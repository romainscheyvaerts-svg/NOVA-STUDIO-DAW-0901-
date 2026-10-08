
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

  // Clavier, comme un menu de Pro Tools : Échap ferme (avant : Échap passait au transport
  // et le menu restait ouvert), ↑ ↓ parcourent les entrées, Entrée lance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = menuRef.current;
      if (!el) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const btns = Array.from(el.querySelectorAll<HTMLButtonElement>('button[role=menuitem]:not(:disabled)'));
      if (!btns.length) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i <= 0 ? btns.length - 1 : i - 1);
      btns[next].focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div 
      ref={menuRef}
      role="menu"
      aria-label="Menu contextuel"
      className="fixed z-[9999] min-w-[200px] rounded-xl border border-nv-line/15 bg-nv-raised p-1 shadow-2xl animate-in fade-in zoom-in duration-75 text-nv-ink"
      style={{ left: position.x, top: position.y, maxHeight: 'calc(100vh - 8px)', overflowY: 'auto' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, idx) => {
        if (item === 'separator') {
            return <div key={`sep-${idx}`} className="h-px bg-nv-line/10 my-1 mx-2"></div>;
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
              role="menuitem"
              // Même style que les menus de piste (TrackStructure.FloatingMenu) : un seul look de menu.
              className={`w-full rounded-lg px-2 py-1.5 [@media(pointer:coarse)]:py-2.5 flex items-center justify-between text-left text-[12px] font-semibold transition-colors group outline-none ${
                  item.disabled
                  ? 'opacity-40 cursor-not-allowed'
                  : item.danger
                    ? 'text-red-400 hover:bg-red-500/10 focus-visible:bg-red-500/10'
                    : 'hover:bg-nv-accent/10 focus-visible:bg-nv-accent/10'
              }`}
            >
              <div className="flex items-center space-x-3">
                 {item.icon && <i className={`fas ${item.icon} w-4 text-center text-[10px] ${item.danger ? '' : 'text-nv-muted'}`}></i>}
                 <span>{item.label}</span>
              </div>
              {item.shortcut && (
                  <span className="text-[10px] font-mono ml-4 text-nv-muted">
                      {item.shortcut}
                  </span>
              )}
            </button>
            {item.component && (
                <div className="px-2 pb-2 pt-1 border-b border-nv-line/10 mb-1">
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
