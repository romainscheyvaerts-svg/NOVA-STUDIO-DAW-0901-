import React from 'react';
import { ViewMode } from '../types';

interface ViewModeSwitcherProps {
  currentMode: ViewMode;
  onChangeMode: (mode: ViewMode) => void;
}

const ViewModeSwitcher: React.FC<ViewModeSwitcherProps> = ({ currentMode, onChangeMode }) => {
  return (
    <div className="flex items-center space-x-1 bg-black/40 rounded-lg p-1 border border-white/5">
      <button
        onClick={() => onChangeMode('DESKTOP')}
        className={`px-3 py-1.5 rounded-md text-[9px] font-bold uppercase transition-all ${
          currentMode === 'DESKTOP'
            ? 'bg-cyan-500 text-black'
            : 'text-slate-500 hover:text-white'
        }`}
      >
        <i className="fas fa-desktop mr-1"></i>
        Desktop
      </button>
      <button
        onClick={() => onChangeMode('TABLET')}
        className={`px-3 py-1.5 rounded-md text-[9px] font-bold uppercase transition-all ${
          currentMode === 'TABLET'
            ? 'bg-cyan-500 text-black'
            : 'text-slate-500 hover:text-white'
        }`}
      >
        <i className="fas fa-tablet-alt mr-1"></i>
        Tablet
      </button>
      <button
        onClick={() => onChangeMode('MOBILE')}
        className={`px-3 py-1.5 rounded-md text-[9px] font-bold uppercase transition-all ${
          currentMode === 'MOBILE'
            ? 'bg-cyan-500 text-black'
            : 'text-slate-500 hover:text-white'
        }`}
      >
        <i className="fas fa-mobile-alt mr-1"></i>
        Mobile
      </button>
    </div>
  );
};

export default ViewModeSwitcher;
