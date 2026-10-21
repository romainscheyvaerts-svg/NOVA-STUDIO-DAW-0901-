import { Track, TrackType } from '../types';
import { isEffectivelyInactive, TrackListFilter } from './trackStructure';
import { structureBus } from './structureBus';

/**
 * Chercher et filtrer les pistes d'une grosse séance (écart 25) : par nom, par rôle
 * (voix, audio, instruments MIDI, bus, dossiers), par couleur et par état (actives,
 * masquées, inactives, coupées, en solo, armées, épinglées). Module pur, rapide :
 * une séance de 96 pistes se filtre en quelques dixièmes de milliseconde.
 */
export type TrackKind = 'voix' | 'audio' | 'midi' | 'bus' | 'dossier';
export type TrackStateFilter = TrackListFilter | 'muted' | 'solo' | 'armed' | 'pinned';

export const KIND_LABELS: Record<TrackKind, string> = { voix: 'Voix', audio: 'Audio', midi: 'MIDI', bus: 'Bus', dossier: 'Dossiers' };
export const STATE_LABELS: Record<TrackStateFilter, string> = {
  all: 'Toutes', active: 'Actives', hidden: 'Masquées', inactive: 'Inactives', muted: 'Coupées', solo: 'En solo', armed: 'Armées', pinned: 'Épinglées',
};

export interface TrackQuery {
  /** Mots du nom (ou du commentaire), sans accents ni majuscules ; plusieurs mots = tous présents. */
  text?: string;
  /** Rôles acceptés (vide : tous). */
  kinds?: TrackKind[];
  /** Couleurs acceptées (#rrggbb, vide : toutes). */
  colors?: string[];
  state?: TrackStateFilter;
}

const VOICE = /\b(voix|vox|voc|vocal|vocals|lead|back|backs|harmo|harmonie|ad.?lib|adlibs?|choeur|chœur|chant|rap|couplet|refrain|dbl|double|topline|prise)\b/i;
const NOT_VOICE = /\b(beat|instru|drum|drums|kick|snare|hat|hats|perc|808|bass|basse|piano|guitare?|gtr|synth|pad|keys|fx|reverb|reverbe|réverbe|delay|bus|master)\b/i;
const fold = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Rôle d'une piste pour le filtre. */
export function trackKind(t: Track): TrackKind {
  if (t.folder) return 'dossier';
  if (t.type === TrackType.BUS || t.type === TrackType.SEND || t.isVca) return 'bus';
  if (t.type !== TrackType.AUDIO) return 'midi';
  if (t.id === 'instrumental' || t.instrumentId || t.beatStem) return 'audio';
  const n = fold(t.name);
  if (t.voiceChain || t.isGuide || (t.breathKind && t.breathKind !== 'skip')) return 'voix';
  if (VOICE.test(n) && !NOT_VOICE.test(n)) return 'voix';
  if (t.id === 'track-rec-main') return 'voix';
  return 'audio';
}

const norm = (c: string) => (c || '').toLowerCase();

/** Pistes qui répondent à la recherche (ordre gardé ; le master n'est jamais listé). */
export function matchTracks(tracks: Track[], q: TrackQuery, pinned: ReadonlySet<string> = new Set()): Track[] {
  const words = fold(q.text || '').split(/\s+/).filter(Boolean);
  const kinds = q.kinds?.length ? new Set(q.kinds) : null;
  const colors = q.colors?.length ? new Set(q.colors.map(norm)) : null;
  const st = q.state || 'all';
  const byId = st === 'active' || st === 'inactive' ? new Map(tracks.map(t => [t.id, t])) : null;
  return tracks.filter(t => {
    if (t.id === 'master') return false;
    if (words.length) { const hay = `${fold(t.name)} ${fold(t.comment || '')}`; if (!words.every(w => hay.includes(w))) return false; }
    if (kinds && !kinds.has(trackKind(t))) return false;
    if (colors && !colors.has(norm(t.color))) return false;
    switch (st) {
      case 'active': return !isEffectivelyInactive(t, byId!);
      case 'inactive': return isEffectivelyInactive(t, byId!);
      case 'hidden': return !!t.isHidden;
      case 'muted': return !!t.isMuted;
      case 'solo': return !!t.isSolo;
      case 'armed': return !!t.isTrackArmed;
      case 'pinned': return pinned.has(t.id);
      default: return true;
    }
  });
}

/** Couleurs présentes dans la séance (pastilles du filtre), dans l'ordre d'apparition. */
export const trackColors = (tracks: Track[]): string[] => [...new Set(tracks.filter(t => t.id !== 'master' && t.color).map(t => norm(t.color)))].slice(0, 12);

/** Le filtre est-il actif (autre chose que « tout ») ? */
export const isFiltering = (q: TrackQuery) => !!(q.text?.trim() || q.kinds?.length || q.colors?.length || (q.state && q.state !== 'all'));

/**
 * « N'afficher que ces pistes » : masque les autres dans l'arrangement et la console
 * (les dossiers des pistes gardées restent affichés). Rien ne change dans le son :
 * une piste masquée joue toujours.
 */
export function showOnly(tracks: Track[], keepIds: Iterable<string>): Track[] {
  const keep = new Set(keepIds);
  const byId = new Map(tracks.map(t => [t.id, t]));
  for (const id of [...keep]) { let p = byId.get(id)?.parentFolderId; let g = 0; while (p && g++ < 16) { keep.add(p); p = byId.get(p)?.parentFolderId; } }
  return tracks.map(t => {
    if (t.id === 'master') return t;
    const hide = !keep.has(t.id);
    return !!t.isHidden === hide ? t : { ...t, isHidden: hide };
  });
}

/** Palette « Chercher une piste » : ouvre la liste des pistes, curseur dans la recherche. */
export function openTrackSearch() {
  structureBus.emit({ kind: 'panel', panel: 'tracks' });
  let n = 0;
  const focus = () => {
    const el = typeof document !== 'undefined' ? document.querySelector<HTMLInputElement>('[data-track-search]') : null;
    if (el) { el.focus(); el.select(); } else if (n++ < 20) setTimeout(focus, 50);
  };
  setTimeout(focus, 30);
}
