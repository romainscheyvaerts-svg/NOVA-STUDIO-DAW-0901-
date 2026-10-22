import { useEffect, useRef } from 'react';
import type { Clip, Track } from '../types';
import { TrackType } from '../types';
import { registerEditCommands } from '../utils/editCommands';
import { openNovaWindow } from '../utils/novaWindows';
import { requestBreaths } from '../utils/breathBus';
import { playheadStore } from '../utils/playheadStore';
import { fadeInTo, fadeOutTo, quickFades, trimEndTo, trimStartTo } from '../utils/clipKeyCommands';
import { clampTrackHeight, fitTrackHeight, stepTrackHeight } from '../utils/trackHeights';
import { editSelectionStore } from '../utils/editSelection';
import { planDuplicate } from '../utils/duplicateClips';
import { clampZoom, fitRange, type ZoomAnchor } from '../utils/arrangeZoom';

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
  /** Zoom ancré (tête de lecture visible, sinon milieu de la vue ; ou l'ancre donnée). */
  zoomTo?: (z: number, anchor?: ZoomAnchor) => void;
  zoomV: number;
  setZoomV: (z: number) => void;
  bpm: number;
  /** Largeur visible de la timeline (px). */
  viewportWidth: number;
  /** Hauteur visible des pistes (px) et nombre de pistes affichées (Z sans sélection : tout voir). */
  tracksViewHeight?: number;
  visibleTrackCount?: number;
  scrollTo?: (left: number) => void;
}

/** Pistes visées par « tous les clips de la piste » : celles des clips sélectionnés, sinon la piste active. */
export function tracksOfSelection(tracks: Track[], selectedClipIds: Set<string>, selectedTrackId: string | null | undefined): string[] {
  if (selectedClipIds.size) return tracks.filter(t => t.clips.some(c => selectedClipIds.has(c.id))).map(t => t.id);
  return selectedTrackId ? [selectedTrackId] : [];
}

/** Ids de tous les clips de ces pistes. */
export const selectTrackClipIds = (tracks: Track[], trackIds: string[]): Set<string> =>
  new Set(tracks.filter(t => trackIds.includes(t.id)).flatMap(t => t.clips.map(c => c.id)));

/** Zoom précédent (Z une 2e fois revient au cadrage d'avant, comme Logic et Live). */
interface SavedView { zoom: number; scroll: number; height: number; fitted: { zoom: number; scroll: number } }

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
    const zoomTo = (z: number, anchor?: ZoomAnchor) => { const f = c().zoomTo; if (f) f(z, anchor); else c().setZoomH(clampZoom(z)); };
    const scrollLeftNow = () => (document.querySelector('[data-arrange-scroll]') as HTMLElement | null)?.scrollLeft ?? 0;
    /** Cadre [start, end] ; garde la vue d'avant pour le retour (Z une 2e fois). */
    let saved: SavedView | null = null;
    const frame = (start: number, end: number, fitHeights = false) => {
      const f = fitRange(start, end, c().viewportWidth);
      saved = { zoom: c().zoomH, scroll: scrollLeftNow(), height: c().zoomV, fitted: f };
      zoomTo(f.zoom, { time: f.scroll / f.zoom, px: 0 });
      // Tout le morceau ET toutes les pistes (Logic : Z sans sélection) : 60 pistes tiennent à l'écran.
      if (fitHeights && c().tracksViewHeight && c().visibleTrackCount) c().setZoomV(fitTrackHeight(c().tracksViewHeight!, c().visibleTrackCount!));
    };

    return registerEditCommands({
      split: () => {
        const t = playheadStore.get();
        const list = targetsOrPlayhead().filter(({ clip }) => t > clip.start && t < clip.start + clip.duration);
        list.forEach(({ trackId, clip }) => edit(trackId, clip.id, 'SPLIT', { time: t }));
        return list.length > 0;
      },
      // En bloc après la sélection ; les copies deviennent la sélection (utils/duplicateClips).
      duplicate: () => {
        const plan = planDuplicate(targets());
        plan.forEach(p => edit(p.trackId, p.clipId, 'DUPLICATE', { start: p.start, id: p.id }));
        if (plan.length) c().setSelectedClipIds(new Set(plan.map(p => p.id)));
        return plan.length > 0;
      },
      // Plusieurs clips : tous au presse-papiers (utils/clipClipboard), écarts et pistes gardés.
      copy: () => {
        const l = targets();
        if (l.length > 1) edit('', '', 'COPY_MANY', { items: l.map(x => ({ trackId: x.trackId, clipId: x.clip.id })) });
        else if (l[0]) edit(l[0].trackId, l[0].clip.id, 'COPY');
        return l.length > 0;
      },
      cut: () => {
        const l = targets();
        if (l.length > 1) edit('', '', 'CUT_MANY', { items: l.map(x => ({ trackId: x.trackId, clipId: x.clip.id })) });
        else l.forEach(({ trackId, clip }) => edit(trackId, clip.id, 'CUT'));
        return l.length > 0;
      },
      paste: () => {
        const target = c().selectedTrackId || c().selectedClip?.trackId;
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
      // Respirations (Ctrl+Alt+R) : clips sélectionnés, sinon TOUTES les voix de la séance (lead
      // baissée, backs supprimées, piste par piste dans la fenêtre). Avant : la piste « active »,
      // c'est-à-dire souvent la dernière importée : l'ingé devait recommencer piste par piste.
      breaths: () => {
        const l = targets().filter(({ clip }) => clip.type !== TrackType.MIDI);
        if (l.length) requestBreaths({ mode: 'dialog', clipIds: l.map(x => x.clip.id), trackIds: Array.from(new Set(l.map(x => x.trackId))), reason: 'shortcut' });
        else requestBreaths({ mode: 'dialog', reason: 'shortcut' });
        return true;
      },
      selectAllClips: () => {
        const ids = new Set(c().tracks.filter(t => t.type !== TrackType.SEND && t.id !== 'master').flatMap(t => t.clips.map(cl => cl.id)));
        c().setSelectedClipIds(ids);
        return ids.size > 0;
      },
      // Tous les clips de la piste (pistes des clips sélectionnés, sinon la piste active) :
      // Pro Tools, triple-clic dans la piste avec le Sélecteur. Ctrl+Alt+A, menu de la piste.
      selectTrackClips: (arg?: { trackId?: string }) => {
        const { tracks, selectedTrackId, selectedClipIds } = c();
        const trackIds = arg?.trackId ? [arg.trackId] : tracksOfSelection(tracks, selectedClipIds, selectedTrackId);
        const ids = selectTrackClipIds(tracks, trackIds);
        const say = (detail: string) => window.dispatchEvent(new CustomEvent('nova:notify', { detail }));
        if (!trackIds.length) { say('Sélectionne d’abord une piste (clic sur son nom).'); return true; }
        if (!ids.size) { say('Cette piste n’a encore aucun clip.'); return true; }
        c().setSelectedClipIds(ids);
        const names = tracks.filter(t => trackIds.includes(t.id)).map(t => `« ${t.name} »`).join(', ');
        say(`${ids.size} clip${ids.size > 1 ? 's' : ''} sélectionné${ids.size > 1 ? 's' : ''} sur ${names}.`);
        return true;
      },
      // Ancrés sur la tête de lecture (visible) ou le milieu de la vue : la vue ne saute plus ailleurs.
      zoomIn: () => { zoomTo(c().zoomH * 1.5); },
      zoomOut: () => { zoomTo(c().zoomH / 1.5); },
      // 1 = tout le morceau, 2 = 8 mesures, 3 = 4 mesures, 4 = 1 mesure, 5 = au plus près
      // (quelques millisecondes : les échantillons et les passages à zéro sont visibles).
      zoomPreset: (n: number) => {
        const w = Math.max(200, c().viewportWidth);
        if (n === 1) { const end = songEnd() * 1.03; zoomTo(w / end, { time: 0, px: 0 }); return; }
        const span = n === 2 ? barSec() * 8 : n === 3 ? barSec() * 4 : n === 4 ? barSec() : 0.025;
        zoomTo(w / span);
      },
      // Zoom sur la sélection (Z, comme Logic et Live) : plage de temps, sinon clips sélectionnés,
      // sinon tout le morceau. Z une 2e fois, sans avoir rien touché : retour à la vue d'avant.
      zoomToSelection: () => {
        const now = { zoom: c().zoomH, scroll: scrollLeftNow() };
        if (saved && Math.abs(now.zoom - saved.fitted.zoom) < 1e-6 * now.zoom && Math.abs(now.scroll - saved.fitted.scroll) < 2) {
          const back = saved; saved = null;
          zoomTo(back.zoom, { time: back.scroll / back.zoom, px: 0 });
          if (back.height !== c().zoomV) c().setZoomV(back.height);
          return true;
        }
        const ts = editSelectionStore.get().time;
        if (ts && ts.end > ts.start) { frame(ts.start, ts.end); return true; }
        const l = targets();
        if (l.length) {
          frame(Math.min(...l.map(x => x.clip.start)), Math.max(...l.map(x => x.clip.start + x.clip.duration)));
          return true;
        }
        frame(0, songEnd(), true);
        return true;
      },
      trackHeight: (px: number) => { c().setZoomV(clampTrackHeight(px)); },
      trackHeightUp: () => { c().setZoomV(stepTrackHeight(c().zoomV, 1)); },
      trackHeightDown: () => { c().setZoomV(stepTrackHeight(c().zoomV, -1)); },
    });
  }, []);
}
