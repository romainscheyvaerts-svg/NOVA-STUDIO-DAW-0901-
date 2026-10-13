import { useCallback, useEffect, useRef, useState } from 'react';
import type { CollabRole } from '../types';
import type { GuestRights } from '../utils/guestRights';
import {
  CABIN_ACK_TIMEOUT_MS, CABIN_EV, CabinDedup, cabinAckText, cabinDecide, newCabinId, nextClockOffset,
  sanitizeCabinAck, sanitizeCabinCommand, sanitizeCabinState,
  type CabinCmd, type CabinState,
} from '../utils/cabinRemote';

/**
 * Télécommande de cabine (utils/cabinRemote) : les deux côtés.
 *  - useCabinHost : chez l'ingé. Exécute les commandes permises, publie l'état du transport.
 *  - useCabinPhone : chez l'artiste. Envoie les commandes, suit l'état et les accusés.
 * Les messages passent par le direct de la collaboration (services/Collab, broadcast).
 */

interface Wire {
  memberKey: string;
  broadcast: (event: any, payload: Record<string, unknown>) => boolean;
}
interface OnlineMember { member_key: string; role: CollabRole; display_name: string }

/** Mesures exposées pour la QA (window.__novaCabin) : instants en ms (Date.now). */
const qa = (): Record<string, any> => {
  const w = window as any;
  if (!w.__novaCabin) w.__novaCabin = { executed: [], acks: [], sent: [] };
  return w.__novaCabin;
};

export function useCabinHost(o: {
  wire: () => Wire | null;
  role: CollabRole | null;
  name: string;
  rights: GuestRights | null | undefined;
  isRecording: boolean;
  isPlaying: boolean;
  countInBeat: number | null;
  /** Une prise est en train de démarrer (armement, décompte). */
  busy: () => boolean;
  online: () => OnlineMember[];
  position: () => number;
  armedName: () => string | null;
  /** REC demandé par cet artiste (clé de participant, nom). */
  record: (by: { key: string; name: string }) => void;
  play: () => void;
  stop: () => void;
  home: () => void;
  notify: (text: string) => void;
}) {
  const ref = useRef(o);
  ref.current = o;
  const dedup = useRef(new CabinDedup());
  const active = o.role === 'engineer' && !!o.rights?.remote;

  const publish = useCallback((allowedOverride?: boolean) => {
    const p = ref.current;
    const w = p.wire();
    if (!w || p.role !== 'engineer') return;
    const st: CabinState = {
      from: w.memberKey, eng: p.name, allowed: allowedOverride ?? !!p.rights?.remote,
      rec: p.isRecording, play: p.isPlaying, pos: Math.max(0, p.position()), ci: p.countInBeat,
      track: p.armedName(), at: Date.now(),
    };
    w.broadcast(CABIN_EV.state, st as unknown as Record<string, unknown>);
  }, []);

  // Mesure (QA) : début du décompte chez l'ingé.
  const ciWas = useRef<number | null>(null);
  useEffect(() => {
    if (o.countInBeat !== null && ciWas.current === null) { try { qa().countIn = [...(qa().countIn || []), Date.now()]; } catch { /* */ } }
    ciWas.current = o.countInBeat;
  }, [o.countInBeat]);
  // État publié : à chaque changement (REC, lecture, décompte) et toutes les secondes.
  useEffect(() => { if (active) publish(); }, [active, o.isRecording, o.isPlaying, o.countInBeat, publish]);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (ref.current.online().some(m => m.role === 'artist')) publish();
    }, 1000);
    return () => window.clearInterval(id);
  }, [active, publish]);
  // Télécommande retirée par l'ingé : les téléphones le savent tout de suite.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) publish(false);
    wasActive.current = active;
  }, [active, publish]);

  /** Message éphémère reçu : true s'il était pour la télécommande. */
  const onEvent = useCallback((ev: string, payload: unknown): boolean => {
    if (ev === CABIN_EV.ask) {
      const p = ref.current;
      if (p.role === 'engineer' && p.rights?.remote) publish();
      return true;
    }
    if (ev !== CABIN_EV.cmd) return ev === CABIN_EV.ack || ev === CABIN_EV.state;
    const p = ref.current;
    const w = p.wire();
    const c = sanitizeCabinCommand(payload);
    if (!w || !c) return true;
    const sender = p.online().find(m => m.member_key === c.from) || null;
    const now = Date.now();
    const d = cabinDecide(c, {
      myKey: w.memberKey, myRole: p.role, myName: p.name, rights: p.rights,
      senderRole: sender?.role ?? null, senderName: sender?.display_name ?? null,
      isRecording: p.isRecording, isPlaying: p.isPlaying, countIn: p.countInBeat !== null, busy: p.busy(),
      dedup: dedup.current, now,
    });
    if (!d) return true;
    w.broadcast(CABIN_EV.ack, { ...d.ack, id: c.id, to: c.from, at: now });
    if (d.action === 'none') return true;
    try { qa().executed.push({ id: c.id, cmd: c.cmd, at: now }); } catch { /* */ }
    if (d.log) p.notify(d.log);
    if (d.action === 'record') {
      p.record({ key: c.from, name: sender?.display_name || '' });
      // La prise n'a pas démarré (micro refusé, question à l'écran de l'ingé…) : on le dit à l'artiste,
      // dès que la mise en route est finie (armement du micro compris).
      const t0 = Date.now();
      const watch = () => {
        const q = ref.current;
        if (q.isRecording || q.countInBeat !== null) return;
        if (q.busy() && Date.now() - t0 < 15000) { window.setTimeout(watch, 300); return; }
        q.wire()?.broadcast(CABIN_EV.ack, {
          id: c.id, to: c.from, at: Date.now(), ok: false,
          reason: `La prise n'a pas démarré chez ${q.name || "l'ingé"} (micro pas prêt, ou une question est ouverte sur son écran). Dis-lui avec « Parler ».`,
        });
      };
      window.setTimeout(watch, 600);
    } else if (d.action === 'play') p.play();
    else if (d.action === 'stop') p.stop();
    else if (d.action === 'home') p.home();
    window.setTimeout(() => publish(), 60);
    return true;
  }, [publish]);

  return { onEvent, active };
}

export interface CabinResult { ok: boolean; text: string; cmd: CabinCmd; ms: number | null; at: number }

export function useCabinPhone(o: {
  wire: () => Wire | null;
  /** Clé de membre de l'ingé en ligne (null : pas là). */
  engineerKey: string | null;
  engineerName: string;
  /** Écran cabine ouvert. */
  open: boolean;
  onRetry?: () => void;
}) {
  const ref = useRef(o);
  ref.current = o;
  const [state, setState] = useState<CabinState | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [pending, setPending] = useState<{ id: string; cmd: CabinCmd; sentAt: number } | null>(null);
  const [last, setLast] = useState<CabinResult | null>(null);
  const offset = useRef<number | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const recent = useRef(new Map<string, { cmd: CabinCmd; sentAt: number }>());

  const ask = useCallback(() => {
    const w = ref.current.wire();
    if (!w || !ref.current.engineerKey) return;
    w.broadcast(CABIN_EV.ask, { from: w.memberKey, to: ref.current.engineerKey });
  }, []);

  // Ouverture, écran rallumé (téléphone verrouillé puis rouvert), retour du réseau : on redemande l'état.
  useEffect(() => {
    if (!o.open) return;
    ask();
    const again = () => { if (document.visibilityState === 'visible') { ref.current.onRetry?.(); ask(); window.setTimeout(ask, 800); } };
    document.addEventListener('visibilitychange', again);
    window.addEventListener('online', again);
    window.addEventListener('focus', again);
    return () => { document.removeEventListener('visibilitychange', again); window.removeEventListener('online', again); window.removeEventListener('focus', again); };
  }, [o.open, o.engineerKey, ask]);
  // Ingé parti ou changé : on oublie son état.
  useEffect(() => { setState(null); setReceivedAt(null); offset.current = null; }, [o.engineerKey]);

  const send = useCallback((cmd: CabinCmd, tapAt?: number, force = false): boolean => {
    const p = ref.current;
    const w = p.wire();
    // Double appui (même dans la même image) : déjà en route, rien ne repart.
    if (!force && pendingRef.current?.cmd === cmd) return false;
    const eng = p.engineerName || "l'ingé";
    if (!w || !p.engineerKey) {
      setLast({ ok: false, cmd, ms: null, at: Date.now(), text: `${eng} n'est pas relié : rien n'est parti.` });
      return false;
    }
    const id = newCabinId();
    const now = Date.now();
    const ok = w.broadcast(CABIN_EV.cmd, { id, cmd, from: w.memberKey, to: p.engineerKey, at: now + (offset.current ?? 0) });
    try { qa().sent.push({ id, cmd, at: now, tapAt: tapAt ?? now, ok }); } catch { /* */ }
    if (!ok) {
      setLast({ ok: false, cmd, ms: null, at: now, text: '📡 Pas de réseau : la commande n’est pas partie, rien n’a été lancé. Reconnecte le Wi-Fi, puis réessaie.' });
      return false;
    }
    const pend = { id, cmd, sentAt: tapAt ?? now };
    recent.current.set(id, { cmd, sentAt: pend.sentAt });
    if (recent.current.size > 50) recent.current.delete(recent.current.keys().next().value as string);
    pendingRef.current = pend;
    setPending(pend);
    window.setTimeout(() => {
      if (pendingRef.current?.id !== id) return;
      setPending(null);
      setLast({ ok: false, cmd, ms: null, at: Date.now(), text: `${eng} n'a pas répondu : rien n'est sûr. Regarde le voyant REC, puis réessaie ou parle-lui.` });
      ask();
    }, CABIN_ACK_TIMEOUT_MS);
    return true;
  }, [ask]);

  const onEvent = useCallback((ev: string, payload: unknown): boolean => {
    const w = ref.current.wire();
    if (ev === CABIN_EV.state) {
      const s = sanitizeCabinState(payload);
      if (!s || (ref.current.engineerKey && s.from !== ref.current.engineerKey)) return true;
      const now = Date.now();
      offset.current = nextClockOffset(offset.current, s.at, now);
      setState(s);
      setReceivedAt(now);
      return true;
    }
    if (ev === CABIN_EV.ack) {
      const a = sanitizeCabinAck(payload);
      if (!a || !w || a.to !== w.memberKey) return true;
      const sent = recent.current.get(a.id);
      if (!sent) return true;
      const now = Date.now();
      try { qa().acks.push({ id: a.id, ok: a.ok, done: a.done, at: now, ms: now - sent.sentAt }); } catch { /* */ }
      if (pendingRef.current?.id === a.id) setPending(null);
      // Un accusé « fait » ne remplace pas un échec déjà affiché pour une autre commande plus récente.
      setLast({ ok: a.ok, cmd: sent.cmd, ms: now - sent.sentAt, at: now, text: cabinAckText(a, ref.current.engineerName || "l'ingé") });
      return true;
    }
    return ev === CABIN_EV.cmd || ev === CABIN_EV.ask;
  }, []);

  // QA : une commande envoyée sans la protection du téléphone (deux téléphones, ancienne version) :
  // la protection de l'ingé (cabinDecide) doit tenir seule.
  useEffect(() => {
    if (!o.open) return;
    try { qa().forceSend = (cmd: CabinCmd) => send(cmd, Date.now(), true); } catch { /* */ }
    return () => { try { delete qa().forceSend; } catch { /* */ } };
  }, [o.open, send]);

  return { state, receivedAt, pending: pending?.cmd ?? null, last, send, ask, onEvent };
}
