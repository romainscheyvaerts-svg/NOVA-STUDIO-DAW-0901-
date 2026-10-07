import React, { useEffect, useRef } from 'react';
import { canvasTheme } from '../utils/canvasTheme';

interface Props {
  buffer: AudioBuffer | null;
  height?: number;
  /** Zone jouée (0-1) : le reste est grisé. */
  region?: { start: number; end: number; reverse?: boolean };
  /** Repères de découpe (0-1) numérotés. */
  markers?: number[];
  /** Tranche en surbrillance. */
  hot?: number;
  onTap?: (fraction: number) => void;
  label?: string;
}

/** Forme d'onde légère (canvas) pour les pads et la découpe. */
const MiniWave: React.FC<Props> = ({ buffer, height = 72, region, markers, hot = -1, onTap, label }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(10, cv.clientWidth), h = height;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      const g = cv.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.fillStyle = canvasTheme().ink(0.04); g.fillRect(0, 0, w, h);
      if (!buffer) return;
      const d = buffer.getChannelData(0);
      const per = Math.max(1, Math.floor(d.length / w));
      const mid = h / 2;
      if (markers && markers.length) {
        const pts = [...markers, 1];
        for (let k = 0; k < markers.length; k++) {
          g.fillStyle = k === hot ? 'rgba(34,211,238,0.28)' : k % 2 ? canvasTheme().ink(0.05) : canvasTheme().ink(0.02);
          g.fillRect(pts[k] * w, 0, (pts[k + 1] - pts[k]) * w, h);
        }
      }
      g.fillStyle = '#67e8f9';
      for (let x = 0; x < w; x++) {
        let mn = 0, mx = 0;
        const s = x * per;
        for (let i = s; i < s + per && i < d.length; i += Math.max(1, per >> 6)) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        g.fillRect(x, mid - mx * mid * 0.95, 1, Math.max(1, (mx - mn) * mid * 0.95));
      }
      if (region) {
        g.fillStyle = canvasTheme().labelBg;
        g.fillRect(0, 0, region.start * w, h);
        g.fillRect(region.end * w, 0, (1 - region.end) * w, h);
        g.fillStyle = '#facc15';
        g.fillRect(region.start * w - 1, 0, 2, h);
        g.fillRect(region.end * w - 1, 0, 2, h);
        if (region.reverse) { g.fillStyle = '#facc15'; g.font = 'bold 11px sans-serif'; g.fillText('◀ reverse', region.start * w + 4, 12); }
      }
      if (markers) {
        g.font = 'bold 10px sans-serif';
        markers.forEach((m, k) => {
          g.fillStyle = '#f472b6';
          g.fillRect(m * w - 1, 0, 2, h);
          g.fillStyle = '#fff';
          g.fillText(String(k + 1), m * w + 3, 11);
        });
      }
    };
    draw();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(draw) : null;
    ro?.observe(cv);
    return () => ro?.disconnect();
  }, [buffer, height, region?.start, region?.end, region?.reverse, markers, hot]);

  return (
    <canvas ref={ref} role={onTap ? 'button' : 'img'} aria-label={label || 'Forme d\'onde'}
      onPointerUp={onTap ? e => { const r = (e.target as HTMLCanvasElement).getBoundingClientRect(); onTap(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))); } : undefined}
      className={`w-full rounded-lg block ${onTap ? 'cursor-crosshair touch-manipulation' : ''}`} style={{ height }} />
  );
};

export default MiniWave;
