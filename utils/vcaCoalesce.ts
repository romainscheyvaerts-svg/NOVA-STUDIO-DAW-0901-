import { FADER_MAX_GAIN } from './faderLaw';
import type { Track } from '../types';
import { vcaMembers } from './trackStructure';

/**
 * Fusionner un VCA dans ses pistes (Pro Tools : « Coalesce VCA Automation »).
 *
 * Le VCA de NOVA est un fader maître qui multiplie le volume de ses membres
 * (utils/trackStructure, engineView). Le fusionner = reporter ce gain DANS
 * chaque membre (fader et courbe de volume, ou fader du VCA imbriqué), puis
 * remettre le VCA à 0 dB : le son ne change pas, et on peut retirer le VCA ou
 * exporter les pistes sans lui. Une étape d'annulation côté appelant.
 *
 * Module pur : tests/vcaCoalesce.test.ts.
 */

export interface CoalesceResult {
  tracks: Track[];
  /** Pistes modifiées. */
  members: string[];
  /** Gain reporté (1 : rien à faire). */
  gain: number;
}

const VOLUME_MAX = FADER_MAX_GAIN;

export function coalesceVca(tracks: Track[], vcaId: string): CoalesceResult {
  const vca = tracks.find(t => t.id === vcaId && t.isVca);
  if (!vca) return { tracks, members: [], gain: 1 };
  const g = Math.max(0, vca.volume);
  const members = vcaMembers(vca, tracks);
  if (Math.abs(g - 1) < 1e-6 || !members.length) return { tracks, members: [], gain: g };
  const ids = new Set(members.map(m => m.id));
  const out = tracks.map(t => {
    if (t.id === vcaId) return { ...t, volume: 1 };
    if (!ids.has(t.id)) return t;
    const volume = Math.round(t.volume * g * 1e6) / 1e6;
    const lanes = (t.automationLanes || []).map(l => {
      if (l.parameterName !== 'volume' || !l.points.length) return l;
      const points = l.points.map(p => ({ ...p, value: Math.round(p.value * g * 1e6) / 1e6 }));
      const top = Math.max(l.max, ...points.map(p => p.value));
      return { ...l, points, max: top > VOLUME_MAX ? top : l.max };
    });
    return { ...t, volume, automationLanes: lanes };
  });
  return { tracks: out, members: members.map(m => m.id), gain: g };
}

/** Un réglage au-dessus de la course du fader (+12 dB) après fusion : à signaler. */
export const coalesceOverflow = (r: CoalesceResult): string[] =>
  r.tracks.filter(t => r.members.includes(t.id) && (t.volume > VOLUME_MAX + 1e-9 || (t.automationLanes || []).some(l => l.parameterName === 'volume' && l.points.some(p => p.value > VOLUME_MAX + 1e-9)))).map(t => t.name);
