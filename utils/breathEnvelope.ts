import type { BreathEdit } from '../types';

/**
 * Enveloppe de gain des respirations traitées (Clip.breaths) : logique pure,
 * utilisée par le plan de gain des clips (utils/fades), donc à la fois par la
 * lecture et par l'export. Les zones sont en secondes de l'audio SOURCE ; le
 * gain vaut 1 aux bords de chaque zone, descend en `fade` secondes jusqu'au
 * creux, y reste, puis remonte : le début et la fin des mots voisins ne sont
 * jamais touchés, et la forme en cosinus évite tout clic.
 */

/** En dessous de ce gain (dB), la respiration est supprimée (gain 0). */
export const BREATH_REMOVE_DB = -100;
export const DEFAULT_BREATH_FADE = 0.01;

export const breathDepth = (gainDb: number): number =>
  !Number.isFinite(gainDb) || gainDb <= BREATH_REMOVE_DB ? 0 : Math.min(1, Math.pow(10, gainDb / 20));

/** Fondu effectif d'une zone (jamais plus du tiers de la zone, ni moins de 1 ms). */
export const breathFade = (e: BreathEdit): number =>
  Math.max(0.001, Math.min(e.fade ?? DEFAULT_BREATH_FADE, (e.end - e.start) / 3));

const cosRamp = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : (1 - Math.cos(Math.PI * x)) / 2);

/** Gain d'une seule zone à l'instant source `t`. */
function editGainAt(e: BreathEdit, t: number): number {
  if (t <= e.start || t >= e.end) return 1;
  const depth = breathDepth(e.gainDb);
  const f = breathFade(e);
  let k = 1; // 1 = creux complet
  if (t < e.start + f) k = cosRamp((t - e.start) / f);
  else if (t > e.end - f) k = cosRamp((e.end - t) / f);
  return 1 - (1 - depth) * k;
}

/** Gain des respirations à l'instant source `t` (produit des zones, normalement disjointes). */
export function breathGainAt(edits: BreathEdit[] | undefined, t: number): number {
  if (!edits || !edits.length) return 1;
  let g = 1;
  for (const e of edits) if (t > e.start && t < e.end) g *= editGainAt(e, t);
  return g;
}

/** Zones (s, depuis le début du clip) où le gain des respirations VARIE : les fondus. */
export function breathRampsInClip(edits: BreathEdit[] | undefined, offset: number, duration: number): [number, number][] {
  const out: [number, number][] = [];
  if (!edits) return out;
  for (const e of edits) {
    if (!(e.end > e.start) || breathDepth(e.gainDb) >= 1) continue;
    const a = e.start - offset, b = e.end - offset;
    if (b <= 0 || a >= duration) continue;
    const f = breathFade(e);
    for (const [x, y] of [[a, a + f], [b - f, b]] as [number, number][]) {
      const s = Math.max(0, x), t = Math.min(duration, y);
      if (t > s + 1e-7) out.push([s, t]);
    }
  }
  return out.sort((p, q) => p[0] - q[0]);
}

/** Un clip a-t-il au moins une respiration traitée dans sa fenêtre ? */
export function clipHasBreaths(clip: { breaths?: BreathEdit[]; offset?: number; duration: number; isReversed?: boolean }): boolean {
  if (!clip.breaths?.length || clip.isReversed) return false;
  const off = clip.offset || 0;
  return clip.breaths.some(e => e.end > off && e.start < off + clip.duration && breathDepth(e.gainDb) < 1);
}

/** Empreinte courte des respirations (signature des clips de la lecture). */
export const breathSig = (edits: BreathEdit[] | undefined): string =>
  edits && edits.length ? edits.map(e => `${e.start.toFixed(4)}:${e.end.toFixed(4)}:${e.gainDb}:${e.fade ?? ''}`).join(',') : '';
