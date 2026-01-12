import React from 'react';
import { MobileTab } from '../../types';

interface MobileBottomNavProps {
  activeTab: MobileTab;
  onChangeTab: (tab: MobileTab) => void;
}

const MobileBottomNav: React.FC<MobileBottomNavProps> = ({ activeTab, onChangeTab }) => {
  const tabs: Array<{ id: MobileTab; icon: string; label: string }> = [
    { id: 'PROJECT', icon: 'fa-layer-group', label: 'Pistes' },
    { id: 'MIXER', icon: 'fa-sliders-h', label: 'Mix' },
    { id: 'NOVA', icon: 'fa-robot', label: 'AI' },
    { id: 'AUTOMATION', icon: 'fa-wave-square', label: 'Auto' },
  ];

  return (
    <div className="h-20 bg-black/90 backdrop-blur-xl border-t border-white/10 flex items-center justify-center px-5 flex-shrink-0">
      <div className="flex items-center justify-around w-full max-w-md">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => onChangeTab(tab.id)}
            className={`flex flex-col items-center py-2 px-4 rounded-xl transition-all active:scale-95 ${
              activeTab === tab.id ? 'bg-cyan-500/20 text-cyan-400' : 'text-white/50'
            }`}
          >
            <i className={`fas ${tab.icon} text-lg mb-1`}></i>
            <span className="text-[10px] font-bold">{tab.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default MobileBottomNav;
