
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { AutomationLane as IAutomationLane, AutomationPoint } from '../types';

interface AutomationLaneProps {
  trackId: string;
  lane: IAutomationLane;
  width: number; // Largeur totale du contenu (virtuel)
  zoomH: number; // Pixels par seconde
  onUpdatePoints: (points: AutomationPoint[]) => void;
  onRemoveLane: () => void;
  scrollLeft: number;
  variant?: 'header' | 'body'; // Nouveau prop pour différencier l'affichage
}

const AutomationLane: React.FC<AutomationLaneProps> = ({ 
  trackId, lane, width, zoomH, onUpdatePoints, onRemoveLane, scrollLeft, variant = 'body'
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // État local pour le drag
  const [draggingPointId, setDraggingPointId] = useState<string | null>(null);
  const [hoveredPointId, setHoveredPointId] = useState<string | null>(null);
  
  // Constantes visuelles "Haute Visibilité"
  const POINT_RADIUS = 6; 
  const POINT_HIT_RADIUS = 12;
  const LANE_HEIGHT = 80;
  const LINE_WIDTH = 3;

  // --- HELPERS DE CONVERSION ---
  const timeToX = (time: number) => time * zoomH;
  const xToTime = (x: number) => Math.max(0, x / zoomH);
  
  const valToY = (val: number) => {
    const range = lane.max - lane.min;
    const normalized = (val - lane.min) / range;
    return (LANE_HEIGHT - 10) - (normalized * (LANE_HEIGHT - 20));
  };

  const yToVal = (y: number) => {
    const range = lane.max - lane.min;
    const normalized = 1 - ((y - 10) / (LANE_HEIGHT - 20));
    const clampedNorm = Math.max(0, Math.min(1, normalized));
    return lane.min + (clampedNorm * range);
  };

  // --- RENDU CANVAS ---
  const draw = useCallback(() => {
    if (variant === 'header') return; 

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // THEME DETECTION
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const BG_COLOR = isLight ? '#334155' : '#16191f'; 
    const GRID_COLOR = isLight ? 'rgba(255, 255, 255, 0.1)' : '#2a2e38';
    const GUIDE_COLOR = isLight ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.3)';

    // Nettoyage
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Fond (Redondant avec CSS mais utile pour l'export image)
    ctx.fillStyle = BG_COLOR; 
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grille légère horizontale
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 10); ctx.lineTo(canvas.width, 10);
    ctx.moveTo(0, LANE_HEIGHT / 2); ctx.lineTo(canvas.width, LANE_HEIGHT / 2); 
    ctx.moveTo(0, LANE_HEIGHT - 10); ctx.lineTo(canvas.width, LANE_HEIGHT - 10);
    ctx.stroke();

    // Rendu de la courbe (Jaune / Couleur Piste)
    const lineColor = lane.color || '#eab308'; // Default Yellow if no color

    if (lane.points.length === 0) {
        // Mode "Pas de points" : Ligne continue valeur par défaut
        // Pour le volume c'est souvent 1.0 (env 70%)
        const defaultVal = lane.parameterName === 'volume' ? 1.0 : (lane.min + (lane.max - lane.min) * 0.5);
        const defaultY = valToY(defaultVal); 
        
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.5; // Semi-transparent pour ligne "fantôme"
        ctx.beginPath();
        ctx.moveTo(0, defaultY);
        ctx.lineTo(canvas.width, defaultY);
        ctx.stroke();
        ctx.globalAlpha = 1.0;
        
        ctx.fillStyle = isLight ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.5)';
        ctx.font = 'bold 10px Inter';
        ctx.textAlign = 'left';
        ctx.fillText(`Click to automate ${lane.parameterName}`, scrollLeft + 20, defaultY - 5);
        return;
    }

    const sortedPoints = [...lane.points].sort((a, b) => a.time - b.time);

    // 1. Dessin de la zone remplie (Fill)
    ctx.beginPath();
    ctx.moveTo(0, LANE_HEIGHT); // Coin bas gauche
    
    // Point de départ (extrapolation à t=0)
    ctx.lineTo(0, valToY(sortedPoints[0].value)); 

    sortedPoints.forEach(p => {
      ctx.lineTo(timeToX(p.time), valToY(p.value));
    });
    
    // Extrapolation jusqu'à la fin
    const lastPoint = sortedPoints[sortedPoints.length - 1];
    ctx.lineTo(canvas.width, valToY(lastPoint.value));
    
    // Fermeture
    ctx.lineTo(canvas.width, LANE_HEIGHT);
    ctx.closePath();

    ctx.fillStyle = `${lineColor}33`; // 20% opacité
    ctx.fill();

    // 2. Dessin de la LIGNE (Curve) - Haute Visibilité
    ctx.beginPath();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = LINE_WIDTH;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    
    // Glow effect (Dark mode only)
    if (!isLight) {
        ctx.shadowBlur = 8;
        ctx.shadowColor = lineColor;
    }

    // Premier segment (t=0 au premier point)
    ctx.moveTo(0, valToY(sortedPoints[0].value));
    
    sortedPoints.forEach(p => {
      ctx.lineTo(timeToX(p.time), valToY(p.value));
    });
    
    // Dernier segment (dernier point à infini)
    ctx.lineTo(canvas.width, valToY(lastPoint.value));
    
    ctx.stroke();
    ctx.shadowBlur = 0; // Reset glow

    // 3. Dessin des POINTS
    sortedPoints.forEach(p => {
      const cx = timeToX(p.time);
      const cy = valToY(p.value);
      
      const isHovered = p.id === hoveredPointId;
      const isDragging = p.id === draggingPointId;

      ctx.beginPath();
      ctx.arc(cx, cy, isHovered || isDragging ? POINT_RADIUS + 2 : POINT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = isLight ? '#fff' : '#ffffff'; 
      if (isLight) {
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = 1;
          ctx.stroke();
      }
      ctx.fill();
      
      // Centre coloré
      ctx.beginPath();
      ctx.arc(cx, cy, (isHovered || isDragging ? POINT_RADIUS + 2 : POINT_RADIUS) - 2, 0, Math.PI * 2);
      ctx.fillStyle = isDragging ? '#000' : lineColor;
      ctx.fill();

      if (isHovered || isDragging) {
        const text = p.value.toFixed(2);
        const textWidth = ctx.measureText(text).width;
        ctx.fillStyle = isLight ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.8)';
        ctx.fillRect(cx - textWidth/2 - 4, cy - 25, textWidth + 8, 16);
        
        ctx.fillStyle = lineColor;
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(text, cx, cy - 13);
      }
    });

  }, [lane, width, zoomH, hoveredPointId, draggingPointId, variant, scrollLeft]);

  useEffect(() => {
    draw();
  }, [draw]);

  // --- INTERACTIONS SOURIS ---
  const getPointAtPos = (x: number, y: number) => {
    return lane.points.find(p => {
      const px = timeToX(p.time);
      const py = valToY(p.value);
      return Math.sqrt(Math.pow(x - px, 2) + Math.pow(y - py, 2)) < POINT_HIT_RADIUS;
    });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (variant === 'header') return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollLeft; 
    const y = e.clientY - rect.top;

    const existingPoint = getPointAtPos(x, y);

    if (existingPoint) {
      setDraggingPointId(existingPoint.id);
    } else {
      const newValue = yToVal(y);
      const newTime = xToTime(x);
      
      const newPoint: AutomationPoint = {
        id: `pt-${Date.now()}`,
        time: newTime,
        value: newValue
      };
      
      const newPoints = [...lane.points, newPoint].sort((a, b) => a.time - b.time);
      onUpdatePoints(newPoints);
      setDraggingPointId(newPoint.id);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (variant === 'header') return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollLeft;
    const y = e.clientY - rect.top;

    if (draggingPointId) {
      const newTime = Math.max(0, xToTime(x));
      const newValue = yToVal(y);

      const updatedPoints = lane.points.map(p => {
        if (p.id === draggingPointId) {
          return { ...p, time: newTime, value: newValue };
        }
        return p;
      });
      onUpdatePoints(updatedPoints);
    } else {
      const point = getPointAtPos(x, y);
      setHoveredPointId(point ? point.id : null);
      if (point) document.body.style.cursor = 'grab';
      else document.body.style.cursor = 'cell'; 
    }
  };

  const handleMouseUp = () => {
    if (variant === 'header') return;
    setDraggingPointId(null);
    document.body.style.cursor = 'default';
    const sorted = [...lane.points].sort((a, b) => a.time - b.time);
    onUpdatePoints(sorted); 
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (variant === 'header') return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollLeft;
    const y = e.clientY - rect.top;
    
    const point = getPointAtPos(x, y);
    if (point) {
      const filtered = lane.points.filter(p => p.id !== point.id);
      onUpdatePoints(filtered);
      setHoveredPointId(null);
    }
  };

  const displayName = lane.parameterName.replace('plugin::', '').replace('send::', 'Send ').toUpperCase();

  if (variant === 'header') {
    return (
      <div 
        className="w-full flex items-center justify-between px-4 z-20 relative shadow-lg border-r border-b"
        style={{ height: LANE_HEIGHT, backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-dim)' }}
      >
        <div className="flex items-center space-x-3 overflow-hidden">
           <div className="w-8 h-8 rounded-lg flex items-center justify-center border" style={{ backgroundColor: 'var(--bg-item)', borderColor: 'var(--border-dim)' }}>
             <i className="fas fa-wave-square text-[10px]" style={{ color: lane.color }}></i>
           </div>
           <div className="flex flex-col min-w-0">
              <span className="text-[9px] font-black uppercase tracking-widest truncate" title={displayName} style={{ color: 'var(--text-primary)' }}>
                {displayName}
              </span>
              <span className="text-[7px] font-mono" style={{ color: 'var(--text-secondary)' }}>
                {lane.min.toFixed(1)} - {lane.max.toFixed(1)}
              </span>
           </div>
        </div>
        <button 
          onClick={onRemoveLane}
          className="w-6 h-6 rounded flex items-center justify-center hover:bg-red-500/20 text-slate-600 hover:text-red-400 transition-colors"
          title="Remove Automation Lane"
        >
          <i className="fas fa-times text-[10px]"></i>
        </button>
      </div>
    );
  }

  // Variant Body (Canvas)
  // AJOUT DE BACKGROUND COLOR FALLBACK DANS LE STYLE pour les cas de lag canvas
  return (
    <div 
      ref={containerRef}
      className="relative overflow-hidden w-full h-full border-b group"
      style={{ 
          height: LANE_HEIGHT, 
          backgroundColor: 'var(--bg-main)', // Use CSS var instead of hardcoded hex
          borderColor: 'var(--border-dim)' 
      }}
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={LANE_HEIGHT}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        className="absolute top-0 left-0"
      />
    </div>
  );
};

export default AutomationLane;
