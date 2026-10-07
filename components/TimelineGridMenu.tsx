
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GRID_OPTIONS } from '../utils/grid';
import { chooseEditMode, EDIT_MODE_INFO, EDIT_MODES, useEditMode } from '../utils/editModes';

const notifyMode = (msg: string) => { try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: msg })); } catch { /* rien */ } };
import { runEditCommand } from '../utils/editCommands';
import { openNovaWindow } from '../utils/novaWindows';
import { TRACK_HEIGHTS } from '../utils/trackHeights';

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
  const em = useEditMode();
  void onToggleSnap;

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
        <div className="px-3 py-1.5 mt-1 text-[10px] font-bold text-slate-500" title="Les clips et les points se calent sur ces divisions en mode Grid">Grille</div>
        <div className="grid grid-cols-3 gap-0.5">
          {GRID_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              title={opt.title}
              role="menuitemradio" aria-checked={gridSize === opt.value}
              onClick={() => { onSetGridSize(opt.value); onClose(); }}
              className={`flex items-center justify-between px-2 py-1.5 [@media(pointer:coarse)]:py-2.5 rounded-lg text-[10px] font-bold transition-colors ${gridSize === opt.value ? 'bg-cyan-500/10 text-cyan-400' : 'hover:bg-white/5 text-slate-300'}`}
            >
              <span>{opt.label}</span>
              {gridSize === opt.value && <i className="fas fa-check text-[8px]"></i>}
            </button>
          ))}
        </div>

        <div className="h-px bg-white/5 my-2 mx-2" />

        <div className="px-3 py-1.5 text-[10px] font-bold text-slate-500" title="Modes d'édition de Pro Tools (F1 à F4, ou Alt+1 à 4)">Mode d’édition</div>
        <div className="grid grid-cols-4 gap-0.5 px-1" role="radiogroup" aria-label="Mode d'édition">
          {EDIT_MODES.map(m => {
            const info = EDIT_MODE_INFO[m];
            const on = em.mode === m;
            return (
              <button key={m} role="menuitemradio" aria-checked={on} title={`${info.hint} (${info.keys})`}
                onClick={() => { notifyMode(chooseEditMode(m).message); onClose(); }}
                className={`rounded-lg py-1.5 [@media(pointer:coarse)]:py-2.5 text-[9px] font-black tracking-wider ${on ? 'text-black' : 'text-slate-300 hover:bg-white/5'}`}
                style={on ? { background: info.color } : undefined}>
                {info.short}{m === 'GRID' && on && em.gridKind === 'RELATIVE' ? ' REL' : ''}
              </button>
            );
          })}
        </div>
        <p className="px-3 pt-1 text-[9px] text-slate-500">{snapEnabled ? 'Grille active' : 'Libre'} · Ctrl ou Maj pendant un glissement : inverse</p>

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
          <button onClick={() => { openNovaWindow('memory-locations'); onClose(); }} title="Liste des repères (Pro Tools : Memory Locations, Ctrl+5)" className="w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-[10px] font-bold hover:bg-white/5 text-slate-300">
            <i className="fas fa-map-marker-alt w-4 text-center text-slate-500"></i>
            <span>Repères (Memory Locations)</span>
          </button>
          <button onClick={() => { openNovaWindow('shortcuts'); onClose(); }} title="Tous les raccourcis, avec recherche (touche ?)" className="w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-[10px] font-bold hover:bg-white/5 text-slate-300">
            <i className="fas fa-keyboard w-4 text-center text-slate-500"></i>
            <span>Raccourcis clavier</span>
          </button>
        </div>

        <div className="h-px bg-white/5 my-2 mx-2" />
        <div className="px-3 py-1.5 text-[8px] font-black uppercase text-slate-600 tracking-widest" title="Pro Tools : Track Height (Ctrl+↑ / Ctrl+↓)">Hauteur des pistes</div>
        <div className="grid grid-cols-5 gap-0.5 px-1 pb-1">
          {TRACK_HEIGHTS.map(h => (
            <button key={h.id} title={`${h.label} (${h.px} px) · Pro Tools : ${h.pt}`} onClick={() => { runEditCommand('trackHeight', h.px); onClose(); }}
              className="rounded-lg px-1 py-1.5 [@media(pointer:coarse)]:py-2.5 text-[9px] font-bold text-slate-300 hover:bg-white/5">
              {h.short}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default TimelineGridMenu;
