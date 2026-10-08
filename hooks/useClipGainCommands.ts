import { useEffect } from 'react';
import type { Clip, DAWState, Track } from '../types';
import { TrackType } from '../types';
import { registerEditCommands } from '../utils/editCommands';
import { editSelectionStore } from '../utils/editSelection';
import { playheadStore } from '../utils/playheadStore';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { getEditCommands, bufferDurationOf } from './useEditCommands';
import {
  clipGainViewStore, dbText, linToDb, nudgeClipGain, renderGainToChannels, renderedClipPatch, revertGainRenderPatch,
} from '../utils/clipGain';
import { healTrack, loopCount, loopTrim, repeatClips, unloop } from '../utils/clipLoop';

/**
 * Commandes R5 (gain de clip, Heal, boucle, Répéter), branchées sur le bus des
 * raccourcis (utils/editCommands) et réutilisées par les menus. Elles
 * travaillent sur la sélection partagée (utils/editSelection) : clips
 * sélectionnés, sinon plage de temps, sinon le clip sous la tête de lecture
 * sur la piste active.
 */

type Target = { trackId: string; clip: Clip };

const isAudio = (c: Clip) => c.type !== TrackType.MIDI && !!(c.bufferId || c.buffer);
const st = (): DAWState | null => getEditCommands()?.getState() || null;
const notify = (text: string) => getEditCommands()?.notify(text);

/** Clips visés : la sélection de clips, sinon ceux de la plage, sinon celui sous la tête de lecture. */
export function gainTargets(state: DAWState): { list: Target[]; range: { start: number; end: number } | null } {
  const sel = editSelectionStore.get();
  const ids = new Set(sel.clipIds);
  const all = (state.tracks || []).flatMap(t => t.clips.map(clip => ({ trackId: t.id, clip })));
  if (ids.size) return { list: all.filter(x => ids.has(x.clip.id) && isAudio(x.clip)), range: null };
  if (sel.time) {
    const s = sel.time;
    return {
      list: all.filter(x => s.trackIds.includes(x.trackId) && isAudio(x.clip) && x.clip.start < s.end && x.clip.start + x.clip.duration > s.start),
      range: { start: s.start, end: s.end },
    };
  }
  const t = playheadStore.get();
  const track = state.tracks.find(x => x.id === sel.focusTrackId);
  return { list: (track?.clips || []).filter(c => isAudio(c) && t >= c.start && t < c.start + c.duration).map(clip => ({ trackId: track!.id, clip })), range: null };
}

const byTrack = (list: Target[]) => {
  const m = new Map<string, Clip[]>();
  list.forEach(x => m.set(x.trackId, [...(m.get(x.trackId) || []), x.clip]));
  return m;
};

/** Nudge du gain (Ctrl+Maj+↑ / ↓) : tout le clip, ou seulement la plage sélectionnée. */
export function nudgeGainCommand(deltaDb: number): boolean {
  const s = st(); const ed = getEditCommands();
  if (!s || !ed) return false;
  const { list, range } = gainTargets(s);
  if (!list.length) return false;
  byTrack(list).forEach((clips, trackId) => {
    const patches: Record<string, Partial<Clip>> = {};
    for (const c of clips) {
      const r = range ? [(c.offset || 0) + (range.start - c.start), (c.offset || 0) + (range.end - c.start)] as [number, number] : null;
      patches[c.id] = nudgeClipGain(c, deltaDb, r);
    }
    ed.patchClips(trackId, patches);
  });
  const c0 = list[0].clip;
  const total = range ? null : linToDb((c0.gain ?? 1)) + deltaDb;
  notify(`Gain du clip ${deltaDb > 0 ? '+' : '−'}${Math.abs(deltaDb).toFixed(1)} dB${range ? ' sur la plage' : total !== null ? ` (${dbText(total)})` : ''}${list.length > 1 ? ` · ${list.length} clips` : ''}`);
  return true;
}

/** Heal Separation (Ctrl+H). */
export function healCommand(): boolean {
  const s = st(); const ed = getEditCommands();
  if (!s || !ed) return false;
  const sel = editSelectionStore.get();
  const work: { track: Track; ids?: Set<string> }[] = [];
  if (sel.clipIds.length) {
    const ids = new Set(sel.clipIds);
    s.tracks.forEach(t => {
      const mine = t.clips.filter(c => ids.has(c.id));
      if (!mine.length) return;
      // Un seul clip choisi : on essaie avec ses voisins directs (Pro Tools : la sélection couvre la jonction).
      const cand = new Set(mine.map(c => c.id));
      if (mine.length === 1) {
        const c = mine[0];
        t.clips.forEach(o => { if (o.id !== c.id && (Math.abs(o.start - (c.start + c.duration)) < 0.01 || Math.abs(o.start + o.duration - c.start) < 0.01 || (o.start < c.start + c.duration && o.start + o.duration > c.start))) cand.add(o.id); });
      }
      work.push({ track: t, ids: cand });
    });
  } else if (sel.time) {
    const r = sel.time;
    s.tracks.filter(t => r.trackIds.includes(t.id)).forEach(t => work.push({ track: t, ids: new Set(t.clips.filter(c => c.start <= r.end + 1e-3 && c.start + c.duration >= r.start - 1e-3).map(c => c.id)) }));
  } else {
    const t = s.tracks.find(x => x.id === sel.focusTrackId);
    const p = playheadStore.get();
    if (t) work.push({ track: t, ids: new Set(t.clips.filter(c => c.start <= p + 0.05 && c.start + c.duration >= p - 0.05).map(c => c.id)) });
  }
  let healed = 0, exact = true;
  let reason: string | null = null;
  for (const w of work) {
    const r = healTrack(w.track.clips, w.ids);
    if (!r.healed) { reason = reason || r.reason; continue; }
    healed += r.healed;
    if (!r.exact) exact = false;
    // Clips recollés (ils gardent l'id du premier morceau) et morceaux absorbés.
    const changed = r.clips.filter(c => !w.track.clips.includes(c));
    ed.replaceClips(w.track.id, Array.from(new Set([...r.removed, ...changed.map(c => c.id)])), changed);
  }
  if (!healed) {
    notify(reason ? `Heal impossible : ${reason}` : 'Heal : sélectionne deux morceaux consécutifs d’un même fichier (ou place la tête de lecture sur leur jonction).');
    return work.length > 0;
  }
  notify(`Heal : ${healed} jonction${healed > 1 ? 's' : ''} recollée${healed > 1 ? 's' : ''}${exact ? ' — le son est celui d’avant la découpe' : ' (gains différents : rampe de 5 ms à la jonction)'}`);
  return true;
}

/** Répéter n fois (Alt+R). */
export function repeatCommand(n: number): boolean {
  const s = st(); const ed = getEditCommands();
  if (!s || !ed) return false;
  const ids = new Set(editSelectionStore.get().clipIds);
  const all = s.tracks.flatMap(t => t.clips.filter(c => ids.has(c.id)).map(clip => ({ trackId: t.id, clip })));
  if (!all.length) { notify('Répéter : sélectionne d’abord un ou plusieurs clips.'); return false; }
  const copies = repeatClips(all.map(x => x.clip), n);
  const trackOf = new Map(all.map(x => [x.clip.id, x.trackId]));
  const per = new Map<string, Clip[]>();
  copies.forEach(c => { const src = all.find(x => c.id.startsWith(`${x.clip.id}-rep`)); const tid = src ? trackOf.get(src.clip.id)! : all[0].trackId; per.set(tid, [...(per.get(tid) || []), c]); });
  per.forEach((list, tid) => ed.replaceClips(tid, [], list));
  notify(`Répété ${n} fois : ${copies.length} clip${copies.length > 1 ? 's' : ''} ajouté${copies.length > 1 ? 's' : ''}.`);
  return true;
}

/** Boucler le(s) clip(s) sélectionné(s) n fois (Ctrl+Alt+L), fondus aux jonctions en option. */
export function loopCommand(n: number, xfadeMs: number): boolean {
  const s = st(); const ed = getEditCommands();
  if (!s || !ed) return false;
  const { list } = gainTargets(s);
  if (!list.length) { notify('Boucler : sélectionne d’abord un clip audio.'); return false; }
  for (const { trackId, clip } of list) {
    const track = s.tracks.find(t => t.id === trackId)!;
    const base = clip.loop ? unloop(track.clips, clip.id)!.add[0] : clip;
    const removed = clip.loop ? track.clips.filter(c => c.loop?.id === clip.loop!.id).map(c => c.id) : [clip.id];
    const add = loopCount(base, n, { xfade: xfadeMs / 1000, bufferDuration: bufferDurationOf(base) });
    ed.replaceClips(trackId, removed, add);
  }
  notify(`Clip bouclé : ${n} tour${n > 1 ? 's' : ''}${xfadeMs > 0 ? `, fondus de ${xfadeMs} ms aux jonctions` : ''}. Tire son bord droit (mode Boucle) pour en ajouter.`);
  return true;
}

/** Défaire la boucle (ne garder que le clip d'origine). */
export function unloopCommand(trackId: string, clipId: string): boolean {
  const s = st(); const ed = getEditCommands();
  const t = s?.tracks.find(x => x.id === trackId);
  const r = t && unloop(t.clips, clipId);
  if (!r || !ed) return false;
  ed.replaceClips(trackId, r.remove, r.add);
  notify('Boucle défaite : il reste le clip d’origine.');
  return true;
}

/** Loop Trim (tirer le bord droit) : utilisé par la souris (components/ClipGainTools). */
export const loopTrimPlan = loopTrim;

/** « Rendre le gain dans le fichier » (Render Clip Gain), non destructif. */
export function renderGainCommand(targets?: Target[]): boolean {
  const s = st(); const ed = getEditCommands();
  if (!s || !ed) return false;
  const list = (targets || gainTargets(s).list).filter(x => x.clip.bufferId && (x.clip.gainPoints?.length || Math.abs((x.clip.gain ?? 1) - 1) > 1e-6));
  if (!list.length) { notify('Rendre le gain : ce clip n’a ni ligne de gain ni gain à rendre.'); return false; }
  let done = 0;
  for (const { trackId, clip } of list) {
    const src = audioBufferRegistry.get(clip.bufferId!);
    if (!src) continue;
    const chans = Array.from({ length: src.numberOfChannels }, (_, i) => src.getChannelData(i));
    const out = renderGainToChannels(chans, src.sampleRate, clip.gainPoints, clip.gain ?? 1);
    const buf = new AudioBuffer({ length: src.length, numberOfChannels: src.numberOfChannels, sampleRate: src.sampleRate });
    out.forEach((ch, i) => buf.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
    const id = audioBufferRegistry.register(buf, `${clip.id}-gain-${Date.now().toString(36)}`);
    ed.patchClips(trackId, { [clip.id]: renderedClipPatch(clip, id) });
    done++;
  }
  notify(done ? `Gain rendu dans le fichier (${done} clip${done > 1 ? 's' : ''}) : la ligne revient à 0 dB. « Revenir » remet le son et la ligne d’avant.` : 'Rendre le gain : son introuvable.');
  return done > 0;
}

/** « Revenir » après un rendu du gain. */
export function revertGainCommand(trackId: string, clipId: string): boolean {
  const s = st(); const ed = getEditCommands();
  const c = s?.tracks.find(t => t.id === trackId)?.clips.find(x => x.id === clipId);
  if (!c || !ed) return false;
  const p = revertGainRenderPatch(c, id => audioBufferRegistry.has(id));
  if (!p) { notify('Le son d’origine n’est pas sur cet appareil : impossible de revenir.'); return false; }
  ed.patchClips(trackId, { [clipId]: p });
  notify('Gain d’origine rétabli : la ligne de gain est de retour.');
  return true;
}

/** Fenêtres « Répéter » et « Boucler » (components/ClipGainTools). */
export type ClipToolsDialog = { kind: 'repeat' } | { kind: 'loop' } | null;
let dialog: ClipToolsDialog = null;
const dlgListeners = new Set<() => void>();
export const clipToolsDialogStore = {
  get: () => dialog,
  set: (d: ClipToolsDialog) => { dialog = d; dlgListeners.forEach(l => l()); },
  subscribe: (l: () => void) => { dlgListeners.add(l); return () => { dlgListeners.delete(l); }; },
};

/** Inscrit les commandes sur le bus des raccourcis (une fois, par l'arrangement). */
export function useClipGainCommands() {
  useEffect(() => registerEditCommands({
    clipGainLine: () => {
      const on = !clipGainViewStore.get().line;
      clipGainViewStore.set({ line: on });
      notify(on ? 'Ligne de gain affichée : clique sur la ligne pour poser un point, glisse-le, Alt+clic pour l’enlever.' : 'Ligne de gain masquée.');
      return true;
    },
    clipGainNudge: (arg?: { db?: number }) => nudgeGainCommand(arg?.db ?? 0.5),
    heal: () => healCommand(),
    repeatClips: () => {
      if (!editSelectionStore.get().clipIds.length) { notify('Répéter : sélectionne d’abord un ou plusieurs clips.'); return true; }
      clipToolsDialogStore.set({ kind: 'repeat' }); return true;
    },
    loopClips: () => {
      const s = st();
      if (!s || !gainTargets(s).list.length) { notify('Boucler : sélectionne d’abord un clip audio.'); return true; }
      clipToolsDialogStore.set({ kind: 'loop' }); return true;
    },
  }), []);
}
