
import React from 'react';
import { ViewMode } from '../types';

interface ViewModeSwitcherProps {
  currentMode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

const ViewModeSwitcher: React.FC<ViewModeSwitcherProps> = ({ currentMode, onChange }) => {
  return (
    <div className="flex items-center bg-white/[0.05] rounded-xl p-1 gap-1" role="group" aria-label="Mode d'affichage">
      <button 
        onClick={() => onChange('DESKTOP')}
        className={`w-8 h-8 group-[.vm-labeled]:w-auto group-[.vm-labeled]:h-auto group-[.vm-labeled]:flex-1 group-[.vm-labeled]:min-h-11 group-[.vm-labeled]:flex-row group-[.vm-labeled]:gap-2 rounded-lg flex items-center justify-center transition-colors duration-150 ${currentMode === 'DESKTOP' ? 'bg-nv-raised text-nv-ink shadow-sm ring-1 ring-nv-accent/50' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
        title="Mode PC (ordinateur)"
      >
        <i className="fas fa-desktop text-[11px]"></i>
        <span className="hidden group-[.vm-labeled]:block text-[13px] font-semibold">PC</span>
      </button>
      <button 
        onClick={() => onChange('TABLET')}
        className={`w-8 h-8 group-[.vm-labeled]:w-auto group-[.vm-labeled]:h-auto group-[.vm-labeled]:flex-1 group-[.vm-labeled]:min-h-11 group-[.vm-labeled]:flex-row group-[.vm-labeled]:gap-2 rounded-lg flex items-center justify-center transition-colors duration-150 ${currentMode === 'TABLET' ? 'bg-nv-raised text-nv-ink shadow-sm ring-1 ring-nv-accent/50' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
        title="Mode Tablette (tactile)"
      >
        <i className="fas fa-tablet-alt text-[11px]"></i>
        <span className="hidden group-[.vm-labeled]:block text-[13px] font-semibold">Tablette</span>
      </button>
      <button 
        onClick={() => onChange('MOBILE')}
        className={`w-8 h-8 group-[.vm-labeled]:w-auto group-[.vm-labeled]:h-auto group-[.vm-labeled]:flex-1 group-[.vm-labeled]:min-h-11 group-[.vm-labeled]:flex-row group-[.vm-labeled]:gap-2 rounded-lg flex items-center justify-center transition-colors duration-150 ${currentMode === 'MOBILE' ? 'bg-nv-raised text-nv-ink shadow-sm ring-1 ring-nv-accent/50' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
        title="Mode Mobile (téléphone)"
      >
        <i className="fas fa-mobile-alt text-[11px]"></i>
        <span className="hidden group-[.vm-labeled]:block text-[13px] font-semibold">Téléphone</span>
      </button>
    </div>
  );
};

export default ViewModeSwitcher;
