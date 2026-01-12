import React from 'react';

interface Tab {
  id: string;
  icon: string;
  label: string;
}

const MOBILE_TABS: Tab[] = [
  { id: 'TRACKS', icon: 'fa-layer-group', label: 'Pistes' },
  { id: 'MIXER', icon: 'fa-sliders-h', label: 'Mixer' },
  { id: 'PLUGINS', icon: 'fa-plug', label: 'Plugins' },
  { id: 'SOUNDS', icon: 'fa-music', label: 'Sons' },
  { id: 'AI', icon: 'fa-robot', label: 'Nova' },
  { id: 'OPTIONS', icon: 'fa-cog', label: 'Options' },
];

interface Props {
  activeTab: string;
  onChangeTab: (tabId: string) => void;
}

const MobileBottomNav: React.FC<Props> = ({ activeTab, onChangeTab }) => {
  return (
    <div className="h-16 bg-[#0b0c0e] border-t border-white/5 flex items-center justify-between px-3">
      {MOBILE_TABS.map(tab => (
        <button key={tab.id} onClick={() => onChangeTab(tab.id)} className={`flex-1 flex flex-col items-center justify-center py-2 ${activeTab === tab.id ? 'text-cyan-400' : 'text-white/50'}`}>
          <i className={`fas ${tab.icon} text-lg`} />
          <span className="text-[10px] mt-1">{tab.label}</span>
        </button>
      ))}
    </div>
  );
};

export default MobileBottomNav;
