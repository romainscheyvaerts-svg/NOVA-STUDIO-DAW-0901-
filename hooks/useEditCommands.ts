import { useEffect, useMemo, useRef } from 'react';
import { produce } from 'immer';
import { Clip, CrossfadeCurve, DAWState, TrackType } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { autoCrossfadePatches, DEFAULT_XFADE_SEC, FADE_CURVE_INFO, makeCrossfade, handlesOf, nudgeSeconds, NudgeUnit, NUDGE_UNITS } from '../utils/fades';
import { editPrefsStore, editSelectionStore } from '../utils/editSelection';
import { shiftSelection } from '../utils/timeSelection';
import { playheadStore } from '../utils/playheadStore';

/**
 * Commandes d'édition « façon Pro Tools » appelables de partout (clavier,
 * menus, barre d'actions, IA). Le système de raccourcis global (autre chantier)
 * n'a qu'à appeler ces fonctions : `useEditCommands` les renvoie, et
 * `getEditCommands()` les donne hors de React.
 *
 * Toutes les éditions passent par `setState` (immer) : une commande = une
 * étape d'annulation (Ctrl+Z).
 */
export interface EditCommands {
  /** État courant du projet (lecture seule). */
  getState: () => DAWState;
  // --- Punch (vague 1)
  togglePunch: () => void;
  toggleQuickPunch: () => void;
  // --- Fondus, crossfades, nudge (vague 2)
  /** Courbe des fondus d'entrée / de sortie des clips donnés. */
  setFadeCurve: (trackId: string, clipIds: string[], which: 'in' | 'out' | 'both', curve: CrossfadeCurve) => void;
  /** Modifie plusieurs clips d'une piste en une seule étape d'annulation. */
  patchClips: (trackId: string, patches: Map<string, Partial<Clip>> | Record<string, Partial<Clip>>) => void;
  /** Crossfade entre deux clips (jonction ou chevauchement). false si l'audio manque. */
  crossfade: (trackId: string, aId: string, bId: string, length?: number, curve?: CrossfadeCurve) => boolean;
  /** Crossfade automatique des clips modifiés avec leurs voisins (selon la préférence). */
  autoCrossfade: (trackId: string, clipIds: string[]) => void;
  /** Nudge (Pro Tools) : clips sélectionnés (sinon la sélection de plage) d'un pas. */
  nudge: (direction: 1 | -1, steps?: number) => void;
  setNudgeUnit: (unit: NudgeUnit) => void;
  nudgeStepSeconds: () => number;
}

export interface EditCommandDeps {
  stateRef: React.MutableRefObject<DAWState>;
  setState: (updater: (prev: DAWState) => DAWState) => void;
  notify: (text: string) => void;
  togglePunch: () => void;
  toggleQuickPunch: () => void;
}

let current: EditCommands | null = null;
/** Commandes d'édition du studio ouvert (null avant son montage). */
export const getEditCommands = (): EditCommands | null => current;

/** Durée de l'audio d'un clip (pour les « handles » des crossfades). */
export const bufferDurationOf = (c: { bufferId?: string; buffer?: { duration: number } }): number | undefined =>
  c.buffer?.duration ?? (c.bufferId ? audioBufferRegistry.get(c.bufferId)?.duration : undefined);

const fmtMs = (s: number) => (s >= 1 ? `${s.toFixed(2).replace('.', ',')} s` : `${Math.round(s * 1000)} ms`);

export function useEditCommands(deps: EditCommandDeps): EditCommands {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const commands = useMemo<EditCommands>(() => {
    const d = () => depsRef.current;
    const st = () => d().stateRef.current;

    const patchClips: EditCommands['patchClips'] = (trackId, patches) => {
      const entries = patches instanceof Map ? Array.from(patches.entries()) : Object.entries(patches);
      if (!entries.length) return;
      d().setState(produce((draft: DAWState) => {
        const t = draft.tracks.find(x => x.id === trackId);
        if (!t) return;
        for (const [id, p] of entries) {
          const c = t.clips.find(x => x.id === id);
          if (c) Object.assign(c, p);
        }
      }));
    };

    const nudgeStepSeconds = () => {
      const s = st();
      return nudgeSeconds(editPrefsStore.get().nudge, s.bpm, (window as any).gridSize || '1/4');
    };

    return {
      getState: st,
      togglePunch: () => d().togglePunch(),
      toggleQuickPunch: () => d().toggleQuickPunch(),

      setFadeCurve: (trackId, clipIds, which, curve) => {
        const p: Partial<Clip> = {};
        if (which !== 'out') p.fadeInCurve = curve;
        if (which !== 'in') p.fadeOutCurve = curve;
        const patches: Record<string, Partial<Clip>> = {};
        clipIds.forEach(id => { patches[id] = p; });
        patchClips(trackId, patches);
        d().notify(`Courbe ${which === 'in' ? 'du fondu d\'entrée' : which === 'out' ? 'du fondu de sortie' : 'des fondus'} : ${FADE_CURVE_INFO[curve].label}`);
      },

      patchClips,

      crossfade: (trackId, aId, bId, length = DEFAULT_XFADE_SEC, curve) => {
        const t = st().tracks.find(x => x.id === trackId);
        const a = t?.clips.find(c => c.id === aId);
        const b = t?.clips.find(c => c.id === bId);
        if (!a || !b) return false;
        const cv = curve || editPrefsStore.get().xfadeCurve;
        const x = makeCrossfade(a, b, length, cv, handlesOf(a, b, bufferDurationOf));
        if (!x) {
          d().notify('Crossfade impossible : il n\'y a pas d\'audio au-delà du bord des deux clips (rallonge l\'un des deux d\'abord).');
          return false;
        }
        patchClips(trackId, { [a.id]: x.a, [b.id]: x.b });
        return true;
      },

      autoCrossfade: (trackId, clipIds) => {
        const prefs = editPrefsStore.get();
        if (!prefs.autoXfade) return;
        const t = st().tracks.find(x => x.id === trackId);
        if (!t || t.type === TrackType.MIDI) return;
        const p = autoCrossfadePatches(t.clips, new Set(clipIds), prefs.xfadeCurve, bufferDurationOf);
        if (p.size) patchClips(trackId, p);
      },

      nudge: (direction, steps = 1) => {
        const step = nudgeStepSeconds() * steps * direction;
        const sel = editSelectionStore.get();
        const ids = new Set(sel.clipIds);
        if (ids.size) {
          // Pas sous zéro : le groupe entier s'arrête au début du morceau.
          let minStart = Infinity;
          st().tracks.forEach(t => t.clips.forEach(c => { if (ids.has(c.id)) minStart = Math.min(minStart, c.start); }));
          const delta = Math.max(-minStart, step);
          if (Math.abs(delta) < 1e-9) return;
          d().setState(produce((draft: DAWState) => {
            draft.tracks.forEach(t => t.clips.forEach(c => { if (ids.has(c.id)) c.start = Math.max(0, c.start + delta); }));
          }));
          if (sel.time) editSelectionStore.set({ time: shiftSelection(sel.time, delta) });
          return;
        }
        if (sel.time) {
          const next = shiftSelection(sel.time, step);
          editSelectionStore.set({ time: next });
          playheadStore.set(next.start);
        }
      },

      setNudgeUnit: (unit) => {
        editPrefsStore.set({ nudge: unit });
        const label = NUDGE_UNITS.find(u => u.id === unit)?.label || unit;
        d().notify(`Nudge : ${label} (${fmtMs(nudgeStepSeconds())}) — flèches ← / → sur la sélection.`);
      },

      nudgeStepSeconds,
    };
  }, []);
  useEffect(() => {
    current = commands;
    // Accès pour les tests de bout en bout (navigateur headless) et la console.
    (window as any).__novaEdit = commands;
    return () => {
      if (current === commands) current = null;
      if ((window as any).__novaEdit === commands) delete (window as any).__novaEdit;
    };
  }, [commands]);
  return commands;
}
