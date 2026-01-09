
import React, { useEffect, useRef } from 'react';

interface TimelineGridMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  gridSize: string;
  onSetGridSize: (size: string) => void;
  snapEnabled: boolean;
  onToggleSnap: () => void;
  onAddTrack: () => void;
  onResetZoom: () => void;
  onPaste?: () => void;
}

const TimelineGridMenu: React.FC<TimelineGridMenuProps> = ({ 
  x, y, onClose, 
  gridSize, onSetGridSize, 
  snapEnabled, onToggleSnap,
  onAddTrack, onResetZoom, onPaste
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Petit délai pour éviter que le clic d'ouverture ne ferme immédiatement le menu
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 10);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Garde-fou pour ne pas sortir de l'écran
  const adjustedX = Math.min(x, window.innerWidth - 240);
  const adjustedY = Math.min(y, window.innerHeight - 300);

  const GRID_OPTIONS = [
    { label: '1/4 (Beat)', value: '1/4' },
    { label: '1/8', value: '1/8' },
    { label: '1/16', value: '1/16' },
    { label: 'Bar (Mesure)', value: '1/1' },
  ];

  return (
    <div 
      ref={menuRef}
      className="fixed z-[1000] w-60 bg-[#14161a] border border-white/10 rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.8)] overflow-hidden text-[#e2e8f0] animate-in fade-in zoom-in duration-75"
      style={{ left: adjustedX, top: adjustedY }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* HEADER */}
      <div className="px-4 py-2 border-b border-white/5 bg-white/[0.02]">
        <div className="flex items-center space-x-2">
          <i className="fas fa-th text-[10px] text-cyan-500"></i>
          <span className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400">Arrangement View</span>
        </div>
      </div>

      <div className="p-1">
        {/* SECTION 1: GRID SIZE */}
        <div className="px-3 py-1.5 mt-1 text-[8px] font-black uppercase text-slate-600 tracking-widest">Quantization (Grid)</div>
        <div className="flex flex-col space-y-0.5">
          {GRID_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { onSetGridSize(opt.value); onClose(); }}
              className={`flex items-center justify-between px-3 py-1.5 rounded-lg text-[10px] font-bold transition-colors ${gridSize === opt.value ? 'bg-cyan-500/10 text-cyan-400' : 'hover:bg-white/5 text-slate-300'}`}
            >
              <span>{opt.label}</span>
              {gridSize === opt.value && <i className="fas fa-check text-[8px]"></i>}
            </button>
          ))}
        </div>

        <div className="h-px bg-white/5 my-2 mx-2" />

        {/* SECTION 2: EDIT MODE */}
        <div className="px-3 py-1.5 text-[8px] font-black uppercase text-slate-600 tracking-widest">Mode d'Édition</div>
        <button
          onClick={() => { onToggleSnap(); onClose(); }}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-[10px] font-bold hover:bg-white/5 text-slate-300 group"
        >
          <div className="flex items-center space-x-2">
            <i className={`fas ${snapEnabled ? 'fa-magnet text-green-400' : 'fa-slash text-slate-500'} w-4 text-center`}></i>
            <span className={snapEnabled ? 'text-white' : 'text-slate-400'}>{snapEnabled ? 'SNAP (Magnétique)' : 'SLIP (Libre)'}</span>
          </div>
          <div className={`w-8 h-4 rounded-full p-0.5 ${snapEnabled ? 'bg-green-500/20' : 'bg-white/10'}`}>
            <div className={`w-3 h-3 rounded-full bg-white transition-transform ${snapEnabled ? 'translate-x-4 bg-green-400' : 'translate-x-0 bg-slate-500'}`} />
          </div>
        </button>

        <div className="h-px bg-white/5 my-2 mx-2" />

        {/* SECTION 3: GLOBAL TOOLS */}
        <div className="flex flex-col space-y-0.5">
          <button onClick={() => { onAddTrack(); onClose(); }} className="w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-[10px] font-bold hover:bg-white/5 text-slate-300">
            <i className="fas fa-plus-circle w-4 text-center text-slate-500"></i>
            <span>Ajouter une Piste Audio</span>
          </button>
          
          <button onClick={() => { if(onPaste) onPaste(); onClose(); }} className="w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-[10px] font-bold hover:bg-white/5 text-slate-300">
            <i className="fas fa-paste w-4 text-center text-slate-500"></i>
            <span>Coller</span>
          </button>

          <button onClick={() => { onResetZoom(); onClose(); }} className="w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-[10px] font-bold hover:bg-white/5 text-slate-300">
            <i className="fas fa-search-minus w-4 text-center text-slate-500"></i>
            <span>Réinitialiser le Zoom</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default TimelineGridMenu;
