import React, { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../engine/AudioEngine';

/**
 * Vumètre d'entrée de la piste armée, façon console : crête en dBFS avec
 * maintien (1,5 s), barre RMS, et diode CLIP qui reste allumée après une
 * saturation (clic pour l'éteindre). Rafraîchi ~30 fois par seconde.
 */
const InputMeter: React.FC<{ trackId: string }> = ({ trackId }) => {
  const [v, setV] = useState({ rms: -90, peak: -90, hold: -90 });
  const [clip, setClip] = useState(false);
  const raf = useRef(0);

  useEffect(() => {
    let buf: Float32Array | null = null;
    let hold = -90, holdAt = 0, last = 0;
    const tick = (now: number) => {
      raf.current = requestAnimationFrame(tick);
      if (now - last < 33) return;
      last = now;
      const an = audioEngine.getTrackAnalyzer(trackId);
      if (!an) return;
      if (!buf || buf.length !== an.fftSize) buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      let pk = 0, sum = 0;
      for (let i = 0; i < buf.length; i++) { const x = buf[i]; sum += x * x; const a = x < 0 ? -x : x; if (a > pk) pk = a; }
      const rms = 20 * Math.log10(Math.max(Math.sqrt(sum / buf.length), 1e-6));
      const peak = 20 * Math.log10(Math.max(pk, 1e-6));
      if (peak > hold || now - holdAt > 1500) { hold = peak; holdAt = now; }
      if (pk >= 0.989) setClip(true); // ≈ -0,1 dBFS
      setV({ rms, peak, hold });
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [trackId]);

  // Échelle -60 … 0 dBFS
  const pos = (db: number) => Math.max(0, Math.min(1, (db + 60) / 60)) * 100;
  const color = v.peak > -3 ? 'bg-red-500' : v.peak > -12 ? 'bg-amber-400' : 'bg-emerald-400';

  return (
    <div className="flex items-center gap-1.5" data-nova-target="input-meter" title="Niveau du micro (dBFS). Vise -12 à -6 dB sur les passages forts.">
      <span className="text-[8px] font-black text-slate-500">IN</span>
      <div className="relative flex-1 h-2 rounded-full bg-black/60 overflow-hidden">
        <div className={`absolute inset-y-0 left-0 ${color} opacity-50`} style={{ width: `${pos(v.peak)}%` }} />
        <div className={`absolute inset-y-0 left-0 ${color}`} style={{ width: `${pos(v.rms)}%` }} />
        <div className="absolute inset-y-0 w-0.5 bg-white" style={{ left: `calc(${pos(v.hold)}% - 1px)` }} />
        {/* repères -12 et -6 dB */}
        <div className="absolute inset-y-0 w-px bg-white/25" style={{ left: `${pos(-12)}%` }} />
        <div className="absolute inset-y-0 w-px bg-white/25" style={{ left: `${pos(-6)}%` }} />
      </div>
      <span className="w-8 text-right text-[9px] font-mono tabular-nums text-slate-300">{v.hold <= -89 ? '-∞' : v.hold.toFixed(1)}</span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setClip(false); }}
        title={clip ? 'Saturation détectée : baisse le gain de ta carte son / éloigne-toi du micro. Clic pour effacer.' : 'Diode de saturation'}
        aria-label={clip ? 'Saturation détectée, cliquer pour effacer' : 'Pas de saturation'}
        className={`h-4 px-1 rounded text-[8px] font-black ${clip ? 'bg-red-600 text-white' : 'bg-white/5 text-slate-600'}`}
      >
        CLIP
      </button>
    </div>
  );
};

export default InputMeter;
