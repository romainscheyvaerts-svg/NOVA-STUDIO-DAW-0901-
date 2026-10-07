import { useEffect, useRef } from 'react';
import type { Clip, Track } from '../types';
import { TrackType } from '../types';
import { registerEditCommands } from '../utils/editCommands';
import { openNovaWindow } from '../utils/novaWindows';
import { requestBreaths } from '../utils/breathBus';
import { playheadStore } from '../utils/playheadStore';
import { fadeInTo, fadeOutTo, quickFades, trimEndTo, trimStartTo } from '../utils/clipKeyCommands';
import { clampTrackHeight, stepTrackHeight } from '../utils/trackHeights';

/**
 * Versions de base des commandes d'édition (raccourcis Pro Tools) pour
 * l'arrangement : elles travaillent sur la sélection de clips qu'il connaît.
 * Inscrites dans utils/editCommands ; hooks/useEditCommands (sélection de
 * plage, nudge…) pourra s'inscrire par-dessus sans toucher à ce fichier.
 *
 * Le nudge n'est volontairement PAS fourni ici (il appartient aux vagues
 * d'édition) : sans lui, les flèches déplacent la tête de lecture.
 */
export interface ArrangementCommandContext {
  tracks: Track[];
  selectedTrackId: string | null | undefined;
  selectedClip: { trackId: string; clip: Clip } | null;
  selectedClipIds: Set<string>;
  setSelectedClipIds: (ids: Set<string>) => void;
  onEditClip?: (trackId: string, clipId: string, action: string, payload?: any) => void;
  zoomH: number;
  setZoomH: (z: number) => void;
  zoomV: number;
  setZoomV: (z: number) => void;
  bpm: number;
  /** Largeur visible de la timeline (px). */
  viewportWidth: number;
  scrollTo?: (left: number) => void;
}

const ZOOM_MIN = 10, ZOOM_MAX = 300;
const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

export function useArrangementCommands(ctx: ArrangementCommandContext) {
  const ref = useRef(ctx);
  ref.current = ctx;

  useEffect(() => {
    const c = () => ref.current;
    /** Clips visés : sélection multiple, sinon le clip ancre. */
    const targets = (): { trackId: string; clip: Clip }[] => {
      const { tracks, selectedClipIds, selectedClip } = c();
      if (selectedClipIds.size > 0) return tracks.flatMap(t => t.clips.filter(cl => selectedClipIds.has(cl.id)).map(clip => ({ trackId: t.id, clip })));
      return selectedClip ? [{ trackId: selectedClip.trackId, clip: tracks.find(t => t.id === selectedClip.trackId)?.clips.find(x => x.id === selectedClip.clip.id) || selectedClip.clip }] : [];
    };
    /** Sans sélection : les clips de la piste choisie sous la tête de lecture (comme le curseur de Pro Tools). */
    const underPlayhead = (): { trackId: string; clip: Clip }[] => {
      const { tracks, selectedTrackId } = c();
      const t = playheadStore.get();
      const track = tracks.find(x => x.id === selectedTrackId);
      return track ? track.clips.filter(cl => t > cl.start && t < cl.start + cl.duration).map(clip => ({ trackId: track.id, clip })) : [];
    };
    const targetsOrPlayhead = () => { const s = targets(); return s.length ? s : underPlayhead(); };
    const edit = (trackId: string, clipId: string, action: string, payload?: any) => c().onEditClip?.(trackId, clipId, action, payload);
    const atCursor = (fn: (clip: Clip, t: number) => Partial<Clip> | null) => () => {
      const t = playheadStore.get();
      let done = false;
      for (const { trackId, clip } of targetsOrPlayhead()) {
        const props = fn(clip, t);
        if (props) { edit(trackId, clip.id, 'UPDATE_PROPS', props); done = true; }
      }
      return done;
    };
    const songEnd = () => Math.max(1, ...c().tracks.flatMap(t => t.clips.map(cl => cl.start + cl.duration)));
    const barSec = () => (4 * 60) / (c().bpm || 120);

    return registerEditCommands({
      split: () => {
        const t = playheadStore.get();
        const list = targetsOrPlayhead().filter(({ clip }) => t > clip.start && t < clip.start + clip.duration);
        list.forEach(({ trackId, clip }) => edit(trackId, clip.id, 'SPLIT', { time: t }));
        return list.length > 0;
      },
      duplicate: () => { const l = targets(); l.forEach(({ trackId, clip }) => edit(trackId, clip.id, 'DUPLICATE')); return l.length > 0; },
      copy: () => { const l = targets(); if (l[0]) edit(l[0].trackId, l[0].clip.id, 'COPY'); return l.length > 0; },
      cut: () => { const l = targets(); l.forEach(({ trackId, clip }) => edit(trackId, clip.id, 'CUT')); return l.length > 0; },
      paste: () => {
        const target = c().selectedClip?.trackId || c().selectedTrackId;
        if (!target) return false;
        edit(target, '', 'PASTE', { time: playheadStore.get() });
        return true;
      },
      delete: () => { const l = targets(); l.forEach(({ trackId, clip }) => edit(trackId, clip.id, 'DELETE')); return l.length > 0; },
      mute: () => { const l = targets(); l.forEach(({ trackId, clip }) => edit(trackId, clip.id, 'MUTE')); return l.length > 0; },
      quickFades: () => {
        const l = targetsOrPlayhead().filter(({ clip }) => clip.type !== TrackType.MIDI);
        l.forEach(({ trackId, clip }) => edit(trackId, clip.id, 'UPDATE_PROPS', quickFades(clip)));
        return l.length > 0;
      },
      trimStartToCursor: atCursor(trimStartTo),
      trimEndToCursor: atCursor(trimEndTo),
      fadeInToCursor: atCursor(fadeInTo),
      fadeOutToCursor: atCursor(fadeOutTo),
      renameClip: () => {
        const l = targetsOrPlayhead();
        if (!l.length) return false;
        openNovaWindow('clip-props', { targets: l.map(x => ({ trackId: x.trackId, clipId: x.clip.id })), focus: 'name' });
        return true;
      },
      clipColor: () => {
        const l = targetsOrPlayhead();
        if (!l.length) return false;
        openNovaWindow('clip-props', { targets: l.map(x => ({ trackId: x.trackId, clipId: x.clip.id })), focus: 'color' });
        return true;
      },
      stripSilence: () => {
        let l = targets().filter(({ clip }) => clip.type !== TrackType.MIDI);
        if (!l.length) {
          const track = c().tracks.find(t => t.id === c().selectedTrackId);
          l = (track?.clips || []).filter(cl => cl.type !== TrackType.MIDI && !cl.isMuted).map(clip => ({ trackId: track!.id, clip }));
        }
        openNovaWindow('strip-silence', { targets: l.map(x => ({ trackId: x.trackId, clipId: x.clip.id })) });
        return true;
      },
      // Respirations (Ctrl+Alt+R) : clips sélectionnés, sinon la piste sélectionnée, sinon toutes les voix.
      breaths: () => {
        const l = targets().filter(({ clip }) => clip.type !== TrackType.MIDI);
        if (l.length) requestBreaths({ mode: 'dialog', clipIds: l.map(x => x.clip.id), trackIds: Array.from(new Set(l.map(x => x.trackId))), reason: 'shortcut' });
        else requestBreaths({ mode: 'dialog', trackIds: c().selectedTrackId ? [c().selectedTrackId!] : undefined, reason: 'shortcut' });
        return true;
      },
      selectAllClips: () => {
        const ids = new Set(c().tracks.filter(t => t.type !== TrackType.SEND && t.id !== 'master').flatMap(t => t.clips.map(cl => cl.id)));
        c().setSelectedClipIds(ids);
        return ids.size > 0;
      },
      zoomIn: () => { c().setZoomH(clampZoom(c().zoomH * 1.5)); },
      zoomOut: () => { c().setZoomH(clampZoom(c().zoomH / 1.5)); },
      // 1 = tout le morceau, 2 = 8 mesures, 3 = 4 mesures, 4 = 1 mesure, 5 = au plus près.
      zoomPreset: (n: number) => {
        const w = Math.max(200, c().viewportWidth);
        const span = n === 1 ? songEnd() * 1.05 : n === 2 ? barSec() * 8 : n === 3 ? barSec() * 4 : n === 4 ? barSec() : 0;
        c().setZoomH(span > 0 ? clampZoom(w / span) : ZOOM_MAX);
        if (n === 1) c().scrollTo?.(0);
      },
      zoomToSelection: () => {
        const l = targets();
        if (!l.length) return false;
        const start = Math.min(...l.map(x => x.clip.start));
        const end = Math.max(...l.map(x => x.clip.start + x.clip.duration));
        const z = clampZoom(Math.max(200, c().viewportWidth) / Math.max(0.05, (end - start) * 1.1));
        c().setZoomH(z);
        c().scrollTo?.(Math.max(0, (start - (end - start) * 0.05) * z));
        return true;
      },
      trackHeight: (px: number) => { c().setZoomV(clampTrackHeight(px)); },
      trackHeightUp: () => { c().setZoomV(stepTrackHeight(c().zoomV, 1)); },
      trackHeightDown: () => { c().setZoomV(stepTrackHeight(c().zoomV, -1)); },
    });
  }, []);
}
