import { Track, TrackType } from '../types';
import { isVoiceTrack } from './vocalRoles';

/**
 * « + Piste voix » (audit B2) : la nouvelle piste arrive SOUS la piste
 * sélectionnée (comme Logic), porte un nom unique (VOIX, VOIX 2…), part dans le
 * bus des voix et reprend le traitement de la voix modèle quand un style de mix
 * est posé. Le reste (sélection, armement, défilement) est fait par l'appelant.
 */
export interface VoiceTrackPlan {
  /** Index d'insertion dans state.tracks. */
  index: number;
  name: string;
  outputTrackId: string;
  /** Piste voix dont on copie effets et envois (style de mix déjà posé). */
  templateId: string | null;
}

const isSendLike = (t: Track) => t.type === TrackType.SEND || t.type === TrackType.BUS || t.id === 'master';

export function nextVoiceName(tracks: Track[], base = 'VOIX'): string {
  const used = new Set(tracks.map(t => (t.name || '').trim().toUpperCase()));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** « Bus 1 », « Bus 2 »… : premier numéro libre (audit G20, avant « Group Bus »). */
export function nextNumberedName(tracks: Track[], base: string): string {
  const used = new Set(tracks.map(t => (t.name || '').trim().toUpperCase()));
  let n = 1;
  while (used.has(`${base} ${n}`.toUpperCase())) n++;
  return `${base} ${n}`;
}

export function planVoiceTrack(tracks: Track[], selectedTrackId: string | null | undefined): VoiceTrackPlan {
  const selIdx = tracks.findIndex(t => t.id === selectedTrackId);
  const sel = selIdx >= 0 ? tracks[selIdx] : undefined;
  let index: number;
  if (sel && !isSendLike(sel)) {
    // Sous la sélectionnée (le beat compris : la voix arrive juste dessous).
    index = selIdx + 1;
  } else {
    // Rien de sélectionné (ou un bus) : après la dernière piste « jouable ».
    let last = -1;
    tracks.forEach((t, i) => { if (!isSendLike(t)) last = i; });
    index = last + 1;
  }
  const template = (isVoiceTrack(sel) ? sel : undefined)
    ?? tracks.find(t => t.id === 'track-rec-main')
    ?? tracks.find(t => isVoiceTrack(t));
  return {
    index,
    name: nextVoiceName(tracks),
    outputTrackId: tracks.some(t => t.id === 'bus-vox') ? 'bus-vox' : 'master',
    templateId: template ? template.id : null,
  };
}

/**
 * Fait défiler l'écran jusqu'à la piste (arrangement PC ou liste mobile), dès
 * que React l'a dessinée : l'artiste voit la piste qu'il vient de créer.
 */
export function revealTrack(trackId: string, tries = 20) {
  if (typeof document === 'undefined') return;
  const el = document.querySelector<HTMLElement>(`[data-track-header="${CSS.escape(trackId)}"]`);
  if (el && el.getClientRects().length) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    return;
  }
  if (tries > 0) requestAnimationFrame(() => revealTrack(trackId, tries - 1));
}
