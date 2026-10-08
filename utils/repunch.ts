/**
 * R23 · Repunch intelligent : repérer les passages « à refaire » d'une prise
 * et poser la zone de punch pour les refaire.
 *
 * Pro Tools laisse l'ingé écouter toute la prise et poser les points de punch
 * à la main. Ici, la prise est découpée en phrases (silences, sinon toutes les
 * 2 mesures) ; chaque phrase est notée par utils/takeScore (justesse, calage
 * sur le temps, niveau, bruit) et on y ajoute la saturation. Une phrase est
 * « à refaire » quand un critère tombe sous un seuil absolu, ou nettement
 * sous le reste de la prise (l'artiste qui rappe toujours un peu en avance
 * n'a pas toute sa prise en rouge : on montre ce qui détonne).
 *
 * Module pur : testé dans tests/repunch.test.ts.
 */
import { scoreTake, ScoreOptions, TakeScore } from './takeScore';

export type RedoReason = 'justesse' | 'calage' | 'niveau' | 'saturation' | 'bruit';

export const REASON_LABEL: Record<RedoReason, string> = {
  justesse: 'justesse', calage: 'calage sur le temps', niveau: 'niveau trop bas', saturation: 'saturation', bruit: 'bruit de fond',
};

export const REASON_TIP: Record<RedoReason, string> = {
  justesse: 'Des notes à côté de la gamme du beat : chante plus près de la note (ou laisse l’Auto-Tune corriger si l’écart est léger).',
  calage: 'Les attaques tombent à côté du temps : cale-toi sur la caisse claire ou le charley.',
  niveau: 'Passage trop faible : rapproche-toi du micro ou chante plus franchement.',
  saturation: 'Le son a saturé (crête au maximum) : recule un peu du micro ou baisse le gain d’entrée.',
  bruit: 'Bruit de fond élevé (souffle, pièce, téléphone) : coupe la source ou rapproche-toi du micro.',
};

export interface RedoSpot {
  id: string;
  trackId: string;
  start: number;
  end: number;
  score: TakeScore;
  /** Part des échantillons saturés (0-1). */
  clipped: number;
  reasons: RedoReason[];
  /** « Justesse, calage sur le temps » */
  label: string;
}

export interface Phrase { start: number; end: number }

const ENV_STEP = 0.016;

/**
 * Phrases d'une voix (échantillons mono qui commencent à `t0`) : passages
 * séparés par des silences d'au moins `minGap` s ; les phrases de plus de
 * 3 mesures sont coupées toutes les 2 mesures (sur la grille de `gridOrigin`).
 */
export function splitPhrases(x: Float32Array, sr: number, t0: number, bpm: number, opts: { minGap?: number; minPhrase?: number; gridOrigin?: number } = {}): Phrase[] {
  const minGap = opts.minGap ?? 0.25, minPhrase = opts.minPhrase ?? 0.6;
  const per = Math.max(1, Math.round(ENV_STEP * sr));
  const n = Math.floor(x.length / per);
  if (!n) return [];
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = i * per; k < (i + 1) * per; k++) s += x[k] * x[k]; env[i] = Math.sqrt(s / per); }
  const sorted = Array.from(env).sort((a, b) => a - b);
  const loud = sorted[Math.floor(n * 0.95)] || 0;
  const thr = Math.max(loud * 0.08, 1e-4);
  const raw: Phrase[] = [];
  let i = 0;
  while (i < n) {
    while (i < n && env[i] < thr) i++;
    if (i >= n) break;
    const s = i;
    let quiet = 0;
    while (i < n && (env[i] >= thr || quiet * ENV_STEP < minGap)) { quiet = env[i] >= thr ? 0 : quiet + 1; i++; }
    raw.push({ start: t0 + s * ENV_STEP, end: t0 + (i - quiet) * ENV_STEP });
  }
  // Trop courtes : collées à la voisine.
  const merged: Phrase[] = [];
  for (const p of raw) {
    const last = merged[merged.length - 1];
    if (last && (p.end - p.start < minPhrase || last.end - last.start < minPhrase) && p.start - last.end < 1) last.end = p.end;
    else merged.push({ ...p });
  }
  const bar2 = (60 / (bpm > 0 ? bpm : 120)) * 8;
  const g0 = opts.gridOrigin ?? 0;
  const out: Phrase[] = [];
  for (const p of merged) {
    if (p.end - p.start <= bar2 * 1.5) { out.push(p); continue; }
    let cur = p.start;
    for (let t = g0 + Math.ceil((p.start + 0.5 - g0) / bar2) * bar2; t < p.end - bar2 / 2; t += bar2) { out.push({ start: cur, end: t }); cur = t; }
    out.push({ start: cur, end: p.end });
  }
  return out;
}

/** Part des échantillons saturés (|x| ≥ 0,985, au moins 3 de suite). */
export function clippedShare(x: Float32Array, gain = 1): number {
  let run = 0, n = 0;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i] * gain) >= 0.985) { run++; if (run === 3) n += 3; else if (run > 3) n++; }
    else run = 0;
  }
  return x.length ? n / x.length : 0;
}

const median = (v: number[]) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

export interface FindOptions extends ScoreOptions {
  trackId: string;
  /** Premier temps du beat (s) : la grille du calage part de là (0 par défaut). */
  gridOrigin?: number;
  /** Seuils absolus (0-100) sous lesquels un critère est signalé. */
  thresholds?: Partial<Record<'pitch' | 'timing' | 'level' | 'noise', number>>;
}

export const DEFAULT_THRESHOLDS = { pitch: 60, timing: 55, level: 45, noise: 40 };
/** Écart à la médiane de la prise (points) qui fait signaler un critère. */
export const RELATIVE_GAP = 18;

/**
 * Passages à refaire d'une voix : `x` (mono) commence à `t0` (s, projet).
 * Trié du pire au moins mauvais.
 */
export function findRedoSpots(x: Float32Array, sr: number, t0: number, o: FindOptions): RedoSpot[] {
  const g0 = o.gridOrigin ?? 0;
  const phrases = splitPhrases(x, sr, t0, o.bpm, { gridOrigin: g0 });
  const th = { ...DEFAULT_THRESHOLDS, ...(o.thresholds || {}) };
  const rows = phrases.map(p => {
    const a = Math.max(0, Math.round((p.start - t0) * sr)), b = Math.min(x.length, Math.round((p.end - t0) * sr));
    const seg = x.subarray(a, b);
    // Grille du calage : décalée du premier temps du beat.
    const score = scoreTake(seg, sr, { bpm: o.bpm, key: o.key, gain: o.gain, t0: p.start - g0 });
    return { p, score, clipped: clippedShare(seg, o.gain ?? 1) };
  }).filter(r => r.p.end - r.p.start >= 0.3);
  if (!rows.length) return [];
  const med = {
    pitch: median(rows.map(r => r.score.pitch)), timing: median(rows.map(r => r.score.timing)),
    level: median(rows.map(r => r.score.level)), noise: median(rows.map(r => r.score.noise)),
  };
  const several = rows.length >= 3;
  const spots: RedoSpot[] = [];
  rows.forEach((r, i) => {
    const reasons: RedoReason[] = [];
    // Sous le seuil ET un peu sous le reste de la prise, ou nettement sous le reste de la prise :
    // le style de l'artiste (flow en avance, voix voilée) ne met pas toute la prise en rouge.
    const bad = (k: 'pitch' | 'timing' | 'level' | 'noise') =>
      (r.score[k] < th[k] && (!several || r.score[k] < med[k] - 5)) || (several && r.score[k] < med[k] - RELATIVE_GAP);
    if (bad('pitch')) reasons.push('justesse');
    if (bad('timing')) reasons.push('calage');
    if (r.clipped > 0.0005) reasons.push('saturation');
    else if (bad('level')) reasons.push('niveau');
    // Bruit : mesuré sur les petits silences de la phrase, peu fiable seul ; seulement s'il détonne
    // du reste de la prise (le bruit de toute la prise est signalé à part : takeNoise).
    if (several && r.score.noise < th.noise && r.score.noise < med.noise - RELATIVE_GAP) reasons.push('bruit');
    if (!reasons.length) return;
    spots.push({
      id: `redo-${o.trackId}-${Math.round(r.p.start * 1000)}-${i}`,
      trackId: o.trackId, start: Math.round(r.p.start * 1000) / 1000, end: Math.round(r.p.end * 1000) / 1000,
      score: r.score, clipped: r.clipped, reasons,
      label: reasons.map(k => REASON_LABEL[k]).join(', ').replace(/^./, c => c.toUpperCase()),
    });
  });
  const sev = (s: RedoSpot) => s.score.total - s.reasons.length * 5 - (s.reasons.includes('saturation') ? 20 : 0);
  return spots.sort((a, b) => sev(a) - sev(b));
}

/** Avant / après d'un passage refait. */
export function compareScores(before: TakeScore | null, after: TakeScore | null): { better: 'new' | 'old' | 'same'; text: string } {
  if (!before || !after) return { better: 'same', text: 'Comparaison impossible (passage vide).' };
  const d = after.total - before.total;
  const crit: [keyof TakeScore, string][] = [['pitch', 'justesse'], ['timing', 'calage'], ['level', 'niveau'], ['noise', 'bruit']];
  const gains = crit.filter(([k]) => after[k] - before[k] >= 8).map(([, n]) => n);
  const losses = crit.filter(([k]) => before[k] - after[k] >= 8).map(([, n]) => n);
  if (d >= 4) return { better: 'new', text: `La nouvelle prise est meilleure (${before.total} → ${after.total}${gains.length ? ` : ${gains.join(', ')}` : ''}).` };
  if (d <= -4) return { better: 'old', text: `L’ancienne était meilleure (${before.total} → ${after.total}${losses.length ? ` : ${losses.join(', ')} en baisse` : ''}). Écoute les deux avant de choisir.` };
  return { better: 'same', text: `Les deux se valent (${before.total} → ${after.total}) : choisis à l’oreille.` };
}

/**
 * Bruit de fond de TOUTE la prise (silences entre les phrases compris) : 0-100.
 * Sous 40 : la pièce, le souffle ou un appareil s'entendent sur toute la prise.
 */
export function takeNoise(x: Float32Array, sr: number, bpm: number): number {
  return scoreTake(x, sr, { bpm }).noise;
}
