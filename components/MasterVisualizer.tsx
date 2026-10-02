
import React, { useRef, useEffect, useState } from 'react';
import { audioEngine } from '../engine/AudioEngine';

const MasterVisualizer: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<'SPECTRUM' | 'WAVE'>('SPECTRUM');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let animationFrameId = 0;

    // Taille suivie par ResizeObserver : avant, chaque image relisait
    // getBoundingClientRect et reallouait le canvas (width/height reassignes).
    let width = 0, height = 0;
    const resize = (w: number, h: number) => {
      const dpr = window.devicePixelRatio || 1;
      width = w; height = h;
      const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const r0 = canvas.getBoundingClientRect();
    resize(r0.width, r0.height);
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect;
      if (r) resize(r.width, r.height);
    });
    ro.observe(canvas);

    // Tampons et couleurs prealloues (plus d'allocation par image).
    let dataArray = new Uint8Array(0);
    let colors: string[] = [];
    const ensureBuffers = (n: number) => {
      if (dataArray.length === n) return;
      dataArray = new Uint8Array(n);
      colors = Array.from({ length: n }, (_, i) => `hsla(${(i / n) * 360}, 100%, 50%, 0.8)`);
    };

    // La boucle s'arrete quand le visualiseur est hors ecran ou l'onglet cache.
    let onScreen = true;
    const running = () => onScreen && document.visibilityState !== 'hidden';

    const draw = () => {
      animationFrameId = 0;
      if (!running()) return;
      animationFrameId = requestAnimationFrame(draw);
      if (width <= 0 || height <= 0) return;

      ctx.clearRect(0, 0, width, height);
      const analyzer = audioEngine.getMasterAnalyzer();
      if (!analyzer) return;

      const bufferLength = analyzer.frequencyBinCount;
      ensureBuffers(bufferLength);

      if (mode === 'SPECTRUM') {
        analyzer.getByteFrequencyData(dataArray);
        const barWidth = (width / bufferLength) * 2.5;
        let x = 0;

        for (let i = 0; i < bufferLength && x < width; i++) {
          const barHeight = (dataArray[i] / 255) * height;
          ctx.fillStyle = colors[i];
          // Mirror effect for cool look
          ctx.fillRect(x, height / 2 - barHeight / 2, barWidth, barHeight);
          x += barWidth + 1;
        }
      } else {
        // OSCILLOSCOPE
        analyzer.getByteTimeDomainData(dataArray);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00f2ff';
        ctx.beginPath();

        const sliceWidth = width / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          const v = dataArray[i] / 128.0;
          const y = v * height / 2;

          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);

          x += sliceWidth;
        }

        ctx.lineTo(width, height / 2);
        ctx.stroke();
      }
    };

    const restart = () => { if (running() && !animationFrameId) animationFrameId = requestAnimationFrame(draw); };
    const io = new IntersectionObserver(entries => {
      onScreen = entries[entries.length - 1]?.isIntersecting ?? true;
      restart();
    });
    io.observe(canvas);
    document.addEventListener('visibilitychange', restart);
    restart();

    return () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', restart);
    };
  }, [mode]);

  return (
    <div
      className="w-32 h-10 bg-black/60 rounded-lg border border-white/10 relative overflow-hidden cursor-pointer group"
      onClick={() => setMode(m => m === 'SPECTRUM' ? 'WAVE' : 'SPECTRUM')}
      title="Click to toggle visualizer mode"
    >
       <canvas ref={canvasRef} className="w-full h-full" />
       <div className="absolute inset-0 bg-gradient-to-r from-black/20 via-transparent to-black/20 pointer-events-none" />
       <div className="absolute top-0.5 right-1 text-[6px] font-mono text-cyan-500/50 group-hover:text-cyan-400 transition-colors">
          {mode}
       </div>
    </div>
  );
};

export default MasterVisualizer;
