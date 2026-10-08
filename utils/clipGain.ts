import type { AutomationPoint, Clip, ClipGainPoint } from '../types';

/**
 * Ligne de gain des clips (Pro Tools : Clip Gain Line) : logique pure.
 *
 * - Les points (Clip.gainPoints) sont en secondes de l'audio SOURCE (même
 *   repère que Clip.offset) : découper, rogner ou déplacer un clip ne les
 *   déplace pas par rapport au son.
 * - Le gain de la ligne s'ajoute (en dB) au gain global du clip (Clip.gain).
 * - Entre deux points, le gain varie en dB (droit, ou courbé par `curve`).
 *   Avant le premier point et après le dernier, il reste au niveau du point.
 * - La lecture et l'export lisent la ligne par le même plan de gain que les
 *   fondus et les respirations (utils/fades.clipGainEvents) : même son.
 *
 * Le crayon (formes libre, ligne, triangle, carré, aléatoire) sert aussi aux
 * lignes d'automation : `pencilShape` travaille dans un espace de valeurs
 * quelconque (dB pour un clip, valeur normalisée pour l'automation).
 */

// --------------------------------------------------------------- dB ↔ linéaire

/** Bornes d'un point (Pro Tools : −144 … +36 dB ; ici −60 dB ≈ silence). */
export const GAIN_POINT_MIN_DB = -60;
export const GAIN_POINT_MAX_DB = 24;
/** Pas du nudge de gain (Pro Tools : Ctrl+Maj+↑ / ↓) et pas fin. */
export const GAIN_NUDGE_DB = 0.5;
export const GAIN_NUDGE_FINE_DB = 0.1;
/** Rampe anti-clic posée aux bords d'une zone modifiée (s). */
export const GAIN_EDGE_RAMP = 0.005;

export const dbToLin = (db: number): number => (db <= GAIN_POINT_MIN_DB - 1e-9 ? 0 : Math.pow(10, db / 20));
export const linToDb = (g: number): number => (g > 0 ? 20 * Math.log10(g) : -Infinity);
export const clampDb = (db: number): number => Math.max(GAIN_POINT_MIN_DB, Math.min(GAIN_POINT_MAX_DB, Number.isFinite(db) ? db : 0));

/** « +2.5 dB », « −3.0 dB », « 0.0 dB ». */
export const dbText = (db: number): string => {
  if (!Number.isFinite(db) || db <= GAIN_POINT_MIN_DB) return '−∞ dB';
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)} dB`;
};

// ------------------------------------------------------------------- enveloppe

/** Forme d'un segment : x 0 → 1, courbure c (−1 … 1, 0 = droit). */
export function segmentShape(x: number, c = 0): number {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  if (!c || Math.abs(c) < 1e-6) return t;
  const k = Math.max(-1, Math.min(1, c)) * 5;
  return (Math.exp(k * t) - 1) / (Math.exp(k) - 1);
}

export const sortGainPoints = (pts: ClipGainPoint[] | undefined): ClipGainPoint[] =>
  [...(pts || [])].filter(p => p && Number.isFinite(p.t) && Number.isFinite(p.db)).sort((a, b) => a.t - b.t);

/** Gain de la ligne (dB) à l'instant source `t` ; 0 dB sans points. Points triés. */
export function envelopeDbAt(pts: ClipGainPoint[] | undefined, t: number): number {
  if (!pts || !pts.length) return 0;
  if (t <= pts[0].t) return pts[0].db;
  const last = pts[pts.length - 1];
  if (t >= last.t) return last.db;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const d = b.t - a.t;
  if (d <= 1e-12) return b.db;
  return a.db + (b.db - a.db) * segmentShape((t - a.t) / d, a.curve || 0);
}

/** Gain linéaire de la ligne à l'instant source `t`. */
export const envelopeGainAt = (pts: ClipGainPoint[] | undefined, t: number): number =>
  !pts || !pts.length ? 1 : dbToLin(envelopeDbAt(pts, t));

type EnvClip = { gainPoints?: ClipGainPoint[]; offset?: number; duration: number };

/** Le clip a-t-il une ligne de gain (au moins un point) ? */
export const hasGainPoints = (c: { gainPoints?: ClipGainPoint[] }): boolean => !!c.gainPoints && c.gainPoints.length > 0;

/** Gain de la ligne à la position `t` du clip (s depuis son début). */
export const clipEnvelopeGain = (c: EnvClip, t: number): number =>
  hasGainPoints(c) ? envelopeGainAt(c.gainPoints, (c.offset || 0) + t) : 1;

/** Zones (s depuis le début du clip) où la ligne VARIE : entre deux points de niveaux différents. */
export function envelopeRampsInClip(pts: ClipGainPoint[] | undefined, offset: number, duration: number): [number, number][] {
  const out: [number, number][] = [];
  if (!pts || pts.length < 2) return out;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (Math.abs(a.db - b.db) < 1e-9) continue;
    const s = Math.max(0, a.t - offset), e = Math.min(duration, b.t - offset);
    if (e > s + 1e-7) out.push([s, e]);
  }
  return out;
}

/** Empreinte courte de la ligne (signatures de lecture, de gel, de cache). */
export const gainPointsSig = (pts: ClipGainPoint[] | undefined): string =>
  pts && pts.length ? pts.map(p => `${p.t.toFixed(5)}:${p.db.toFixed(3)}${p.curve ? `~${p.curve.toFixed(2)}` : ''}`).join(',') : '';

/** Points visibles d'un clip, plus le voisin de chaque côté (pour tracer la ligne jusqu'aux bords). */
export function pointsInClip(c: EnvClip): { index: number; p: ClipGainPoint }[] {
  const pts = c.gainPoints || [];
  const a = c.offset || 0, b = a + c.duration;
  const out: { index: number; p: ClipGainPoint }[] = [];
  pts.forEach((p, index) => { if (p.t >= a - 1e-9 && p.t <= b + 1e-9) out.push({ index, p }); });
  return out;
}

// ------------------------------------------------------------- édition de points

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

/** Ajoute un point (instant source `t`) ; renvoie la ligne triée et le rang du point. */
export function addGainPoint(pts: ClipGainPoint[] | undefined, t: number, db: number): { points: ClipGainPoint[]; index: number } {
  const list = sortGainPoints(pts).filter(p => !near(p.t, t));
  const p: ClipGainPoint = { t, db: clampDb(db) };
  list.push(p);
  list.sort((a, b) => a.t - b.t);
  return { points: list, index: list.indexOf(p) };
}

/** Déplace le point n° i (sans dépasser ses voisins). */
export function moveGainPoint(pts: ClipGainPoint[], i: number, t: number, db: number, bounds?: { min?: number; max?: number }): ClipGainPoint[] {
  const list = pts.map(p => ({ ...p }));
  if (!list[i]) return list;
  const lo = Math.max(bounds?.min ?? -Infinity, i > 0 ? list[i - 1].t + 1e-4 : -Infinity);
  const hi = Math.min(bounds?.max ?? Infinity, i + 1 < list.length ? list[i + 1].t - 1e-4 : Infinity);
  list[i].t = lo <= hi ? Math.max(lo, Math.min(hi, t)) : list[i].t;
  list[i].db = clampDb(db);
  return list;
}

export const removeGainPoint = (pts: ClipGainPoint[], i: number): ClipGainPoint[] => pts.filter((_, k) => k !== i);

/** Courbure du segment qui part du point n° i (Ctrl+glisser sur le segment). */
export function setSegmentCurve(pts: ClipGainPoint[], i: number, curve: number): ClipGainPoint[] {
  return pts.map((p, k) => {
    if (k !== i) return p;
    const c = Math.max(-1, Math.min(1, curve));
    const { curve: _old, ...rest } = p;
    return Math.abs(c) < 0.02 ? rest : { ...rest, curve: Math.round(c * 100) / 100 };
  });
}

/**
 * Remplace la ligne entre `t0` et `t1` (instants source) par de nouveaux
 * points, en gardant la ligne d'avant de part et d'autre : une courte rampe
 * (5 ms) aux deux bords, jamais de saut (pas de clic).
 */
export function replaceGainRange(pts: ClipGainPoint[] | undefined, t0: number, t1: number, fresh: ClipGainPoint[], ramp = GAIN_EDGE_RAMP): ClipGainPoint[] {
  const old = sortGainPoints(pts);
  const a = Math.min(t0, t1), b = Math.max(t0, t1);
  const keepL = old.filter(p => p.t < a - ramp - 1e-9);
  const keepR = old.filter(p => p.t > b + ramp + 1e-9);
  const out: ClipGainPoint[] = [...keepL];
  const newPts = sortGainPoints(fresh).filter(p => p.t >= a - 1e-9 && p.t <= b + 1e-9).map(p => ({ ...p, db: clampDb(p.db) }));
  if (!newPts.length) return old;
  // Bords : la ligne d'avant jusqu'à la rampe (seulement si elle existait ou si le niveau change).
  const leftDb = envelopeDbAt(old, a - ramp);
  const rightDb = envelopeDbAt(old, b + ramp);
  if (old.length || Math.abs(newPts[0].db) > 1e-9) out.push({ t: a - ramp, db: leftDb });
  out.push(...newPts);
  if (old.length || Math.abs(newPts[newPts.length - 1].db) > 1e-9) out.push({ t: b + ramp, db: rightDb });
  out.push(...keepR);
  return dedupe(out);
}

/** Retire les points superposés (même instant : le dernier gagne) et les intermédiaires inutiles. */
function dedupe(pts: ClipGainPoint[]): ClipGainPoint[] {
  const s = [...pts].sort((a, b) => a.t - b.t);
  const out: ClipGainPoint[] = [];
  for (const p of s) {
    const last = out[out.length - 1];
    if (last && near(last.t, p.t, 1e-7)) out[out.length - 1] = p; else out.push(p);
  }
  // Trois points alignés au même niveau : celui du milieu ne sert à rien.
  return out.filter((p, i) => !(i > 0 && i + 1 < out.length && near(out[i - 1].db, p.db, 1e-6) && near(out[i + 1].db, p.db, 1e-6) && !out[i - 1].curve && !p.curve));
}

/**
 * Nudge du gain (Pro Tools : Ctrl+Maj+↑ / ↓) : sans plage, tout le clip (gain
 * global) ; avec une plage (instants source), seulement la plage, avec des
 * rampes de 5 ms aux bords (Pro Tools : Clip Gain sur la sélection).
 */
export function nudgeClipGain(clip: Pick<Clip, 'gain' | 'gainPoints' | 'offset' | 'duration'>, deltaDb: number, range?: [number, number] | null): Partial<Clip> {
  if (!range) {
    const db = clampDb(linToDb(clip.gain ?? 1) + deltaDb);
    return { gain: Math.abs(db) < 1e-6 ? 1 : dbToLin(db) };
  }
  const off = clip.offset || 0;
  const a = Math.max(off, Math.min(range[0], range[1])), b = Math.min(off + clip.duration, Math.max(range[0], range[1]));
  if (!(b > a + 1e-4)) return {};
  return { gainPoints: offsetGainRange(clip.gainPoints, a, b, deltaDb) };
}

/** Ajoute `deltaDb` à la ligne entre a et b (instants source), rampes de 5 ms à l'extérieur. */
export function offsetGainRange(pts: ClipGainPoint[] | undefined, a: number, b: number, deltaDb: number, ramp = GAIN_EDGE_RAMP): ClipGainPoint[] {
  const old = sortGainPoints(pts);
  const inner = old.filter(p => p.t > a + 1e-9 && p.t < b - 1e-9).map(p => ({ ...p, db: clampDb(p.db + deltaDb) }));
  const fresh: ClipGainPoint[] = [
    { t: a, db: clampDb(envelopeDbAt(old, a) + deltaDb) },
    ...inner,
    { t: b, db: clampDb(envelopeDbAt(old, b) + deltaDb) },
  ];
  // Rampe d'entrée / sortie : on garde la ligne d'avant à a − rampe et b + rampe.
  const out = [
    ...old.filter(p => p.t < a - ramp - 1e-9),
    { t: a - ramp, db: envelopeDbAt(old, a - ramp) },
    ...fresh,
    { t: b + ramp, db: envelopeDbAt(old, b + ramp) },
    ...old.filter(p => p.t > b + ramp + 1e-9),
  ];
  return dedupe(out);
}

/** Ligne remise à plat (0 dB) : plus de points. */
export const clearGainLine = (): Partial<Clip> => ({ gainPoints: undefined });

// ----------------------------------------------------------------------- crayon

/** Formes du crayon (Pro Tools : Pencil Tool, Free Hand / Line / Triangle / Square / Random). */
export type PencilShape = 'free' | 'line' | 'triangle' | 'square' | 'random';

export const PENCIL_SHAPES: { id: PencilShape; label: string; icon: string; hint: string }[] = [
  { id: 'free', label: 'Libre', icon: 'fa-signature', hint: 'Dessine la ligne à main levée (« Free Hand » du crayon de Pro Tools). Grille active : un point par pas de grille.' },
  { id: 'line', label: 'Ligne', icon: 'fa-slash', hint: 'Une droite du point de départ au point d’arrivée (« Line » de Pro Tools).' },
  { id: 'triangle', label: 'Triangle', icon: 'fa-wave-square', hint: 'Montées et descentes régulières, une période par pas de grille (« Triangle » de Pro Tools) : glisse vers le haut ou le bas pour l’amplitude.' },
  { id: 'square', label: 'Carré', icon: 'fa-chart-simple', hint: 'Créneaux haut / bas, un par pas de grille (« Square » de Pro Tools), avec des rampes de 5 ms contre les clics.' },
  { id: 'random', label: 'Aléatoire', icon: 'fa-shuffle', hint: 'Un niveau au hasard par pas de grille (« Random » de Pro Tools), entre le départ et la hauteur du pointeur.' },
];

/** Générateur pseudo-aléatoire stable (même tracé pendant tout le geste). */
export function seededRandom(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PencilStroke {
  shape: PencilShape;
  /** Début et fin du geste (temps de la timeline, s). */
  t0: number;
  t1: number;
  /** Valeur au départ du geste et valeur sous le pointeur. */
  v0: number;
  v1: number;
  /** Pas de grille (s) : période des formes, cadence du tracé libre. Absent : `period`. */
  step?: number;
  /** Période des formes sans grille (s). */
  period: number;
  /** Échantillons du tracé libre (temps croissants). */
  samples?: { t: number; v: number }[];
  seed?: number;
  /** Rampe des créneaux et des marches (s). */
  ramp?: number;
}

/** Points (temps, valeur) d'un geste de crayon, dans l'ordre des temps. */
export function pencilShape(s: PencilStroke): { t: number; v: number }[] {
  const a = Math.min(s.t0, s.t1), b = Math.max(s.t0, s.t1);
  const ramp = s.ramp ?? GAIN_EDGE_RAMP;
  const P = Math.max(0.002, s.step || s.period);
  switch (s.shape) {
    case 'line': {
      if (b - a < 1e-6) return [{ t: a, v: s.v1 }];
      const [va, vb] = s.t0 <= s.t1 ? [s.v0, s.v1] : [s.v1, s.v0];
      return [{ t: a, v: va }, { t: b, v: vb }];
    }
    case 'triangle': {
      const out: { t: number; v: number }[] = [];
      let k = 0;
      for (let t = a; t <= b + 1e-9; t += P / 2, k++) out.push({ t: Math.min(t, b), v: k % 2 ? s.v1 : s.v0 });
      const last = out[out.length - 1];
      if (last.t < b - 1e-6) {
        // Fin au milieu d'une pente : la valeur à cet instant (la pente garde sa raideur).
        const next = k % 2 ? s.v1 : s.v0;
        out.push({ t: b, v: last.v + (next - last.v) * ((b - last.t) / (P / 2)) });
      }
      return out;
    }
    case 'square':
    case 'random': {
      const rnd = seededRandom(s.seed ?? 1);
      const lo = Math.min(s.v0, s.v1), hi = Math.max(s.v0, s.v1);
      const half = s.shape === 'square' ? P / 2 : P;
      const out: { t: number; v: number }[] = [];
      let k = 0;
      for (let t = a; t < b - 1e-9; t += half, k++) {
        const v = s.shape === 'square' ? (k % 2 ? s.v1 : s.v0) : lo + (hi - lo) * rnd();
        const end = Math.min(b, t + half);
        const r = Math.min(ramp, (end - t) / 3);
        // Chaque marche commence après la rampe (depuis la fin de la précédente) et tient jusqu'au pas suivant.
        out.push({ t: k === 0 ? t : t + r, v });
        out.push({ t: end, v });
      }
      return out.filter((p, i) => !(i > 0 && Math.abs(p.t - out[i - 1].t) < 1e-9));
    }
    case 'free':
    default: {
      const sm = (s.samples || []).filter(p => p.t >= a - 1e-9 && p.t <= b + 1e-9);
      if (!sm.length) return [{ t: a, v: s.v0 }];
      if (s.step && s.step > 0) {
        // Grille : un point par pas de grille (valeur du tracé à cet instant).
        const out: { t: number; v: number }[] = [];
        const first = Math.ceil((a - 1e-9) / s.step) * s.step;
        const at = (t: number) => {
          if (t <= sm[0].t) return sm[0].v;
          for (let i = 1; i < sm.length; i++) if (sm[i].t >= t) {
            const p = sm[i - 1], q = sm[i];
            return q.t - p.t > 1e-9 ? p.v + (q.v - p.v) * (t - p.t) / (q.t - p.t) : q.v;
          }
          return sm[sm.length - 1].v;
        };
        out.push({ t: a, v: at(a) });
        for (let t = first; t <= b + 1e-9; t += s.step) if (t > a + 1e-6) out.push({ t, v: at(t) });
        if (out[out.length - 1].t < b - 1e-6) out.push({ t: b, v: at(b) });
        return out;
      }
      return simplifyPolyline(sm, 0.05);
    }
  }
}

/** Ajoute un échantillon au tracé libre : revenir en arrière efface ce qui suit. */
export function addFreehandSample(samples: { t: number; v: number }[], t: number, v: number): { t: number; v: number }[] {
  const out = samples.filter(p => p.t < t - 1e-6);
  out.push({ t, v });
  return out;
}

/** Douglas-Peucker : garde la forme à `tol` près (unités de la valeur), en gardant les extrémités. */
export function simplifyPolyline(pts: { t: number; v: number }[], tol: number): { t: number; v: number }[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = pts[i], b = pts[j];
    let best = -1, bestD = tol;
    for (let k = i + 1; k < j; k++) {
      const p = pts[k];
      const x = b.t - a.t > 1e-12 ? (p.t - a.t) / (b.t - a.t) : 0;
      const d = Math.abs(p.v - (a.v + (b.v - a.v) * x));
      if (d > bestD) { bestD = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

/**
 * Applique un geste de crayon à la ligne de gain d'un clip. Les valeurs du
 * geste sont des gains TOTAUX (dB, gain global compris, comme la hauteur à
 * l'écran) : on retire le gain global pour obtenir la ligne.
 */
export function applyPencilToClip(clip: Pick<Clip, 'start' | 'offset' | 'duration' | 'gain' | 'gainPoints'>, stroke: PencilStroke): ClipGainPoint[] | undefined {
  const toSrc = (t: number) => (clip.offset || 0) + (t - clip.start);
  const lo = clip.start, hi = clip.start + clip.duration;
  const s = { ...stroke, t0: Math.max(lo, Math.min(hi, stroke.t0)), t1: Math.max(lo, Math.min(hi, stroke.t1)) };
  if (Math.abs(s.t1 - s.t0) < 1e-4 && s.shape !== 'free') return clip.gainPoints;
  const base = linToDb(clip.gain ?? 1);
  const pts = pencilShape(s).map(p => ({ t: toSrc(Math.max(lo, Math.min(hi, p.t))), db: clampDb(p.v - (Number.isFinite(base) ? base : 0)) }));
  if (!pts.length) return clip.gainPoints;
  const a = Math.min(...pts.map(p => p.t)), b = Math.max(...pts.map(p => p.t));
  if (b - a < 1e-4) {
    // Simple clic au crayon : un point.
    return addGainPoint(clip.gainPoints, pts[0].t, pts[0].db).points;
  }
  return replaceGainRange(clip.gainPoints, a, b, pts);
}

/**
 * Même geste sur une ligne d'automation : valeurs déjà dans l'unité du
 * paramètre. Les points de la plage sont remplacés ; la courbe d'avant est
 * gardée de part et d'autre (point posé juste avant et juste après).
 */
export function applyPencilToAutomation(points: AutomationPoint[], stroke: PencilStroke, valueAt: (t: number) => number, newId: (i: number) => string, ramp = GAIN_EDGE_RAMP): AutomationPoint[] {
  const shape = pencilShape(stroke);
  if (!shape.length) return points;
  const a = Math.min(...shape.map(p => p.t)), b = Math.max(...shape.map(p => p.t));
  const old = [...points].sort((x, y) => x.time - y.time);
  const out: AutomationPoint[] = old.filter(p => p.time < a - ramp - 1e-9);
  let n = 0;
  if (old.length && a - ramp > 0) out.push({ id: newId(n++), time: a - ramp, value: valueAt(a - ramp) });
  for (const p of shape) out.push({ id: newId(n++), time: Math.max(0, p.t), value: p.v });
  if (old.length) out.push({ id: newId(n++), time: b + ramp, value: valueAt(b + ramp) });
  out.push(...old.filter(p => p.time > b + ramp + 1e-9));
  return out.sort((x, y) => x.time - y.time);
}

// ----------------------------------------------------------- rendre dans le fichier

/**
 * « Rendre le gain dans le fichier » (Pro Tools : Render Clip Gain) : applique
 * la ligne et le gain global à tout le son (les points sont en temps source).
 * Renvoie de nouveaux canaux ; le son d'origine n'est pas touché.
 */
export function renderGainToChannels(channels: Float32Array[], sampleRate: number, pts: ClipGainPoint[] | undefined, gain = 1): Float32Array[] {
  const sorted = sortGainPoints(pts);
  const n = channels[0]?.length || 0;
  const env = new Float32Array(n);
  if (!sorted.length) env.fill(gain);
  else for (let i = 0; i < n; i++) env[i] = gain * envelopeGainAt(sorted, i / sampleRate);
  return channels.map(ch => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i] * env[i];
    return out;
  });
}

/** Modification du clip après le rendu (le son rendu est `renderedBufferId`). */
export function renderedClipPatch(clip: Pick<Clip, 'bufferId' | 'gain' | 'gainPoints'>, renderedBufferId: string): Partial<Clip> {
  return {
    bufferId: renderedBufferId,
    gain: 1,
    gainPoints: undefined,
    gainRender: { sourceBufferId: clip.bufferId, gainPoints: sortGainPoints(clip.gainPoints), gain: clip.gain ?? 1 },
  };
}

/** « Revenir » : le son d'origine et la ligne de gain reviennent (null si l'origine manque). */
export function revertGainRenderPatch(clip: Pick<Clip, 'gainRender'>, has: (bufferId: string) => boolean): Partial<Clip> | null {
  const r = clip.gainRender;
  if (!r?.sourceBufferId || !has(r.sourceBufferId)) return null;
  return {
    bufferId: r.sourceBufferId,
    gain: r.gain,
    gainPoints: r.gainPoints.length ? r.gainPoints.map(p => ({ ...p })) : undefined,
    gainRender: undefined,
  };
}

// ---------------------------------------------------- réglages d'affichage (store)

export interface ClipGainView {
  /** Ligne de gain affichée et éditable sur les clips (Pro Tools : Ctrl+Maj+−). */
  line: boolean;
  /** Valeurs de gain écrites sur les clips (Pro Tools : Clip Gain Info). */
  info: boolean;
  /** Forme du crayon. */
  shape: PencilShape;
  /** Tirer le bord droit d'un clip le boucle (Pro Tools : Loop Trim). */
  loopTrim: boolean;
  /** Fondus aux jonctions des boucles (ms, 0 = aucun). */
  loopXfadeMs: number;
}

const VIEW_KEY = 'nova_clip_gain_view';
const DEFAULT_VIEW: ClipGainView = { line: false, info: true, shape: 'free', loopTrim: false, loopXfadeMs: 0 };

function loadView(): ClipGainView {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(VIEW_KEY) : null;
    if (raw) return { ...DEFAULT_VIEW, ...JSON.parse(raw) };
  } catch { /* stockage indisponible */ }
  return { ...DEFAULT_VIEW };
}

let view: ClipGainView = loadView();
const listeners = new Set<() => void>();

export const clipGainViewStore = {
  get: (): ClipGainView => view,
  set: (patch: Partial<ClipGainView>) => {
    view = { ...view, ...patch };
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* ignoré */ }
    listeners.forEach(l => l());
  },
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
};

// ------------------------------------------------------- hauteur à l'écran (dB ↔ y)

/**
 * Même échelle que la poignée de gain de l'arrangement : +12 dB en haut de la
 * forme d'onde, 0 dB à 20 % sous le haut, −40 dB en bas (zone y+18 … y+h−4).
 */
export const LINE_MAX_DB = 12;
export const LINE_MIN_DB = -40;
const ZERO_FRAC = 0.8;

export const dbToFrac = (db: number): number => {
  if (!Number.isFinite(db)) return 0;
  if (db >= 0) return ZERO_FRAC + (1 - ZERO_FRAC) * Math.min(1, db / LINE_MAX_DB);
  return ZERO_FRAC * (1 - Math.min(1, db / LINE_MIN_DB));
};

export const fracToDb = (f: number): number => {
  const c = Math.max(0, Math.min(1, f));
  if (c <= 0.002) return GAIN_POINT_MIN_DB;
  return c >= ZERO_FRAC ? ((c - ZERO_FRAC) / (1 - ZERO_FRAC)) * LINE_MAX_DB : (1 - c / ZERO_FRAC) * LINE_MIN_DB;
};

/** Ordonnée de la ligne (relative au haut du clip, hauteur h) pour un gain total en dB. */
export const lineY = (h: number, db: number): number => 18 + Math.max(4, h - 22) * (1 - dbToFrac(db));
/** Gain total (dB) sous une ordonnée relative au haut du clip. */
export const lineDb = (h: number, y: number): number => fracToDb(1 - (y - 18) / Math.max(4, h - 22));
