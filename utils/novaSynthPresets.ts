/**
 * Banque de sons du synthé NOVA, pensée pour le rap, la trap et le R&B.
 * Chaque préréglage ne décrit que ce qui change par rapport à defaultSynth() ;
 * presetSettings() renvoie des réglages complets et bornés (normalizeSynth).
 * Pas de 808 ici : elle a son propre moteur (Bass808Node).
 */
import { NovaSynthSettings, SynthOsc, OscWave, defaultSynth, defaultOsc, normalizeSynth } from './novaSynth';

export const PRESET_CATEGORIES = [
  'Pianos & Rhodes', 'Nappes', 'Plucks', 'Leads', 'Cloches & mallets', 'Cordes',
  'Flûtes & vents', 'Chœurs', 'Basses', 'Arpèges', 'Afro & Amapiano', 'Rage & Hyperpop', 'Basiques',
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
  /** Ajouté le 14/10/2026 (pastille « Nouveau » et filtre « Nouveautés »). */
  isNew?: boolean;
  /** Notes de l'aperçu, quand celles de la catégorie ne conviennent pas. */
  preview?: number[];
}

const O = (wave: OscWave, over: Partial<SynthOsc> = {}): SynthOsc => defaultOsc({ on: true, wave, level: 0.8, ...over });
/** Trois oscillateurs (les absents sont coupés). */
const osc = (...list: SynthOsc[]): SynthOsc[] => [0, 1, 2].map(i => list[i] ?? defaultOsc());
const env = (a: number, d: number, s: number, r: number) => ({ a, d, s, r });

const P = (id: string, name: string, cat: PresetCategory, tip: string, over: Over): SynthPreset => ({ id, name, cat, tip, over });
/** Préréglage ajouté le 14/10/2026 (sons 2026 : afro, rage, drill, jersey, future bass…). */
const N = (id: string, name: string, cat: PresetCategory, tip: string, over: Over, preview?: number[]): SynthPreset =>
  ({ id, name, cat, tip, over, isNew: true, ...(preview ? { preview } : {}) });

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
  N('orgue-house', 'Orgue house', 'Pianos & Rhodes', 'L\'orgue percussif des classiques house des années 90 : accords courts et brillants (house, amapiano)', {
    osc: osc(O('square', { level: 0.55 }), O('sine', { octave: 1, level: 0.6 }), O('sine', { octave: 2, semi: 7, level: 0.25 })),
    filter: { cutoff: 2600, keytrack: 0.5, envAmount: 1.5, velAmount: 0.8 }, ampEnv: env(0.001, 0.45, 0.45, 0.12), filterEnv: env(0.001, 0.15, 0.3, 0.1),
    fx: { chorus: { mix: 0.2 } }, velToAmp: 0.5, level: 0.7,
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
  N('nappe-drill-sombre', 'Nappe drill sombre', 'Nappes', 'Nappe glaciale et menaçante qui ondule lentement, pour la drill UK et FR', {
    osc: osc(O('sawtooth', { unison: 5, detune: 22, spread: 0.9 }), O('triangle', { octave: -1, level: 0.6 }), O('sine', { octave: 1, level: 0.12 })),
    filter: { cutoff: 480, reso: 4, steep: true, keytrack: 0.3, envAmount: 0, velAmount: 0.3 }, ampEnv: env(0.9, 1, 1, 2.2),
    lfo: { dest: 'filter', rate: 0.15, amount: 0.2, wave: 'triangle' }, fx: { chorus: { mix: 0.35, depth: 0.6 }, delay: { mix: 0.22, time: 0.5, feedback: 0.45 } }, velToAmp: 0.3, level: 0.8,
  }),
  N('nappe-synthwave', 'Nappe synthwave', 'Nappes', 'Nappe années 80 chorusée qui s\'ouvre doucement, pour les prods rétro et nocturnes', {
    osc: osc(O('sawtooth', { unison: 3, detune: 14, spread: 0.8 }), O('square', { octave: -1, level: 0.4 })),
    filter: { cutoff: 900, reso: 2, keytrack: 0.3, envAmount: 1.6, velAmount: 0.5 }, ampEnv: env(0.25, 1, 0.9, 1.6), filterEnv: env(0.8, 2.5, 0.4, 1.5),
    fx: { chorus: { mix: 0.7, rate: 0.5, depth: 0.6 }, delay: { mix: 0.2, time: 0.5, feedback: 0.45 } }, velToAmp: 0.3, level: 0.75,
  }),
  N('nappe-vinyle', 'Nappe vinyle', 'Nappes', 'Nappe douce et usée, avec du souffle et une hauteur qui flotte comme un vieux disque', {
    osc: osc(O('triangle', { unison: 3, detune: 10, spread: 0.6 }), O('sine', { octave: 1, level: 0.25 })), noise: { level: 0.1 },
    filter: { cutoff: 1500, keytrack: 0.2, envAmount: 0, velAmount: 0.3 }, ampEnv: env(0.4, 1, 1, 1.8),
    lfo: { dest: 'pitch', rate: 0.45, amount: 0.07, wave: 'sine' }, fx: { chorus: { mix: 0.5, depth: 0.7 } }, velToAmp: 0.3, level: 0.8,
  }),
  N('accords-future-bass', 'Accords future bass', 'Nappes', 'Accords larges qui « pompent » (sidechain simulé par le LFO sur le volume, calé sur 150 BPM) : refrains future bass et trap mélodique', {
    osc: osc(O('sawtooth', { unison: 7, detune: 40, spread: 1 }), O('sawtooth', { octave: 1, unison: 3, detune: 25, spread: 1, level: 0.35 }), O('square', { octave: -1, level: 0.3 })),
    filter: { cutoff: 3200, keytrack: 0.2, envAmount: 0.8, velAmount: 0.5 }, ampEnv: env(0.005, 0.3, 1, 0.35), filterEnv: env(0.01, 0.4, 0.6, 0.3),
    lfo: { dest: 'amp', rate: 2.5, amount: 0.7, wave: 'sine' }, fx: { chorus: { mix: 0.25 } }, velToAmp: 0.3, level: 0.6,
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
  N('pluck-lofi', 'Pluck lo-fi détendu', 'Plucks', 'Pluck feutré qui « pleure » un peu, comme une vieille cassette : boucles lo-fi et chill', {
    osc: osc(O('triangle'), O('sine', { octave: 1, level: 0.25 })), noise: { level: 0.04 },
    filter: { cutoff: 700, keytrack: 0.4, envAmount: 2.2, velAmount: 1 }, ampEnv: env(0.003, 0.9, 0.1, 0.4), filterEnv: env(0.002, 0.25, 0.1, 0.25),
    lfo: { dest: 'pitch', rate: 0.7, amount: 0.06, wave: 'sine' }, fx: { chorus: { mix: 0.45, depth: 0.7 }, delay: { mix: 0.15, time: 0.375, feedback: 0.3 } }, velToAmp: 0.6, level: 0.85,
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
  N('lead-jersey', 'Lead jersey club', 'Leads', 'Lead rebondissant, attaque claquée et maintien court : rythmes jersey club et drill sautillante', {
    osc: osc(O('square'), O('sawtooth', { fine: -8, level: 0.6 })),
    filter: { cutoff: 1600, reso: 3, keytrack: 0.4, envAmount: 2.8 }, ampEnv: env(0.001, 0.22, 0.45, 0.1), filterEnv: env(0.001, 0.12, 0.25, 0.1),
    fx: { delay: { mix: 0.15, time: 0.125, feedback: 0.25 } }, velToAmp: 0.5, level: 0.7,
  }),
  N('lead-gfunk', 'Lead G-funk', 'Leads', 'Le sifflement sinus qui glisse des prods West Coast : portamento lent et vibrato', {
    osc: osc(O('sine'), O('triangle', { level: 0.15 })),
    filter: { cutoff: 5000, keytrack: 0, envAmount: 0, velAmount: 0 }, ampEnv: env(0.03, 0.3, 1, 0.25),
    lfo: { dest: 'pitch', rate: 5.5, amount: 0.12, wave: 'sine' }, mono: true, legato: true, glide: 0.2,
    fx: { chorus: { mix: 0.15 }, delay: { mix: 0.2, time: 0.375, feedback: 0.3 } }, velToAmp: 0.3, level: 0.8,
  }),
  N('lead-voix', 'Lead voix synthé', 'Leads', 'Lead qui « chante » comme une voix (formant), mono et glissé : réponses de mélodie trap', {
    osc: osc(O('sawtooth'), O('sawtooth', { fine: 10, level: 0.6 }), O('square', { octave: 1, level: 0.3 })),
    filter: { type: 'bandpass', cutoff: 800, reso: 1.4, keytrack: 0.6, envAmount: 0.4, velAmount: 0.5 }, ampEnv: env(0.02, 0.3, 0.95, 0.25), filterEnv: env(0.05, 0.4, 0.5, 0.3),
    lfo: { dest: 'pitch', rate: 5.2, amount: 0.09, wave: 'sine' }, mono: true, glide: 0.09,
    fx: { chorus: { mix: 0.2 }, delay: { mix: 0.25, time: 0.375, feedback: 0.35 } }, velToAmp: 0.4, level: 0.8,
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
  N('cloche-noel', 'Cloche de Noël trap', 'Cloches & mallets', 'Clochettes scintillantes façon conte d\'hiver : la mélodie de cloche des beats trap de Noël', {
    osc: osc(O('sine', { octave: 1 }), O('sine', { octave: 2, semi: 5, fine: 50, level: 0.45 }), O('sine', { octave: 3, semi: 4, fine: 80, level: 0.18 })),
    filter: { cutoff: 12000, keytrack: 0, envAmount: 0, velAmount: 0 }, ampEnv: env(0.001, 1.6, 0, 1.6),
    lfo: { dest: 'amp', rate: 7, amount: 0.2, wave: 'sine' }, fx: { chorus: { mix: 0.3, rate: 1.2, depth: 0.3 }, delay: { mix: 0.25, time: 0.25, feedback: 0.4 } }, velToAmp: 0.7, level: 0.8,
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
  N('cuivres-trap', 'Cuivres trap', 'Flûtes & vents', 'Section de cuivres épaisse et sombre qui gonfle : intros épiques et refrains', {
    osc: osc(O('sawtooth', { unison: 5, detune: 18, spread: 0.7 }), O('sawtooth', { octave: -1, level: 0.5 }), O('square', { level: 0.2 })),
    filter: { cutoff: 600, reso: 1.5, keytrack: 0.5, envAmount: 2.2, velAmount: 1.5 }, ampEnv: env(0.06, 0.5, 0.9, 0.25), filterEnv: env(0.12, 0.5, 0.45, 0.25),
    lfo: { dest: 'pitch', rate: 5, amount: 0.03, wave: 'sine' }, velToAmp: 0.6, level: 0.65,
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
  N('choeur-sombre', 'Chœur sombre', 'Chœurs', 'Chœur grave et inquiétant (« Oh »), pour les ambiances drill et les intros sombres', {
    osc: osc(O('sawtooth', { unison: 5, detune: 18, spread: 0.8 }), O('sawtooth', { octave: -1, unison: 3, detune: 12, spread: 0.5, level: 0.6 })),
    filter: { type: 'bandpass', cutoff: 550, reso: 3, keytrack: 0.2, envAmount: 0, velAmount: 0 }, ampEnv: env(0.5, 0.8, 1, 1.6),
    lfo: { dest: 'pitch', rate: 4.5, amount: 0.03, wave: 'sine' }, fx: { chorus: { mix: 0.6 }, delay: { mix: 0.15, time: 0.5, feedback: 0.4 } }, velToAmp: 0.3, level: 1,
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
  N('basse-funk', 'Basse funk', 'Basses', 'Basse synthé ronde et claquante façon funk / G-funk, avec un petit glissé', {
    osc: osc(O('square', { octave: -1, level: 0.7 }), O('sawtooth', { octave: -1, fine: 5, level: 0.5 })),
    filter: { cutoff: 380, reso: 4, keytrack: 0.4, envAmount: 2.6, velAmount: 1.2 }, ampEnv: env(0.003, 0.5, 0.6, 0.08), filterEnv: env(0.004, 0.18, 0.15, 0.12),
    mono: true, glide: 0.04, velToAmp: 0.6, level: 0.8,
  }),
  N('reese-drill', 'Reese drill', 'Basses', 'Reese grave qui grogne et glisse, pour les basses drill UK / FR (à doubler avec une 808)', {
    osc: osc(O('sawtooth', { octave: -1, unison: 3, detune: 28, spread: 0.5 }), O('sawtooth', { octave: -1, fine: -15, level: 0.7 }), O('sine', { octave: -1, level: 0.5 })),
    filter: { cutoff: 650, reso: 2, steep: true, keytrack: 0.3, envAmount: 0.6, velAmount: 0.5 }, ampEnv: env(0.004, 0.3, 1, 0.12), filterEnv: env(0.01, 0.6, 0.4, 0.2),
    lfo: { dest: 'filter', rate: 0.6, amount: 0.12, wave: 'sine' }, mono: true, glide: 0.08, velToAmp: 0.3, level: 0.7,
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
  N('arp-ambient', 'Arpège ambient', 'Arpèges', 'Notes douces noyées dans un long écho : à arpéger lentement pour une intro planante', {
    osc: osc(O('sine'), O('triangle', { octave: 1, level: 0.3 }), O('sine', { octave: 2, semi: 7, level: 0.08 })),
    filter: { cutoff: 2200, keytrack: 0.3, envAmount: 1.2 }, ampEnv: env(0.004, 0.9, 0, 0.9), filterEnv: env(0.002, 0.3, 0.1, 0.4),
    fx: { chorus: { mix: 0.4 }, delay: { mix: 0.45, time: 0.5, feedback: 0.6 } }, velToAmp: 0.6, level: 0.85,
  }),

  // --- Afro & Amapiano
  N('log-drum', 'Log drum amapiano', 'Afro & Amapiano', 'La basse percussive de l\'amapiano : un « tok » boisé qui gronde et glisse, à jouer en notes courtes', {
    osc: osc(O('sine', { octave: -1, level: 0.9 }), O('triangle', { level: 0.35 }), O('square', { semi: 7, level: 0.08 })), noise: { level: 0.05 },
    filter: { cutoff: 280, reso: 6, keytrack: 0.6, envAmount: 3.2, velAmount: 1.2 }, ampEnv: env(0.001, 0.55, 0, 0.18), filterEnv: env(0.001, 0.09, 0, 0.08),
    mono: true, legato: false, glide: 0.035, velToAmp: 0.6, level: 0.8,
  }, [43]),
  N('pluck-afro', 'Pluck afro', 'Afro & Amapiano', 'Pluck boisé et rebondissant des mélodies afrobeats, avec un écho court', {
    osc: osc(O('triangle'), O('sine', { octave: 2, level: 0.18 }), O('square', { octave: 1, level: 0.1 })),
    filter: { cutoff: 1400, keytrack: 0.5, envAmount: 2.5, velAmount: 1 }, ampEnv: env(0.001, 0.38, 0, 0.22), filterEnv: env(0.001, 0.12, 0, 0.12),
    fx: { delay: { mix: 0.22, time: 0.1875, feedback: 0.3 } }, velToAmp: 0.7, level: 0.85,
  }, [60, 67, 70, 74]),
  N('accords-amapiano', 'Accords amapiano', 'Afro & Amapiano', 'Accords de piano house feutrés et jazzy, typiques de l\'amapiano', {
    osc: osc(O('sine', { level: 0.85 }), O('triangle', { octave: 1, level: 0.3 }), O('sawtooth', { level: 0.12, fine: 6 })),
    filter: { cutoff: 1800, keytrack: 0.5, envAmount: 1.2, velAmount: 1.5 }, ampEnv: env(0.002, 0.9, 0.35, 0.35), filterEnv: env(0.002, 0.35, 0.2, 0.3),
    fx: { chorus: { mix: 0.3 } }, velToAmp: 0.8, level: 0.8,
  }),
  N('flute-afro', 'Flûte afro', 'Afro & Amapiano', 'Flûte souple et soufflée, vibrato lent : mélodies afro et amapiano', {
    osc: osc(O('sine'), O('triangle', { octave: 1, level: 0.12 })), noise: { level: 0.1 },
    filter: { cutoff: 3500, keytrack: 0.3, envAmount: 0, velAmount: 0.5 }, ampEnv: env(0.05, 0.3, 0.9, 0.3),
    lfo: { dest: 'pitch', rate: 4.2, amount: 0.08, wave: 'sine' }, mono: true, glide: 0.07,
    fx: { chorus: { mix: 0.25 }, delay: { mix: 0.25, time: 0.375, feedback: 0.35 } }, velToAmp: 0.4, level: 0.8,
  }),

  // --- Rage & Hyperpop
  N('lead-rage', 'Lead rage désaccordé', 'Rage & Hyperpop', 'Lead énorme, désaccordé et agressif des prods rage : à jouer en notes tenues', {
    osc: osc(O('sawtooth', { unison: 7, detune: 55, spread: 1 }), O('square', { unison: 3, detune: 30, spread: 0.7, level: 0.55 }), O('sawtooth', { octave: -1, level: 0.45 })),
    filter: { cutoff: 5200, reso: 2.5, keytrack: 0.2, envAmount: 0.8 }, ampEnv: env(0.004, 0.3, 0.95, 0.22), filterEnv: env(0.003, 0.25, 0.6, 0.2),
    lfo: { dest: 'pitch', rate: 6, amount: 0.04, wave: 'sine' }, fx: { chorus: { mix: 0.25 }, delay: { mix: 0.18, time: 0.375, feedback: 0.3 } }, velToAmp: 0.3, level: 0.6,
  }),
  N('pluck-rage', 'Pluck rage', 'Rage & Hyperpop', 'Pluck brillant et large pour les boucles rage et pluggnb', {
    osc: osc(O('sawtooth', { unison: 5, detune: 35, spread: 0.9 }), O('square', { octave: 1, level: 0.25 })),
    filter: { cutoff: 1000, keytrack: 0.4, envAmount: 3.2, velAmount: 1 }, ampEnv: env(0.002, 0.8, 0, 0.3), filterEnv: env(0.004, 0.2, 0.08, 0.15),
    fx: { chorus: { mix: 0.2 }, delay: { mix: 0.25, time: 0.25, feedback: 0.35 } }, velToAmp: 0.45, level: 0.8,
  }, [60, 67, 70, 74]),
  N('lead-hyperpop', 'Lead hyperpop aigu', 'Rage & Hyperpop', 'Lead perçant une octave au-dessus, vibrato rapide et glissés : hyperpop et digicore', {
    osc: osc(O('square', { octave: 1, level: 0.8 }), O('sawtooth', { octave: 1, fine: 9, level: 0.5 }), O('sine', { octave: 2, level: 0.2 })),
    filter: { cutoff: 7000, keytrack: 0, envAmount: 0, velAmount: 0 }, ampEnv: env(0.003, 0.2, 0.85, 0.12),
    lfo: { dest: 'pitch', rate: 7.5, amount: 0.14, wave: 'sine' }, mono: true, glide: 0.05,
    fx: { delay: { mix: 0.22, time: 0.1875, feedback: 0.3 } }, velToAmp: 0.3, level: 0.6,
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
  // Nouveaux sons (14/10/2026) : calibrés par qa/synthe_sons.py --calibrer.
  'orgue-house': 0.234,
  'nappe-drill-sombre': 0.213,
  'nappe-synthwave': 0.263,
  'nappe-vinyle': 0.213,
  'accords-future-bass': 0.33,
  'pluck-lofi': 0.402,
  'lead-jersey': 0.207,
  'lead-gfunk': 0.281,
  'cloche-noel': 0.274,
  'cuivres-trap': 0.22,
  'choeur-sombre': 0.785,
  'basse-funk': 0.349,
  'reese-drill': 0.234,
  'arp-ambient': 0.407,
  'log-drum': 0.58,
  'pluck-afro': 0.555,
  'accords-amapiano': 0.304,
  'flute-afro': 0.37,
  'lead-rage': 0.218,
  'lead-hyperpop': 0.287,
  'lead-voix': 1.0,
  'pluck-rage': 0.42,
};

/** Volume calibré d'un son (undefined : pas encore mesuré). */
export const calibratedLevel = (id: string): number | undefined => CALIBRATED_LEVEL[id];

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
  if (p.preview) return [...p.preview];
  if (p.cat === 'Basses') return [36];
  if (p.over.mono) return [67];
  if (p.cat === 'Cloches & mallets' || p.cat === 'Arpèges' || p.cat === 'Plucks') return [60, 67, 70, 74];
  return [48, 55, 58, 62, 65];
}
