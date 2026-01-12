import React from 'react';
import { MobileTab } from '../types';

interface MobileBottomNavProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
}

const MobileBottomNav: React.FC<MobileBottomNavProps> = ({ activeTab, onTabChange }) => {
  const tabs: { id: MobileTab; icon: string; label: string }[] = [
    { id: 'TRACKS', icon: 'fa-bars-staggered', label: 'Pistes' },
    { id: 'MIX', icon: 'fa-sliders-h', label: 'Mix' },
    { id: 'REC', icon: 'fa-microphone', label: 'Rec' },
    { id: 'BROWSER', icon: 'fa-folder', label: 'Browser' },
    { id: 'NOVA', icon: 'fa-sparkles', label: 'Nova' },
  ];

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[100] bg-[#08090b]/95 backdrop-blur-xl border-t border-white/5 pb-safe">
      <div className="flex items-center justify-around h-16">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`flex flex-col items-center justify-center flex-1 h-full transition-all ${
              activeTab === tab.id
                ? 'text-cyan-400'
                : 'text-slate-500'
            }`}
          >
            <i className={`fas ${tab.icon} text-lg mb-1 ${
              activeTab === tab.id ? 'animate-pulse' : ''
            }`}></i>
            <span className="text-[8px] font-black uppercase tracking-wider">{tab.label}</span>
            {activeTab === tab.id && (
              <div className="absolute bottom-1 w-1 h-1 bg-cyan-400 rounded-full"></div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

export default MobileBottomNav;
