import { useEffect, useState } from 'react';
import { readLayoutPart } from '../utils/windowLayouts';

/**
 * Zoom (px/s), défilement horizontal et largeur des en-têtes de l'arrangement, lus de
 * l'extérieur (disposition « zoom » + conteneur [data-follow]) : les bandeaux montés
 * au-dessus de l'arrangement (pistes épinglées, couloir vidéo) restent calés dessus
 * sans toucher à ArrangementView.
 */
export interface ArrangementViewport { h: number; scroll: number; header: number }

export function useArrangementView(active: boolean): ArrangementViewport {
  const [v, setV] = useState<ArrangementViewport>({ h: 40, scroll: 0, header: 296 });
  useEffect(() => {
    if (!active) return;
    let el: HTMLElement | null = null;
    let raf = 0;
    const read = () => {
      raf = 0;
      if (!el || !el.isConnected) el = document.querySelector('main [data-follow]');
      const z = readLayoutPart('zoom');
      const side = el?.firstElementChild?.firstElementChild as HTMLElement | null | undefined;
      const next = { h: Number.isFinite(z?.h) ? z.h : 40, scroll: el ? el.scrollLeft : (Number.isFinite(z?.scroll) ? z.scroll : 0), header: side?.offsetWidth || 296 };
      setV(o => (o.h === next.h && o.scroll === next.scroll && o.header === next.header ? o : next));
    };
    const onScroll = (e: Event) => { if (e.target === el || (e.target as HTMLElement)?.matches?.('[data-follow]')) { if (!raf) raf = requestAnimationFrame(read); } };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    // Zoom (molette, curseur, disposition) : relu 4 fois par seconde, sans rendu si rien ne bouge.
    const iv = window.setInterval(read, 250);
    read();
    return () => { document.removeEventListener('scroll', onScroll, { capture: true } as any); window.clearInterval(iv); if (raf) cancelAnimationFrame(raf); };
  }, [active]);
  return v;
}
