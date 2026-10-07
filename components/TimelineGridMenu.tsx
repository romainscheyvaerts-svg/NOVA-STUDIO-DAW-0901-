
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

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
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 10);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Recalé dans l'écran sur sa VRAIE hauteur (G3) : « Coller » et « Réinitialiser
  // le zoom » sortaient de l'écran à 900 px de haut.
  const [pos, setPos] = useState({ left: Math.min(x, window.innerWidth - 248), top: y });
  useLayoutEffect(() => {
    const el = menuRef.current;
    const h = el?.offsetHeight || 0, w = el?.offsetWidth || 240;
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.max(8, Math.min(x, vw - w - 8));
    const top = y + h <= vh - 8 ? y : Math.max(8, Math.min(y - h, vh - h - 8));
    setPos({ left, top });
  }, [x, y]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const GRID_OPTIONS = [
    { label: 'Mesure', value: '1/1', hint: 'Une case par mesure' },
    { label: 'Noire (1/4)', value: '1/4', hint: 'Une case par temps' },
    { label: 'Croche (1/8)', value: '1/8', hint: 'Deux cases par temps' },
    { label: 'Double croche (1/16)', value: '1/16', hint: 'Quatre cases par temps' },
  ];

  return (
    <div 
      ref={menuRef}
      className="fixed z-[1000] w-60 bg-[#14161a] border border-white/10 rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.8)] overflow-hidden text-[#e2e8f0] animate-in fade-in zoom-in duration-75"
      style={{ left: pos.left, top: pos.top }}
      role="menu" aria-label="Grille et pistes"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-4 py-2 border-b border-white/5 bg-white/[0.02]">
        <div className="flex items-center space-x-2">
          <i className="fas fa-th text-[10px] text-cyan-500"></i>
          <span className="text-[11px] font-bold text-slate-300">Grille et pistes</span>
        </div>
      </div>

      <div className="p-1">
        <div className="px-3 py-1.5 mt-1 text-[10px] font-bold text-slate-500" title="Les clips et les points se calent sur ces divisions quand l'aimant est actif">Grille</div>
        <div className="flex flex-col space-y-0.5">
          {GRID_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              title={opt.hint}
              role="menuitemradio" aria-checked={gridSize === opt.value}
              onClick={() => { onSetGridSize(opt.value); onClose(); }}
              className={`flex items-center justify-between px-3 py-1.5 rounded-lg text-[10px] font-bold transition-colors ${gridSize === opt.value ? 'bg-cyan-500/10 text-cyan-400' : 'hover:bg-white/5 text-slate-300'}`}
            >
              <span>{opt.label}</span>
              {gridSize === opt.value && <i className="fas fa-check text-[8px]"></i>}
            </button>
          ))}
        </div>

        <div className="h-px bg-white/5 my-2 mx-2" />

        <div className="px-3 py-1.5 text-[10px] font-bold text-slate-500">Édition</div>
        <button
          onClick={() => { onToggleSnap(); onClose(); }}
          role="menuitemcheckbox" aria-checked={snapEnabled}
          title="Aimanter à la grille : les clips se calent sur les temps (Maj pendant un glissement = libre)"
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-[10px] font-bold hover:bg-white/5 text-slate-300 group"
        >
          <div className="flex items-center space-x-2">
            <i className={`fas ${snapEnabled ? 'fa-magnet text-green-400' : 'fa-slash text-slate-500'} w-4 text-center`}></i>
            <span className={snapEnabled ? 'text-white' : 'text-slate-400'}>{snapEnabled ? 'Aimanter à la grille : oui' : 'Aimanter à la grille : non (libre)'}</span>
          </div>
          <div className={`w-8 h-4 rounded-full p-0.5 ${snapEnabled ? 'bg-green-500/20' : 'bg-white/10'}`}>
            <div className={`w-3 h-3 rounded-full bg-white transition-transform ${snapEnabled ? 'translate-x-4 bg-green-400' : 'translate-x-0 bg-slate-500'}`} />
          </div>
        </button>

        <div className="h-px bg-white/5 my-2 mx-2" />

        <div className="flex flex-col space-y-0.5">
          <button onClick={() => { onAddTrack(); onClose(); }} className="w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-[10px] font-bold hover:bg-white/5 text-slate-300">
            <i className="fas fa-plus-circle w-4 text-center text-slate-500"></i>
            <span>Ajouter une piste audio</span>
          </button>
          
          <button onClick={() => { if(onPaste) onPaste(); onClose(); }} className="w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-[10px] font-bold hover:bg-white/5 text-slate-300">
            <i className="fas fa-paste w-4 text-center text-slate-500"></i>
            <span>Coller</span>
          </button>

          <button onClick={() => { onResetZoom(); onClose(); }} className="w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-[10px] font-bold hover:bg-white/5 text-slate-300">
            <i className="fas fa-search-minus w-4 text-center text-slate-500"></i>
            <span>Réinitialiser le zoom</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default TimelineGridMenu;
