import { PluginType } from '../types';

/**
 * Styles de mix voix « en un clic ».
 *
 * Chaque style remplace la chaîne d'effets des pistes voix, règle les envois
 * vers les retours (délai, réverb courte, réverb longue) et l'équilibre
 * voix / beat. Tout passe par l'historique : Annuler revient au mix précédent.
 *
 * Ordre de la chaîne : nettoyage → justesse → couleur → niveau (compression
 * en série : rapide puis lente) → sifflantes → caractère → largeur
 * (DENOISER → AUTOTUNE → PROEQ12 → COMPRESSOR FET → COMPRESSOR OPTO →
 * DEESSER → VOCALSATURATOR → DOUBLER). Le de-esser vient APRÈS l'égaliseur :
 * il rattrape les « s » que l'air (+4 dB à 12 kHz, +4 dB au-dessus de 15 kHz)
 * ferait ressortir.
 *
 * Niveaux : chaque style est calibré hors ligne (signal voix de test : voyelles
 * à formants, consonnes, phrases et silences, crête -6 dBFS, souffle de pièce)
 * pour sortir au même niveau intégré (LUFS) que la voix brute, à ±1 dB
 * (« Effet téléphone » : -1 dB environ). Passer d'un style à l'autre change le
 * son, pas le volume. Les compresseurs n'ont plus de gain caché : makeupGain
 * est le vrai gain de compensation.
 *
 * Toute la chaîne est sans latence, sauf l'AutoTune (~27 ms en lecture,
 * compensés par le moteur ; ~4 ms en mode basse latence pendant la prise).
 */

export interface VocalChainItem {
  type: PluginType;
  params: Record<string, any>;
}

export interface VocalMixStyle {
  id: string;
  name: string;
  emoji: string;
  /** Une phrase pour l'artiste : à quoi ça sonne, pour quel morceau. */
  description: string;
  chain: VocalChainItem[];
  /** Niveaux d'envoi (0-1) vers les retours du projet. */
  sends: { delay: number; verbShort: number; verbLong: number };
  /** Volume des pistes voix et du beat (0-1, fader linéaire). */
  voiceVolume: number;
  beatVolume: number;
}

/**
 * Bandes de l'égaliseur 12 bandes :
 *  0 coupe-bas · 1 corps · 2 boue · 3 carton · 6 présence · 9 cloche 12 kHz
 *  · 10 étagère 15 kHz · 11 coupe-haut (les autres restent libres, neutres).
 */
interface EqShape {
  highpass: number;
  lowpass?: number;
  /** Corps / chaleur (cloche large), fréquence et gain (dB). */
  body?: [number, number];
  /** Correction des bas-médiums (boue). */
  mud?: [number, number];
  /** Son « carton » / nasal (cloche étroite). */
  boxy?: [number, number];
  /** Présence (intelligibilité). */
  presence?: [number, number];
  /**
   * Air obligatoire sur tous les styles (choix du studio) : cloche +4 dB à
   * 12 kHz (Q 0,8) ET étagère +4 dB à 15 kHz. false uniquement pour un son
   * volontairement filtré (téléphone).
   */
  air?: boolean;
}

const eq = (s: EqShape): VocalChainItem => {
  const freqs = [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000];
  const bands = freqs.map((frequency, id) => ({
    id,
    type: (id === 0 ? 'highpass' : id === 11 ? 'lowpass' : 'peaking') as string,
    frequency,
    gain: 0,
    q: id === 0 || id === 11 ? 0.71 : 1.0,
    isEnabled: id === 0 || id === 11,
    isSolo: false,
  }));
  bands[0].frequency = s.highpass;
  bands[11].frequency = s.lowpass ?? 18000;
  bands[11].isEnabled = s.lowpass !== undefined;
  if (s.body) Object.assign(bands[1], { frequency: s.body[0], gain: s.body[1], q: 0.8, isEnabled: true });
  if (s.mud) Object.assign(bands[2], { frequency: s.mud[0], gain: s.mud[1], q: 1.2, isEnabled: true });
  if (s.boxy) Object.assign(bands[3], { frequency: s.boxy[0], gain: s.boxy[1], q: 2.5, isEnabled: true });
  if (s.presence) Object.assign(bands[6], { frequency: s.presence[0], gain: s.presence[1], q: 0.9, isEnabled: true });
  if (s.air !== false) {
    Object.assign(bands[9], { type: 'peaking', frequency: 12000, gain: 4, q: 0.8, isEnabled: true });
    Object.assign(bands[10], { type: 'highshelf', frequency: 15000, gain: 4, q: 0.71, isEnabled: true });
  }
  return { type: 'PROEQ12', params: { masterGain: 1.0, bands } };
};

const dbToGain = (db: number) => Math.pow(10, db / 20);

/**
 * Nettoyage adaptatif : le seuil se cale tout seul 9 dB au-dessus du bruit
 * de la pièce appris pendant les silences (jamais sous -60 dB, jamais au-dessus
 * de -30 dB), coupe-bas 80 Hz (grondements, manipulation du téléphone) et
 * filtre de ronflette 50/60 Hz activé seulement si une ronflette est détectée.
 * Mesuré : bruit rose/brun à -45 dBFS + ronflette 50 Hz -> -25 dB entre les
 * phrases, voix forte intacte (-0,6 dB : le bruit retiré), fins de mots
 * préservées (-0,2 dB avec un bruit à -50 dBFS). Atténuation plafonnée à
 * -30 dB : une porte qui se tromperait baisse, elle ne coupe pas.
 */
const denoise: VocalChainItem = {
  type: 'DENOISER',
  params: {
    threshold: -60, range: -30, attack: 0.002, hold: 0.08, release: 0.08, scFreq: 250, flip: false,
    autoThreshold: true, lowCut: 80, humFilter: true,
  },
};

/**
 * De-esser en cloche après l'égaliseur, 8 kHz par défaut (règle de Romain),
 * détection relative (la zone des « s » comparée au reste de la voix : ne
 * dépend pas du niveau d'enregistrement). `threshold` (absolu) reste pour les
 * filtres hors voix pleine bande (téléphone : détection absolue).
 */
const deess = (threshold: number, reduction: number, frequency = 8000, q = 1.0, detection: 'RELATIVE' | 'ABSOLUTE' = 'RELATIVE'): VocalChainItem => ({
  type: 'DEESSER',
  params: { threshold, frequency, q, reduction, mode: 'BELL', detection, relThreshold: threshold <= -42 ? -7 : -6, listen: 0 },
});

/** Compresseur rapide « 1176 » : attrape les crêtes (2-4 dB). */
const fetComp = (threshold: number, ratio: number, makeupDb: number, attack = 0.002, release = 0.08): VocalChainItem => ({
  type: 'COMPRESSOR',
  params: { threshold, ratio, knee: 4, attack, release, makeupGain: dbToGain(makeupDb), autoMakeup: false, mix: 1, scHpFreq: 150, lookahead: 0, mode: 'FET' },
});

/** Compresseur lent « LA-2A » : nivelle les phrases, release dépendant du programme. */
const optoComp = (threshold: number, ratio: number, makeupDb: number, release = 0.25): VocalChainItem => ({
  type: 'COMPRESSOR',
  params: { threshold, ratio, knee: 10, attack: 0.01, release, makeupGain: dbToGain(makeupDb), autoMakeup: false, mix: 1, scHpFreq: 100, lookahead: 0, mode: 'OPTO' },
});

export const VOCAL_MIX_STYLES: VocalMixStyle[] = [
  {
    id: 'rap-clair',
    name: 'Rap clair',
    emoji: '🎙️',
    description: 'Voix devant, nette et compréhensible. Idéal pour du rap old school, boom bap ou conscient.',
    // Source : chaîne courte EQ + compression + de-esser (Alex Tumay, ingé de Young Thug, interview Red Bull Music Academy 2017)
    // et compression en série 1176 puis LA-2A (Universal Audio, « UAD Spotlight: UA 1176 & Teletronix LA-2A »).
    chain: [
      denoise,
      eq({ highpass: 100, mud: [300, -3], boxy: [700, -1.5], presence: [3000, 2.5] }),
      fetComp(-16, 4, 0),
      optoComp(-22, 3, 5),
      deess(-40, 0.5),
    ],
    sends: { delay: 0.06, verbShort: 0.1, verbLong: 0 },
    voiceVolume: 1.0,
    beatVolume: 0.6,
  },
  {
    id: 'trap-autotune',
    name: 'Trap autotune',
    emoji: '🤖',
    description: 'Autotune serré (effet robot), voix brillante et compressée, délai et réverb marqués.',
    // Source : Antares, « How to build a professional rap and R&B vocal chain » : retune 0-10 ms, tuning en tête,
    // EQ 150-250 Hz / 2-5 kHz / air > 12 kHz, plusieurs compresseurs, de-esser, saturation légère, doubleur discret.
    chain: [
      denoise,
      { type: 'AUTOTUNE', params: { speed: 0, humanize: 0, mix: 1 } },
      eq({ highpass: 120, mud: [250, -3], boxy: [600, -1.5], presence: [4000, 3] }),
      fetComp(-17, 6, 0, 0.001, 0.06),
      optoComp(-22, 3, 4.8),
      deess(-41, 0.6),
      { type: 'VOCALSATURATOR', params: { drive: 15, mix: 0.3, tone: 0.1, eqLow: 0, eqMid: 0, eqHigh: 0, mode: 'TAPE', outputGain: 1.0 } },
      { type: 'DOUBLER', params: { detune: 0.25, width: 0.5, gainL: 0.2, gainR: 0.2, directOn: true } },
    ],
    sends: { delay: 0.15, verbShort: 0.18, verbLong: 0.05 },
    voiceVolume: 1.0,
    beatVolume: 0.6,
  },
  {
    id: 'drill',
    name: 'Drill',
    emoji: '🔪',
    description: 'Voix sombre et agressive, un peu saturée, autotune discret. Pour drill UK / FR.',
    // Source : Sound On Sound « Inside Track: Central Cee » (Sean Donoghue) : accordage rare et discret en drill ;
    // usage courant du genre : voix sèche et devant, compression en plusieurs étages, saturation granuleuse.
    chain: [
      denoise,
      { type: 'AUTOTUNE', params: { speed: 0.25, humanize: 0.3, mix: 0.5 } },
      eq({ highpass: 110, body: [200, 1.5], mud: [450, -2], presence: [2500, 3] }),
      fetComp(-15, 8, 0, 0.001, 0.05),
      optoComp(-22, 3, 3.3),
      deess(-40, 0.5),
      { type: 'VOCALSATURATOR', params: { drive: 30, mix: 0.35, tone: -0.15, eqLow: 0, eqMid: 1.5, eqHigh: -1, mode: 'TRANSISTOR', outputGain: 1.0 } },
    ],
    sends: { delay: 0.12, verbShort: 0.08, verbLong: 0 },
    voiceVolume: 1.0,
    beatVolume: 0.62,
  },
  {
    id: 'chant-rnb',
    name: 'Chant / R&B',
    emoji: '🎶',
    description: 'Justesse naturelle, voix douce et large, réverb aérée. Pour les refrains chantés et le R&B.',
    // Source : Antares (même guide) : retune 15-50 ms + Humanize pour le R&B, second compresseur plus léger,
    // doubleur pour l'épaisseur des refrains ; de-essing ciblé façon Manny Marroquin (dbx 902, cf. Waves).
    chain: [
      denoise,
      { type: 'AUTOTUNE', params: { speed: 0.35, humanize: 0.45, mix: 1 } },
      eq({ highpass: 90, body: [180, 1], mud: [280, -2], presence: [3000, 2] }),
      fetComp(-12, 4, 0, 0.003, 0.1),
      optoComp(-18, 2.5, 0.5, 0.3),
      deess(-41, 0.5),
      { type: 'DOUBLER', params: { detune: 0.3, width: 0.6, gainL: 0.35, gainR: 0.35, directOn: true } },
    ],
    sends: { delay: 0.12, verbShort: 0.15, verbLong: 0.2 },
    voiceVolume: 1.0,
    beatVolume: 0.55,
  },
  {
    id: 'voix-brute',
    name: 'Voix brute',
    emoji: '🎤',
    description: 'Aucun effet : ta voix telle quelle sur le beat, pour juger ta prise.',
    chain: [],
    sends: { delay: 0, verbShort: 0, verbLong: 0 },
    voiceVolume: 1.0,
    beatVolume: 0.7,
  },
  {
    id: 'telephone',
    name: 'Effet téléphone',
    emoji: '📞',
    description: 'Voix filtrée façon téléphone / radio. Parfait pour une intro, un pont ou une ad-lib.',
    // Effet classique de « voix téléphone » : bande passante 500 Hz-3,5 kHz, compression forte, saturation.
    // Pas d'air ici (il contredirait le filtrage) ; de-esser dans la bande utile (~3,2 kHz).
    chain: [
      denoise,
      eq({ highpass: 500, lowpass: 3500, presence: [1500, 6], air: false }),
      { type: 'COMPRESSOR', params: { threshold: -20, ratio: 6, knee: 6, attack: 0.003, release: 0.1, makeupGain: dbToGain(5.5), autoMakeup: false, mix: 1, scHpFreq: 300, lookahead: 0, mode: 'FET' } },
      deess(-42, 0.4, 3200, 1.0, 'ABSOLUTE'),
      { type: 'VOCALSATURATOR', params: { drive: 40, mix: 0.7, tone: 0.15, eqLow: -6, eqMid: 3, eqHigh: -6, mode: 'TRANSISTOR', outputGain: 1.0 } },
    ],
    sends: { delay: 0.1, verbShort: 0.05, verbLong: 0 },
    voiceVolume: 1.0,
    beatVolume: 0.6,
  },
];

/**
 * Style proposé d'office après la première prise, d'après le beat : la première
 * réécoute doit déjà sonner « produite », c'est elle qui donne envie.
 */
export function suggestVocalMixStyle(bpm: number, genre?: string | null, title?: string | null): string {
  const g = `${genre || ''} ${title || ''}`.toLowerCase();
  if (/drill/.test(g)) return 'drill';
  if (/r ?&? ?b|rnb|soul|love|chant|afro|zouk|pop|ballad/.test(g)) return 'chant-rnb';
  if (/boom ?bap|old ?school|lofi|lo-fi|jazz/.test(g)) return 'rap-clair';
  if (/trap|cloud|rage|plugg/.test(g) || bpm >= 125) return 'trap-autotune';
  return 'rap-clair';
}

export const findVocalMixStyle = (idOrName?: string | null): VocalMixStyle | undefined => {
  if (!idOrName) return undefined;
  const q = String(idOrName).trim().toLowerCase();
  const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
  return (
    VOCAL_MIX_STYLES.find(s => s.id === q) ||
    VOCAL_MIX_STYLES.find(s => norm(s.name) === norm(q)) ||
    VOCAL_MIX_STYLES.find(s => norm(s.name).includes(norm(q)) || norm(q).includes(norm(s.id)))
  );
};
