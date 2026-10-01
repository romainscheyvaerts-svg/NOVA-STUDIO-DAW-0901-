import type { Track } from '../types';

/**
 * Passerelles vers le site du studio : acheter l'instru, faire mixer par un pro.
 *
 * Dans le site (DAW en iframe sur /daw), on demande à la page parente de
 * naviguer : l'artiste reste dans le site. Hors iframe, ou si la page parente
 * ne répond pas (ancienne version, autre hôte), on ouvre un nouvel onglet.
 */

export const STUDIO_SITE = 'https://www.studiomakemusic.com';

export function openStudioPage(path: string) {
  const inFrame = window.parent && window.parent !== window;
  const fallback = () => { window.open(STUDIO_SITE + path, '_blank', 'noopener'); };
  if (!inFrame) { fallback(); return; }
  let acked = false;
  const onAck = (e: MessageEvent) => {
    if (e.data && e.data.type === 'NOVA_NAVIGATE_ACK') acked = true;
  };
  window.addEventListener('message', onAck);
  // Aucune donnée sensible : un simple chemin, la page parente le filtre.
  window.parent.postMessage({ type: 'NOVA_NAVIGATE', path }, '*');
  setTimeout(() => {
    window.removeEventListener('message', onAck);
    if (!acked) fallback();
  }, 600);
}

/** Beat du catalogue présent dans le projet (id + titre affiché). */
export function getCatalogBeat(tracks: Track[]): { id: string; title: string } | null {
  const t = tracks.find(x => x.instrumentId !== undefined && x.instrumentId !== null);
  if (!t) return null;
  const title = t.clips[0]?.name || t.name;
  return { id: String(t.instrumentId), title };
}

/** Fiche d'achat du beat sur le site (licences et prix). */
export function openBuyBeat(tracks: Track[]) {
  const beat = getCatalogBeat(tracks);
  const qs = beat ? `?beat=${encodeURIComponent(beat.id)}&q=${encodeURIComponent(beat.title)}` : '';
  openStudioPage(`/instrumentals${qs}`);
}

/** Réservation d'un mixage par un ingé son du studio. */
export function openProMix() {
  openStudioPage('/reservation?service=mixing');
}
