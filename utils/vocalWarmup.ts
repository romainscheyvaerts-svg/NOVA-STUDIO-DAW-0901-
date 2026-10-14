/**
 * Échauffement « Voix et flow » (lot 11a) : programme, notes des exercices de
 * voix et historique des progrès. Logique pure (tests/vocalWarmup.test.ts),
 * le stockage passe par `localStorage` seulement (sur l'appareil, aucun serveur).
 *
 * Les exercices et leur ordre suivent les sources notées dans
 * CONTENU/nova-bandlab/lot11_echauffement/RECETTES.md : souffle, puis
 * exercices à conduit vocal semi-fermé (trilles des lèvres, « ng »), sirènes,
 * gammes de 5 notes montées par demi-tons, tenue de note ; côté rap,
 * diction (virelangues) et placement sur le clic.
 */
import type { Subdivision } from './flowDrill';

export type ExerciseKind = 'souffle' | 'tessiture' | 'sirene' | 'trilles' | 'gamme5' | 'tenue' | 'diction' | 'flow';
export type ExerciseGroup = 'voix' | 'rap' | 'souffle';

export interface Exercise {
  id: string;
  kind: ExerciseKind;
  group: ExerciseGroup;
  title: string;
  /** Une ligne : ce que ça travaille. */
  goal: string;
  /** Consignes pas à pas (affichées avant le départ). */
  steps: string[];
  /** Durée approximative (s). */
  seconds: number;
  /** Unité du score affiché. */
  measure: 'cents' | 'ms' | 'demi-tons' | 's';
  /** Références (clés de SOURCES). */
  sources: string[];
  /** Flow : tempo et découpage. */
  bpm?: number;
  subdivision?: Subdivision;
}

/** Sources (détail et liens dans RECETTES.md). */
export const SOURCES: Record<string, { label: string; url: string }> = {
  titze2006: { label: 'I. Titze, « Voice training and therapy with a semi-occluded vocal tract », JSLHR, 2006', url: 'https://doi.org/10.1044/1092-4388(2006/035)' },
  revueEchauffement: { label: 'Revue systématique « Vocal warm-up and cool-down » (Revista CEFAC)', url: 'https://www.scielo.br/j/rcefac/a/47rW5K8NFbCgJSsYD4hNY4K/abstract/?lang=en' },
  vocalises: { label: 'Cours et Fiches : 12 vocalises (sirène, trille, gammes de 5 notes)', url: 'https://cours-et-fiches.com/chanter/vocalises/' },
  songwriting: { label: 'Songwriting Magazine : 10 vocal warm-up exercises', url: 'https://www.songwritingmagazine.co.uk/tips/10-vocal-warm-up-exercises' },
  ohriner: { label: 'M. Ohriner, « Flow: The Rhythmic Voice in Rap Music », Oxford University Press, 2019', url: 'https://academic.oup.com/book/37383' },
  adams: { label: 'K. Adams, « On the Metrical Techniques of Flow in Rap Music », Music Theory Online 15.5, 2009', url: 'https://mtosmt.org/issues/mto.09.15.5/mto.09.15.5.adams.php' },
  edwards: { label: 'P. Edwards, « How to Rap 2: Advanced Flow and Delivery Techniques », Chicago Review Press, 2013', url: 'https://chicagoreviewpress.com/how-to-rap-2-products-9781613744017.php' },
  virelangues: { label: 'Les Sherpas : virelangues, guide d’entraînement oral', url: 'https://sherpas.com/blog/virelangues/' },
  hyperphysics: { label: 'HyperPhysics : cents et seuil de perception (≈ 5 cents)', url: 'https://hyperphysics.gsu.edu/hbase/Music/cents.html' },
};

export const EXERCISES: Exercise[] = [
  { id: 'souffle', kind: 'souffle', group: 'souffle', title: 'Souffle tenu « sss »', goal: 'Tenir le souffle pour finir tes phrases sans manquer d’air.', seconds: 45, measure: 's', sources: ['vocalises', 'songwriting'],
    steps: ['Debout, épaules basses. Inspire par le nez pendant 4 temps, le ventre gonfle.', 'Bloque 2 temps sans serrer la gorge.', 'Souffle « sssss » le plus longtemps possible, à volume constant.', 'Objectif : 20 s régulières, puis 25 s.'] },
  { id: 'tessiture', kind: 'tessiture', group: 'voix', title: 'Test de tessiture', goal: 'Trouver ta zone confortable : les gammes s’y calent ensuite.', seconds: 20, measure: 'demi-tons', sources: ['vocalises'],
    steps: ['Sur « ou », pars de ta note la plus grave CONFORTABLE.', 'Glisse lentement jusqu’à ta note aiguë confortable, puis redescends.', 'Ne force jamais le haut ni le bas : on mesure ta zone de travail, pas un record.'] },
  { id: 'sirene', kind: 'sirene', group: 'voix', title: 'Sirènes', goal: 'Passer du grave à l’aigu sans cassure (registres).', seconds: 20, measure: 'demi-tons', sources: ['vocalises', 'songwriting'],
    steps: ['Sur « ng » (comme la fin de « parking ») ou « ou », volume doux.', 'Glisse du grave à l’aigu puis retour, comme une sirène, sur un seul souffle.', 'Fais-en 3. La ligne doit rester continue, sans trou.'] },
  { id: 'trilles', kind: 'trilles', group: 'voix', title: 'Trilles des lèvres guidés', goal: 'Détendre et équilibrer souffle et voix (exercice à conduit semi-fermé).', seconds: 50, measure: 'cents', sources: ['titze2006', 'vocalises', 'revueEchauffement'],
    steps: ['Lèvres détendues, fais « brrr » comme un moteur (si ça bloque : pose deux doigts sur les joues, ou roule le « r »).', 'Écoute le motif de 5 notes, puis refais-le en « brrr » en suivant la ligne.', 'Le motif monte d’un demi-ton à chaque tour.'] },
  { id: 'gamme5', kind: 'gamme5', group: 'voix', title: 'Gamme de 5 notes', goal: 'Justesse note par note, dans ta tessiture.', seconds: 60, measure: 'cents', sources: ['vocalises', 'songwriting'],
    steps: ['Écoute Do-Ré-Mi-Fa-Sol-Fa-Mi-Ré-Do, puis chante-le sur « ma-mé-mi-mo-mou ».', 'Chaque tour monte d’un demi-ton.', 'Vise le centre de la note : la bande verte = ±25 cents.'] },
  { id: 'tenue', kind: 'tenue', group: 'voix', title: 'Tenue de note', goal: 'Tenir une note juste et stable 6 secondes.', seconds: 15, measure: 'cents', sources: ['hyperphysics'],
    steps: ['Écoute la note de départ.', 'Chante-la sur « a », sans vibrato, 6 secondes.', 'Score : écart en cents (5 cents ≈ ce que l’oreille entend, 25 cents = faux).'] },
  { id: 'diction', kind: 'diction', group: 'rap', title: 'Diction : virelangues', goal: 'Articuler net à vitesse rap.', seconds: 40, measure: 'ms', sources: ['virelangues', 'edwards'],
    steps: ['Lis d’abord le virelangue lentement, en exagérant les consonnes.', 'Puis dis une syllabe par point lumineux, sur le clic.', 'Trois vitesses : 70, 85 puis 100 BPM.'] },
  { id: 'flow-80-croches', kind: 'flow', group: 'rap', title: 'Flow 80 BPM · croches', goal: 'Poser 2 syllabes par temps, pile sur la grille (boom bap).', seconds: 20, measure: 'ms', bpm: 80, subdivision: 'croches', sources: ['ohriner', 'adams', 'edwards'],
    steps: ['1 mesure de décompte (4 clics), puis 2 mesures à rapper.', 'Dis « ta-ka » sur chaque point lumineux.', 'Score : écart en millisecondes entre ta syllabe et le temps.'] },
  { id: 'flow-90-triolets', kind: 'flow', group: 'rap', title: 'Flow 90 BPM · triolets', goal: 'Le flow en triolets (3 syllabes par temps).', seconds: 20, measure: 'ms', bpm: 90, subdivision: 'triolets', sources: ['edwards', 'ohriner'],
    steps: ['1 mesure de décompte, puis 2 mesures.', 'Dis « ta-ki-ta » sur chaque groupe de 3 points.', 'Garde les 3 syllabes égales, n’accélère pas la 3e.'] },
  { id: 'flow-140-croches', kind: 'flow', group: 'rap', title: 'Flow 140 BPM · croches', goal: 'Tempo trap / drill : rester calé quand ça va vite.', seconds: 15, measure: 'ms', bpm: 140, subdivision: 'croches', sources: ['ohriner', 'adams'],
    steps: ['1 mesure de décompte, puis 2 mesures.', '« ta-ka » sur chaque point : 4,7 syllabes par seconde.', 'Quand c’est calé, essaie les doubles croches.'] },
  { id: 'flow-140-doubles', kind: 'flow', group: 'rap', title: 'Flow 140 BPM · doubles croches', goal: 'Débit rapide (fast flow), 16 syllabes par mesure.', seconds: 15, measure: 'ms', bpm: 140, subdivision: 'doubles', sources: ['ohriner', 'edwards'],
    steps: ['1 mesure de décompte, puis 2 mesures.', '« ta-ka-ti-ki » sur chaque temps : 9 syllabes par seconde.', 'Langue souple, mâchoire détendue : la vitesse vient de la précision.'] },
];

/** Échauffement complet, en un clic (≈ 8 min). */
export const PROGRAM: string[] = ['souffle', 'sirene', 'trilles', 'gamme5', 'tenue', 'diction', 'flow-80-croches', 'flow-90-triolets', 'flow-140-croches'];

export const exerciseById = (id: string) => EXERCISES.find(e => e.id === id);

// ---------------------------------------------------------------------------
// Hauteur captée : une liste de { t (s), midi } (NaN = pas de note).
// ---------------------------------------------------------------------------

export interface PitchPoint { t: number; midi: number }

const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.max(0, Math.min(s.length - 1, Math.floor(p * (s.length - 1))))]; };

export interface Tessiture { low: number; high: number }

/** Tessiture : 5e et 95e centiles des hauteurs chantées (les éclats ne comptent pas). */
export function tessitureOf(track: PitchPoint[]): Tessiture | null {
  const v = track.map(p => p.midi).filter(Number.isFinite);
  if (v.length < 10) return null;
  const low = Math.round(pct(v, 0.05)), high = Math.round(pct(v, 0.95));
  return high - low >= 3 ? { low, high } : null;
}

/** Tessiture par défaut (voix d'homme moyenne, rap / R&B) : La1 → Mi3 (MIDI 45 → 64). */
export const DEFAULT_TESSITURE: Tessiture = { low: 45, high: 64 };

/**
 * Fondamentale d'une gamme de 5 notes (quinte = 7 demi-tons) dans la tessiture :
 * dans le bas-médium, pour finir les 3 tours (+2 demi-tons) sous le haut confortable.
 */
export function comfortableRoot(t: Tessiture, reps = 3): number {
  const span = t.high - t.low;
  const room = span - 7 - (reps - 1);
  if (room <= 0) return t.low;
  return t.low + Math.round(room * 0.3);
}

/** Note à tenir : le milieu de la tessiture, un peu plus bas (là où la voix est la plus sûre). */
export const holdTarget = (t: Tessiture) => Math.round(t.low + (t.high - t.low) * 0.4);

/** Petit nom de la zone (indicatif). */
export function zoneLabel(t: Tessiture): string {
  const mid = (t.low + t.high) / 2;
  if (mid < 50) return 'grave';
  if (mid < 57) return 'médium-grave';
  if (mid < 64) return 'médium';
  return 'aiguë';
}

export interface TargetNote { t0: number; t1: number; midi: number }

/** Motif Do-Ré-Mi-Fa-Sol-Fa-Mi-Ré-Do (majeur) sur `root`, notes de `noteSec`. */
export function fiveNotePattern(root: number, start: number, noteSec = 0.45): TargetNote[] {
  const steps = [0, 2, 4, 5, 7, 5, 4, 2, 0];
  return steps.map((s, i) => ({ t0: start + i * noteSec, t1: start + (i + 1) * noteSec, midi: root + s }));
}

/** Motif des trilles : Do-Mi-Sol-Mi-Do, plus lent (le « brrr » se cale moins vite). */
export function trillPattern(root: number, start: number, noteSec = 0.6): TargetNote[] {
  const steps = [0, 4, 7, 4, 0];
  return steps.map((s, i) => ({ t0: start + i * noteSec, t1: start + (i + 1) * noteSec, midi: root + s }));
}

/** Écart (cents) ramené à l'octave la plus proche : une voix d'homme qui suit un guide plus aigu n'est pas « fausse ». */
export const foldCents = (midi: number, target: number) => {
  let d = midi - target;
  d = ((d + 6) % 12 + 12) % 12 - 6;
  return d * 100;
};

export interface GuidedScore {
  score: number;
  /** Écart absolu médian, toutes notes (cents). */
  medianAbsCents: number;
  /** Écart moyen signé (cents) : + = trop haut. */
  meanCents: number;
  /** Notes chantées (avec assez de trames) sur le total. */
  sung: number;
  total: number;
  /** Par note : écart médian signé, ou null si pas chantée. */
  perNote: (number | null)[];
}

/**
 * Justesse d'un motif guidé. Les premières `reactionSec` de chaque note sont
 * ignorées (le temps d'attaquer la note) ; octave pliée.
 */
export function scoreGuided(track: PitchPoint[], targets: TargetNote[], reactionSec = 0.12): GuidedScore {
  const perNote: (number | null)[] = [];
  const all: number[] = [];
  for (const n of targets) {
    const c = track.filter(p => p.t >= n.t0 + reactionSec && p.t < n.t1 && Number.isFinite(p.midi)).map(p => foldCents(p.midi, n.midi));
    if (c.length < 3) { perNote.push(null); continue; }
    const med = pct(c, 0.5);
    perNote.push(Math.round(med));
    all.push(...c);
  }
  const sung = perNote.filter(x => x !== null).length;
  if (!sung) return { score: 0, medianAbsCents: 0, meanCents: 0, sung: 0, total: targets.length, perNote };
  const abs = perNote.filter((x): x is number => x !== null).map(Math.abs);
  const medAbs = pct(abs, 0.5);
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const acc = Math.max(0, 100 - medAbs * 2);
  const score = Math.round(Math.max(0, Math.min(100, acc * (0.4 + 0.6 * sung / targets.length))));
  return { score, medianAbsCents: Math.round(medAbs), meanCents: Math.round(mean), sung, total: targets.length, perNote };
}

export interface SirenScore { score: number; rangeSemis: number; continuity: number; breaks: number }

/**
 * Sirène : étendue parcourue (demi-tons), continuité (part des trames avec
 * une hauteur pendant le passage chanté) et cassures (sauts de plus de
 * 2 demi-tons entre deux trames voisines, la marque d'un changement de registre brutal).
 */
export function scoreSiren(track: PitchPoint[], wantSemis = 12): SirenScore {
  const idx = track.map((p, i) => (Number.isFinite(p.midi) ? i : -1)).filter(i => i >= 0);
  if (idx.length < 8) return { score: 0, rangeSemis: 0, continuity: 0, breaks: 0 };
  const seg = track.slice(idx[0], idx[idx.length - 1] + 1);
  const v = seg.map(p => p.midi).filter(Number.isFinite);
  const range = pct(v, 0.97) - pct(v, 0.03);
  const continuity = v.length / seg.length;
  let breaks = 0;
  for (let i = 1; i < seg.length; i++) if (Number.isFinite(seg[i].midi) && Number.isFinite(seg[i - 1].midi) && Math.abs(seg[i].midi - seg[i - 1].midi) > 2) breaks++;
  const score = Math.round(Math.max(0, Math.min(100, Math.min(1, range / wantSemis) * 60 + continuity * 40 - breaks * 5)));
  return { score, rangeSemis: Math.round(range * 10) / 10, continuity: Math.round(continuity * 100) / 100, breaks };
}

// ---------------------------------------------------------------------------
// Historique (sur l'appareil).
// ---------------------------------------------------------------------------

export interface WarmupResult {
  id: string;
  /** Date (ms). */
  at: number;
  score: number;
  /** Mesure principale dans l'unité de l'exercice (cents, ms, demi-tons, s). */
  value: number;
  /** Détail court (« 18 ms en retard », « 12 cents »…). */
  note?: string;
}

export const HISTORY_KEY = 'nova_echauffement_v1';
export const TESSITURE_KEY = 'nova_tessiture_v1';
const MAX_ENTRIES = 600;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const store = (): Store | null => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };

export function loadHistory(s: Store | null = store()): WarmupResult[] {
  try {
    const raw = s?.getItem(HISTORY_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter(r => r && typeof r.id === 'string' && Number.isFinite(r.score) && Number.isFinite(r.at)) : [];
  } catch { return []; }
}

export function addResult(r: WarmupResult, s: Store | null = store()): WarmupResult[] {
  const all = [...loadHistory(s), r].slice(-MAX_ENTRIES);
  try { s?.setItem(HISTORY_KEY, JSON.stringify(all)); } catch { /* stockage plein ou bloqué : l'exercice reste noté à l'écran */ }
  return all;
}

export function clearHistory(s: Store | null = store()) { try { s?.removeItem(HISTORY_KEY); } catch { /* */ } }

export function loadTessiture(s: Store | null = store()): Tessiture | null {
  try { const v = JSON.parse(s?.getItem(TESSITURE_KEY) || 'null'); return v && Number.isFinite(v.low) && Number.isFinite(v.high) && v.high > v.low ? v : null; } catch { return null; }
}
export function saveTessiture(t: Tessiture, s: Store | null = store()) { try { s?.setItem(TESSITURE_KEY, JSON.stringify(t)); } catch { /* */ } }

export interface ExerciseProgress { id: string; count: number; best: number; last: number; first: number; recent: number[]; streakDays: number }

/** Progrès d'un exercice : meilleur score, dernier, premier, 10 derniers. */
export function progressOf(history: WarmupResult[], id: string): ExerciseProgress | null {
  const h = history.filter(r => r.id === id).sort((a, b) => a.at - b.at);
  if (!h.length) return null;
  return { id, count: h.length, best: Math.max(...h.map(r => r.score)), last: h[h.length - 1].score, first: h[0].score, recent: h.slice(-10).map(r => r.score), streakDays: streakDays(history) };
}

/** Jours d'affilée (jusqu'à aujourd'hui ou hier) avec au moins un exercice. */
export function streakDays(history: WarmupResult[], now = Date.now()): number {
  const day = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const days = new Set(history.map(r => day(r.at)));
  let n = 0;
  let t = now;
  if (!days.has(day(t))) t -= 86400000;
  while (days.has(day(t))) { n++; t -= 86400000; }
  return n;
}
