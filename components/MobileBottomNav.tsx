import React from 'react';
import { MobileTab } from '../types';

interface MobileBottomNavProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
}

/**
 * Barre de navigation mobile en bas d'écran
 * Inspiré de Logic Pro iPad
 */
const MobileBottomNav: React.FC<MobileBottomNavProps> = ({ activeTab, onTabChange }) => {
  const tabs: { id: MobileTab; icon: string; label: string }[] = [
    { id: 'TRACKS', icon: 'fa-bars-staggered', label: 'Pistes' },
    { id: 'MIXER', icon: 'fa-sliders-h', label: 'Mixer' },
    { id: 'PLUGINS', icon: 'fa-plug', label: 'FX' },
    { id: 'BROWSER', icon: 'fa-folder-open', label: 'Sons' },
    { id: 'NOVA', icon: 'fa-sparkles', label: 'Nova' },
  ];

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[100] bg-[#08090b]/98 backdrop-blur-xl border-t border-white/10 safe-area-inset-bottom">
      <div className="flex items-center justify-around h-16 px-2">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`flex flex-col items-center justify-center flex-1 h-full transition-all relative ${
              activeTab === tab.id
                ? 'text-cyan-400'
                : 'text-slate-500 hover:text-slate-400 active:text-slate-300'
            }`}
          >
            <i className={`fas ${tab.icon} text-xl mb-1 transition-transform ${
              activeTab === tab.id ? 'scale-110' : 'scale-100'
            }`}></i>
            <span className={`text-[9px] font-bold uppercase tracking-wider transition-all ${
              activeTab === tab.id ? 'opacity-100' : 'opacity-70'
            }`}>
              {tab.label}
            </span>
            {activeTab === tab.id && (
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-1 bg-cyan-400 rounded-full"></div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

export default MobileBottomNav;
