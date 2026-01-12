import React from 'react';
import { MobileTab } from '../types';

interface MobileBottomNavProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
}

const MobileBottomNav: React.FC<MobileBottomNavProps> = ({ activeTab, onTabChange }) => {
  // Limit to 4 tabs max as per spec: Arrangement, Mixer, AI Nova, Settings
  const tabs: { id: MobileTab; icon: string; label: string }[] = [
    { id: 'TRACKS', icon: 'fa-layer-group', label: 'Arrange' },
    { id: 'MIX', icon: 'fa-sliders-h', label: 'Mixer' },
    { id: 'NOVA', icon: 'fa-robot', label: 'AI' },
    { id: 'SETTINGS', icon: 'fa-cog', label: 'Settings' },
  ];

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-[100] bg-[#08090b]/95 backdrop-blur-xl border-t border-white/10 shadow-2xl"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-center justify-around h-16">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`flex flex-col items-center justify-center flex-1 h-full transition-all relative ${
              activeTab === tab.id
                ? 'text-cyan-400'
                : 'text-slate-500 active:bg-white/5'
            }`}
          >
            <i className={`fas ${tab.icon} text-xl mb-1`}></i>
            <span className="text-[9px] font-black uppercase tracking-wide">{tab.label}</span>
            {activeTab === tab.id && (
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-1 bg-cyan-400 rounded-b-full"></div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

export default MobileBottomNav;
