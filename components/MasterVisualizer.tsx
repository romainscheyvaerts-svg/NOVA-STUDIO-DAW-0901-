
import React, { useRef, useEffect, useState } from 'react';
import { audioEngine } from '../engine/AudioEngine';

const MasterVisualizer: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<'SPECTRUM' | 'WAVE'>('SPECTRUM');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let animationFrameId: number;

    const draw = () => {
      const analyzer = audioEngine.getMasterAnalyzer();
      
      // Auto-resize canvas for sharpness
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      
      const width = rect.width;
      const height = rect.height;

      ctx.clearRect(0, 0, width, height);

      if (!analyzer) {
          animationFrameId = requestAnimationFrame(draw);
          return;
      }

      const bufferLength = analyzer.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      if (mode === 'SPECTRUM') {
        analyzer.getByteFrequencyData(dataArray);
        const barWidth = (width / bufferLength) * 2.5;
        let barHeight;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          barHeight = (dataArray[i] / 255) * height;
          
          const hue = (i / bufferLength) * 360;
          ctx.fillStyle = `hsla(${hue}, 100%, 50%, 0.8)`;
          
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

        const sliceWidth = width * 1.0 / bufferLength;
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

      animationFrameId = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(animationFrameId);
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
