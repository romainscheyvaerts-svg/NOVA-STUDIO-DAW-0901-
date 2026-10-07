import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Track } from '../types';
import { TakeLane } from '../utils/playlists';
import { readComp, CompSegment } from '../utils/comping';
import { fmtTime } from '../utils/takes';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { visibleEnvelope } from '../utils/waveformPeaks';

/**
 * Couloirs de prises sous une piste (« Playlists » de Pro Tools, « take
 * lanes » d'Ableton, dossier de prises de Logic) et comp à la souris (Quick
 * Swipe Comping de Logic) : on balaie un passage dans un couloir, il passe
 * dans la piste principale. Au doigt : glisser horizontalement = balayer,
 * glisser verticalement = faire défiler.
 */

/** Hauteur d'un couloir (px) : assez pour le doigt. */
export const TAKE_LANE_H = 44;

/** Couleur d'une prise (la même dans le couloir, la pastille et le menu). */
export const TAKE_COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#facc15', '#34d399', '#fb923c', '#60a5fa', '#f87171'];
export const takeColor = (n: number) => TAKE_COLORS[(Math.max(1, n) - 1) % TAKE_COLORS.length];

export interface TakeLanesApi {
  open: Record<string, boolean>;
  audition: { trackId: string; n: number } | null;
  onToggle: (trackId: string, open?: boolean) => void;
  onAudition: (trackId: string, n: number | null) => void;
  /** b = null : tap (le passage du comp à cet instant). */
  onComp: (trackId: string, n: number, a: number, b: number | null) => void;
  onKeep: (trackId: string, n: number) => void;
  onRename: (trackId: string, n: number, name: string) => void;
  onDuplicate: (trackId: string, n: number) => void;
  onDelete: (trackId: string, n: number) => void;
}

// ------------------------------------------------------------------ en-têtes (colonne gauche)

interface HeaderProps {
  track: Track;
  lanes: TakeLane[];
  api: TakeLanesApi;
  onMenu: (x: number, y: number, lane: TakeLane) => void;
}

export const TakeLaneHeaders: React.FC<HeaderProps> = ({ track, lanes, api, onMenu }) => {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const commit = (n: number) => { api.onRename(track.id, n, draft); setEditing(null); };
  // « Renommer… » du menu du couloir : édition sur place.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.trackId !== track.id) return;
      const l = lanes.find(x => x.n === d.n);
      if (l) { setDraft(l.meta?.name || l.name); setEditing(l.n); }
    };
    window.addEventListener('nova:rename-take', on);
    return () => window.removeEventListener('nova:rename-take', on);
  }, [track.id, lanes]);
  return (
    <div data-take-lanes={track.id}>
      {lanes.map(l => {
        const solo = api.audition?.trackId === track.id && api.audition.n === l.n;
        const used = l.used > 0.05;
        return (
          <div key={l.n} data-take-lane={l.n}
            className={`flex items-center gap-1 pl-1 pr-1 border-t border-white/5 ${solo ? 'bg-cyan-500/10' : 'bg-[#101216]'}`}
            style={{ height: TAKE_LANE_H }} title={l.title}>
            <span className="w-1 self-stretch rounded-full shrink-0" style={{ background: takeColor(l.n), opacity: used ? 1 : 0.4 }} />
            <button type="button" aria-pressed={solo}
              aria-label={solo ? `Revenir à ta voix finale` : `Écouter ${l.name} seule`}
              title={solo ? 'Revenir à ta voix finale (tout le comp)' : `Écouter ${l.name} seule (comme le solo d'une playlist de Pro Tools)`}
              onClick={() => api.onAudition(track.id, solo ? null : l.n)}
              className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-[11px] ${solo ? 'bg-cyan-400 text-black' : 'bg-white/5 text-slate-300 hover:text-white hover:bg-white/10'}`}>
              <i className="fas fa-headphones" />
            </button>
            {editing === l.n ? (
              <input autoFocus value={draft} maxLength={40} aria-label={`Nouveau nom de ${l.name}`}
                onChange={e => setDraft(e.target.value)}
                onBlur={() => commit(l.n)}
                onKeyDown={e => { if (e.key === 'Enter') commit(l.n); if (e.key === 'Escape') setEditing(null); e.stopPropagation(); }}
                className="min-w-0 flex-1 h-8 rounded-md bg-black/50 border border-cyan-500/60 px-1.5 text-[11px] text-white outline-none" />
            ) : (
              <button type="button" className="min-w-0 flex-1 text-left leading-tight"
                onDoubleClick={() => { setDraft(l.meta?.name || l.name); setEditing(l.n); }}
                onClick={() => api.onKeep(track.id, l.n)}
                title={`${l.title}\nClic : garder toute la prise · Double-clic : renommer`}>
                <span className={`block truncate text-[11px] font-bold ${used ? 'text-white' : 'text-slate-400'}`}>{l.label}</span>
                <span className="block truncate text-[9.5px] text-slate-500">
                  {used ? `✓ entendue ${fmtTime(l.used)}` : 'pas utilisée'}{l.meta?.loopPass ? ` · tour ${l.meta.loopPass}` : ''}{l.meta?.score ? ` · note ${l.meta.score.total}/100` : ''}
                </span>
              </button>
            )}
            <button type="button" aria-label={`Options de ${l.name}`} title="Garder, renommer, dupliquer, supprimer"
              onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onMenu(r.right, r.bottom, l); }}
              className="w-8 h-8 shrink-0 rounded-lg bg-white/5 text-slate-300 hover:text-white hover:bg-white/10 text-[11px]">
              <i className="fas fa-ellipsis-vertical" />
            </button>
          </div>
        );
      })}
    </div>
  );
};

// ------------------------------------------------------------------ couloirs (timeline)

interface OverlayProps {
  track: Track;
  lanes: TakeLane[];
  api: TakeLanesApi;
  /** Haut du 1er couloir dans le calque (px, déjà décalé du défilement). */
  top: number;
  zoomH: number;
  scrollLeft: number;
  width: number;
  /** Molette : on fait défiler l'arrangement. */
  onWheel: (e: React.WheelEvent) => void;
}

interface Drag { n: number; t0: number; t1: number; x0: number; pointerId: number; moved: boolean }

export const TakeLanesOverlay: React.FC<OverlayProps> = ({ track, lanes, api, top, zoomH, scrollLeft, width, onWheel }) => {
  const segs = useMemo<CompSegment[]>(() => readComp(track.clips), [track.clips]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const timeAt = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.max(0, (e.clientX - r.left + scrollLeft) / zoomH);
  };
  const end = (e: React.PointerEvent, cancel = false) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d || cancel) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(d.pointerId); } catch { /* */ }
    if (!d.moved) api.onComp(track.id, d.n, d.t0, null);
    else api.onComp(track.id, d.n, d.t0, d.t1);
  };
  return (
    <>
      {lanes.map((l, i) => (
        <div key={l.n} data-take-lane-row={l.n}
          title={`${l.title}\nBalaie un passage pour le garder dans ta voix finale (Quick Swipe Comping de Logic, comping de Pro Tools) · Tap : remplace le passage à cet endroit`}
          className="absolute left-0 right-0 border-t border-white/5 cursor-crosshair select-none"
          style={{ top: top + i * TAKE_LANE_H, height: TAKE_LANE_H, pointerEvents: 'auto', touchAction: 'pan-y' }}
          onWheel={onWheel}
          onContextMenu={e => e.preventDefault()}
          onPointerDown={e => {
            if (e.button !== 0) return;
            e.stopPropagation();
            const t = timeAt(e);
            const d: Drag = { n: l.n, t0: t, t1: t, x0: e.clientX, pointerId: e.pointerId, moved: false };
            dragRef.current = d; setDrag(d);
            try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* */ }
          }}
          onPointerMove={e => {
            const d = dragRef.current;
            if (!d || d.pointerId !== e.pointerId) return;
            const moved = d.moved || Math.abs(e.clientX - d.x0) > 5;
            const nd = { ...d, t1: timeAt(e), moved };
            dragRef.current = nd; setDrag(nd);
          }}
          onPointerUp={e => end(e)}
          onPointerCancel={e => end(e, true)}
        >
          <LaneCanvas lane={l} segs={segs} zoomH={zoomH} scrollLeft={scrollLeft} width={width}
            solo={api.audition?.trackId === track.id && api.audition.n === l.n} />
          {drag && drag.n === l.n && drag.moved && (
            <div className="absolute top-0.5 bottom-0.5 rounded-md border-2 pointer-events-none"
              style={{ left: Math.min(drag.t0, drag.t1) * zoomH - scrollLeft, width: Math.abs(drag.t1 - drag.t0) * zoomH,
                borderColor: takeColor(l.n), background: takeColor(l.n) + '33' }}>
              <span className="absolute -top-0.5 left-1 text-[10px] font-black text-white drop-shadow">{fmtTime(Math.min(drag.t0, drag.t1))} → {fmtTime(Math.max(drag.t0, drag.t1))}</span>
            </div>
          )}
        </div>
      ))}
    </>
  );
};

/** Un couloir : l'audio de la prise (forme d'onde), en couleur là où on l'entend. */
const LaneCanvas: React.FC<{ lane: TakeLane; segs: CompSegment[]; zoomH: number; scrollLeft: number; width: number; solo: boolean }> =
  ({ lane, segs, zoomH, scrollLeft, width, solo }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(width));
    const h = TAKE_LANE_H - 1;
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const color = takeColor(lane.n);
    const used = segs.filter(s => s.n === lane.n);
    for (const sp of lane.spans) {
      const x0 = sp.start * zoomH - scrollLeft, x1 = sp.end * zoomH - scrollLeft;
      if (x1 < 0 || x0 > w) continue;
      ctx.fillStyle = solo ? color + '30' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(x0, 2, x1 - x0, h - 4);
      ctx.strokeStyle = color + '66';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, 2.5, Math.max(1, x1 - x0 - 1), h - 5);
      // Passages entendus : fond coloré.
      for (const s of used) {
        if (s.span !== sp.key) continue;
        const a = s.start * zoomH - scrollLeft, b = s.end * zoomH - scrollLeft;
        ctx.fillStyle = color + '40';
        ctx.fillRect(a, 2, b - a, h - 4);
        ctx.fillStyle = color;
        ctx.fillRect(a, 2, b - a, 2);
      }
      // Forme d'onde.
      const buf = sp.base.bufferId ? audioBufferRegistry.get(sp.base.bufferId) : sp.base.buffer;
      if (!buf) continue;
      const px0 = Math.max(0, Math.floor(-x0)), wpx = Math.max(1, Math.round(x1 - x0));
      const px1 = Math.min(wpx, Math.ceil(w - x0) + 1);
      if (px1 <= px0) continue;
      const sr = buf.sampleRate;
      const off = sp.start - sp.anchor;
      const env = visibleEnvelope(buf, Math.floor(off * sr), Math.min(buf.length, Math.floor((off + sp.end - sp.start) * sr)), wpx, px0, px1, false);
      const cy = h / 2, amp = (h - 10) * 0.45 * Math.min(4, sp.base.gain ?? 1);
      for (let i = 0; i < px1 - px0; i++) {
        const t = sp.start + (px0 + i) / zoomH;
        const heard = used.some(s => s.span === sp.key && t >= s.start && t < s.end);
        ctx.fillStyle = heard || solo ? color : 'rgba(148,163,184,0.45)';
        const v = Math.min(1, env[i]) * amp;
        ctx.fillRect(x0 + px0 + i, cy - v, 1, Math.max(1, v * 2));
      }
    }
  }, [lane, segs, zoomH, scrollLeft, width, solo]);
  return <canvas ref={ref} className="absolute inset-0 pointer-events-none" style={{ width: Math.max(1, Math.floor(width)), height: TAKE_LANE_H - 1 }} />;
};
