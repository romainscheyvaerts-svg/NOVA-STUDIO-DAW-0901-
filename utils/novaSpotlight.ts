/**
 * Nova « montre du doigt » un élément de l'interface : halo pulsé autour de
 * l'élément et bulle avec la consigne (« baisse ce fader vers 60 % »).
 *
 * Les éléments ciblables portent `data-nova-target` :
 *   vol-<trackId>, track-<trackId>, rec, mix-auto, beat-catalog
 */

let cleanup: (() => void) | null = null;

const isVisible = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && (el as HTMLElement).offsetParent !== null;
};

export function novaSpotlight(target: string, message?: string, durationMs = 6000): boolean {
  cleanup?.();
  const candidates = [target];
  // Fader introuvable (piste repliée, autre onglet) : on montre au moins la piste.
  if (target.startsWith('vol-')) candidates.push(`track-${target.slice(4)}`);
  // Sur téléphone l'en-tête de piste n'existe pas : on montre son fader.
  if (target.startsWith('track-')) candidates.push(`vol-${target.slice(6)}`);
  let el: HTMLElement | null = null;
  for (const t of candidates) {
    const found = Array.from(document.querySelectorAll<HTMLElement>(`[data-nova-target="${CSS.escape(t)}"]`)).find(isVisible);
    if (found) { el = found; break; }
  }
  if (!el) return false;

  el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  el.classList.add('nova-spotlight');

  let bubble: HTMLDivElement | null = null;
  let raf = 0;
  if (message) {
    bubble = document.createElement('div');
    bubble.className = 'nova-spot-bubble';
    bubble.setAttribute('role', 'status');
    bubble.textContent = message;
    document.body.appendChild(bubble);
    // Suit l'élément pendant le défilement.
    const place = () => {
      if (!el || !bubble) return;
      const r = el.getBoundingClientRect();
      const bw = bubble.offsetWidth;
      const bh = bubble.offsetHeight;
      let top = r.bottom + 10;
      if (top + bh > window.innerHeight - 8) top = Math.max(8, r.top - bh - 10);
      const left = Math.min(Math.max(8, r.left + r.width / 2 - bw / 2), window.innerWidth - bw - 8);
      bubble.style.top = `${top}px`;
      bubble.style.left = `${left}px`;
      raf = requestAnimationFrame(place);
    };
    place();
  }

  const timer = window.setTimeout(() => cleanup?.(), durationMs);
  cleanup = () => {
    window.clearTimeout(timer);
    cancelAnimationFrame(raf);
    el?.classList.remove('nova-spotlight');
    bubble?.remove();
    cleanup = null;
  };
  return true;
}
