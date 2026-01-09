
import React, { useEffect, useRef } from 'react';

interface WaveformRendererProps {
  buffer?: AudioBuffer;
  peaks?: Float32Array | number[];
  color: string;
  height: number;
  offset: number;     // Offset de lecture dans le buffer (sec)
  duration: number;   // Durée affichée (sec)
  pixelsPerSecond: number;
  visualGain?: number; // Facteur d'échelle visuelle (1.0 = normal)
}

const WaveformRenderer: React.FC<WaveformRendererProps> = ({ 
  buffer, peaks, color, height, offset, duration, pixelsPerSecond, visualGain = 1.0 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = height;
    const centerY = h / 2;
    ctx.clearRect(0, 0, w, h);

    // Dessiner la ligne de 0dB (Silence)
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.moveTo(0, centerY);
    ctx.lineTo(w, centerY);
    ctx.stroke();

    // Priorité au buffer pour la haute fidélité
    const data = buffer ? buffer.getChannelData(0) : (peaks ? Float32Array.from(peaks) : null);
    if (!data) return;

    const sampleRate = buffer ? buffer.sampleRate : 44100; // Estimation si buffer absent
    const startSample = Math.floor(offset * sampleRate);
    const endSample = Math.floor((offset + duration) * sampleRate);
    const totalSamplesToRender = endSample - startSample;
    
    // Déterminer si on est en mode "Sample Level" (plus de 1 pixel par échantillon)
    const samplesPerPixel = totalSamplesToRender / w;
    const isSampleLevel = samplesPerPixel < 1.5;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = isSampleLevel ? 2 : 1;
    ctx.lineJoin = 'round';

    if (isSampleLevel) {
      // MODE CHIRURGICAL : Rendu des points d'échantillonnage individuels
      for (let x = 0; x < w; x++) {
        const sampleIdx = startSample + Math.floor(x * samplesPerPixel);
        if (sampleIdx >= data.length) break;
        
        const val = data[sampleIdx] * visualGain;
        const y = centerY - (val * centerY);

        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);

        // Dessiner les points si on est vraiment très zoomé
        if (samplesPerPixel < 0.2) {
          ctx.save();
          ctx.fillStyle = '#fff';
          ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
          ctx.restore();
        }
      }
      ctx.stroke();
    } else {
      // MODE APERÇU : Algorithme Min-Max pour éviter l'aliasing
      ctx.fillStyle = color;
      for (let x = 0; x < w; x++) {
        const chunkStart = startSample + Math.floor(x * samplesPerPixel);
        const chunkEnd = startSample + Math.floor((x + 1) * samplesPerPixel);
        
        let min = 0;
        let max = 0;

        for (let i = chunkStart; i < chunkEnd; i++) {
          if (i >= data.length) break;
          const val = data[i];
          if (val < min) min = val;
          if (val > max) max = val;
        }

        const yMin = centerY - (min * centerY * visualGain);
        const yMax = centerY - (max * centerY * visualGain);
        
        // On dessine une barre verticale du min au max
        const barHeight = Math.max(1, yMin - yMax);
        ctx.fillRect(x, yMax, 1, barHeight);
      }
    }
  }, [buffer, peaks, color, height, offset, duration, pixelsPerSecond, visualGain]);

  return <canvas ref={canvasRef} className="w-full h-full pointer-events-none" />;
};

export default WaveformRenderer;
