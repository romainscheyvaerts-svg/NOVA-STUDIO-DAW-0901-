
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

  // Recalage dans l'écran (G3) sur la taille réelle (offset*, insensible à
  // l'animation de zoom), et défilement interne si le menu est plus haut que l'écran.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const screenW = window.innerWidth, screenH = window.innerHeight;
    let newX = x + w > screenW - 4 ? x - w : x;
    let newY = y + h > screenH - 4 ? Math.min(y - h, screenH - h - 4) : y;
    newX = Math.max(4, Math.min(newX, screenW - w - 4));
    newY = Math.max(4, newY);
    setPosition({ x: newX, y: newY });
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
      className="fixed z-[9999] min-w-[200px] bg-[#1a1c22] border border-white/10 shadow-[0_10px_40px_rgba(0,0,0,0.8)] rounded-lg py-1.5 animate-in fade-in zoom-in duration-75 text-[#e2e8f0]"
      style={{ left: position.x, top: position.y, maxHeight: 'calc(100vh - 8px)', overflowY: 'auto' }}
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
              title={item.title}
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
