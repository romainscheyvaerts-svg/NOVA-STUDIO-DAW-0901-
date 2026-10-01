import { PluginType } from '../types';

/**
 * Styles de mix voix « en un clic ».
 *
 * Chaque style remplace la chaîne d'effets des pistes voix, règle les envois
 * vers les retours (délai, réverb courte, réverb longue) et l'équilibre
 * voix / beat. Tout passe par l'historique : Annuler revient au mix précédent.
 *
 * Ordre de la chaîne : nettoyage → justesse → couleur → niveau → sifflantes
 * → caractère → largeur (DENOISER → AUTOTUNE → PROEQ12 → COMPRESSOR →
 * DEESSER → VOCALSATURATOR → DOUBLER).
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

/** Bandes de l'égaliseur 12 bandes : coupe-bas, corrections, coupe-haut. */
interface EqShape {
  highpass: number;
  lowpass?: number;
  /** Correction des bas-médiums (boue) : fréquence et gain (dB). */
  mud?: [number, number];
  /** Présence (intelligibilité). */
  presence?: [number, number];
  /** Air (brillance), en plateau aigu. */
  air?: [number, number];
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
  if (s.mud) Object.assign(bands[2], { frequency: s.mud[0], gain: s.mud[1], q: 1.2, isEnabled: true });
  if (s.presence) Object.assign(bands[6], { frequency: s.presence[0], gain: s.presence[1], q: 0.9, isEnabled: true });
  if (s.air) Object.assign(bands[10], { type: 'highshelf', frequency: s.air[0], gain: s.air[1], q: 0.71, isEnabled: true });
  return { type: 'PROEQ12', params: { masterGain: 1.0, bands } };
};

const dbToGain = (db: number) => Math.pow(10, db / 20);

const denoise: VocalChainItem = {
  type: 'DENOISER',
  // Porte douce : baisse le souffle de la pièce entre les phrases sans couper les fins de mots.
  params: { threshold: -50, range: -18, attack: 0.005, hold: 0.08, release: 0.2, scFreq: 1000, flip: false },
};

const deess = (threshold = -28, reduction = 0.5): VocalChainItem => ({
  type: 'DEESSER',
  params: { threshold, frequency: 6500, q: 1.0, reduction, mode: 'BELL' },
});

export const VOCAL_MIX_STYLES: VocalMixStyle[] = [
  {
    id: 'rap-clair',
    name: 'Rap clair',
    emoji: '🎙️',
    description: 'Voix devant, nette et compréhensible. Idéal pour du rap old school, boom bap ou conscient.',
    chain: [
      denoise,
      eq({ highpass: 100, mud: [300, -3], presence: [3000, 3], air: [10000, 2] }),
      { type: 'COMPRESSOR', params: { threshold: -20, ratio: 4, knee: 8, attack: 0.005, release: 0.12, makeupGain: dbToGain(4), autoMakeup: false, mix: 1, scHpFreq: 120, mode: 'VCA' } },
      deess(),
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
    chain: [
      denoise,
      { type: 'AUTOTUNE', params: { speed: 0, humanize: 0, mix: 1 } },
      eq({ highpass: 120, mud: [350, -3], presence: [4000, 4], air: [12000, 3] }),
      { type: 'COMPRESSOR', params: { threshold: -22, ratio: 6, knee: 6, attack: 0.002, release: 0.08, makeupGain: dbToGain(5), autoMakeup: false, mix: 1, scHpFreq: 150, mode: 'FET' } },
      deess(-30, 0.6),
      { type: 'VOCALSATURATOR', params: { drive: 15, mix: 0.3, tone: 0.2, eqLow: 0, eqMid: 0, eqHigh: 1, mode: 'TAPE', outputGain: 1.0 } },
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
    chain: [
      denoise,
      { type: 'AUTOTUNE', params: { speed: 0.2, humanize: 0.2, mix: 0.7 } },
      eq({ highpass: 110, mud: [400, -2], presence: [2500, 3], air: [10000, 1] }),
      { type: 'COMPRESSOR', params: { threshold: -24, ratio: 8, knee: 4, attack: 0.002, release: 0.07, makeupGain: dbToGain(6), autoMakeup: false, mix: 1, scHpFreq: 150, mode: 'FET' } },
      deess(-30, 0.5),
      { type: 'VOCALSATURATOR', params: { drive: 25, mix: 0.35, tone: -0.1, eqLow: 0, eqMid: 1, eqHigh: 0, mode: 'TRANSISTOR', outputGain: 0.9 } },
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
    chain: [
      denoise,
      { type: 'AUTOTUNE', params: { speed: 0.45, humanize: 0.4, mix: 1 } },
      eq({ highpass: 90, mud: [250, -2], presence: [3000, 2], air: [12000, 3] }),
      { type: 'COMPRESSOR', params: { threshold: -20, ratio: 3, knee: 12, attack: 0.01, release: 0.3, makeupGain: dbToGain(3), autoMakeup: false, mix: 1, scHpFreq: 100, mode: 'OPTO' } },
      deess(-28, 0.55),
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
    chain: [
      eq({ highpass: 500, lowpass: 3500, presence: [1500, 6] }),
      { type: 'COMPRESSOR', params: { threshold: -24, ratio: 6, knee: 6, attack: 0.003, release: 0.1, makeupGain: dbToGain(6), autoMakeup: false, mix: 1, scHpFreq: 300, mode: 'FET' } },
      { type: 'VOCALSATURATOR', params: { drive: 40, mix: 0.7, tone: 0.3, eqLow: -6, eqMid: 3, eqHigh: -3, mode: 'TRANSISTOR', outputGain: 0.8 } },
    ],
    sends: { delay: 0.1, verbShort: 0.05, verbLong: 0 },
    voiceVolume: 1.0,
    beatVolume: 0.6,
  },
];

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
