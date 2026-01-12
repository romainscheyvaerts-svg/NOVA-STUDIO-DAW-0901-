import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ContextMenuItem } from '../types';

interface ContextMenuProps {
  x: number;
  y: number;
  items: (ContextMenuItem | 'separator')[];
  onClose: () => void;
}

const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Adjust position to keep menu in viewport
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const adjustedX = x + rect.width > window.innerWidth ? x - rect.width : x;
      const adjustedY = y + rect.height > window.innerHeight ? y - rect.height : y;

      menuRef.current.style.left = `${Math.max(0, adjustedX)}px`;
      menuRef.current.style.top = `${Math.max(0, adjustedY)}px`;
    }
  }, [x, y]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[10000] bg-[#14161a] border border-white/10 rounded-xl shadow-2xl py-2 min-w-[180px] animate-in fade-in zoom-in-95 duration-100"
      style={{ left: x, top: y }}
    >
      {items.map((item, index) => {
        if (item === 'separator' || (typeof item === 'object' && item.label === 'separator')) {
          return <div key={index} className="h-px bg-white/10 my-1 mx-2" />;
        }

        const menuItem = item as ContextMenuItem;

        if (menuItem.component) {
          return <div key={index} className="px-2">{menuItem.component}</div>;
        }

        return (
          <button
            key={index}
            onClick={() => {
              if (!menuItem.disabled) {
                menuItem.onClick();
                onClose();
              }
            }}
            disabled={menuItem.disabled}
            className={`w-full px-4 py-2 text-left flex items-center justify-between text-[11px] transition-all ${
              menuItem.danger
                ? 'text-red-400 hover:bg-red-500/10'
                : menuItem.disabled
                ? 'text-slate-600 cursor-not-allowed'
                : 'text-slate-300 hover:bg-white/5 hover:text-white'
            }`}
          >
            <div className="flex items-center">
              {menuItem.icon && (
                <i className={`fas ${menuItem.icon} w-5 mr-2 text-[10px] opacity-60`}></i>
              )}
              <span>{menuItem.label}</span>
            </div>
            {menuItem.shortcut && (
              <span className="text-[9px] text-slate-600 ml-4">{menuItem.shortcut}</span>
            )}
          </button>
        );
      })}
    </div>,
    document.body
  );
};

export default ContextMenu;
