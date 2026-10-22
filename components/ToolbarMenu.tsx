import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Menu déroulant des barres (transport, outils d'édition, bandeau du bas, piste, tranche).
 *
 * « Trop de boutons » (22/10/2026) : les commandes rares sont rangées dans des menus
 * nommés (« Édition ▾ », « Outils ▾ », « Vue ▾ », « Session ▾ », « ⋯ » d'une piste).
 * Le contenu n'est monté QU'À L'OUVERTURE (léger : rien à rendre tant qu'il est fermé),
 * posé dans <body> (au-dessus des pistes), recalé dans l'écran, fermé par Échap
 * (sans arrêter la lecture) ou par un clic à côté. Le bouton garde ses attributs
 * (`data-testid`, `data-nova-target`, `data-bar-item`…) passés dans `triggerProps`.
 */
export interface ToolbarMenuProps {
  /** Contenu du bouton (icône, libellé, pastilles d'état). */
  label: React.ReactNode;
  title: string;
  ariaLabel: string;
  testId?: string;
  /** Nom du menu (lecteurs d'écran). */
  menuLabel: string;
  triggerClassName: string;
  triggerStyle?: React.CSSProperties;
  /** Attributs en plus sur le bouton (data-bar-item, data-nova-target…). */
  triggerProps?: Record<string, unknown>;
  /** Largeur du menu (px). */
  width?: number;
  /** Aligné sur le bord droit du bouton (barres collées à droite). */
  alignRight?: boolean;
  /** Contenu, rendu seulement quand le menu est ouvert. `close` le referme. */
  children: (close: () => void) => React.ReactNode;
  /** Ouvert / fermé (pour l'état du bouton). */
  onOpenChange?: (open: boolean) => void;
}

const ToolbarMenu: React.FC<ToolbarMenuProps> = ({
  label, title, ariaLabel, testId, menuLabel, triggerClassName, triggerStyle, triggerProps, width = 280, alignRight = false, children, onOpenChange,
}) => {
  const [open, setOpenState] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const setOpen = (v: boolean) => { setOpenState(v); onOpenChange?.(v); };
  const close = () => setOpen(false);

  // Sous le bouton s'il tient, sinon au-dessus, sinon collé en bas avec défilement.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      const w = Math.min(width, vw - 16);
      const h = menuRef.current?.scrollHeight || 320;
      const maxHeight = vh - 16;
      let top = r.bottom + 6;
      if (top + Math.min(h, maxHeight) > vh - 8) top = r.top - 6 - h >= 8 ? r.top - 6 - h : Math.max(8, vh - 8 - Math.min(h, maxHeight));
      const left = alignRight ? Math.max(8, Math.min(r.right - w, vw - w - 8)) : Math.max(8, Math.min(r.left, vw - w - 8));
      setPos({ left, top, maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, width, alignRight]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      // Sous-fenêtre ouverte depuis le menu (liste d'un <select>, popover gardé) : on reste ouvert.
      if (t instanceof Element && t.closest('[data-toolbar-menu-keep]')) return;
      setOpen(false);
    };
    // Échap : ferme le menu sans arrêter la lecture ni fermer autre chose.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation(); e.preventDefault();
      setOpen(false); btnRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <button ref={btnRef} type="button" {...triggerProps} data-testid={testId}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        onMouseDown={(e) => e.stopPropagation()}
        aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} title={title}
        className={triggerClassName} style={triggerStyle}>
        {label}
      </button>
      {open && createPortal(
        <div ref={menuRef} role="menu" aria-label={menuLabel} data-toolbar-menu={testId || menuLabel}
          onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}
          className="fixed z-[700] overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-nv-surface p-2 text-[12px] shadow-[0_10px_40px_rgba(0,0,0,0.6)]"
          style={{ width: Math.min(width, typeof window !== 'undefined' ? window.innerWidth - 16 : width), left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: pos?.maxHeight, color: 'var(--text-primary)' }}>
          {children(close)}
        </div>,
        document.body,
      )}
    </>
  );
};

export default ToolbarMenu;

/** Titre de section d'un menu. */
export const MenuSection: React.FC<{ title: string; children: React.ReactNode; first?: boolean }> = ({ title, children, first }) => (
  <div className={first ? '' : 'mt-2 border-t border-white/5 pt-2'}>
    <div className="px-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</div>
    {children}
  </div>
);

/** Ligne de menu : icône, libellé, état à droite (pastille, raccourci). */
export const menuRowClass = (on = false) =>
  `w-full min-h-9 [@media(pointer:coarse)]:min-h-11 px-2 rounded-lg flex items-center gap-2 text-left text-[12px] font-semibold transition-colors ${on ? 'bg-cyan-500/15 text-cyan-200 [[data-theme=light]_&]:text-cyan-800' : 'hover:bg-white/5'}`;

/** Interrupteur à droite d'une ligne de menu. */
export const MenuSwitch: React.FC<{ on: boolean }> = ({ on }) => (
  <span className={`ml-auto relative shrink-0 w-8 h-4 rounded-full transition-colors ${on ? 'bg-cyan-500' : 'bg-white/15'}`} aria-hidden="true">
    <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
  </span>
);
