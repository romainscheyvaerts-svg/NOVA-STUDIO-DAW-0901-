import React, { useRef, useEffect, useState, useCallback } from 'react';
import { novaBridge } from '../services/NovaBridge';
import { PluginInstance } from '../types';

interface VSTPluginWindowProps {
  plugin: PluginInstance;
  onClose: () => void;
  trackId?: string;  // Track ID for multi-instance support
  pluginIndex?: number;  // Plugin index in chain for multi-instance support
}

/**
 * VSTPluginWindow v3.0
 * 
 * Affiche l'interface d'un plugin VST3 via le bridge Python.
 * Supporte les multi-instances via système de slots.
 */
const VSTPluginWindow: React.FC<VSTPluginWindowProps> = ({ 
  plugin, 
  onClose,
  trackId = 'default',
  pluginIndex = 0
}) => {
  const canvasRef = useRef<HTMLImageElement>(null);
  const [status, setStatus] = useState<string>('Connecting to VST Bridge...');
  const [isConnected, setIsConnected] = useState(false);
  const [pluginParams, setPluginParams] = useState<any[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  
  // Generate unique slot ID for this plugin instance
  const slotId = `${trackId}_fx${pluginIndex}`;
  
  // Drag State
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });

  useEffect(() => {
    // Connect to bridge if not connected
    novaBridge.connect();
    
    // Subscribe to connection status
    const unsubStatus = novaBridge.subscribe((state) => {
      setIsConnected(state.isConnected);
      if (!state.isConnected) {
        setStatus('Bridge déconnecté - Vérifiez que le serveur Python est lancé');
      }
    });

    // 1. Load the plugin via the path stored in params
    const pluginPath = plugin.params?.localPath;
    
    if (pluginPath) {
        console.log(`[VST Window] Loading ${plugin.name} from ${pluginPath} (slot: ${slotId})`);
        novaBridge.loadPluginToSlot(pluginPath, 44100, slotId);
        setStatus('Loading Plugin...');
    } else {
        setStatus('Error: Missing Plugin Path');
    }

    // 2. Subscribe to UI frames for this slot
    const unsubscribeUI = novaBridge.subscribeToSlotUI(slotId, (base64Image) => {
        if (canvasRef.current) {
            canvasRef.current.src = `data:image/jpeg;base64,${base64Image}`;
            if (status !== 'Active') setStatus('Active');
        }
    });
    
    // 3. Subscribe to params for this slot
    const unsubscribeParams = novaBridge.subscribeToSlotParams(slotId, (params) => {
        setPluginParams(params);
    });

    // 4. Subscribe to load errors for this slot
    const unsubscribeError = novaBridge.subscribeToSlotError(slotId, (error) => {
        console.error('[VST Window] Load Error:', error);
        setLoadError(error);
        setStatus('Error: ' + error.substring(0, 50));
    });

    return () => {
      unsubStatus();
      unsubscribeUI();
      unsubscribeParams();
      unsubscribeError();
      
      // Unload plugin from this slot when window closes
      novaBridge.unloadPluginFromSlot(slotId);
    };
  }, [plugin, slotId]);

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
      
      // Send click to specific slot
      novaBridge.clickOnSlot(x, y, 'left', slotId);
      
      // Prepare for drag
      isDragging.current = true;
      dragStart.current = { x, y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
      if (!isDragging.current) return;
      
      const { x, y } = getCoords(e);
      
      // Send drag to specific slot
      novaBridge.dragOnSlot(dragStart.current.x, dragStart.current.y, x, y, slotId);
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
      novaBridge.scrollOnSlot(x, y, delta, slotId);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      const { x, y } = getCoords(e);
      novaBridge.clickOnSlot(x, y, 'right', slotId);
  };

  return (
    <div className="flex flex-col bg-[#1e2229] border border-white/10 rounded-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
      
      {/* WINDOW HEADER */}
      <div className="h-8 bg-[#0c0d10] border-b border-white/10 flex items-center justify-between px-3 select-none cursor-move">
        <div className="flex items-center space-x-2">
            <div className={`w-2 h-2 rounded-full ${status === 'Active' ? 'bg-green-500 animate-pulse' : isConnected ? 'bg-yellow-500' : 'bg-red-500'}`}></div>
            <span className="text-[10px] font-black text-white uppercase tracking-widest">{plugin.name} (VST3)</span>
        </div>
        <div className="flex items-center space-x-2">
            <span className="text-[8px] font-mono text-slate-500">{status}</span>
            <span className="text-[7px] font-mono text-slate-600">slot: {slotId}</span>
            <button onClick={onClose} className="text-slate-500 hover:text-red-500 transition-colors">
                <i className="fas fa-times text-xs"></i>
            </button>
        </div>
      </div>

      {/* VST VIEWPORT */}
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
            onContextMenu={handleContextMenu}
            draggable={false}
         />
         
         {status !== 'Active' && (
             <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/70">
                 <div className="flex flex-col items-center space-y-3 max-w-[350px] text-center p-4">
                     {loadError ? (
                         <>
                             <i className="fas fa-lock text-3xl text-red-500"></i>
                             <span className="text-xs text-red-400 font-bold">Plugin non supporté</span>
                             <span className="text-[10px] text-slate-400 leading-relaxed">
                                 Ce plugin nécessite une licence ou utilise un format protégé.
                                 <br/>
                                 <span className="text-yellow-500">Le bridge Python (pedalboard) ne peut pas charger les plugins commerciaux.</span>
                             </span>
                             <div className="mt-2 p-2 bg-slate-800 rounded text-[9px] text-slate-500">
                                 <span className="text-green-400">Alternative :</span> Utilisez les effets intégrés (Reverb, Delay, EQ, Compressor) dans l'onglet FW
                             </div>
                         </>
                     ) : (
                         <>
                             <i className={`fas ${isConnected ? 'fa-satellite-dish' : 'fa-exclamation-triangle'} text-2xl ${isConnected ? 'text-slate-700 animate-pulse' : 'text-red-700'}`}></i>
                             <span className="text-[9px] text-slate-500 font-mono">{status}</span>
                             {!isConnected && (
                                 <span className="text-[8px] text-slate-600 font-mono">
                                     python bridge-python/nova_bridge_server.py
                                 </span>
                             )}
                         </>
                     )}
                 </div>
             </div>
         )}
      </div>
      
      {/* PARAMETERS PANEL (collapsible) */}
      {pluginParams.length > 0 && (
        <div className="max-h-32 overflow-y-auto bg-[#151820] border-t border-white/5">
          <div className="px-2 py-1 text-[8px] text-slate-500 uppercase tracking-wide">
            Parameters ({pluginParams.length})
          </div>
          <div className="grid grid-cols-4 gap-1 px-2 pb-2">
            {pluginParams.slice(0, 12).map((param, idx) => (
              <div key={idx} className="flex flex-col">
                <span className="text-[7px] text-slate-600 truncate">{param.display_name || param.name}</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={param.value}
                  onChange={(e) => novaBridge.setParamForSlot(param.name, parseFloat(e.target.value), slotId)}
                  className="w-full h-2 accent-purple-500"
                />
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* FOOTER CONTROLS */}
      <div className="h-6 bg-[#0c0d10] border-t border-white/5 flex items-center justify-between px-2">
         <span className="text-[8px] font-mono text-slate-600">NOVA BRIDGE v3.0 • MULTI-INSTANCE</span>
         <div className="flex space-x-2 items-center">
             <span className="text-[7px] font-mono text-slate-700">{novaBridge.getActiveSlots().size} slots</span>
             <i className={`fas fa-wifi text-[8px] ${isConnected ? 'text-green-500' : 'text-red-500'}`} title={isConnected ? "Connected" : "Disconnected"}></i>
         </div>
      </div>
    </div>
  );
};

export default VSTPluginWindow;
