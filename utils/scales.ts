/**
 * Gammes et accords pour le piano roll (V14).
 *
 * - Surbrillance de la gamme du projet (Scale Highlighting de FL Studio,
 *   Keys and Scales de Live 12) : `isInScale`.
 * - Aimant de gamme (Scale Snap de FL, « Fold / Scale Mode » de Live) :
 *   `snapToScale`, `scaleRows`.
 * - Tampon d'accord (Chord Stamp de FL, générateur Stacks de Live 12) :
 *   `buildChord`, `diatonicChord`.
 *
 * Les gammes reprennent les noms du projet (`projectScale`, détectés à
 * l'import et lus sur le beat du catalogue) : MAJOR, MINOR, MINOR_HARMONIC,
 * PENTATONIC (pentatonique mineure, comme l'Auto-Tune), CHROMATIC.
 */

export const SCALE_INTERVALS: Record<string, number[]> = {
  CHROMATIC: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  MAJOR: [0, 2, 4, 5, 7, 9, 11],
  MINOR: [0, 2, 3, 5, 7, 8, 10],
  MINOR_HARMONIC: [0, 2, 3, 5, 7, 8, 11],
  PENTATONIC: [0, 3, 5, 7, 10],
  PENTATONIC_MAJOR: [0, 2, 4, 7, 9],
  DORIAN: [0, 2, 3, 5, 7, 9, 10],
  PHRYGIAN: [0, 1, 3, 5, 7, 8, 10],
  BLUES: [0, 3, 5, 6, 7, 10],
};

/** Gammes proposées dans le piano roll, avec leur nom français. */
export const SCALE_CHOICES: { id: string; label: string }[] = [
  { id: 'MINOR', label: 'mineur' },
  { id: 'MAJOR', label: 'majeur' },
  { id: 'MINOR_HARMONIC', label: 'mineur harmonique' },
  { id: 'PENTATONIC', label: 'penta mineure' },
  { id: 'PENTATONIC_MAJOR', label: 'penta majeure' },
  { id: 'DORIAN', label: 'dorien' },
  { id: 'PHRYGIAN', label: 'phrygien' },
  { id: 'BLUES', label: 'blues' },
  { id: 'CHROMATIC', label: 'chromatique' },
];

export const NOTE_NAMES_FR = ['Do', 'Do#', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa#', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];

const mod12 = (n: number) => ((Math.round(n) % 12) + 12) % 12;

/** Intervalles de la gamme (chromatique si inconnue). */
export const scaleIntervals = (scale?: string): number[] =>
  SCALE_INTERVALS[(scale || '').toUpperCase()] || SCALE_INTERVALS.CHROMATIC;

/** Classes de hauteur (0-11) de la gamme. */
export const scalePitchClasses = (root: number, scale?: string): Set<number> =>
  new Set(scaleIntervals(scale).map(i => mod12(root + i)));

/** Vrai si la note MIDI appartient à la gamme (toujours vrai en chromatique). */
export const isInScale = (pitch: number, root: number, scale?: string): boolean =>
  scalePitchClasses(root, scale).has(mod12(pitch));

/**
 * Note de la gamme la plus proche. À égale distance, on descend (comme
 * le Scale Snap de FL) sauf si `dir` impose le sens.
 */
export const snapToScale = (pitch: number, root: number, scale?: string, dir: 'nearest' | 'up' | 'down' = 'nearest'): number => {
  const pcs = scalePitchClasses(root, scale);
  const p = Math.round(pitch);
  if (pcs.has(mod12(p))) return p;
  for (let d = 1; d <= 12; d++) {
    const down = p - d, up = p + d;
    if (dir !== 'up' && pcs.has(mod12(down))) return Math.max(0, down);
    if (dir !== 'down' && pcs.has(mod12(up))) return Math.min(127, up);
  }
  return p;
};

/**
 * Lignes affichées dans le piano roll, de la plus aiguë à la plus grave.
 * `onlyScale` : seulement les notes de la gamme (« montrer seulement la gamme »).
 */
export const scaleRows = (root: number, scale: string | undefined, onlyScale: boolean, lo = 0, hi = 127): number[] => {
  const rows: number[] = [];
  const pcs = scalePitchClasses(root, scale);
  for (let p = hi; p >= lo; p--) if (!onlyScale || pcs.has(mod12(p))) rows.push(p);
  return rows;
};

/** Nom français d'une note MIDI : 60 → « Do3 » (Do central = Do3, comme Live et FL). */
export const noteNameFr = (pitch: number): string => `${NOTE_NAMES_FR[mod12(pitch)]}${Math.floor(Math.round(pitch) / 12) - 2}`;

/** « Fa# mineur » ; '' si la tonalité est inconnue. */
export const keyLabelFr = (root?: number, scale?: string): string => {
  if (typeof root !== 'number' || !Number.isFinite(root)) return '';
  const s = SCALE_CHOICES.find(c => c.id === (scale || 'MINOR').toUpperCase());
  return `${NOTE_NAMES_FR[mod12(root)]} ${s ? s.label : ''}`.trim();
};

// ---------------------------------------------------------------------------
// Accords
// ---------------------------------------------------------------------------

export type ChordKind =
  | 'SCALE' | 'MAJOR' | 'MINOR' | 'DOM7' | 'MAJ7' | 'MIN7' | 'SUS2' | 'SUS4' | 'DIM' | 'AUG' | 'ADD9' | 'MIN9' | 'POWER';

/** Intervalles depuis la fondamentale (partagés avec le ChordGenerator du service MIDI). */
export const CHORD_INTERVALS: Record<Exclude<ChordKind, 'SCALE'> | 'DIM7' | 'MAJ9', number[]> = {
  MAJOR: [0, 4, 7],
  MINOR: [0, 3, 7],
  DIM: [0, 3, 6],
  AUG: [0, 4, 8],
  SUS2: [0, 2, 7],
  SUS4: [0, 5, 7],
  MAJ7: [0, 4, 7, 11],
  MIN7: [0, 3, 7, 10],
  DOM7: [0, 4, 7, 10],
  DIM7: [0, 3, 6, 9],
  MAJ9: [0, 4, 7, 11, 14],
  MIN9: [0, 3, 7, 10, 14],
  ADD9: [0, 4, 7, 14],
  POWER: [0, 7],
};

/** Accords du tampon, avec libellé français et équivalent cité dans l'infobulle. */
export const CHORD_CHOICES: { id: ChordKind; label: string; hint: string }[] = [
  { id: 'SCALE', label: 'Accord de la gamme', hint: 'Triade construite sur la gamme du morceau : majeur, mineur ou diminué selon la note, toujours juste' },
  { id: 'MAJOR', label: 'Majeur', hint: 'Do-Mi-Sol : lumineux' },
  { id: 'MINOR', label: 'Mineur', hint: 'Do-Mi♭-Sol : sombre, le son trap / R&B' },
  { id: 'MIN7', label: 'Mineur 7', hint: 'Mineur + 7e : très R&B' },
  { id: 'MAJ7', label: 'Majeur 7', hint: 'Majeur + 7e majeure : doux, jazzy' },
  { id: 'DOM7', label: '7e (dominante)', hint: 'Majeur + 7e mineure : tension' },
  { id: 'MIN9', label: 'Mineur 9', hint: 'Mineur 7 + 9e : nappe R&B' },
  { id: 'ADD9', label: 'Add9', hint: 'Majeur + 9e : ouvert' },
  { id: 'SUS2', label: 'Sus2', hint: 'Sans tierce, avec la seconde : flottant' },
  { id: 'SUS4', label: 'Sus4', hint: 'Sans tierce, avec la quarte : suspendu' },
  { id: 'DIM', label: 'Diminué', hint: 'Tierces mineures : inquiétant' },
  { id: 'AUG', label: 'Augmenté', hint: 'Quinte augmentée : étrange' },
  { id: 'POWER', label: 'Quinte (power)', hint: 'Fondamentale + quinte : 808, guitares' },
];

/**
 * Triade (ou accord de 7e avec `sevenths`) construite en empilant des
 * tierces DANS la gamme, à partir de la note cliquée ramenée dans la gamme.
 * En chromatique, on retombe sur un accord mineur (le plus courant en rap).
 */
export const diatonicChord = (rootPitch: number, root: number, scale?: string, sevenths = false): number[] => {
  const iv = scaleIntervals(scale);
  if (iv.length < 5 || (scale || '').toUpperCase() === 'CHROMATIC') {
    return (sevenths ? CHORD_INTERVALS.MIN7 : CHORD_INTERVALS.MINOR).map(i => rootPitch + i);
  }
  const start = snapToScale(rootPitch, root, scale);
  // Degrés de la gamme à partir de `start`, sur deux octaves.
  const degrees: number[] = [];
  for (let p = start; degrees.length < 8 && p <= start + 24; p++) {
    if (iv.includes(mod12(p - root))) degrees.push(p);
  }
  // Pentatonique (5 notes) : empiler « une note sur deux » donne déjà un bel accord.
  const idx = sevenths ? [0, 2, 4, 6] : [0, 2, 4];
  return idx.map(i => degrees[i]).filter((p): p is number => typeof p === 'number');
};

/**
 * Notes de l'accord posé sur `rootPitch`. Avec `snap`, la fondamentale est
 * d'abord ramenée dans la gamme ; pour un accord nommé (majeur, mineur…), les
 * notes restent celles de l'accord (comme le Chord Stamp de FL).
 */
export const buildChord = (rootPitch: number, kind: ChordKind, opts: { root?: number; scale?: string; snap?: boolean; inversion?: number } = {}): number[] => {
  const hasKey = typeof opts.root === 'number';
  const base = hasKey && opts.snap ? snapToScale(rootPitch, opts.root!, opts.scale) : Math.round(rootPitch);
  let notes = kind === 'SCALE'
    ? diatonicChord(base, hasKey ? opts.root! : 0, hasKey ? opts.scale : 'CHROMATIC')
    : CHORD_INTERVALS[kind].map(i => base + i);
  const inv = Math.max(0, Math.min(notes.length - 1, Math.round(opts.inversion || 0)));
  for (let k = 0; k < inv; k++) notes = [...notes.slice(1), notes[0] + 12];
  return notes.filter(p => p >= 0 && p <= 127);
};

/** Nom de l'accord affiché (« Fa# mineur »), pour le retour visuel. */
export const chordLabelFr = (notes: number[]): string => {
  if (notes.length < 2) return notes.length ? noteNameFr(notes[0]) : '';
  const root = notes[0];
  const rel = notes.map(n => n - root).sort((a, b) => a - b).join(',');
  const table: Record<string, string> = {
    '0,4,7': 'majeur', '0,3,7': 'mineur', '0,3,6': 'diminué', '0,4,8': 'augmenté', '0,2,7': 'sus2', '0,5,7': 'sus4',
    '0,4,7,11': 'majeur 7', '0,3,7,10': 'mineur 7', '0,4,7,10': '7', '0,3,6,10': 'demi-diminué', '0,3,6,9': 'diminué 7',
    '0,3,7,10,14': 'mineur 9', '0,4,7,14': 'add9', '0,7': '5', '0,3,7,11': 'mineur maj7',
  };
  return `${NOTE_NAMES_FR[mod12(root)]} ${table[rel] || ''}`.trim();
};
