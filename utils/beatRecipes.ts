/**
 * Lot 10 · Recettes de genre de « Démarrer un beat » et des boucles NOVA.
 *
 * RÈGLE (comme les presets du synthé) : rien au hasard. Chaque tempo, motif de batterie, suite
 * d'accords et règle de 808 vient d'une source publiée (tutoriel, article, encyclopédie) ; les
 * numéros `src` renvoient à la liste de CONTENU/nova-151/sons-beat/RECETTES_BEAT.md (URL ouvertes).
 * Ce qui est un choix de NOVA (rythme d'accompagnement des accords, instrument) est marqué « NOVA ».
 *
 * Grille des motifs : 16 pas par mesure (pas 1 = index 0 = temps 1, pas 5 = temps 2, pas 9 = temps 3,
 * pas 13 = temps 4), « | » sépare les mesures. « X » accent, « x » coup, « o » ghost, « . » silence,
 * « 2 » / « 3 » roll de 2 ou 3 coups sur le pas. Rangée `rate: '16t'` : 24 pas par mesure (triolets).
 * Swing : échelle de la boîte à rythmes NOVA (0 = droit, 0,6 max ; retard des doubles-croches paires
 * = swing × ½ pas). Conversion depuis le swing MPC (50 % droit, 66 % triolet) : sw ≈ (MPC − 50) / 25.
 */
import type { ChordQuality } from './chordDetect';

export type BeatGenreId = 'trap' | 'drill-uk' | 'drill-fr' | 'boombap' | 'rnb' | 'afro';
export type BeatScale = 'MINOR' | 'MAJOR' | 'MINOR_HARMONIC' | 'PHRYGIAN' | 'DORIAN';

export interface DrumLine {
  role: 'kick' | 'snare' | 'clap' | 'hihat' | 'openhat' | 'perc' | 'perc2' | 'rim' | 'shaker' | 'crash' | 'tom';
  hits: string;
  rate?: '16' | '16t';
}
export interface DrumVariant { name: string; bars: 1 | 2; swing?: number; lines: DrumLine[]; src: number[] }
export interface BassRule {
  /** Rythme des attaques de 808 (même grille), si elle ne suit pas le kick. */
  hits?: string;
  /** La 808 joue sous le kick du motif choisi. */
  followKick?: boolean;
  /** Glissé vers la fondamentale suivante juste avant chaque changement d'accord. */
  slides?: boolean;
  /** Saut d'octave ponctuel (une attaque sur quatre). */
  octave?: boolean;
  src: number[];
}
export interface GenreRecipe {
  id: BeatGenreId;
  name: string;
  emoji: string;
  hint: string;
  bpm: number;
  bpmRange: [number, number];
  /** Ressenti en half-time (snare sur le 3e temps). */
  halfTime: boolean;
  scale: BeatScale;
  defaultRoot: number;
  swing: number;
  /** Styles des kits NOVA (index des kits) et kit synthé de secours (hors ligne). */
  kitStyles: string[];
  fallbackKit: string;
  /** Instruments NOVA des accords (le 1er pour « Démarrer un beat »). NOVA. */
  instruments: string[];
  /** Rythmes d'accompagnement des accords (1 mesure, « x » attaque, « - » tenue, « . » silence). NOVA. */
  comp: string[];
  dist808?: boolean;
  drums: DrumVariant[];
  bass: BassRule[];
  src: number[];
}
export interface ProgChord { off: number; q: ChordQuality; beats: number }
export interface ProgressionDef { id: string; genre: BeatGenreId; name: string; roman: string; scale: BeatScale; chords: ProgChord[]; src: number[] }

const L = (role: DrumLine['role'], hits: string, rate?: DrumLine['rate']): DrumLine => ({ role, hits, ...(rate ? { rate } : {}) });

export const BEAT_GENRES: GenreRecipe[] = [
  {
    id: 'trap', name: 'Trap', emoji: '🔥', hint: 'half-time, hats rapides, 808 sous le kick',
    bpm: 140, bpmRange: [130, 150], halfTime: true, scale: 'MINOR', defaultRoot: 6, swing: 0.16,
    kitStyles: ['trap', 'detroit'], fallbackKit: 'trap', instruments: ['cloches', 'piano', 'pad'],
    comp: ['x---------------', 'x-------x-------'],
    drums: [
      { name: 'clap sur le 3, hats en croches, rolls en fin de mesure', bars: 2, swing: 0.16, src: [3], lines: [
        L('kick', 'x.............x.|..x.............'),
        L('clap', '........X.......|........X.......'),
        L('hihat', 'x.x.x.x.x.x.x.x.|x.x.x.x.x.x.3.3.'),
      ] },
      { name: 'hats en doubles, roll avant le 3, open hat', bars: 1, swing: 0.16, src: [1, 2], lines: [
        L('kick', 'x......x........'),
        L('snare', '........Xo......'),
        L('hihat', 'xoxoxox3xoxoxo.x'),
        L('openhat', '..............x.'),
      ] },
      { name: 'trap dure : open hat à chaque temps, rolls 1/32', bars: 1, swing: 0, src: [2, 4, 6], lines: [
        L('kick', 'x......x......x.'),
        L('clap', '........X.......'),
        L('hihat', 'x...x...x...x.22'),
        L('openhat', '..x...x...x...x.'),
      ] },
    ],
    bass: [
      { followKick: true, src: [8] },
      { followKick: true, slides: true, src: [8] },
      { followKick: true, octave: true, src: [4, 8] },
    ],
    src: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  {
    id: 'drill-uk', name: 'Drill UK', emoji: '🇬🇧', hint: 'snare décalée, hats 3-3-2, 808 qui glisse',
    bpm: 142, bpmRange: [138, 146], halfTime: true, scale: 'MINOR', defaultRoot: 7, swing: 0.2,
    kitStyles: ['drill'], fallbackKit: 'drill', instruments: ['cordes', 'piano'], dist808: true,
    comp: ['x---------------', 'x-----x-----x---'],
    drums: [
      { name: 'snare au 3e temps puis au 4e', bars: 2, swing: 0.2, src: [12], lines: [
        L('kick', 'x.............x.|x..x..x.......x.'),
        L('snare', '........X.......|............X...'),
        L('hihat', 'x..o..x.x..o..xo|x..o..x.x..o..x.'),
        L('perc', 'x...............|..............x.'),
        L('perc2', '................|........x.......'),
      ] },
      { name: 'grime : hats 3-3-2, ghost snares, shaker', bars: 2, swing: 0.2, src: [13, 14], lines: [
        L('kick', 'x.............x.|x.....x.........'),
        L('snare', '........X.......|..........o.X..o'),
        L('hihat', 'x..x..x.x..x..x.'),
        L('shaker', '..x...x...x...x.'),
        L('perc', 'x...............'),
      ] },
      { name: 'snare au pas 11, rolls en triolets', bars: 2, swing: 0, src: [6, 16], lines: [
        L('kick', 'x.............x.|x..x..x.......x.'),
        L('snare', '..........X.....|............X...'),
        L('hihat', 'x..x..x..x..x..x..x..xxx', '16t'),
      ] },
    ],
    bass: [
      { followKick: true, slides: true, src: [15, 20] },
      { hits: 'x.......x.......', slides: true, src: [17, 20] },
      { followKick: true, slides: true, src: [12, 19] },
    ],
    src: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
  },
  {
    id: 'drill-fr', name: 'Drill FR', emoji: '🇫🇷', hint: 'la drill UK à 140, 808 longues et glissées',
    bpm: 140, bpmRange: [138, 145], halfTime: true, scale: 'MINOR', defaultRoot: 1, swing: 0.2,
    kitStyles: ['drill'], fallbackKit: 'drill', instruments: ['piano', 'cordes'], dist808: true,
    comp: ['x---------------', 'x-------x-------'],
    drums: [
      { name: 'gabarit UK (snare 3e puis 4e temps)', bars: 2, swing: 0.2, src: [12, 22, 24], lines: [
        L('kick', 'x.............x.|x..x..x.......x.'),
        L('snare', '........X.......|............X...'),
        L('hihat', 'x..x..x.x..x..x.'),
        L('perc', 'x...............|..............x.'),
      ] },
      { name: 'snare à contretemps, kick glissant', bars: 2, swing: 0.2, src: [6, 11, 23], lines: [
        L('kick', 'x.....x.......x.|x..x..........x.'),
        L('snare', '..........X.....|............X...'),
        L('hihat', 'x..x..x.x..x..x.|x..x..x.x..x.3x.'),
        L('shaker', '..x...x...x...x.'),
      ] },
      { name: 'hi-hats à contretemps, rolls en triolets', bars: 2, swing: 0, src: [11, 16], lines: [
        L('kick', 'x.............x.|x..x..x.......x.'),
        L('snare', '........X.......|............X...'),
        L('hihat', '...x..x..x..x..x..x..xxx', '16t'),
        L('openhat', '..x.......x.....'),
      ] },
    ],
    bass: [
      { hits: 'x...............|x.......x.......', slides: true, src: [11, 23] },
      { followKick: true, slides: true, src: [11, 20] },
      { hits: 'x.......x.......', slides: true, src: [20, 23] },
    ],
    src: [11, 22, 23, 24],
  },
  {
    id: 'boombap', name: 'Boom bap', emoji: '🎤', hint: 'swing MPC, snare sur 2 et 4, accords jazz',
    bpm: 90, bpmRange: [85, 95], halfTime: false, scale: 'MAJOR', defaultRoot: 0, swing: 0.3,
    kitStyles: ['boombap'], fallbackKit: 'boombap', instruments: ['rhodes', 'piano'],
    comp: ['x-------x-------', 'x-----x---x-----'],
    drums: [
      { name: 'kick 1, 7, 11, snare sur 2 et 4', bars: 2, swing: 0.3, src: [27], lines: [
        L('kick', 'x.o...x...x.....|x.....x...x.....'),
        L('snare', '....X.......X...'),
        L('hihat', 'x.x.x.xox.x.x.x.'),
      ] },
      { name: 'ghost notes, open hat coupé', bars: 1, swing: 0.3, src: [29], lines: [
        L('kick', 'xo....x..o....o.'),
        L('snare', '...oX......oX...'),
        L('hihat', 'x.x.x.x.x.x.x...'),
        L('openhat', '..............x.'),
      ] },
      { name: '90s : hats en doubles, cowbell, open hat', bars: 2, swing: 0.4, src: [25, 30], lines: [
        L('kick', 'x.......x.......'),
        L('snare', '....X.......X...'),
        L('hihat', 'xoxoxoxoxoxoxoxo|xoxoxoxoxoxo.oxo'),
        L('perc', '................|x...............'),
        L('openhat', '................|............x...'),
      ] },
    ],
    bass: [
      { hits: 'x.......x.......', src: [27, 29] },
      { hits: 'x.....x.........', src: [28, 29] },
      { hits: 'x.......x...x...', src: [27, 29] },
    ],
    src: [25, 26, 27, 28, 29, 30],
  },
  {
    id: 'rnb', name: 'R&B', emoji: '🎶', hint: 'lent, rim sur 2 et 4, accords de 7e',
    bpm: 75, bpmRange: [68, 90], halfTime: false, scale: 'MAJOR', defaultRoot: 0, swing: 0.4,
    kitStyles: ['pop', ''], fallbackKit: 'rnb', instruments: ['rhodes', 'pad'],
    comp: ['x---------------', 'x-----x-------x-'],
    drums: [
      { name: 'kick 1 et « et » du 2, rim, hats doux', bars: 2, swing: 0.4, src: [33], lines: [
        L('kick', 'x.....x.........|x.....x.......x.'),
        L('rim', '...oX.......X...'),
        L('hihat', 'xoxoxoxoxoxoxoxo'),
        L('openhat', '..............x.'),
      ] },
      { name: 'kick 1 et 3, rim + snap, shaker', bars: 1, swing: 0.3, src: [34], lines: [
        L('kick', 'x.......x.....o.'),
        L('rim', '....x.......x...'),
        L('clap', '....x.......x...'),
        L('hihat', 'xoxoxoxoxoxoxoxo'),
        L('openhat', '......x.........'),
        L('shaker', 'oooooooooooooooo'),
      ] },
      { name: 'slow jam : hats en croches, shaker', bars: 2, swing: 0.4, src: [33, 34], lines: [
        L('kick', 'x.......x.......|x.....x.......o.'),
        L('rim', '....x.......x...'),
        L('hihat', 'x.x.x.x.x.x.x.x.'),
        L('shaker', 'o.o.o.o.o.o.o.o.'),
      ] },
    ],
    bass: [
      { hits: 'x...............', src: [34] },
      { hits: 'x.....x.........', src: [31, 34] },
      { followKick: true, src: [31] },
    ],
    src: [31, 32, 33, 34, 35],
  },
  {
    id: 'afro', name: 'Afro', emoji: '🌍', hint: 'rythme 3-3-2, rim, shaker, majeur',
    bpm: 106, bpmRange: [95, 115], halfTime: false, scale: 'MAJOR', defaultRoot: 7, swing: 0.24,
    kitStyles: ['afro'], fallbackKit: 'afro', instruments: ['guitare', 'rhodes'],
    comp: ['x--x--x-x--x--x-', '..x-..x-..x-..x-'],
    drums: [
      { name: 'base afrobeats : kick 1-7-13, rim 4 et 11', bars: 1, swing: 0.24, src: [38, 40], lines: [
        L('kick', 'x.....x.....x...'),
        L('rim', '...x......x.....'),
        L('shaker', 'xoxoxoxoxoxoxoxo'),
        L('openhat', '..x...x...x...x.'),
      ] },
      { name: 'tresillo au kick, au clap et aux hats', bars: 1, swing: 0.24, src: [39, 44], lines: [
        L('kick', 'x..x....x.x.....'),
        L('clap', '...x..x......x..'),
        L('hihat', 'x..x..x3x..x..x.'),
      ] },
      { name: 'kick 1-7-9, shaker cyclique, congas', bars: 2, swing: 0.24, src: [38], lines: [
        L('kick', 'x.....x.o.......|x.....x.o.....x.'),
        L('clap', '....x.......x...|....x.......xo..'),
        L('hihat', 'x.o.x.o.x.o.x.o.'),
        L('openhat', '......x.........'),
        L('shaker', 'xoXoxoXoxoXoxoXo'),
        L('perc', '....x...x.......'),
      ] },
    ],
    bass: [
      { followKick: true, src: [36] },
      { hits: 'x.......x.......', src: [38] },
      { followKick: true, src: [36, 38] },
    ],
    src: [36, 37, 38, 39, 40, 41, 43, 44, 45, 46],
  },
];

const P = (id: string, genre: BeatGenreId, name: string, roman: string, scale: BeatScale, chords: [number, ChordQuality, number][], src: number[]): ProgressionDef =>
  ({ id, genre, name, roman, scale, chords: chords.map(([off, q, beats]) => ({ off, q, beats })), src });

/** Suites d'accords classiques : décalage en demi-tons depuis la tonique, qualité, durée en temps. */
export const PROGRESSIONS: ProgressionDef[] = [
  // Trap : mineur naturel.
  P('trap-maskoff', 'trap', 'façon « Mask Off »', 'i – VI – v – i', 'MINOR', [[0, 'min', 4], [8, 'maj', 4], [7, 'min', 4], [0, 'min', 4]], [9, 10]),
  P('trap-melo', 'trap', 'trap mélodique', 'i – III – VI – VII', 'MINOR', [[0, 'min', 4], [3, 'maj', 4], [8, 'maj', 4], [10, 'maj', 4]], [10]),
  P('trap-classic', 'trap', 'trap classique', 'i – VI – VII', 'MINOR', [[0, 'min', 8], [8, 'maj', 4], [10, 'maj', 4]], [7]),
  P('trap-ivv', 'trap', 'sombre', 'i – v – iv', 'MINOR', [[0, 'min', 8], [7, 'min', 4], [5, 'min', 4]], [9]),
  // Drill UK : mineur, phrygien (seconde abaissée).
  P('drilluk-ivVI', 'drill-uk', 'drill UK', 'i – v – VI', 'MINOR', [[0, 'min', 8], [7, 'min', 4], [8, 'maj', 4]], [20]),
  P('drilluk-iVIIVI', 'drill-uk', 'descente', 'i – VII – VI', 'MINOR', [[0, 'min', 8], [10, 'maj', 4], [8, 'maj', 4]], [20, 21]),
  P('drilluk-phryg', 'drill-uk', 'phrygien', 'i – II♭ – i', 'PHRYGIAN', [[0, 'min', 8], [1, 'maj', 4], [0, 'min', 4]], [16, 17, 20]),
  P('drilluk-ivVIIIII', 'drill-uk', 'quatre accords', 'i – iv – VII – III', 'MINOR', [[0, 'min', 4], [5, 'min', 4], [10, 'maj', 4], [3, 'maj', 4]], [20]),
  // Drill FR : mêmes règles que la drill UK (aucune suite propre à la France n'est publiée).
  P('drillfr-iVI', 'drill-fr', 'deux accords', 'i – VI', 'MINOR', [[0, 'min', 8], [8, 'maj', 8]], [21]),
  P('drillfr-iiv', 'drill-fr', 'mineur sombre', 'i – iv', 'MINOR', [[0, 'min', 8], [5, 'min', 8]], [21]),
  P('drillfr-ivivii', 'drill-fr', 'quatre accords', 'i – v – iv – VII', 'MINOR', [[0, 'min', 4], [7, 'min', 4], [5, 'min', 4], [10, 'maj', 4]], [20]),
  P('drillfr-harm', 'drill-fr', 'mineur harmonique', 'i – vii° – VI', 'MINOR_HARMONIC', [[0, 'min', 8], [11, 'dim', 4], [8, 'maj', 4]], [15, 21]),
  // Boom bap : harmonie jazz / soul des samples.
  P('boombap-251', 'boombap', 'jazz', 'ii7 – V7 – Imaj7', 'MAJOR', [[2, 'min7', 4], [7, '7', 4], [0, 'maj7', 8]], [10]),
  P('boombap-251m', 'boombap', 'jazz mineur', 'ii° – V7 – i', 'MINOR_HARMONIC', [[2, 'dim', 4], [7, '7', 4], [0, 'min', 8]], [10]),
  P('boombap-soul', 'boombap', 'soul', 'i7 – iv7 – v7', 'MINOR', [[0, 'min7', 8], [5, 'min7', 4], [7, 'min7', 4]], [32]),
  // R&B : accords de 7e.
  P('rnb-1625', 'rnb', 'R&B classique', 'Imaj7 – vi7 – ii7 – V7', 'MAJOR', [[0, 'maj7', 4], [9, 'min7', 4], [2, 'min7', 4], [7, '7', 4]], [32, 33]),
  P('rnb-neosoul', 'rnb', 'néo-soul', 'IVmaj7 – iii7 – ii7', 'MAJOR', [[5, 'maj7', 4], [4, 'min7', 4], [2, 'min7', 8]], [32]),
  P('rnb-6415', 'rnb', 'R&B moderne', 'vi7 – IVmaj7 – Imaj7 – V7', 'MAJOR', [[9, 'min7', 4], [5, 'maj7', 4], [0, 'maj7', 4], [7, '7', 4]], [33]),
  P('rnb-minor', 'rnb', 'R&B mineur', 'i7 – iv7 – v7', 'MINOR', [[0, 'min7', 8], [5, 'min7', 4], [7, 'min7', 4]], [32]),
  // Afro : majeur.
  P('afro-145', 'afro', 'highlife', 'I – IV – V – IV', 'MAJOR', [[0, 'maj', 4], [5, 'maj', 4], [7, 'maj', 4], [5, 'maj', 4]], [40]),
  P('afro-1564', 'afro', 'afropop', 'I – V – vi – IV', 'MAJOR', [[0, 'maj', 4], [7, 'maj', 4], [9, 'min', 4], [5, 'maj', 4]], [36]),
  P('afro-1465', 'afro', 'afrobeats', 'I – IV – vi – V', 'MAJOR', [[0, 'maj', 4], [5, 'maj', 4], [9, 'min', 4], [7, 'maj', 4]], [40]),
  P('afro-1254', 'afro', 'afro doux', 'I – ii – V – IV', 'MAJOR', [[0, 'maj', 4], [2, 'min', 4], [7, 'maj', 4], [5, 'maj', 4]], [40]),
];

export const genreRecipe = (id: string | null | undefined): GenreRecipe => BEAT_GENRES.find(g => g.id === id) || BEAT_GENRES[0];

/** Genre reconnu dans une phrase (« un beat drill fr », « afrobeat », « boom bap »…). */
export function genreFromText(t: string): BeatGenreId | null {
  const s = t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/drill\s*(fr|francaise?|france|gazo)/.test(s)) return 'drill-fr';
  if (/drill/.test(s)) return 'drill-uk';
  if (/boom\s*-?\s*bap|old\s*school|90s|jazz/.test(s)) return 'boombap';
  if (/\br\s*&?\s*n?\s*b\b|rnb|soul/.test(s)) return 'rnb';
  if (/afro|amapiano|naija/.test(s)) return 'afro';
  if (/trap|plugg|rage/.test(s)) return 'trap';
  return null;
}
