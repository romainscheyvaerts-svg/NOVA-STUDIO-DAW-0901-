import { Track, TrackType } from '../types';

/**
 * Rôle d'une piste dans une session voix, comme le pense un ingé son :
 * le lead porte le morceau, les backs doublent les fins de phrase et les
 * punchlines, les harmonies chantent une autre note au refrain, les ad-libs
 * ponctuent (« yeah », « skrr »…).
 */
export type VocalRole = 'beat' | 'lead' | 'back' | 'harmony' | 'adlib' | 'other';

export const ROLE_LABELS: Record<VocalRole, string> = {
  beat: 'Beat',
  lead: 'Voix principale (lead)',
  back: 'Backs',
  harmony: 'Harmonies',
  adlib: 'Ad-libs',
  other: 'Autre',
};

export const isVoiceTrack = (t?: Track | null): t is Track =>
  !!t && t.type === TrackType.AUDIO && t.id !== 'instrumental' && !t.instrumentId;

export function getVocalRole(t: Track): VocalRole {
  if (t.id === 'instrumental') return 'beat';
  if (!isVoiceTrack(t)) return 'other';
  const n = (t.name || '').toUpperCase();
  if (/HARMO/.test(n)) return 'harmony';
  if (/AD.?LIB|ADLIB|\bADD\b|\bAD\b/.test(n)) return 'adlib';
  if (/BACK|CHOEUR|CHŒUR|DOUBLE|DBL/.test(n)) return 'back';
  return 'lead';
}

/**
 * Réglages relatifs au lead, appliqués par-dessus un style de mix : les voix
 * secondaires plus basses, ouvertes sur les côtés et plus « loin » (plus de
 * réverb), pour que le lead reste devant.
 */
export const ROLE_MIX: Record<'lead' | 'back' | 'harmony' | 'adlib', { volume: number; pan: number; verbAdd: number; delayAdd: number; highpass: number }> = {
  lead:    { volume: 1.0,  pan: 0,    verbAdd: 0,    delayAdd: 0,    highpass: 0 },
  back:    { volume: 0.55, pan: 0.35, verbAdd: 0.08, delayAdd: 0,    highpass: 150 },
  harmony: { volume: 0.5,  pan: 0.5,  verbAdd: 0.12, delayAdd: 0,    highpass: 180 },
  adlib:   { volume: 0.5,  pan: 0.6,  verbAdd: 0.06, delayAdd: 0.12, highpass: 200 },
};

/** Piste à utiliser pour un rôle (la première qui correspond), sinon undefined. */
export const findTrackForRole = (tracks: Track[], role: VocalRole): Track | undefined => {
  const voices = tracks.filter(isVoiceTrack);
  if (role === 'lead') return voices.find(t => t.id === 'track-rec-main') || voices.find(t => getVocalRole(t) === 'lead');
  // Pour une voix secondaire : de préférence une piste vide du bon rôle.
  const ofRole = voices.filter(t => getVocalRole(t) === role);
  return ofRole.find(t => t.clips.length === 0) || ofRole[0];
};
