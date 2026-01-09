
import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { Track, AutomationLane, AutomationPoint } from '../types';
import AutomationLaneComponent from './AutomationLane';
import { audioEngine } from '../engine/AudioEngine';

interface AutomationEditorViewProps {
  tracks: Track[];
  currentTime: number;
  bpm: number;
  zoomH: number;
  onUpdateTrack: (track: Track) => void;
  onSeek: (time: number) => void;
}

const AutomationEditorView: React.FC<AutomationEditorViewProps> = ({
  tracks,
  currentTime,
  bpm,
  zoomH: initialZoomH,
  onUpdateTrack,
  onSeek
}) => {
  const [zoomH, setZoomH] = useState(initialZoomH);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [paramMenuOpen, setParamMenuOpen] = useState<string | null>(null); // Track ID for menu
  
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null); // For Ruler/Grid
  const requestRef = useRef<number>(0);

  // Sync scrolling
  const handleScroll = () => {
    if (scrollContainerRef.current) {
        setScrollLeft(scrollContainerRef.current.scrollLeft);
        if (sidebarContainerRef.current) {
            sidebarContainerRef.current.scrollTop = scrollContainerRef.current.scrollTop;
        }
    }
  };

  // Time conversion
  const timeToPixels = useCallback((time: number) => time * zoomH, [zoomH]);
  const pixelsToTime = useCallback((pixels: number) => pixels / zoomH, [zoomH]);

  const totalWidth = useMemo(() => {
    const maxClipEnd = Math.max(...tracks.flatMap(t => t.clips.map(c => c.start + c.duration)), 300);
    return (maxClipEnd + 60) * zoomH;
  }, [tracks, zoomH]);

  // Handle adding a new lane
  const addAutomationLane = (track: Track, paramId: string, min: number = 0, max: number = 1) => {
      // Check if already exists
      if (track.automationLanes.some(l => l.parameterName === paramId)) return;

      const initialVal = paramId === 'volume' ? track.volume : (paramId === 'pan' ? track.pan : 0.5);

      const newLane: AutomationLane = {
          id: `auto-${Date.now()}`,
          parameterName: paramId,
          points: [{ id: 'init', time: 0, value: initialVal }],
          color: track.color,
          isExpanded: true,
          min,
          max
      };
      
      onUpdateTrack({ ...track, automationLanes: [...track.automationLanes, newLane] });
      setParamMenuOpen(null);
  };

  // Get available parameters for a track (Native + Plugins)
  const getAvailableParameters = (track: Track) => {
      const params = [
          { id: 'volume', name: 'Volume', min: 0, max: 1.5 },
          { id: 'pan', name: 'Pan', min: -1, max: 1 }
      ];
      
      // Sends
      track.sends.forEach(s => {
          params.push({ id: `send::${s.id}`, name: `Send: ${s.id.replace('send-','').toUpperCase()}`, min: 0, max: 1.5 });
      });

      // Plugins
      const pluginParams = audioEngine.getTrackPluginParameters(track.id);
      pluginParams.forEach(pp => {
          pp.params.forEach(p => {
              params.push({ 
                  id: `plugin::${pp.pluginId}::${p.id}`, 
                  name: `${pp.pluginName}: ${p.name}`, 
                  min: p.min, 
                  max: p.max 
              });
          });
      });

      return params;
  };

  // Render Grid & Playhead (simplified version of ArrangementView)
  const drawRuler = () => {
      const canvas = canvasRef.current;
      if (!canvas || !scrollContainerRef.current) return;
      
      const width = scrollContainerRef.current.clientWidth;
      const height = canvas.height;
      
      if (canvas.width !== width) canvas.width = width;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const isLight = document.documentElement.getAttribute('data-theme') === 'light';
      // Colors
      const HEADER_BG = isLight ? '#0f172a' : '#0c0d10'; // Navy Header
      const GRID_COLOR = isLight ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255,255,255,0.1)';
      const TEXT_COLOR = isLight ? '#f1f5f9' : '#64748b'; // White text in header
      const PH_COLOR = isLight ? '#38bdf8' : '#00f2ff';

      // 1. Clear Canvas (Transparent Body)
      // Correction Critique : On efface TOUT et on ne redessine PAS de fond opaque sur le corps.
      ctx.clearRect(0, 0, width, height);
      
      // 2. Header Background (Opaque uniquement en haut)
      ctx.fillStyle = HEADER_BG;
      ctx.fillRect(0, 0, width, 40); // Header height

      // Grid Lines
      const beatPx = (60 / bpm) * zoomH;
      const startTime = pixelsToTime(scrollLeft);
      const endTime = pixelsToTime(scrollLeft + width);
      const startBar = Math.floor(startTime * (bpm / 60) / 4);
      const endBar = Math.ceil(endTime * (bpm / 60) / 4);

      ctx.strokeStyle = GRID_COLOR;
      ctx.fillStyle = TEXT_COLOR;
      ctx.font = 'bold 10px Inter';
      ctx.lineWidth = 1;

      for (let i = startBar; i <= endBar; i++) {
          const time = i * 4 * (60 / bpm);
          const x = timeToPixels(time) - scrollLeft;
          
          if (x >= 0 && x <= width) {
              // Bar Line (Vertical Grid)
              ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
              // Text only in header
              ctx.fillText((i+1).toString(), x + 4, 24);
          }
      }

      // Playhead
      const phX = timeToPixels(currentTime) - scrollLeft;
      if (phX >= 0 && phX <= width) {
          ctx.strokeStyle = PH_COLOR;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, height); ctx.stroke();
          ctx.fillStyle = PH_COLOR;
          ctx.beginPath(); ctx.moveTo(phX-5, 0); ctx.lineTo(phX+5, 0); ctx.lineTo(phX, 10); ctx.fill();
      }

      requestRef.current = requestAnimationFrame(drawRuler);
  };

  useEffect(() => {
      requestRef.current = requestAnimationFrame(drawRuler);
      return () => cancelAnimationFrame(requestRef.current);
  }, [scrollLeft, currentTime, zoomH, bpm]);

  // Pointer handling for Seek
  const handleRulerClick = (e: React.MouseEvent) => {
      const rect = scrollContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left + scrollLeft;
      onSeek(Math.max(0, pixelsToTime(x)));
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--bg-main)' }}>
      {/* TOOLBAR */}
      <div className="h-10 border-b flex items-center justify-between px-4" style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-dim)' }}>
         <div className="flex items-center space-x-4">
            <span className="text-[10px] font-black uppercase tracking-widest" style={{ color: 'var(--accent-neon)' }}>Automation Editor</span>
            <div className="h-4 w-px bg-white/10"></div>
            <div className="flex items-center space-x-2">
                <i className="fas fa-search-plus text-[10px]" style={{ color: 'var(--text-secondary)' }}></i>
                <input type="range" min="10" max="200" value={zoomH} onChange={e => setZoomH(Number(e.target.value))} className="w-20 h-1 bg-white/10 rounded-full accent-cyan-500" />
            </div>
         </div>
         <div className="text-[9px] font-mono" style={{ color: 'var(--text-secondary)' }}>SHIFT + Click to snap</div>
      </div>

      <div className="flex-1 flex overflow-hidden relative">
         {/* SIDEBAR */}
         <div ref={sidebarContainerRef} className="w-64 border-r overflow-hidden flex-shrink-0 pt-10" style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-dim)' }}>
            {tracks.map(track => {
                return (
                    <div key={track.id} className="border-b" style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-dim)' }}>
                        {/* Track Header in Automation View */}
                        <div className="h-10 flex items-center justify-between px-3 border-l-4" style={{ backgroundColor: 'var(--bg-item)', borderLeftColor: track.color }}>
                            <span className="text-[10px] font-black uppercase truncate w-32" style={{ color: 'var(--text-primary)' }} title={track.name}>{track.name}</span>
                            <div className="relative">
                                <button 
                                    onClick={() => setParamMenuOpen(paramMenuOpen === track.id ? null : track.id)}
                                    className="w-5 h-5 rounded flex items-center justify-center bg-white/10 hover:bg-cyan-500 hover:text-black text-slate-400 transition-colors"
                                    title="Add Automation Parameter"
                                >
                                    <i className="fas fa-plus text-[8px]"></i>
                                </button>
                                {/* Dropdown Menu for Parameters */}
                                {paramMenuOpen === track.id && (
                                    <div className="absolute top-6 right-0 w-48 border shadow-2xl rounded-lg z-50 max-h-60 overflow-y-auto" style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-dim)' }}>
                                        <div className="px-2 py-1 text-[8px] font-black uppercase bg-black/20" style={{ color: 'var(--text-secondary)' }}>Add Parameter</div>
                                        {getAvailableParameters(track).map(p => (
                                            <button 
                                                key={p.id}
                                                onClick={() => addAutomationLane(track, p.id, p.min, p.max)}
                                                className="w-full text-left px-3 py-2 text-[9px] hover:bg-cyan-500/20 border-b last:border-0 truncate"
                                                style={{ color: 'var(--text-primary)', borderColor: 'var(--border-dim)' }}
                                            >
                                                {p.name}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Lane Headers */}
                        {track.automationLanes.map(lane => (
                            <div key={lane.id} className="h-20 border-b last:border-0 relative" style={{ borderColor: 'var(--border-dim)' }}>
                                <AutomationLaneComponent 
                                    trackId={track.id}
                                    lane={lane}
                                    width={0}
                                    zoomH={zoomH}
                                    scrollLeft={0}
                                    onUpdatePoints={() => {}}
                                    onRemoveLane={() => {
                                        const newLanes = track.automationLanes.filter(l => l.id !== lane.id);
                                        onUpdateTrack({ ...track, automationLanes: newLanes });
                                    }}
                                    variant="header"
                                />
                            </div>
                        ))}
                        
                        {track.automationLanes.length === 0 && (
                            <div className="h-8 flex items-center justify-center text-[8px] italic bg-black/5" style={{ color: 'var(--text-secondary)' }}>
                                No automation
                            </div>
                        )}
                    </div>
                );
            })}
            {/* Spacer at bottom */}
            <div className="h-96"></div>
         </div>

         {/* MAIN CONTENT */}
         <div 
            ref={scrollContainerRef}
            className="flex-1 overflow-auto relative custom-scroll"
            onScroll={handleScroll}
         >
            {/* Canvas Overlay for Ruler/Grid/Playhead */}
            {/* IMPORTANT: pointer-events-none ensures clicks go through to lanes */}
            <canvas 
                ref={canvasRef}
                height={window.innerHeight} // Will resize dynamically
                className="sticky top-0 left-0 z-30 pointer-events-none"
                style={{ width: '100%', height: '100%', position: 'absolute' }}
            />
            
            {/* Invisible Hit Area for Ruler Click only in top 40px */}
            <div 
                className="absolute top-0 left-0 right-0 h-10 z-40 cursor-pointer" 
                style={{ width: totalWidth }}
                onMouseDown={handleRulerClick}
            />

            <div style={{ width: totalWidth, paddingTop: '40px' }}>
                {tracks.map(track => (
                    <div key={track.id} style={{ backgroundColor: 'transparent' }}>
                        {/* Spacer for Track Header Height (10px padding roughly) */}
                        <div className="h-10 border-b border-l opacity-10" style={{ borderColor: 'var(--border-dim)' }}></div>

                        {track.automationLanes.map(lane => (
                            <div key={lane.id} className="h-20 relative">
                                <AutomationLaneComponent 
                                    trackId={track.id}
                                    lane={lane}
                                    width={totalWidth}
                                    zoomH={zoomH}
                                    scrollLeft={scrollLeft}
                                    onUpdatePoints={(points) => {
                                        const newLanes = track.automationLanes.map(l => l.id === lane.id ? { ...l, points } : l);
                                        onUpdateTrack({ ...track, automationLanes: newLanes });
                                    }}
                                    onRemoveLane={() => {}} 
                                    variant="body"
                                />
                            </div>
                        ))}
                         {track.automationLanes.length === 0 && <div className="h-8 bg-black/5 border-b" style={{ borderColor: 'var(--border-dim)' }}></div>}
                    </div>
                ))}
                <div className="h-96"></div>
            </div>
         </div>
      </div>
    </div>
  );
};

export default AutomationEditorView;
