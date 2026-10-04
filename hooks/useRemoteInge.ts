import { MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { produce } from 'immer';
import { DAWState, PluginInstance, RemoteIngePhase, Track, TrackType } from '../types';
import type { CollabMember, CollabOp } from '../services/Collab';
import { RemoteAck, RemoteIngeClient, RemoteRole, remoteInviteUrl, REMOTE_KINDS } from '../services/RemoteInge';
import { CloudLink, linkToString } from '../services/SessionCloud';
import { novaBridge } from '../services/NovaBridge';
import { useBridgeState } from './useNovaBridge';
import { audioEngine } from '../engine/AudioEngine';
import { applyBusFreezeResult, applyFreezeResult, busesNeedingVstRender, renderBusFreeze, renderTrackFreeze } from '../services/VstFreeze';
import { canBakeTrack, freezeIndex, isFreezeStale, isVst, lastVstIndex } from '../utils/freeze';
import {
  acceptReturn, acceptSend, applyFxOnArtist, applyReturnOnArtist, applySendOnEngineer, artistNeedsSend, artistStatus,
  buildFxPayload, buildReturnPayload, buildSendPayload, busesFedBy, checkPluginAdd, EngineerAckState, fxSignature,
  localOutboxStore, moveInsertToSend, needsProcessing, rawSignature, parseRemoteLink, RemoteMixRule, RemoteOutbox, RemoteReturnPayload,
  RemoteRuleIssue, remoteRuleIssues, RemoteSendPayload, revertOnArtist, sendBufferIds, shouldSendReturn, SLOT_LABEL,
} from '../utils/remoteInge';
import { remoteStore, RemoteTrackBadge } from '../utils/remoteStore';

/**
 * Mode « Ingé à distance (ses propres VST) » : glue React entre le projet,
 * le transport (services/RemoteInge) et la logique pure (utils/remoteInge).
 * Voir utils/remoteInge pour le principe.
 */

const activeVst = (t: Track) => (t.plugins || []).some(p => isVst(p) && p.isEnabled);
/** Bus VST dont le rendu (par source) est à jour : il doit être joué gelé chez l'artiste. */
const freshVstBus = (b: Track) => activeVst(b) && !!b.frozenClip && !isFreezeStale(b) && freezeIndex(b) >= lastVstIndex(b);

export interface RemoteIngeOptions {
  tracks: Track[];
  remoteInge: DAWState['remoteInge'];
  isRecording: boolean;
  showLanding: boolean;
  stateRef: MutableRefObject<DAWState>;
  setState: (fn: (prev: DAWState) => DAWState) => void;
  setSilently: (fn: (prev: DAWState) => DAWState) => void;
  notify: (msg: string, ms?: number) => void;
  /** Compte + abonnement collaboration (interactive : affiche la connexion / l'abonnement). */
  gate: (interactive: boolean) => Promise<boolean>;
  /** Sauvegarde de la session (fichier local + en ligne si liée). */
  saveSession: () => Promise<void>;
  releaseBuffer: (id: string) => void;
  author: () => string;
}

export interface EngineerRow {
  track: Track;
  label: string;
  tone: RemoteTrackBadge['tone'];
  issues: RemoteRuleIssue[];
  busy?: string;
  latencyMs: number;
}

export function useRemoteInge(o: RemoteIngeOptions) {
  const { stateRef, setState, setSilently, notify } = o;
  const bridge = useBridgeState();
  const bridgeOk = bridge.status === 'connected';
  const [active, setActive] = useState<{ role: RemoteRole; name: string; link: CloudLink } | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const clientRef = useRef<RemoteIngeClient | null>(null);
  const outboxRef = useRef<RemoteOutbox | null>(null);
  const [members, setMembers] = useState<CollabMember[]>([]);
  const [peerSeen, setPeerSeen] = useState<{ name: string; at: number } | null>(null);
  const [acks, setAcks] = useState<Record<string, RemoteAck>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [queued, setQueued] = useState<string[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const processingRef = useRef(new Set<string>());
  const ackedRef = useRef(new Map<string, string>());
  const lastFxSigRef = useRef<string>('');
  const phase: RemoteIngePhase = o.remoteInge?.phase || 'recording';

  /** Modification hors historique (vient de l'autre, ou du traitement automatique). */
  const mutateSilently = useCallback((fn: (d: DAWState) => void) => {
    stateRef.current = produce(stateRef.current, fn);
    setSilently(produce(fn));
  }, [stateRef, setSilently]);
  /** Modification annulable (Ctrl+Z) : recevoir / revenir à sa prise brute. */
  const mutateUndoable = useCallback((fn: (d: DAWState) => void) => {
    stateRef.current = produce(stateRef.current, fn);
    setState(produce(fn));
  }, [stateRef, setState]);

  const findTrack = (id: string) => stateRef.current.tracks.find(t => t.id === id);
  const refreshQueue = () => setQueued(outboxRef.current?.list() || []);

  const ack = useCallback((trackId: string, v: number, state: EngineerAckState, detail?: string) => {
    const key = `${trackId}:${v}`;
    const val = `${state}:${detail || ''}`;
    if (ackedRef.current.get(key) === val) return; // déjà dit à l'artiste
    ackedRef.current.set(key, val);
    void clientRef.current?.sendAck({ trackId, v, state, ...(detail ? { detail } : {}) }).catch(() => { ackedRef.current.delete(key); });
  }, []);

  // --- Envois (passent par la file : hors ligne, ils partent à la reconnexion) ------------

  const sendNow = useCallback(async (trackId: string) => {
    const t = findTrack(trackId);
    if (!t?.remote || !artistNeedsSend(t)) return;
    const c = clientRef.current;
    if (!c) throw new Error('Pas de lien');
    const v = (t.remote.sentV || 0) + 1;
    const payload: RemoteSendPayload = buildSendPayload(t, v);
    await c.sendTrack(payload, sendBufferIds(payload));
    mutateSilently(d => { const x = d.tracks.find(y => y.id === trackId); if (x?.remote) x.remote = { ...x.remote, sentV: v, sentSig: payload.sig }; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutateSilently]);

  const returnNow = useCallback(async (trackId: string): Promise<'sent' | 'same'> => {
    const st = stateRef.current;
    const t = st.tracks.find(x => x.id === trackId);
    if (!t?.remote) return 'same';
    const latencyMs = Math.round((audioEngine.getTrackLatency?.(t.id) || 0) * 1000);
    const { payload, bufferIds } = buildReturnPayload(t, st.tracks, st.remoteInge?.phase || 'recording', latencyMs);
    if (!shouldSendReturn(t.remote, payload.sig)) return 'same';
    const c = clientRef.current;
    if (!c) throw new Error('Pas de lien');
    await c.sendReturn(payload, bufferIds);
    mutateSilently(d => { const x = d.tracks.find(y => y.id === trackId); if (x?.remote) x.remote = { ...x.remote, returnedV: payload.forV, returnedSig: payload.sig, auto: true }; });
    return 'sent';
  }, [stateRef, mutateSilently]);

  const outboxSend = useCallback(async (kind: string, id: string) => {
    const c = clientRef.current;
    if (!c) throw new Error('Pas de lien');
    if (kind === 'send') return sendNow(id);
    if (kind === 'return') { await returnNow(id); return; }
    if (kind === 'fx') { await c.sendFx(buildFxPayload(stateRef.current.tracks)); return; }
    if (kind === 'phase') { await c.sendPhase(stateRef.current.remoteInge?.phase || 'recording'); return; }
  }, [sendNow, returnNow, stateRef]);
  const outboxSendRef = useRef(outboxSend);
  outboxSendRef.current = outboxSend;

  const queue = useCallback((kind: string, id: string) => {
    const box = outboxRef.current;
    if (!box) return;
    box.add(kind, id);
    void box.flush().then(refreshQueue);
  }, []);

  // --- Réception -----------------------------------------------------------------------------

  const applyReturn = useCallback(async (p: RemoteReturnPayload & { audio?: any }, undoable: boolean) => {
    await clientRef.current?.ensureAudio(p.audio);
    const { audio: _a, ...payload } = p;
    let released: string[] = [];
    const fn = (d: DAWState) => { const r = applyReturnOnArtist(d.tracks, payload as RemoteReturnPayload, 'Ingé'); if (r) released = r.released; };
    if (undoable) mutateUndoable(fn); else mutateSilently(fn);
    setTimeout(() => released.forEach(id => o.releaseBuffer(id)), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutateSilently, mutateUndoable]);

  const onOp = useCallback(async (op: CollabOp) => {
    const me = clientRef.current;
    if (!me || !REMOTE_KINDS.has(op.kind) || op.role === me.role) return;
    const p = op.op || {};
    // Signe de vie de l'autre (le direct peut être coupé : la présence ne suffit pas).
    setPeerSeen({ name: op.author_name, at: Date.now() });
    if (me.role === 'artist') {
      if (op.kind === 'ri_ack') {
        setAcks(a => (a[p.trackId] && a[p.trackId].v > p.v ? a : { ...a, [p.trackId]: p as RemoteAck }));
      } else if (op.kind === 'ri_return') {
        const t = stateRef.current.tracks.find(x => x.id === p.trackId && !!x.remote);
        if (!t || acceptReturn(t.remote, p) !== 'new') return;
        if (t.remote!.accepted && !t.remote!.reverted) {
          await applyReturn(p, false);
          notify(`✅ Mise à jour reçue de l'ingé sur « ${t.name} » : tu entends ses effets sur ta dernière version.`, 5000);
        } else {
          mutateSilently(d => { const x = d.tracks.find(y => y.id === p.trackId); if (x?.remote) x.remote = { ...x.remote, pending: p }; });
          void me.ensureAudio(p.audio).catch(() => { /* retéléchargé à l'acceptation */ });
          notify(t.remote!.reverted
            ? `🎧 Nouveaux réglages de l'ingé pour « ${t.name} » gardés en réserve (tu écoutes ta prise brute).`
            : `🎧 L'ingé t'a renvoyé « ${t.name} » avec ses effets : clique « Recevoir les réglages de l'ingé ».`, 8000);
        }
      } else if (op.kind === 'ri_fx') {
        mutateSilently(d => { applyFxOnArtist(d.tracks, p); });
      } else if (op.kind === 'ri_phase') {
        const next: RemoteIngePhase = p.phase === 'mixing' ? 'mixing' : 'recording';
        if (stateRef.current.remoteInge?.phase === next) return;
        mutateSilently(d => { if (d.remoteInge) d.remoteInge.phase = next; });
        notify(next === 'mixing'
          ? `🎚️ ${op.author_name} passe au mix : il peut utiliser sa reverb VST. Tu recevras son rendu, et tu pourras toujours retoucher tes prises.`
          : `🎙️ ${op.author_name} repasse en enregistrement : reverbs et délais de NOVA, que tu entends en direct comme lui.`, 7000);
      }
    } else if (op.kind === 'ri_send') {
      const existing = stateRef.current.tracks.find(x => x.remote?.peerTrackId === p.trackId);
      const verdict = acceptSend(existing?.remote, p);
      if (verdict === 'old') return;
      if (verdict === 'dup') { ack(p.trackId, p.v, 'received'); return; }
      await me.ensureAudio(p.audio);
      const { audio: _a, ...payload } = p;
      let res = { trackId: '', created: false };
      mutateSilently(d => { res = applySendOnEngineer(d.tracks, payload as RemoteSendPayload); });
      const t = findTrack(res.trackId);
      const auto = !!t?.remote?.auto;
      const slot = p.slot && SLOT_LABEL[p.slot] ? ` (${SLOT_LABEL[p.slot]})` : '';
      notify(res.created
        ? `🎤 Nouvelle piste de ${op.author_name}${slot} : « ${t?.name || p.name} » est dans ta session. Traite-la avec tes VST, puis « Geler et envoyer à l'artiste ».`
        : `🎤 ${op.author_name} a modifié « ${t?.name || p.name} » (coupes, prises, fondus) : piste dégelée, ses éditions passent AVANT tes effets.${auto ? ' Renvoi automatique…' : ''}`, 7000);
      ack(p.trackId, p.v, auto ? (novaBridge.isConnected() || !t || !activeVst(t) ? 'processing' : 'waiting_bridge') : 'received');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateRef, mutateSilently, applyReturn, notify, ack]);
  const onOpRef = useRef(onOp);
  onOpRef.current = onOp;

  // --- Lien ----------------------------------------------------------------------------------

  /** Lien déjà repris (ou en cours) : la reprise automatique ne le rouvre pas en double. */
  const resumeTriedRef = useRef('');
  const start = useCallback(async (role: RemoteRole, name: string, linkRaw?: string, opts: { quiet?: boolean } = {}): Promise<boolean> => {
    setError(null);
    try {
      if (!(await o.gate(!opts.quiet))) return false;
      const saved = stateRef.current.remoteInge;
      let link: CloudLink | null = null;
      if (role === 'engineer') {
        link = parseRemoteLink(linkRaw) || (saved?.role === 'engineer' ? parseRemoteLink(saved.link) : null);
        if (!link) throw new Error("colle le lien envoyé par l'artiste (il contient « ?inge= »)");
      } else {
        link = parseRemoteLink(linkRaw) || (saved?.role === 'artist' ? parseRemoteLink(saved.link) : null);
        if (!link) { setConnecting('Création du lien avec ton ingé…'); link = await RemoteIngeClient.createLink(name); }
      }
      await clientRef.current?.leave().catch(() => {});
      const linkStr = linkToString(link);
      resumeTriedRef.current = linkStr;
      const same = saved?.link === linkStr && saved.role === role;
      const client = new RemoteIngeClient(link, role, name, op => onOpRef.current(op), setMembers);
      clientRef.current = client;
      const box = new RemoteOutbox(localOutboxStore(`nova_ri_outbox_${link.id}_${role}`), (k, id) => outboxSendRef.current(k, id), refreshQueue);
      outboxRef.current = box;
      mutateSilently(d => { d.remoteInge = { link: linkStr, role, phase: same ? saved!.phase : 'recording', seq: same ? saved!.seq || 0 : 0 }; });
      setConnecting(role === 'artist' ? 'Connexion au lien…' : "Connexion à l'artiste…");
      await client.join(same ? saved!.seq || 0 : 0);
      setActive({ role, name, link });
      refreshQueue();
      void box.flush().then(refreshQueue);
      if (!opts.quiet) {
        notify(role === 'artist'
          ? "🎧 Lien avec ton ingé prêt : envoie-lui le lien d'invitation, puis glisse une piste dans « Envoyer à l'ingé »."
          : "🎛️ Tu es relié à l'artiste : ses pistes arrivent dans TA session. Traite-les avec tes VST, puis « Geler et envoyer à l'artiste ».", 7000);
      }
      return true;
    } catch (e: any) {
      const msg = String(e?.message || 'erreur');
      if (!opts.quiet) setError(/Connecte-toi|Abonnement/.test(msg) ? msg : `Lien impossible : ${msg}`);
      void clientRef.current?.leave().catch(() => {});
      clientRef.current = null;
      outboxRef.current = null;
      setActive(null);
      return false;
    } finally {
      setConnecting(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateRef, mutateSilently, notify]);

  const leave = useCallback(async (forget = true) => {
    const c = clientRef.current;
    clientRef.current = null;
    outboxRef.current = null;
    setActive(null);
    setMembers([]);
    if (forget) mutateSilently(d => { delete d.remoteInge; });
    if (c) await c.leave().catch(() => {});
  }, [mutateSilently]);

  // Reprise automatique du lien enregistré avec le projet (sans fenêtre si ça échoue).
  useEffect(() => {
    const saved = o.remoteInge;
    if (active || clientRef.current || !saved || o.showLanding || resumeTriedRef.current === saved.link) return;
    resumeTriedRef.current = saved.link;
    const t = window.setTimeout(() => { void start(saved.role, saved.role === 'artist' ? 'Artiste' : 'Ingé', saved.link, { quiet: true }); }, 2500);
    return () => window.clearTimeout(t);
  }, [o.remoteInge, o.showLanding, active, start]);

  // Numéro de la dernière opération reçue (rattrapage à la reconnexion).
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      const c = clientRef.current;
      const cur = stateRef.current.remoteInge;
      if (c && cur && c.lastSeq > (cur.seq || 0)) mutateSilently(d => { if (d.remoteInge) d.remoteInge.seq = c.lastSeq; });
      if (outboxRef.current?.size()) void outboxRef.current.flush().then(refreshQueue);
    }, 10000);
    const online = () => { void outboxRef.current?.flush().then(refreshQueue); void clientRef.current?.catchUp(); };
    window.addEventListener('online', online);
    return () => { window.clearInterval(id); window.removeEventListener('online', online); };
  }, [active, stateRef, mutateSilently]);

  // --- Artiste ----------------------------------------------------------------------------------

  const sendTrack = useCallback((trackId: string, slot?: string) => {
    const t = findTrack(trackId);
    if (!t) return;
    if (!activeRef.current || activeRef.current.role !== 'artist') { notify("Ouvre d'abord le lien « Ingé à distance » (bouton Collaborer)."); return; }
    if (!canBakeTrack(t) || t.type !== TrackType.AUDIO) { notify("Seules tes pistes voix partent chez l'ingé (le beat reste chez toi : licence)."); return; }
    if (!(t.clips || []).some(c => !!c.bufferId)) { notify(`« ${t.name} » est vide : enregistre une prise d'abord.`); return; }
    mutateSilently(d => {
      const x = d.tracks.find(y => y.id === trackId);
      if (!x) return;
      x.remote = { ...(x.remote || { peerTrackId: x.id }), ...(slot ? { slot } : {}) };
      // Renvoi forcé (nouvel emplacement, ou l'artiste insiste) : nouvelle version.
      if (x.remote.sentV) x.remote = { ...x.remote, sentSig: undefined };
    });
    queue('send', trackId);
    notify(`📤 « ${t.name} » part chez l'ingé${slot && SLOT_LABEL[slot] ? ` (${SLOT_LABEL[slot]})` : ''} : son audio brut et tes éditions. Tes prochaines coupes repartiront toutes seules.`, 6000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutateSilently, queue, notify]);

  useEffect(() => {
    const on = (e: Event) => sendTrack(String((e as CustomEvent).detail || ''));
    window.addEventListener('nova:remote-send', on);
    return () => window.removeEventListener('nova:remote-send', on);
  }, [sendTrack]);

  // Aller-retour automatique : une piste déjà envoyée et modifiée repart (pas pendant une prise).
  useEffect(() => {
    if (!active || active.role !== 'artist' || o.isRecording) return;
    const dirty = o.tracks.filter(t => !!t.remote?.sentV && artistNeedsSend(t));
    if (!dirty.length) return;
    const timer = window.setTimeout(() => { dirty.forEach(t => queue('send', t.id)); }, 2500);
    return () => window.clearTimeout(timer);
  }, [o.tracks, o.isRecording, active, queue]);

  const receive = useCallback(async (trackId: string) => {
    const t = findTrack(trackId);
    const p = t?.remote?.pending;
    if (!t || !p) return;
    setBusy(b => ({ ...b, [trackId]: 'Téléchargement des réglages…' }));
    try {
      await applyReturn(p, true);
      notify(`✅ Réglages de l'ingé appliqués sur « ${t.name} ». Ta prise brute est gardée : « Revenir à ma prise brute » quand tu veux (ou Ctrl+Z).`, 6000);
    } catch (e: any) {
      notify(`⚠️ Réglages de l'ingé pas encore téléchargés (${e?.message || 'connexion'}). Réessaie dans un instant.`, 6000);
    } finally {
      setBusy(b => { const { [trackId]: _x, ...r } = b; return r; });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyReturn, notify]);

  const revert = useCallback((trackId: string) => {
    const t = findTrack(trackId);
    if (!t?.remote?.before) return;
    let released: string[] = [];
    mutateUndoable(d => { const x = d.tracks.find(y => y.id === trackId); released = [x?.frozenClip?.bufferId, ...(x?.sendFreezes || []).map(s => s.clip.bufferId)].filter(Boolean) as string[]; revertOnArtist(d.tracks, trackId); });
    void released; // gardés en mémoire : « Réappliquer » les reprend sans téléchargement
    notify(`↩️ « ${t.name} » : retour à ta prise brute et à tes effets. Les réglages de l'ingé restent en réserve (« Réappliquer »).`, 5000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutateUndoable, notify]);

  // --- Ingé -------------------------------------------------------------------------------------

  const processTrack = useCallback(async (trackId: string, manual: boolean): Promise<boolean> => {
    if (processingRef.current.has(trackId)) return false;
    const st = stateRef.current;
    const t = st.tracks.find(x => x.id === trackId);
    if (!t?.remote) return false;
    const ph = st.remoteInge?.phase || 'recording';
    const v = t.remote.recvV ?? 0;
    const issues = remoteRuleIssues(st.tracks, [trackId], ph);
    if (issues.length) {
      ack(t.remote.peerTrackId, v, 'blocked', issues[0].code === 'temporal-insert' ? 'il déplace une reverb en envoi' : 'il remplace sa reverb VST par celle de NOVA');
      if (manual) notify(`⛔ ${issues[0].message} Clique « ${issues[0].fix === 'move-to-send' ? 'Déplacer en envoi' : 'Mettre en pause'} » dans le panneau Ingé à distance.`, 9000);
      return false;
    }
    const fed = busesFedBy(t, st.tracks);
    if ((activeVst(t) || fed.some(activeVst)) && !novaBridge.isConnected()) {
      ack(t.remote.peerTrackId, v, 'waiting_bridge');
      if (manual) notify("🔌 Tes VST tournent sur ton PC : ouvre NOVA Studio pour Windows (ou connecte le pont dans l'onglet VST) pour geler et envoyer. Sans pont, seuls les effets de NOVA marchent.", 8000);
      return false;
    }
    processingRef.current.add(trackId);
    const step = (msg: string) => setBusy(b => ({ ...b, [trackId]: msg }));
    step('Gel de la piste…');
    ack(t.remote.peerTrackId, v, 'processing');
    const by = o.author() || "l'ingé";
    try {
      const old: string[] = [];
      if ((t.clips || []).some(c => !!c.bufferId) && (t.plugins || []).length > 0) {
        const r = await renderTrackFreeze(t, t.plugins.length - 1, step);
        const now = findTrack(trackId);
        if (!now || (now.remote?.recvV ?? 0) !== v || rawSignature(now) !== rawSignature(t)) {
          // Nouvelle version arrivée pendant le rendu : on recommence avec elle.
          setTimeout(() => o.releaseBuffer(r.clip.bufferId!), 0);
          return false;
        }
        mutateSilently(d => {
          const x = d.tracks.find(y => y.id === trackId);
          if (!x) return;
          if (x.frozenClip?.bufferId && x.frozenClip.bufferId !== r.clip.bufferId) old.push(x.frozenClip.bufferId);
          x.isFrozen = true;
          delete x.frozenAuto;
          applyFreezeResult(x, r, by);
        });
      } else if (t.isFrozen) {
        mutateSilently(d => { const x = d.tracks.find(y => y.id === trackId); if (x) x.isFrozen = false; });
      }
      // Bus VST alimentés par la piste (reverb VST au mix) : rendus par source, joués gelés.
      const tracksNow = stateRef.current.tracks;
      const me = tracksNow.find(x => x.id === trackId)!;
      const fedIds = new Set(busesFedBy(me, tracksNow).map(b => b.id));
      for (const bus of busesNeedingVstRender(tracksNow).filter(b => fedIds.has(b.id))) {
        step(`Gel de ${bus.name}…`);
        const br = await renderBusFreeze(bus, stateRef.current.tracks, step);
        mutateSilently(d => { old.push(...applyBusFreezeResult(d.tracks, br, by)); });
      }
      mutateSilently(d => { d.tracks.forEach(b => { if (fedIds.has(b.id) && freshVstBus(b)) { b.isFrozen = true; delete b.frozenAuto; } }); });
      setTimeout(() => old.forEach(id => o.releaseBuffer(id)), 0);
      step("Envoi à l'artiste…");
      try {
        await returnNow(trackId);
      } catch {
        // Hors ligne : traité (pas de nouveau rendu), part à la reconnexion.
        mutateSilently(d => { const x = d.tracks.find(y => y.id === trackId); if (x?.remote) x.remote = { ...x.remote, returnedV: v, auto: true }; });
        queue('return', trackId);
        if (manual) notify("📡 Pas de connexion : l'envoi partira tout seul dès que possible.", 5000);
        return true;
      }
      if (manual) notify(`📤 « ${t.name} » envoyée à l'artiste avec tes effets. Ses prochaines coupes reviendront ici et repartiront toutes seules.`, 6000);
      return true;
    } catch (e: any) {
      console.warn('[Ingé à distance] traitement', e);
      notify(`⚠️ Gel impossible pour « ${t.name} » : ${e?.message || 'erreur'}.`, 7000);
      return false;
    } finally {
      processingRef.current.delete(trackId);
      setBusy(b => { const { [trackId]: _x, ...r } = b; return r; });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateRef, mutateSilently, returnNow, queue, notify, ack]);

  /** « Geler et envoyer à l'artiste » (au mix : la session est aussi sauvegardée). */
  const returnTrack = useCallback(async (trackId: string) => {
    const ok = await processTrack(trackId, true);
    if (ok && (stateRef.current.remoteInge?.phase || 'recording') === 'mixing') {
      try { await o.saveSession(); } catch (e) { console.warn('[Ingé à distance] sauvegarde', e); }
    }
    return ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processTrack, stateRef]);

  // Renvoi automatique : version reçue, pont prêt (ou que des effets de NOVA), pas pendant une prise.
  useEffect(() => {
    if (!active || active.role !== 'engineer' || o.isRecording) return;
    const todo = o.tracks.filter(t => needsProcessing(t) && !processingRef.current.has(t.id));
    if (!todo.length) return;
    const timer = window.setTimeout(async () => { for (const t of todo) await processTrack(t.id, false); }, 1200);
    return () => window.clearTimeout(timer);
  }, [o.tracks, o.isRecording, active, bridgeOk, processTrack]);

  // Reverbs / délais de NOVA : réglages envoyés en direct à l'artiste.
  useEffect(() => {
    if (!active || active.role !== 'engineer') return;
    const fx = buildFxPayload(o.tracks);
    if (!fx.tracks.length) return;
    const sig = fxSignature(fx);
    if (sig === lastFxSigRef.current) return;
    const timer = window.setTimeout(() => { lastFxSigRef.current = sig; queue('fx', 'all'); }, 350);
    return () => window.clearTimeout(timer);
  }, [o.tracks, active, queue]);

  const setPhase = useCallback((next: RemoteIngePhase) => {
    mutateSilently(d => { if (d.remoteInge) d.remoteInge.phase = next; });
    queue('phase', 'all');
    notify(next === 'mixing'
      ? "🎚️ Mode mix : tu peux remplacer la reverb de NOVA par ta reverb VST sur le bus d'envoi, puis « Geler et envoyer à l'artiste » (la session est sauvegardée)."
      : "🎙️ Mode enregistrement : reverbs et délais de NOVA seulement, l'artiste les entend en direct comme toi.", 7000);
  }, [mutateSilently, queue, notify]);

  const fixIssue = useCallback((i: RemoteRuleIssue) => {
    if (i.fix === 'move-to-send') {
      const now = Date.now();
      let res: ReturnType<typeof moveInsertToSend> = null;
      mutateUndoable(d => { res = moveInsertToSend(d.tracks, i.trackId, i.pluginId, now); });
      const r = res as ReturnType<typeof moveInsertToSend>;
      if (r) notify(`🌫️ « ${i.pluginName} » déplacé sur la piste d'envoi « ${r.busName} » (envoi ${Math.round(r.level * 100)} %) : même réglage, et la queue suivra les coupes de l'artiste.`, 6000);
    } else {
      mutateUndoable(d => { const b = d.tracks.find(x => x.id === i.trackId); const p = b?.plugins.find(x => x.id === i.pluginId); if (p) p.isEnabled = false; });
      notify(`⏸️ « ${i.pluginName} » en pause pendant l'enregistrement : mets une reverb de NOVA sur ce bus. Tu la réactiveras au mix.`, 6000);
    }
  }, [mutateUndoable, notify]);

  /** Ajout d'un effet chez l'ingé : verrou d'enregistrement, effet temporel forcé en insert. */
  const checkAdd = useCallback((trackId: string, plugin: PluginInstance, forceInsert?: boolean) => {
    const a = activeRef.current;
    if (!a || a.role !== 'engineer') return { ok: true as const };
    const t = findTrack(trackId);
    return checkPluginAdd({ phase: stateRef.current.remoteInge?.phase || 'recording', isRemoteTrack: !!t?.remote, forceInsert }, plugin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateRef]);

  /** Règle pour le mix piloté par le chat (null : pas de mode ingé à distance côté ingé). */
  const mixRule = useCallback((): RemoteMixRule | null => {
    const a = activeRef.current;
    if (!a || a.role !== 'engineer') return null;
    return { phase: stateRef.current.remoteInge?.phase || 'recording', trackIds: stateRef.current.tracks.filter(t => !!t.remote).map(t => t.id) };
  }, [stateRef]);

  // --- Affichage ----------------------------------------------------------------------------------

  const role = active?.role || null;
  const artistRows = useMemo(() => (role !== 'artist' ? [] : o.tracks
    .filter(t => t.type === TrackType.AUDIO && canBakeTrack(t) && ((t.clips || []).some(c => !!c.bufferId) || !!t.remote))
    .map(t => ({ track: t, status: artistStatus(t, acks[t.id], queued.includes(`send:${t.id}`)), busy: busy[t.id] }))), [role, o.tracks, acks, queued, busy]);

  const engineerRows: EngineerRow[] = useMemo(() => {
    if (role !== 'engineer') return [];
    const remoteIds = o.tracks.filter(t => !!t.remote).map(t => t.id);
    const issues = remoteRuleIssues(o.tracks, remoteIds, phase);
    return o.tracks.filter(t => !!t.remote).map(t => {
      const r = t.remote!;
      const mine = issues.filter(i => i.trackId === t.id || busesFedBy(t, o.tracks).some(b => b.id === i.trackId));
      let label = 'Reçue : à traiter, puis « Geler et envoyer »';
      let tone: RemoteTrackBadge['tone'] = 'info';
      if (busy[t.id]) { label = busy[t.id]; tone = 'busy'; }
      else if (mine.length) { label = 'Règle des envois : à corriger'; tone = 'warn'; }
      else if (needsProcessing(t)) { label = bridgeOk || !activeVst(t) ? `Nouvelle version (v${r.recvV}) : renvoi…` : `Nouvelle version (v${r.recvV}) : pont VST fermé`; tone = bridgeOk ? 'busy' : 'warn'; }
      else if (queued.includes(`return:${t.id}`)) { label = 'Envoi en attente de connexion'; tone = 'warn'; }
      else if (r.returnedV) { label = `Envoyée à l'artiste (v${r.returnedV})`; tone = 'ok'; }
      const latencyMs = Math.round((audioEngine.getTrackLatency?.(t.id) || 0) * 1000);
      return { track: t, label, tone, issues: mine, busy: busy[t.id], latencyMs };
    });
  }, [role, o.tracks, phase, busy, bridgeOk, queued]);

  useEffect(() => {
    const badges: Record<string, RemoteTrackBadge> = {};
    artistRows.forEach(r => { badges[r.track.id] = { label: r.busy || r.status.label, tone: r.busy ? 'busy' : r.status.tone, canSend: !r.track.remote?.sentV }; });
    engineerRows.forEach(r => { badges[r.track.id] = { label: r.label, tone: r.tone }; });
    remoteStore.set({ role, badges });
  }, [role, artistRows, engineerRows]);
  useEffect(() => () => remoteStore.set({ role: null, badges: {} }), []);

  const peer = members.find(m => m.role !== role && m.online);
  return {
    active: !!active, role, phase, name: active?.name || '', connecting, error, setError,
    inviteUrl: active && role === 'artist' ? remoteInviteUrl(active.link) : null,
    peerName: peer?.display_name || null,
    /** Dernier signe de vie de l'autre (envoi, accusé de réception), si la présence en direct manque. */
    peerSeen: peer ? null : peerSeen,
    bridgeConnected: bridgeOk,
    queuedCount: queued.length,
    savedLink: o.remoteInge || null,
    artistRows, engineerRows,
    start, leave, sendTrack, receive, revert, returnTrack, setPhase, fixIssue, checkAdd, mixRule,
  };
}

export type RemoteInge = ReturnType<typeof useRemoteInge>;
