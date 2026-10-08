/**
 * Justesse note par note (V19) : calcul des corrections.
 *
 * Chaque note reçoit une retouche (`NoteEdit`) ; on en déduit, trame par
 * trame, la courbe de correction (en demi-tons) que le rendu PSOLA applique
 * (utils/pitchRender.ts). Logique pure, testée dans tests/pitchEdit.test.ts.
 *
 * La hauteur chantée d'une note se décompose en :
 *   centre (médiane) + dérive lente (la note qui « glisse ») + vibrato (rapide).
 * La hauteur visée vaut :
 *   centre + décalage + (1 − redressement) · dérive + vibrato · oscillation.
 * Entre deux notes, le décalage passe de l'une à l'autre sur la durée de la
 * transition (fondu en cosinus) : la glissade chantée est gardée, recentrée.
 */
import type { PitchNote, PitchTrack } from './pitchAnalysis';
import { scalePitchClasses } from './scales';

export interface NoteEdit {
  /** Décalage de la note (demi-tons, au cent près) depuis la hauteur chantée. */
  shift: number;
  /** Redressement de la dérive : 0 = laissée telle quelle, 1 = note bien droite. */
  drift: number;
  /** Vibrato : 1 = intact, 0 = supprimé, 2 = doublé. */
  vibrato: number;
  /** Transition depuis la note précédente (ms). Absente = naturelle. */
  transitionMs?: number;
}

export const NEUTRAL_EDIT: NoteEdit = { shift: 0, drift: 0, vibrato: 1 };

/** Transition « naturelle » (ms) quand la note n'en précise pas. */
export const NATURAL_TRANSITION_MS = 70;

export type CorrectStyle = 'naturel' | 'robot';

export const isNeutral = (e?: NoteEdit): boolean =>
  !e || (Math.abs(e.shift) < 1e-4 && e.drift < 1e-4 && Math.abs(e.vibrato - 1) < 1e-4 && e.transitionMs === undefined);

const mod12 = (n: number) => ((n % 12) + 12) % 12;

/**
 * Note de la gamme la plus proche d'une hauteur fractionnaire (MIDI). En
 * chromatique (ou tonalité inconnue) : le demi-ton le plus proche.
 */
export function nearestScaleNote(midi: number, root?: number, scale?: string): number {
  const pcs = typeof root === 'number' && Number.isFinite(root) ? scalePitchClasses(root, scale) : null;
  let best = Math.round(midi), bestD = Infinity;
  for (let p = Math.floor(midi) - 7; p <= Math.ceil(midi) + 7; p++) {
    if (pcs && !pcs.has(mod12(p))) continue;
    const d = Math.abs(midi - p);
    if (d < bestD - 1e-9) { bestD = d; best = p; }
  }
  return best;
}

/** Hauteur visée du centre de la note (MIDI fractionnaire). */
export const targetCenter = (note: PitchNote, edit?: NoteEdit): number => note.center + (edit?.shift ?? 0);

/** Écart (cents, signé) d'une hauteur à la note de la gamme la plus proche. */
export const centsFromScale = (midi: number, root?: number, scale?: string): number =>
  (midi - nearestScaleNote(midi, root, scale)) * 100;

/**
 * « Corriger tout dans la gamme » : chaque note est ramenée vers la note de
 * la gamme la plus proche, au dosage `amount` (0 à 1).
 *  - Naturel : la note est recentrée, sa vie (dérive, vibrato, glissades)
 *    est gardée ; seule la dérive est un peu redressée.
 *  - Robot : note bien droite, sans vibrato, saut net d'une note à l'autre
 *    (l'effet Auto-Tune du rap).
 */
export function autoCorrect(notes: PitchNote[], key: { root?: number; scale?: string }, amount: number, style: CorrectStyle): NoteEdit[] {
  const a = Math.max(0, Math.min(1, amount));
  return notes.map(n => {
    const target = nearestScaleNote(n.center, key.root, key.scale);
    const shift = a * (target - n.center);
    if (style === 'robot') {
      return { shift, drift: a, vibrato: 1 - a, transitionMs: Math.round((1 - a) * NATURAL_TRANSITION_MS) };
    }
    return { shift, drift: 0.35 * a, vibrato: 1 };
  });
}

/** Coller la note à la gamme (décalage complet vers la note la plus proche de la hauteur visée). */
export function snapEdit(note: PitchNote, edit: NoteEdit, key: { root?: number; scale?: string }): NoteEdit {
  const target = nearestScaleNote(targetCenter(note, edit), key.root, key.scale);
  return { ...edit, shift: target - note.center };
}

/**
 * Monter / descendre une note : par demi-ton (la note retombe sur un demi-ton
 * juste) ou au cent près.
 */
export function nudgeEdit(note: PitchNote, edit: NoteEdit, amount: number, unit: 'semitone' | 'cent'): NoteEdit {
  if (unit === 'cent') return { ...edit, shift: Math.round((edit.shift + amount / 100) * 100) / 100 };
  const now = targetCenter(note, edit);
  const step = Math.round(amount);
  if (!step) return edit;
  // Hors demi-ton juste, le premier pas retombe sur le demi-ton voisin dans le sens demandé.
  const onGrid = Math.abs(now - Math.round(now)) < 0.02;
  const dest = onGrid ? Math.round(now) + step : step > 0 ? Math.ceil(now) + step - 1 : Math.floor(now) + step + 1;
  return { ...edit, shift: Math.round((dest - note.center) * 1000) / 1000 };
}

/** Moyenne glissante (fenêtre ±r trames) qui ignore les trames sans hauteur. */
function smooth(v: Float32Array, r: number): Float32Array {
  const n = v.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) if (!Number.isNaN(v[k])) { s += v[k]; c++; }
    out[i] = c ? s / c : 0;
  }
  return out;
}

/** Fondu en cosinus de 0 à 1 (u de 0 à 1). */
const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * u));

/**
 * Courbe de correction (demi-tons) trame par trame. 0 hors des notes (souffle,
 * consonnes, silences : rendu à l'identique).
 */
export function correctionCurve(track: PitchTrack, notes: PitchNote[], edits: (NoteEdit | undefined)[]): Float32Array {
  const n = track.midi.length;
  const out = new Float32Array(n);
  const hopMs = (track.hop / track.sr) * 1000;
  // Décomposition dérive lente / vibrato : moyenne double de ±70 ms (≈ coupe
  // au-dessus de 3 Hz, le vibrato chanté est entre 4 et 8 Hz).
  const r = Math.max(2, Math.round(70 / hopMs));
  const transOf = (k: number) => {
    const e = edits[k];
    return Math.max(0, e?.transitionMs ?? NATURAL_TRANSITION_MS);
  };

  // Partie propre à chaque note : décalage + retouches de dérive / vibrato.
  const own: Float32Array[] = notes.map((note, k) => {
    const e = edits[k] || NEUTRAL_EDIT;
    const len = note.i1 - note.i0;
    const dev = new Float32Array(len);
    for (let i = 0; i < len; i++) { const m = track.midi[note.i0 + i]; dev[i] = Number.isNaN(m) ? NaN : m - note.center; }
    const slow = smooth(smooth(dev, r), r);
    const res = new Float32Array(len);
    // Les retouches de dérive et de vibrato s'effacent aux bords de la note
    // (sur une demi-transition) : la glissade d'attaque reste naturelle.
    const tIn = transOf(k) / 2 / hopMs;
    const tOut = (k + 1 < notes.length && notes[k + 1].i0 <= note.i1 + 1 ? transOf(k + 1) : transOf(k)) / 2 / hopMs;
    for (let i = 0; i < len; i++) {
      if (Number.isNaN(dev[i])) { res[i] = e.shift; continue; }
      const vib = dev[i] - slow[i];
      const w = Math.min(tIn > 0 ? ease((i + 0.5) / tIn) : 1, tOut > 0 ? ease((len - i - 0.5) / tOut) : 1);
      res[i] = e.shift + w * (-e.drift * slow[i] + (e.vibrato - 1) * vib);
    }
    return res;
  });

  for (let k = 0; k < notes.length; k++) {
    const note = notes[k];
    for (let i = note.i0; i < note.i1; i++) out[i] = own[k][i - note.i0];
  }

  // Transitions entre notes collées (même passage chanté) : fondu du
  // décalage de part et d'autre de la frontière.
  for (let k = 1; k < notes.length; k++) {
    const A = notes[k - 1], B = notes[k];
    if (B.i0 > A.i1 + 1) continue;
    const half = transOf(k) / 2 / hopMs;
    if (half < 0.5) continue;
    const b = B.i0;
    const lo = Math.max(A.i0, Math.floor(b - half)), hi = Math.min(B.i1, Math.ceil(b + half));
    const lastA = own[k - 1][A.i1 - A.i0 - 1], firstB = own[k][0];
    for (let i = lo; i < hi; i++) {
      const u = (i + 0.5 - (b - half)) / (2 * half);
      const left = i < b ? own[k - 1][i - A.i0] : lastA;
      const right = i >= b ? own[k][i - B.i0] : firstB;
      out[i] = left + (right - left) * ease(u);
    }
  }

  // Aucune correction là où rien n'est chanté.
  for (let i = 0; i < n; i++) if (Number.isNaN(track.midi[i])) out[i] = 0;
  return out;
}

/** Hauteur visée (MIDI) trame par trame : courbe affichée en surimpression. */
export function targetPitch(track: PitchTrack, corr: Float32Array): Float32Array {
  const out = new Float32Array(track.midi.length);
  for (let i = 0; i < out.length; i++) out[i] = Number.isNaN(track.midi[i]) ? NaN : track.midi[i] + corr[i];
  return out;
}

/** Vrai si au moins une note est retouchée. */
export const hasEdits = (edits: (NoteEdit | undefined)[]): boolean => edits.some(e => !isNeutral(e));

/**
 * Gamme devinée d'après la voix (tonalité du projet inconnue) : la gamme
 * majeure ou mineure qui contient le plus de temps chanté, en favorisant les
 * notes longues et la tonique sur les notes tenues.
 */
export function guessKey(notes: PitchNote[]): { root: number; scale: 'MINOR' | 'MAJOR' } | null {
  if (notes.length < 3) return null;
  const weight = new Array(12).fill(0);
  for (const n of notes) weight[mod12(Math.round(n.center))] += Math.max(0.02, n.end - n.start);
  let best: { root: number; scale: 'MINOR' | 'MAJOR' } | null = null, bestScore = -Infinity;
  for (const scale of ['MINOR', 'MAJOR'] as const) {
    for (let root = 0; root < 12; root++) {
      const pcs = scalePitchClasses(root, scale);
      let s = 0;
      for (let pc = 0; pc < 12; pc++) s += pcs.has(pc) ? weight[pc] : -1.5 * weight[pc];
      s += 0.25 * weight[root];
      // À égalité (relatives majeure / mineure), le rap et le R&B penchent vers le mineur.
      if (scale === 'MINOR') s += 1e-6;
      if (s > bestScore) { bestScore = s; best = { root, scale }; }
    }
  }
  return best;
}

/**
 * Courbe de hauteur pour l'AFFICHAGE : aux bords d'un passage chanté (juste
 * avant ou après un blanc), la fenêtre d'analyse chevauche le silence et la
 * hauteur mesurée fait un petit pic (un demi-ton sur une trame). On masque ces
 * trames de bord (jusqu'à 2 de chaque côté) quand elles s'écartent de la
 * tendance des trames voisines. Le son n'est pas concerné : la correction ne
 * dépend pas de ces trames.
 */
export function displayPitchCurve(v: Float32Array, maxJump = 0.3, edge = 2): Float32Array {
  const out = Float32Array.from(v);
  const ok = (i: number) => i >= 0 && i < out.length && !Number.isNaN(out[i]);
  for (let i = 0; i < out.length; i++) {
    if (!ok(i) || (ok(i - 1) && ok(i + 1))) continue;
    // Bord d'un passage : on remonte vers l'intérieur (dir = +1 depuis le début, −1 depuis la fin).
    const dir = ok(i + 1) ? 1 : ok(i - 1) ? -1 : 0;
    if (!dir) continue;
    for (let k = 0; k < edge; k++) {
      const j = i + dir * k, a = j + dir, b = j + 2 * dir;
      if (!ok(j) || !ok(a) || !ok(b)) break;
      const pred = out[a] + (out[a] - out[b]);
      if (Math.abs(out[j] - pred) <= maxJump) break;
      out[j] = NaN;
    }
  }
  return out;
}
