import { useEffect, useMemo, useRef } from 'react';
import { produce } from 'immer';
import { Clip, CrossfadeCurve, DAWState, TrackType } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { applyGainEvents, autoCrossfadePatches, clipGainEvents, DEFAULT_XFADE_SEC, FADE_CURVE_INFO, fadesForRange, makeCrossfade, handlesOf, nudgeSeconds, NudgeUnit, NUDGE_UNITS } from '../utils/fades';
import { editPrefsStore, editSelectionStore, requestSelectionExport } from '../utils/editSelection';
import {
  ClipsByTrack, consolidatePlan, ConsolidatePiece, copyRange, cutRange, deleteRange, duplicateRange, idGenerator, makeSelection,
  pasteRange, RangeClipboard, replaceWithConsolidated, selLength, separateAtSelection, shiftSelection, TimeSelection,
} from '../utils/timeSelection';
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
  // --- Sélection de plage (vague 3, Sélecteur / Smart Tool de Pro Tools)
  /** Pose la sélection de plage (null = point d'insertion seulement). */
  /** Sélection de plage courante (null = aucune). */
  getTimeSelection: () => TimeSelection | null;
  selectRange: (start: number, end: number, trackIds: string[]) => void;
  clearSelection: () => void;
  /** Pistes éditables dans l'ordre affiché (cibles de la sélection et du collage). */
  editableTrackIds: () => string[];
  copySelection: () => boolean;
  cutSelection: () => boolean;
  /** Colle la plage copiée au début de la sélection (sinon à la tête de lecture), sur les pistes sélectionnées (sinon la piste active). */
  pasteRange: () => boolean;
  /** Le dernier copier / couper portait sur une plage (Ctrl+V la colle). */
  hasRangeClipboard: () => boolean;
  /** À appeler quand un CLIP est copié : Ctrl+V collera ce clip, pas la plage. */
  markClipClipboard: () => void;
  deleteSelection: () => boolean;
  duplicateSelection: () => boolean;
  /** Séparer (Ctrl+E) aux bords de la plage, ou à la tête de lecture sur la piste active. */
  separate: () => boolean;
  /** Consolider (Alt+Maj+3) : un seul clip audio par piste pour la plage. */
  consolidateSelection: () => Promise<boolean>;
  /** Créer des fondus (Ctrl+F) sur la plage : fondus d'entrée / de sortie ou crossfade. */
  fadesFromSelection: () => boolean;
  /** La plage devient la zone de boucle (et la boucle s'active). */
  loopSelection: () => boolean;
  /** La plage devient la zone de punch (et le punch s'active). */
  punchSelection: () => boolean;
  /** Ouvre l'export sur la plage. */
  exportSelection: () => boolean;
}

export interface EditCommandDeps {
  stateRef: React.MutableRefObject<DAWState>;
  setState: (updater: (prev: DAWState) => DAWState) => void;
  notify: (text: string) => void;
  togglePunch: () => void;
  toggleQuickPunch: () => void;
  /** Pose la zone de punch (activée). */
  setPunchZone?: (start: number, end: number) => void;
  /** Ouvre la fenêtre d'export (la plage est prise dans editSelectionStore). */
  openExport?: () => void;
}

let current: EditCommands | null = null;
/** Commandes d'édition du studio ouvert (null avant son montage). */
export const getEditCommands = (): EditCommands | null => current;

/** Durée de l'audio d'un clip (pour les « handles » des crossfades). */
export const bufferDurationOf = (c: { bufferId?: string; buffer?: { duration: number } }): number | undefined =>
  c.buffer?.duration ?? (c.bufferId ? audioBufferRegistry.get(c.bufferId)?.duration : undefined);

const fmtMs = (s: number) => (s >= 1 ? `${s.toFixed(2).replace('.', ',')} s` : `${Math.round(s * 1000)} ms`);

/** Presse-papiers de plage (partagé par toutes les commandes du studio). */
let rangeClipboard: RangeClipboard | null = null;
let lastClipboard: 'range' | 'clip' | null = null;

/** Mixe les morceaux d'une plage (clips seuls, sans effets) dans un nouveau son. */
async function renderPieces(pieces: ConsolidatePiece[], length: number): Promise<AudioBuffer | null> {
  const bufs = pieces.map(p => p.clip.buffer || (p.clip.bufferId ? audioBufferRegistry.get(p.clip.bufferId) : undefined));
  const first = bufs.find(Boolean);
  if (!first) return null;
  const sr = first.sampleRate;
  const ch = Math.max(1, ...bufs.map(b => b?.numberOfChannels || 1));
  const ctx = new OfflineAudioContext(ch, Math.max(1, Math.ceil(length * sr)), sr);
  pieces.forEach((p, i) => {
    let b = bufs[i];
    if (!b) return;
    if (p.clip.isReversed) {
      const r = ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
      for (let c = 0; c < b.numberOfChannels; c++) { const src = b.getChannelData(c), dst = r.getChannelData(c); for (let k = 0; k < src.length; k++) dst[k] = src[src.length - 1 - k]; }
      b = r;
    }
    const s = ctx.createBufferSource();
    s.buffer = b;
    const g = ctx.createGain();
    s.connect(g); g.connect(ctx.destination);
    // Même gain et mêmes fondus qu'à la lecture (utils/fades).
    applyGainEvents(g.gain, clipGainEvents(p.clip, p.from), p.at - p.from);
    s.start(p.at, (p.clip.offset || 0) + p.from, p.to - p.from);
  });
  return ctx.startRendering();
}

type RangeCommandKeys = 'getTimeSelection' | 'selectRange' | 'clearSelection' | 'editableTrackIds' | 'copySelection' | 'cutSelection' | 'pasteRange' | 'hasRangeClipboard'
  | 'markClipClipboard' | 'deleteSelection' | 'duplicateSelection' | 'separate' | 'consolidateSelection' | 'fadesFromSelection'
  | 'loopSelection' | 'punchSelection' | 'exportSelection';

function rangeCommands(
  d: () => EditCommandDeps, st: () => DAWState, patchClips: EditCommands['patchClips'],
): Pick<EditCommands, RangeCommandKeys> {
  const editableTrackIds = () => st().tracks.filter(t => t.type !== TrackType.SEND && t.id !== 'master').map(t => t.id);
  const sel = (): TimeSelection | null => editSelectionStore.get().time;
  const need = (): TimeSelection | null => {
    const s = sel();
    if (!s) d().notify('Sélectionne d\'abord une plage : glisse dans la moitié haute d\'un clip (Smart Tool) ou avec le Sélecteur.');
    return s;
  };
  const byTrack = (ids: string[]): ClipsByTrack => {
    const out: ClipsByTrack = {};
    st().tracks.forEach(t => { if (ids.includes(t.id)) out[t.id] = t.clips; });
    return out;
  };
  /** Applique de nouvelles listes de clips (une étape d'annulation) ; les gelées gardent leurs règles. */
  const apply = (clips: ClipsByTrack) => {
    d().setState(produce((draft: DAWState) => {
      Object.entries(clips).forEach(([id, list]) => {
        const t = draft.tracks.find(x => x.id === id);
        if (t) t.clips = list as any;
      });
    }));
  };
  const what = (s: TimeSelection) => `${fmtMs(selLength(s))} sur ${s.trackIds.length} piste${s.trackIds.length > 1 ? 's' : ''}`;

  return {
    editableTrackIds,
    getTimeSelection: () => editSelectionStore.get().time,
    selectRange: (start, end, trackIds) => {
      editSelectionStore.set({ time: makeSelection(start, end, trackIds) });
    },
    clearSelection: () => editSelectionStore.set({ time: null }),

    copySelection: () => {
      const s = need(); if (!s) return false;
      rangeClipboard = copyRange(byTrack(s.trackIds), s, idGenerator('c'));
      lastClipboard = 'range';
      d().notify(`📋 Plage copiée (${what(s)}) : Ctrl+V la colle à la tête de lecture ou au début de ta sélection.`);
      return true;
    },
    cutSelection: () => {
      const s = need(); if (!s) return false;
      const r = cutRange(byTrack(s.trackIds), s, idGenerator('x'));
      rangeClipboard = r.clipboard;
      lastClipboard = 'range';
      apply(r.clips);
      d().notify(`✂️ Plage coupée (${what(s)}) — Ctrl+V pour la coller, Ctrl+Z pour revenir.`);
      return true;
    },
    pasteRange: () => {
      if (!rangeClipboard) { d().notify('Rien à coller : copie d\'abord une plage (Ctrl+C).'); return false; }
      const s = sel();
      const order = editableTrackIds();
      const focus = editSelectionStore.get().focusTrackId;
      const startIdx = Math.max(0, order.indexOf(s?.trackIds[0] || focus || rangeClipboard.trackIds[0]));
      const targets = s ? [...s.trackIds, ...order.slice(order.indexOf(s.trackIds[s.trackIds.length - 1]) + 1)] : order.slice(startIdx);
      const at = s ? s.start : playheadStore.get();
      const clips = pasteRange(byTrack(targets), rangeClipboard, at, targets, idGenerator('p'));
      if (!Object.keys(clips).length) return false;
      apply(clips);
      const used = targets.slice(0, rangeClipboard.lanes.length);
      editSelectionStore.set({ time: makeSelection(at, at + rangeClipboard.length, used) });
      d().notify(`📋 Plage collée à ${at.toFixed(2).replace('.', ',')} s (${fmtMs(rangeClipboard.length)}).`);
      return true;
    },
    hasRangeClipboard: () => lastClipboard === 'range' && !!rangeClipboard,
    markClipClipboard: () => { lastClipboard = 'clip'; },

    deleteSelection: () => {
      const s = need(); if (!s) return false;
      apply(deleteRange(byTrack(s.trackIds), s, idGenerator('d')));
      d().notify(`🗑️ Plage effacée (${what(s)}) — Ctrl+Z pour revenir.`);
      return true;
    },
    duplicateSelection: () => {
      const s = need(); if (!s) return false;
      const r = duplicateRange(byTrack(s.trackIds), s, idGenerator('u'));
      apply(r.clips);
      editSelectionStore.set({ time: r.selection });
      d().notify(`⧉ Plage dupliquée juste après (${what(s)}).`);
      return true;
    },
    separate: () => {
      const s = sel();
      const target: TimeSelection | null = s || (() => {
        const f = editSelectionStore.get().focusTrackId;
        return f ? { start: playheadStore.get(), end: playheadStore.get(), trackIds: [f] } : null;
      })();
      if (!target) { d().notify('Séparer : clique d\'abord sur une piste (ou sélectionne une plage).'); return false; }
      apply(separateAtSelection(byTrack(target.trackIds), target, idGenerator('s')));
      d().notify(s ? `✂️ Clips séparés aux bords de la plage (${what(s)}).` : '✂️ Clip séparé à la tête de lecture.');
      return true;
    },
    consolidateSelection: async () => {
      const s = need(); if (!s) return false;
      const len = selLength(s);
      const out: ClipsByTrack = {};
      let made = 0;
      for (const id of s.trackIds) {
        const t = st().tracks.find(x => x.id === id);
        if (!t || t.type === TrackType.MIDI) continue;
        const plan = consolidatePlan(t.clips, s.start, s.end);
        if (!plan.length) continue;
        const buf = await renderPieces(plan, len);
        if (!buf) continue;
        const cid = `cons-${Date.now().toString(36)}-${made}`;
        const bufferId = audioBufferRegistry.register(buf, cid);
        const first = plan[0].clip;
        const clip: Clip = {
          id: cid, name: `${first.name || t.name} (consolidé)`, start: s.start, duration: len, offset: 0, fadeIn: 0, fadeOut: 0,
          color: first.color || t.color, type: TrackType.AUDIO, bufferId, gain: 1,
          ...(first.takeNumber ? { takeNumber: first.takeNumber } : {}),
        };
        // Les clips ont pu changer pendant le rendu : on repart de l'état courant.
        const now = st().tracks.find(x => x.id === id);
        out[id] = replaceWithConsolidated(now ? now.clips : t.clips, s.start, s.end, clip, idGenerator('k'));
        made++;
      }
      if (!made) { d().notify('Consolider : aucun clip audio dans la plage.'); return false; }
      apply(out);
      d().notify(`🧱 Plage consolidée : ${made} clip${made > 1 ? 's' : ''} d'un seul tenant (sans effets, comme « Consolidate » dans Pro Tools). Ctrl+Z pour revenir.`);
      return true;
    },
    fadesFromSelection: () => {
      const s = need(); if (!s) return false;
      let n = 0;
      for (const id of s.trackIds) {
        const t = st().tracks.find(x => x.id === id);
        if (!t) continue;
        const p = fadesForRange(t.clips, s.start, s.end, editPrefsStore.get().xfadeCurve, bufferDurationOf);
        if (p.size) { patchClips(id, p); n += p.size; }
      }
      d().notify(n ? `Fondus créés sur la plage (${FADE_CURVE_INFO[editPrefsStore.get().xfadeCurve].label}).` : 'Fondus : la plage doit toucher le début, la fin d\'un clip ou une jonction entre deux clips.');
      return n > 0;
    },
    loopSelection: () => {
      const s = need(); if (!s) return false;
      d().setState(prev => ({ ...prev, loopStart: s.start, loopEnd: s.end, isLoopActive: true }));
      d().notify(`🔁 Boucle sur la plage (${fmtMs(selLength(s))}).`);
      return true;
    },
    punchSelection: () => {
      const s = need(); if (!s) return false;
      if (!d().setPunchZone) return false;
      d().setPunchZone!(s.start, s.end);
      d().notify(`🎯 Punch sur la plage : REC ne remplacera que ${s.start.toFixed(2).replace('.', ',')} s → ${s.end.toFixed(2).replace('.', ',')} s.`);
      return true;
    },
    exportSelection: () => {
      const s = need(); if (!s) return false;
      if (!d().openExport) return false;
      requestSelectionExport();
      d().openExport!();
      return true;
    },
  };
}

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

      // ------------------------------------------------- sélection de plage
      ...rangeCommands(d, st, patchClips),
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
