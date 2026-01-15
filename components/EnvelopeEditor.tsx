
/**
 * ADSR ENVELOPE EDITOR
 * Professional envelope visualizer and editor
 * Inspired by Serum, Massive X, and Vital
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';

export interface ADSRValues {
  attack: number;    // seconds (0-5)
  decay: number;     // seconds (0-5)
  sustain: number;   // level 0-1
  release: number;   // seconds (0-10)
}

interface EnvelopeEditorProps {
  values: ADSRValues;
  onChange: (values: ADSRValues) => void;
  width?: number;
  height?: number;
  color?: string;
  showLabels?: boolean;
  showValues?: boolean;
  maxAttack?: number;
  maxDecay?: number;
  maxRelease?: number;
}

type DragTarget = 'attack' | 'decay' | 'sustain' | 'release' | null;

const EnvelopeEditor: React.FC<EnvelopeEditorProps> = ({
  values,
  onChange,
  width = 300,
  height = 150,
  color = '#00f2ff',
  showLabels = true,
  showValues = true,
  maxAttack = 2,
  maxDecay = 2,
  maxRelease = 5,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);
  const [hoveredTarget, setHoveredTarget] = useState<DragTarget>(null);
  
  // Calculate pixel positions from ADSR values
  const getPositions = useCallback(() => {
    const padding = 20;
    const usableWidth = width - padding * 2;
    const usableHeight = height - padding * 2;
    
    // Total time for visualization
    const totalTime = maxAttack + maxDecay + maxRelease;
    const pxPerSecond = usableWidth / totalTime;
    
    // Calculate x positions
    const attackX = padding + (values.attack * pxPerSecond);
    const decayX = attackX + (values.decay * pxPerSecond);
    const sustainWidth = usableWidth * 0.15; // Fixed sustain display width
    const releaseX = decayX + sustainWidth + (values.release * pxPerSecond);
    
    // Y positions
    const topY = padding;
    const sustainY = padding + (1 - values.sustain) * usableHeight;
    const bottomY = height - padding;
    
    return {
      start: { x: padding, y: bottomY },
      attack: { x: attackX, y: topY },
      decay: { x: decayX, y: sustainY },
      sustainEnd: { x: decayX + sustainWidth, y: sustainY },
      release: { x: Math.min(releaseX, width - padding), y: bottomY },
      padding,
      usableHeight,
      usableWidth,
    };
  }, [values, width, height, maxAttack, maxDecay, maxRelease]);
  
  // Draw envelope
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const pos = getPositions();
    
    // Clear
    ctx.clearRect(0, 0, width, height);
    
    // Background
    ctx.fillStyle = '#0f1115';
    ctx.fillRect(0, 0, width, height);
    
    // Grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pos.padding + (i / 4) * pos.usableHeight;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    
    // Fill area under curve
    ctx.beginPath();
    ctx.moveTo(pos.start.x, pos.start.y);
    
    // Attack curve (exponential)
    const attackSteps = 20;
    for (let i = 0; i <= attackSteps; i++) {
      const t = i / attackSteps;
      const x = pos.start.x + (pos.attack.x - pos.start.x) * t;
      const y = pos.start.y + (pos.attack.y - pos.start.y) * Math.pow(t, 0.5);
      ctx.lineTo(x, y);
    }
    
    // Decay curve (exponential)
    const decaySteps = 20;
    for (let i = 0; i <= decaySteps; i++) {
      const t = i / decaySteps;
      const x = pos.attack.x + (pos.decay.x - pos.attack.x) * t;
      const y = pos.attack.y + (pos.decay.y - pos.attack.y) * (1 - Math.pow(1 - t, 2));
      ctx.lineTo(x, y);
    }
    
    // Sustain line
    ctx.lineTo(pos.sustainEnd.x, pos.sustainEnd.y);
    
    // Release curve (exponential)
    const releaseSteps = 20;
    for (let i = 0; i <= releaseSteps; i++) {
      const t = i / releaseSteps;
      const x = pos.sustainEnd.x + (pos.release.x - pos.sustainEnd.x) * t;
      const y = pos.sustainEnd.y + (pos.release.y - pos.sustainEnd.y) * (1 - Math.pow(1 - t, 3));
      ctx.lineTo(x, y);
    }
    
    ctx.lineTo(pos.start.x, pos.start.y);
    ctx.closePath();
    
    // Fill gradient
    const gradient = ctx.createLinearGradient(0, pos.padding, 0, height - pos.padding);
    gradient.addColorStop(0, color + '40');
    gradient.addColorStop(1, color + '05');
    ctx.fillStyle = gradient;
    ctx.fill();
    
    // Draw curve line
    ctx.beginPath();
    ctx.moveTo(pos.start.x, pos.start.y);
    
    // Attack curve
    for (let i = 0; i <= attackSteps; i++) {
      const t = i / attackSteps;
      const x = pos.start.x + (pos.attack.x - pos.start.x) * t;
      const y = pos.start.y + (pos.attack.y - pos.start.y) * Math.pow(t, 0.5);
      ctx.lineTo(x, y);
    }
    
    // Decay curve
    for (let i = 0; i <= decaySteps; i++) {
      const t = i / decaySteps;
      const x = pos.attack.x + (pos.decay.x - pos.attack.x) * t;
      const y = pos.attack.y + (pos.decay.y - pos.attack.y) * (1 - Math.pow(1 - t, 2));
      ctx.lineTo(x, y);
    }
    
    // Sustain line
    ctx.lineTo(pos.sustainEnd.x, pos.sustainEnd.y);
    
    // Release curve
    for (let i = 0; i <= releaseSteps; i++) {
      const t = i / releaseSteps;
      const x = pos.sustainEnd.x + (pos.release.x - pos.sustainEnd.x) * t;
      const y = pos.sustainEnd.y + (pos.release.y - pos.sustainEnd.y) * (1 - Math.pow(1 - t, 3));
      ctx.lineTo(x, y);
    }
    
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    
    // Draw control points
    const drawPoint = (x: number, y: number, isHovered: boolean, isDragging: boolean) => {
      const radius = isDragging ? 8 : (isHovered ? 7 : 5);
      
      // Outer glow
      if (isHovered || isDragging) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
        ctx.fillStyle = color + '30';
        ctx.fill();
      }
      
      // Point
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isDragging ? '#fff' : color;
      ctx.fill();
      
      // Inner highlight
      ctx.beginPath();
      ctx.arc(x, y, radius - 2, 0, Math.PI * 2);
      ctx.fillStyle = isDragging ? color : '#fff';
      ctx.fill();
    };
    
    drawPoint(pos.attack.x, pos.attack.y, hoveredTarget === 'attack', dragTarget === 'attack');
    drawPoint(pos.decay.x, pos.decay.y, hoveredTarget === 'decay', dragTarget === 'decay');
    drawPoint(pos.sustainEnd.x, pos.sustainEnd.y, hoveredTarget === 'sustain', dragTarget === 'sustain');
    
    // Labels
    if (showLabels) {
      ctx.font = 'bold 9px Inter, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.fillText('A', pos.attack.x - 3, height - 5);
      ctx.fillText('D', pos.decay.x - 3, height - 5);
      ctx.fillText('S', pos.sustainEnd.x - 3, height - 5);
      ctx.fillText('R', pos.release.x - 3, height - 5);
    }
    
  }, [getPositions, width, height, color, showLabels, hoveredTarget, dragTarget]);
  
  // Redraw on changes
  useEffect(() => {
    draw();
  }, [draw]);
  
  // Mouse interaction
  const handleMouseDown = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const pos = getPositions();
    
    // Check which point is clicked
    const hitRadius = 15;
    
    if (Math.hypot(x - pos.attack.x, y - pos.attack.y) < hitRadius) {
      setDragTarget('attack');
    } else if (Math.hypot(x - pos.decay.x, y - pos.decay.y) < hitRadius) {
      setDragTarget('decay');
    } else if (Math.hypot(x - pos.sustainEnd.x, y - pos.sustainEnd.y) < hitRadius) {
      setDragTarget('sustain');
    }
  };
  
  const handleMouseMove = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const pos = getPositions();
    
    if (dragTarget) {
      const padding = pos.padding;
      const usableWidth = pos.usableWidth;
      const usableHeight = pos.usableHeight;
      const totalTime = maxAttack + maxDecay + maxRelease;
      const pxPerSecond = usableWidth / totalTime;
      
      let newValues = { ...values };
      
      if (dragTarget === 'attack') {
        const attackPx = Math.max(0, Math.min(usableWidth * 0.3, x - padding));
        newValues.attack = attackPx / pxPerSecond;
      } else if (dragTarget === 'decay') {
        const decayPx = Math.max(0, Math.min(usableWidth * 0.3, x - pos.attack.x));
        newValues.decay = decayPx / pxPerSecond;
        
        // Also adjust sustain level from Y
        const sustainLevel = 1 - Math.max(0, Math.min(1, (y - padding) / usableHeight));
        newValues.sustain = sustainLevel;
      } else if (dragTarget === 'sustain') {
        // Only adjust sustain level
        const sustainLevel = 1 - Math.max(0, Math.min(1, (y - padding) / usableHeight));
        newValues.sustain = sustainLevel;
      }
      
      onChange(newValues);
    } else {
      // Hover detection
      const hitRadius = 15;
      if (Math.hypot(x - pos.attack.x, y - pos.attack.y) < hitRadius) {
        setHoveredTarget('attack');
      } else if (Math.hypot(x - pos.decay.x, y - pos.decay.y) < hitRadius) {
        setHoveredTarget('decay');
      } else if (Math.hypot(x - pos.sustainEnd.x, y - pos.sustainEnd.y) < hitRadius) {
        setHoveredTarget('sustain');
      } else {
        setHoveredTarget(null);
      }
    }
  }, [dragTarget, values, onChange, getPositions, maxAttack, maxDecay, maxRelease]);
  
  const handleMouseUp = () => {
    setDragTarget(null);
  };
  
  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove]);
  
  return (
    <div className="relative" style={{ width, height }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        onMouseDown={handleMouseDown}
        className={`block rounded-lg border border-white/10 ${hoveredTarget || dragTarget ? 'cursor-pointer' : 'cursor-default'}`}
      />
      
      {/* Value display */}
      {showValues && (
        <div className="absolute top-2 right-2 bg-black/60 rounded px-2 py-1 text-[8px] font-mono text-slate-400">
          <div>A: {values.attack.toFixed(2)}s</div>
          <div>D: {values.decay.toFixed(2)}s</div>
          <div>S: {(values.sustain * 100).toFixed(0)}%</div>
          <div>R: {values.release.toFixed(2)}s</div>
        </div>
      )}
    </div>
  );
};

export default EnvelopeEditor;
