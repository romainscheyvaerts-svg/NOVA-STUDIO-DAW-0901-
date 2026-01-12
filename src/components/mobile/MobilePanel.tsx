import React, { useState, useRef } from 'react';

export interface PanelConfig {
  id: string;
  title: string;
  icon: string;
  component: React.ComponentType<any>;
  defaultHeight: 'half' | 'full';
  canResize: boolean;
}

interface MobilePanelProps {
  config: PanelConfig;
  height: 'half' | 'full';
  onChangeHeight: (h: 'half' | 'full') => void;
  onClose: () => void;
  componentProps?: any;
}

const MobilePanel: React.FC<MobilePanelProps> = ({ 
  config, 
  height, 
  onChangeHeight, 
  onClose,
  componentProps = {}
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const startY = useRef(0);
  const currentY = useRef(0);
  
  const handleDragStart = (e: React.TouchEvent) => {
    setIsDragging(true);
    startY.current = e.touches[0].clientY;
    currentY.current = e.touches[0].clientY;
  };
  
  const handleDrag = (e: React.TouchEvent) => {
    if (!isDragging) return;
    currentY.current = e.touches[0].clientY;
  };
  
  const handleDragEnd = () => {
    if (!isDragging) return;
    
    const deltaY = currentY.current - startY.current;
    
    // Swipe down = close or reduce
    if (deltaY > 100) {
      if (height === 'full' && config.canResize) {
        onChangeHeight('half');
      } else {
        onClose();
      }
    }
    // Swipe up = expand
    else if (deltaY < -100 && height === 'half' && config.canResize) {
      onChangeHeight('full');
    }
    
    setIsDragging(false);
  };
  
  const PanelComponent = config.component;
  
  return (
    <div 
      className={`fixed left-0 right-0 bottom-0 bg-[#12141a] rounded-t-3xl shadow-2xl transition-all duration-300 ease-out z-[90] ${
        height === 'full' ? 'top-0' : 'top-1/2'
      }`}
      style={{
        paddingLeft: 'max(16px, env(safe-area-inset-left))',
        paddingRight: 'max(16px, env(safe-area-inset-right))',
      }}
    >
      {/* Handle de drag */}
      <div 
        className="h-8 flex items-center justify-center cursor-grab active:cursor-grabbing"
        onTouchStart={handleDragStart}
        onTouchMove={handleDrag}
        onTouchEnd={handleDragEnd}
      >
        <div className="w-12 h-1 bg-white/30 rounded-full"></div>
      </div>
      
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <i className={`fas ${config.icon} text-cyan-400`}></i>
          <span className="text-white font-bold">{config.title}</span>
        </div>
        <button 
          onClick={onClose} 
          className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center hover:bg-white/20 transition-colors"
        >
          <i className="fas fa-times text-white/70"></i>
        </button>
      </div>
      
      {/* Contenu du panneau */}
      <div className="overflow-y-auto" style={{ height: 'calc(100% - 5rem)' }}>
        <PanelComponent {...componentProps} />
      </div>
    </div>
  );
};

export default MobilePanel;
