import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { closePopout, openPopout, popoutStore, usePopout } from '../utils/popoutWindow';
import { registerLayoutPart } from '../utils/windowLayouts';

/**
 * Console sur un 2e écran (écart 17) : rend la console dans sa fenêtre détachée
 * (utils/popoutWindow, portail React : même état, même moteur, vumètres et automation
 * compris). La disposition de fenêtres retient si la console est détachée (rappel =
 * ouverture, puisqu'il suit un geste). Monté une fois par App ; rien sans fenêtre.
 */
export const PopoutHost: React.FC<{ renderConsole: () => React.ReactNode }> = ({ renderConsole }) => {
  const consoleOut = usePopout('console');
  useEffect(() => registerLayoutPart('popout', {
    get: () => ({ console: popoutStore.isOpen('console') }),
    set: (v) => { if (!v || typeof v !== 'object') return; if (v.console) openPopout('console'); else closePopout('console'); },
  }), []);
  if (!consoleOut) return null;
  return createPortal(
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="popout-console" style={{ backgroundColor: 'var(--bg-main)', color: 'var(--text-primary)' }}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-[12px]" style={{ borderColor: 'var(--border-dim)', backgroundColor: 'var(--bg-surface)' }}>
        <i className="fas fa-sliders-h text-nv-accent" aria-hidden="true" />
        <span className="font-bold text-nv-ink">Console</span>
        <span className="text-nv-muted">· fenêtre détachée (2e écran) : tout reste lié au studio</span>
        <button type="button" onClick={() => closePopout('console')} data-testid="popout-console-return"
          className="ml-auto h-7 rounded-md border border-nv-line bg-nv-well px-2.5 text-[11px] font-bold text-nv-ink hover:bg-nv-accent/15">
          <i className="fas fa-compress-alt mr-1" aria-hidden="true" />Ramener dans la fenêtre principale
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{renderConsole()}</div>
    </div>,
    consoleOut.container,
  );
};

/** À la place de la console dans la fenêtre principale quand elle est détachée. */
export const ConsoleElsewhere: React.FC = () => (
  <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="console-elsewhere">
    <i className="fas fa-desktop text-3xl text-nv-accent" aria-hidden="true" />
    <p className="text-[15px] font-bold text-nv-ink">La console est sur l'autre écran</p>
    <p className="max-w-md text-[12px] text-nv-muted">Elle bouge avec le studio : faders, vumètres, effets et automation. Ferme sa fenêtre pour la ramener ici.</p>
    <div className="flex flex-wrap justify-center gap-2">
      <button type="button" onClick={() => openPopout('console')} className="h-9 rounded-lg border border-nv-line bg-nv-well px-3 text-[12px] font-bold text-nv-ink">Afficher la fenêtre</button>
      <button type="button" onClick={() => closePopout('console')} data-testid="console-elsewhere-return" className="h-9 rounded-lg bg-cyan-500 px-3 text-[12px] font-black text-black">Ramener la console ici</button>
    </div>
  </div>
);

export default PopoutHost;
