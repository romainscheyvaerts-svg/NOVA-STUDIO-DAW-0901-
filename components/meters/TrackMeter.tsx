import React, { useEffect, useRef, useState } from 'react';
import { meterBank, meterClock, MeterView, HOLD_MS } from '../../engine/meters/meterBank';
import { meterPrefs } from '../../engine/meters/meterPrefs';
import { MeterScale, scaleFrac, scaleReading, METER_SCALES } from '../../engine/meters/scales';
import { audioEngine } from '../../engine/AudioEngine';
import { canvasTheme } from '../../utils/canvasTheme';
import { playheadStore } from '../../utils/playheadStore';

/**
 * Vumètre stéréo d'un point de mesure (R11) : piste, bus ou master.
 *
 *  - gauche et droite séparés (vraies mesures AudioWorklet, pas le spectre) ;
 *  - échelle au choix (clic droit : Sample Peak, dBFS, VU, K-20/14/12) ;
 *  - trait de maintien (crête vraie, 2,5 s) ;
 *  - diode de saturation qui reste allumée jusqu'au clic : rouge = saturation
 *    (≥ 0 dBFS), orange = dépassement inter-échantillons seulement (> 0 dBTP) ;
 *  - colonne de réduction de gain (compresseur, de-esser, limiteur) à droite,
 *    du haut vers le bas, comme Pro Tools.
 *
 * Dessin : boucle partagée à 30 images/s (meterClock), canvas redessiné
 * seulement quand une valeur affichée change, aucun rendu React en lecture.
 */

meterBank.positionOf = () => playheadStore.get();

const GR_RANGE_DB = 20;
const fmtPos = (s: number | null) => (s == null ? '' : ` à ${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
const fmtDb = (d: number) => (d > -120 ? `${d > 0 ? '+' : ''}${d.toFixed(1).replace('.', ',')}` : '−∞').replace('-', '−');

/** Couleur d'un niveau selon les zones de l'échelle. */
const zoneColor = (s: MeterScale, db: number) => (db >= s.redDb ? '#ef4444' : db >= s.amberDb ? '#fbbf24' : '#10b981');

export interface DrawOpts { vertical: boolean; marks: boolean; gr: number | null; light: boolean }

/** Dessine les deux barres (et la colonne GR) ; renvoie rien. */
export function drawStereoMeter(ctx: CanvasRenderingContext2D, W: number, H: number, v: MeterView | null, s: MeterScale, o: DrawOpts) {
  const cv = canvasTheme();
  ctx.clearRect(0, 0, W, H);
  const grW = o.gr !== null ? (o.vertical ? Math.max(2, Math.round(W * 0.18)) : Math.max(2, Math.round(H * 0.18))) : 0;
  const labelW = o.marks ? (o.vertical ? 14 : 9) : 0;
  const across = (o.vertical ? W : H) - grW - labelW - (grW ? 1 : 0);
  const len = o.vertical ? H : W;
  const thick = Math.max(1, Math.floor((across - 1) / 2));
  const bg = o.light ? 'rgba(15, 23, 42, 0.10)' : '#0b0d10';
  const bar = (ch: number, from: number, to: number, color: string, alpha = 1) => {
    if (to <= from) return;
    ctx.globalAlpha = alpha; ctx.fillStyle = color;
    const off = ch * (thick + 1);
    if (o.vertical) ctx.fillRect(off, len - to, thick, to - from); else ctx.fillRect(from, off, to - from, thick);
    ctx.globalAlpha = 1;
  };
  const zones: [number, number, string][] = [[s.floorDb, s.amberDb, '#10b981'], [s.amberDb, s.redDb, '#fbbf24'], [s.redDb, 99, '#ef4444']];
  for (let ch = 0; ch < 2; ch++) {
    bar(ch, 0, len, bg);
    if (!v) continue;
    const main = s.ballistics === 'peak' ? v.peak[ch] : v.rms[ch];
    const fm = scaleFrac(s, main) * len;
    // barre principale découpée par zones (vert / ambre / rouge)
    for (const [a, b, c] of zones) {
      const fa = scaleFrac(s, a) * len, fb = Math.min(fm, scaleFrac(s, b) * len);
      bar(ch, fa, fb, c);
    }
    if (s.ballistics === 'peak') {
      // RMS à l'intérieur, plus sombre
      const fr = scaleFrac(s, v.rms[ch]) * len;
      bar(ch, 0, Math.min(fr, fm), o.light ? 'rgba(15,23,42,0.35)' : 'rgba(0,0,0,0.38)');
    } else {
      // crête : trait fin au-dessus du RMS
      const fp = scaleFrac(s, v.peak[ch]) * len;
      if (fp > 1) bar(ch, fp - 1, fp + 1, zoneColor(s, v.peak[ch]), 0.9);
    }
    const fh = scaleFrac(s, v.hold[ch]) * len;
    if (fh > 1) bar(ch, Math.max(0, fh - 2), fh, v.hold[ch] >= 0 ? '#ef4444' : cv.ink(0.95));
  }
  // graduations
  if (o.marks) {
    const x0 = 2 * (thick + 1);
    ctx.font = '600 7px Inter, system-ui, sans-serif';
    ctx.textBaseline = o.vertical ? 'middle' : 'top';
    ctx.textAlign = o.vertical ? 'left' : 'center';
    let lastPos = -99;
    for (const m of s.marks) {
      const f = scaleFrac(s, m.db) * len;
      ctx.fillStyle = cv.ink(o.light ? 0.25 : 0.3);
      if (o.vertical) ctx.fillRect(0, Math.round(len - f), x0, 1); else ctx.fillRect(Math.round(f), 0, 1, x0);
      if (Math.abs(f - lastPos) < 9) continue;
      lastPos = f;
      ctx.fillStyle = cv.ink(o.light ? 0.7 : 0.55);
      if (o.vertical) ctx.fillText(m.label, x0 + 1, Math.max(4, Math.min(len - 4, len - f)));
      else ctx.fillText(m.label, Math.max(4, Math.min(len - 4, f)), x0 + 1);
    }
  }
  // colonne de réduction de gain (orange, du haut vers le bas)
  if (grW) {
    const off = (o.vertical ? W : H) - grW;
    ctx.fillStyle = o.light ? 'rgba(15, 23, 42, 0.08)' : '#15100a';
    if (o.vertical) ctx.fillRect(off, 0, grW, len); else ctx.fillRect(0, off, len, grW);
    const g = Math.min(1, (o.gr || 0) / GR_RANGE_DB) * len;
    if (g > 0.5) {
      ctx.fillStyle = '#f59e0b';
      if (o.vertical) ctx.fillRect(off, 0, grW, g); else ctx.fillRect(len - g, off, g, grW);
    }
  }
}

/** Petit menu (clic droit sur un vumètre) : échelle, pré / post-fader, effacer les diodes. */
export const MeterMenu: React.FC<{ x: number; y: number; onClose: () => void }> = ({ x, y, onClose }) => {
  const s = meterPrefs.scale();
  const mode = meterBank.getTapMode();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', off, true); window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', off, true); window.removeEventListener('keydown', esc); };
  }, [onClose]);
  const left = Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 400) - 228);
  const top = Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : 600) - 330);
  const item = 'w-full text-left px-3 py-1.5 [@media(pointer:coarse)]:py-2.5 rounded text-[11px] hover:bg-cyan-500/15 flex items-center gap-2';
  return (
    <div ref={ref} role="menu" aria-label="Réglages des vumètres" data-testid="meter-menu"
      className="fixed z-[200] w-56 rounded-xl border border-white/10 bg-nv-surface shadow-2xl p-1.5 text-nv-text" style={{ left: Math.max(8, left), top: Math.max(8, top) }}>
      <div className="px-3 pt-1 pb-0.5 text-[9px] font-black uppercase text-slate-500">Échelle des vumètres</div>
      {METER_SCALES.map(sc => (
        <button key={sc.id} type="button" role="menuitemradio" aria-checked={sc.id === s.id} title={sc.hint} className={item}
          onClick={() => { meterPrefs.setScale(sc.id); onClose(); }}>
          <i className={`fas fa-check text-[9px] ${sc.id === s.id ? 'text-cyan-400' : 'opacity-0'}`} />{sc.label}
          <span className="ml-auto text-[9px] text-slate-500">{sc.ballistics === 'rms' ? 'RMS' : 'crête'}</span>
        </button>
      ))}
      <div className="px-3 pt-2 pb-0.5 text-[9px] font-black uppercase text-slate-500">Point de mesure</div>
      {(['pre', 'post'] as const).map(m => (
        <button key={m} type="button" role="menuitemradio" aria-checked={mode === m} className={item}
          title={m === 'pre' ? 'Mesure après les effets, avant le fader : le niveau qui entre dans la tranche (Pro Tools « Pre-Fader Metering »)' : 'Mesure après le fader et le pan : ce que la piste envoie au mix'}
          onClick={() => { meterBank.setTapMode(m); onClose(); }}>
          <i className={`fas fa-check text-[9px] ${mode === m ? 'text-cyan-400' : 'opacity-0'}`} />{m === 'pre' ? 'Pré-fader' : 'Post-fader'}
        </button>
      ))}
      <div className="my-1 border-t border-white/10" />
      <button type="button" className={item} onClick={() => { meterBank.resetClip(); onClose(); }}>
        <i className="fas fa-eraser text-[9px] text-slate-400" />Effacer toutes les diodes de saturation
      </button>
    </div>
  );
};

interface Props {
  /** Piste (son id), ou MASTER_OUT pour la sortie finale. */
  pointId: string;
  /** Piste dont on affiche la réduction de gain (sinon aucune colonne GR). */
  grTrackId?: string;
  orientation?: 'vertical' | 'horizontal';
  /** Diode de saturation cliquable au-dessus (vertical) / à droite. */
  showClip?: boolean;
  /** Valeur numérique (crête vraie max) sous le mètre. */
  showReadout?: boolean;
  /** Graduations (si la place le permet). */
  marks?: boolean;
  /** Zone de 40 px au doigt autour de la diode (faux dans l'en-tête de piste : elle recouvrait le bouton R). */
  clipHit?: boolean;
  className?: string;
  label?: string;
  /** Valeur de réduction de gain écrite sous le mètre (sinon la colonne seule). */
  grText?: boolean;
}

const TrackMeter: React.FC<Props> = ({ pointId, grTrackId, orientation = 'vertical', showClip = true, showReadout = false, marks = true, className = '', label, grText = true, clipHit = true }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clipRef = useRef<HTMLButtonElement>(null);
  const readRef = useRef<HTMLButtonElement>(null);
  const grRef = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const vertical = orientation === 'vertical';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let W = 0, H = 0, dpr = 1, lastKey = '', lastClip = -1, lastRead = '', lastGr = '';
    // Taille lue dans le ResizeObserver (une seule mise en page pour tous les mètres). Avant,
    // chaque mètre lisait clientWidth à son montage puis redimensionnait son canvas : 45 mises en
    // page forcées à l'ouverture de la console de 40 pistes (≈ 270 ms bloquées).
    const resize = (w0?: number, h0?: number) => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(w0 ?? canvas.clientWidth)), h = Math.max(1, Math.round(h0 ?? canvas.clientHeight));
      if (w === W && h === H) return false;
      W = w; H = h; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); lastKey = '';
      return true;
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(entries => {
      const r = entries[entries.length - 1].contentRect;
      if (resize(r.width, r.height)) frame(performance.now());
    }) : null;
    const frame = (now: number) => {
      if (!W) { if (ro) return; resize(); }
      const v = meterBank.view(pointId, now);
      const s = meterPrefs.scale();
      const gr = grTrackId ? audioEngine.getTrackGainReduction(grTrackId) : null;
      const light = canvasTheme().light;
      const key = v ? `${s.id}|${light ? 1 : 0}|${v.peak[0].toFixed(1)}|${v.peak[1].toFixed(1)}|${v.rms[0].toFixed(1)}|${v.rms[1].toFixed(1)}|${v.hold[0].toFixed(1)}|${v.hold[1].toFixed(1)}|${gr ? gr.db.toFixed(1) : '-'}|${W}x${H}` : `none|${s.id}|${light}|${W}x${H}`;
      if (key !== lastKey) {
        lastKey = key;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawStereoMeter(ctx, W, H, v, s, { vertical, marks: marks && (vertical ? W >= 26 : H >= 18), gr: gr ? gr.db : null, light });
      }
      const clip = v ? v.clip : 0;
      if (clipRef.current && clip !== lastClip) {
        lastClip = clip;
        const b = clipRef.current;
        b.dataset.clip = String(clip);
        b.style.background = clip === 2 ? '#dc2626' : clip === 1 ? '#f97316' : '';
        b.style.color = clip ? '#fff' : '';
        b.title = clip === 2 ? `Saturation (≥ 0 dBFS)${fmtPos(v!.clipAt)} : baisse le gain avant ce point. Clic pour effacer.`
          : clip === 1 ? `Crête inter-échantillons au-dessus de 0 dBTP${fmtPos(v!.clipAt)} : saturera après conversion ou en MP3. Clic pour effacer.`
          : 'Diode de saturation : reste allumée jusqu’au clic (rouge = ≥ 0 dBFS, orange = crête vraie > 0 dBTP)';
        b.setAttribute('aria-label', clip ? 'Saturation détectée, cliquer pour effacer' : 'Pas de saturation');
      }
      if (readRef.current) {
        const t = v ? fmtDb(v.maxTp) : '−∞';
        if (t !== lastRead) { lastRead = t; readRef.current.textContent = t; }
      }
      if (grRef.current) {
        const g = gr && gr.db >= 0.05 ? `−${gr.db.toFixed(1).replace('.', ',')}` : '';
        if (g !== lastGr) { lastGr = g; grRef.current.textContent = g; grRef.current.title = gr ? `Réduction de gain : ${gr.db.toFixed(1).replace('.', ',')} dB` : ''; }
      }
    };
    ro?.observe(canvas);
    if (!ro) { resize(); frame(performance.now()); }
    const unsub = meterClock.subscribe(frame);
    const unsubPrefs = meterPrefs.subscribe(() => { lastKey = ''; frame(performance.now()); });
    return () => { unsub(); unsubPrefs(); ro?.disconnect(); };
  }, [pointId, grTrackId, vertical, marks]);

  const onMenu = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); };
  const reset = (e: React.SyntheticEvent) => { e.stopPropagation(); meterBank.resetClip(pointId); };
  const s = meterPrefs.scale();
  const help = `${label ? label + ' : ' : ''}gauche / droite, échelle ${s.label}${grTrackId ? ', réduction de gain en orange à droite' : ''}. Clic droit : échelle, pré / post-fader.`;

  if (vertical) {
    return (
      <div className={`relative flex flex-col items-stretch gap-0.5 h-full min-h-0 ${className}`} data-meter={pointId} onContextMenu={onMenu} title={help}>
        {showClip && <button ref={clipRef} type="button" onClick={reset} data-testid={`meter-clip-${pointId}`}
          className={`h-2.5 shrink-0 rounded-sm bg-white/10 [[data-theme=light]_&]:bg-slate-300/60 ${clipHit ? 'nova-hit-tactile' : ''}`} aria-label="Pas de saturation" />}
        <canvas ref={canvasRef} className="flex-1 min-h-0 w-full" />
        {grTrackId && grText && <span ref={grRef} className="h-3 shrink-0 text-center text-[8px] font-mono tabular-nums text-amber-400 leading-3" />}
        {showReadout && <button ref={readRef} type="button" onClick={reset} title="Crête vraie la plus haute (dBTP) : clic pour remettre à zéro"
          className="h-3.5 shrink-0 text-center text-[8px] font-mono tabular-nums text-slate-300 leading-3 hover:text-white">−∞</button>}
        {menu && <MeterMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      </div>
    );
  }
  return (
    <div className={`relative flex items-center gap-0.5 ${className}`} data-meter={pointId} onContextMenu={onMenu} title={help}>
      <canvas ref={canvasRef} className="flex-1 h-full min-w-0" />
      {showClip && <button ref={clipRef} type="button" onClick={reset} data-testid={`meter-clip-${pointId}`}
        className="w-2 h-full shrink-0 rounded-sm bg-white/10 [[data-theme=light]_&]:bg-slate-300/60" aria-label="Pas de saturation" />}
      {menu && <MeterMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
};

export default TrackMeter;
export { HOLD_MS, scaleReading };
