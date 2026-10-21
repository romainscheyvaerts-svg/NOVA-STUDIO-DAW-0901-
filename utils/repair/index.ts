/**
 * Écart 7 · « Réparer la voix » : plosives, clics de bouche, bourdonnement
 * secteur et écrêtage, en traitement de clip (utils/clipProcess) : le son
 * réparé est un nouveau son, la prise d'origine est gardée (« Revenir à
 * l'original », Ctrl+Z). Tout est calculé sur l'appareil (Worker), sans service
 * en ligne. Le calcul lui-même : utils/repair/pipeline.
 */
import type { Clip } from '../../types';
import { audioSuiteBlock, audioSuitePatch, audioSuiteRegion, DEFAULT_HANDLE } from '../clipProcess';
import { shiftTranscript, transcriptValid } from '../voiceLyrics';
import type { RepairOptions, RepairStats, RepairStrength } from './pipeline';

export * from './pipeline';

export const STRENGTH_LABELS: Record<RepairStrength, { label: string; hint: string }> = {
  light: { label: 'Léger', hint: 'Ne prend que les défauts francs : rien d’autre ne bouge.' },
  medium: { label: 'Moyen', hint: 'Conseillé pour une prise voix.' },
  strong: { label: 'Fort', hint: 'Prend aussi les petits défauts ; à écouter (consonnes très sèches).' },
};

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Bilan lisible : « 12 clics de bouche retirés · bourdonnement 50 Hz (6 harmoniques) retiré ». */
export function repairSummary(s: RepairStats): string {
  const parts: string[] = [];
  if (s.declip?.runs) parts.push(`${plural(s.declip.runs, 'crête écrêtée reconstruite', 'crêtes écrêtées reconstruites')}${s.declip.gainDb < -0.05 ? ` (clip baissé de ${Math.abs(s.declip.gainDb).toFixed(1).replace('.', ',')} dB pour ne pas réécrêter)` : ''}`);
  if (s.clicks?.count) parts.push(plural(s.clicks.count, 'clic de bouche retiré', 'clics de bouche retirés'));
  if (s.hum?.f0) parts.push(`bourdonnement ${String(Math.round(s.hum.f0 * 10) / 10).replace('.', ',')} Hz (${plural(s.hum.harmonics, 'fréquence', 'fréquences')}) retiré`);
  if (s.plosives?.count) parts.push(`${plural(s.plosives.count, 'plosive adoucie', 'plosives adoucies')} (jusqu’à −${Math.round(s.plosives.maxReductionDb)} dB de grave)`);
  return parts.join(' · ');
}

/** Ce qui a été cherché sans rien trouver (pour dire « rien à réparer » clairement). */
export function repairNothingFound(o: RepairOptions): string {
  const what = [o.declip && 'écrêtage', o.clicks && 'clic de bouche', o.hum !== 'off' && 'bourdonnement', o.plosives && 'plosive'].filter(Boolean) as string[];
  return what.length ? `Rien à réparer : aucun ${what.join(', aucun ').replace('aucun plosive', 'aucune plosive')} trouvé${what.length > 1 ? 's' : ''} avec la sensibilité choisie. Le clip n’a pas été modifié.` : 'Coche au moins une réparation.';
}

/** Ce clip peut-il être réparé ? (sinon : la raison, qui dit quoi faire) */
export function repairBlock(c: Clip | null | undefined): string | null {
  if (!c) return 'Clip introuvable : il a peut-être été supprimé.';
  const b = audioSuiteBlock(c);
  if (b) return b.replace('Ce traitement', 'La réparation');
  if (c.duration < 0.05) return 'Clip trop court pour être réparé.';
  return null;
}

/** Partie du son réparée (le clip et ses poignées, comme le traitement de clip). */
export const repairRegion = (c: Pick<Clip, 'offset' | 'duration'>, bufferDuration: number, handle = DEFAULT_HANDLE) => audioSuiteRegion(c, bufferDuration, handle);

/** Nom de l'étape (liste des traitements, nom du clip) : « Voix réparée (clics, plosives) ». */
export function repairStepName(o: RepairOptions): string {
  const what = [o.declip && 'écrêtage', o.clicks && 'clics', o.hum !== 'off' && 'bourdonnement', o.plosives && 'plosives'].filter(Boolean);
  return `Voix réparée (${what.length === 4 ? 'tout' : what.join(', ') || 'rien'})`.slice(0, 40);
}

/**
 * Changements du clip une fois le son réparé enregistré sous `newBufferId` (il
 * commence à `from` dans le son actuel). Les temps ne bougent pas : les paroles
 * transcrites suivent le nouveau son.
 */
export function repairPatch(c: Clip, o: { newBufferId: string; from: number; name: string; type?: 'VOICE_REPAIR' | 'SPECTRAL_EDIT'; now?: number }): Partial<Clip> {
  const patch = audioSuitePatch(c, { newBufferId: o.newBufferId, from: o.from, step: { type: o.type || 'VOICE_REPAIR', name: o.name, at: o.now ?? Date.now() } });
  if (c.transcript && transcriptValid(c)) patch.transcript = shiftTranscript(c.transcript, o.from, o.newBufferId);
  return patch;
}
