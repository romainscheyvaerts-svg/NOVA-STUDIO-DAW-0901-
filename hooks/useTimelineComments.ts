import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CollabRole, DAWState } from '../types';
import {
  addReply, Author, COMMENTS_KIND, createComment, fmtTime, HybridClock, maxStamp, mergeComments, readCommentsOp,
  setArchived, setStatus, TimelineComment, visibleReplies, sortComments, commentSig,
} from '../utils/timelineComments';
import {
  canDecide, createVersion, decide, DecisionKind, MixAudioRef, MixVersion, mergeVersions, MIX_VERSIONS_KIND, nextVersionN, readVersionsOp,
  versionStatusLine, versionSig, versionSnapshotComment,
} from '../utils/mixVersions';

/**
 * Chantier 11 · Commentaires horodatés + versions validées : branchements de App.
 * La logique (fusion, convergence, droits) est dans utils/timelineComments et
 * utils/mixVersions ; ici seulement :
 *  - les gestes (poser, répondre, résoudre, archiver, envoyer une version, décider) ;
 *  - l'envoi par la file de la collaboration (une clé par commentaire : l'état
 *    complet le plus récent part, hors ligne il attend le retour du réseau) ;
 *  - la réception (fusion, notifications, historique) ;
 *  - le lecteur des versions (bounce reçu).
 * Les commentaires ne passent pas par l'annulation (Ctrl+Z) : ce qui est envoyé
 * aux autres ne disparaît pas d'un raccourci.
 */

export interface CommentsCollab {
  queue: (key: string, kind: string, op: Record<string, unknown>) => void;
  role: CollabRole;
}

export interface CommentsDeps {
  stateRef: React.MutableRefObject<DAWState>;
  setSilently: (fn: (prev: DAWState) => DAWState) => void;
  notify: (text: string) => void;
  /** Qui je suis (clé de participant en collaboration, « local » sinon). */
  me: () => Author;
  collab: () => CommentsCollab | null;
  seek: (t: number) => void;
  position: () => number;
  /** Plage sélectionnée sur la timeline (commentaire sur une plage). */
  selection?: () => { start: number; end: number } | null;
  /** Ligne dans l'historique de la collaboration. */
  history?: (e: { who: string; role: CollabRole; text: string; seq: number }) => void;
  /** Instantané nommé dans l'historique de l'appareil ; renvoie son numéro de version de session. */
  saveSnapshot?: (comment: string) => Promise<number | null>;
  /** Bounce du mix envoyé par le canal audio (null : impossible, version de référence). */
  bounce?: (onStep: (text: string) => void) => Promise<MixAudioRef | null>;
  /** Télécharge le bounce d'une version reçue. */
  fetchAudio?: (ref: MixAudioRef) => Promise<AudioBuffer | null>;
  /** Contexte audio pour écouter une version. */
  audioContext?: () => Promise<AudioContext | null>;
  /** Empreinte de ce qui est partagé (référence de la version). */
  print?: () => string;
}

interface Times { createdAt: number; receivedAt?: number; sentAt?: number }

export function useTimelineComments(state: DAWState, d: CommentsDeps) {
  const dRef = useRef(d);
  dRef.current = d;
  const clockRef = useRef<HybridClock | null>(null);
  const clock = () => {
    const by = dRef.current.me().key;
    if (!clockRef.current) clockRef.current = new HybridClock(by);
    clockRef.current.by = by;
    return clockRef.current;
  };
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'comments' | 'versions'>('comments');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ id: string; at: number } | null>(null);
  const timesRef = useRef(new Map<string, Times>());
  const orphansRef = useRef(new Map<string, MixVersion>());
  const playerRef = useRef<{ src: AudioBufferSourceNode; ctx: AudioContext } | null>(null);

  const comments = useMemo(() => state.timelineComments || [], [state.timelineComments]);
  const versions = useMemo(() => state.mixVersions || [], [state.mixVersions]);

  // L'horloge reste en avance sur tout ce qu'on a (projet rouvert, état reçu).
  useEffect(() => { const c = clock(); comments.forEach(x => c.observe(maxStamp(x))); versions.forEach(v => c.observe(v.decision.s)); }, [comments, versions]);

  const write = (fn: (s: DAWState) => DAWState) => {
    const dd = dRef.current;
    dd.stateRef.current = fn(dd.stateRef.current);
    dd.setSilently(fn);
  };

  const sendComment = (c: TimelineComment) => {
    const co = dRef.current.collab();
    if (!co) return;
    const t = timesRef.current.get(c.id) || { createdAt: c.createdAt };
    timesRef.current.set(c.id, { ...t, sentAt: Date.now() });
    co.queue(`comment:${c.id}`, COMMENTS_KIND, { upsert: [c] });
  };
  const sendVersion = (v: MixVersion) => {
    const co = dRef.current.collab();
    if (co) co.queue(`mixver:${v.id}`, MIX_VERSIONS_KIND, { upsert: [v] });
  };

  const upsertLocal = (c: TimelineComment) => {
    write(s => ({ ...s, timelineComments: mergeComments(s.timelineComments, [c]).list }));
    sendComment(c);
  };

  const mutate = (id: string, fn: (c: TimelineComment, k: HybridClock) => TimelineComment) => {
    const cur = (dRef.current.stateRef.current.timelineComments || []).find(x => x.id === id);
    if (!cur) return null;
    const k = clock();
    k.observe(maxStamp(cur));
    const next = fn(cur, k);
    upsertLocal(next);
    return next;
  };

  // ── Gestes ────────────────────────────────────────────────────────────────
  const add = useCallback((input: { time: number; end?: number | null; text: string; trackId?: string | null }): TimelineComment | null => {
    const text = input.text.trim();
    if (!text) return null;
    const who = dRef.current.me();
    const c = createComment({ ...input, text }, who, clock());
    timesRef.current.set(c.id, { createdAt: Date.now() });
    upsertLocal(c);
    setFocusId(c.id);
    dRef.current.notify(dRef.current.collab()
      ? `💬 Commentaire posé à ${fmtTime(c.pos.v.t)} : il part tout de suite chez les autres.`
      : `💬 Commentaire posé à ${fmtTime(c.pos.v.t)} (enregistré dans le projet).`);
    return c;
  }, []);

  const reply = useCallback((id: string, text: string) => {
    if (!text.trim()) return;
    mutate(id, (c, k) => addReply(c, text, dRef.current.me(), k));
  }, []);
  const resolve = useCallback((id: string, done: boolean) => {
    const c = mutate(id, (x, k) => setStatus(x, done ? 'resolved' : 'open', dRef.current.me(), k));
    if (c) dRef.current.notify(done ? `✅ Commentaire de ${fmtTime(c.pos.v.t)} résolu.` : `↩️ Commentaire de ${fmtTime(c.pos.v.t)} rouvert.`);
  }, []);
  const archive = useCallback((id: string, on: boolean) => {
    const c = mutate(id, (x, k) => setArchived(x, on, k));
    if (c) dRef.current.notify(on ? `🗄️ Commentaire de ${fmtTime(c.pos.v.t)} archivé (onglet « Archivés »).` : `📤 Commentaire de ${fmtTime(c.pos.v.t)} ressorti des archives.`);
  }, []);
  const goTo = useCallback((id: string) => {
    const c = (dRef.current.stateRef.current.timelineComments || []).find(x => x.id === id);
    if (!c) return;
    dRef.current.seek(c.pos.v.t);
    setFocusId(id);
  }, []);
  const openAt = useCallback((id: string | null, which: 'comments' | 'versions' = 'comments') => {
    setTab(which);
    setOpen(true);
    if (id) { setFocusId(id); const c = (dRef.current.stateRef.current.timelineComments || []).find(x => x.id === id); if (c) dRef.current.seek(c.pos.v.t); }
  }, []);

  // ── Versions ──────────────────────────────────────────────────────────────
  const sendNewVersion = useCallback(async (opts: { name?: string; note?: string; withAudio: boolean }) => {
    if (busy) return null;
    const dd = dRef.current;
    const me = dd.me();
    const s0 = dd.stateRef.current;
    const n = nextVersionN(s0.mixVersions);
    setBusy(`Version ${n} : préparation…`);
    try {
      let audio: MixAudioRef | null = null;
      if (opts.withAudio && dd.bounce) {
        try { audio = await dd.bounce(t => setBusy(`Version ${n} : ${t}`)); } catch (e) { console.warn('[Versions] bounce', e); audio = null; }
      }
      let sessionVersion: number | null = null;
      // Instantané de séance : auteur et date toujours écrits dedans (décision du 16/10/2026).
      try { sessionVersion = (await dd.saveSnapshot?.(versionSnapshotComment(n, me, Date.now(), opts.note))) ?? null; } catch { /* historique indisponible */ }
      const s1 = dd.stateRef.current;
      const end = Math.max(0, ...s1.tracks.filter(t => !t.isGuide).flatMap(t => t.clips.map(c => c.start + c.duration)));
      const v = createVersion({
        n, name: opts.name, note: opts.note, audio,
        ref: { sessionVersion, print: dd.print?.() ?? null, duration: Math.round(end * 1000) / 1000, tracks: s1.tracks.filter(t => t.id !== 'master').length },
      }, me, clock());
      write(s => ({ ...s, mixVersions: mergeVersions(s.mixVersions, [v], { fromEngineer: true, fromArtist: false }).list }));
      sendVersion(v);
      dd.notify(dd.collab()
        ? `📨 « ${v.name} » envoyée${audio ? ' avec le son du mix' : " (sans fichier son : l'artiste écoute la séance)"} : l'artiste peut l'écouter, la valider ou demander des retouches.`
        : `🔖 « ${v.name} » enregistrée. Ouvre une collaboration pour l'envoyer à l'artiste.`);
      return v;
    } finally { setBusy(null); }
  }, [busy]);

  const decideVersion = useCallback((id: string, kind: DecisionKind, comment?: string) => {
    const dd = dRef.current;
    const co = dd.collab();
    if (!canDecide(co?.role)) { dd.notify("⚠️ C'est l'artiste qui valide une version."); return; }
    const cur = (dd.stateRef.current.mixVersions || []).find(v => v.id === id);
    if (!cur) return;
    if (kind === 'changes' && !(comment || '').trim()) { dd.notify('✍️ Dis ce qu’il faut retoucher (une phrase suffit).'); return; }
    const k = clock();
    k.observe(cur.decision.s);
    const next = decide(cur, kind, dd.me(), k, comment);
    write(s => ({ ...s, mixVersions: mergeVersions(s.mixVersions, [next], { fromEngineer: false, fromArtist: true }).list }));
    sendVersion(next);
    // Les retouches demandées deviennent aussi un commentaire sur la timeline (à l'endroit écouté).
    if (kind === 'changes' && comment?.trim()) add({ time: dd.position(), text: `Version ${cur.n} : ${comment.trim()}` });
    dd.notify(kind === 'approved' ? `✅ Version ${cur.n} validée : ${cur.sentBy} est prévenu.` : `✎ Retouches demandées sur la version ${cur.n} : ${cur.sentBy} est prévenu.`);
  }, [add]);

  const stopVersion = useCallback(() => {
    const p = playerRef.current;
    playerRef.current = null;
    if (p) { try { p.src.onended = null; p.src.stop(); } catch { /* déjà arrêté */ } }
    setPlaying(null);
  }, []);
  const playVersion = useCallback(async (id: string) => {
    const dd = dRef.current;
    stopVersion();
    const v = (dd.stateRef.current.mixVersions || []).find(x => x.id === id);
    if (!v) return;
    if (!v.audio || !dd.fetchAudio || !dd.audioContext) { dd.notify(`🎧 « ${v.name} » n'a pas de fichier son : écoute la séance (▶) telle que ${v.sentBy} l'a envoyée.`); return; }
    setBusy(`Chargement de « ${v.name} »…`);
    try {
      const [buf, ctx] = await Promise.all([dd.fetchAudio(v.audio), dd.audioContext()]);
      if (!buf || !ctx) { dd.notify(`⚠️ Le son de « ${v.name} » n'est pas encore arrivé : réessaie dans un instant.`); return; }
      try { if (ctx.state === 'suspended') await ctx.resume(); } catch { /* */ }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => { if (playerRef.current?.src === src) { playerRef.current = null; setPlaying(null); } };
      src.start();
      playerRef.current = { src, ctx };
      setPlaying({ id, at: Date.now() });
    } catch (e) {
      console.warn('[Versions] lecture', e);
      dd.notify(`⚠️ Lecture de « ${v.name} » impossible pour l'instant : réessaie.`);
    } finally { setBusy(null); }
  }, [stopVersion]);
  useEffect(() => () => stopVersion(), [stopVersion]);

  // ── Réception ─────────────────────────────────────────────────────────────
  const onRemote = useCallback((o: { kind: string; op?: unknown; seq: number; role: CollabRole; author_name?: string; replay?: boolean }) => {
    const dd = dRef.current;
    const who = o.author_name || 'Un collaborateur';
    if (o.kind === COMMENTS_KIND) {
      const incoming = readCommentsOp(o.op);
      if (!incoming.length) return;
      const k = clock();
      incoming.forEach(c => k.observe(maxStamp(c)));
      const before = new Map((dd.stateRef.current.timelineComments || []).map(c => [c.id, c] as const));
      const r = mergeComments(dd.stateRef.current.timelineComments, incoming);
      if (!r.added.length && !r.changed.length) return;
      const now = Date.now();
      r.added.forEach(c => { if (!timesRef.current.has(c.id)) timesRef.current.set(c.id, { createdAt: c.createdAt, receivedAt: now }); });
      write(s => ({ ...s, timelineComments: mergeComments(s.timelineComments, incoming).list }));
      if (o.replay) return;
      for (const c of r.added) {
        dd.notify(`💬 ${c.authorName} a commenté à ${fmtTime(c.pos.v.t)} : « ${c.text.v.slice(0, 120)} »`);
        dd.history?.({ who: c.authorName, role: o.role, seq: o.seq, text: `a commenté à ${fmtTime(c.pos.v.t)} : « ${c.text.v.slice(0, 60)} »` });
      }
      for (const c of r.changed) {
        const b = before.get(c.id);
        if (!b) continue;
        const newReplies = visibleReplies(c).filter(x => !b.replies.some(y => y.id === x.id));
        if (newReplies.length) dd.notify(`↩️ ${newReplies[newReplies.length - 1].authorName} a répondu au commentaire de ${fmtTime(c.pos.v.t)} : « ${newReplies[newReplies.length - 1].text.v.slice(0, 100)} »`);
        else if (b.status.v.s !== c.status.v.s) dd.notify(c.status.v.s === 'resolved' ? `✅ ${who} a résolu le commentaire de ${fmtTime(c.pos.v.t)}.` : `↩️ ${who} a rouvert le commentaire de ${fmtTime(c.pos.v.t)}.`);
        else if (b.archived.v !== c.archived.v && c.archived.v) dd.notify(`🗄️ ${who} a archivé le commentaire de ${fmtTime(c.pos.v.t)}.`);
      }
      return;
    }
    if (o.kind === MIX_VERSIONS_KIND) {
      const incoming = readVersionsOp(o.op);
      if (!incoming.length) return;
      const k = clock();
      incoming.forEach(v => k.observe(v.decision.s));
      const opts = { fromEngineer: o.role === 'engineer', fromArtist: o.role === 'artist' };
      const cur = dd.stateRef.current.mixVersions;
      let r = mergeVersions(cur, incoming, opts);
      // Décision arrivée avant sa version (ordre d'arrivée) : gardée, refusionnée à l'arrivée de la version.
      r.orphans.forEach(v => orphansRef.current.set(v.id, v));
      const waiting = r.added.map(v => orphansRef.current.get(v.id)).filter(Boolean) as MixVersion[];
      if (waiting.length) {
        waiting.forEach(v => orphansRef.current.delete(v.id));
        const r2 = mergeVersions(r.list, waiting, { fromEngineer: false, fromArtist: true });
        r = { ...r2, added: r.added, decided: [...r.decided, ...r2.decided] };
      }
      if (!r.added.length && !r.decided.length) return;
      write(s => ({ ...s, mixVersions: r.list }));
      if (o.replay) return;
      for (const v of r.added) {
        dd.notify(`📨 ${v.sentBy} t'envoie « ${v.name} »${v.note ? ` : « ${v.note.slice(0, 100)} »` : ''}. Écoute-la, puis valide ou demande des retouches.`);
        dd.history?.({ who: v.sentBy, role: o.role, seq: o.seq, text: `a envoyé « ${v.name} »` });
        if (dd.collab()?.role === 'artist') { setTab('versions'); }
      }
      for (const v of r.decided) {
        const line = versionStatusLine(v);
        dd.notify(v.decision.v?.kind === 'approved' ? `🎉 ${line}.` : `✎ ${line}`);
        dd.history?.({ who: v.decision.v?.by || who, role: o.role, seq: o.seq, text: v.decision.v?.kind === 'approved' ? `a validé la version ${v.n}` : `a demandé des retouches sur la version ${v.n}` });
      }
    }
  }, []);

  // ── Diagnostic (scénarios de bout en bout, console) ─────────────────────────
  useEffect(() => {
    (window as any).__novaComments = {
      list: () => (dRef.current.stateRef.current.timelineComments || []).map(c => ({
        id: c.id, t: c.pos.v.t, end: c.pos.v.end, text: c.text.v, by: c.authorName, status: c.status.v.s, archived: c.archived.v,
        replies: visibleReplies(c).map(r => ({ by: r.authorName, text: r.text.v })),
      })),
      times: () => Object.fromEntries(timesRef.current),
      /** Empreinte complète (registres et horodatages compris) : identique chez tous après convergence. */
      sig: () => sortComments(dRef.current.stateRef.current.timelineComments || []).map(commentSig).join('|'),
      versionsSig: () => (dRef.current.stateRef.current.mixVersions || []).map(versionSig).join('|'),
      versions: () => (dRef.current.stateRef.current.mixVersions || []).map(v => ({ id: v.id, n: v.n, name: v.name, sentBy: v.sentBy, sentAt: v.sentAt, audio: !!v.audio, duration: v.audio?.duration ?? null, decision: v.decision.v, line: versionStatusLine(v) })),
      playing: () => playerRef.current ? playing?.id ?? true : null,
    };
    return () => { delete (window as any).__novaComments; };
  }, [playing]);

  return {
    comments, versions, open, setOpen, tab, setTab, focusId, setFocusId, busy, playingId: playing?.id ?? null,
    add, reply, resolve, archive, goTo, openAt, sendNewVersion, decideVersion, playVersion, stopVersion, onRemote,
  };
}

export type TimelineCommentsApi = ReturnType<typeof useTimelineComments>;
