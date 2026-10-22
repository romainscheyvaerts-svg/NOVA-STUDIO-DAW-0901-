import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Menu déroulant du piano roll (22/10/2026) : « Outil ▾ », « Outils ▾ », « Notes ▾ »,
 * « Vue ▾ » et menu du clic droit. Une liste courte, lisible, au clavier
 * (↑ ↓ Entrée Échap) comme à la souris et au doigt (lignes de 44 px).
 * Échap ferme le menu sans fermer le piano roll.
 */

export type RollMenuEntry =
  | { kind: 'section'; label: string }
  | { kind: 'sep' }
  | {
      kind?: 'item';
      /** data-nova-roll (scénarios QA, aide). */
      id?: string;
      label: string;
      hint?: string;
      icon?: string;
      /** Raccourci affiché à droite. */
      keys?: string;
      /** Case cochée (bascule) : undefined = action simple. */
      checked?: boolean;
      disabled?: boolean;
      /** Garde le menu ouvert (bascules d'affichage). */
      keepOpen?: boolean;
      attrs?: Record<string, string>;
      onSelect: () => void;
    };

interface Props {
  name: string;
  label: string;
  entries: (RollMenuEntry | false | null | undefined)[];
  anchor: { x: number; y: number };
  onClose: () => void;
  width?: number;
}

const RollMenu: React.FC<Props> = ({ name, label, entries, anchor, onClose, width = 272 }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(anchor);
  const list = entries.filter(Boolean) as RollMenuEntry[];

  // Reste dans l'écran (en bas à droite, le menu remonte ou se décale).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(anchor.x, window.innerWidth - r.width - 8));
    const y = anchor.y + r.height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - r.height - 8) : anchor.y;
    setPos({ x, y });
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLButtonElement>('button.pr-menu-item:not(:disabled)');
    // Le focus va au menu seulement s'il a été ouvert au clavier (pas de cadre bleu à la souris).
    if (first && document.activeElement && (document.activeElement as HTMLElement).matches?.(':focus-visible')) first.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onClose(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button.pr-menu-item:not(:disabled)') || []);
        if (!items.length) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const n = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
        items[n].focus();
        return;
      }
      // Les autres raccourcis du piano roll restent actifs : le menu se ferme.
      if (e.key.length === 1 || e.ctrlKey || e.metaKey) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-[290]" onPointerDown={e => { e.stopPropagation(); onClose(); }} onContextMenu={e => e.preventDefault()} />
      <div ref={ref} role="menu" aria-label={label} data-nova-roll-menu={`liste-${name}`}
        className="pr-menu fixed z-[300] max-h-[78vh] overflow-y-auto" style={{ left: pos.x, top: pos.y, width: Math.min(width, window.innerWidth - 16) }}
        onContextMenu={e => e.preventDefault()}>
        {list.map((it, i) => {
          if (it.kind === 'section') return <div key={`s${i}`} className="pr-menu-sec" role="presentation">{it.label}</div>;
          if (it.kind === 'sep') return <div key={`p${i}`} className="pr-menu-sep" role="separator" />;
          const check = typeof it.checked === 'boolean';
          return (
            <button key={`${it.id || it.label}-${i}`} type="button" role={check ? 'menuitemcheckbox' : 'menuitem'} aria-checked={check ? it.checked : undefined}
              data-nova-roll={it.id} disabled={it.disabled} title={it.hint} className="pr-menu-item" {...(it.attrs || {})}
              onClick={() => { it.onSelect(); if (!it.keepOpen) onClose(); }}>
              <span className="pr-menu-ico" aria-hidden>
                {/* Coché : ✓ ; une bascule avec icône (outils) garde son icône, sinon un trait discret. */}
                {check && it.checked ? <i className="fas fa-check" /> : it.icon ? <i className={`fas ${it.icon} ${check ? 'opacity-60' : ''}`} /> : check ? <i className="fas fa-minus opacity-25" /> : null}
              </span>
              <span className="min-w-0">{it.label}</span>
              {it.keys && <span className="pr-menu-keys">{it.keys}</span>}
            </button>
          );
        })}
      </div>
    </>
  );
};

export default RollMenu;
