
import React, { useEffect, useRef } from 'react';
import { audioEngine } from '../engine/AudioEngine';

// --- METER MANAGER LOGIC ---
class MeterManager {
  private static instance: MeterManager;
  private registeredElements: Map<string, { el: HTMLElement, type: 'TRACK' | 'MASTER_L' | 'MASTER_R', peak: number, peakTimer: number }> = new Map();
  private animationFrameId: number | null = null;

  private constructor() {
    this.loop = this.loop.bind(this);
  }

  public static getInstance(): MeterManager {
    if (!MeterManager.instance) {
      MeterManager.instance = new MeterManager();
    }
    return MeterManager.instance;
  }

  public register(id: string, element: HTMLElement, type: 'TRACK' | 'MASTER_L' | 'MASTER_R') {
    this.registeredElements.set(id, { el: element, type, peak: 0, peakTimer: 0 });
    if (!this.animationFrameId) {
      this.loop();
    }
  }

  public unregister(id: string) {
    this.registeredElements.delete(id);
    if (this.registeredElements.size === 0 && this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private loop() {
    this.animationFrameId = requestAnimationFrame(this.loop);
    
    const now = Date.now();
    const isPlaying = audioEngine.getIsPlaying();

    this.registeredElements.forEach((data, id) => {
      let rms = 0;

      if (data.type === 'MASTER_L' || data.type === 'MASTER_R') {
        // CORRECTION: Si le transport est arrêté, on force le niveau à 0 pour éviter le freeze du dernier buffer
        if (isPlaying) {
            rms = audioEngine.getRMS(data.type === 'MASTER_L' ? audioEngine.masterAnalyzerL : audioEngine.masterAnalyzerR);
        } else {
            rms = 0;
        }
      } else if (data.type === 'TRACK') {
        // Pour les pistes, on vérifie toujours l'analyseur (monitoring possible)
        const analyzer = audioEngine.getTrackAnalyzer(id);
        if (analyzer) rms = audioEngine.getRMS(analyzer);
      }

      // Convert RMS to dB visual scale (0 to 1)
      // Range: -60dB (0) to 0dB (1)
      const db = 20 * Math.log10(Math.max(rms, 0.00001));
      const visual = Math.max(0, Math.min(1, (db + 60) / 60));
      
      // Peak Hold Logic
      if (visual > data.peak) {
        data.peak = visual;
        data.peakTimer = now + 1000; // Hold 1s
      } else if (now > data.peakTimer) {
        data.peak = Math.max(0, data.peak - 0.02); // Decay
      }

      // DOM Update (Highly Optimized)
      // On assume que l'élément a un enfant pour la barre (index 0)
      const bar = data.el.firstElementChild as HTMLElement;
      if (bar) {
        const percent = visual * 100;
        
        if (data.type.startsWith('MASTER')) {
            // Vertical bar
            bar.style.height = `${percent}%`;
        } else {
            // Horizontal bar (Tracks)
            bar.style.width = `${percent}%`;
        }
        
        // Color Logic based on visual level (0-1)
        // Green < 0.7 (-18dB), Yellow < 0.9 (-6dB), Red > 0.9
        if (visual > 0.95) bar.style.backgroundColor = '#ef4444'; // Red
        else if (visual > 0.8) bar.style.backgroundColor = '#fbbf24'; // Yellow
        else bar.style.backgroundColor = '#10b981'; // Green
      }
    });
  }
}

// --- REACT COMPONENTS ---

export const MasterMeter: React.FC = () => {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const manager = MeterManager.getInstance();
    if (leftRef.current) manager.register('master_L', leftRef.current, 'MASTER_L');
    if (rightRef.current) manager.register('master_R', rightRef.current, 'MASTER_R');

    return () => {
      manager.unregister('master_L');
      manager.unregister('master_R');
    };
  }, []);

  return (
    <div className="flex space-x-1 h-8 bg-black/60 rounded p-1 border border-white/10 items-end" title="Master Output L/R">
      <div className="w-2 h-full bg-[#111] rounded-sm relative overflow-hidden" ref={leftRef}>
        <div className="absolute bottom-0 left-0 right-0 bg-green-500 transition-none" style={{ height: '0%' }} />
      </div>
      <div className="w-2 h-full bg-[#111] rounded-sm relative overflow-hidden" ref={rightRef}>
        <div className="absolute bottom-0 left-0 right-0 bg-green-500 transition-none" style={{ height: '0%' }} />
      </div>
    </div>
  );
};

interface TrackMeterProps {
  trackId: string;
}

export const TrackMeter: React.FC<TrackMeterProps> = ({ trackId }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const manager = MeterManager.getInstance();
    if (ref.current) manager.register(trackId, ref.current, 'TRACK');
    return () => manager.unregister(trackId);
  }, [trackId]);

  return (
    <div className="w-16 h-2 bg-black/50 rounded-full overflow-hidden border border-white/5 relative" ref={ref}>
      <div className="h-full bg-green-500 transition-none" style={{ width: '0%' }} />
    </div>
  );
};
