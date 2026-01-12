import React, { useState } from 'react';
import MobilePanel, { PanelConfig } from './MobilePanel';

interface MobilePanelSystemProps {
  children: React.ReactNode; // Main content (track list)
  panels: PanelConfig[];
  panelProps?: Record<string, any>; // Props to pass to each panel
}

const MobilePanelSystem: React.FC<MobilePanelSystemProps> = ({ 
  children, 
  panels,
  panelProps = {}
}) => {
  const [activePanel, setActivePanel] = useState<string | null>(null);
  const [panelHeight, setPanelHeight] = useState<'half' | 'full'>('half');
  
  const handlePanelToggle = (panelId: string) => {
    if (activePanel === panelId) {
      setActivePanel(null);
    } else {
      const panel = panels.find(p => p.id === panelId);
      setActivePanel(panelId);
      setPanelHeight(panel?.defaultHeight || 'half');
    }
  };
  
  const handleClosePanel = () => {
    setActivePanel(null);
  };
  
  const activeConfig = panels.find(p => p.id === activePanel);
  
  return (
    <div className="fixed inset-0 flex flex-col bg-[#0a0b0d]">
      {/* Main content - dimmed when panel is open */}
      <div 
        className={`flex-1 transition-opacity duration-300 ${
          activePanel ? 'opacity-30 pointer-events-none' : 'opacity-100'
        }`}
      >
        {children}
      </div>
      
      {/* Panel buttons bar (always visible above bottom nav) */}
      <div 
        className="h-16 bg-black/80 border-t border-white/10 flex items-center justify-around px-4 z-50"
        style={{
          paddingBottom: 'max(0px, env(safe-area-inset-bottom))',
          marginBottom: '64px' // Space for bottom nav
        }}
      >
        {panels.map(panel => (
          <button
            key={panel.id}
            onClick={() => handlePanelToggle(panel.id)}
            className={`flex flex-col items-center p-2 rounded-xl transition-all ${
              activePanel === panel.id 
                ? 'bg-cyan-500/20 text-cyan-400' 
                : 'text-white/50 hover:text-white/70'
            }`}
          >
            <i className={`fas ${panel.icon} text-lg`}></i>
            <span className="text-[9px] mt-1 font-bold">{panel.title}</span>
          </button>
        ))}
      </div>
      
      {/* Active panel (slide from bottom) */}
      {activePanel && activeConfig && (
        <MobilePanel
          config={activeConfig}
          height={panelHeight}
          onChangeHeight={setPanelHeight}
          onClose={handleClosePanel}
          componentProps={panelProps[activePanel] || {}}
        />
      )}
    </div>
  );
};

export default MobilePanelSystem;
