import { useEffect, useRef } from 'react';
import { produce } from 'immer';
import { DAWState, Track } from '../types';
import { novaBridge } from '../services/NovaBridge';
import {
  applyInstrumentRender, clearInstrumentRender, ensureInstrumentSlot, instrumentRenderSig, isInstrumentRenderCurrent,
  loadedInstrumentTracks, onInstrumentState, renderInstrumentTrack, unloadInstrumentSlot,
} from '../services/VstInstrument';
import { instrumentStore } from '../utils/instrumentStore';
import { useBridgeState } from './useNovaBridge';

/** Délai après la dernière modification des notes avant le rendu. */
const RENDER_DEBOUNCE_MS = 600;

/**
 * Rendu automatique des pistes MIDI jouées par un instrument VST3 du PC :
 * notes, tempo ou son modifiés -> nouveau rendu ~600 ms après la dernière
 * modification (pont connecté). Le rendu est rangé sans étape d'annulation
 * (Ctrl+Z annule les notes, pas le rendu qui les suit).
 */
export function useVstInstruments(opts: {
  tracks: Track[];
  bpm: number;
  stateRef: React.MutableRefObject<DAWState>;
  /** Mise à jour du projet sans étape d'annulation. */
  setSilently: (fn: (s: DAWState) => DAWState) => void;
  /** Collaboration : seul le propriétaire des notes rend la piste. */
  canRender: (t: Track) => boolean;
  releaseBuffer: (bufferId: string | undefined) => void;
  notify: (msg: string) => void;
}) {
  const bridge = useBridgeState();
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const timers = useRef(new Map<string, number>());
  const running = useRef(new Set<string>());
  const again = useRef(new Set<string>());
  const failedSig = useRef(new Map<string, string>());

  // Son changé dans la fenêtre du plugin -> état de la piste (le rendu suit).
  useEffect(() => onInstrumentState((trackId, stateB64) => {
    optsRef.current.setSilently(produce((d: DAWState) => {
      const t = d.tracks.find(x => x.id === trackId);
      if (t?.vstInstrument && t.vstInstrument.stateB64 !== stateB64) t.vstInstrument.stateB64 = stateB64;
    }));
  }), []);

  const run = async (trackId: string) => {
    if (running.current.has(trackId)) { again.current.add(trackId); return; }
    running.current.add(trackId);
    instrumentStore.patch(trackId, { rendering: true });
    const { stateRef } = optsRef.current;
    let sig = '';
    let name = '';
    try {
      const first = stateRef.current.tracks.find(t => t.id === trackId);
      if (!first?.vstInstrument) return;
      name = first.name;
      sig = instrumentRenderSig(first, stateRef.current.bpm);
      // Premier chargement : l'état d'origine du plugin arrive avec lui.
      await ensureInstrumentSlot(first).catch(() => undefined);
      await new Promise(r => setTimeout(r, 30));
      const t = stateRef.current.tracks.find(x => x.id === trackId);
      if (!t?.vstInstrument) return;
      const bpm = stateRef.current.bpm;
      // Déjà à jour (demande arrivée pendant le rendu précédent) : rien à refaire.
      if (isInstrumentRenderCurrent(t, bpm)) return;
      sig = instrumentRenderSig(t, bpm);
      const r = await renderInstrumentTrack(t, bpm);
      let old: string | undefined;
      let applied = false;
      optsRef.current.setSilently(produce((d: DAWState) => {
        const x = d.tracks.find(y => y.id === trackId);
        // Instrument changé ou retiré pendant le rendu : rendu jeté.
        if (!x?.vstInstrument || x.vstInstrument.path !== r.path) return;
        old = x.frozenClip?.bufferId;
        applyInstrumentRender(x, r);
        applied = true;
      }));
      if (!applied && r.clip?.bufferId) optsRef.current.releaseBuffer(r.clip.bufferId);
      if (old && old !== r.clip?.bufferId) setTimeout(() => optsRef.current.releaseBuffer(old), 0);
      failedSig.current.delete(trackId);
      instrumentStore.patch(trackId, { error: null });
    } catch (e: any) {
      console.warn('[Instrument VST] rendu impossible', e);
      failedSig.current.set(trackId, sig);
      const msg = e?.message || 'erreur';
      instrumentStore.patch(trackId, { error: msg });
      let old: string | undefined;
      optsRef.current.setSilently(produce((d: DAWState) => {
        const x = d.tracks.find(y => y.id === trackId);
        if (!x?.vstInstrument) return;
        old = x.frozenClip?.bufferId;
        clearInstrumentRender(x);
        delete x.vstInstrument.renderSig;
      }));
      if (old) setTimeout(() => optsRef.current.releaseBuffer(old), 0);
      optsRef.current.notify(`🎹 Rendu de « ${name || 'la piste'} » impossible : ${msg}. Le synthé Nova joue tes notes en attendant.`);
    } finally {
      running.current.delete(trackId);
      instrumentStore.patch(trackId, { rendering: false });
      if (again.current.delete(trackId)) schedule(trackId);
    }
  };

  const schedule = (trackId: string) => {
    const old = timers.current.get(trackId);
    if (old) window.clearTimeout(old);
    timers.current.set(trackId, window.setTimeout(() => {
      timers.current.delete(trackId);
      void run(trackId);
    }, RENDER_DEBOUNCE_MS));
  };

  // Notes / tempo / son modifiés : rendu (anti-rebond). Instances libérées
  // pour les pistes supprimées ou repassées au synthé Nova.
  useEffect(() => {
    const { tracks, bpm, canRender } = optsRef.current;
    const withInstrument = new Set(tracks.filter(t => t.vstInstrument).map(t => t.id));
    loadedInstrumentTracks().forEach(id => { if (!withInstrument.has(id)) { unloadInstrumentSlot(id); instrumentStore.clear(id); } });
    if (bridge.status !== 'connected' || !bridge.instruments) { failedSig.current.clear(); return; }
    for (const t of tracks) {
      if (!t.vstInstrument || !canRender(t)) continue;
      if (isInstrumentRenderCurrent(t, bpm)) continue;
      // Même rendu déjà raté : on attend une modification (ou « Réessayer »).
      if (failedSig.current.get(t.id) === instrumentRenderSig(t, bpm)) continue;
      schedule(t.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.tracks, opts.bpm, bridge.status, bridge.instruments]);

  useEffect(() => () => { timers.current.forEach(id => window.clearTimeout(id)); }, []);

  /** « Réessayer » : relance le rendu tout de suite. */
  return {
    retry: (trackId: string) => { failedSig.current.delete(trackId); instrumentStore.patch(trackId, { error: null }); void run(trackId); },
    isConnected: () => novaBridge.isConnected(),
  };
}
