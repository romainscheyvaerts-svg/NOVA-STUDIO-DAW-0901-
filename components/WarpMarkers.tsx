/**
 * R13 · Marqueurs de warp (Pro Tools : Elastic Audio, vue Warp · Logic : Flex
 * Time · Live : Warp markers · FL : Slice / Stretch).
 *
 * La forme d'onde du clip, avec ses attaques détectées (utils/transients) :
 * vertes sur la grille, orange à côté. On tire un marqueur (ou une attaque)
 * pour la caler où on veut : seul le son entre les marqueurs voisins s'étire,
 * la hauteur ne bouge pas. « Quantifier l'audio » cale toutes les attaques
 * sur la grille d'un coup (Elastic Audio Quantize, Flex Time Quantize).
 *
 * Doigt : glisser un marqueur, appui long pour le retirer. Souris : double-clic
 * pour poser un marqueur, clic droit ou Suppr pour le retirer, Maj pour
 * ignorer la grille.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, DAWState, ElasticInfo, Track } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import {
  editingElastic, elasticBlock, elasticLabel, elasticRevertPatch, isNeutralElastic, mapTime, placeMarker, quantizeOnsets, removeMarker, unmapTime,
} from '../utils/clipTranspose';
import { transientsOf } from '../utils/transients';
import { gridLabel, gridStepSeconds } from '../utils/grid';
import { useEditMode } from '../utils/editModes';
import { canvasTheme } from '../utils/canvasTheme';
import { useTheme } from '../utils/themeStore';
import { applyClipPatches, doneMessage, notifyElastic, renderAndApply } from '../services/elasticRender';

interface Props {
  open: boolean;
  trackId?: string;
  clipId?: string;
  tracks: Track[];
  bpm: number;
  setState: (fn: (prev: DAWState) => DAWState) => void;
  onClose: () => void;
}

const has = (id: string) => !!audioBufferRegistry.get(id);
const H = 170;

const WarpMarkers: React.FC<Props> = ({ open, trackId, clipId, tracks, bpm, setState, onClose }) => {
  const track = tracks.find(t => t.id === trackId);
  const clip = track?.clips.find(c => c.id === clipId) as Clip | undefined;
  const base = useMemo(() => (clip ? editingElastic(clip, has) : null), [clip?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const [info, setInfo] = useState<ElasticInfo | null>(null);
  const [strength, setStrength] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [width, setWidth] = useState(640);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; src: number; free: boolean; timer?: number; moved: boolean } | null>(null);
  const em = useEditMode();
  const { theme } = useTheme();

  useEffect(() => { if (open && base) { setInfo(base.info); setError(null); setBusy(null); setSel(null); } }, [open, base]);

  const buffer = base?.bufferId ? audioBufferRegistry.get(base.bufferId) : clip?.buffer;
  // Attaques du son d'origine, dans la partie montrée (s, repère du son d'origine).
  const onsets = useMemo(() => {
    if (!buffer || !info) return [] as number[];
    const a = info.sourceOffset, b = info.sourceOffset + info.sourceDuration;
    return transientsOf(buffer).filter(s => s > a + 0.005 && s < b - 0.005);
  }, [buffer, info?.sourceOffset, info?.sourceDuration]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = gridStepSeconds(em.gridSize, bpm);
  const clipStart = clip?.start || 0;
  const onGrid = (d: number) => Math.abs(((clipStart + d) / step) - Math.round((clipStart + d) / step)) * step < 0.0015;

  // Largeur suivie (fenêtre, rotation de la tablette).
  useEffect(() => {
    if (!open) return;
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(240, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !info || !buffer) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(width * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = `${width}px`; cv.style.height = `${H}px`;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const th = canvasTheme();
    ctx.fillStyle = th.surface; ctx.fillRect(0, 0, width, H);
    const D = info.duration;
    const xOf = (d: number) => (d / D) * width;
    // Grille du projet (calée sur la timeline : le début du clip n'est pas forcément sur un temps).
    const first = Math.ceil(clipStart / step) * step - clipStart;
    for (let g = first, k = 0; g <= D + 1e-9 && k < 4000; g += step, k++) {
      const x = Math.round(xOf(g)) + 0.5;
      const beat = Math.abs(((clipStart + g) / (60 / bpm)) - Math.round((clipStart + g) / (60 / bpm))) < 1e-6;
      ctx.strokeStyle = th.ink(beat ? 0.18 : 0.07);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    // Forme d'onde du son d'origine passée par la fonction du temps (ce qu'on entendra).
    const sr = buffer.sampleRate, n = buffer.length, chs = buffer.numberOfChannels;
    const mid = H / 2 + 8, amp = H / 2 - 20;
    ctx.fillStyle = th.accentFill(0.45);
    ctx.beginPath();
    const tops: number[] = [];
    for (let px = 0; px < width; px++) {
      const s0 = Math.max(0, Math.floor(unmapTime(info, (px / width) * D) * sr));
      const s1 = Math.min(n, Math.max(s0 + 1, Math.floor(unmapTime(info, ((px + 1) / width) * D) * sr)));
      const stride = Math.max(1, Math.floor((s1 - s0) / 600));
      let pk = 0;
      for (let c = 0; c < chs; c++) { const d = buffer.getChannelData(c); for (let i = s0; i < s1; i += stride) { const v = Math.abs(d[i]); if (v > pk) pk = v; } }
      tops.push(Math.min(1, pk));
    }
    ctx.moveTo(0, mid);
    tops.forEach((v, px) => ctx.lineTo(px, mid - v * amp));
    for (let px = width - 1; px >= 0; px--) ctx.lineTo(px, mid + tops[px] * amp);
    ctx.closePath(); ctx.fill();
    // Attaques : vertes sur la grille, orange à côté.
    for (const s of onsets) {
      const d = mapTime(info, s);
      const x = Math.round(xOf(d)) + 0.5;
      ctx.strokeStyle = onGrid(d) ? 'rgba(34,197,94,0.85)' : 'rgba(249,115,22,0.85)';
      ctx.beginPath(); ctx.moveTo(x, 18); ctx.lineTo(x, H); ctx.stroke();
    }
    // Marqueurs : poignée en haut + trait.
    for (const m of info.markers || []) {
      const x = Math.round(xOf(m.dst)) + 0.5;
      const on = m.id === sel;
      ctx.strokeStyle = on ? '#facc15' : '#22d3ee';
      ctx.lineWidth = on ? 2 : 1.5;
      ctx.beginPath(); ctx.moveTo(x, 14); ctx.lineTo(x, H); ctx.stroke();
      ctx.fillStyle = on ? '#facc15' : '#22d3ee';
      ctx.beginPath(); ctx.moveTo(x - 7, 0); ctx.lineTo(x + 7, 0); ctx.lineTo(x, 14); ctx.closePath(); ctx.fill();
      ctx.lineWidth = 1;
    }
  }, [info, buffer, width, onsets, sel, step, clipStart, bpm, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (open) draw(); }, [open, draw]);

  // Suppr / Retour arrière : retire le marqueur choisi.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel && info) { e.preventDefault(); e.stopPropagation(); setInfo(removeMarker(info, sel)); setSel(null); }
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, sel, info, busy, onClose]);

  if (!open || !clip || !info || !base) return null;

  const blocked = elasticBlock(clip);
  const D = info.duration;
  const dOfX = (x: number) => Math.max(0, Math.min(D, (x / width) * D));
  const snap = (d: number, free: boolean) => (free ? d : Math.round((clipStart + d) / step) * step - clipStart);
  const localX = (e: React.PointerEvent | React.MouseEvent) => e.clientX - (canvasRef.current?.getBoundingClientRect().left || 0);

  const hit = (x: number): { kind: 'marker'; id: string; src: number } | { kind: 'onset'; src: number } | null => {
    let best: { kind: 'marker'; id: string; src: number } | null = null, bd = 10;
    for (const m of info.markers || []) { const dx = Math.abs((m.dst / D) * width - x); if (dx < bd) { bd = dx; best = { kind: 'marker', id: m.id, src: m.src }; } }
    if (best) return best;
    let bo: number | null = null; let bo_d = 7;
    for (const s of onsets) { const dx = Math.abs((mapTime(info, s) / D) * width - x); if (dx < bo_d) { bo_d = dx; bo = s; } }
    return bo !== null ? { kind: 'onset', src: bo } : null;
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    const x = localX(e);
    const h = hit(x);
    if (!h) { setSel(null); return; }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    let id: string;
    if (h.kind === 'marker') id = h.id;
    else {
      // Attaque attrapée : un marqueur y naît (sans bouger le son pour l'instant).
      const next = placeMarker(info, h.src, mapTime(info, h.src));
      const m = next.markers?.find(k => Math.abs(k.src - h.src) < 1e-6);
      if (!m) return;
      setInfo(next); id = m.id;
    }
    setSel(id);
    const d = { id, src: h.src, free: e.shiftKey, moved: false, timer: undefined as number | undefined };
    // Appui long au doigt (sans bouger) : retirer le marqueur.
    if (e.pointerType === 'touch') d.timer = window.setTimeout(() => { if (drag.current && !drag.current.moved) { setInfo(cur => (cur ? removeMarker(cur, id) : cur)); setSel(null); drag.current = null; } }, 650);
    drag.current = d;
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.moved = true;
    if (d.timer) { window.clearTimeout(d.timer); d.timer = undefined; }
    const target = snap(dOfX(localX(e)), e.shiftKey || d.free);
    setInfo(cur => (cur ? placeMarker(cur, d.src, target, d.id) : cur));
  };
  const onUp = () => { if (drag.current?.timer) window.clearTimeout(drag.current.timer); drag.current = null; };
  const onDouble = (e: React.MouseEvent) => {
    const x = localX(e);
    const h = hit(x);
    if (h?.kind === 'marker') return;
    const src = h?.src ?? unmapTime(info, dOfX(x));
    const next = placeMarker(info, src, mapTime(info, src));
    setInfo(next);
    setSel(next.markers?.find(k => Math.abs(k.src - src) < 1e-6)?.id || null);
  };
  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const h = hit(localX(e));
    if (h?.kind === 'marker') { setInfo(removeMarker(info, h.id)); setSel(null); }
  };

  const quantize = () => {
    setInfo(quantizeOnsets({ ...info, markers: undefined }, onsets, clipStart, step, strength));
    setSel(null);
  };
  const offGrid = onsets.filter(s => !onGrid(mapTime(info, s))).length;

  const apply = async () => {
    setError(null);
    try {
      const n = await renderAndApply(tracks, [{ trackId: trackId!, clipId: clipId!, info }], setState, m => setBusy(m));
      notifyElastic(n ? doneMessage(info) : 'Rien à changer.');
      onClose();
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(null); }
  };
  const revert = () => {
    const p = elasticRevertPatch(clip, has);
    if (!p) return;
    applyClipPatches(setState, [{ trackId: trackId!, clipId: clipId!, patch: p }]);
    notifyElastic("↩️ Clip revenu à l'original. Ctrl+Z pour retrouver le warp.");
    onClose();
  };
  const btn = 'min-h-[36px] [@media(pointer:coarse)]:min-h-[44px] rounded-xl border border-nv-line px-3 text-[12px] font-bold hover:bg-nv-accent/10 disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Marqueurs de warp" data-testid="warp-dialog" onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-4xl max-h-[94vh] overflow-y-auto space-y-3 rounded-t-2xl sm:rounded-2xl border border-nv-line bg-nv-panel p-4 text-nv-ink shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-black">Marqueurs de warp · « {clip.elastic?.sourceName || clip.name} »</h2>
            <p className="text-[11px] text-nv-muted" title="Pro Tools : Elastic Audio (vue Warp, Quantize) · Logic : Flex Time · Live : Warp markers · FL : Slice / Stretch">
              Tire une attaque (trait orange) ou un marqueur (triangle) pour la caler : seul le son entre les marqueurs voisins s'étire, la hauteur ne bouge pas.
              <span className="[@media(pointer:coarse)]:hidden"> Double-clic : poser un marqueur · clic droit ou Suppr : le retirer · Maj : sans grille.</span>
              <span className="hidden [@media(pointer:coarse)]:inline"> Appui long sur un marqueur : le retirer.</span>
            </p>
          </div>
          <button type="button" disabled={!!busy} onClick={onClose} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10"><i className="fas fa-times" /></button>
        </div>

        <div ref={boxRef} className="w-full overflow-hidden rounded-xl border border-nv-line">
          <canvas ref={canvasRef} data-testid="warp-canvas" style={{ touchAction: 'none', display: 'block' }}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={onDouble} onContextMenu={onContext} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-nv-muted" data-testid="warp-status">
          <span><span className="inline-block h-2 w-2 rounded-full bg-green-500 mr-1" />attaques sur la grille : {onsets.length - offGrid}</span>
          <span><span className="inline-block h-2 w-2 rounded-full bg-orange-500 mr-1" />à côté : {offGrid}</span>
          <span>grille : {gridLabel(em.gridSize)}</span>
          <span>marqueurs : {info.markers?.length || 0}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={quantize} disabled={!onsets.length} className={btn} data-testid="warp-quantize"
            title="Cale toutes les attaques sur la grille du projet, sans changer la hauteur (Pro Tools : Elastic Audio Quantize · Logic : Flex Time + Quantize · Live : Quantize des warp markers)">
            <i className="fas fa-magnet mr-1.5" />Quantifier l'audio
          </button>
          <label className="flex items-center gap-1 text-[12px]" title="Force du calage : 100 % = pile sur la grille ; 50 % = à mi-chemin (garde du groove)">
            Force
            <select value={strength} onChange={e => setStrength(Number(e.target.value))} aria-label="Force du calage" className="rounded-lg border border-nv-line bg-nv-well px-2 py-1 text-[12px] text-nv-ink">
              {[1, 0.75, 0.5, 0.25].map(v => <option key={v} value={v}>{Math.round(v * 100)} %</option>)}
            </select>
          </label>
          <button type="button" onClick={() => { setInfo({ ...info, markers: undefined }); setSel(null); }} disabled={!info.markers?.length} className={btn} data-testid="warp-clear">
            <i className="fas fa-eraser mr-1.5" />Effacer les marqueurs
          </button>
        </div>

        <p className="text-[11px] text-nv-muted">Résultat : {isNeutralElastic(info) ? 'son d’origine' : elasticLabel(info)}</p>
        {blocked && <p role="alert" className="rounded-lg bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-500">{blocked}</p>}
        {busy && <p role="status" className="text-[12px] text-nv-muted"><i className="fas fa-circle-notch animate-spin mr-2" />{busy}</p>}
        {error && <p role="alert" className="rounded-lg bg-red-500/10 px-2 py-1.5 text-[12px] text-red-400">{error}</p>}

        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!!busy || !!blocked} onClick={() => void apply()} data-testid="warp-apply"
            className="min-h-[40px] [@media(pointer:coarse)]:min-h-[48px] flex-1 rounded-xl bg-cyan-500 px-4 text-[13px] font-bold text-black hover:bg-cyan-400 disabled:opacity-40">
            <i className="fas fa-check mr-2" />Appliquer
          </button>
          {!!clip.elastic && base.fromOriginal && (
            <button type="button" disabled={!!busy} onClick={revert} className={btn} data-testid="warp-revert"><i className="fas fa-rotate-left mr-2" />Revenir à l'original</button>
          )}
        </div>
      </div>
    </div>
  );
};

export default WarpMarkers;
