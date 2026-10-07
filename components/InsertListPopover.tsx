import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PluginInstance } from '../types';
import { PluginName } from './PluginName';

/**
 * Liste complète des effets d'une tranche (« +N » de la console, audit B5) :
 * clic = ouvrir l'effet, ⏻ = activer / désactiver. Ancrée au bouton, recalée
 * dans l'écran, fermée par Échap ou un clic ailleurs.
 */
const InsertListPopover: React.FC<{
  anchor: DOMRect;
  title: string;
  plugins: PluginInstance[];
  onOpen: (p: PluginInstance) => void;
  onToggle: (p: PluginInstance) => void;
  onAdd?: (x: number, y: number) => void;
  onClose: () => void;
}> = ({ anchor, title, plugins, onOpen, onToggle, onAdd, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('mousedown', down);
    window.addEventListener('touchstart', down);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('touchstart', down); window.removeEventListener('keydown', key, true); };
  }, [onClose]);

  const W = 240;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - W - 8));
  // Position calculée sur la vraie hauteur : sous le bouton, sinon au-dessus, sinon collée en bas.
  const [top, setTop] = useState(anchor.bottom + 4);
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight || 0;
    const vh = window.innerHeight;
    if (anchor.bottom + 4 + h <= vh - 8) setTop(anchor.bottom + 4);
    else if (anchor.top - 4 - h >= 8) setTop(anchor.top - 4 - h);
    else setTop(Math.max(8, vh - 8 - h));
  }, [anchor, plugins.length]);

  return (
    <div ref={ref} role="menu" aria-label={title} data-testid="insert-list"
      className="fixed z-[600] rounded-xl border border-white/10 bg-[#14161c] p-1.5 shadow-2xl max-h-[calc(100vh-16px)] overflow-y-auto"
      style={{ left, top, width: W }} onClick={e => e.stopPropagation()}>
      <p className="px-2 pt-1 pb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">{title}</p>
      {plugins.map((p, i) => (
        <div key={p.id} className="flex items-center gap-1 rounded-lg hover:bg-white/5">
          <span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-slate-600">{i + 1}</span>
          <button type="button" role="menuitem" onClick={() => { onClose(); onOpen(p); }}
            className={`flex-1 min-w-0 truncate px-2 py-1.5 [@media(pointer:coarse)]:py-2.5 text-left text-[12px] font-semibold ${p.isEnabled ? 'text-white' : 'text-slate-500 line-through'}`}>
            <PluginName plugin={p} showDetail className="max-w-full" />
          </button>
          <button type="button" onClick={() => onToggle(p)} aria-pressed={p.isEnabled}
            title={p.isEnabled ? "Désactiver l'effet" : "Activer l'effet"}
            aria-label={`${p.isEnabled ? 'Désactiver' : 'Activer'} ${p.name || p.type}`}
            className={`nova-hit-tactile w-7 h-7 rounded-md flex items-center justify-center ${p.isEnabled ? 'text-cyan-400' : 'text-slate-600'}`}>
            <i className="fas fa-power-off text-[9px]" />
          </button>
        </div>
      ))}
      {onAdd && (
        <button type="button" onClick={(e) => { onClose(); onAdd(e.clientX, e.clientY); }}
          className="mt-1 w-full rounded-lg bg-cyan-500/15 px-2 py-1.5 [@media(pointer:coarse)]:py-2.5 text-left text-[12px] font-bold text-cyan-300 hover:bg-cyan-500/25">
          <i className="fas fa-plus mr-1.5 text-[10px]" /> Ajouter un effet
        </button>
      )}
    </div>
  );
};

export default InsertListPopover;
