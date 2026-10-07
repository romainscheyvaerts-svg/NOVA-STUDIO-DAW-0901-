import { useEffect, useRef } from 'react';
import { produce } from 'immer';
import type { Clip, DAWState } from '../types';
import { TrackType } from '../types';
import { registerEditCommands } from '../utils/editCommands';
import { chooseEditMode, EditMode, editModeStore, sanitizeEditMode, syncPointAt } from '../utils/editModes';
import { editPrefsStore, editSelectionStore } from '../utils/editSelection';
import { playheadStore } from '../utils/playheadStore';
import { shuffleInsert, shuffleMove, shuffleRemove, shuffleTrimEnd, shuffleTrimStart, ShuffleOptions } from '../utils/shuffle';
import { clipTransients, nextIn, transientsOf } from '../utils/transients';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';

/**
 * Branchement des modes d'édition Pro Tools dans le studio (App.tsx n'appelle
 * que ce hook) :
 * - raccourcis F1–F4 / Alt+1–4 (mode), Tab / Maj+Tab (attaques), Ctrl+, (point de synchro) ;
 * - opérations Shuffle sur les clips (supprimer, couper, coller, dupliquer,
 *   déplacer, rogner), chacune en UN setState : une étape d'annulation et une
 *   seule opération de collaboration par piste ;
 * - mode sauvé avec le projet (DAWState.editMode, sans étape d'annulation).
 */
export interface EditModeDeps {
  stateRef: React.MutableRefObject<DAWState>;
  setState: (updater: (prev: DAWState) => DAWState) => void;
  /** Modifie le projet SANS étape d'annulation (réglage du mode). */
  setVisualState: (patch: Partial<DAWState>) => void;
  seek: (t: number) => void;
  notify: (text: string) => void;
  /** Presse-papiers des clips de l'arrangement (Ctrl+C / Ctrl+X sur un clip). */
  getClipboardClip: () => Clip | null;
  setClipboardClip: (c: Clip) => void;
}

let deps: EditModeDeps | null = null;

const bufferDuration = (c: Clip): number | undefined =>
  (c as any).buffer?.duration ?? (c.bufferId ? audioBufferRegistry.get(c.bufferId)?.duration : undefined);

const shuffleOpts = (): ShuffleOptions => {
  const p = editPrefsStore.get();
  return { autoXfade: p.autoXfade, curve: p.xfadeCurve, bufferDuration };
};

const newId = (p: string) => `clip-${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Remplace les clips d'une piste à partir de l'état PRÉCÉDENT (appels successifs cumulés). */
function updateTrackClips(trackId: string, fn: (clips: Clip[], track: DAWState['tracks'][number]) => Clip[] | null) {
  if (!deps) return false;
  deps.setState(produce((draft: DAWState) => {
    const t = draft.tracks.find(x => x.id === trackId);
    if (!t) return;
    const next = fn(t.clips as Clip[], t as any);
    if (next) t.clips = next as any;
  }));
  return true;
}

/**
 * Actions de clip en mode Shuffle (appelées par l'arrangement à la place de
 * onEditClip). Renvoie false si l'action ne relève pas du Shuffle.
 */
export function shuffleEditClip(trackId: string, clipId: string, action: string, payload?: any): boolean {
  if (!deps || editModeStore.get().mode !== 'SHUFFLE') return false;
  const o = shuffleOpts();
  switch (action) {
    case 'CUT': {
      const clip = deps.stateRef.current.tracks.find(t => t.id === trackId)?.clips.find(c => c.id === clipId);
      if (!clip) return false;
      deps.setClipboardClip({ ...clip });
      return updateTrackClips(trackId, clips => shuffleRemove(clips, [clipId], o));
    }
    case 'DELETE':
      return updateTrackClips(trackId, clips => (clips.some(c => c.id === clipId) ? shuffleRemove(clips, [clipId], o) : null));
    case 'PASTE': {
      const src = deps.getClipboardClip();
      if (!src) return false;
      const at = Math.max(0, payload?.time ?? playheadStore.get());
      return updateTrackClips(trackId, clips => shuffleInsert(clips, [{ ...src, id: newId('paste'), start: at }], at, o));
    }
    case 'DUPLICATE': {
      // Alt+glisser (copie laissée sur place) n'est pas un collage Shuffle.
      if (payload?.start !== undefined) return false;
      return updateTrackClips(trackId, clips => {
        const c = clips.find(x => x.id === clipId);
        if (!c) return null;
        const at = c.start + c.duration;
        return shuffleInsert(clips, [{ ...c, id: newId('dup'), start: at }], at, o);
      });
    }
    default: return false;
  }
}

/** Glissement en Shuffle : recalculé depuis les clips du DÉBUT du geste. Renvoie le début atteint. */
export function shuffleDrag(trackId: string, initial: Clip[], clipId: string, kind: 'MOVE' | 'TRIM_START' | 'TRIM_END', t: number): number | null {
  if (!deps) return null;
  const o = shuffleOpts();
  let start: number | null = null;
  let next: Clip[];
  if (kind === 'MOVE') { const r = shuffleMove(initial, clipId, t, o); next = r.clips; start = r.start; }
  else if (kind === 'TRIM_END') next = shuffleTrimEnd(initial, clipId, t, o);
  else next = shuffleTrimStart(initial, clipId, t, o);
  updateTrackClips(trackId, () => next);
  return start;
}

/** Sélectionne un clip dans l'arrangement (Alt+Tab : clip suivant). */
export const SELECT_CLIP_EVENT = 'nova:select-clip';

export function useEditModes(d: EditModeDeps, project: { id: string; editMode?: DAWState['editMode'] }) {
  const ref = useRef(d);
  ref.current = d;
  deps = d;
  useEffect(() => () => { if (deps === ref.current) deps = null; }, []);

  // --- Mode sauvé avec le projet : à l'ouverture, le projet donne son mode ;
  // ensuite chaque changement est recopié dans le projet (sans étape d'annulation).
  useEffect(() => {
    if (project.editMode) editModeStore.set(sanitizeEditMode(project.editMode, editModeStore.get()));
    else ref.current.setVisualState({ editMode: editModeStore.get() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);
  useEffect(() => editModeStore.subscribe(() => {
    const s = editModeStore.get();
    if (JSON.stringify(ref.current.stateRef.current.editMode) !== JSON.stringify(s)) ref.current.setVisualState({ editMode: s });
  }), []);

  useEffect(() => {
    const st = () => ref.current.stateRef.current;

    /** Clips visés : la sélection, sinon la piste active. */
    const target = (): { trackId: string; clips: Clip[]; selected: Clip[] } | null => {
      const sel = editSelectionStore.get();
      const ids = new Set(sel.clipIds);
      for (const t of st().tracks) {
        const selected = t.clips.filter(c => ids.has(c.id));
        if (selected.length) return { trackId: t.id, clips: t.clips, selected };
      }
      const tid = sel.focusTrackId || st().selectedTrackId;
      const t = st().tracks.find(x => x.id === tid);
      return t ? { trackId: t.id, clips: t.clips, selected: [] } : null;
    };

    const tab = (arg: { dir?: 1 | -1; clip?: boolean } = {}) => {
      const dir = arg.dir === -1 ? -1 : 1;
      const tg = target();
      if (!tg) { ref.current.notify('Tab : clique d’abord sur une piste ou un clip.'); return true; }
      const now = playheadStore.get();
      const active = tg.clips.filter(c => !c.isMuted).sort((a, b) => a.start - b.start);
      if (arg.clip) {
        const starts = active.map(c => c.start);
        const t = nextIn(starts, now, dir);
        if (t === null) { ref.current.notify(dir > 0 ? 'Plus de clip après la tête de lecture sur cette piste.' : 'Pas de clip avant la tête de lecture sur cette piste.'); return true; }
        const c = active.find(x => Math.abs(x.start - t) < 1e-9)!;
        ref.current.seek(t);
        window.dispatchEvent(new CustomEvent(SELECT_CLIP_EVENT, { detail: { trackId: tg.trackId, clipId: c.id } }));
        return true;
      }
      const scope = tg.selected.length ? tg.selected.filter(c => !c.isMuted) : active;
      const points: number[] = [];
      scope.forEach(c => { points.push(c.start, c.start + c.duration); });
      if (editModeStore.get().tabToTransient) {
        for (const c of scope) {
          if (c.type === TrackType.MIDI) continue;
          const buf = (c as any).buffer || (c.bufferId ? audioBufferRegistry.get(c.bufferId) : undefined);
          if (buf) points.push(...clipTransients(c, transientsOf(buf), buf.duration));
        }
      }
      points.sort((a, b) => a - b);
      const t = nextIn(points, now, dir);
      if (t === null) { ref.current.notify(dir > 0 ? 'Plus d’attaque après la tête de lecture.' : 'Pas d’attaque avant la tête de lecture.'); return true; }
      ref.current.seek(t);
      return true;
    };

    const syncPoint = (arg: { remove?: boolean } = {}) => {
      const tg = target();
      if (!tg) { ref.current.notify('Point de synchro : sélectionne d’abord un clip.'); return true; }
      const sel = editSelectionStore.get();
      const at = sel.time ? sel.time.start : playheadStore.get();
      if (arg.remove) {
        const ids = new Set(tg.selected.map(c => c.id));
        if (!ids.size) { ref.current.notify('Sélectionne le clip dont tu veux enlever le point de synchro.'); return true; }
        ref.current.setState(produce((draft: DAWState) => {
          draft.tracks.find(t => t.id === tg.trackId)?.clips.forEach(c => { if (ids.has(c.id)) delete (c as any).syncPoint; });
        }));
        ref.current.notify('Point de synchro enlevé : c’est de nouveau le début du clip qui se cale.');
        return true;
      }
      const pool = tg.selected.length ? tg.selected : tg.clips.filter(c => !c.isMuted);
      const clip = pool.find(c => at >= c.start - 1e-9 && at <= c.start + c.duration + 1e-9);
      if (!clip) { ref.current.notify('Point de synchro : place la tête de lecture DANS le clip (sur l’attaque à caler), puis Ctrl+,'); return true; }
      const sp = syncPointAt(clip, at);
      if (sp === null) return true;
      ref.current.setState(produce((draft: DAWState) => {
        const c = draft.tracks.find(t => t.id === tg.trackId)?.clips.find(x => x.id === clip.id);
        if (c) (c as any).syncPoint = sp;
      }));
      ref.current.notify(`📍 Point de synchro posé à ${(at - clip.start).toFixed(3).replace('.', ',')} s du début de « ${clip.name} » : en Grid et en Spot, c’est lui qui se cale. Ctrl+Alt+, pour l’enlever.`);
      return true;
    };

    return registerEditCommands({
      editMode: (mode: EditMode) => { const r = chooseEditMode(mode); ref.current.notify(r.message); return true; },
      tabToTransient: tab,
      syncPoint,
    }, 5);
  }, []);
}

