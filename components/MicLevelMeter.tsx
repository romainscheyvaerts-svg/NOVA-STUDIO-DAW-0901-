import React, { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../engine/AudioEngine';

/**
 * Vumètre du micro de la piste armée, avec un verdict simple : l'artiste
 * vérifie que le micro marche et qu'il est au bon niveau AVANT sa prise.
 */
const MicLevelMeter: React.FC<{ trackId: string | null }> = ({ trackId }) => {
  const [level, setLevel] = useState(0);
  const [peakDb, setPeakDb] = useState(-90);
  const [heard, setHeard] = useState(false);
  const raf = useRef(0);

  useEffect(() => {
    if (!trackId) return;
    const an = audioEngine.getTrackAnalyzer(trackId);
    if (!an) return;
    const buf = new Float32Array(an.fftSize);
    let hold = -90, holdAt = 0;
    const tick = (now: number) => {
      an.getFloatTimeDomainData(buf);
      let pk = 0, sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
      const rmsDb = 20 * Math.log10(Math.max(Math.sqrt(sum / buf.length), 1e-6));
      const pDb = 20 * Math.log10(Math.max(pk, 1e-6));
      if (pDb > hold || now - holdAt > 1200) { hold = pDb; holdAt = now; }
      setLevel(Math.max(0, Math.min(1, (rmsDb + 60) / 60)));
      setPeakDb(hold);
      if (rmsDb > -45) setHeard(true);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [trackId]);

  const verdict = !heard
    ? { t: '🎤 Parle ou chante pour tester ton micro', c: 'text-slate-300' }
    : peakDb > -1 ? { t: '🔴 Trop fort : recule un peu ou baisse le gain', c: 'text-red-300' }
    : peakDb < -30 ? { t: '🔉 Un peu faible : rapproche-toi du micro', c: 'text-amber-200' }
    : { t: '✅ Micro OK, bon niveau', c: 'text-emerald-300' };

  return (
    <div className="rounded-xl bg-white/5 border border-white/10 p-3 text-left">
      <div className="h-2.5 rounded-full bg-white/10 overflow-hidden" aria-hidden="true">
        <div
          className={`h-full transition-[width] duration-75 ${peakDb > -1 ? 'bg-red-500' : peakDb < -30 ? 'bg-amber-400' : 'bg-emerald-400'}`}
          style={{ width: `${Math.round(level * 100)}%` }}
        />
      </div>
      <p className={`mt-2 text-[12px] font-semibold ${verdict.c}`} role="status" aria-live="polite">{verdict.t}</p>
    </div>
  );
};

export default MicLevelMeter;
