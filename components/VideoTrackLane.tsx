import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Track } from '../types';
import { useArrangementView } from '../hooks/useArrangementView';
import { useSimpleMode } from '../utils/simpleMode';
import { applyTracks } from '../utils/structureBus';
import { getVideoFile, nudgeOffset, openVideoExport, setVideoProject, thumbSlots, toggleVideoViewer, updateVideoMeta, useVideoMeta, videoBus, type VideoTrackMeta } from '../utils/videoTrack';
import { loadVideoElement, seekVideo } from '../utils/videoExport';

/**
 * Couloir vidéo (écart 24) : au-dessus de l'arrangement, les vignettes de la vidéo calées
 * sur le zoom et le défilement (comme les pistes épinglées), son nom, sa position (glisser
 * le couloir ou ◀ ▶ d'une image) et l'accord avec le son importé. Rien sans vidéo.
 */
const LANE_H = 48;
const THUMB_H = 40;
const fmtTime = (t: number) => { const s = Math.max(0, t); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0').replace('.', ',')}`; };

/** Vignettes : un élément vidéo caché, images tirées une à une et gardées en mémoire. */
function useThumbs(meta: VideoTrackMeta | null) {
  const [, setTick] = useState(0);
  const cache = useRef(new Map<number, string>());
  const queue = useRef<number[]>([]);
  const busy = useRef(false);
  const vid = useRef<{ v: HTMLVideoElement; url: string } | null>(null);
  useEffect(() => {
    cache.current = new Map(); queue.current = [];
    let dead = false;
    if (!meta) return;
    (async () => {
      try {
        const f = await getVideoFile(meta.id);
        if (!f || dead) return;
        vid.current = await loadVideoElement(f);
        if (dead) { URL.revokeObjectURL(vid.current.url); return; }
        setTick(x => x + 1);
      } catch { /* vidéo absente : couloir sans vignettes */ }
    })();
    return () => { dead = true; const x = vid.current; vid.current = null; if (x) { x.v.removeAttribute('src'); x.v.load(); URL.revokeObjectURL(x.url); } };
  }, [meta?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const pump = async () => {
    if (busy.current || !vid.current) return;
    busy.current = true;
    const { v } = vid.current;
    const c = document.createElement('canvas');
    try {
      while (queue.current.length && vid.current) {
        const t = queue.current.shift()!;
        if (cache.current.has(t)) continue;
        await seekVideo(v, t);
        const ar = (v.videoWidth || 16) / (v.videoHeight || 9);
        c.height = THUMB_H; c.width = Math.max(8, Math.round(THUMB_H * ar));
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
        cache.current.set(t, c.toDataURL('image/jpeg', 0.6));
        if (queue.current.length % 4 === 0) setTick(x => x + 1);
      }
    } catch { /* image illisible : ignorée */ }
    busy.current = false;
    setTick(x => x + 1);
  };
  const want = (ts: number[]) => {
    const missing = ts.filter(t => !cache.current.has(t) && !queue.current.includes(t));
    if (missing.length) { queue.current.push(...missing); void pump(); }
  };
  return { get: (t: number) => cache.current.get(t), want, ready: !!vid.current };
}

const VideoTrackLane: React.FC<{ visible: boolean; projectId: string; tracks: Track[] }> = ({ visible, projectId, tracks }) => {
  useEffect(() => { setVideoProject(projectId); }, [projectId]);
  const meta = useVideoMeta();
  const { simple } = useSimpleMode();
  const on = visible && !simple && !!meta;
  const view = useArrangementView(on);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [drag, setDrag] = useState<{ x0: number; off0: number; off: number } | null>(null);
  const thumbs = useThumbs(on ? meta : null);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(Math.max(0, el.clientWidth - view.header)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view.header, on]);
  const offset = drag ? drag.off : meta?.offset ?? 0;
  const slots = useMemo(() => (meta ? thumbSlots({ t0: view.scroll / view.h, t1: (view.scroll + width) / view.h, pxPerSec: view.h, thumbW: Math.round(THUMB_H * (meta.width || 16) / (meta.height || 9)), meta: { ...meta, offset }, step: 0.5 }) : []),
    [meta, view.h, view.scroll, width, offset]);
  useEffect(() => { if (on && thumbs.ready) thumbs.want(slots.map(s => s.videoT)); }); // vignettes demandées à chaque rendu (file sans doublon)
  if (!on || !meta) return null;

  const audio = meta.audioTrackId ? tracks.find(t => t.id === meta.audioTrackId) : undefined;
  const aClip = audio?.clips.find(c => c.id === meta.audioClipId) || audio?.clips[0];
  const gapMs = aClip ? Math.round((aClip.start - aClip.offset - offset) * 1000) : null;
  // Décale la vidéo ET son son (même étape d'annulation pour le son ; la vidéo suit).
  const moveTo = (next: number) => {
    const n = Math.max(0, next);
    const d = n - meta.offset;
    updateVideoMeta({ offset: n });
    if (aClip && audio && Math.abs(d) > 1e-9 && gapMs === 0) applyTracks(ts => ts.map(t => (t.id === audio.id ? { ...t, clips: t.clips.map(c => (c.id === aClip.id ? { ...c, start: Math.max(0, c.start + d) } : c)) } : t)), 'Vidéo et son déplacés ensemble');
  };
  const x0 = offset * view.h - view.scroll;
  const w = meta.duration * view.h;
  return (
    <section ref={boxRef} aria-label="Vidéo" data-testid="video-lane" data-video-offset={offset} data-sync={gapMs === null ? 'sans-son' : gapMs === 0 ? 'cale' : `decale:${gapMs}`}
      className="relative z-[5] flex shrink-0 border-b-2 border-fuchsia-400/50 bg-nv-panel" style={{ height: LANE_H }}>
      <div className="flex shrink-0 items-center gap-1 border-r border-nv-line px-1.5" style={{ width: view.header }}>
        <i className="fas fa-film ml-1 text-[12px] text-fuchsia-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-bold text-nv-ink" title={meta.name}>{meta.name}</p>
          <p className="truncate text-[10px] text-nv-muted" data-testid="video-lane-pos">
            {gapMs !== null && (gapMs === 0
              ? <i className="fas fa-link mr-1 text-emerald-400" title="Son de la vidéo calé sur l’image" aria-label="Son calé sur l’image" />
              : <i className="fas fa-unlink mr-1 text-amber-300" title={`Son de la vidéo décalé de ${gapMs} ms`} aria-label={`Son décalé de ${gapMs} ms`} />)}
            à {fmtTime(offset)} · {Math.round(meta.duration)} s</p>
        </div>
        <button type="button" onClick={() => moveTo(nudgeOffset(meta.offset, -1, meta.fps))} aria-label="Vidéo une image plus tôt" title="Une image plus tôt" data-testid="video-nudge-left"
          className="nova-hit-tactile h-7 w-6 shrink-0 rounded-md bg-nv-well text-[10px] text-nv-muted hover:text-nv-ink"><i className="fas fa-chevron-left" /></button>
        <button type="button" onClick={() => moveTo(nudgeOffset(meta.offset, 1, meta.fps))} aria-label="Vidéo une image plus tard" title="Une image plus tard" data-testid="video-nudge-right"
          className="nova-hit-tactile h-7 w-6 shrink-0 rounded-md bg-nv-well text-[10px] text-nv-muted hover:text-nv-ink"><i className="fas fa-chevron-right" /></button>
        {gapMs !== null && gapMs !== 0 && aClip && (
          <button type="button" data-testid="video-realign" title="Recaler le son importé sur l'image"
            onClick={() => applyTracks(ts => ts.map(t => (t.id === audio!.id ? { ...t, clips: t.clips.map(c => (c.id === aClip.id ? { ...c, start: offset + c.offset } : c)) } : t)), 'Son recalé sur l’image')}
            className="nova-hit-tactile h-7 shrink-0 rounded-md bg-amber-500/20 px-1.5 text-[10px] font-bold text-amber-200">Recaler</button>
        )}
        <button type="button" onClick={() => toggleVideoViewer()} aria-label="Afficher l'image" title="Afficher / masquer l'image" data-testid="video-viewer-toggle"
          className="nova-hit-tactile h-7 w-7 shrink-0 rounded-md bg-nv-well text-[11px] text-nv-muted hover:text-nv-ink"><i className="fas fa-tv" /></button>
        <button type="button" onClick={() => openVideoExport()} aria-label="Exporter la vidéo avec le mix" title="Exporter la vidéo avec le mix (MP4)" data-testid="video-export-open"
          className="nova-hit-tactile h-7 w-7 shrink-0 rounded-md bg-nv-well text-[11px] text-nv-muted hover:text-nv-ink"><i className="fas fa-file-video" /></button>
        <button type="button" onClick={() => videoBus.emit({ kind: 'remove' })} aria-label="Retirer la vidéo" title="Retirer la vidéo (le son importé reste)" data-testid="video-remove"
          className="nova-hit-tactile h-7 w-7 shrink-0 rounded-md text-[11px] text-nv-muted hover:text-red-400"><i className="fas fa-times" /></button>
      </div>
      <div className="relative min-w-0 flex-1 overflow-hidden bg-black/30">
        <div data-testid="video-strip" title="Glisser pour déplacer la vidéo sur la timeline (Maj : à l'image près)"
          className={`absolute top-1 bottom-1 overflow-hidden rounded-[4px] border border-fuchsia-400/70 bg-fuchsia-500/10 ${drag ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ left: x0, width: Math.max(4, w), touchAction: 'none' }}
          onPointerDown={e => { if (e.button !== 0) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDrag({ x0: e.clientX, off0: meta.offset, off: meta.offset }); }}
          onPointerMove={e => { if (!drag) return; let off = drag.off0 + (e.clientX - drag.x0) / view.h; off = Math.max(0, Math.round(off * meta.fps) / meta.fps); setDrag({ ...drag, off }); }}
          onPointerUp={() => { if (drag) { const off = drag.off; setDrag(null); if (Math.abs(off - meta.offset) > 1e-9) moveTo(off); } }}
          onPointerCancel={() => setDrag(null)}>
          {slots.map(s => {
            const src = thumbs.get(s.videoT);
            return src ? <img key={`${s.x}`} src={src} alt="" draggable={false} className="absolute top-0 h-full select-none" style={{ left: s.x - offset * view.h }} />
              : <span key={`${s.x}`} className="absolute top-0 h-full border-r border-fuchsia-400/20" style={{ left: s.x - offset * view.h, width: 2 }} />;
          })}
        </div>
      </div>
    </section>
  );
};

export default React.memo(VideoTrackLane);
