
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ContextMenuItem } from '../types';

type Entry = ContextMenuItem | 'separator';

interface ContextMenuProps {
  x: number;
  y: number;
  items: Entry[];
  onClose: () => void;
}

/** Sous-menus « en place » (← Retour) au lieu d'un volet à côté : écrans étroits (téléphone). */
const DRILL_MAX_W = 640;

/** Libellés d'un sous-menu, pour les scénarios QA et les lecteurs d'écran (data-submenu). */
const subLabels = (items: Entry[]) => items.filter((x): x is ContextMenuItem => x !== 'separator').map(x => x.label).join('\n');

/**
 * Menu contextuel (clip, règle, marqueur…). Une entrée peut ouvrir un sous-menu
 * (`submenu`) : survol à la souris, clic ou doigt, → / Entrée au clavier ;
 * ← ou Échap le referme. Sur téléphone, le sous-menu s'ouvre à la place du menu
 * (« ‹ Retour »), le doigt n'a pas à viser un volet à côté.
 */
const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  const [sub, setSub] = useState<{ index: number; focusFirst: boolean } | null>(null);
  const [subPos, setSubPos] = useState<{ x: number; y: number } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const drill = typeof window !== 'undefined' && window.innerWidth < DRILL_MAX_W;
  const rawSub = sub ? items[sub.index] : undefined;
  const subItem = rawSub && rawSub !== 'separator' ? rawSub : undefined;
  const subEntries = subItem?.submenu || null;

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
  }, [x, y, drill && sub ? sub.index : -1]);

  // Volet du sous-menu : à droite de l'entrée, à gauche s'il n'y a pas la place, dans l'écran.
  useLayoutEffect(() => {
    if (!sub || drill) { setSubPos(null); return; }
    const trigger = menuRef.current?.querySelector<HTMLElement>(`[data-menu-index="${sub.index}"]`);
    const el = subRef.current;
    if (!trigger || !el) return;
    const r = trigger.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    const screenW = window.innerWidth, screenH = window.innerHeight;
    let sx = r.right + 2;
    if (sx + w > screenW - 4) sx = Math.max(4, r.left - w - 2);
    let sy = r.top - 4;
    if (sy + h > screenH - 4) sy = Math.max(4, screenH - h - 4);
    setSubPos({ x: sx, y: sy });
  }, [sub, drill, position.x, position.y]);

  useEffect(() => {
    if (sub?.focusFirst) {
      const panel = drill ? menuRef.current : subRef.current;
      requestAnimationFrame(() => panel?.querySelector<HTMLButtonElement>('button[role=menuitem]:not(:disabled)')?.focus());
    }
  }, [sub, drill, subPos]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
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

  useEffect(() => () => { if (hoverTimer.current) window.clearTimeout(hoverTimer.current); }, []);

  const closeSub = useCallback((refocus: boolean) => {
    const idx = sub?.index;
    setSub(null);
    if (refocus && idx !== undefined) requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>(`[data-menu-index="${idx}"]`)?.focus());
  }, [sub]);

  // Clavier, comme un menu de Pro Tools : Échap ferme (avant : Échap passait au transport
  // et le menu restait ouvert), ↑ ↓ parcourent les entrées, → ouvre un sous-menu, ← le
  // referme, Entrée lance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = menuRef.current;
      if (!root) return;
      const panel = sub && !drill ? subRef.current : root;
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (sub) closeSub(true); else onClose();
        return;
      }
      if (e.key === 'ArrowLeft' && sub) { e.preventDefault(); e.stopImmediatePropagation(); closeSub(true); return; }
      if (e.key === 'ArrowRight' && !sub) {
        const a = document.activeElement as HTMLElement | null;
        const idx = a?.dataset?.menuIndex;
        if (a && root.contains(a) && idx !== undefined && a.getAttribute('aria-haspopup') === 'menu' && !(a as HTMLButtonElement).disabled) {
          e.preventDefault(); e.stopImmediatePropagation(); setSub({ index: Number(idx), focusFirst: true });
        }
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (!panel) return;
      const btns = Array.from(panel.querySelectorAll<HTMLButtonElement>('button[role=menuitem]:not(:disabled)'));
      if (!btns.length) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i <= 0 ? btns.length - 1 : i - 1);
      btns[next].focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, sub, drill, closeSub]);

  const renderItems = (list: Entry[], level: 0 | 1) => list.map((item, idx) => {
    if (item === 'separator') {
      return <div key={`sep-${idx}`} className="h-px bg-nv-line/10 my-1 mx-2" role="separator"></div>;
    }
    const hasSub = level === 0 && !!item.submenu;
    const expanded = hasSub && sub?.index === idx;
    return (
      <div key={idx} className="flex flex-col">
        <button
          type="button"
          data-menu-index={level === 0 ? idx : undefined}
          data-submenu={hasSub ? subLabels(item.submenu!) : undefined}
          aria-haspopup={hasSub ? 'menu' : undefined}
          aria-expanded={hasSub ? expanded : undefined}
          onPointerEnter={(e) => {
            if (level !== 0 || drill || e.pointerType !== 'mouse') return;
            if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
            // Souris : le sous-menu suit le survol (petit délai, pour traverser sans tout ouvrir).
            hoverTimer.current = window.setTimeout(() => {
              if (hasSub && !item.disabled) setSub({ index: idx, focusFirst: false });
              else setSub(null);
            }, hasSub ? 90 : 220);
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (item.disabled) return;
            if (hasSub) { setSub(expanded && !drill ? null : { index: idx, focusFirst: e.detail === 0 }); return; }
            item.onClick();
            onClose();
          }}
          onKeyDown={(e) => {
            if (hasSub && (e.key === 'Enter' || e.key === ' ') && !item.disabled) {
              e.preventDefault(); e.stopPropagation(); setSub({ index: idx, focusFirst: true });
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
                : expanded
                  ? 'bg-nv-accent/10'
                  : 'hover:bg-nv-accent/10 focus-visible:bg-nv-accent/10'
          }`}
        >
          <div className="flex items-center space-x-3">
             {item.icon && <i className={`fas ${item.icon} w-4 text-center text-[10px] ${item.danger ? '' : 'text-nv-muted'}`} aria-hidden="true"></i>}
             <span>{item.label}</span>
          </div>
          {hasSub ? (
            <i className="fas fa-chevron-right ml-4 text-[9px] text-nv-muted" aria-hidden="true"></i>
          ) : item.shortcut && (
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
  });

  const panel = 'fixed z-[9999] min-w-[200px] rounded-xl border border-nv-line/15 bg-nv-raised p-1 shadow-2xl text-nv-ink';
  const drilled = drill && subEntries;

  return (
    <div ref={wrapRef} style={{ display: 'contents' }}>
      <div
        ref={menuRef}
        role="menu"
        aria-label={drilled ? subItem!.label : 'Menu contextuel'}
        className={`${panel} animate-in fade-in zoom-in duration-75`}
        style={{ left: position.x, top: position.y, maxHeight: 'calc(100vh - 8px)', overflowY: 'auto' }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {drilled ? (
          <>
            <button type="button" role="menuitem" onClick={(e) => { e.stopPropagation(); closeSub(true); }}
              className="w-full rounded-lg px-2 py-1.5 [@media(pointer:coarse)]:py-2.5 flex items-center gap-3 text-left text-[12px] font-black text-nv-accent-ink hover:bg-nv-accent/10 focus-visible:bg-nv-accent/10 outline-none">
              <i className="fas fa-chevron-left w-4 text-center text-[10px]" aria-hidden="true"></i>
              <span>{subItem!.label}</span>
            </button>
            <div className="h-px bg-nv-line/10 my-1 mx-2" role="separator"></div>
            {renderItems(subEntries!, 1)}
          </>
        ) : renderItems(items, 0)}
      </div>
      {subEntries && !drill && (
        <div
          ref={subRef}
          role="menu"
          aria-label={subItem!.label}
          data-testid="context-submenu"
          className={panel}
          style={{ left: subPos?.x ?? -9999, top: subPos?.y ?? -9999, maxHeight: 'calc(100vh - 8px)', overflowY: 'auto', visibility: subPos ? 'visible' : 'hidden' }}
          onContextMenu={(e) => e.preventDefault()}
          onPointerEnter={() => { if (hoverTimer.current) window.clearTimeout(hoverTimer.current); }}
        >
          {renderItems(subEntries, 1)}
        </div>
      )}
    </div>
  );
};

export default ContextMenu;
