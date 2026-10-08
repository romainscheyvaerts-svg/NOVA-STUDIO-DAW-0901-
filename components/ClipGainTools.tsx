import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { AutomationLane, AutomationPoint, Clip, ContextMenuItem, EditorTool, Track } from '../types';
import { TrackType } from '../types';
import {
  addFreehandSample, addGainPoint, applyPencilToAutomation, applyPencilToClip, clipGainViewStore, ClipGainView, dbText,
  envelopeDbAt, lineDb, lineY, linToDb, dbToLin, moveGainPoint, PENCIL_SHAPES, PencilShape, PencilStroke, pointsInClip,
  removeGainPoint, setSegmentCurve, sortGainPoints, clampDb,
} from '../utils/clipGain';
import { gridStepSeconds, snapToGrid } from '../utils/grid';
import { LANE_HEIGHT } from '../utils/automationDraw';
import { normalize, paramSpec, sortedPoints, valueAtPoints } from '../utils/automationWrite';
import { canvasTheme } from '../utils/canvasTheme';
import { getEditCommands, bufferDurationOf } from '../hooks/useEditCommands';
import {
  clipToolsDialogStore, healCommand, loopCommand, loopTrimPlan, renderGainCommand, repeatCommand, revertGainCommand,
  unloopCommand, useClipGainCommands,
} from '../hooks/useClipGainCommands';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { editSelectionStore } from '../utils/editSelection';

/**
 * Gain de clip façon Pro Tools dans l'arrangement (R5) : ligne de gain à
 * points, crayon (clips et lignes d'automation), Loop Trim, barre d'outils,
 * menus et fenêtres « Répéter » / « Boucler ». La logique est dans
 * utils/clipGain et utils/clipLoop ; l'arrangement n'appelle que quelques
 * crochets (onClipDown, onMove, onUp, draw, cursorAt).
 */

export const useClipGainView = (): ClipGainView => useSyncExternalStore(clipGainViewStore.subscribe, clipGainViewStore.get, clipGainViewStore.get);

const isAudio = (c: Clip) => c.type !== TrackType.MIDI && !!(c.bufferId || c.buffer);
const AMBER = '#fbbf24';

type Drag =
  | { kind: 'point'; trackId: string; clipId: string; index: number; moved: boolean; h: number }
  | { kind: 'global'; trackId: string; clipId: string; lastY: number; db: number; h: number }
  | { kind: 'curve'; trackId: string; clipId: string; index: number; startY: number; curve0: number; sign: number }
  | { kind: 'pencil'; trackId: string; clip0: Clip; stroke: PencilStroke; moved: boolean; clipTop: number; h: number }
  | { kind: 'auto'; track: Track; lane: AutomationLane; points0: AutomationPoint[]; stroke: PencilStroke; lyDown: number; yDown: number; moved: boolean }
  | { kind: 'loop'; trackId: string; clipId: string; clips0: Clip[]; lastIds: string[] };

export interface ClipGainEditDeps {
  zoomH: number;
  bpm: number;
  gridSize: string;
  /** Calage sur la grille pour ce geste (mode Grid, Ctrl / Maj inversent). */
  snap: (ev?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } | null) => boolean;
  /** Appui au doigt (zones d'accroche plus grandes). */
  touch: () => boolean;
  onUpdateTrack: (t: Track) => void;
}

interface ClipHit { trackId: string; clip: Clip; x: number; relY: number; laneH: number; tool: EditorTool; edgePx: number }

/** Valeur d'une voie d'automation ↔ position verticale (même échelle que utils/automationDraw). */
const laneSpec = (lane: AutomationLane) => ({ ...paramSpec(lane.parameterName), min: lane.min, max: lane.max });
const laneValueAt = (lane: AutomationLane, relY: number): number => {
  const spec = laneSpec(lane);
  const n = Math.max(0, Math.min(1, 1 - (relY - 8) / (LANE_HEIGHT - 16)));
  if (spec.kind === 'gain') return n * n * (spec.max || 1);
  return spec.min + n * (spec.max - spec.min);
};

export function useClipGainEdit(deps: ClipGainEditDeps) {
  const view = useClipGainView();
  const ref = useRef(deps);
  ref.current = deps;
  const drag = useRef<Drag | null>(null);
  const activeRef = useRef(false);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  const ed = () => getEditCommands();
  const liveClip = (trackId: string, clipId: string): Clip | undefined => ed()?.getState().tracks.find(t => t.id === trackId)?.clips.find(c => c.id === clipId);
  const patch = (trackId: string, clipId: string, p: Partial<Clip>) => ed()?.patchClips(trackId, { [clipId]: p });
  const grab = () => (ref.current.touch() ? 14 : 7);
  const timeAt = (x: number) => x / ref.current.zoomH;
  const gridStep = () => gridStepSeconds(ref.current.gridSize, ref.current.bpm);
  const snapT = (t: number, ev?: any) => (ref.current.snap(ev) ? snapToGrid(t, ref.current.bpm, ref.current.gridSize, true) : t);
  const totalDbOf = (c: Clip) => { const g = linToDb(c.gain ?? 1); return Number.isFinite(g) ? g : -60; };
  const start = (d: Drag) => { drag.current = d; activeRef.current = true; };

  /** Points de la ligne à l'écran : x (contenu, px), y (relatif au haut du clip). */
  const screenPoints = (c: Clip, h: number) => {
    const z = ref.current.zoomH, g = totalDbOf(c), off = c.offset || 0;
    return pointsInClip(c).map(({ index, p }) => ({ index, x: (c.start + (p.t - off)) * z, y: lineY(h, g + p.db), p }));
  };

  const onClipDown = (e: React.MouseEvent | React.PointerEvent, a: ClipHit): boolean => {
    const c = a.clip;
    if (!isAudio(c) || e.button === 2) return false;
    const v = clipGainViewStore.get();
    const h = a.laneH - 4, y = a.relY - 2;
    const cx0 = c.start * ref.current.zoomH, cx1 = (c.start + c.duration) * ref.current.zoomH;
    // --- Crayon : dessiner la ligne de gain.
    if (a.tool === 'DRAW') {
      const t = snapT(timeAt(a.x), e);
      const v0 = lineDb(h, y);
      const stroke: PencilStroke = { shape: v.shape, t0: t, t1: t, v0, v1: v0, period: gridStep(), step: ref.current.snap(e) ? gridStep() : undefined, samples: [{ t: timeAt(a.x), v: v0 }], seed: Date.now() & 0xffff };
      start({ kind: 'pencil', trackId: a.trackId, clip0: c, stroke, moved: false, clipTop: 2, h });
      setTip({ x: e.clientX, y: e.clientY, text: `Crayon · ${PENCIL_SHAPES.find(s => s.id === v.shape)?.label} · ${dbText(v0)}` });
      return true;
    }
    // --- Loop Trim : bord droit, moitié basse (le coin haut reste le fondu).
    if (v.loopTrim && cx1 - a.x < Math.max(a.edgePx, ref.current.touch() ? 16 : 0) && a.relY >= a.laneH * 0.35) {
      const track = ed()?.getState().tracks.find(t => t.id === a.trackId);
      if (!track) return false;
      const ids = c.loop ? track.clips.filter(x => x.loop?.id === c.loop!.id).map(x => x.id) : [c.id];
      start({ kind: 'loop', trackId: a.trackId, clipId: c.id, clips0: track.clips.map(x => ({ ...x })), lastIds: ids });
      setTip({ x: e.clientX, y: e.clientY, text: 'Boucle : tire vers la droite' });
      return true;
    }
    if (!v.line) return false;
    if (cx1 - cx0 < 8) return false;
    // --- Point existant : le tirer, Alt+clic l'enlève.
    const pts = screenPoints(c, h);
    let best = -1, bestD = grab() + 1;
    pts.forEach((p, k) => { const d = Math.hypot(p.x - a.x, p.y - y); if (d < bestD) { bestD = d; best = k; } });
    if (best >= 0) {
      const sp = pts[best];
      if (e.altKey) {
        patch(a.trackId, c.id, { gainPoints: removeGainPoint(sortGainPoints(c.gainPoints), sp.index).length ? removeGainPoint(sortGainPoints(c.gainPoints), sp.index) : undefined });
        setTip({ x: e.clientX, y: e.clientY, text: 'Point enlevé' });
        window.setTimeout(() => setTip(null), 600);
        return true;
      }
      start({ kind: 'point', trackId: a.trackId, clipId: c.id, index: sp.index, moved: false, h });
      setTip({ x: e.clientX, y: e.clientY, text: dbText(totalDbOf(c) + sp.p.db) });
      return true;
    }
    // --- Sur la ligne : poser un point (Ctrl : courber le segment, Maj : tout le clip).
    if (a.x < cx0 || a.x > cx1) return false;
    const t = timeAt(a.x);
    const src = (c.offset || 0) + (t - c.start);
    const sorted = sortGainPoints(c.gainPoints);
    const envDb = envelopeDbAt(sorted, src);
    const ly = lineY(h, totalDbOf(c) + envDb);
    if (Math.abs(ly - y) > grab()) return false;
    if (e.shiftKey) {
      start({ kind: 'global', trackId: a.trackId, clipId: c.id, lastY: e.clientY, db: totalDbOf(c), h });
      setTip({ x: e.clientX, y: e.clientY, text: `Tout le clip · ${dbText(totalDbOf(c))}` });
      return true;
    }
    if (e.ctrlKey || e.metaKey) {
      const i = sorted.findIndex((p, k) => k + 1 < sorted.length && p.t <= src && sorted[k + 1].t >= src);
      if (i < 0) return false;
      start({ kind: 'curve', trackId: a.trackId, clipId: c.id, index: i, startY: e.clientY, curve0: sorted[i].curve || 0, sign: sorted[i + 1].db >= sorted[i].db ? 1 : -1 });
      setTip({ x: e.clientX, y: e.clientY, text: 'Courbure du segment' });
      return true;
    }
    const tp = snapT(t, e);
    const srcP = Math.max(c.offset || 0, Math.min((c.offset || 0) + c.duration, (c.offset || 0) + (tp - c.start)));
    const r = addGainPoint(sorted, srcP, envelopeDbAt(sorted, srcP));
    patch(a.trackId, c.id, { gainPoints: r.points });
    start({ kind: 'point', trackId: a.trackId, clipId: c.id, index: r.index, moved: false, h });
    setTip({ x: e.clientX, y: e.clientY, text: `Point posé · ${dbText(totalDbOf(c) + r.points[r.index].db)}` });
    return true;
  };

  /** Crayon sur une voie d'automation ouverte (relY : depuis le haut des voies de la piste ; yContent : ordonnée du contenu). */
  const onAutomationDown = (e: React.MouseEvent | React.PointerEvent, track: Track, x: number, relY: number, yContent: number): boolean => {
    const lanes = (track.automationLanes || []).filter(l => l.isExpanded);
    const lane = lanes[Math.floor(relY / LANE_HEIGHT)];
    if (!lane || e.button === 2) return false;
    const ly = relY - Math.floor(relY / LANE_HEIGHT) * LANE_HEIGHT;
    const t = snapT(timeAt(x), e);
    const v0 = laneValueAt(lane, ly);
    const v = clipGainViewStore.get();
    const stroke: PencilStroke = { shape: v.shape, t0: t, t1: t, v0, v1: v0, period: gridStep(), step: ref.current.snap(e) ? gridStep() : undefined, samples: [{ t: timeAt(x), v: v0 }], seed: Date.now() & 0xffff, ramp: 0.002 };
    start({ kind: 'auto', track, lane, points0: sortedPoints(lane.points), stroke, lyDown: ly, yDown: yContent, moved: false });
    setTip({ x: e.clientX, y: e.clientY, text: `Crayon · automation` });
    return true;
  };

  /** Applique le geste du crayon d'automation (relY absolu dans les voies de la piste). */
  const applyAuto = (d: Extract<Drag, { kind: 'auto' }>, final: boolean) => {
    const stat = d.lane.parameterName === 'volume' ? d.track.volume : d.lane.parameterName === 'pan' ? d.track.pan : (d.lane.min + d.lane.max) / 2;
    let n = 0;
    const tag = Date.now().toString(36);
    const pts = applyPencilToAutomation(d.points0, d.stroke, t => valueAtPoints(d.points0, t, stat), () => `pt-${tag}-${n++}`, d.stroke.ramp);
    const live = ed()?.getState().tracks.find(t => t.id === d.track.id) || d.track;
    ref.current.onUpdateTrack({ ...live, automationLanes: live.automationLanes.map(l => (l.id === d.lane.id ? { ...l, points: pts } : l)) });
    if (final) setTip(null);
  };

  const onMove = (e: React.MouseEvent | React.PointerEvent, x: number, yContent: number, laneTopOf?: (trackId: string) => number | null): boolean => {
    const d = drag.current;
    if (!d) return false;
    const t = timeAt(x);
    if (d.kind === 'pencil') {
      const top = laneTopOf?.(d.trackId);
      if (top === null || top === undefined) return true;
      const y = yContent - top - 2;
      const v1 = lineDb(d.h, y);
      const s = d.stroke;
      s.t1 = snapT(t, e);
      s.v1 = v1;
      s.step = ref.current.snap(e) ? gridStep() : undefined;
      if (s.shape === 'free') s.samples = addFreehandSample(s.samples || [], t, v1);
      d.moved = true;
      const pts = applyPencilToClip(d.clip0, s);
      patch(d.trackId, d.clip0.id, { gainPoints: pts && pts.length ? pts : undefined });
      setTip({ x: e.clientX, y: e.clientY, text: `${PENCIL_SHAPES.find(p => p.id === s.shape)?.label} · ${dbText(v1)}` });
      return true;
    }
    if (d.kind === 'auto') {
      const ly = d.lyDown + (yContent - d.yDown);
      const v1 = laneValueAt(d.lane, ly);
      const s = d.stroke;
      s.t1 = snapT(t, e); s.v1 = v1;
      s.step = ref.current.snap(e) ? gridStep() : undefined;
      if (s.shape === 'free') s.samples = addFreehandSample(s.samples || [], t, v1);
      d.moved = true;
      applyAuto(d, false);
      const spec = laneSpec(d.lane);
      setTip({ x: e.clientX, y: e.clientY, text: `Automation · ${spec.kind === 'gain' ? dbText(linToDb(v1)) : v1.toFixed(2)}` });
      return true;
    }
    const c = liveClip((d as any).trackId, (d as any).clipId);
    if (d.kind === 'loop') {
      const end = Math.max(0, snapT(t, e));
      const v = clipGainViewStore.get();
      const plan = loopTrimPlan(d.clips0, d.clipId, end, { xfade: v.loopXfadeMs / 1000, bufferDuration: bufferDurationOf(d.clips0.find(x => x.id === d.clipId) || {}) });
      if (!plan) return true;
      ed()?.replaceClips(d.trackId, d.lastIds, plan.add);
      d.lastIds = plan.add.map(x => x.id);
      const unit = plan.add[0]?.loop?.unit ?? plan.add[0]?.duration ?? 1;
      const turns = (end - plan.add[0].start) / unit;
      setTip({ x: e.clientX, y: e.clientY, text: plan.add.length > 1 ? `Boucle · ${turns.toFixed(2).replace('.', ',')} tours` : 'Boucle · 1 tour (rognage)' });
      return true;
    }
    if (!c) return true;
    const laneTop = laneTopOf?.(d.trackId);
    if (d.kind === 'point') {
      if (laneTop === null || laneTop === undefined) return true;
      const h = d.h;
      const y = yContent - laneTop - 2;
      const sorted = sortGainPoints(c.gainPoints);
      const tp = snapT(t, e);
      const src = (c.offset || 0) + (tp - c.start);
      const db = clampDb(lineDb(h, y) - totalDbOf(c));
      const next = moveGainPoint(sorted, d.index, src, db, { min: c.offset || 0, max: (c.offset || 0) + c.duration });
      d.moved = true;
      patch(d.trackId, c.id, { gainPoints: next });
      setTip({ x: e.clientX, y: e.clientY, text: dbText(totalDbOf(c) + next[d.index].db) });
      return true;
    }
    if (d.kind === 'global') {
      const h = d.h;
      const dbPerPx = 52 / Math.max(10, h - 22) * (e.shiftKey ? 0.2 : 1);
      d.db = Math.max(-40, Math.min(12, d.db - (e.clientY - d.lastY) * dbPerPx));
      d.lastY = e.clientY;
      const snapped = Math.abs(d.db) < 0.3 ? 0 : d.db;
      patch(d.trackId, c.id, { gain: Math.abs(snapped) < 1e-6 ? 1 : dbToLin(snapped) });
      setTip({ x: e.clientX, y: e.clientY, text: `Tout le clip · ${dbText(snapped)}` });
      return true;
    }
    if (d.kind === 'curve') {
      const curve = Math.max(-1, Math.min(1, d.curve0 + d.sign * (d.startY - e.clientY) / 80));
      patch(d.trackId, c.id, { gainPoints: setSegmentCurve(sortGainPoints(c.gainPoints), d.index, curve) });
      setTip({ x: e.clientX, y: e.clientY, text: `Courbure ${Math.round(curve * 100)} %` });
      return true;
    }
    return true;
  };

  const onUp = (): boolean => {
    const d = drag.current;
    drag.current = null;
    activeRef.current = false;
    if (!d) return false;
    if (d.kind === 'pencil' && !d.moved) {
      // Simple toucher au crayon : un point à cet endroit.
      const pts = applyPencilToClip(d.clip0, { ...d.stroke, shape: 'free' });
      patch(d.trackId, d.clip0.id, { gainPoints: pts && pts.length ? pts : undefined });
    }
    if (d.kind === 'auto' && !d.moved) applyAuto({ ...d, stroke: { ...d.stroke, shape: 'free' } }, true);
    setTip(null);
    return true;
  };

  /** Curseur et aide au survol (null : rien de spécial ici). */
  const cursorAt = (c: Clip, x: number, relY: number, laneH: number, tool: EditorTool, edgePx: number): { cursor: string; hint?: string } | null => {
    if (!isAudio(c)) return null;
    const v = clipGainViewStore.get();
    if (tool === 'DRAW') return { cursor: 'crosshair', hint: `Crayon (${PENCIL_SHAPES.find(s => s.id === v.shape)?.label}) : dessine la ligne de gain` };
    const cx1 = (c.start + c.duration) * ref.current.zoomH;
    if (v.loopTrim && cx1 - x < edgePx && relY >= laneH * 0.35) return { cursor: 'e-resize', hint: 'Glisser : boucler le clip (Loop Trim de Pro Tools)' };
    if (!v.line) return null;
    const h = laneH - 4, y = relY - 2;
    if (screenPoints(c, h).some(p => Math.hypot(p.x - x, p.y - y) <= grab())) return { cursor: 'move', hint: 'Glisser : déplacer le point · Alt+clic : l’enlever' };
    const src = (c.offset || 0) + (x / ref.current.zoomH - c.start);
    if (Math.abs(lineY(h, totalDbOf(c) + envelopeDbAt(sortGainPoints(c.gainPoints), src)) - y) <= grab()) return { cursor: 'copy', hint: 'Clic : poser un point · Ctrl+glisser : courber · Maj+glisser : tout le clip' };
    return null;
  };

  /** Dessin de la ligne, des points, des infos de gain et des boucles (appelé par drawClip). */
  const draw = (ctx: CanvasRenderingContext2D, c: Clip, x: number, y: number, w: number, h: number, isSelected: boolean) => {
    if (!isAudio(c) || w < 3 || h < 24) return;
    const v = clipGainViewStore.get();
    const pts = sortGainPoints(c.gainPoints);
    const g = totalDbOf(c);
    const cv = canvasTheme();
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.clip();
    if (v.line || pts.length) {
      const z = ref.current.zoomH, off = c.offset || 0;
      const px0 = Math.max(x, 0), px1 = Math.min(x + w, ctx.canvas.width);
      ctx.strokeStyle = v.line ? AMBER : 'rgba(251,191,36,0.55)';
      ctx.lineWidth = v.line ? 1.5 : 1;
      if (!v.line) ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (let px = px0; px <= px1; px += 2) {
        const t = (px - x) / z;
        const yy = y + lineY(h, g + envelopeDbAt(pts, off + t));
        if (px === px0) ctx.moveTo(px, yy); else ctx.lineTo(px, yy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (v.line) {
        const big = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
        const s = big ? 9 : 6;
        let lastLabelX = -Infinity;
        for (const sp of pointsInClip(c)) {
          const xx = x + (sp.p.t - off) * z, yy = y + lineY(h, g + sp.p.db);
          if (xx < -10 || xx > ctx.canvas.width + 10) continue;
          ctx.fillStyle = isSelected ? AMBER : '#f59e0b';
          ctx.strokeStyle = cv.ink(0.9);
          ctx.lineWidth = 1;
          ctx.fillRect(xx - s / 2, yy - s / 2, s, s);
          ctx.strokeRect(xx - s / 2 + 0.5, yy - s / 2 + 0.5, s - 1, s - 1);
          if (v.info && xx - lastLabelX > 44) {
            const label = dbText(g + sp.p.db);
            ctx.font = '700 9px Inter';
            const tw = ctx.measureText(label).width;
            const ly = yy - 7 < y + 20 ? yy + 14 : yy - 6;
            ctx.fillStyle = cv.labelBg; ctx.fillRect(xx + 5, ly - 9, tw + 4, 11);
            ctx.fillStyle = AMBER; ctx.fillText(label, xx + 7, ly);
            lastLabelX = xx;
          }
        }
      }
    }
    // Infos de gain (Pro Tools : Clip Gain Info) : en bas à gauche du clip.
    if (v.info && w > 70 && (pts.length || c.gainRender)) {
      const lo = pts.length ? Math.min(...pts.map(p => p.db)) + g : g, hi = pts.length ? Math.max(...pts.map(p => p.db)) + g : g;
      const label = c.gainRender ? 'Gain rendu dans le fichier' : `Ligne ${dbText(lo)}${Math.abs(hi - lo) > 0.05 ? ` … ${dbText(hi)}` : ''}`;
      ctx.font = '700 9px Inter';
      const tw = ctx.measureText(label).width;
      const bx = Math.max(x + 4, 4), by = y + h - 15;
      ctx.fillStyle = cv.labelBg; ctx.fillRect(bx, by, tw + 18, 12);
      ctx.fillStyle = AMBER;
      ctx.fillRect(bx + 3, by + 3, 2, 6); ctx.fillRect(bx + 7, by + 2, 2, 8); ctx.fillRect(bx + 11, by + 4, 2, 4);
      ctx.fillText(label, bx + 16, by + 9);
    }
    // Itérations de boucle (Pro Tools : flèche de boucle sur chaque tour).
    if (c.loop && w > 18) {
      ctx.font = '900 11px Inter';
      ctx.fillStyle = cv.ink(0.85);
      ctx.fillText('⟳', x + w - 14, y + h - 5);
      if (c.loop.index > 0) {
        ctx.strokeStyle = cv.ink(0.35); ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(x + 0.5, y + 3); ctx.lineTo(x + 0.5, y + h - 3); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    ctx.restore();
  };

  const overlay = tip ? (
    <div role="status" data-testid="clip-gain-tip" className="fixed z-[200] px-2 py-1 bg-black/90 border border-amber-400/40 rounded-md shadow-2xl pointer-events-none text-[11px] font-black text-amber-300 font-mono tabular-nums"
      style={{ left: tip.x + 14, top: tip.y - 30 }}>{tip.text}</div>
  ) : null;

  return { view, activeRef, isActive: () => !!drag.current, onClipDown, onAutomationDown, onMove, onUp, cursorAt, draw, overlay };
}

// ----------------------------------------------------------------- barre d'outils

const btn = (on: boolean) => `h-9 [@media(pointer:coarse)]:h-10 min-w-9 [@media(pointer:coarse)]:min-w-10 px-2 rounded-lg flex items-center justify-center gap-1 text-[10px] font-bold border transition-all ${on ? 'bg-amber-400 text-black border-amber-300' : 'bg-black/30 border-white/10 text-slate-400 hover:text-white'}`;

/** Crayon (+ formes), ligne de gain, infos de gain, boucle : à côté des outils de l'arrangement. */
export const ClipGainToolbar: React.FC<{ activeTool: EditorTool; setActiveTool: (t: EditorTool) => void; compact?: boolean }> = ({ activeTool, setActiveTool, compact }) => {
  const v = useClipGainView();
  // Menu des formes : posé sur la page (au-dessus des pistes et de leurs en-têtes).
  const [shapesOpen, setShapesOpen] = useState<{ x: number; y: number } | null>(null);
  const shapeBtnRef = useRef<HTMLButtonElement>(null);
  const shape = PENCIL_SHAPES.find(s => s.id === v.shape) || PENCIL_SHAPES[0];
  useEffect(() => {
    if (!shapesOpen) return;
    const close = () => setShapesOpen(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [shapesOpen]);
  return (
    <div className="flex items-center gap-1 shrink-0" data-testid="clip-gain-toolbar">
      <div className="relative flex bg-black/40 rounded-lg p-0.5 border border-white/5">
        <button type="button" data-testid="tool-pencil" aria-pressed={activeTool === 'DRAW'} onClick={() => setActiveTool(activeTool === 'DRAW' ? 'SMART' : 'DRAW')}
          title={`Crayon (6, comme le Pencil Tool de Pro Tools : F10) : dessine la ligne de gain d'un clip ou une ligne d'automation ouverte. Forme : ${shape.label}.`}
          aria-label="Crayon"
          className={`w-9 h-9 [@media(pointer:coarse)]:w-10 [@media(pointer:coarse)]:h-10 rounded-lg flex items-center justify-center transition-all ${activeTool === 'DRAW' ? 'bg-amber-400 text-black' : 'text-slate-500 hover:text-white'}`}>
          <i className="fas fa-pencil-alt text-[12px]" />
        </button>
        <button ref={shapeBtnRef} type="button" data-testid="pencil-shape" aria-haspopup="menu" aria-expanded={!!shapesOpen}
          onPointerDown={e => e.stopPropagation()}
          onClick={() => setShapesOpen(o => { if (o) return null; const r = shapeBtnRef.current?.getBoundingClientRect(); return { x: r ? r.left - 40 : 0, y: r ? r.bottom + 4 : 48 }; })}
          title={`Forme du crayon : ${shape.label}. ${shape.hint}`} aria-label={`Forme du crayon : ${shape.label}`}
          className="w-6 [@media(pointer:coarse)]:w-8 h-9 [@media(pointer:coarse)]:h-10 rounded-lg flex items-center justify-center text-slate-400 hover:text-white">
          <i className={`fas ${shape.icon} text-[10px]`} />
        </button>
        {shapesOpen && createPortal(
          <div role="menu" aria-label="Formes du crayon" className="fixed z-[500] w-56 p-1 rounded-xl border border-white/10 shadow-2xl" style={{ left: Math.max(4, shapesOpen.x), top: shapesOpen.y, background: 'var(--bg-surface)' }} onPointerDown={e => e.stopPropagation()}>
            {PENCIL_SHAPES.map(s => (
              <button key={s.id} type="button" role="menuitemradio" aria-checked={v.shape === s.id} data-testid={`pencil-shape-${s.id}`}
                onClick={() => { clipGainViewStore.set({ shape: s.id as PencilShape }); setActiveTool('DRAW'); setShapesOpen(null); }}
                title={s.hint}
                className={`w-full flex items-center gap-2 px-2.5 py-2 [@media(pointer:coarse)]:py-3 rounded-lg text-left text-[12px] ${v.shape === s.id ? 'bg-amber-400/15 text-amber-500' : 'opacity-80 hover:bg-white/5'}`}>
                <i className={`fas ${s.icon} w-4 text-center text-[11px]`} />{s.label}
              </button>
            ))}
          </div>, document.body)}
      </div>
      <button type="button" data-testid="toggle-gain-line" aria-pressed={v.line} onClick={() => clipGainViewStore.set({ line: !v.line })}
        title="Ligne de gain des clips (Pro Tools : Ctrl+Maj+−, ici aussi Alt+G) : clique sur la ligne pour poser un point, tire-le, Alt+clic pour l'enlever, Ctrl+glisser pour courber un segment, Maj+glisser pour tout le clip. Ctrl+Maj+↑ / ↓ : ±0,5 dB."
        aria-label="Ligne de gain" className={btn(v.line)}>
        <i className="fas fa-chart-line text-[11px]" />{!compact && <span className="hidden 2xl:inline">Gain</span>}
      </button>
      {!compact && (
        <>
          <button type="button" data-testid="toggle-gain-info" aria-pressed={v.info} onClick={() => clipGainViewStore.set({ info: !v.info })}
            title="Valeurs de gain sur les clips (Pro Tools : Clip Gain Info) : le gain de chaque clip et de chaque point de sa ligne."
            aria-label="Valeurs de gain sur les clips" className={`${btn(v.info)} hidden lg:flex`}>
            <i className="fas fa-sliders text-[11px]" />{<span className="hidden 2xl:inline">dB</span>}
          </button>
          <button type="button" data-testid="toggle-loop-trim" aria-pressed={v.loopTrim} onClick={() => clipGainViewStore.set({ loopTrim: !v.loopTrim })}
            title="Mode boucle (Pro Tools : Loop Trim) : tire le bord droit d'un clip pour le répéter ; la dernière boucle peut être partielle. Ctrl+Alt+L : boucler n fois, Alt+R : répéter."
            aria-label="Mode boucle" className={btn(v.loopTrim)}>
            <i className="fas fa-repeat text-[11px]" />{<span className="hidden 2xl:inline">Boucle</span>}
          </button>
        </>
      )}
    </div>
  );
};

// ------------------------------------------------------------------- menus

const selectOnly = (clipId: string) => editSelectionStore.set({ clipIds: [clipId], time: null });

/** Entrées du menu d'un clip audio (clic droit, appui long). */
export function clipGainMenuItems(trackId: string, clip: Clip, close: () => void): ContextMenuItem[] {
  if (!isAudio(clip)) return [];
  const v = clipGainViewStore.get();
  const items: ContextMenuItem[] = [
    { label: 'Heal : recoller avec le voisin', icon: 'fa-bandage', shortcut: 'Ctrl+H',
      title: 'Recolle deux morceaux consécutifs d’un même fichier (Heal Separation de Pro Tools) : le son redevient celui d’avant la découpe.',
      onClick: () => { selectOnly(clip.id); healCommand(); close(); } },
    { label: 'Boucler le clip…', icon: 'fa-repeat', shortcut: 'Ctrl+Alt+L', title: 'Répète le clip en boucle (Loop de Pro Tools), avec des fondus aux jonctions si tu veux.',
      onClick: () => { selectOnly(clip.id); clipToolsDialogStore.set({ kind: 'loop' }); close(); } },
    ...(clip.loop ? [{ label: 'Défaire la boucle', icon: 'fa-link-slash', title: 'Ne garde que le clip d’origine (Unloop de Pro Tools).', onClick: () => { unloopCommand(trackId, clip.id); close(); } }] : []),
    { label: 'Répéter…', icon: 'fa-clone', shortcut: 'Alt+R', title: 'Copie le clip n fois à la suite (Repeat de Pro Tools).',
      onClick: () => { selectOnly(clip.id); clipToolsDialogStore.set({ kind: 'repeat' }); close(); } },
    { label: v.line ? 'Masquer la ligne de gain' : 'Afficher la ligne de gain', icon: 'fa-chart-line', shortcut: 'Alt+G',
      title: 'Ligne de gain des clips (Clip Gain Line de Pro Tools, Ctrl+Maj+−).', onClick: () => { clipGainViewStore.set({ line: !v.line }); close(); } },
  ];
  if (clip.gainPoints?.length) items.push({ label: 'Remettre la ligne de gain à plat', icon: 'fa-minus', title: 'Enlève tous les points (le gain global du clip reste).', onClick: () => { getEditCommands()?.patchClips(trackId, { [clip.id]: { gainPoints: undefined } }); close(); } });
  if (!clip.gainRender && (clip.gainPoints?.length || Math.abs((clip.gain ?? 1) - 1) > 1e-6)) {
    items.push({ label: 'Rendre le gain dans le fichier', icon: 'fa-file-waveform', title: 'Applique la ligne et le gain au son (Render Clip Gain de Pro Tools). Non destructif : « Revenir » remet tout comme avant.',
      onClick: () => { renderGainCommand([{ trackId, clip }]); close(); } });
  }
  if (clip.gainRender) {
    const can = !!clip.gainRender.sourceBufferId && audioBufferRegistry.has(clip.gainRender.sourceBufferId);
    items.push({ label: 'Revenir au gain d’avant le rendu', icon: 'fa-rotate-left', disabled: !can, title: can ? 'Remet le son d’origine et la ligne de gain.' : 'Le son d’origine n’est pas sur cet appareil.',
      onClick: () => { revertGainCommand(trackId, clip.id); close(); } });
  }
  return items;
}

// --------------------------------------------------------- fenêtres et commandes

interface NumberDialogProps {
  title: string; hint: string; testId: string; label: string; children?: React.ReactNode;
  value: number; min: number; max: number; onChange: (n: number) => void; onOk: () => void; onClose: () => void;
}

const NumberDialog: React.FC<NumberDialogProps> = ({ title, hint, testId, children, value, min, max, onChange, onOk, onClose, label }) => (
  <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/50" onPointerDown={onClose} role="presentation">
    <div role="dialog" aria-modal="true" aria-label={title} data-testid={testId} onPointerDown={e => e.stopPropagation()}
      className="w-[min(92vw,360px)] rounded-2xl border border-white/10 shadow-2xl p-4 space-y-3" style={{ background: 'var(--bg-surface)', color: 'var(--text-main, #e2e8f0)' }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onClose(); }}>
      <div className="text-[14px] font-black">{title}</div>
      <p className="text-[11px] opacity-70 leading-snug">{hint}</p>
      <label className="flex items-center justify-between gap-3 text-[12px] font-bold">
        {label}
        <span className="flex items-center gap-1">
          <button type="button" aria-label="Moins" className="w-10 h-10 rounded-lg bg-white/10" onClick={() => onChange(Math.max(min, value - 1))}>−</button>
          <input autoFocus type="number" min={min} max={max} value={value} aria-label={label}
            onChange={e => onChange(Math.max(min, Math.min(max, Math.round(Number(e.target.value) || min))))}
            className="w-16 h-10 text-center rounded-lg bg-black/40 border border-white/10 font-mono" />
          <button type="button" aria-label="Plus" className="w-10 h-10 rounded-lg bg-white/10" onClick={() => onChange(Math.min(max, value + 1))}>+</button>
        </span>
      </label>
      {children}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} className="h-10 px-4 rounded-lg bg-white/5 text-[12px] font-bold">Annuler</button>
        <button type="button" data-testid={`${testId}-ok`} onClick={onOk} className="h-10 px-4 rounded-lg bg-amber-400 text-black text-[12px] font-black">OK</button>
      </div>
    </div>
  </div>
);

/** Commandes R5 (raccourcis) + fenêtres « Répéter » et « Boucler ». À monter une fois dans l'arrangement. */
export const ClipToolsHost: React.FC = () => {
  useClipGainCommands();
  const dlg = useSyncExternalStore(clipToolsDialogStore.subscribe, clipToolsDialogStore.get, clipToolsDialogStore.get);
  const v = useClipGainView();
  const [n, setN] = useState(2);
  const [xf, setXf] = useState(v.loopXfadeMs);
  if (!dlg) return null;
  const close = () => clipToolsDialogStore.set(null);
  if (dlg.kind === 'repeat') {
    return <NumberDialog title="Répéter" testId="repeat-dialog" label="Nombre de copies" value={n} min={1} max={99} onChange={setN}
      hint="Copie les clips sélectionnés à la suite, autant de fois que tu veux (Repeat de Pro Tools, Alt+R)."
      onClose={close} onOk={() => { repeatCommand(n); close(); }} />;
  }
  return (
    <NumberDialog title="Boucler le clip" testId="loop-dialog" label="Nombre de tours" value={Math.max(2, n)} min={2} max={256} onChange={setN}
      hint="Répète le clip en boucle (Loop de Pro Tools). Ensuite, en mode Boucle, tire son bord droit pour ajouter ou enlever des tours."
      onClose={close} onOk={() => { clipGainViewStore.set({ loopXfadeMs: xf }); loopCommand(Math.max(2, n), xf); close(); }}>
      <label className="flex items-center justify-between gap-3 text-[12px] font-bold">
        Fondus aux jonctions
        <select value={xf} onChange={e => setXf(Number(e.target.value))} aria-label="Fondus aux jonctions"
          title="Un court fondu à chaque jonction évite les clics quand la fin et le début du clip ne se raccordent pas."
          className="h-10 rounded-lg bg-black/40 border border-white/10 px-2 text-[12px]">
          {[0, 2, 5, 10, 20, 50].map(ms => <option key={ms} value={ms}>{ms ? `${ms} ms` : 'Aucun'}</option>)}
        </select>
      </label>
    </NumberDialog>
  );
};

// --------------------------------------------------------------- téléphone

/** Version simple pour le téléphone : gain du clip ± 1 dB, et l'état de sa ligne. */
export const MobileClipGain: React.FC<{ clip: Clip; onChange: (patch: Partial<Clip>) => void }> = ({ clip, onChange }) => {
  const db = linToDb(clip.gain ?? 1);
  const cur = Number.isFinite(db) ? db : -60;
  const step = (d: number) => {
    const next = clampDb(cur + d);
    onChange({ gain: Math.abs(next) < 0.05 ? 1 : dbToLin(next) });
  };
  return (
    <div className="flex-shrink-0 flex flex-col items-center justify-center px-1.5 h-12 rounded-lg bg-white/5" data-testid="mobile-clip-gain"
      title="Gain du clip (Clip Gain de Pro Tools) : ±1 dB par appui. La ligne de gain dessinée sur ordinateur est gardée.">
      <span className="text-[8px] font-bold text-white/40 mb-0.5">GAIN{clip.gainPoints?.length ? ' · LIGNE' : ''}</span>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => step(-1)} aria-label="Baisser le gain du clip d’1 dB" className="nova-hit w-8 h-8 rounded bg-white/10 text-white/80 text-sm hover:bg-white/20">−</button>
        <span className="text-[9px] font-mono tabular-nums text-green-400 w-12 text-center">{dbText(cur)}</span>
        <button type="button" onClick={() => step(1)} aria-label="Monter le gain du clip d’1 dB" className="nova-hit w-8 h-8 rounded bg-white/10 text-white/80 text-sm hover:bg-white/20">+</button>
      </div>
    </div>
  );
};
