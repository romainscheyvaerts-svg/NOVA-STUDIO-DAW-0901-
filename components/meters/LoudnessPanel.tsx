import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { meterBank, meterClock, MASTER_OUT } from '../../engine/meters/meterBank';
import { meterPrefs } from '../../engine/meters/meterPrefs';
import { METER_SCALES } from '../../engine/meters/scales';
import { octaveSmooth, SpectrumHold, freqToX } from '../../engine/meters/spectrum';
import { audioEngine } from '../../engine/AudioEngine';
import { PLATFORM_TARGETS } from '../../utils/masterAssistant';
import { canvasTheme } from '../../utils/canvasTheme';

/**
 * Fenêtre « Loudness » (R11) : ce que mesurent Spotify, YouTube, Apple et
 * TikTok, en direct sur la sortie du master.
 *
 *  - LUFS intégré, court terme (3 s), momentané (400 ms), LRA, crête vraie
 *    (ITU-R BS.1770-4 / EBU R128 : filtre K, portillons −70 LUFS / −10 LU) ;
 *  - écart à la cible de chaque plateforme (cibles du Master Nova) ;
 *  - corrélation de phase, goniomètre, analyseur de spectre (lissage par
 *    octave, maintien des crêtes) ;
 *  - réglages des vumètres : échelle, point de mesure pré / post-fader.
 */

// ---------- Ouverture (boutique minuscule, partagée par le transport et la console) ----------
let open = false;
const subs = new Set<() => void>();
export const loudnessPanel = {
  isOpen: () => open,
  set(v: boolean) { if (v !== open) { open = v; subs.forEach(f => f()); } },
  toggle() { this.set(!open); },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};

const fmt = (v: number, unit = '') => (Number.isFinite(v) && v > -99 ? `${v.toFixed(1).replace('.', ',').replace('-', '−')}${unit}` : '−∞');

/** Bouton compact du transport : LUFS intégré (et momentané), ouvre la fenêtre Loudness. */
export const LufsChip: React.FC<{ className?: string }> = ({ className = '' }) => {
  const iRef = useRef<HTMLSpanElement>(null);
  const mRef = useRef<HTMLSpanElement>(null);
  const isOpen = useSyncExternalStore(loudnessPanel.subscribe, loudnessPanel.isOpen);
  useEffect(() => {
    let li = '', lm = '', last = 0;
    return meterClock.subscribe((now) => {
      if (now - last < 200) return; // 5 fois / s suffit pour des chiffres
      last = now;
      const s = meterBank.loudnessLive(now);
      const i = fmt(s.integrated), m = fmt(s.momentary);
      if (iRef.current && i !== li) { li = i; iRef.current.textContent = i; }
      if (mRef.current && m !== lm) { lm = m; mRef.current.textContent = m; }
    });
  }, []);
  return (
    <button type="button" onClick={() => loudnessPanel.toggle()} aria-pressed={isOpen} data-testid="lufs-chip"
      title="Loudness du master (EBU R128) : LUFS intégré (I) et momentané (M). Clic : fenêtre Loudness (LRA, crête vraie, corrélation, goniomètre, spectre, cibles Spotify / YouTube / Apple / TikTok)"
      aria-label="Ouvrir la fenêtre Loudness"
      className={`h-10 min-w-[58px] shrink-0 whitespace-nowrap px-2 rounded-lg border flex flex-col justify-center items-end leading-none gap-0.5 font-mono tabular-nums ${isOpen ? 'border-cyan-400/60 bg-cyan-500/10' : 'border-white/10 bg-black/50'} ${className}`}>
      <span className="text-[10px] text-slate-200"><span className="text-[8px] text-slate-500 mr-1 font-sans font-bold">I</span><span ref={iRef}>−∞</span></span>
      <span className="text-[9px] text-slate-400"><span className="text-[8px] text-slate-500 mr-1 font-sans font-bold">M</span><span ref={mRef}>−∞</span></span>
    </button>
  );
};

const LUFS_MIN = -40, LUFS_MAX = 0;
const lufsFrac = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, (v - LUFS_MIN) / (LUFS_MAX - LUFS_MIN))) : 0);

const LoudnessPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const numRefs = useRef<Record<string, HTMLElement | null>>({});
  const mBar = useRef<HTMLDivElement>(null);
  const sBar = useRef<HTMLDivElement>(null);
  const corrDot = useRef<HTMLDivElement>(null);
  const corrTxt = useRef<HTMLSpanElement>(null);
  const goni = useRef<HTMLCanvasElement>(null);
  const spec = useRef<HTMLCanvasElement>(null);
  const targetRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const [target, setTarget] = useState<string>(() => { try { return localStorage.getItem('nova_loudness_target') || 'spotify'; } catch { return 'spotify'; } });
  const [fraction, setFraction] = useState(1 / 3);
  const scale = useSyncExternalStore(meterPrefs.subscribe, meterPrefs.scale);
  const [tap, setTap] = useState(meterBank.getTapMode());
  const tgt = PLATFORM_TARGETS.find(t => t.id === target) || PLATFORM_TARGETS[0];

  useEffect(() => { try { localStorage.setItem('nova_loudness_target', target); } catch { /* */ } }, [target]);

  useEffect(() => {
    // Analyseur de spectre : branché sur la sortie finale du master, seulement fenêtre ouverte.
    const src = audioEngine.getMasterMeterInput();
    const actx = audioEngine.getAudioContext();
    let an: AnalyserNode | null = null;
    if (src && actx) { an = actx.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0.55; try { src.connect(an); } catch { an = null; } }
    const bins = an ? new Float32Array(an.frequencyBinCount) : null;
    const smooth = an ? new Float32Array(an.frequencyBinCount) : null;
    const hold = new SpectrumHold(1500, 15);
    let lastT = 0, lastNum = 0;
    const set = (k: string, v: string) => { const el = numRefs.current[k]; if (el && el.textContent !== v) el.textContent = v; };

    const draw = (now: number) => {
      const dt = lastT ? Math.min(0.2, (now - lastT) / 1000) : 1 / 30;
      lastT = now;
      const s = meterBank.loudnessLive(now);
      const v = meterBank.view(MASTER_OUT, now);
      if (now - lastNum > 150) {
        lastNum = now;
        set('I', fmt(s.integrated)); set('S', fmt(s.shortTerm)); set('M', fmt(s.momentary));
        set('LRA', s.integrated > -99 ? s.lra.toFixed(1).replace('.', ',') : '—');
        set('TP', v ? fmt(v.maxTp) : '−∞'); set('MMAX', fmt(s.momentaryMax)); set('SMAX', fmt(s.shortTermMax));
        set('T', `${Math.floor(s.seconds / 60)}:${String(Math.floor(s.seconds % 60)).padStart(2, '0')}`);
        const tpEl = numRefs.current.TP;
        if (tpEl) tpEl.style.color = v && v.maxTp > tgt.ceiling ? '#f87171' : '';
        for (const t of PLATFORM_TARGETS) {
          const el = targetRefs.current[t.id];
          if (!el) continue;
          const d = s.integrated - t.lufs;
          const txt = Number.isFinite(d) ? `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1).replace('.', ',')} LU` : '—';
          if (el.textContent !== txt) el.textContent = txt;
          el.style.color = !Number.isFinite(d) ? '' : Math.abs(d) <= 1 ? '#34d399' : d > 0 ? '#fbbf24' : '#94a3b8';
        }
      }
      if (mBar.current) mBar.current.style.width = `${lufsFrac(s.momentary) * 100}%`;
      if (sBar.current) sBar.current.style.width = `${lufsFrac(s.shortTerm) * 100}%`;
      if (v && corrDot.current) {
        const live = now - v.at < 400;
        const c = live ? v.corr : 0;
        corrDot.current.style.left = `${(c + 1) * 50}%`;
        corrDot.current.style.background = c < 0 ? '#ef4444' : c < 0.3 ? '#fbbf24' : '#34d399';
        if (corrTxt.current) corrTxt.current.textContent = live ? (c >= 0 ? '+' : '−') + Math.abs(c).toFixed(2).replace('.', ',') : '—';
      }
      const cv = canvasTheme();
      // Goniomètre : M en haut, S à l'horizontale ; gain automatique doux.
      const g = goni.current;
      if (g) {
        const gctx = g.getContext('2d');
        const w = g.clientWidth, h = g.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
        if (gctx && w > 0) {
          if (g.width !== Math.round(w * dpr)) { g.width = Math.round(w * dpr); g.height = Math.round(h * dpr); }
          gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          gctx.fillStyle = cv.light ? '#f8fafc' : '#05070a';
          gctx.fillRect(0, 0, w, h);
          gctx.strokeStyle = cv.ink(0.12); gctx.lineWidth = 1;
          gctx.beginPath(); gctx.moveTo(w / 2, 0); gctx.lineTo(w / 2, h); gctx.moveTo(0, h / 2); gctx.lineTo(w, h / 2);
          gctx.moveTo(0, h); gctx.lineTo(w, 0); gctx.moveTo(0, 0); gctx.lineTo(w, h); gctx.stroke();
          gctx.fillStyle = cv.ink(0.4); gctx.font = '600 8px Inter, system-ui, sans-serif';
          gctx.fillText('M', w / 2 + 3, 9); gctx.fillText('L', 4, 9); gctx.fillText('R', w - 9, 9); gctx.fillText('+S', w - 14, h / 2 - 3); gctx.fillText('−S', 3, h / 2 - 3);
          const pts = now - meterBank.gonioAt < 300 ? meterBank.gonio : null;
          if (pts && pts.length) {
            let mx = 1e-4;
            for (let i = 0; i < pts.length; i++) { const a = Math.abs(pts[i]); if (a > mx) mx = a; }
            const k = (Math.min(w, h) / 2 - 4) / Math.max(0.05, mx * 1.414);
            gctx.fillStyle = cv.light ? 'rgba(8,145,178,0.55)' : 'rgba(34,211,238,0.55)';
            for (let i = 0; i + 1 < pts.length; i += 2) {
              const l = pts[i], r = pts[i + 1];
              const x = w / 2 + (r - l) * 0.7071 * k, y = h / 2 - (l + r) * 0.7071 * k;
              gctx.fillRect(x, y, 1.2, 1.2);
            }
          }
        }
      }
      // Spectre (FFT, lissage par fraction d'octave, maintien des crêtes)
      const sp = spec.current;
      if (sp && an && bins && smooth) {
        const sctx = sp.getContext('2d');
        const w = sp.clientWidth, h = sp.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
        if (sctx && w > 0) {
          if (sp.width !== Math.round(w * dpr)) { sp.width = Math.round(w * dpr); sp.height = Math.round(h * dpr); }
          sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          an.getFloatFrequencyData(bins);
          octaveSmooth(bins, actx!.sampleRate, fraction, smooth);
          const held = hold.update(smooth, now, dt);
          const nyq = actx!.sampleRate / 2, n = bins.length;
          const yOf = (d: number) => h - Math.max(0, Math.min(1, (d + 96) / 90)) * h;
          sctx.fillStyle = cv.light ? '#f8fafc' : '#05070a'; sctx.fillRect(0, 0, w, h);
          sctx.strokeStyle = cv.ink(0.1); sctx.fillStyle = cv.ink(0.45); sctx.font = '600 8px Inter, system-ui, sans-serif';
          for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
            const x = freqToX(f) * w; sctx.beginPath(); sctx.moveTo(x, 0); sctx.lineTo(x, h); sctx.stroke();
            sctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, h - 3);
          }
          for (const d of [-12, -24, -36, -48, -60, -72]) { const y = yOf(d); sctx.beginPath(); sctx.moveTo(0, y); sctx.lineTo(w, y); sctx.stroke(); sctx.fillText(String(d), 2, y - 2); }
          const path = (arr: Float32Array) => {
            sctx.beginPath();
            let started = false;
            for (let i = 1; i < n; i++) {
              const f = i * nyq / n;
              if (f < 20) continue;
              const x = freqToX(f) * w, y = yOf(arr[i]);
              if (!started) { sctx.moveTo(x, y); started = true; } else sctx.lineTo(x, y);
              if (f > 20000) break;
            }
          };
          path(smooth);
          sctx.lineTo(w, h); sctx.lineTo(0, h); sctx.closePath();
          sctx.fillStyle = cv.light ? 'rgba(8,145,178,0.25)' : 'rgba(34,211,238,0.22)'; sctx.fill();
          path(smooth); sctx.strokeStyle = cv.light ? '#0891b2' : '#22d3ee'; sctx.lineWidth = 1.2; sctx.stroke();
          path(held); sctx.strokeStyle = cv.light ? 'rgba(15,23,42,0.55)' : 'rgba(255,255,255,0.55)'; sctx.lineWidth = 1; sctx.stroke();
        }
      }
    };
    const unsub = meterClock.subscribe(draw);
    return () => { unsub(); try { if (an && src) src.disconnect(an); } catch { /* */ } };
  }, [fraction, tgt.ceiling]);

  const num = (k: string, label: string, unit: string, big = false, help = '') => (
    <div className="flex flex-col min-w-0" title={help}>
      <span className="text-[9px] font-black uppercase text-slate-500 tracking-wide">{label}</span>
      <span className={`font-mono tabular-nums text-nv-text ${big ? 'text-2xl font-bold' : 'text-base font-semibold'}`}>
        <span ref={el => { numRefs.current[k] = el; }} data-testid={`loud-${k}`}>−∞</span>
        <span className="text-[10px] text-slate-500 ml-1 font-sans">{unit}</span>
      </span>
    </div>
  );

  return (
    <div role="dialog" aria-label="Loudness du master" data-testid="loudness-panel"
      className="fixed z-[150] bottom-2 inset-x-2 sm:inset-x-auto sm:right-4 sm:bottom-24 sm:w-[600px] max-h-[88vh] overflow-y-auto rounded-2xl border border-white/10 bg-nv-surface text-nv-text shadow-2xl p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-3">
        <i className="fas fa-wave-square text-cyan-400 text-sm" aria-hidden />
        <h2 className="text-sm font-black">Loudness du master</h2>
        <span className="text-[10px] text-slate-500 hidden sm:inline">EBU R128 · ITU-R BS.1770-4</span>
        <span className="ml-auto text-[10px] font-mono text-slate-500" title="Durée mesurée depuis la remise à zéro"><span ref={el => { numRefs.current.T = el; }}>0:00</span></span>
        <button type="button" onClick={() => meterBank.resetLoudness()} data-testid="loudness-reset"
          title="Remettre à zéro le LUFS intégré, le LRA, les maxima et la crête vraie (à faire avant de lire le morceau en entier)"
          className="nova-hit-tactile h-7 px-2 rounded-lg bg-white/[0.06] hover:bg-cyan-500/20 text-[11px] font-bold"><i className="fas fa-undo mr-1 text-[9px]" />Remettre à zéro</button>
        <button type="button" onClick={onClose} aria-label="Fermer la fenêtre Loudness" className="nova-hit-tactile w-7 h-7 rounded-lg bg-white/[0.06] hover:bg-white/10"><i className="fas fa-times text-[11px]" /></button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        {num('I', 'Intégré', 'LUFS', true, 'Loudness intégrée sur toute la lecture depuis la remise à zéro (portillons −70 LUFS et −10 LU) : la valeur que mesurent les plateformes')}
        {num('S', 'Court terme', 'LUFS', false, 'Fenêtre glissante de 3 s')}
        {num('M', 'Momentané', 'LUFS', false, 'Fenêtre glissante de 400 ms')}
        {num('TP', 'Crête vraie max', 'dBTP', false, 'Crête vraie (suréchantillonnage ×4) la plus haute : en rouge au-dessus du plafond de la cible')}
        {num('LRA', 'LRA', 'LU', false, 'Plage de loudness (EBU Tech 3342) : écart entre passages doux et forts. Pop / rap ≈ 3 à 6 LU, musique de film 10 LU et plus')}
        {num('SMAX', 'Court terme max', 'LUFS')}
        {num('MMAX', 'Momentané max', 'LUFS')}
      </div>

      <div className="space-y-1.5 mb-3" aria-hidden>
        {[['M', mBar], ['S', sBar]].map(([k, r]) => (
          <div key={k as string} className="flex items-center gap-2">
            <span className="w-3 text-[9px] font-black text-slate-500">{k as string}</span>
            <div className="relative flex-1 h-3 rounded bg-black/40 [[data-theme=light]_&]:bg-slate-200 overflow-hidden">
              <div ref={r as React.RefObject<HTMLDivElement>} className="h-full bg-gradient-to-r from-emerald-500 via-cyan-400 to-amber-400" style={{ width: 0 }} />
              <div className="absolute top-0 bottom-0 w-0.5 bg-white [[data-theme=light]_&]:bg-slate-900" style={{ left: `${lufsFrac(tgt.lufs) * 100}%` }} title={`Cible ${tgt.label} : ${tgt.lufs} LUFS`} />
            </div>
          </div>
        ))}
        <div className="flex justify-between text-[8px] font-mono text-slate-500 pl-5"><span>−40</span><span>−30</span><span>−20</span><span>−10</span><span>0 LUFS</span></div>
      </div>

      <div className="mb-3">
        <div className="text-[9px] font-black uppercase text-slate-500 mb-1">Cibles des plateformes (écart du LUFS intégré)</div>
        <div className="flex flex-wrap gap-1.5">
          {PLATFORM_TARGETS.map(t => (
            <button key={t.id} type="button" onClick={() => setTarget(t.id)} aria-pressed={t.id === target} title={t.hint}
              className={`nova-hit-tactile rounded-lg border px-2 py-1 text-left ${t.id === target ? 'border-cyan-400/60 bg-cyan-500/10' : 'border-white/10 bg-white/[0.03]'}`}>
              <div className="text-[10px] font-bold">{t.label}</div>
              <div className="text-[9px] font-mono text-slate-400">{t.lufs} LUFS · {t.ceiling} dBTP · <span ref={el => { targetRefs.current[t.id] = el; }}>—</span></div>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[150px_1fr] gap-3 mb-3">
        <div>
          <div className="text-[9px] font-black uppercase text-slate-500 mb-1">Goniomètre</div>
          <canvas ref={goni} className="block w-full max-w-[200px] mx-auto sm:max-w-none sm:w-[150px] aspect-square rounded-lg border border-white/10" aria-label="Goniomètre du master" />
          <div className="mt-2 text-[9px] font-black uppercase text-slate-500 flex justify-between"><span>Corrélation</span><span ref={corrTxt} className="font-mono text-slate-300">—</span></div>
          <div className="relative h-3 rounded bg-gradient-to-r from-red-500/40 via-amber-400/30 to-emerald-500/40 mt-1" title="Corrélation de phase : +1 = mono, 0 = très large, négatif = problème de phase (le son disparaît en mono)">
            <div ref={corrDot} className="absolute top-0 bottom-0 w-1.5 -ml-[3px] rounded bg-emerald-400" style={{ left: '50%' }} />
          </div>
          <div className="flex justify-between text-[8px] font-mono text-slate-500"><span>−1</span><span>0</span><span>+1</span></div>
        </div>
        <div className="min-w-0">
          <div className="flex items-center mb-1">
            <span className="text-[9px] font-black uppercase text-slate-500">Spectre</span>
            <div className="ml-auto flex gap-1">
              {[[1 / 3, '1/3 oct'], [1 / 6, '1/6'], [1 / 12, '1/12']].map(([f, l]) => (
                <button key={l as string} type="button" onClick={() => setFraction(f as number)} aria-pressed={fraction === f}
                  className={`h-5 px-1.5 rounded text-[9px] font-bold ${fraction === f ? 'bg-cyan-500/20 text-cyan-300' : 'bg-white/[0.05] text-slate-400'}`}>{l as string}</button>
              ))}
            </div>
          </div>
          <canvas ref={spec} className="w-full h-[150px] sm:h-[188px] rounded-lg border border-white/10" aria-label="Analyseur de spectre du master (trait clair : maintien des crêtes)" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
        <span className="text-[9px] font-black uppercase text-slate-500">Vumètres</span>
        <select value={scale.id} onChange={e => meterPrefs.setScale(e.target.value as any)} aria-label="Échelle des vumètres" title={scale.hint}
          className="h-7 rounded-lg bg-black/40 [[data-theme=light]_&]:bg-white border border-white/10 px-2 text-[11px]">
          {METER_SCALES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <div className="flex rounded-lg overflow-hidden border border-white/10" role="radiogroup" aria-label="Point de mesure des pistes">
          {(['pre', 'post'] as const).map(m => (
            <button key={m} type="button" role="radio" aria-checked={tap === m} onClick={() => { meterBank.setTapMode(m); setTap(m); }}
              title={m === 'pre' ? 'Mesure après les effets, avant le fader (Pro Tools « Pre-Fader Metering »)' : 'Mesure après le fader et le pan'}
              className={`h-7 px-2 text-[11px] font-bold ${tap === m ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400'}`}>{m === 'pre' ? 'Pré-fader' : 'Post-fader'}</button>
          ))}
        </div>
        <button type="button" onClick={() => meterBank.resetClip()} className="h-7 px-2 rounded-lg bg-white/[0.06] text-[11px] font-bold" title="Éteindre toutes les diodes de saturation">Effacer les diodes</button>
      </div>
    </div>
  );
};

/** À monter une fois (App) : la fenêtre s'ouvre depuis le transport ou la console. */
export const LoudnessPanelHost: React.FC = () => {
  const isOpen = useSyncExternalStore(loudnessPanel.subscribe, loudnessPanel.isOpen);
  return isOpen ? <LoudnessPanel onClose={() => loudnessPanel.set(false)} /> : null;
};

export default LoudnessPanel;
