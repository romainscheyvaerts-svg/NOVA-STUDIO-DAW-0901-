
import React from 'react';
import { ViewMode } from '../types';

interface ViewModeSwitcherProps {
  currentMode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

const ViewModeSwitcher: React.FC<ViewModeSwitcherProps> = ({ currentMode, onChange }) => {
  return (
    <div className="flex items-center bg-black/40 rounded-xl p-0.5 border border-white/5 space-x-0.5" role="group" aria-label="Mode d'affichage">
      <button 
        onClick={() => onChange('DESKTOP')}
        className={`w-8 h-8 group-[.vm-labeled]:w-auto group-[.vm-labeled]:h-auto group-[.vm-labeled]:flex-1 group-[.vm-labeled]:py-2 group-[.vm-labeled]:flex-col rounded-lg flex items-center justify-center transition-all ${currentMode === 'DESKTOP' ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/20' : 'text-slate-600 hover:text-white hover:bg-white/5'}`}
        title="Mode PC (ordinateur)"
      >
        <i className="fas fa-desktop text-[10px]"></i>
        <span className="hidden group-[.vm-labeled]:block text-[10px] font-bold mt-0.5">PC</span>
      </button>
      <button 
        onClick={() => onChange('TABLET')}
        className={`w-8 h-8 group-[.vm-labeled]:w-auto group-[.vm-labeled]:h-auto group-[.vm-labeled]:flex-1 group-[.vm-labeled]:py-2 group-[.vm-labeled]:flex-col rounded-lg flex items-center justify-center transition-all ${currentMode === 'TABLET' ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/20' : 'text-slate-600 hover:text-white hover:bg-white/5'}`}
        title="Mode Tablette (tactile)"
      >
        <i className="fas fa-tablet-alt text-[10px]"></i>
        <span className="hidden group-[.vm-labeled]:block text-[10px] font-bold mt-0.5">Tablette</span>
      </button>
      <button 
        onClick={() => onChange('MOBILE')}
        className={`w-8 h-8 group-[.vm-labeled]:w-auto group-[.vm-labeled]:h-auto group-[.vm-labeled]:flex-1 group-[.vm-labeled]:py-2 group-[.vm-labeled]:flex-col rounded-lg flex items-center justify-center transition-all ${currentMode === 'MOBILE' ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/20' : 'text-slate-600 hover:text-white hover:bg-white/5'}`}
        title="Mode Mobile (téléphone)"
      >
        <i className="fas fa-mobile-alt text-[10px]"></i>
        <span className="hidden group-[.vm-labeled]:block text-[10px] font-bold mt-0.5">Téléphone</span>
      </button>
    </div>
  );
};

export default ViewModeSwitcher;
