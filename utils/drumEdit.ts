/**
 * Séquenceur pro (22/10/2026) : gestes d'édition de la boîte à rythmes, purs (testés dans
 * tests/drumEdit.test.ts). Ils agissent sur le motif AFFICHÉ (`rows`) : pas, rolls et tous les
 * couloirs par pas (pan, hauteur, probabilité, décalage, longueur, glisse) bougent ensemble.
 *
 *  - décaler (rotation ← / →), inverser, effacer : une rangée ou tout le motif ;
 *  - doubler la longueur (1 → 2 → 4 → 8 mesures, le contenu est recopié) ;
 *  - remplir tous les N pas (outil mécanique, comme « Fill each N steps ») ;
 *  - copier / coller un motif ou une rangée ;
 *  - rythmes publiés : les motifs des recettes sourcées (utils/beatRecipes.ts,
 *    CONTENU/nova-151/sons-beat/RECETTES_BEAT.md) posés dans le motif — jamais inventés ;
 *  - enregistrement en direct : un coup frappé pendant la lecture devient un pas (quantifié ou non) ;
 *  - nouveau tirage des probabilités.
 */
import type { DrumMachine, DrumRow } from './drumKits';
import { setBars } from './drumKits';
import { addPattern, barsOf, rowLength, rowStepsPerBar, setRowRate, STEP_LANES, STEPS_PER_BAR, type LaneKey, type StepRate } from './drumPatterns';
import { BEAT_GENRES, genreRecipe, type BeatGenreId } from './beatRecipes';
import { padFor, parseHits } from './beatStarter';

type RowArrays = { steps: number[]; ratchet: number[] } & Partial<Record<LaneKey, number[]>>;

const editRows = (dm: DrumMachine, which: (ri: number) => boolean, fn: (a: number[], dflt: number, lane: LaneKey | 'steps' | 'ratchet') => number[]): DrumMachine => ({
  ...dm,
  rows: dm.rows.map((r, ri) => {
    if (!which(ri)) return r;
    const out: DrumRow = { ...r, steps: fn([...r.steps], 0, 'steps'), ratchet: fn([...r.ratchet], 1, 'ratchet') };
    for (const l of STEP_LANES) { const a = r[l.row]; if (a) out[l.row] = fn([...a], l.dflt, l.key); }
    return out;
  }),
});

const rot = (a: number[], dir: number) => {
  const n = a.length;
  if (!n) return a;
  const k = ((dir % n) + n) % n;
  return a.map((_, i) => a[(i - k + n) % n]);
};

/** Décale une rangée d'un pas (dir 1 = vers la droite, -1 = vers la gauche), en boucle. */
export const rotateRow = (dm: DrumMachine, ri: number, dir: 1 | -1) => editRows(dm, i => i === ri, a => rot(a, dir));
/** Décale tout le motif d'un pas de chaque rangée. */
export const rotatePattern = (dm: DrumMachine, dir: 1 | -1) => editRows(dm, () => true, a => rot(a, dir));

/** Inverse une rangée (lue à l'envers ; le décalage fin change de sens). */
export const reverseRow = (dm: DrumMachine, ri: number) => editRows(dm, i => i === ri, (a, _d, lane) => { const r = a.reverse(); return lane === 'nudge' ? r.map(v => -v || 0) : r; });
export const reversePattern = (dm: DrumMachine) => editRows(dm, () => true, (a, _d, lane) => { const r = a.reverse(); return lane === 'nudge' ? r.map(v => -v || 0) : r; });

const clearRowOf = (r: DrumRow): DrumRow => {
  const out: DrumRow = { ...r, steps: r.steps.map(() => 0), ratchet: r.ratchet.map(() => 1) };
  for (const l of STEP_LANES) delete out[l.row];
  return out;
};
/** Efface une rangée (pas et réglages par pas). */
export const clearRow = (dm: DrumMachine, ri: number): DrumMachine => ({ ...dm, rows: dm.rows.map((r, i) => (i === ri ? clearRowOf(r) : r)) });
/** Efface tout le motif affiché. */
export const clearPattern = (dm: DrumMachine): DrumMachine => ({ ...dm, rows: dm.rows.map(clearRowOf) });

/** Double la longueur du motif (le contenu est recopié à la suite), jusqu'à 8 mesures. */
export function doublePattern(dm: DrumMachine): DrumMachine {
  const b = barsOf(dm.bars);
  if (b >= 8) return dm;
  return setBars(dm, (b * 2) as 2 | 4 | 8);
}

/** Remplit une rangée : un coup tous les `every` pas (à partir de `offset`), les autres pas éteints. */
export function fillEvery(dm: DrumMachine, ri: number, every: number, offset = 0, vel = 110): DrumMachine {
  const n = Math.max(1, Math.round(every));
  return { ...dm, rows: dm.rows.map((r, i) => (i !== ri ? r : { ...clearRowOf(r), steps: r.steps.map((_, k) => (k % n === offset % n ? vel : 0)) })) };
}

// ── Presse-papiers (motif ou rangée) ──────────────────────────────────────────────────

export interface PatternClip { kind: 'pattern'; bars: number; rows: Record<string, RowArrays> }
export interface RowClip { kind: 'row'; row: RowArrays }
let clip: PatternClip | RowClip | null = null;
const CLIP_KEY = 'nova_drum_clipboard';

const arraysOf = (r: DrumRow): RowArrays => {
  const o: RowArrays = { steps: [...r.steps], ratchet: [...r.ratchet] };
  for (const l of STEP_LANES) { const a = r[l.row]; if (a) o[l.key] = [...a]; }
  return o;
};
const fitTo = (a: number[] | undefined, len: number, dflt: number) => Array.from({ length: len }, (_, i) => (a && a.length ? a[i] ?? a[i % a.length] ?? dflt : dflt));
const writeRow = (r: DrumRow, src: RowArrays): DrumRow => {
  const len = r.steps.length;
  const out: DrumRow = { ...r, steps: fitTo(src.steps, len, 0), ratchet: fitTo(src.ratchet, len, 1) };
  for (const l of STEP_LANES) { delete out[l.row]; const a = src[l.key]; if (a) out[l.row] = fitTo(a, len, l.dflt); }
  return out;
};

function remember(c: PatternClip | RowClip) {
  clip = c;
  try { sessionStorage.setItem(CLIP_KEY, JSON.stringify(c)); } catch { /* stockage bloqué */ }
}
export function clipboard(): PatternClip | RowClip | null {
  if (clip) return clip;
  try { const s = sessionStorage.getItem(CLIP_KEY); if (s) clip = JSON.parse(s); } catch { /* */ }
  return clip;
}
export const copyPattern = (dm: DrumMachine) => remember({ kind: 'pattern', bars: dm.bars, rows: Object.fromEntries(dm.rows.map(r => [r.id, arraysOf(r)])) });
export const copyRow = (dm: DrumMachine, ri: number) => { const r = dm.rows[ri]; if (r) remember({ kind: 'row', row: arraysOf(r) }); };

/** Colle le motif copié (pads de même id) ; une rangée copiée se colle sur la rangée `ri`. */
export function paste(dm: DrumMachine, ri: number): DrumMachine | null {
  const c = clipboard();
  if (!c) return null;
  if (c.kind === 'row') return { ...dm, rows: dm.rows.map((r, i) => (i === ri ? writeRow(r, c.row) : r)) };
  let d = c.bars !== dm.bars && [1, 2, 4, 8].includes(c.bars) ? setBars(dm, c.bars as 1 | 2 | 4 | 8) : dm;
  d = { ...d, rows: d.rows.map(r => (c.rows[r.id] ? writeRow(r, c.rows[r.id]) : clearRowOf(r))) };
  return d;
}

// ── Rythmes publiés (recettes sourcées) ───────────────────────────────────────────────

export interface RecipeChoice { genre: BeatGenreId; genreName: string; emoji: string; index: number; name: string; bars: number; src: number[] }
/** Tous les motifs publiés : genre, variante, sources (numéros de RECETTES_BEAT.md). */
export const recipeChoices = (): RecipeChoice[] => BEAT_GENRES.flatMap(g => g.drums.map((v, i) => ({
  genre: g.id, genreName: g.name, emoji: g.emoji, index: i, name: v.name, bars: v.bars, src: v.src,
})));

/**
 * Pose un motif publié dans la boîte à rythmes : dans le motif affiché (`replace`) ou dans un nouveau
 * motif (`new`). Swing de la recette. Rôles sans pad (ex. pas de tom) : listés dans `missing`.
 */
export function applyRecipe(dm: DrumMachine, genre: BeatGenreId, index: number, mode: 'replace' | 'new'): { dm: DrumMachine; missing: string[] } {
  const g = genreRecipe(genre);
  const v = g.drums[index] || g.drums[0];
  let d = mode === 'new' ? addPattern(dm) : dm;
  d = setBars(d, v.bars);
  const missing: string[] = [];
  const lines = new Map<string, (typeof v.lines)[number]>();
  for (const l of v.lines) { const id = padFor(l.role); if (d.rows.some(r => r.id === id)) lines.set(id, l); else missing.push(l.role); }
  // Résolution des rangées des triolets (la recette le dit) ; les autres rangées de la recette en 1/16.
  d.rows.forEach((r, ri) => {
    const l = lines.get(r.id);
    if (!l) return;
    const want: StepRate = (l.rate as StepRate) || '16';
    if ((r.rate || '16') !== want || r.len) d = setRowRate({ ...d, rows: d.rows.map((x, i) => (i === ri ? { ...x, len: undefined } : x)) }, ri, want);
  });
  d = {
    ...d, swing: typeof v.swing === 'number' ? v.swing : g.swing,
    rows: d.rows.map(r => {
      const l = lines.get(r.id);
      const base = clearRowOf(r);
      if (!l) return base;
      const len = rowLength(r, d.bars);
      const { vel, ratchet } = parseHits(l.hits);
      return { ...base, steps: Array.from({ length: len }, (_, i) => vel[i % vel.length] || 0), ratchet: Array.from({ length: len }, (_, i) => ratchet[i % ratchet.length] || 1) };
    }),
  };
  return { dm: d, missing };
}

// ── Enregistrement en direct ──────────────────────────────────────────────────────────

/**
 * Coup frappé pendant la lecture → pas de la rangée `ri` dans le motif affiché. `abs16` : position en
 * doubles-croches depuis le début du morceau. Quantifié : au pas le plus proche ; sinon le décalage fin
 * garde l'écart (±50 % d'un pas). Un pas déjà allumé garde la plus forte vélocité.
 */
export function recordHit(dm: DrumMachine, ri: number, abs16: number, quantize: boolean, vel = 110): DrumMachine {
  const r = dm.rows[ri];
  if (!r || !Number.isFinite(abs16)) return dm;
  const spb = rowStepsPerBar(r);
  const len = r.steps.length || rowLength(r, dm.bars);
  const pos = (Math.max(0, abs16) * spb) / STEPS_PER_BAR;
  const near = Math.round(pos);
  const i = ((near % len) + len) % len;
  const nudge = quantize ? 0 : Math.max(-50, Math.min(50, Math.round((pos - near) * 100)));
  const steps = [...r.steps]; steps[i] = Math.max(steps[i] || 0, Math.max(1, Math.min(127, Math.round(vel))));
  const out: DrumRow = { ...r, steps };
  if (nudge || r.stepNudge) {
    const a = r.stepNudge ? [...r.stepNudge] : new Array(len).fill(0);
    a[i] = nudge;
    out.stepNudge = a.some(x => x) ? a : undefined;
  }
  return { ...dm, rows: dm.rows.map((x, k) => (k === ri ? out : x)) };
}

/** Nouveau tirage des probabilités (même tirage en lecture et à l'export). */
export const reroll = (dm: DrumMachine): DrumMachine => ({ ...dm, seed: ((dm.seed || 0) + 1) % 100000 });

/** Le motif utilise-t-il des probabilités ? */
export const usesProbability = (dm: DrumMachine) => dm.rows.some(r => r.stepProb?.some(v => v < 100)) || !!dm.patterns?.some(p => p.prob && Object.values(p.prob).some(a => a.some(v => v < 100)));
