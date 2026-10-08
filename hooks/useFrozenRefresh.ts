import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { produce } from 'immer';
import type { DAWState, Track } from '../types';
import {
  breathsNeedRefreeze, freezeDrift, freezeDriftKey, freezeIndex, freezeOutdated, freezeSignature, isTrackFrozen, isVst, preFreezePlugins,
} from '../utils/freeze';
import { applyFreezeResult, renderTrackFreeze } from '../services/VstFreeze';
import { novaBridge } from '../services/NovaBridge';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { getEditAuthor } from '../utils/preFxEdits';

/**
 * Rendu gelé périmé (utils/freeze : freezeDrift) : dès qu'un clip d'une piste
 * gelée change — quelle que soit l'opération —, on refait le rendu quand c'est
 * sûr (aucun VST dans le rendu, ou pont connecté). Sinon, si le son a changé,
 * une notification propose de dégeler ; la piste affiche « gel à refaire ».
 *
 * Le regel n'est PAS une étape d'annulation : il remplace le présent sans
 * toucher à l'historique. Ctrl+Z revient donc à l'état d'avant la
 * modification, ancien rendu compris (l'ancien son reste en mémoire tant
 * qu'une étape d'annulation y fait référence).
 */

// --- Regels en cours (affichés dans l'en-tête de piste) ---------------------

const busy = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const setBusy = (id: string, on: boolean) => { if (on) busy.add(id); else busy.delete(id); emit(); };
/** Regel de cette piste en cours ? */
export const useFreezeRefreshBusy = (trackId: string): boolean =>
  useSyncExternalStore(subscribe, () => busy.has(trackId), () => false);

// --- Règles (pures, testées) --------------------------------------------------

export interface RefreezeContext {
  /** Pont VST connecté (les VST du rendu peuvent tourner). */
  bridge: boolean;
  /** Chez l'artiste en mode « Ingé à distance » (rendus faits par l'ingé). */
  remoteArtist: boolean;
}

/** Le rendu de cette piste peut-il être refait ici ? */
export const canRefreezeHere = (t: Track, ctx: RefreezeContext): boolean => {
  if (!isTrackFrozen(t) || t.vstInstrument) return false;
  // Rendu fait par l'ingé à distance (ses VST) : on ne peut pas le refaire ici.
  if (t.remote && ctx.remoteArtist) return false;
  return ctx.bridge || !preFreezePlugins(t).some(p => isVst(p) && p.isEnabled);
};

export type RefreshAction = { id: string; key: string; action: 'refreeze' | 'notify' | 'mark' };

/**
 * Que faire des pistes gelées dont le rendu est périmé ? `handled` : dernier
 * état déjà traité sans succès par piste (bloqué, échec) — on n'y revient pas
 * tant que rien ne change.
 */
export function planFrozenRefresh(tracks: Track[], ctx: RefreezeContext, handled: ReadonlyMap<string, string>, inFlight: ReadonlySet<string> = new Set()): RefreshAction[] {
  const out: RefreshAction[] = [];
  for (const t of tracks) {
    if (inFlight.has(t.id)) continue;
    const key = freezeDriftKey(t);
    if (!key || handled.get(t.id) === key) continue;
    // Gel automatique de l'ingé (frozenAuto) : ses éditions sont rejouées avant ses effets au
    // dégel sur son PC (utils/preFxEdits) ; un regel ici effacerait ce journal.
    if (canRefreezeHere(t, ctx) && !t.frozenAuto) out.push({ id: t.id, key, action: 'refreeze' });
    // Son changé que la lecture ne peut pas suivre : prévenir (Dégeler).
    else if (freezeDrift(t)!.content.length) out.push({ id: t.id, key, action: 'notify' });
    // Gain, fondus, découpes… : déjà suivis (à peu près) par les tranches, indicateur seulement.
    else out.push({ id: t.id, key, action: 'mark' });
  }
  return out;
}

// --- Hôte -----------------------------------------------------------------------

export interface FrozenStaleNotice { id: number; trackId: string; text: string }

interface Options {
  tracks: Track[];
  enabled: boolean;
  isRecording: boolean;
  stateRef: React.MutableRefObject<DAWState>;
  setSilently: (fn: (prev: DAWState) => DAWState) => void;
  releaseBufferIfUnused: (bufferId: string | undefined, excludeClipIds: string[]) => void;
  ensureAudioEngine: () => Promise<void>;
}

/** Attente avant de regarder les pistes : une suite de gestes (glisser un gain) ne fait qu'un regel. */
const SETTLE_MS = 350;

export function useFrozenRefresh(o: Options) {
  const opts = useRef(o);
  opts.current = o;
  const [notice, setNotice] = useState<FrozenStaleNotice | null>(null);
  /** Dernier état traité sans succès, par piste. */
  const handled = useRef(new Map<string, string>());
  /** Clips signalés (notification déjà montrée), par piste. */
  const notified = useRef(new Map<string, string>());
  const inFlight = useRef(new Map<string, Promise<void>>());
  const timer = useRef<number | undefined>(undefined);
  const scheduleRef = useRef<() => void>(() => {});

  const ctxNow = (): RefreezeContext => ({
    bridge: novaBridge.isConnected(),
    remoteArtist: opts.current.stateRef.current.remoteInge?.role === 'artist',
  });
  const findTrack = (id: string) => opts.current.stateRef.current.tracks.find(x => x.id === id);

  const showBlocked = useCallback((id: string) => {
    const t = findTrack(id);
    const d = t ? freezeDrift(t) : null;
    notified.current.set(id, (d?.content || []).join(','));
    setNotice({ id: Date.now(), trackId: id, text: `❄️ Piste gelée « ${t?.name || 'piste'} » : dégèle-la pour entendre le traitement.` });
  }, []);

  /** Refait le rendu d'une piste (même plage d'effets) ; false si ce rendu ne correspond plus. */
  const renderOne = async (id: string): Promise<'ok' | 'moved' | 'error'> => {
    const { setSilently, releaseBufferIfUnused, ensureAudioEngine } = opts.current;
    const t = findTrack(id);
    if (!t || !isTrackFrozen(t)) return 'moved';
    const before = freezeDriftKey(t);
    try {
      setBusy(id, true);
      await ensureAudioEngine();
      const renderId = t.frozenClip!.id;
      const r = await renderTrackFreeze(t, freezeIndex(t));
      // Modifiée pendant le rendu (ou Annuler) : ce rendu ne correspond plus.
      const matches = (tt: Track | undefined) => !!tt && !!tt.isFrozen && tt.frozenClip?.id === renderId
        && freezeSignature(tt.clips || [], tt.plugins || [], r.upTo) === r.sig;
      if (!matches(findTrack(id))) {
        if (r.clip.bufferId) audioBufferRegistry.remove(r.clip.bufferId);
        return 'moved';
      }
      const oldBufferId = t.frozenClip!.bufferId;
      let applied = false;
      setSilently(produce((draft: DAWState) => {
        const tt = draft.tracks.find(x => x.id === id);
        // (L'état a pu bouger entre-temps : on revérifie au moment d'appliquer.)
        if (!matches(tt as Track | undefined)) return;
        applyFreezeResult(tt as Track, r, getEditAuthor() || undefined);
        applied = true;
      }));
      // setSilently passe par la file de React : on attend que le présent soit à jour.
      for (let i = 0; i < 40 && findTrack(id)?.frozenClip?.id !== r.clip.id; i++) await new Promise(res => setTimeout(res, 10));
      if (!applied && findTrack(id)?.frozenClip?.id !== r.clip.id) {
        setTimeout(() => releaseBufferIfUnused(r.clip.bufferId, []), 0);
        return 'moved';
      }
      if (oldBufferId && oldBufferId !== r.clip.bufferId) setTimeout(() => releaseBufferIfUnused(oldBufferId, []), 50);
      // Toujours en écart après un rendu tout neuf (clip impossible à ancrer…) : on n'insiste pas.
      const after = findTrack(id);
      const keyAfter = after ? freezeDriftKey(after) : null;
      if (keyAfter) handled.current.set(id, keyAfter);
      return 'ok';
    } catch (e) {
      console.warn('[Gel] Regel impossible', e);
      if (before) handled.current.set(id, before);
      return 'error';
    } finally {
      setBusy(id, false);
    }
  };

  /**
   * Regèle des pistes gelées dont des clips viennent de changer.
   * waitForState : la modification vient d'être demandée (setState pas encore appliqué).
   * blocked : pistes à dégeler pour entendre la modification (VST sans le pont, échec).
   */
  const refreeze = useCallback(async (trackIds: string[], waitForState = false): Promise<{ refrozen: string[]; blocked: string[] }> => {
    const { stateRef } = opts.current;
    if (waitForState) {
      const before = stateRef.current;
      for (let i = 0; i < 40 && stateRef.current === before; i++) await new Promise(r => setTimeout(r, 25));
    }
    const refrozen: string[] = [];
    const blocked: string[] = [];
    for (const id of trackIds) {
      // Un regel de cette piste est déjà en route : on l'attend, puis on regarde ce qui reste.
      const prev = inFlight.current.get(id);
      if (prev) {
        await prev;
        const cur = findTrack(id);
        if (cur && isTrackFrozen(cur) && !freezeOutdated(cur)) { refrozen.push(id); continue; }
      }
      const t = findTrack(id);
      if (!t || !isTrackFrozen(t) || t.vstInstrument) continue;
      const stale = (x: Track) => breathsNeedRefreeze(x) || !!freezeDrift(x)?.content.length;
      if (!canRefreezeHere(t, ctxNow())) {
        if (stale(t)) { blocked.push(id); const k = freezeDriftKey(t); if (k) handled.current.set(id, k); notified.current.set(id, (freezeDrift(t)?.content || []).join(',')); }
        continue;
      }
      let res = 'moved' as 'ok' | 'moved' | 'error';
      const p = renderOne(id).then(r => { res = r; });
      inFlight.current.set(id, p);
      try { await p; } finally { inFlight.current.delete(id); }
      if (res === 'ok') refrozen.push(id);
      else if (res === 'error') { const cur = findTrack(id); if (cur && stale(cur)) blocked.push(id); }
    }
    // Ce qui a bougé pendant les rendus est repris au prochain passage.
    scheduleRef.current();
    return { refrozen, blocked };
  }, []);

  /** Passe sur toutes les pistes gelées (après chaque modification, une fois l'édition posée). */
  const check = useCallback(() => {
    const { stateRef, enabled, isRecording } = opts.current;
    if (!enabled || isRecording) return;
    const tracks = stateRef.current.tracks;
    // Pistes revenues à jour (Annuler, regel, dégel) : on oublie, et la notification part.
    for (const id of Array.from(handled.current.keys())) {
      const t = tracks.find(x => x.id === id);
      if (!t || !freezeDriftKey(t)) handled.current.delete(id);
    }
    for (const id of Array.from(notified.current.keys())) {
      const t = tracks.find(x => x.id === id);
      if (!t || !freezeDrift(t)?.content.length) notified.current.delete(id);
    }
    setNotice(n => {
      if (!n) return n;
      const t = tracks.find(x => x.id === n.trackId);
      return t && freezeDrift(t)?.content.length ? n : null;
    });
    const ctx = ctxNow();
    const plan = planFrozenRefresh(tracks, ctx, handled.current, new Set(inFlight.current.keys()));
    const toRender: string[] = [];
    for (const a of plan) {
      if (a.action === 'refreeze') { toRender.push(a.id); continue; }
      handled.current.set(a.id, a.key);
      if (a.action === 'notify') {
        const t = tracks.find(x => x.id === a.id)!;
        const ids = freezeDrift(t)!.content.join(',');
        if (notified.current.get(a.id) !== ids) showBlocked(a.id);
      }
    }
    if (toRender.length) void refreeze(toRender).then(r => { r.blocked.forEach(id => showBlocked(id)); });
  }, [refreeze, showBlocked]);

  const schedule = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(check, SETTLE_MS);
  }, [check]);
  scheduleRef.current = schedule;

  useEffect(() => { schedule(); }, [o.tracks, o.enabled, o.isRecording, schedule]);
  // Pont VST connecté / coupé : ce qui était bloqué peut devenir faisable.
  const lastBridge = useRef(novaBridge.isConnected());
  useEffect(() => novaBridge.subscribe(() => {
    const bridge = novaBridge.isConnected();
    if (bridge !== lastBridge.current) { lastBridge.current = bridge; handled.current.clear(); schedule(); }
  }), [schedule]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const dismissNotice = useCallback(() => setNotice(null), []);
  return { refreeze, notice, dismissNotice };
}
