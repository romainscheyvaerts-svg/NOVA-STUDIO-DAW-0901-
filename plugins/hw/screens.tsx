import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './ecrans.css';

/**
 * Ajouts de la vague 2A au kit « matériel » (gros effets à écran) :
 *  - HwPresetSelect : préréglages en liste déroulante (barre d'outils), quand
 *    ils sont trop nombreux pour des pastilles ;
 *  - useHwCanvas : canvas net (densité de pixels) qui suit la taille de son
 *    cadre ; on ne le redessine que lorsque c'est utile.
 * Les finitions supplémentaires (midnight, violet, sea, carbon) sont dans ecrans.css.
 */

/** Préréglages en liste (barre d'outils) : affiche celui qui correspond aux réglages, sinon « Personnalisé ». */
export function HwPresetSelect<P extends { id: string; name: string; hint?: string; params: Record<string, any> }>({
  presets, current, onApply, label = 'Préréglages',
}: { presets: P[]; current: Record<string, any>; onApply: (p: P) => void; label?: string }) {
  const matches = (pr: P) => Object.entries(pr.params).every(([k, v]) => typeof v === 'number' ? Math.abs((+current[k] || 0) - v) < 1e-6 : current[k] === v);
  const cur = presets.find(matches);
  return (
    <div className="hw-toolbar-row" data-nova-presets>
      <span className="hw-toolbar-label">{label}</span>
      <select className="hw-select" aria-label={label} value={cur ? cur.id : ''} data-nova-preset-select
        onChange={e => { const pr = presets.find(p => p.id === e.target.value); if (pr) onApply(pr); }}>
        <option value="" disabled>Personnalisé</option>
        {presets.map(pr => <option key={pr.id} value={pr.id} title={pr.hint} data-nova-preset={pr.id}>{pr.name}</option>)}
      </select>
    </div>
  );
}

export interface HwCanvasSize { w: number; h: number; dpr: number }

/**
 * Canvas qui suit la taille CSS de son cadre (ResizeObserver) à la densité de
 * l'écran. `size` change seulement quand le cadre change : la façade ne se
 * redessine pas pour autant, seul le composant qui appelle ce crochet.
 */
export function useHwCanvas() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<HwCanvasSize>({ w: 0, h: 0, dpr: 1 });
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      setSize(s => (s.w === w && s.h === h && s.dpr === dpr ? s : { w, h, dpr }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !size.w) return;
    const W = Math.round(size.w * size.dpr), H = Math.round(size.h * size.dpr);
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
  }, [size]);
  return { wrapRef, canvasRef, size };
}

/** Prépare un contexte 2D à l'échelle CSS (1 unité = 1 px CSS). */
export function hwCtx(cv: HTMLCanvasElement | null, size: HwCanvasSize): CanvasRenderingContext2D | null {
  if (!cv || !size.w) return null;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  return ctx;
}

/** Texte de fréquence à la française : « 80 Hz », « 4,5 kHz », « 12 kHz ». */
export const fmtHzFr = (hz: number) => {
  if (!Number.isFinite(hz)) return '—';
  if (hz < 1000) return `${Math.round(hz)} Hz`;
  const k = hz / 1000;
  return `${k.toLocaleString('fr-FR', { maximumFractionDigits: k >= 10 ? 1 : 2 })} kHz`;
};

/** Nombre à la française (« 1,5 »). */
export const frNum = (v: number, d = 1) => (Number.isFinite(v) ? v : 0).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

export default HwPresetSelect;
