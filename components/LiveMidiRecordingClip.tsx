import React, { useEffect, useRef } from 'react';
import { audioEngine } from '../engine/AudioEngine';
import { midiInput } from '../services/MidiInput';

/**
 * Prise MIDI en cours (R16) : les notes apparaissent pendant que tu joues,
 * à leur place dans le morceau (en boucle : sur le tour en cours).
 */
interface Props {
  trackId: string;
  recStartTime: number;
  zoomH: number;
  height: number;
}

const LiveMidiRecordingClip: React.FC<Props> = ({ trackId, recStartTime, zoomH, height }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current, box = boxRef.current;
      if (!canvas || !box) return;
      const now = audioEngine.getCurrentTime();
      const pv = midiInput.recPreview();
      const notes = pv && pv.trackId === trackId ? pv.notes : [];
      const lastPass = notes.reduce((m, n) => Math.max(m, n.pass), 0);
      const shown = notes.filter(n => n.pass === lastPass);
      const from = Math.min(recStartTime, ...shown.map(n => n.start));
      const to = Math.max(now, ...shown.map(n => n.start + n.duration));
      const width = Math.max(2, (to - from) * zoomH);
      box.style.left = `${from * zoomH}px`;
      box.style.width = `${width}px`;
      if (countRef.current) countRef.current.textContent = `${notes.length} note${notes.length > 1 ? 's' : ''}${lastPass > 0 ? ` · tour ${lastPass + 1}` : ''}`;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.ceil(width * dpr), h = Math.ceil(height * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      if (!shown.length) return;
      const lo = Math.min(...shown.map(n => n.pitch)) - 2, hi = Math.max(...shown.map(n => n.pitch)) + 2;
      const rowH = Math.max(1.5, Math.min(6, (h - 16 * dpr) / Math.max(1, hi - lo)));
      ctx.fillStyle = '#fecaca';
      for (const n of shown) {
        const x = (n.start - from) * zoomH * dpr;
        const y = 14 * dpr + (hi - n.pitch) * rowH;
        ctx.globalAlpha = 0.45 + 0.55 * (n.velocity / 127);
        ctx.fillRect(x, y, Math.max(2, n.duration * zoomH * dpr), Math.max(1.5, rowH - 0.5));
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [trackId, recStartTime, zoomH, height]);

  return (
    <div ref={boxRef} data-nova-live-midi="" className="absolute top-0 h-full bg-red-950/85 border-r-2 border-red-500 z-10 pointer-events-none overflow-hidden"
      style={{ left: `${recStartTime * zoomH}px`, width: 0, borderRadius: 6, boxShadow: '0 0 15px rgba(239, 68, 68, 0.3)' }}>
      <div className="absolute top-0.5 left-2 flex items-center gap-1.5 z-20 whitespace-nowrap">
        <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
        <span className="text-[9px] font-black text-red-100 uppercase tracking-widest">Prise MIDI</span>
        <span ref={countRef} className="text-[9px] font-bold text-red-200" />
      </div>
      <canvas ref={canvasRef} className="absolute top-0 left-0" />
    </div>
  );
};

export default LiveMidiRecordingClip;
