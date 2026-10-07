import React, { useEffect, useRef } from 'react';
import { audioEngine } from '../engine/AudioEngine';
import { playheadStore } from '../utils/playheadStore';

/**
 * Vumètre master « pro » : crête et RMS en dBFS par canal, maintien de crête
 * (1,5 s), diode CLIP qui reste allumée jusqu'au clic, graduations
 * -18 / -12 / -6 / -3 / 0.
 *
 * Coût : UNE seule boucle requestAnimationFrame pour tous les vumètres master
 * affichés (transport + console), arrêtée quand aucun n'est monté. Les canvas
 * et le texte sont écrits directement : aucun rendu React pendant la lecture.
 */

const FLOOR_DB = -60;
const MARKS = [-18, -12, -6, -3, 0];
const HOLD_MS = 1500;
const PEAK_FALL_DB_S = 24;   // retombée de la crête affichée
const RMS_TAU_S = 0.3;       // intégration RMS ≈ 300 ms (VU / console)

/** Échelle non linéaire : -60…-18 sur 40 % de la course, -18…0 sur 60 %. */
export const dbToFrac = (db: number): number => {
  if (!(db > FLOOR_DB)) return 0;
  if (db >= 0) return 1;
  return db <= -18 ? 0.4 * (db - FLOOR_DB) / (-18 - FLOOR_DB) : 0.4 + 0.6 * (db + 18) / 18;
};

const lin2db = (x: number) => 20 * Math.log10(Math.max(x, 1e-6));

interface Levels { peak: [number, number]; rms: [number, number]; hold: [number, number]; clip: boolean; }

// ---------- Échantillonneur partagé (une seule boucle) ----------
const levels: Levels = { peak: [-90, -90], rms: [-90, -90], hold: [-90, -90], clip: false };
const holdAt = [0, 0];
// Moment (position du morceau) de la première saturation : dit OÙ ça a saturé (G10).
let clipAt = 0;
const fmtPos = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const msq = [0, 0];
const listeners = new Set<() => void>();
let raf = 0;
let lastT = 0;
let buf: Float32Array | null = null;

const sample = (an: AnalyserNode | null, ch: 0 | 1, now: number, dt: number) => {
  let pk = 0, sum = 0, n = 1;
  if (an) {
    if (!buf || buf.length !== an.fftSize) buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    n = buf.length;
    for (let i = 0; i < n; i++) { const x = buf[i]; sum += x * x; const a = x < 0 ? -x : x; if (a > pk) pk = a; }
  }
  // RMS intégré (constante de temps ~300 ms), crête instantanée avec retombée
  const a = 1 - Math.exp(-dt / RMS_TAU_S);
  msq[ch] += a * (sum / n - msq[ch]);
  levels.rms[ch] = lin2db(Math.sqrt(msq[ch]));
  const pkDb = lin2db(pk);
  levels.peak[ch] = Math.max(pkDb, levels.peak[ch] - PEAK_FALL_DB_S * dt);
  if (pkDb >= levels.hold[ch] || now - holdAt[ch] > HOLD_MS) { levels.hold[ch] = pkDb; holdAt[ch] = now; }
  if (pk >= 0.99995) { if (!levels.clip) clipAt = playheadStore.get(); levels.clip = true; } // ≥ 0 dBFS : vraie saturation
};

const tick = (now: number) => {
  raf = requestAnimationFrame(tick);
  const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 1 / 60;
  lastT = now;
  sample(audioEngine.masterAnalyzerL, 0, now, dt);
  sample(audioEngine.masterAnalyzerR, 1, now, dt);
  listeners.forEach(l => l());
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  if (!raf) { lastT = 0; raf = requestAnimationFrame(tick); }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && raf) { cancelAnimationFrame(raf); raf = 0; }
  };
};

const resetClip = () => {
  levels.clip = false;
  levels.hold = [-90, -90];
  listeners.forEach(l => l());
};

const fmtDb = (db: number) => (db <= FLOOR_DB ? '-∞' : (db > 0 ? '+' : '') + db.toFixed(1));

// ---------- Composant ----------
interface Props {
  /** 'horizontal' : version compacte du transport ; 'vertical' : tranche master de la console. */
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}

const ProMasterMeter: React.FC<Props> = ({ orientation = 'horizontal', className = '' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const clipRef = useRef<HTMLButtonElement>(null);
  const vertical = orientation === 'vertical';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let W = 0, H = 0, dpr = 1;
    let grad: CanvasGradient | null = null;
    let lastKey = '';
    let lastText = '';
    let lastClip: boolean | null = null;
    let lastTextAt = 0;

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(canvas.clientWidth));
      const h = Math.max(1, Math.round(canvas.clientHeight));
      if (w === W && h === H) return;
      W = w; H = h;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      grad = vertical ? ctx.createLinearGradient(0, H, 0, 0) : ctx.createLinearGradient(0, 0, W, 0);
      // vert < -12, ambre -12…-3, rouge > -3
      const f12 = dbToFrac(-12), f3 = dbToFrac(-3);
      grad.addColorStop(0, '#10b981'); grad.addColorStop(f12 - 0.001, '#10b981');
      grad.addColorStop(f12, '#fbbf24'); grad.addColorStop(f3 - 0.001, '#fbbf24');
      grad.addColorStop(f3, '#ef4444'); grad.addColorStop(1, '#ef4444');
      lastKey = '';
    };

    const draw = () => {
      if (!W) resize();
      const { peak, rms, hold, clip } = levels;
      const key = `${peak[0].toFixed(1)}|${peak[1].toFixed(1)}|${rms[0].toFixed(1)}|${rms[1].toFixed(1)}|${hold[0].toFixed(1)}|${hold[1].toFixed(1)}`;
      if (key !== lastKey) {
        lastKey = key;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        // Zone des barres (laisse la place aux graduations)
        const labelSpace = vertical ? 14 : 8;
        const len = vertical ? H - 4 : W - 2;
        const thick = vertical ? Math.max(3, Math.floor((W - labelSpace - 3) / 2)) : Math.max(3, Math.floor((H - labelSpace - 3) / 2));
        for (let ch = 0; ch < 2; ch++) {
          const off = 1 + ch * (thick + 1);
          // fond
          ctx.fillStyle = '#0b0d10';
          if (vertical) ctx.fillRect(off, 2, thick, len); else ctx.fillRect(1, off, len, thick);
          const fp = dbToFrac(peak[ch]) * len;
          const fr = dbToFrac(rms[ch]) * len;
          const fh = dbToFrac(hold[ch]) * len;
          ctx.fillStyle = grad!;
          // crête (translucide) puis RMS (plein)
          ctx.globalAlpha = 0.45;
          if (vertical) ctx.fillRect(off, 2 + len - fp, thick, fp); else ctx.fillRect(1, off, fp, thick);
          ctx.globalAlpha = 1;
          if (vertical) ctx.fillRect(off, 2 + len - fr, thick, fr); else ctx.fillRect(1, off, fr, thick);
          // maintien de crête
          if (hold[ch] > FLOOR_DB) {
            ctx.fillStyle = hold[ch] >= -0.05 ? '#ef4444' : '#ffffff';
            if (vertical) ctx.fillRect(off, 2 + len - fh - 1, thick, 2); else ctx.fillRect(1 + Math.min(len - 2, fh), off, 2, thick);
          }
        }
        // graduations
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = `600 ${vertical ? 8 : 7}px Inter, system-ui, sans-serif`;
        ctx.textBaseline = vertical ? 'middle' : 'top';
        ctx.textAlign = vertical ? 'left' : 'center';
        const barsEnd = 1 + 2 * (thick + 1);
        for (const m of MARKS) {
          const f = dbToFrac(m) * len;
          ctx.fillStyle = 'rgba(255,255,255,0.28)';
          if (vertical) ctx.fillRect(0, 2 + len - f, barsEnd, 1); else ctx.fillRect(1 + f - (m === 0 ? 1 : 0), 0, 1, barsEnd);
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          // Course courte (transport compact) : pas d'étiquette -3, collée à 0
          if (m === -3 && len < 110) continue;
          const label = m === 0 ? '0' : String(-m);
          if (vertical) ctx.fillText(label, barsEnd + 2, Math.max(5, 2 + len - f));
          else ctx.fillText(label, Math.min(W - 4, Math.max(4, 1 + f)), barsEnd + 1);
        }
      }
      // Lecture numérique : crête maintenue max des deux canaux, ~10 fois / s
      const now = performance.now();
      if (readoutRef.current && now - lastTextAt > 100) {
        lastTextAt = now;
        const txt = fmtDb(Math.max(hold[0], hold[1]));
        if (txt !== lastText) { readoutRef.current.textContent = txt; lastText = txt; }
      }
      if (clipRef.current && clip !== lastClip) {
        lastClip = clip;
        const b = clipRef.current;
        b.dataset.clip = clip ? '1' : '0';
        b.className = clip ? clipOn : clipOff;
        b.setAttribute('aria-label', clip ? 'Saturation du master détectée. Cliquer pour effacer' : 'Pas de saturation du master');
        b.title = clip ? `Le son a saturé à ${fmtPos(clipAt)} (au-dessus de 0 dB) : baisse le volume du beat ou de la voix, ou le gain d'entrée du micro. Clic pour effacer.` : 'Témoin de saturation du master : il s’allume si le son dépasse 0 dB et reste allumé jusqu’au clic';
      }
    };

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { resize(); draw(); }) : null;
    ro?.observe(canvas);
    resize(); draw();
    const unsub = subscribe(draw);
    return () => { unsub(); ro?.disconnect(); };
  }, [vertical]);

  const clipBase = vertical ? 'w-full h-6 rounded text-[9px] font-black' : 'h-5 px-1 rounded text-[8px] font-black';
  const clipOff = `${clipBase} bg-white/5 text-slate-600 border border-white/10`;
  const clipOn = `${clipBase} bg-red-600 text-white border border-red-400`;

  const clipButton = (
    <button ref={clipRef} type="button" onClick={(e) => { e.stopPropagation(); resetClip(); }} className={clipOff}
      title="Diode de saturation du master (reste allumée jusqu’au clic)" aria-label="Pas de saturation du master">CLIP</button>
  );

  if (vertical) {
    return (
      <div className={`flex flex-col items-center gap-1 h-full ${className}`} data-nova-target="master-meter" title="Master : crête (clair) et RMS (plein) en dBFS">
        {clipButton}
        <canvas ref={canvasRef} className="flex-1 w-[38px] min-h-0" />
        <span ref={readoutRef} className="text-[9px] font-mono tabular-nums text-slate-300">-∞</span>
      </div>
    );
  }
  return (
    <div className={`flex items-center gap-1.5 h-10 px-1.5 rounded-lg bg-black/50 border border-white/10 ${className}`} data-nova-target="master-meter"
      title="Master L/R : crête (clair) et RMS (plein) en dBFS, maintien de crête 1,5 s">
      <canvas ref={canvasRef} className="w-[84px] 2xl:w-[140px] h-[24px]" />
      <div className="flex flex-col items-end leading-none gap-0.5">
        <span ref={readoutRef} className="w-8 text-right text-[9px] font-mono tabular-nums text-slate-300">-∞</span>
        {clipButton}
      </div>
    </div>
  );
};

export default ProMasterMeter;
