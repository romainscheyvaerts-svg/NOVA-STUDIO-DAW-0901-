/**
 * Banque de sons du synthé NOVA, pensée pour le rap, la trap et le R&B.
 * Chaque préréglage ne décrit que ce qui change par rapport à defaultSynth() ;
 * presetSettings() renvoie des réglages complets et bornés (normalizeSynth).
 * Pas de 808 ici : elle a son propre moteur (Bass808Node).
 */
import { NovaSynthSettings, SynthOsc, OscWave, defaultSynth, defaultOsc, normalizeSynth } from './novaSynth';

export const PRESET_CATEGORIES = [
  'Pianos & Rhodes', 'Nappes', 'Plucks', 'Leads', 'Cloches & mallets', 'Cordes',
  'Flûtes & vents', 'Chœurs', 'Basses', 'Arpèges', 'Basiques',
] as const;
export type PresetCategory = typeof PRESET_CATEGORIES[number];

type Deep<T> = { [K in keyof T]?: T[K] extends object ? Deep<T[K]> : T[K] };
type Over = Omit<Deep<NovaSynthSettings>, 'osc'> & { osc?: SynthOsc[] };

export interface SynthPreset {
  id: string;
  name: string;
  cat: PresetCategory;
  /** Usage typique, affiché au survol. */
  tip: string;
  over: Over;
}

const O = (wave: OscWave, over: Partial<SynthOsc> = {}): SynthOsc => defaultOsc({ on: true, wave, level: 0.8, ...over });
/** Trois oscillateurs (les absents sont coupés). */
const osc = (...list: SynthOsc[]): SynthOsc[] => [0, 1, 2].map(i => list[i] ?? defaultOsc());
const env = (a: number, d: number, s: number, r: number) => ({ a, d, s, r });

const P = (id: string, name: string, cat: PresetCategory, tip: string, over: Over): SynthPreset => ({ id, name, cat, tip, over });

export const SYNTH_PRESETS: SynthPreset[] = [
  // --- Pianos & Rhodes
  P('rhodes-soul', 'Rhodes soul', 'Pianos & Rhodes', 'Accords R&B et neo-soul, trémolo et chorus comme un vrai Rhodes', {
    osc: osc(O('sine', { level: 0.9 }), O('triangle', { octave: 1, level: 0.22 }), O('sine', { octave: 2, level: 0.06, fine: 4 })),
    filter: { cutoff: 3200, keytrack: 0.5, envAmount: 1, velAmount: 1.5 }, ampEnv: env(0.003, 1.6, 0.25, 0.5), filterEnv: env(0.003, 0.6, 0.2, 0.4),
    lfo: { dest: 'amp', rate: 4.5, amount: 0.22, wave: 'sine' }, fx: { chorus: { mix: 0.35 } }, velToAmp: 0.8, level: 0.8,
  }),
  P('rhodes-lofi', 'Rhodes lo-fi', 'Pianos & Rhodes', 'Rhodes feutré qui « pleure » un peu, pour les prods chill et lo-fi', {
    osc: osc(O('sine', { level: 0.9 }), O('triangle', { octave: 1, level: 0.18 })), noise: { level: 0.03 },
    filter: { cutoff: 1500, keytrack: 0.4, envAmount: 0.8 }, ampEnv: env(0.004, 1.4, 0.3, 0.45), filterEnv: env(0.004, 0.5, 0.2, 0.4),
    lfo: { dest: 'pitch', rate: 0.6, amount: 0.05, wave: 'sine' }, fx: { chorus: { mix: 0.5, depth: 0.7 } }, velToAmp: 0.7, level: 0.85,
  }),
  P('piano-wurli', 'Piano électrique (Wurli)', 'Pianos & Rhodes', 'Plus nasillard que le Rhodes, parfait pour des accords soul', {
    osc: osc(O('triangle', { level: 0.9 }), O('square', { octave: 1, level: 0.12 })),
    filter: { cutoff: 2400, keytrack: 0.5, envAmount: 1.5, velAmount: 1.5 }, ampEnv: env(0.003, 1.2, 0.2, 0.35), filterEnv: env(0.003, 0.35, 0.15, 0.3),
    lfo: { dest: 'amp', rate: 5.5, amount: 0.15, wave: 'sine' }, velToAmp: 0.8, level: 0.75,
  }),
  P('piano-doux', 'Piano doux', 'Pianos & Rhodes', 'Piano synthétique tendre pour les intros et les ballades', {
    osc: osc(O('triangle', { level: 0.9 }), O('sine', { octave: 1, level: 0.3 }), O('sawtooth', { level: 0.12, fine: 5 })),
    filter: { cutoff: 1600, keytrack: 0.7, envAmount: 2, velAmount: 2 }, ampEnv: env(0.002, 2.5, 0, 0.6), filterEnv: env(0.002, 0.5, 0, 0.5),
    velToAmp: 0.9, level: 0.85,
  }),
  P('keys-rnb', 'Keys R&B', 'Pianos & Rhodes', 'Clavier chorusé des années 2000, accords de R&B', {
    osc: osc(O('sawtooth', { level: 0.45 }), O('sine', { level: 0.85 })),
    filter: { cutoff: 1100, keytrack: 0.4, envAmount: 2.2 }, ampEnv: env(0.004, 1.2, 0.4, 0.4), filterEnv: env(0.004, 0.4, 0.15, 0.4),
    fx: { chorus: { mix: 0.6 } }, velToAmp: 0.7, level: 0.75,
  }),
  P('orgue-gospel', 'Orgue gospel', 'Pianos & Rhodes', 'Orgue à tirettes avec effet Leslie, pour le gospel et la soul', {
    osc: osc(O('sine', { level: 0.8 }), O('sine', { octave: 1, level: 0.55 }), O('sine', { octave: 1, semi: 7, level: 0.3 })),
    filter: { cutoff: 6000, keytrack: 0, envAmount: 0, velAmount: 0 }, ampEnv: env(0.005, 0.1, 1, 0.08),
    lfo: { dest: 'amp', rate: 6.5, amount: 0.18, wave: 'sine' }, fx: { chorus: { mix: 0.3, rate: 5, depth: 0.3 } }, velToAmp: 0.2, level: 0.6,
  }),

  // --- Nappes
  P('nappe-chaude', 'Nappe chaude', 'Nappes', 'Tapis d\'accords large et chaud sous un couplet', {
    osc: osc(O('sawtooth', { unison: 5, detune: 25, spread: 0.8 }), O('sawtooth', { octave: -1, unison: 3, detune: 15, spread: 0.5, level: 0.5 })),
    filter: { cutoff: 1300, keytrack: 0.3, envAmount: 0.8, velAmount: 0.5 }, ampEnv: env(0.8, 1, 0.9, 1.8), filterEnv: env(1, 2, 0.5, 1.5),
    fx: { chorus: { mix: 0.4 } }, velToAmp: 0.3, level: 0.75,
  }),
  P('nappe-trap-sombre', 'Nappe trap sombre', 'Nappes', 'Nappe sombre et menaçante, ambiance drill et trap de Memphis', {
    osc: osc(O('sawtooth', { unison: 7, detune: 30, spread: 0.8 }), O('square', { octave: -1, level: 0.4 })),
    filter: { cutoff: 650, reso: 2, steep: true, keytrack: 0.2, envAmount: 0, velAmount: 0.5 }, ampEnv: env(1.2, 1, 1, 2.5),
    lfo: { dest: 'filter', rate: 0.2, amount: 0.15, wave: 'sine' }, fx: { delay: { mix: 0.2, time: 0.5, feedback: 0.4 } }, velToAmp: 0.3, level: 0.85,
  }),
  P('nappe-aerienne', 'Nappe aérienne', 'Nappes', 'Nappe brillante qui flotte au-dessus du beat', {
    osc: osc(O('sawtooth', { unison: 5, detune: 20, spread: 1 }), O('sawtooth', { octave: 1, unison: 3, detune: 15, spread: 1, level: 0.35 })), noise: { level: 0.08 },
    filter: { cutoff: 4000, keytrack: 0.2, envAmount: 0 }, ampEnv: env(1.5, 1, 1, 3),
    fx: { chorus: { mix: 0.5 }, delay: { mix: 0.25, time: 0.5, feedback: 0.4 } }, velToAmp: 0.3, level: 0.6,
  }),
  P('nappe-verre', 'Nappe de verre', 'Nappes', 'Nappe cristalline et douce pour les refrains R&B', {
    osc: osc(O('triangle', { unison: 3, detune: 12, spread: 0.7 }), O('sine', { octave: 1, semi: 7, level: 0.3 })),
    filter: { cutoff: 3000, envAmount: 0 }, ampEnv: env(0.6, 1, 1, 2.5),
    lfo: { dest: 'amp', rate: 0.3, amount: 0.2, wave: 'sine' }, fx: { chorus: { mix: 0.5 } }, velToAmp: 0.3, level: 0.85,
  }),
  P('nappe-rnb-90s', 'Nappe R&B 90s', 'Nappes', 'Nappe carrée et chorusée façon R&B des années 90', {
    osc: osc(O('square', { unison: 3, detune: 10, spread: 0.6, level: 0.7 }), O('sawtooth', { level: 0.5 })),
    filter: { cutoff: 1700, envAmount: 1 }, ampEnv: env(0.3, 1, 0.85, 1.2), filterEnv: env(0.4, 1.5, 0.4, 1),
    fx: { chorus: { mix: 0.7 } }, velToAmp: 0.4, level: 0.7,
  }),
  P('nappe-evolutive', 'Nappe qui évolue', 'Nappes', 'Le filtre s\'ouvre et se referme lentement : idéal sur une intro', {
    osc: osc(O('sawtooth', { unison: 5, detune: 25, spread: 0.8 })),
    filter: { cutoff: 600, reso: 3, envAmount: 0 }, ampEnv: env(1, 1, 1, 2.5),
    lfo: { dest: 'filter', rate: 0.12, amount: 0.35, wave: 'triangle' }, fx: { chorus: { mix: 0.3 } }, velToAmp: 0.3, level: 0.85,
  }),

  // --- Plucks
  P('pluck-trap', 'Pluck trap', 'Plucks', 'Le pluck des mélodies trap, avec un petit écho', {
    osc: osc(O('sawtooth', { unison: 3, detune: 15, spread: 0.6 }), O('square', { octave: 1, level: 0.3 })),
    filter: { cutoff: 600, keytrack: 0.5, envAmount: 4, velAmount: 1 }, ampEnv: env(0.002, 0.45, 0, 0.3), filterEnv: env(0.001, 0.18, 0, 0.2),
    fx: { delay: { mix: 0.2, time: 0.375, feedback: 0.3 } }, velToAmp: 0.6, level: 0.8,
  }),
  P('pluck-doux', 'Pluck doux', 'Plucks', 'Pluck rond pour les mélodies mélancoliques', {
    osc: osc(O('triangle'), O('sine', { octave: 1, level: 0.3 })),
    filter: { cutoff: 900, keytrack: 0.5, envAmount: 3 }, ampEnv: env(0.002, 0.6, 0, 0.4), filterEnv: env(0.001, 0.25, 0, 0.3),
    fx: { chorus: { mix: 0.2 } }, velToAmp: 0.6, level: 0.9,
  }),
  P('pluck-guitare', 'Pluck guitare', 'Plucks', 'Corde pincée façon guitare, pour les boucles mélodiques', {
    osc: osc(O('sawtooth'), O('square', { level: 0.4, fine: 6 })), noise: { level: 0.1 },
    filter: { cutoff: 1200, keytrack: 0.6, envAmount: 3.5, velAmount: 1.5 }, ampEnv: env(0.002, 1.2, 0, 0.25), filterEnv: env(0.001, 0.12, 0.05, 0.2),
    velToAmp: 0.9, level: 0.75,
  }),
  P('kalimba', 'Kalimba', 'Plucks', 'Piano à pouces, très utilisé dans la trap mélodique', {
    osc: osc(O('sine'), O('sine', { octave: 1, semi: 5, level: 0.25 })),
    filter: { cutoff: 5000, envAmount: 0 }, ampEnv: env(0.001, 0.7, 0, 0.5), velToAmp: 0.8, level: 0.9,
  }),
  P('harpe', 'Harpe', 'Plucks', 'Harpe synthétique pour des arpèges délicats', {
    osc: osc(O('triangle'), O('sawtooth', { octave: 1, level: 0.2 })),
    filter: { cutoff: 2000, keytrack: 0.5, envAmount: 2 }, ampEnv: env(0.002, 2, 0, 1.2), filterEnv: env(0.001, 0.3, 0, 0.5),
    fx: { chorus: { mix: 0.2 }, delay: { mix: 0.15, time: 0.375, feedback: 0.3 } }, velToAmp: 0.8, level: 0.85,
  }),

  // --- Leads
  P('lead-trap-glisse', 'Lead trap glissé', 'Leads', 'Mélodie principale mono qui glisse entre les notes', {
    osc: osc(O('sawtooth', { unison: 3, detune: 12, spread: 0.4 }), O('square', { level: 0.4 })),
    filter: { cutoff: 3000, envAmount: 1 }, ampEnv: env(0.005, 0.3, 0.9, 0.15), filterEnv: env(0.005, 0.3, 0.5, 0.2),
    lfo: { dest: 'pitch', rate: 5.5, amount: 0.06, wave: 'sine' }, mono: true, glide: 0.08,
    fx: { delay: { mix: 0.2, time: 0.375, feedback: 0.3 } }, velToAmp: 0.4, level: 0.65,
  }),
  P('lead-sifflet', 'Lead sifflet', 'Leads', 'Sifflement doux avec vibrato, typique des toplines trap', {
    osc: osc(O('sine')), noise: { level: 0.04 },
    filter: { cutoff: 6000, envAmount: 0 }, ampEnv: env(0.04, 0.3, 1, 0.2),
    lfo: { dest: 'pitch', rate: 5.2, amount: 0.12, wave: 'sine' }, mono: true, glide: 0.1,
    fx: { delay: { mix: 0.25, time: 0.375, feedback: 0.35 } }, velToAmp: 0.3, level: 0.75,
  }),
  P('lead-supersaw', 'Lead supersaw', 'Leads', 'Lead énorme et large pour les drops et les refrains', {
    osc: osc(O('sawtooth', { unison: 7, detune: 35, spread: 1 }), O('sawtooth', { octave: -1, unison: 3, detune: 20, spread: 0.6, level: 0.4 })),
    filter: { cutoff: 5000, envAmount: 0 }, ampEnv: env(0.005, 0.3, 1, 0.3),
    fx: { chorus: { mix: 0.3 }, delay: { mix: 0.2, time: 0.375, feedback: 0.3 } }, velToAmp: 0.3, level: 0.55,
  }),
  P('lead-carre-retro', 'Lead carré rétro', 'Leads', 'Lead carré façon jeu vidéo, pour une touche old-school', {
    osc: osc(O('square'), O('square', { octave: 1, level: 0.2, fine: 7 })),
    filter: { cutoff: 2500, envAmount: 1.5 }, ampEnv: env(0.003, 0.2, 0.8, 0.12), filterEnv: env(0.003, 0.2, 0.5, 0.2),
    lfo: { dest: 'pitch', rate: 6, amount: 0.08, wave: 'sine' }, mono: true, glide: 0.04, velToAmp: 0.3, level: 0.55,
  }),
  P('lead-rnb-sinus', 'Lead R&B sinus', 'Leads', 'Lead tout doux qui chante, pour les réponses de mélodie', {
    osc: osc(O('sine'), O('triangle', { octave: 1, level: 0.2 })),
    filter: { cutoff: 4000, envAmount: 0 }, ampEnv: env(0.02, 0.3, 1, 0.3),
    lfo: { dest: 'pitch', rate: 5, amount: 0.1, wave: 'sine' }, mono: true, legato: true, glide: 0.12,
    fx: { chorus: { mix: 0.2 }, delay: { mix: 0.25, time: 0.5, feedback: 0.35 } }, velToAmp: 0.4, level: 0.8,
  }),
  P('lead-acide', 'Lead acide', 'Leads', 'Ligne résonante façon 303, pour un passage plus énervé', {
    osc: osc(O('sawtooth')),
    filter: { cutoff: 450, reso: 12, steep: true, keytrack: 0.3, envAmount: 4, velAmount: 1.5 }, ampEnv: env(0.003, 0.3, 1, 0.1), filterEnv: env(0.002, 0.25, 0.1, 0.15),
    mono: true, glide: 0.06, velToAmp: 0.3, level: 0.6,
  }),

  // --- Cloches & mallets
  P('cloche-trap', 'Cloche trap', 'Cloches & mallets', 'La cloche brillante des mélodies trap (façon Metro / Southside)', {
    osc: osc(O('sine'), O('sine', { octave: 1, semi: 7, level: 0.5 }), O('sine', { octave: 2, semi: 2, fine: 30, level: 0.22 })),
    filter: { cutoff: 8000, envAmount: 0 }, ampEnv: env(0.001, 1.2, 0, 1.5),
    fx: { delay: { mix: 0.2, time: 0.375, feedback: 0.35 } }, velToAmp: 0.7, level: 0.8,
  }),
  P('cloche-sombre', 'Cloche sombre', 'Cloches & mallets', 'Cloche inharmonique et sombre, pour les beats inquiétants', {
    osc: osc(O('sine'), O('triangle', { octave: 1, semi: 4, level: 0.4 })),
    filter: { cutoff: 3000, envAmount: 0 }, ampEnv: env(0.001, 2, 0, 2),
    fx: { chorus: { mix: 0.2 } }, velToAmp: 0.7, level: 0.85,
  }),
  P('marimba', 'Marimba', 'Cloches & mallets', 'Lames de bois, mélodies rebondissantes', {
    osc: osc(O('sine'), O('sine', { octave: 2, level: 0.15 })),
    filter: { cutoff: 5000, envAmount: 0 }, ampEnv: env(0.001, 0.45, 0, 0.3), velToAmp: 0.8, level: 0.95,
  }),
  P('vibraphone', 'Vibraphone', 'Cloches & mallets', 'Vibraphone jazzy avec trémolo, pour le R&B et la soul', {
    osc: osc(O('sine'), O('sine', { octave: 2, level: 0.2 })),
    filter: { cutoff: 5000, envAmount: 0 }, ampEnv: env(0.001, 2.5, 0, 1.5),
    lfo: { dest: 'amp', rate: 5, amount: 0.3, wave: 'sine' }, velToAmp: 0.8, level: 0.9,
  }),
  P('boite-a-musique', 'Boîte à musique', 'Cloches & mallets', 'Petite mélodie fragile et nostalgique', {
    osc: osc(O('triangle', { octave: 1 }), O('sine', { octave: 2, semi: 7, level: 0.25 })),
    filter: { cutoff: 6000, envAmount: 0 }, ampEnv: env(0.001, 0.8, 0, 1),
    fx: { delay: { mix: 0.15, time: 0.25, feedback: 0.3 } }, velToAmp: 0.7, level: 0.8,
  }),

  // --- Cordes
  P('cordes-ensemble', 'Cordes ensemble', 'Cordes', 'Section de cordes pour les accords lyriques', {
    osc: osc(O('sawtooth', { unison: 5, detune: 18, spread: 0.8 }), O('sawtooth', { octave: -1, level: 0.3 })),
    filter: { cutoff: 2200, keytrack: 0.4, envAmount: 0 }, ampEnv: env(0.35, 0.5, 0.9, 0.9),
    lfo: { dest: 'pitch', rate: 5.5, amount: 0.05, wave: 'sine' }, fx: { chorus: { mix: 0.5 } }, velToAmp: 0.4, level: 0.7,
  }),
  P('cordes-pizz', 'Cordes pizzicato', 'Cordes', 'Cordes pincées pour les mélodies sautillantes', {
    osc: osc(O('sawtooth', { unison: 3, detune: 10, spread: 0.5 })),
    filter: { cutoff: 1000, keytrack: 0.5, envAmount: 3 }, ampEnv: env(0.002, 0.35, 0, 0.2), filterEnv: env(0.001, 0.15, 0, 0.2),
    velToAmp: 0.8, level: 0.85,
  }),
  P('violon-solo', 'Violon solo', 'Cordes', 'Un violon expressif et mono, pour les intros dramatiques', {
    osc: osc(O('sawtooth')),
    filter: { cutoff: 2500, reso: 2, keytrack: 0.5, envAmount: 0 }, ampEnv: env(0.15, 0.3, 1, 0.35),
    lfo: { dest: 'pitch', rate: 5.5, amount: 0.1, wave: 'sine' }, mono: true, glide: 0.06, velToAmp: 0.5, level: 0.75,
  }),
  P('cordes-cinema', 'Cordes cinéma', 'Cordes', 'Cordes graves et épiques pour les beats cinématiques', {
    osc: osc(O('sawtooth', { unison: 7, detune: 22, spread: 1 }), O('sawtooth', { octave: -1, unison: 3, detune: 12, spread: 0.6, level: 0.6 })),
    filter: { cutoff: 1100, envAmount: 0 }, ampEnv: env(0.8, 1, 1, 2),
    fx: { chorus: { mix: 0.4 } }, velToAmp: 0.4, level: 0.8,
  }),

  // --- Flûtes & vents
  P('flute-trap', 'Flûte trap', 'Flûtes & vents', 'La flûte des hits trap (souffle + vibrato)', {
    osc: osc(O('sine'), O('triangle', { octave: 1, level: 0.1 })), noise: { level: 0.12 },
    filter: { cutoff: 4500, envAmount: 0 }, ampEnv: env(0.06, 0.3, 0.95, 0.25),
    lfo: { dest: 'pitch', rate: 5, amount: 0.1, wave: 'sine' }, mono: true, glide: 0.05,
    fx: { delay: { mix: 0.2, time: 0.375, feedback: 0.3 } }, velToAmp: 0.4, level: 0.8,
  }),
  P('flute-de-pan', 'Flûte de pan', 'Flûtes & vents', 'Flûte boisée et soufflée, ambiance mystique', {
    osc: osc(O('sine')), noise: { level: 0.2 },
    filter: { cutoff: 3000, envAmount: 0 }, ampEnv: env(0.08, 0.3, 0.8, 0.3),
    fx: { chorus: { mix: 0.2 } }, velToAmp: 0.4, level: 0.85,
  }),
  P('cuivres-synth', 'Cuivres synth', 'Flûtes & vents', 'Stabs de cuivres pour les beats énergiques', {
    osc: osc(O('sawtooth', { unison: 3, detune: 10, spread: 0.5 }), O('sawtooth', { semi: 7, level: 0.3 })),
    filter: { cutoff: 900, keytrack: 0.4, envAmount: 2.5, velAmount: 1.5 }, ampEnv: env(0.05, 0.4, 0.9, 0.2), filterEnv: env(0.08, 0.4, 0.5, 0.2),
    velToAmp: 0.6, level: 0.65,
  }),

  // --- Chœurs
  P('choeur-ah', 'Chœur « Ah »', 'Chœurs', 'Chœur synthétique ouvert, pour les refrains épiques', {
    osc: osc(O('sawtooth', { unison: 5, detune: 15, spread: 0.8 }), O('sawtooth', { octave: -1, level: 0.5 })),
    filter: { type: 'bandpass', cutoff: 900, reso: 3, keytrack: 0.3, envAmount: 0 }, ampEnv: env(0.3, 0.5, 0.9, 1),
    lfo: { dest: 'pitch', rate: 5, amount: 0.04, wave: 'sine' }, fx: { chorus: { mix: 0.6 } }, velToAmp: 0.3, level: 1,
  }),
  P('choeur-ouh', 'Chœur « Ouh »', 'Chœurs', 'Chœur fermé et doux, derrière une voix R&B', {
    osc: osc(O('triangle', { unison: 5, detune: 15, spread: 0.8 }), O('sine', { level: 0.5 })),
    filter: { cutoff: 700, envAmount: 0 }, ampEnv: env(0.4, 0.5, 1, 1.2),
    fx: { chorus: { mix: 0.7 } }, velToAmp: 0.3, level: 0.95,
  }),
  P('voix-angeliques', 'Voix angéliques', 'Chœurs', 'Voix aériennes qui planent, pour les intros', {
    osc: osc(O('sawtooth', { unison: 7, detune: 20, spread: 1 })), noise: { level: 0.05 },
    filter: { type: 'bandpass', cutoff: 1500, reso: 2, envAmount: 0 }, ampEnv: env(1, 1, 1, 2.5),
    fx: { chorus: { mix: 0.6 }, delay: { mix: 0.3, time: 0.5, feedback: 0.4 } }, velToAmp: 0.3, level: 1,
  }),

  // --- Basses (la 808 a son propre moteur)
  P('basse-sub', 'Basse sub (sinus)', 'Basses', 'Sub propre et profond, en complément d\'un kick', {
    osc: osc(O('sine', { octave: -1 }), O('triangle', { octave: -1, level: 0.15 })),
    filter: { cutoff: 800, keytrack: 0, envAmount: 0, velAmount: 0 }, ampEnv: env(0.005, 0.3, 0.9, 0.1),
    mono: true, glide: 0.03, velToAmp: 0.3, level: 0.8,
  }),
  P('basse-reese', 'Basse Reese', 'Basses', 'Basse grondante et désaccordée, pour la drill et la trap sombre', {
    osc: osc(O('sawtooth', { octave: -1, fine: -12 }), O('sawtooth', { octave: -1, fine: 12 })),
    filter: { cutoff: 900, steep: true, keytrack: 0.2, envAmount: 0 }, ampEnv: env(0.005, 0.3, 1, 0.1),
    lfo: { dest: 'filter', rate: 0.3, amount: 0.1, wave: 'sine' }, mono: true, velToAmp: 0.3, level: 0.7,
  }),
  P('basse-rnb', 'Basse R&B ronde', 'Basses', 'Basse ronde et chaude pour les grooves R&B', {
    osc: osc(O('triangle', { octave: -1 }), O('square', { octave: -1, level: 0.2 })),
    filter: { cutoff: 600, keytrack: 0.3, envAmount: 1.5 }, ampEnv: env(0.004, 0.5, 0.7, 0.1), filterEnv: env(0.003, 0.2, 0.3, 0.1),
    mono: true, glide: 0.02, velToAmp: 0.5, level: 0.85,
  }),
  P('basse-pluck', 'Basse pluck', 'Basses', 'Basse courte et percussive qui suit le kick', {
    osc: osc(O('sawtooth', { octave: -1 }), O('square', { octave: -1, level: 0.4 })),
    filter: { cutoff: 300, keytrack: 0.3, envAmount: 3 }, ampEnv: env(0.002, 0.4, 0.2, 0.1), filterEnv: env(0.001, 0.15, 0.05, 0.1),
    mono: true, velToAmp: 0.6, level: 0.85,
  }),

  // --- Arpèges (sons courts faits pour arpéger)
  P('arp-cristal', 'Arpège cristal', 'Arpèges', 'Notes courtes et brillantes avec écho, pour arpéger des accords', {
    osc: osc(O('triangle'), O('sine', { octave: 1, level: 0.4 })),
    filter: { cutoff: 3500, envAmount: 2 }, ampEnv: env(0.002, 0.25, 0, 0.2), filterEnv: env(0.001, 0.1, 0, 0.1),
    fx: { delay: { mix: 0.35, time: 0.25, feedback: 0.45 } }, velToAmp: 0.6, level: 0.9,
  }),
  P('arp-scie', 'Arpège scie', 'Arpèges', 'Arpège nerveux et serré, pour les montées', {
    osc: osc(O('sawtooth', { unison: 3, detune: 10, spread: 0.6 })),
    filter: { cutoff: 800, envAmount: 4 }, ampEnv: env(0.002, 0.2, 0, 0.12), filterEnv: env(0.001, 0.08, 0, 0.1),
    fx: { delay: { mix: 0.3, time: 0.1875, feedback: 0.35 } }, velToAmp: 0.6, level: 0.85,
  }),
  P('arp-retro', 'Arpège rétro 8-bit', 'Arpèges', 'Arpège de console de jeu, style chiptune', {
    osc: osc(O('square')),
    filter: { cutoff: 8000, envAmount: 0 }, ampEnv: env(0.002, 0.15, 0.2, 0.05),
    fx: { delay: { mix: 0.2, time: 0.25, feedback: 0.3 } }, velToAmp: 0.3, level: 0.55,
  }),
  P('arp-nuit', 'Arpège nuit', 'Arpèges', 'Arpège rêveur avec beaucoup d\'écho, ambiance de nuit', {
    osc: osc(O('triangle'), O('sawtooth', { octave: 1, level: 0.3 })),
    filter: { cutoff: 1500, envAmount: 2 }, ampEnv: env(0.002, 0.5, 0, 0.5), filterEnv: env(0.001, 0.2, 0, 0.3),
    fx: { chorus: { mix: 0.3 }, delay: { mix: 0.4, time: 0.5, feedback: 0.5 } }, velToAmp: 0.6, level: 0.85,
  }),

  // --- Basiques
  P('nova-saw-classique', 'Synthé classique NOVA', 'Basiques', 'Le son d\'origine de NOVA (dent de scie filtrée), en version réglable', {
    osc: osc(O('sawtooth', { level: 1 })),
    filter: { cutoff: 2000, reso: 1, keytrack: 0, envAmount: 0, velAmount: 0 }, ampEnv: env(0.01, 0.1, 0.5, 0.2),
    velToAmp: 1, level: 0.9,
  }),
  P('init', 'Son vierge', 'Basiques', 'Un point de départ neutre pour créer ton propre son', {
    osc: osc(O('sawtooth')), filter: { cutoff: 20000, keytrack: 0, envAmount: 0, velAmount: 0 }, ampEnv: env(0.003, 0.1, 1, 0.1), velToAmp: 0.5, level: 0.7,
  }),
];

/**
 * Volume de chaque son, calibré à l'export (qa/synth_v24_preuve.py --niveaux) pour
 * que tous sonnent au même niveau ressenti (-18 dB RMS sur 300 ms, accord de 5 notes
 * ou note seule pour les sons mono) avec au moins 2 dB de marge sous 0 dBFS.
 */
const CALIBRATED_LEVEL: Record<string, number> = {
  'rhodes-soul': 0.323,
  'rhodes-lofi': 0.269,
  'piano-wurli': 0.317,
  'piano-doux': 0.251,
  'keys-rnb': 0.289,
  'orgue-gospel': 0.133,
  'nappe-chaude': 0.321,
  'nappe-trap-sombre': 0.214,
  'nappe-aerienne': 0.35,
  'nappe-verre': 0.217,
  'nappe-rnb-90s': 0.155,
  'nappe-evolutive': 0.245,
  'pluck-trap': 0.477,
  'pluck-doux': 0.484,
  'pluck-guitare': 0.283,
  'kalimba': 0.343,
  'harpe': 0.372,
  'lead-trap-glisse': 0.291,
  'lead-sifflet': 0.292,
  'lead-supersaw': 0.279,
  'lead-carre-retro': 0.336,
  'lead-rnb-sinus': 0.346,
  'lead-acide': 0.272,
  'cloche-trap': 0.239,
  'cloche-sombre': 0.263,
  'marimba': 0.461,
  'vibraphone': 0.269,
  'boite-a-musique': 0.388,
  'cordes-ensemble': 0.328,
  'cordes-pizz': 0.469,
  'violon-solo': 0.532,
  'cordes-cinema': 0.312,
  'flute-trap': 0.33,
  'flute-de-pan': 0.212,
  'cuivres-synth': 0.216,
  'choeur-ah': 0.796,
  'choeur-ouh': 0.181,
  'voix-angeliques': 1.0,
  'basse-sub': 0.323,
  'basse-reese': 0.332,
  'basse-rnb': 0.422,
  'basse-pluck': 0.624,
  'arp-cristal': 0.639,
  'arp-scie': 0.491,
  'arp-retro': 0.394,
  'arp-nuit': 0.61,
  'nova-saw-classique': 0.474,
  'init': 0.235,
};

const byId = new Map(SYNTH_PRESETS.map(p => [p.id, p]));
export const presetById = (id: string) => byId.get(id);
export const DEFAULT_PRESET_ID = 'keys-rnb';

const merge = (base: any, over: any): any => {
  if (over === undefined) return base;
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over;
  const out: any = { ...base };
  for (const k of Object.keys(over)) out[k] = merge(base?.[k], over[k]);
  return out;
};

/** Réglages complets d'un préréglage (préréglage inconnu : le son par défaut). */
export function presetSettings(id: string): NovaSynthSettings {
  const p = byId.get(id) ?? byId.get(DEFAULT_PRESET_ID)!;
  const level = CALIBRATED_LEVEL[p.id] ?? p.over.level;
  return { ...normalizeSynth(merge(defaultSynth(), { ...p.over, level })), presetId: p.id, name: p.name };
}

/** Notes jouées par l'aperçu : accord (Do mineur 9) ou note seule pour les sons mono. */
export function previewNotesFor(id: string): number[] {
  const p = byId.get(id);
  if (!p) return [48, 55, 58, 62, 65];
  if (p.cat === 'Basses') return [36];
  if (p.over.mono) return [67];
  if (p.cat === 'Cloches & mallets' || p.cat === 'Arpèges' || p.cat === 'Plucks') return [60, 67, 70, 74];
  return [48, 55, 58, 62, 65];
}
