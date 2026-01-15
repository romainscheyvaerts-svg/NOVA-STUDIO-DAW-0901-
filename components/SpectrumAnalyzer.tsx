
/**
 * SPECTRUM ANALYZER
 * Professional FFT-based spectrum analyzer
 * Inspired by FabFilter Pro-Q, iZotope Ozone, and Voxengo SPAN
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';

interface SpectrumAnalyzerProps {
  analyzer: AnalyserNode | null;
  width?: number;
  height?: number;
  mode?: 'BARS' | 'LINE' | 'FILL' | 'DUAL';
  colorPrimary?: string;
  colorSecondary?: string;
  showGrid?: boolean;
  showLabels?: boolean;
  showPeak?: boolean;
  smoothing?: number;
  minDb?: number;
  maxDb?: number;
  logScale?: boolean;
}

// Frequency labels for grid
const FREQ_LABELS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const DB_LABELS = [-60, -48, -36, -24, -12, 0];

const SpectrumAnalyzer: React.FC<SpectrumAnalyzerProps> = ({
  analyzer,
  width = 400,
  height = 200,
  mode = 'FILL',
  colorPrimary = '#00f2ff',
  colorSecondary = '#0066ff',
  showGrid = true,
  showLabels = true,
  showPeak = true,
  smoothing = 0.8,
  minDb = -90,
  maxDb = 0,
  logScale = true,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peakHoldRef = useRef<Float32Array>(new Float32Array(1024));
  const peakDecayRef = useRef<Float32Array>(new Float32Array(1024));
  const rafRef = useRef<number>(0);
  const [isActive, setIsActive] = useState(false);
  
  // Convert frequency to X position (logarithmic scale)
  const freqToX = useCallback((freq: number) => {
    if (logScale) {
      const minLog = Math.log10(20);
      const maxLog = Math.log10(20000);
      const logFreq = Math.log10(Math.max(20, freq));
      return ((logFreq - minLog) / (maxLog - minLog)) * width;
    }
    return (freq / 20000) * width;
  }, [width, logScale]);
  
  // Convert bin index to frequency
  const binToFreq = useCallback((bin: number, sampleRate: number, fftSize: number) => {
    return (bin * sampleRate) / fftSize;
  }, []);
  
  // Convert dB to Y position
  const dbToY = useCallback((db: number) => {
    const normalized = (db - minDb) / (maxDb - minDb);
    return height - (normalized * height);
  }, [height, minDb, maxDb]);
  
  // Draw spectrum
  const draw = useCallback(() => {
    if (!analyzer || !canvasRef.current) {
      rafRef.current = requestAnimationFrame(draw);
      return;
    }
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Get frequency data
    const bufferLength = analyzer.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);
    analyzer.getFloatFrequencyData(dataArray);
    
    const sampleRate = analyzer.context.sampleRate;
    const fftSize = analyzer.fftSize;
    
    // Check if active
    const maxLevel = Math.max(...dataArray);
    setIsActive(maxLevel > -80);
    
    // Clear canvas
    ctx.clearRect(0, 0, width, height);
    
    // Draw background
    ctx.fillStyle = '#0a0b0d';
    ctx.fillRect(0, 0, width, height);
    
    // Draw grid
    if (showGrid) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      
      // Frequency grid lines
      FREQ_LABELS.forEach(freq => {
        const x = freqToX(freq);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      });
      
      // dB grid lines
      DB_LABELS.forEach(db => {
        const y = dbToY(db);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      });
    }
    
    // Draw labels
    if (showLabels) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.font = '9px Inter, sans-serif';
      
      // Frequency labels
      FREQ_LABELS.forEach(freq => {
        const x = freqToX(freq);
        const label = freq >= 1000 ? `${freq/1000}k` : `${freq}`;
        ctx.fillText(label, x - 10, height - 4);
      });
      
      // dB labels
      DB_LABELS.forEach(db => {
        const y = dbToY(db);
        ctx.fillText(`${db}`, 4, y + 3);
      });
    }
    
    // Build frequency curve from FFT data
    const points: { x: number; y: number; db: number }[] = [];
    
    for (let i = 0; i < bufferLength; i++) {
      const freq = binToFreq(i, sampleRate, fftSize);
      if (freq < 20 || freq > 20000) continue;
      
      const db = Math.max(minDb, Math.min(maxDb, dataArray[i]));
      const x = freqToX(freq);
      const y = dbToY(db);
      
      // Peak hold
      if (showPeak) {
        if (db > peakHoldRef.current[i]) {
          peakHoldRef.current[i] = db;
          peakDecayRef.current[i] = 0;
        } else {
          peakDecayRef.current[i] += 0.1;
          peakHoldRef.current[i] -= peakDecayRef.current[i] * 0.05;
        }
      }
      
      points.push({ x, y, db });
    }
    
    // Simplify points for performance (skip some)
    const simplifiedPoints = points.filter((_, i) => i % 2 === 0 || i === points.length - 1);
    
    if (simplifiedPoints.length < 2) {
      rafRef.current = requestAnimationFrame(draw);
      return;
    }
    
    // Create gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, colorPrimary);
    gradient.addColorStop(0.5, colorSecondary);
    gradient.addColorStop(1, 'transparent');
    
    // Draw based on mode
    if (mode === 'FILL' || mode === 'DUAL') {
      ctx.beginPath();
      ctx.moveTo(0, height);
      ctx.lineTo(simplifiedPoints[0].x, simplifiedPoints[0].y);
      
      simplifiedPoints.forEach((point, i) => {
        if (i === 0) return;
        const prev = simplifiedPoints[i - 1];
        const cpX = (prev.x + point.x) / 2;
        ctx.quadraticCurveTo(prev.x, prev.y, cpX, (prev.y + point.y) / 2);
      });
      
      ctx.lineTo(simplifiedPoints[simplifiedPoints.length - 1].x, height);
      ctx.closePath();
      
      ctx.fillStyle = gradient;
      ctx.globalAlpha = 0.6;
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }
    
    if (mode === 'LINE' || mode === 'DUAL') {
      ctx.beginPath();
      ctx.moveTo(simplifiedPoints[0].x, simplifiedPoints[0].y);
      
      simplifiedPoints.forEach((point, i) => {
        if (i === 0) return;
        const prev = simplifiedPoints[i - 1];
        const cpX = (prev.x + point.x) / 2;
        ctx.quadraticCurveTo(prev.x, prev.y, cpX, (prev.y + point.y) / 2);
      });
      
      ctx.strokeStyle = colorPrimary;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    
    if (mode === 'BARS') {
      const barWidth = width / 64;
      const barGap = 2;
      
      for (let i = 0; i < 64; i++) {
        const binIndex = Math.floor((i / 64) * bufferLength * 0.5);
        const db = Math.max(minDb, Math.min(maxDb, dataArray[binIndex]));
        const barHeight = (1 - dbToY(db) / height) * height;
        
        const barGradient = ctx.createLinearGradient(0, height - barHeight, 0, height);
        barGradient.addColorStop(0, colorPrimary);
        barGradient.addColorStop(1, colorSecondary);
        
        ctx.fillStyle = barGradient;
        ctx.fillRect(
          i * (barWidth + barGap),
          height - barHeight,
          barWidth,
          barHeight
        );
      }
    }
    
    // Draw peak hold line
    if (showPeak && (mode === 'LINE' || mode === 'FILL' || mode === 'DUAL')) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 1;
      
      let started = false;
      for (let i = 0; i < bufferLength; i += 2) {
        const freq = binToFreq(i, sampleRate, fftSize);
        if (freq < 20 || freq > 20000) continue;
        
        const peakDb = Math.max(minDb, Math.min(maxDb, peakHoldRef.current[i]));
        const x = freqToX(freq);
        const y = dbToY(peakDb);
        
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    
    rafRef.current = requestAnimationFrame(draw);
  }, [analyzer, width, height, mode, colorPrimary, colorSecondary, showGrid, showLabels, showPeak, freqToX, binToFreq, dbToY, minDb, maxDb]);
  
  // Start drawing loop
  useEffect(() => {
    if (analyzer) {
      analyzer.smoothingTimeConstant = smoothing;
    }
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [analyzer, draw, smoothing]);
  
  return (
    <div className="relative rounded-lg overflow-hidden" style={{ width, height }}>
      <canvas 
        ref={canvasRef} 
        width={width} 
        height={height}
        className="block"
      />
      {/* Activity indicator */}
      <div className={`absolute top-2 right-2 w-2 h-2 rounded-full transition-colors ${isActive ? 'bg-green-500' : 'bg-slate-700'}`} />
    </div>
  );
};

/**
 * Compact Spectrum Analyzer for plugin headers
 */
export const MiniSpectrum: React.FC<{
  analyzer: AnalyserNode | null;
  width?: number;
  height?: number;
  color?: string;
}> = ({ analyzer, width = 100, height = 30, color = '#00f2ff' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  
  useEffect(() => {
    if (!analyzer) return;
    
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      const bufferLength = analyzer.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      analyzer.getByteFrequencyData(dataArray);
      
      ctx.clearRect(0, 0, width, height);
      
      const barCount = 32;
      const barWidth = width / barCount - 1;
      
      for (let i = 0; i < barCount; i++) {
        // Use logarithmic sampling
        const binIndex = Math.floor(Math.pow(i / barCount, 2) * bufferLength * 0.5);
        const value = dataArray[binIndex] / 255;
        const barHeight = value * height;
        
        ctx.fillStyle = color + Math.floor(value * 255).toString(16).padStart(2, '0');
        ctx.fillRect(
          i * (barWidth + 1),
          height - barHeight,
          barWidth,
          barHeight
        );
      }
      
      rafRef.current = requestAnimationFrame(draw);
    };
    
    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, [analyzer, width, height, color]);
  
  return (
    <canvas 
      ref={canvasRef} 
      width={width} 
      height={height}
      className="block opacity-80"
    />
  );
};

export default SpectrumAnalyzer;
