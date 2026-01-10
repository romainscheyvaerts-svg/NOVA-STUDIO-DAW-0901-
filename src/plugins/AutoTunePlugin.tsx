

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AutoTuneNode } from './autotune-pro/AutoTuneNode';
// FIX: Import centralized constants to ensure consistency and avoid duplication.
import { NOTES, SCALES } from '../utils/constants';

export interface AutoTuneParams {
  speed: number;      
  humanize: number;   
  mix: number;        
  rootKey: number;    
  scale: string;      
  isEnabled: boolean;
}

interface AutoTuneUIProps {
  node: AutoTuneNode;
  initialParams: AutoTuneParams;
  onParamsChange?: (p: AutoTuneParams) => void;
}

export const AutoTuneUI: React.FC<AutoTuneUIProps> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<AutoTuneParams>(initialParams);
  const paramsRef = useRef<AutoTuneParams>(initialParams); // Ref to hold latest params for event listeners
  const [vizData, setVizData] = useState({ detectedFreq: 0, targetFreq: 0, correctionCents: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDragging = useRef(false);
  const activeParam = useRef<keyof AutoTuneParams | null>(null);

  // Sync ref with state
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  useEffect(() => {
    node.setStatusCallback((data) => {
      setVizData(data);
    });
    return () => node.setStatusCallback(() => {});
  }, [node]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let frameId: number;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.beginPath();
      ctx.moveTo(w/2, 0); ctx.lineTo(w/2, h); 
      ctx.stroke();

      ctx.fillStyle = 'rgba(0, 242, 255, 0.05)';
      ctx.fillRect(w/2 - 20, 0, 40, h);

      if (vizData.detectedFreq > 50) {
        const offset = Math.max(-100, Math.min(100, vizData.correctionCents));
        const x = (w / 2) + (offset / 100) * (w / 2 * 0.8); 

        ctx.strokeStyle = '#00f2ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(w/2, h/2 - 20); ctx.lineTo(w/2, h/2 + 20);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(x, h/2, 8, 0, Math.PI * 2);
        ctx.fillStyle = paramsRef.current.isEnabled ? '#ffffff' : '#555';
        ctx.fill();
        
        ctx.beginPath();
        ctx.moveTo(x, h/2);
        ctx.lineTo(w/2, h/2);
        ctx.strokeStyle = `rgba(0, 242, 255, ${Math.abs(offset) / 100})`;
        ctx.stroke();
      }

      frameId = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frameId);
  }, [vizData]);

  const updateParam = (key: keyof AutoTuneParams, value: any) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  };

  const handleMouseDown = (param: keyof AutoTuneParams, e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    activeParam.current = param;
    document.body.style.cursor = 'ns-resize';
  };

  // FIX: Refactored to avoid calling onParamsChange within the setState callback, which is a React anti-pattern (#310) that can lead to stale state and unpredictable behavior. The side effect is now correctly separated from the state update.
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !activeParam.current) return;
    const delta = -e.movementY / 150;
    
    const currentParams = paramsRef.current;
    const currentVal = currentParams[activeParam.current!];
    
    if (typeof currentVal !== 'number') return;
    
    const newVal = Math.max(0, Math.min(1, currentVal + delta));
    const newParams = { ...currentParams, [activeParam.current!]: newVal };
    
    setParams(newParams);
    node.updateParams(newParams);
    
    if (onParamsChange) {
        onParamsChange(newParams);
    }
  }, [node, onParamsChange]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    activeParam.current = null;
    document.body.style.cursor = 'default';
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  const getNoteName = (freq: number) => {
    if (freq <= 0) return '--';
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    return NOTES[midi % 12] || '--';
  };

  return (
    <div className="w-[480px] bg-[#0c0d10] border border-white/10 rounded-[40px] p-10