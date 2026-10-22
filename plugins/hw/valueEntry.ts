/**
 * Saisie d'une valeur au clavier (audit mix 22/10/2026) : on tape « -3,5 », « 2.5k », « 800 Hz »,
 * « 30 ms », « G 20 », « -inf »… et le réglage prend la valeur affichée correspondante, comme dans
 * les DAW. Module pur (tests/valueEntry.test.ts).
 *
 * Principe : on ne connaît pas la loi qui relie le réglage à son affichage (gain linéaire affiché en dB,
 * fréquence logarithmique en Hz / kHz, temps en s affiché en ms…), mais on a la fonction d'affichage.
 * On lit donc le nombre affiché (ramené à une unité de base : Hz, s, dB…) et on cherche par dichotomie,
 * sur la course du bouton, la position dont l'affichage vaut ce qui a été tapé. L'affichage doit être
 * monotone sur la course (c'est le cas de tous les réglages continus).
 */
import { fromNorm, quantize, type KnobRange } from './knobMath';

const UNIT_MUL: Record<string, number> = { hz: 1, khz: 1000, k: 1000, ms: 0.001, s: 1, sec: 1, db: 1, '%': 1, x: 1 };
const FAMILY: Record<string, string> = { hz: 'f', khz: 'f', k: 'f', ms: 't', s: 't', sec: 't' };

export interface ParsedValue { num: number; unit: string | null }

/** Lit un nombre affiché ou tapé : virgule décimale, signe, côté du pan (G / L = gauche, D / R = droite, C = centre), −∞. */
export function parseShown(text: string): ParsedValue | null {
  const t = String(text ?? '').trim().replace(/−/g, '-').replace(/\s+/g, ' ');
  if (!t) return null;
  if (/^[-]?\s*(∞|inf(ini)?)/i.test(t)) return { num: -Infinity, unit: 'db' };
  if (/^c(entre|enter)?$/i.test(t)) return { num: 0, unit: null };
  let side = 1;
  let rest = t;
  const lr = /^([GLDR])\s*(?=[\d.,])/i.exec(t);
  if (lr) { side = /[GL]/i.test(lr[1]) ? -1 : 1; rest = t.slice(lr[0].length); }
  const m = /^([-+]?\d*(?:[.,]\d+)?|[-+]?\d+[.,]?)\s*([a-zA-Z%µ]*)/.exec(rest);
  if (!m || !m[1] || !/\d/.test(m[1])) return null;
  const num = parseFloat(m[1].replace(',', '.')) * side;
  if (!Number.isFinite(num)) return null;
  const u = (m[2] || '').toLowerCase();
  return { num, unit: u in UNIT_MUL ? u : null };
}

/** Valeur ramenée à l'unité de base de sa famille (Hz, s), ou telle quelle. */
const toBase = (p: ParsedValue): number => p.num * (p.unit ? UNIT_MUL[p.unit] : 1);

/**
 * Valeur du réglage qui affiche ce qui a été tapé, ou null si le texte n'est pas un nombre.
 * Sans unité tapée, on prend l'unité affichée ; « 800 » sur un affichage en kHz veut dire 800 Hz
 * (et « 300 » sur un affichage en s veut dire 300 ms), comme dans les DAW.
 */
export function solveTypedValue(range: KnobRange, format: (v: number) => string, typed: string, current?: number): number | null {
  const want = parseShown(typed);
  if (!want) return null;
  const ref = parseShown(format(current ?? (range.min + range.max) / 2));
  let unit = want.unit;
  if (!unit && ref?.unit) {
    unit = ref.unit;
    if (unit === 'khz' && Math.abs(want.num) >= 20) unit = 'hz';
    if (unit === 's' && Math.abs(want.num) > 10) unit = 'ms';
  }
  // Unité d'une autre famille que l'affichage (« ms » tapé sur un réglage en Hz) : on garde le nombre seul.
  if (unit && ref?.unit && FAMILY[unit] !== FAMILY[ref.unit]) unit = ref.unit;
  const target = toBase({ num: want.num, unit });
  const shownAt = (v: number): number => { const p = parseShown(format(v)); return p ? toBase(p) : NaN; };

  if (range.detents && range.detents.length) {
    let best: number | null = null, gap = Infinity;
    for (const d of range.detents) {
      const s = shownAt(d.v);
      const g = s === target ? 0 : Math.abs(s - target);
      if (g < gap) { gap = g; best = d.v; }
    }
    return best;
  }

  const lo = shownAt(fromNorm({ ...range, step: 0 }, 0));
  const hi = shownAt(fromNorm({ ...range, step: 0 }, 1));
  if (Number.isNaN(lo) || Number.isNaN(hi)) return null;
  const up = hi >= lo;
  if (up ? target <= lo : target >= lo) return quantize(range, range.min);
  if (up ? target >= hi : target <= hi) return quantize(range, range.max);
  // L'affichage est arrondi (« 4 kHz » de 3950 à 4050 Hz) : on cherche les deux bords du palier qui
  // affiche la valeur tapée et on prend son milieu (4000 Hz, pas 3950).
  const edge = (strict: boolean): number => {
    let a = 0, b = 1;
    for (let i = 0; i < 48; i++) {
      const mid = (a + b) / 2;
      const s = shownAt(fromNorm({ ...range, step: 0 }, mid));
      const before = Number.isNaN(s) || (up ? (strict ? s <= target : s < target) : (strict ? s >= target : s > target));
      if (before) a = mid; else b = mid;
    }
    return (a + b) / 2;
  };
  const n0 = edge(false), n1 = edge(true);
  const v0 = fromNorm({ ...range, step: 0 }, n0), v1 = fromNorm({ ...range, step: 0 }, n1);
  return quantize(range, (v0 + v1) / 2);
}

/** Gain linéaire (0…max) pour un texte en dB (« -3,5 », « +2 dB », « -inf ») ; null si illisible. */
export function dbTextToGain(typed: string, maxGain = 1.5): number | null {
  const p = parseShown(typed);
  if (!p || (p.unit && p.unit !== 'db')) return null;
  if (p.num === -Infinity || p.num <= -120) return 0;
  return Math.max(0, Math.min(maxGain, Math.pow(10, p.num / 20)));
}

/** Pan −1…1 pour « C », « G 30 », « L30 », « D 20 », « R20 », « -30 », « 25 » ; null si illisible. */
export function panTextToValue(typed: string): number | null {
  const p = parseShown(typed);
  if (!p || p.unit) return null;
  return Math.max(-1, Math.min(1, p.num / 100));
}

/** Touche qui ouvre la saisie quand un réglage a le focus : chiffre, signe, séparateur décimal. */
export const startsValueEntry = (key: string): boolean => /^[0-9.,+-]$/.test(key);
