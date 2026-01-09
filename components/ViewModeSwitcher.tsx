
import React from 'react';
import { ViewMode } from '../types';

interface ViewModeSwitcherProps {
  currentMode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

const ViewModeSwitcher: React.FC<ViewModeSwitcherProps> = ({ currentMode, onChange }) => {
  return (
    <div className="flex items-center bg-black/40 rounded-xl p-0.5 border border-white/5 space-x-0.5">
      <button 
        onClick={() => onChange('DESKTOP')}
        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${currentMode === 'DESKTOP' ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/20' : 'text-slate-600 hover:text-white hover:bg-white/5'}`}
        title="Mode PC (Desktop)"
      >
        <i className="fas fa-desktop text-[10px]"></i>
      </button>
      <button 
        onClick={() => onChange('TABLET')}
        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${currentMode === 'TABLET' ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/20' : 'text-slate-600 hover:text-white hover:bg-white/5'}`}
        title="Mode Tablette (Touch)"
      >
        <i className="fas fa-tablet-alt text-[10px]"></i>
      </button>
      <button 
        onClick={() => onChange('MOBILE')}
        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${currentMode === 'MOBILE' ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/20' : 'text-slate-600 hover:text-white hover:bg-white/5'}`}
        title="Mode Mobile (Focus)"
      >
        <i className="fas fa-mobile-alt text-[10px]"></i>
      </button>
    </div>
  );
};

export default ViewModeSwitcher;
