import React, { useLayoutEffect, useRef, useState } from 'react';
import { PluginInstance } from '../types';
import { PluginName, usePluginTitle } from './PluginName';
import { FloatingMenu, handlePluginModifierClick, pluginStateClass, pluginStateHelp, pluginStateMenuItems, useLongPress } from './TrackStructure';

/**
 * Effets de la piste, lisibles d'un coup d'œil (comme les inserts de Pro Tools) :
 * un clic ouvre l'effet, Ctrl+clic l'active / le désactive. Ce qui ne tient pas
 * dans la largeur est annoncé par « +N », qui ouvre la liste complète.
 */
export interface TrackInsertStripProps {
  trackId: string;
  plugins: PluginInstance[];
  isBaked: (p: PluginInstance) => boolean;
  onOpen: (e: React.MouseEvent, p: PluginInstance) => void;
  onToggle: (e: React.MouseEvent, p: PluginInstance) => void;
  onRemove: (e: React.MouseEvent, id: string) => void;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onShowAll: (e: React.MouseEvent) => void;
  /** Avant les effets (piste armée : vumètre + retour casque). */
  leading?: React.ReactNode;
  /** Piste vide : effets prêts mais grisés (F8), on lit tout de suite où il y a du son. */
  idle?: boolean;
}

const Chip: React.FC<{ p: PluginInstance; baked: boolean; trackId: string } & Omit<TrackInsertStripProps, 'trackId' | 'plugins' | 'isBaked' | 'onShowAll'>> = ({ p, baked, trackId, onOpen, onToggle, onRemove, onDragStart }) => {
  const bakedVst = baked && p.type === 'VST3';
  // Menu de l'effet (clic droit, appui long au doigt) : actif / bypass / inactif.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { consumed: lpConsumed, ...lpHandlers } = useLongPress((x, y) => { if (!baked) setMenu({ x, y }); });
  const title = usePluginTitle(p);
  return (
    <div
      draggable={!baked}
      onDragStart={(e) => { if (baked) return; e.stopPropagation(); onDragStart(e, p.id); }}
      data-fx-baked={baked ? '1' : undefined}
      className={`relative group/fxitem fx-slot shrink-0 max-w-[150px] ${baked ? (bakedVst ? 'opacity-70' : 'pointer-events-none opacity-40') : ''}`}
    >
      <button
        type="button"
        onClick={(e) => {
          if (lpConsumed()) return;
          // Ctrl+clic : bypass ; Ctrl+Alt+clic : actif / inactif (Pro Tools : Ctrl+Démarrer+clic).
          if (!baked && handlePluginModifierClick(e, trackId, p, () => onToggle(e, p))) return;
          onOpen(e, p);
        }}
        onContextMenu={(e) => { if (baked) return; e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); }}
        {...lpHandlers}
        title={bakedVst
          ? "Rendu (VST du PC) : déjà inclus dans l'audio de la piste. Pour le régler, ouvre le projet sur ton PC avec le pont VST."
          : baked ? 'Inclus dans le rendu gelé de la piste' : `${title} · ${pluginStateHelp(p)}`}
        aria-label={`Ouvrir ${p.name || p.type}`}
        data-fx-state={p.isInactive ? 'inactive' : p.isEnabled ? 'active' : 'bypass'}
        className={`max-w-full h-5 rounded-md border px-1.5 text-[10px] font-semibold flex items-center transition-colors ${pluginStateClass(p)} ${p.isEnabled && !p.isInactive
          ? (p.type === 'VST3' ? 'border-fuchsia-400/25 bg-fuchsia-500/10 text-fuchsia-100 hover:bg-fuchsia-500/20' : 'border-cyan-400/20 bg-black/40 text-cyan-100 hover:bg-white/10')
          : `border-white/5 bg-black/20 text-slate-500 ${p.isInactive ? '' : 'line-through'}`}`}
      >
        <PluginName plugin={p} showDetail compact />
      </button>
      {!baked && <button type="button" onClick={(e) => onRemove(e, p.id)} className="delete-fx" title="Retirer l'effet" aria-label={`Retirer ${p.name || p.type}`}><i className="fas fa-times"></i></button>}
      {menu && <FloatingMenu x={menu.x} y={menu.y} title={p.name || p.type} onClose={() => setMenu(null)} items={pluginStateMenuItems(trackId, p, () => onOpen({ stopPropagation() {}, preventDefault() {} } as unknown as React.MouseEvent, p))} />}
    </div>
  );
};

const TrackInsertStrip: React.FC<TrackInsertStripProps> = (props) => {
  const { trackId, plugins, isBaked, onShowAll } = props;
  const box = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(0);

  // Combien d'effets dépassent de la largeur visible : annoncés par « +N ».
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const chips = Array.from(el.querySelectorAll<HTMLElement>(':scope > .fx-slot'));
      chips.forEach(c => { c.style.visibility = ''; });
      const overflow = el.scrollWidth > el.clientWidth + 1;
      // Seulement des effets ENTIERS (pas de « Ég… » coupé) ; les autres sont comptés dans « +N ».
      const right = el.getBoundingClientRect().left + el.clientWidth - (overflow ? 34 : 0);
      let n = 0;
      chips.forEach(c => {
        const out = c.getBoundingClientRect().right > right + 0.5;
        if (overflow && out) { c.style.visibility = 'hidden'; n++; }
      });
      setHidden(n);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [plugins]);

  return (
    <div className="mt-1 flex items-center gap-1 min-h-0 shrink-0">
      {props.leading}
      <div ref={box} className={`flex min-w-0 flex-1 gap-1 overflow-x-auto overflow-y-hidden no-scrollbar ${props.idle ? 'opacity-50' : ''}`} data-testid={`inserts-${trackId}`}
        title={props.idle ? 'Piste vide : ces effets sont prêts pour ta prochaine prise ici' : undefined}>
        {plugins.map(p => <Chip key={p.id} p={p} baked={isBaked(p)} {...props} trackId={trackId} />)}
      </div>
      {hidden > 0 && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onShowAll(e); }}
          title={`${hidden} autre${hidden > 1 ? 's' : ''} effet${hidden > 1 ? 's' : ''} : voir la liste complète`}
          aria-label={`Voir les ${plugins.length} effets`}
          data-testid={`inserts-plus-${trackId}`}
          className="shrink-0 h-5 rounded-md bg-cyan-500/20 px-1.5 text-[10px] font-black text-cyan-200 hover:bg-cyan-500/35">
          +{hidden}
        </button>
      )}
    </div>
  );
};

export default TrackInsertStrip;
