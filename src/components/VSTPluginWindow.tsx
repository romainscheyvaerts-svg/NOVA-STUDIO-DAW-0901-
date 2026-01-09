
import React, { useRef, useEffect, useState } from 'react';
import { novaBridge, PluginParameter } from '../services/NovaBridge';
import { PluginInstance } from '../types';

interface VSTPluginWindowProps {
  plugin: PluginInstance;
  trackId?: string;
  onClose: () => void;
}

const VSTPluginWindow: React.FC<VSTPluginWindowProps> = ({ plugin, trackId, onClose }) => {
  const canvasRef = useRef<HTMLImageElement>(null);
  const [status, setStatus] = useState<string>('Connecting to VST Bridge...');
  const [params, setParams] = useState<PluginParameter[]>([]);
  
  // Drag State
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });

  useEffect(() => {
    // 1. Initialisation : Charger le plugin via le chemin stocké
    const pluginPath = plugin.params?.localPath;
    
    if (pluginPath) {
        console.log(`[VST Window] Loading ${plugin.name} from ${pluginPath}`);
        novaBridge.loadPlugin(pluginPath, 44100);
        setStatus('Loading Plugin...');
        
        // 🎵 NOUVEAU: Activer le streaming audio
        import('../engine/AudioEngine').then(({ audioEngine }) => {
          // Trouver le trackId depuis props ou params
          const tid = trackId || plugin.params?.trackId;
          
          if (tid) {
            audioEngine.enableVSTAudioStreaming(tid, plugin.id)
              .then(() => {
                console.log('✅ [VST Window] Audio streaming enabled');
                setStatus('Active (Audio Streaming)');
              })
              .catch(err => {
                console.error('❌ [VST Window] Audio streaming failed:', err);
                setStatus('Active (No Audio)');
              });
          } else {
             console.warn('[VST Window] Track ID missing for streaming');
             setStatus('Active (No Audio - No Track ID)');
          }
        });
    } else {
        setStatus('Error: Missing Plugin Path');
    }

    // 2. Subscription au flux UI
    const unsubscribeUI = novaBridge.subscribeToUI((base64Image) => {
        if (canvasRef.current) {
            canvasRef.current.src = `data:image/jpeg;base64,${base64Image}`;
            if (status.indexOf('Active') === -1) setStatus('Active');
        }
    });

    // 3. Subscription aux paramètres
    const unsubscribeParams = novaBridge.subscribeToParams(setParams);

    return () => {
      unsubscribeUI();
      unsubscribeParams();
      novaBridge.unloadPlugin();
      
      // 🛑 NOUVEAU: Désactiver le streaming audio
      import('../engine/AudioEngine').then(({ audioEngine }) => {
        audioEngine.disableVSTAudioStreaming();
      });
    };
  }, [plugin, trackId]);

  // --- MOUSE EVENTS MAPPING ---

  const getCoords = (e: React.MouseEvent) => {
      const rect = e.currentTarget.getBoundingClientRect();
      return {
          x: Math.round(e.clientX - rect.left),
          y: Math.round(e.clientY - rect.top)
      };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
      e.preventDefault();
      const { x, y } = getCoords(e);
      novaBridge.click(x, y, 'left');
      isDragging.current = true;
      dragStart.current = { x, y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
      if (!isDragging.current) return;
      const { x, y } = getCoords(e);
      novaBridge.drag(dragStart.current.x, dragStart.current.y, x, y);
  };

  const handleMouseUp = (e: React.MouseEvent) => {
      if (isDragging.current) {
          isDragging.current = false;
      }
  };

  const handleWheel = (e: React.WheelEvent) => {
      const { x, y } = getCoords(e);
      const delta = e.deltaY > 0 ? -1 : 1; 
      novaBridge.scroll(x, y, delta);
  };

  return (
    <div className="flex flex-col bg-[#1e2229] border border-white/10 rounded-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
      
      {/* WINDOW HEADER */}
      <div className="h-8 bg-[#0c0d10] border-b border-white/10 flex items-center justify-between px-3 select-none cursor-move">
        <div className="flex items-center space-x-2">
            <div className={`w-2 h-2 rounded-full ${status.includes('Active') ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`}></div>
            <span className="text-[10px] font-black text-white uppercase tracking-widest">{plugin.name} (VST3)</span>
        </div>
        <div className="flex items-center space-x-2">
            <span className="text-[8px] font-mono text-slate-500">{status}</span>
            <button onClick={onClose} className="text-slate-500 hover:text-red-500 transition-colors">
                <i className="fas fa-times text-xs"></i>
            </button>
        </div>
      </div>

      {/* VST VIEWPORT (IMG based for simplicity with base64 src) */}
      <div className="relative bg-black flex items-center justify-center overflow-hidden min-w-[400px] min-h-[300px]">
         <img 
            ref={canvasRef}
            className="cursor-crosshair block max-w-full max-h-[80vh]"
            alt="VST Interface"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onWheel={handleWheel}
            draggable={false}
         />
         
         {!status.includes('Active') && (
             <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/50">
                 <div className="flex flex-col items-center space-y-2">
                     <i className="fas fa-satellite-dish text-2xl text-slate-700 animate-pulse"></i>
                     <span className="text-[9px] text-slate-500 font-mono">{status}</span>
                 </div>
             </div>
         )}
      </div>
      
      {/* PARAMETERS PANEL (BOTTOM) */}
      <div className="p-3 bg-[#0f1115] border-t border-white/10 max-h-40 overflow-y-auto custom-scroll">
         <h4 className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2">Automations & Controls</h4>
         <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {params.map(p => (
                <div key={p.name} className="flex flex-col space-y-1">
                    <div className="flex justify-between items-center text-[8px]">
                        <span className="text-slate-300 font-bold truncate pr-2">{p.display_name}</span>
                        <span className="text-cyan-500 font-mono">{p.value.toFixed(2)}</span>
                    </div>
                    <input 
                        type="range" 
                        min="0" max="1" step="0.001"
                        value={p.value}
                        onChange={(e) => novaBridge.setParam(p.name, parseFloat(e.target.value))}
                        className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-cyan-500"
                    />
                </div>
            ))}
         </div>
         {params.length === 0 && <div className="text-[8px] text-slate-600 text-center py-2">Aucun paramètre exposé</div>}
      </div>

      {/* FOOTER CONTROLS */}
      <div className="h-6 bg-[#0c0d10] border-t border-white/5 flex items-center justify-between px-2">
         <span className="text-[8px] font-mono text-slate-600">NOVA BRIDGE v3.1 • PROTOCOL VST</span>
         <div className="flex space-x-2">
             <i className="fas fa-wifi text-[8px] text-green-500" title="Connected"></i>
         </div>
      </div>
    </div>
  );
};

export default VSTPluginWindow;
