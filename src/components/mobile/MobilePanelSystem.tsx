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
    <>
      {/* Main content - dimmed when panel is open */}
      {/* Masquer complètement le contenu principal si un panneau est ouvert */}
      {!activePanel && (
        <div 
          className="flex-1 flex flex-col"
          style={{ 
            marginBottom: '128px' // Space for panel bar (64px) + bottom nav (64px)
          }}
        >
          {children}
        </div>
      )}
      
      {/* Panel buttons bar (fixed above bottom nav) */}
      <div 
        className="fixed left-0 right-0 h-16 bg-black/80 border-t border-white/10 flex items-center justify-around px-4 z-50"
        style={{
          bottom: '64px', // Height of bottom nav
          paddingLeft: 'max(16px, env(safe-area-inset-left))',
          paddingRight: 'max(16px, env(safe-area-inset-right))',
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
            <span className="text-[9px] mt-1 font-bold uppercase">{panel.title}</span>
          </button>
        ))}
      </div>
      
      {/* Backdrop + Active panel (slide from bottom) */}
      {activePanel && activeConfig && (
        <>
          {/* Backdrop pour masquer le contenu principal */}
          <div className="fixed inset-0 z-[9998] bg-black/60 transition-opacity duration-300" />
          <MobilePanel
            config={activeConfig}
            height={panelHeight}
            onChangeHeight={setPanelHeight}
            onClose={handleClosePanel}
            componentProps={panelProps[activePanel] || {}}
          />
        </>
      )}
    </>
  );
};

export default MobilePanelSystem;
