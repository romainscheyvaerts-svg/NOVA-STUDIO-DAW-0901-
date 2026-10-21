/**
 * Écart 7 · « Réparer la voix » : la chaîne de calcul seule (sans clip ni DOM),
 * pour le Worker (services/VoiceRepairWorker) et les tests.
 *
 * Ordre de passage : écrêtage, clics, bourdonnement, plosives (on reconstruit
 * d'abord les crêtes, sinon le reste travaille sur un son faux ; c'est l'ordre
 * habituel des chaînes de restauration).
 *
 * Réglages neutres : une seule « Sensibilité » (Léger / Moyen / Fort) qui règle
 * les seuils de détection ; aucun préréglage inventé.
 */
import { declipChannels, type DeclipStats } from './declip';
import { removeHum, type HumMode, type HumStats } from './hum';
import { removeClicks, type ClickStats } from './mouthClicks';
import { reducePlosives, type PlosiveStats } from './plosives';

export type RepairStrength = 'light' | 'medium' | 'strong';
export type { HumMode } from './hum';

export interface RepairOptions {
  plosives: boolean;
  clicks: boolean;
  hum: HumMode;
  declip: boolean;
  /** Après le déclippeur : baisser le clip juste assez pour ne pas réécrêter (−1 dBFS). */
  declipLowerGain: boolean;
  strength: RepairStrength;
}

export const DEFAULT_REPAIR_OPTIONS: RepairOptions = { plosives: true, clicks: true, hum: 'auto', declip: true, declipLowerGain: true, strength: 'medium' };

export interface RepairStats {
  declip?: DeclipStats;
  clicks?: ClickStats;
  hum?: HumStats;
  plosives?: PlosiveStats;
}

export type RepairProgress = (pct: number, message: string) => void;

/** Répare les canaux (copies ; un canal sans défaut revient tel quel). */
export function repairChannels(chs: Float32Array[], sampleRate: number, o: RepairOptions, onProgress?: RepairProgress): { channels: Float32Array[]; stats: RepairStats } {
  let cur = chs;
  const stats: RepairStats = {};
  const steps = [o.declip, o.clicks, o.hum !== 'off', o.plosives].filter(Boolean).length || 1;
  let done = 0;
  const tick = (m: string) => onProgress?.(Math.round((done++ / steps) * 100), m);
  if (o.declip) {
    tick('Écrêtage : reconstruction des crêtes…');
    const r = declipChannels(cur, sampleRate, { lowerGain: o.declipLowerGain });
    cur = r.channels; stats.declip = r.stats;
  }
  if (o.clicks) {
    tick('Clics de bouche…');
    let count = 0, samples = 0;
    cur = cur.map(c => { const r = removeClicks(c, sampleRate, o.strength); count += r.stats.count; samples += r.stats.samples; return r.channel; });
    stats.clicks = { count, samples };
  }
  if (o.hum !== 'off') {
    tick('Bourdonnement secteur…');
    const r = removeHum(cur, sampleRate, o.hum);
    cur = r.channels; stats.hum = r.stats;
  }
  if (o.plosives) {
    tick('Plosives…');
    const r = reducePlosives(cur, sampleRate, o.strength);
    cur = r.channels; stats.plosives = r.stats;
  }
  onProgress?.(100, 'Terminé');
  return { channels: cur, stats };
}

/** Un défaut a-t-il été trouvé et réparé ? */
export const repairedSomething = (s: RepairStats) => !!((s.declip?.runs || 0) + (s.clicks?.count || 0) + (s.hum?.f0 ? 1 : 0) + (s.plosives?.count || 0));
