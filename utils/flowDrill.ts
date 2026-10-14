/**
 * Exercices de flow et de diction (lot 11a) : logique pure, sans DOM
 * (tests/flowDrill.test.ts).
 *
 * Le rappeur pose une syllabe sur chaque point de la grille (croches,
 * triolets ou doubles croches) sur un clic à 80, 90 ou 140 BPM. On mesure
 * l'écart, en millisecondes, entre chaque attaque (détection d'attaques
 * existante : utils/transients.ts) et le point de grille le plus proche.
 *
 * Grille à 16 positions par mesure (doubles croches) : c'est le cadre que
 * les analystes du flow utilisent (M. Ohriner, « Flow: The Rhythmic Voice in
 * Rap Music », Oxford, 2019 ; K. Adams, « On the Metrical Techniques of Flow
 * in Rap Music », Music Theory Online 15.5, 2009). Sources : RECETTES.md.
 */
import { detectTransients } from './transients';

export type Subdivision = 'croches' | 'triolets' | 'doubles';
export const SUBDIV_PER_BEAT: Record<Subdivision, number> = { croches: 2, triolets: 3, doubles: 4 };
export const SUBDIV_LABEL: Record<Subdivision, string> = { croches: 'Croches (2 par temps)', triolets: 'Triolets (3 par temps)', doubles: 'Doubles croches (4 par temps)' };
/** Syllabes conseillées : on articule mieux un motif qu'une même syllabe répétée. */
export const SUBDIV_SYLLABLES: Record<Subdivision, string[]> = { croches: ['ta', 'ka'], triolets: ['ta', 'ki', 'ta'], doubles: ['ta', 'ka', 'ti', 'ki'] };

export interface FlowClick { t: number; accent: boolean; countIn: boolean; beat: number }
export interface FlowPlan {
  bpm: number;
  subdivision: Subdivision;
  beatsPerBar: number;
  /** Clics (s) : décompte puis exercice. */
  clicks: FlowClick[];
  /** Instants (s) attendus de chaque syllabe. */
  grid: number[];
  /** Index du temps de chaque point de grille, et rang dans le temps (0 = sur le temps). */
  gridBeat: number[];
  gridSub: number[];
  /** Début du décompte, début de l'exercice, fin. */
  start: number;
  rapStart: number;
  end: number;
}

/** Plan d'un passage : `countInBars` mesures de décompte, puis `bars` mesures à rapper. */
export function planFlow(bpm: number, subdivision: Subdivision, start = 0, bars = 2, countInBars = 1, beatsPerBar = 4): FlowPlan {
  const beat = 60 / Math.max(30, Math.min(300, bpm));
  const per = SUBDIV_PER_BEAT[subdivision];
  const clicks: FlowClick[] = [];
  const grid: number[] = [], gridBeat: number[] = [], gridSub: number[] = [];
  const ci = countInBars * beatsPerBar;
  const total = ci + bars * beatsPerBar;
  for (let b = 0; b < total; b++) {
    const t = start + b * beat;
    clicks.push({ t, accent: b % beatsPerBar === 0, countIn: b < ci, beat: b });
    if (b >= ci) for (let k = 0; k < per; k++) { grid.push(t + (k * beat) / per); gridBeat.push(b - ci); gridSub.push(k); }
  }
  return { bpm, subdivision, beatsPerBar, clicks, grid, gridBeat, gridSub, start, rapStart: start + ci * beat, end: start + total * beat };
}

export interface FlowHit { grid: number; onset: number | null; offsetMs: number | null }
export interface FlowScore {
  /** 0-100. */
  score: number;
  /** Syllabes attendues, posées (appariées à un point de grille), en trop. */
  expected: number;
  hits: number;
  extras: number;
  /** Écart moyen signé (ms) : + = en retard, − = en avance. */
  meanOffsetMs: number;
  /** Écart absolu moyen et médian (ms). */
  meanAbsMs: number;
  medianAbsMs: number;
  /** Régularité : écart-type des écarts (ms). Faible + écart moyen fort = posé volontairement derrière (laid-back) ou devant. */
  spreadMs: number;
  /** Part des syllabes à ±30 ms (0-1). */
  tight: number;
  detail: FlowHit[];
  /** Tendance lisible. */
  tendency: 'calé' | 'en retard' | 'en avance' | 'irrégulier';
}

const median = (v: number[]) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Points par syllabe : 1 jusqu'à 15 ms d'écart, 0 à 75 ms (au-delà, la syllabe est « à côté »). */
export const hitPoints = (absMs: number) => Math.max(0, Math.min(1, 1 - (absMs - 15) / 60));

/**
 * Appariement attaques ↔ grille (un pour un, plus proches d'abord, dans une
 * fenêtre de la moitié de l'espacement), puis note.
 */
export function scoreFlow(onsets: number[], grid: number[]): FlowScore {
  const spacing = grid.length > 1 ? Math.min(...grid.slice(1).map((g, i) => g - grid[i])) : 0.25;
  const win = spacing / 2;
  const pairs: { g: number; o: number; d: number }[] = [];
  grid.forEach((g, gi) => onsets.forEach((o, oi) => { const d = Math.abs(o - g); if (d < win) pairs.push({ g: gi, o: oi, d }); }));
  pairs.sort((a, b) => a.d - b.d);
  const gUsed = new Map<number, number>(), oUsed = new Set<number>();
  for (const p of pairs) {
    if (gUsed.has(p.g) || oUsed.has(p.o)) continue;
    gUsed.set(p.g, p.o); oUsed.add(p.o);
  }
  const detail: FlowHit[] = grid.map((g, gi) => {
    const oi = gUsed.get(gi);
    return oi === undefined ? { grid: g, onset: null, offsetMs: null } : { grid: g, onset: onsets[oi], offsetMs: (onsets[oi] - g) * 1000 };
  });
  const offs = detail.filter(d => d.offsetMs !== null).map(d => d.offsetMs as number);
  const lo = grid.length ? grid[0] - win : 0, hi = grid.length ? grid[grid.length - 1] + win : 0;
  const extras = onsets.filter((o, oi) => !oUsed.has(oi) && o >= lo && o <= hi).length;
  const hits = offs.length;
  const mean = hits ? offs.reduce((a, b) => a + b, 0) / hits : 0;
  const abs = offs.map(Math.abs);
  const meanAbs = hits ? abs.reduce((a, b) => a + b, 0) / hits : 0;
  const spread = hits ? Math.sqrt(offs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / hits) : 0;
  const coverage = grid.length ? hits / grid.length : 0;
  const precision = hits ? abs.reduce((a, b) => a + hitPoints(b), 0) / hits : 0;
  // Syllabes en trop (bégaiement, souffle bruyant) : légère pénalité.
  const extraPenalty = grid.length ? Math.min(0.2, (extras / grid.length) * 0.5) : 0;
  const score = Math.round(Math.max(0, Math.min(100, 100 * (0.35 * coverage + 0.65 * precision * coverage ** 0.5 - extraPenalty))));
  const tendency: FlowScore['tendency'] = !hits ? 'irrégulier' : spread > 35 ? 'irrégulier' : mean > 15 ? 'en retard' : mean < -15 ? 'en avance' : 'calé';
  return {
    score, expected: grid.length, hits, extras,
    meanOffsetMs: Math.round(mean * 10) / 10, meanAbsMs: Math.round(meanAbs * 10) / 10, medianAbsMs: Math.round(median(abs) * 10) / 10,
    spreadMs: Math.round(spread * 10) / 10, tight: hits ? Math.round((abs.filter(a => a <= 30).length / grid.length) * 1000) / 1000 : 0,
    detail, tendency,
  };
}

/**
 * Attaques d'une prise captée au micro, ramenées sur l'horloge des clics.
 * `firstTime` : instant (horloge du contexte audio) du 1er échantillon capté ;
 * `latencySec` : retard total (sortie entendue + entrée du micro + réglage
 * « décalage de prise » de NOVA) à retirer.
 */
export function takeOnsets(samples: Float32Array, sr: number, firstTime: number, latencySec: number, spacingSec = 0.2): number[] {
  // Syllabes rapprochées (doubles croches à 140 BPM = 107 ms) : écart minimal sous la moitié de l'espacement.
  const minGap = Math.max(0.045, Math.min(0.09, spacingSec * 0.55));
  return detectTransients(samples, sr, { jumpDb: 7, floorDb: -48, minGapSec: minGap }).map(t => firstTime + t - latencySec);
}

/** Note complète d'une prise de flow. */
export function analyzeFlowTake(samples: Float32Array, sr: number, firstTime: number, latencySec: number, plan: FlowPlan): FlowScore {
  const spacing = 60 / plan.bpm / SUBDIV_PER_BEAT[plan.subdivision];
  const on = takeOnsets(samples, sr, firstTime, latencySec, spacing).filter(t => t >= plan.rapStart - spacing / 2 && t <= plan.end);
  return scoreFlow(on, plan.grid);
}

/**
 * Le clic s'entend-il dans le micro (haut-parleurs) ? Attaques trouvées
 * pendant le décompte (l'artiste se tait), calées sur les clics à ±25 ms.
 */
export function clickLeak(samples: Float32Array, sr: number, firstTime: number, latencySec: number, plan: FlowPlan): boolean {
  const ci = plan.clicks.filter(c => c.countIn);
  if (ci.length < 2) return false;
  const on = takeOnsets(samples, sr, firstTime, latencySec).filter(t => t < plan.rapStart - 0.03);
  const near = ci.filter(c => on.some(o => Math.abs(o - c.t) < 0.025)).length;
  return near >= Math.ceil(ci.length / 2);
}

/** Message lisible pour l'artiste. */
export function flowAdvice(s: FlowScore): string {
  if (!s.hits) return 'Aucune syllabe entendue : vérifie le micro et rappe un peu plus fort.';
  if (s.hits < s.expected * 0.6) return `${s.hits} syllabes posées sur ${s.expected} : pose une syllabe sur chaque point lumineux, même doucement.`;
  const ms = Math.round(Math.abs(s.meanOffsetMs));
  if (s.tendency === 'irrégulier') return `Placement irrégulier (± ${Math.round(s.spreadMs)} ms) : ralentis d'abord, garde le même motif de syllabes.`;
  if (s.tendency === 'en retard') return s.spreadMs < 18 ? `Régulier, mais ${ms} ms derrière le temps : c'est un style (laid-back) si c'est voulu, sinon anticipe un peu.` : `Tu traînes de ${ms} ms en moyenne : attaque la consonne un peu plus tôt.`;
  if (s.tendency === 'en avance') return s.spreadMs < 18 ? `Régulier, mais ${ms} ms devant le temps : tu pousses le flow. Détends-toi sur le clic.` : `Tu te précipites (${ms} ms d'avance en moyenne) : écoute le clic, laisse-le arriver.`;
  return `Calé : ${Math.round(s.meanAbsMs)} ms d'écart moyen. ${s.meanAbsMs <= 15 ? 'Niveau pro, passe au tempo suivant.' : 'Encore un passage pour descendre sous 15 ms.'}`;
}

// ---------------------------------------------------------------------------
// Diction : virelangues français, une syllabe par croche.
// ---------------------------------------------------------------------------

export interface Virelangue { id: string; text: string; syllables: string[]; travail: string }

/** Syllabes écrites comme on les dit (e muets tombés quand le français parlé les fait tomber). */
export const VIRELANGUES: Virelangue[] = [
  { id: 'chasseur', text: 'Un chasseur sachant chasser sait chasser sans son chien.', travail: '« ch » contre « s »',
    syllables: ['Un', 'chas', 'seur', 'sa', 'chant', 'chas', 'ser', 'sait', 'chas', 'ser', 'sans', 'son', 'chien', '·', '·', '·'] },
  { id: 'chaussettes', text: 'Les chaussettes de l’archiduchesse sont-elles sèches, archi-sèches ?', travail: '« ch » / « s », débit',
    syllables: ['Les', 'chaus', 'settes', 'de', 'l’ar', 'chi', 'du', 'chesse', 'sont', 'elles', 'sè', 'ches', 'ar', 'chi', 'sè', 'ches'] },
  { id: 'didon', text: 'Didon dîna, dit-on, du dos d’un dodu dindon.', travail: '« d » : la pointe de la langue',
    syllables: ['Di', 'don', 'dî', 'na', 'dit', 'on', 'du', 'dos', 'd’un', 'do', 'du', 'din', 'don', '·', '·', '·'] },
  { id: 'scies', text: 'Si six scies scient six cyprès, six cent six scies scient six cent six cyprès.', travail: '« s » et « si », sifflantes nettes',
    syllables: ['Si', 'six', 'scies', 'scient', 'six', 'cy', 'près', '·', 'six', 'cent', 'six', 'scies', 'scient', 'six', 'cent', 'six', 'cy', 'près', '·', '·', '·', '·', '·', '·'] },
  { id: 'chats', text: 'Cinq chiens chassent six chats.', travail: 'nasales et « ch »',
    syllables: ['Cinq', 'chiens', 'chass', 'six', 'chats', '·', '·', '·'] },
  { id: 'tortues', text: 'Trois tortues trottaient sur un trottoir très étroit.', travail: '« tr » : attaques sèches',
    syllables: ['Trois', 'tor', 'tues', 'trot', 'taient', 'sur', 'un', 'trot', 'toir', 'très', 'é', 'troit', '·', '·', '·', '·'] },
];

/** Paliers de vitesse de la diction (BPM, une syllabe par croche). */
export const DICTION_TEMPOS = [70, 85, 100];

/** Plan d'un virelangue : une syllabe par croche ; « · » = silence (respiration), pas de syllabe attendue. */
export function planDiction(v: Virelangue, bpm: number, start = 0): FlowPlan & { syllableAt: (string | null)[] } {
  const bars = Math.ceil(v.syllables.length / 8);
  const p = planFlow(bpm, 'croches', start, bars, 1);
  const keep: number[] = [];
  const syllableAt: (string | null)[] = [];
  p.grid.forEach((_, i) => { const s = v.syllables[i]; syllableAt.push(s && s !== '·' ? s : null); if (s && s !== '·') keep.push(i); });
  return { ...p, grid: keep.map(i => p.grid[i]), gridBeat: keep.map(i => p.gridBeat[i]), gridSub: keep.map(i => p.gridSub[i]), syllableAt };
}

// ---------------------------------------------------------------------------
// Souffle : tenue d'un « sss » (souffle soutenu, sans voix).
// ---------------------------------------------------------------------------

export interface HissScore { seconds: number; steadiness: number; score: number }

/**
 * Durée du plus long souffle continu (trous < 250 ms tolérés) et régularité
 * du niveau (écart-type en dB). 25 s de « sss » régulier = 100.
 */
export function analyzeHiss(samples: Float32Array, sr: number): HissScore {
  const hop = Math.max(64, Math.round(sr * 0.02));
  const db: number[] = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let s = 0;
    for (let k = i; k < i + hop; k++) s += samples[k] * samples[k];
    const r = Math.sqrt(s / hop);
    db.push(r > 1e-9 ? 20 * Math.log10(r) : -120);
  }
  if (!db.length) return { seconds: 0, steadiness: 0, score: 0 };
  const sorted = [...db].sort((a, b) => a - b);
  // Plancher = le plus calme (le souffle peut occuper presque toute la capture).
  const floor = sorted[Math.floor(sorted.length * 0.02)];
  const loud = sorted[Math.floor(sorted.length * 0.9)];
  if (loud < -50) return { seconds: 0, steadiness: 0, score: 0 };
  const thr = loud - floor >= 8 ? Math.max(floor + 6, loud - 18, -60) : loud - 18;
  const maxGap = Math.round(0.25 / (hop / sr));
  let best = { a: 0, b: 0 }, a = -1, gap = 0;
  for (let i = 0; i <= db.length; i++) {
    const on = i < db.length && db[i] >= thr;
    if (on) { if (a < 0) a = i; gap = 0; }
    else if (a >= 0) {
      gap++;
      if (gap > maxGap || i === db.length) { const b = i - gap + 1; if (b - a > best.b - best.a) best = { a, b }; a = -1; gap = 0; }
    }
  }
  const seg = db.slice(best.a, best.b);
  const seconds = Math.round(((best.b - best.a) * hop / sr) * 10) / 10;
  if (seg.length < 5) return { seconds, steadiness: 0, score: 0 };
  const m = seg.reduce((x, y) => x + y, 0) / seg.length;
  const sd = Math.sqrt(seg.reduce((x, y) => x + (y - m) * (y - m), 0) / seg.length);
  const steadiness = Math.round(Math.max(0, Math.min(100, 100 - (sd - 2) * 10)));
  const score = Math.round(Math.max(0, Math.min(100, (seconds / 25) * 85 + steadiness * 0.15)));
  return { seconds, steadiness, score };
}
