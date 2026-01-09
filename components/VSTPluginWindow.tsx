
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { novaBridge } from '../services/NovaBridge';
import { PluginInstance } from '../types';

interface VSTPluginWindowProps {
  plugin: PluginInstance;
  onClose: () => void;
}

const VSTPluginWindow: React.FC<VSTPluginWindowProps> = ({ plugin, onClose }) => {
  const canvasRef = useRef<HTMLImageElement>(null);
  const [status, setStatus] = useState<string>('Connecting to VST Bridge...');
  
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
    } else {
        setStatus('Error: Missing Plugin Path');
    }

    // 2. Subscription au flux UI
    const unsubscribe = novaBridge.subscribeToUI((base64Image) => {
        if (canvasRef.current) {
            canvasRef.current.src = `data:image/jpeg;base64,${base64Image}`;
            if (status !== 'Active') setStatus('Active');
        }
    });

    return () => {
      unsubscribe();
      novaBridge.unloadPlugin();
    };
  }, [plugin]);

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
      
      // Envoi du Clic
      novaBridge.click(x, y, 'left');
      
      // Préparation Drag
      isDragging.current = true;
      dragStart.current = { x, y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
      if (!isDragging.current) return;
      
      const { x, y } = getCoords(e);
      
      // Envoi Drag
      novaBridge.drag(dragStart.current.x, dragStart.current.y, x, y);
  };

  const handleMouseUp = (e: React.MouseEvent) => {
      if (isDragging.current) {
          isDragging.current = false;
      }
  };

  const handleWheel = (e: React.WheelEvent) => {
      const { x, y } = getCoords(e);
      // DeltaY positive = down, negative = up
      const delta = e.deltaY > 0 ? -1 : 1; 
      novaBridge.scroll(x, y, delta);
  };

  return (
    <div className="flex flex-col bg-[#1e2229] border border-white/10 rounded-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
      
      {/* WINDOW HEADER */}
      <div className="h-8 bg-[#0c0d10] border-b border-white/10 flex items-center justify-between px-3 select-none cursor-move">
        <div className="flex items-center space-x-2">
            <div className={`w-2 h-2 rounded-full ${status === 'Active' ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`}></div>
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
         {/* L'image est affichée directement */}
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
         
         {status !== 'Active' && (
             <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/50">
                 <div className="flex flex-col items-center space-y-2">
                     <i className="fas fa-satellite-dish text-2xl text-slate-700 animate-pulse"></i>
                     <span className="text-[9px] text-slate-500 font-mono">{status}</span>
                 </div>
             </div>
         )}
      </div>
      
      {/* FOOTER CONTROLS */}
      <div className="h-6 bg-[#0c0d10] border-t border-white/5 flex items-center justify-between px-2">
         <span className="text-[8px] font-mono text-slate-600">NOVA BRIDGE v3.0 • PROTOCOL VST</span>
         <div className="flex space-x-2">
             <i className="fas fa-wifi text-[8px] text-green-500" title="Connected"></i>
         </div>
      </div>
    </div>
  );
};

export default VSTPluginWindow;
