import React, { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../engine/AudioEngine';

interface RecordingCoachProps {
  isRecording: boolean;
  /** Piste en cours d'enregistrement (micro armé). */
  trackId: string | null;
  trackName?: string;
  /** Ce que l'artiste enregistre en ce moment (« ta voix principale », « tes backs »…). */
  partLabel?: string;
}

type Advice = { text: string; tone: 'ok' | 'warn' | 'bad' | 'idle' };

/**
 * L'ingé son derrière la vitre pendant la prise : vumètre du micro et
 * consignes en direct (« recule un peu », « rapproche-toi »).
 * Ne bloque rien : simple bandeau au-dessus du studio.
 */
const RecordingCoach: React.FC<RecordingCoachProps> = ({ isRecording, trackId, trackName, partLabel }) => {
  const [level, setLevel] = useState(0); // 0-1 pour l'affichage
  const [advice, setAdvice] = useState<Advice>({ text: '🎤 Vas-y, je t\'écoute', tone: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const raf = useRef(0);

  useEffect(() => {
    if (!isRecording || !trackId) return;
    const analyser = audioEngine.getTrackAnalyzer(trackId);
    const buf = new Float32Array(analyser ? analyser.fftSize : 2048);
    const start = performance.now();
    let lastClip = -1e9;
    let lastSound = start;
    let lastUi = 0;
    let soundMs = 0;
    let prev = start;

    const tick = (now: number) => {
      const dt = now - prev;
      prev = now;
      let peak = 0;
      let rms = 0;
      if (analyser) {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
        rms = Math.sqrt(sum / buf.length);
      }
      const rmsDb = 20 * Math.log10(Math.max(rms, 1e-6));
      if (peak > 0.97) lastClip = now;
      if (rmsDb > -45) { lastSound = now; soundMs += dt; }

      if (now - lastUi > 80) {
        lastUi = now;
        setLevel(Math.max(0, Math.min(1, (rmsDb + 60) / 60)));
        setElapsed((now - start) / 1000);
        if (!analyser) setAdvice({ text: '🎤 Enregistrement en cours', tone: 'idle' });
        else if (now - lastClip < 1500) setAdvice({ text: '🔴 Trop fort ! Recule d\'une main du micro', tone: 'bad' });
        else if (now - lastSound > 4000 && now - start > 4000) setAdvice({ text: '🤔 Je ne t\'entends pas : rapproche-toi du micro', tone: 'warn' });
        else if (soundMs > 600 && rmsDb > -30) setAdvice({ text: '✅ Bon niveau, continue comme ça', tone: 'ok' });
        else if (soundMs > 600 && rmsDb > -45) setAdvice({ text: '🎤 Un peu faible : rapproche-toi un peu', tone: 'warn' });
        else setAdvice({ text: '🎤 Vas-y, je t\'écoute', tone: 'idle' });
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [isRecording, trackId]);

  if (!isRecording) return null;

  const color = advice.tone === 'bad' ? 'bg-red-500' : advice.tone === 'warn' ? 'bg-amber-400' : 'bg-emerald-400';
  const mm = Math.floor(elapsed / 60);
  const ss = Math.floor(elapsed % 60).toString().padStart(2, '0');

  return (
    <div className="fixed left-1/2 -translate-x-1/2 top-[72px] z-[400] w-[min(92vw,420px)] pointer-events-none" role="status" aria-live="polite">
      <div className="rounded-2xl bg-black/85 border border-red-500/40 shadow-2xl px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2 text-[11px] font-bold text-red-300 uppercase tracking-wider">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span className="truncate">Rec {partLabel ? `· ${partLabel}` : ''}{trackName ? ` · ${trackName}` : ''}</span>
          <span className="ml-auto tabular-nums text-white/80">{mm}:{ss}</span>
        </div>
        <div className="mt-2 h-2.5 rounded-full bg-white/10 overflow-hidden" aria-hidden="true">
          <div className={`h-full ${color} transition-[width] duration-75`} style={{ width: `${Math.round(level * 100)}%` }} />
        </div>
        <div className={`mt-2 text-[13px] font-semibold ${advice.tone === 'bad' ? 'text-red-300' : advice.tone === 'warn' ? 'text-amber-200' : 'text-white'}`}>
          {advice.text}
        </div>
        <div className="mt-1 text-[10.5px] text-slate-400">Réappuie sur REC pour arrêter et réécouter.</div>
      </div>
    </div>
  );
};

export default RecordingCoach;
