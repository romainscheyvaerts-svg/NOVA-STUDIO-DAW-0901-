import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Menu de la boîte à rythmes (clic droit, appui long, bouton « ⋯ ») : les commandes rares sont ici,
 * pas en boutons. Bureau : petite fenêtre à l'endroit du clic, gardée dans l'écran. Téléphone :
 * feuille en bas de l'écran. Lignes de 44 px (doigt), Échap ou clic dehors pour fermer, flèches ↑ / ↓.
 */
export type DrumMenuItem =
  | { kind?: 'item'; label: string; icon?: string; kbd?: string; checked?: boolean; disabled?: boolean; danger?: boolean; hint?: string; onClick: () => void; keepOpen?: boolean; testId?: string }
  | { kind: 'sep' }
  | { kind: 'title'; label: string }
  | { kind: 'choices'; label: string; value: string | number; options: { label: string; value: string | number; hint?: string }[]; onPick: (v: string | number) => void; testId?: string }
  | { kind: 'node'; node: React.ReactNode };

export interface DrumMenuState { x: number; y: number; title?: string; items: DrumMenuItem[] }

export const DrumMenu: React.FC<{ menu: DrumMenuState | null; onClose: () => void; narrow?: boolean }> = ({ menu, onClose, narrow }) => {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!menu || narrow) { setPos(null); return; }
    const el = box.current;
    const w = el?.offsetWidth || 260, h = el?.offsetHeight || 300;
    const left = Math.max(8, Math.min(menu.x, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(menu.y, window.innerHeight - h - 8));
    setPos({ left, top });
  }, [menu, narrow]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onClose(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.from(box.current?.querySelectorAll<HTMLElement>('[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio]') || []).filter(x => !(x as HTMLButtonElement).disabled);
        if (!items.length) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      }
    };
    const onDown = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey, true);
    const t = window.setTimeout(() => window.addEventListener('pointerdown', onDown, true), 0);
    return () => { window.removeEventListener('keydown', onKey, true); window.clearTimeout(t); window.removeEventListener('pointerdown', onDown, true); };
  }, [menu, onClose]);
  if (!menu) return null;
  const run = (fn: () => void, keep?: boolean) => { fn(); if (!keep) onClose(); };
  const body = (
    <div ref={box} role="menu" aria-label={menu.title || 'Menu'} data-testid="drum-menu" data-own-longpress=""
      onContextMenu={e => e.preventDefault()}
      // Portail : les événements React remontent quand même au panneau (téléphone : un clic sur son fond le ferme).
      onClick={e => e.stopPropagation()}
      className={narrow
        ? 'fixed inset-x-0 bottom-0 z-[700] max-h-[75vh] overflow-y-auto rounded-t-3xl border-t border-white/10 bg-nv-raised p-2 pb-[max(8px,env(safe-area-inset-bottom))] shadow-2xl'
        : 'fixed z-[700] w-[min(340px,calc(100vw-16px))] max-h-[min(80vh,640px)] overflow-y-auto rounded-2xl border border-white/15 bg-nv-raised p-1.5 shadow-2xl shadow-black/60'}
      style={narrow ? undefined : pos ? { left: pos.left, top: pos.top } : { left: menu.x, top: menu.y, visibility: 'hidden' }}>
      {menu.title && <p className="px-3 pt-1.5 pb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400 truncate">{menu.title}</p>}
      {menu.items.map((it, i) => {
        if (it.kind === 'sep') return <div key={i} className="my-1 h-px bg-white/10" />;
        if (it.kind === 'title') return <p key={i} className="px-3 pt-2 pb-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">{it.label}</p>;
        if (it.kind === 'node') return <div key={i} className="px-2 py-1">{it.node}</div>;
        if (it.kind === 'choices') return (
          <div key={i} className="px-2 py-1" role="group" aria-label={it.label} data-testid={it.testId}>
            <p className="px-1 pb-1 text-[11px] text-slate-400">{it.label}</p>
            <div className="flex flex-wrap gap-1">
              {it.options.map(o => (
                <button key={String(o.value)} type="button" role="menuitemradio" aria-checked={o.value === it.value} title={o.hint}
                  onClick={() => run(() => it.onPick(o.value), true)}
                  className={`min-h-[44px] min-w-[44px] px-2.5 rounded-lg text-[12px] font-bold tabular-nums ${o.value === it.value ? 'bg-cyan-500 text-black' : 'bg-white/[0.06] text-nv-ink hover:bg-white/10'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        );
        return (
          <button key={i} type="button" role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={it.checked === undefined ? undefined : it.checked}
            disabled={it.disabled} title={it.hint} data-testid={it.testId}
            onClick={() => run(it.onClick, it.keepOpen)}
            className={`w-full min-h-[44px] flex items-center gap-2.5 px-3 rounded-xl text-left text-[13px] disabled:opacity-40 ${it.danger ? 'text-red-400 hover:bg-red-500/10' : 'text-nv-ink hover:bg-white/10'} focus:bg-white/10 outline-none`}>
            <span className="w-4 text-center shrink-0">{it.checked ? <i className="fas fa-check text-cyan-400" aria-hidden /> : it.icon ? <i className={`fas ${it.icon} text-slate-400`} aria-hidden /> : null}</span>
            <span className="flex-1 min-w-0 truncate">{it.label}</span>
            {it.kbd && <kbd className="shrink-0 text-[10px] font-bold text-slate-500 bg-white/5 rounded px-1.5 py-0.5">{it.kbd}</kbd>}
          </button>
        );
      })}
    </div>
  );
  return createPortal(narrow ? <><div className="fixed inset-0 z-[699] bg-black/40" onPointerDown={onClose} onClick={e => e.stopPropagation()} />{body}</> : body, document.body);
};

/** Ouvre un menu à la position d'un événement (clic droit) ou sous un bouton. */
export function menuAt(e: { clientX: number; clientY: number } | React.MouseEvent | React.PointerEvent, title: string | undefined, items: DrumMenuItem[]): DrumMenuState {
  // Événement sans position (clavier, appui long synthétique) : au milieu de l'écran.
  const x = Number.isFinite(e.clientX) && (e.clientX || e.clientY) ? e.clientX : Math.max(8, window.innerWidth / 2 - 170);
  const y = Number.isFinite(e.clientY) && (e.clientX || e.clientY) ? e.clientY : Math.max(8, window.innerHeight / 4);
  return { x, y, title, items };
}
export function menuUnder(el: HTMLElement, title: string | undefined, items: DrumMenuItem[]): DrumMenuState {
  const r = el.getBoundingClientRect();
  return { x: Math.max(8, r.right - 280), y: r.bottom + 4, title, items };
}
