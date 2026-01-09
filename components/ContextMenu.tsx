
import React, { useEffect, useRef, useState } from 'react';
import { ContextMenuItem } from '../types';

interface ContextMenuProps {
  x: number;
  y: number;
  items: (ContextMenuItem | 'separator')[];
  onClose: () => void;
}

const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useEffect(() => {
    // Smart Positioning Logic
    if (menuRef.current) {
        const rect = menuRef.current.getBoundingClientRect();
        const screenW = window.innerWidth;
        const screenH = window.innerHeight;
        
        let newX = x;
        let newY = y;

        // Check Right Edge
        if (x + rect.width > screenW) {
            newX = x - rect.width;
        }

        // Check Bottom Edge
        if (y + rect.height > screenH) {
            newY = y - rect.height;
        }

        // Prevent top/left overflow
        newX = Math.max(0, newX);
        newY = Math.max(0, newY);

        setPosition({ x: newX, y: newY });
    }
  }, [x, y]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    
    // Timeout to prevent immediate close if the triggering click bubbles
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 50);
    
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  return (
    <div 
      ref={menuRef}
      className="fixed z-[9999] min-w-[200px] bg-[#1a1c22] border border-white/10 shadow-[0_10px_40px_rgba(0,0,0,0.8)] rounded-lg py-1.5 overflow-hidden animate-in fade-in zoom-in duration-75 text-[#e2e8f0]"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, idx) => {
        if (item === 'separator') {
            return <div key={`sep-${idx}`} className="h-px bg-white/10 my-1 mx-2"></div>;
        }

        return (
          <div key={idx} className="flex flex-col">
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!item.disabled) {
                    item.onClick();
                    onClose();
                }
              }}
              disabled={item.disabled}
              className={`w-full px-4 py-2 flex items-center justify-between text-[11px] font-medium transition-colors group ${
                  item.disabled 
                  ? 'opacity-40 cursor-not-allowed' 
                  : item.danger 
                    ? 'hover:bg-red-500/20 text-red-400 hover:text-red-300' 
                    : 'hover:bg-[#00f2ff] hover:text-black'
              }`}
            >
              <div className="flex items-center space-x-3">
                 {item.icon && <i className={`fas ${item.icon} w-4 text-center ${item.danger ? '' : 'text-slate-400 group-hover:text-black'}`}></i>}
                 <span>{item.label}</span>
              </div>
              {item.shortcut && (
                  <span className={`text-[9px] font-mono ml-4 ${item.disabled ? '' : 'text-slate-500 group-hover:text-black/60'}`}>
                      {item.shortcut}
                  </span>
              )}
            </button>
            {item.component && (
                <div className="px-2 pb-2 pt-1 border-b border-white/5 mb-1 bg-black/20">
                    {item.component}
                </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default ContextMenu;
