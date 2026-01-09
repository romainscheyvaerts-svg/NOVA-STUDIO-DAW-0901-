
import React, { useEffect, useRef } from 'react';
import { audioEngine } from '../engine/AudioEngine';

interface LiveRecordingClipProps {
  trackId: string;
  recStartTime: number;
  currentTime: number;
  zoomH: number; // Pixels par seconde
  height: number;
}

const LiveRecordingClip: React.FC<LiveRecordingClipProps> = ({ 
  trackId, 
  recStartTime, 
  currentTime, 
  zoomH, 
  height 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const peaksRef = useRef<number[]>([]);
  const lastDrawTimeRef = useRef<number>(recStartTime);
  const animationFrameRef = useRef<number>(0);

  useEffect(() => {
    // Reset au démarrage
    peaksRef.current = [];
    lastDrawTimeRef.current = recStartTime;

    const drawLoop = () => {
      const analyzer = audioEngine.getTrackAnalyzer(trackId);
      const canvas = canvasRef.current;
      const container = containerRef.current;

      if (!analyzer || !canvas || !container) {
        animationFrameRef.current = requestAnimationFrame(drawLoop);
        return;
      }

      // 1. Calcul de la géométrie temporelle
      // On utilise audioEngine.getCurrentTime() pour une fluidité maximale hors React render cycle
      const now = audioEngine.getCurrentTime();
      const duration = Math.max(0, now - recStartTime);
      const width = duration * zoomH;

      // Mise à jour de la largeur du conteneur (Animation CSS fluide)
      container.style.width = `${width}px`;

      // Gestion de la taille du canvas (Redimensionnement dynamique)
      // On évite de redimensionner à chaque frame pour perf, on le fait par paliers ou si besoin
      if (canvas.width < width) {
        // Sauvegarde du contenu actuel
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext('2d');
        if (tempCtx) tempCtx.drawImage(canvas, 0, 0);

        // Agrandissement
        canvas.width = width + 100; // Buffer de 100px pour éviter trop de resizes
        canvas.height = height; // Hauteur fixe

        // Restauration
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.drawImage(tempCanvas, 0, 0);
      }

      // 2. Acquisition des données audio
      const dataArray = new Uint8Array(analyzer.frequencyBinCount);
      analyzer.getByteTimeDomainData(dataArray);

      // Calcul RMS instantané (Amplitude)
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const amplitude = (dataArray[i] - 128) / 128;
        sum += amplitude * amplitude;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      
      // Stockage pour redessin éventuel (optionnel, ici on dessine en "mode append")
      // On dessine directement sur le canvas à la position X actuelle
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const x = width; // On dessine tout à droite
        const barHeight = Math.max(1, rms * height * 3); // Amplification visuelle
        const centerY = height / 2;

        ctx.fillStyle = '#ff0000'; // Couleur de l'onde brute
        ctx.fillRect(x - 1, centerY - barHeight / 2, 2, barHeight);
      }

      animationFrameRef.current = requestAnimationFrame(drawLoop);
    };

    animationFrameRef.current = requestAnimationFrame(drawLoop);

    return () => {
      cancelAnimationFrame(animationFrameRef.current);
    };
  }, [trackId, recStartTime, zoomH, height]);

  return (
    <div 
      ref={containerRef}
      className="absolute top-0 h-full bg-red-900/20 border-r-2 border-red-500 z-10 pointer-events-none overflow-hidden"
      style={{ 
        left: `${recStartTime * zoomH}px`, // Position absolue de départ
        width: '0px',
        borderRadius: '6px',
        boxShadow: '0 0 15px rgba(239, 68, 68, 0.3)'
      }}
    >
      {/* Indicateur "REC" clignotant */}
      <div className="absolute top-1 left-2 flex items-center space-x-2 z-20">
        <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse shadow-[0_0_10px_red]"></div>
        <span className="text-[9px] font-black text-red-100 uppercase tracking-widest animate-pulse">Recording...</span>
      </div>

      {/* Canvas Waveform */}
      <canvas 
        ref={canvasRef} 
        height={height}
        className="absolute top-0 left-0 h-full opacity-80"
        style={{ width: 'auto' }} // La largeur est gérée par l'attribut width du canvas
      />
      
      {/* Ligne de scan "Radar" */}
      <div className="absolute top-0 right-0 w-[1px] h-full bg-red-400 shadow-[0_0_10px_red]"></div>
    </div>
  );
};

export default LiveRecordingClip;
