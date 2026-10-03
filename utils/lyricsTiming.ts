import type { Marker } from '../types';

/**
 * Prompteur calé sur des régions : chaque bloc de paroles (lignes séparées par
 * une ligne vide : Couplet 1, Refrain…) défile exactement pendant la durée de
 * sa région. La vitesse se règle donc en tirant les bords des régions, plus
 * avec 🐢 / 🐇. Sans région associée, défilement à vitesse fixe (lignes / min).
 */

export interface LyricBlock {
  /** Index de la première ligne du bloc. */
  start: number;
  /** Index après la dernière ligne du bloc. */
  end: number;
  /** Première ligne (titre ou début du bloc), pour l'afficher. */
  title: string;
}

/** Blocs de paroles séparés par au moins une ligne vide. */
export function lyricBlocks(lines: string[]): LyricBlock[] {
  const blocks: LyricBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) break;
    const start = i;
    while (i < lines.length && lines[i].trim()) i++;
    blocks.push({ start, end: i, title: lines[start].trim().slice(0, 40) });
  }
  return blocks;
}

interface Anchor { t: number; line: number }

/** Points de calage (temps → ligne) des blocs associés à une région. */
export function regionAnchors(blocks: LyricBlock[], regionMap: Record<string, string>, regions: Marker[]): Anchor[] {
  const byId = new Map(regions.filter(r => r.endTime !== undefined && r.endTime > r.time).map(r => [r.id, r]));
  const anchors: Anchor[] = [];
  blocks.forEach((b, i) => {
    const r = byId.get(regionMap[String(i)]);
    if (!r) return;
    anchors.push({ t: r.time, line: b.start }, { t: r.endTime as number, line: b.end });
  });
  anchors.sort((a, b) => a.t - b.t || a.line - b.line);
  return anchors;
}

/**
 * Position du prompteur (en lignes, fractionnaire) au temps t.
 * Avec régions : interpolation entre les points de calage ; avant la première
 * région le texte attend sur son premier bloc, après la dernière il continue
 * à la vitesse fixe. Sans région : (t - start) × vitesse.
 */
export function prompterLine(t: number, opts: { anchors: Anchor[]; start: number; speed: number }): number {
  const { anchors, start, speed } = opts;
  const perSec = Math.max(0, speed) / 60;
  if (!anchors.length) return Math.max(0, (t - start) * perSec);
  const first = anchors[0];
  if (t <= first.t) return first.line;
  for (let k = 1; k < anchors.length; k++) {
    const a = anchors[k - 1], b = anchors[k];
    if (t <= b.t) {
      if (b.t <= a.t) return b.line;
      return a.line + (b.line - a.line) * ((t - a.t) / (b.t - a.t));
    }
  }
  const last = anchors[anchors.length - 1];
  return last.line + (t - last.t) * perSec;
}

/** Association automatique : 1er bloc → 1re région, etc. (dans l'ordre du temps). */
export function autoRegionMap(blocks: LyricBlock[], regions: Marker[]): Record<string, string> {
  const sorted = regions.filter(r => r.endTime !== undefined && r.endTime > r.time).sort((a, b) => a.time - b.time);
  const map: Record<string, string> = {};
  blocks.forEach((_, i) => { if (sorted[i]) map[String(i)] = sorted[i].id; });
  return map;
}
