/**
 * Lot 8a — bibliothèque de presets de chaîne voix (rangés par style et par rôle),
 * faits UNIQUEMENT avec les effets natifs de NOVA.
 *
 * Chaque preset part d'une recette documentée (sources : `sources`, détaillées dans
 * CONTENU/nova-bandlab/lot8_presets/RECETTES.md) et des règles de mix de Romain,
 * qui passent avant tout :
 *  - compresseur voix en 2:1, sur DEUX étages de types différents : étage 1 =
 *    Compresseur NOVA (numérique, comme le Pro-C 3 de la session de Romain), étage 2 =
 *    Opto Vintage (type CL 1B) OU Vox Strip (type VOXBOX), jamais les deux ;
 *  - réduction de gain : 5 dB MAXIMUM au VU par étage (Opto Vintage, Vox Strip) ;
 *    sur un bus : FET 76 5 dB, Leveler 2A 2 dB (presets « Bus voix ») ;
 *  - leads : coupe-bas 80 Hz (au moins) ; backs, doubles, ad-libs, harmonies :
 *    coupe-bas 200 Hz (au moins) + coupe-haut 15 kHz (au plus) ;
 *  - de-esser vers 8 kHz ; effets temporels (réverbe, écho) en ENVOI, jamais en insert.
 *
 * Niveaux : la chaîne est calée hors ligne sur 3 vraies prises rap du studio
 * (tools/labo/presets_voix_mesures.py → utils/voicePresetCalib.ts) : seuils des deux
 * étages, gain de sortie. À l'application, NOVA mesure la prise (LUFS intégrés) et
 * règle le trim d'entrée de la tranche (tête de tranche, avant les effets) pour
 * l'amener à REF_INPUT_LUFS : la
 * compression travaille alors comme au labo, quel que soit le niveau d'enregistrement
 * (c'est le « Caler sur ma voix » fait d'office), et tous les presets sortent au même
 * niveau (TARGET_OUTPUT_LUFS, ±1 dB) : changer de preset change le son, pas le volume.
 *
 * Données pures (aucun React, aucun nœud audio) : interface, chat, Décris ton son,
 * One Knob, labo et tests s'en servent.
 */
import type { PluginInstance, PluginType, Track, VoiceChainState } from '../types';
import { ANALOG_SPECS } from '../engine/analogCompParams';
import { V21_DEFAULTS } from '../engine/v21Params';
import { VOICE_PRESET_CALIB, type VoicePresetCalib } from './voicePresetCalib';
import { PRESET_DEFS } from './voicePresetDefs';

// ---------------------------------------------------------------------------
// Règles maison et références
// ---------------------------------------------------------------------------

/** Niveau de référence de la prise à l'entrée de la chaîne (LUFS intégrés, mono). */
export const REF_INPUT_LUFS = -20;
/** Niveau visé en sortie de chaîne, avant le fader (LUFS intégrés, stéréo). */
export const TARGET_OUTPUT_LUFS = -16;
/** Trim d'entrée possible (dB), celui de la tête de tranche (engine/meters/channelStrip) : au-delà, gain du clip. */
export const TRIM_RANGE = { min: -24, max: 24 } as const;

export const HOUSE_RULES = {
  ratio: 2,
  /** Réduction max au VU (dB) : étage 1 (Compresseur NOVA) et étage 2 (Opto Vintage / Vox Strip). */
  stage1MaxGrDb: 5,
  stage2MaxGrDb: 5,
  /** Bus : FET 76 et Leveler 2A. */
  busFetMaxGrDb: 5,
  busLevelerMaxGrDb: 2,
  leadHighpassHz: 80,
  otherHighpassHz: 200,
  otherLowpassHz: 15000,
  deesserHz: 8000,
} as const;

/** Effets temporels : toujours en envoi (règle de Romain). */
export const TIME_FX: PluginType[] = ['REVERB', 'DELAY', 'TIMEFX'];

export type VoicePresetRole = 'lead' | 'back' | 'double' | 'adlib' | 'harmony' | 'bus';
export type VoicePresetStyle =
  | 'trap' | 'drill' | 'conscient' | 'rnb' | 'afro' | 'pop' | 'autotune' | 'melodique'
  | 'lofi' | 'telephone' | 'podcast' | 'maison';

export const ROLE_NAMES: Record<VoicePresetRole, string> = {
  lead: 'Lead', back: 'Backs', double: 'Doubles', adlib: 'Ad-libs', harmony: 'Harmonies', bus: 'Bus voix',
};

export const STYLE_NAMES: Record<VoicePresetStyle, string> = {
  trap: 'Trap', drill: 'Drill', conscient: 'Rap conscient', rnb: 'R&B doux', afro: 'Afro', pop: 'Pop',
  autotune: 'Autotune marqué', melodique: 'Rap mélodique', lofi: 'Lo-fi', telephone: 'Téléphone / radio',
  podcast: 'Voix parlée', maison: 'Make Music',
};

// ---------------------------------------------------------------------------
// Description d'un preset
// ---------------------------------------------------------------------------

/**
 * Égaliseur 12 bandes (Pro EQ 12) : chaque bande a un rôle fixe, que les macros
 * du One Knob retrouvent : 0 coupe-bas · 1 corps · 2 boue · 3 carton · 4 nasal ·
 * 5 dureté · 6 présence · 7 et 8 libres · 9 air (cloche) · 10 étagère aiguë · 11 coupe-haut.
 */
export const EQ_BAND = { hp: 0, body: 1, mud: 2, boxy: 3, nasal: 4, harsh: 5, presence: 6, air: 9, shelf: 10, lp: 11 } as const;

/** [fréquence Hz, gain dB, Q facultatif] d'une cloche. */
export type EqBell = [number, number] | [number, number, number];

export interface EqShape {
  hp: number;
  lp?: number;
  body?: EqBell;
  mud?: EqBell;
  boxy?: EqBell;
  nasal?: EqBell;
  harsh?: EqBell;
  presence?: EqBell;
  /** Cloche d'air (≈ 8-12 kHz). */
  air?: EqBell;
  /** Étagère aiguë (≈ 10-15 kHz). */
  shelf?: [number, number];
}

export interface PresetDef {
  id: string;
  name: string;
  style: VoicePresetStyle;
  role: VoicePresetRole;
  /** Une phrase pour l'artiste : à quoi ça sonne, pour quel morceau. */
  description: string;
  /** Identifiants des recettes (RECETTES.md). */
  sources: string[];
  /** Nettoyage (gate de bruit adaptatif) en tête de chaîne. */
  denoise?: boolean;
  /** Nova Tune : temps de correction (ms), naturel (0-1), dosage (0-1). */
  tune?: { ms: number; humanize: number; mix?: number };
  /** Voix grave / aiguë (pitch, formant…). */
  shift?: { pitch: number; formant: number; link?: 0 | 1; mix: number; output?: number };
  eq?: EqShape;
  /** Étage 1 (Compresseur NOVA, 2:1). Temps en ms. */
  comp1?: { attackMs: number; releaseMs: number; mode?: 'CLEAN' | 'VCA' | 'OPTO' | 'FET'; knee?: number };
  /** De-esser (fréquence de départ, profondeur 0-1). */
  deess?: { freq: number; depth: number };
  /** Étage 2 : Opto Vintage OU Vox Strip (jamais les deux). Positions du constructeur (0-10 / 0-4). */
  comp2?:
    | { kind: 'OPTO_VINTAGE'; attack: number; release: number; mode?: 0 | 1 | 2 }
    | { kind: 'VOXSTRIP'; attack: number; release: number; loPeak?: number; loFreq?: number; midDip?: number; midFreq?: number; hiPeak?: number; hiFreq?: number };
  /** Saturation (après la compression). */
  sat?: { mode: 'TAPE' | 'TUBE' | 'TRANSISTOR' | 'SOFT_CLIP'; drive: number; mix: number; tone?: number };
  /** Lo-fi / téléphone (couleur, en fin de chaîne). */
  lofi?: { bits: number; rate: number; lowCut: number; highCut: number; drive: number; noise: number; mix?: number };
  /** Doubleur (largeur, désaccord). */
  width?: { detune: number; width: number; gain: number; directOn?: boolean };
  /** Bus voix : FET 76 puis Leveler 2A (règle maison). */
  bus?: { fetRatio: 2 | 4 | 8; fetAttack: number; fetRelease: number; leveler: boolean };
  /** Envois (gain linéaire 0-1) vers les retours du projet. */
  sends: { delay: number; verbShort: number; verbLong: number };
  /** Réduction visée au calage (dB, pire des 3 prises) : étage 1, étage 2 (≤ 5, règle maison). Défaut 3 / 4,5. */
  gr?: { stage1: number; stage2: number };
  /** Fader (dB) et pan (0-1, côté alterné pour les voix secondaires). */
  volumeDb: number;
  pan: number;
}

export interface VoicePreset extends PresetDef {
  calib: VoicePresetCalib;
}

export interface VoiceChainItem { type: PluginType; params: Record<string, any> }

// ---------------------------------------------------------------------------
// Constructeurs d'effets (réglages complets, mêmes valeurs par défaut que l'appli)
// ---------------------------------------------------------------------------

const EQ_FREQS = [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000];

export function buildEqBands(s: EqShape) {
  const bands = EQ_FREQS.map((frequency, id) => ({
    id,
    type: (id === 0 ? 'highpass' : id === 11 ? 'lowpass' : 'peaking') as string,
    frequency, gain: 0, q: id === 0 || id === 11 ? 0.71 : 1.0, isEnabled: id === 0, isSolo: false,
  }));
  bands[0].frequency = s.hp;
  if (s.lp) Object.assign(bands[11], { frequency: s.lp, isEnabled: true });
  const bell = (i: number, v: EqBell | undefined, q: number) => { if (v) Object.assign(bands[i], { frequency: v[0], gain: v[1], q: v[2] ?? q, isEnabled: true }); };
  bell(EQ_BAND.body, s.body, 0.8);
  bell(EQ_BAND.mud, s.mud, 1.2);
  bell(EQ_BAND.boxy, s.boxy, 2.0);
  bell(EQ_BAND.nasal, s.nasal, 2.0);
  bell(EQ_BAND.harsh, s.harsh, 2.5);
  bell(EQ_BAND.presence, s.presence, 0.9);
  bell(EQ_BAND.air, s.air, 0.8);
  if (s.shelf) Object.assign(bands[EQ_BAND.shelf], { type: 'highshelf', frequency: s.shelf[0], gain: s.shelf[1], q: 0.71, isEnabled: true });
  else Object.assign(bands[EQ_BAND.shelf], { type: 'highshelf', frequency: 15000, gain: 0, q: 0.71, isEnabled: false });
  return bands;
}

const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Temps de correction (ms) → réglage « vitesse » de Nova Tune (0-1, ms = 300 × v²). */
export const tuneSpeedFromMs = (ms: number) => r2(Math.sqrt(Math.max(0, ms) / 300));

const DENOISE_PARAMS = {
  threshold: -60, range: -30, attack: 0.002, hold: 0.08, release: 0.08, scFreq: 250, flip: false,
  autoThreshold: true, lowCut: 80, humFilter: true,
};

const NEUTRAL_CALIB: VoicePresetCalib = { thr1: -24, thr2: -26, levelDb: 0, gr1: 0, gr2: 0, head2: 4, outLufs: null, spreadDb: null, truePeakDb: null };

/** Chaîne d'effets d'un preset (ordre : nettoyage → justesse → EQ → étage 1 → de-esser → étage 2 → couleur → largeur). */
export function presetChain(p: PresetDef, calib: VoicePresetCalib = NEUTRAL_CALIB): VoiceChainItem[] {
  const out: VoiceChainItem[] = [];
  if (p.denoise) out.push({ type: 'DENOISER', params: { ...DENOISE_PARAMS } });
  if (p.tune) out.push({ type: 'AUTOTUNE', params: { speed: tuneSpeedFromMs(p.tune.ms), humanize: p.tune.humanize, mix: p.tune.mix ?? 1 } });
  if (p.shift) out.push({ type: 'VOICESHIFT', params: { ...V21_DEFAULTS.VOICESHIFT(), link: 0, output: 0, ...p.shift } });
  // Toujours un égaliseur sur une voix (coupe-bas de la règle maison, bandes des macros du One Knob) ;
  // jamais sur un bus voix (son coupe-bas couperait le grave du lead).
  if (!p.bus) {
    const eq = p.eq || { hp: p.role === 'lead' ? HOUSE_RULES.leadHighpassHz : HOUSE_RULES.otherHighpassHz };
    out.push({ type: 'PROEQ12', params: { masterGain: 1, bands: buildEqBands(eq) } });
  }
  if (p.comp1) {
    out.push({
      type: 'COMPRESSOR',
      params: {
        threshold: calib.thr1, ratio: HOUSE_RULES.ratio, knee: p.comp1.knee ?? 6, attack: p.comp1.attackMs / 1000, release: p.comp1.releaseMs / 1000,
        makeupGain: 1, autoMakeup: false, mix: 1, scHpFreq: 100, lookahead: 0, mode: p.comp1.mode || 'CLEAN',
      },
    });
  }
  if (p.deess) {
    out.push({ type: 'DEESSER', params: { threshold: -40, frequency: p.deess.freq, q: 1.0, reduction: p.deess.depth, mode: 'BELL', detection: 'RELATIVE', relThreshold: -6, listen: 0 } });
  }
  if (p.comp2?.kind === 'OPTO_VINTAGE') {
    out.push({
      type: 'OPTO_VINTAGE',
      params: { ...ANALOG_SPECS.OPTO_VINTAGE.defaults, threshold: calib.thr2, ratio: HOUSE_RULES.ratio, attack: p.comp2.attack, release: p.comp2.release, mode: p.comp2.mode ?? 1, output: calib.levelDb, mix: 100, scLowCut: 80, vintage: 0 },
    });
  } else if (p.comp2?.kind === 'VOXSTRIP') {
    const c = p.comp2;
    const eqOn = (c.loPeak || c.midDip || c.hiPeak) ? 1 : 0;
    out.push({
      type: 'VOXSTRIP',
      params: {
        ...ANALOG_SPECS.VOXSTRIP.defaults, input: 5, compThresh: calib.thr2, attack: c.attack, release: c.release,
        loPeak: c.loPeak ?? 0, loFreq: c.loFreq ?? 3, midDip: c.midDip ?? 0, midFreq: c.midFreq ?? 1, hiPeak: c.hiPeak ?? 0, hiFreq: c.hiFreq ?? 8,
        eqOn, compOn: 1, lowCut: 0, transformer: 1, output: calib.levelDb, mix: 100,
      },
    });
  }
  if (p.bus) {
    out.push({ type: 'FET76', params: { ...ANALOG_SPECS.FET76.defaults, input: calib.thr1, output: calib.busOut ?? -15, ratio: p.bus.fetRatio, attack: p.bus.fetAttack, release: p.bus.fetRelease, slo: 0, mix: 100 } });
    if (p.bus.leveler) out.push({ type: 'LEVELER2A', params: { ...ANALOG_SPECS.LEVELER2A.defaults, peakReduction: calib.thr2, gain: calib.busGain ?? 25, limit: 0, emphasis: 0, mix: 100 } });
  }
  if (p.sat) out.push({ type: 'VOCALSATURATOR', params: { drive: p.sat.drive, mix: p.sat.mix, tone: p.sat.tone ?? 0, eqLow: 0, eqMid: 0, eqHigh: 0, mode: p.sat.mode, outputGain: 1 } });
  if (p.lofi) out.push({ type: 'LOFI', params: { ...V21_DEFAULTS.LOFI(), ...p.lofi, mix: p.lofi.mix ?? 1, output: 0 } });
  if (p.width) out.push({ type: 'DOUBLER', params: { detune: p.width.detune, width: p.width.width, gainL: p.width.gain, gainR: p.width.gain, directOn: p.width.directOn ?? true } });
  return out;
}

const REGISTERED_NAMES: Partial<Record<PluginType, string>> = {
  OPTO_VINTAGE: 'Opto Vintage', VOXSTRIP: 'Vox Strip', FET76: 'FET 76', LEVELER2A: 'Leveler 2A',
  LOFI: 'Lo-fi / téléphone', VOICESHIFT: 'Voix grave / aiguë',
};

let pluginSeq = 0;
/** Effet NOVA prêt à poser sur une piste (même forme que createDefaultPlugins). */
export function makeVoicePlugin(type: PluginType, params: Record<string, any>, idPrefix = 'pl-voix'): PluginInstance {
  pluginSeq = (pluginSeq + 1) % 1e6;
  return {
    id: `${idPrefix}-${type.toLowerCase()}-${Date.now().toString(36)}-${pluginSeq}`,
    name: REGISTERED_NAMES[type] || type,
    type,
    isEnabled: true,
    params: { ...structuredClone(params), isEnabled: true },
    latency: 0,
  };
}

// ---------------------------------------------------------------------------
// Bibliothèque
// ---------------------------------------------------------------------------

export const VOICE_PRESETS: VoicePreset[] = PRESET_DEFS.map(d => ({ ...d, calib: VOICE_PRESET_CALIB[d.id] || NEUTRAL_CALIB }));

export const findVoicePreset = (idOrName?: string | null): VoicePreset | undefined => {
  if (!idOrName) return undefined;
  const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
  const q = norm(String(idOrName));
  return VOICE_PRESETS.find(p => p.id === idOrName) || VOICE_PRESETS.find(p => norm(p.id) === q) || VOICE_PRESETS.find(p => norm(p.name) === q);
};

/** Presets d'un style et / ou d'un rôle (ordre de la bibliothèque). */
export const voicePresetsFor = (filter: { style?: VoicePresetStyle | null; role?: VoicePresetRole | null } = {}) =>
  VOICE_PRESETS.filter(p => (!filter.style || p.style === filter.style) && (!filter.role || p.role === filter.role));

/** Rôle d'une piste voix d'après son nom (BACK, DOUBLE, ADLIB, HARMO…) ; lead par défaut. */
export function roleFromTrackName(name: string): VoicePresetRole {
  const n = (name || '').toUpperCase();
  if (/HARMO/.test(n)) return 'harmony';
  if (/AD.?LIB|ADLIB|\bADD\b|\bAD\b/.test(n)) return 'adlib';
  if (/DOUBLE|DBL|\bDB\b/.test(n)) return 'double';
  if (/BACK|CHOEUR|CHŒUR/.test(n)) return 'back';
  if (/BUS/.test(n)) return 'bus';
  return 'lead';
}

// ---------------------------------------------------------------------------
// Application sur une piste
// ---------------------------------------------------------------------------

export const SEND_IDS = { delay: 'send-delay', verbShort: 'send-verb-short', verbLong: 'send-verb-long' } as const;

/** Trim d'entrée (dB) qui amène une prise mesurée à `lufs` au niveau de référence ; 0 si inconnu. */
export function trimFor(lufs: number | null | undefined): number {
  if (lufs === null || lufs === undefined || !Number.isFinite(lufs) || lufs < -70) return 0;
  return Math.round(Math.max(TRIM_RANGE.min, Math.min(TRIM_RANGE.max, REF_INPUT_LUFS - lufs)) * 10) / 10;
}

export interface ApplyVoicePresetOptions {
  /** Pistes du projet (retours d'effets, côté des voix secondaires). */
  allTracks: Track[];
  /** LUFS intégrés de la prise (mono, gain des clips compris) ; absent : trim de la tranche inchangé. */
  inputLufs?: number | null;
  /** Tonalité du projet pour Nova Tune (sinon chromatique). */
  projectKey?: number | null;
  projectScale?: string | null;
  /** Garder le fader et le pan de la piste (Décris ton son sur une piste déjà équilibrée). */
  keepFader?: boolean;
}

/**
 * Pose un preset sur une piste : chaîne d'effets (avec le gain d'entrée calé sur la
 * prise), envois vers les retours existants, fader et pan (côté alterné pour les voix
 * secondaires). Pur : renvoie la nouvelle piste (une seule modification = un Ctrl+Z)
 * et des remarques (« retour Écho absent »…).
 */
export function applyVoicePreset(track: Track, preset: VoicePreset, opts: ApplyVoicePresetOptions): { track: Track; notes: string[]; trimDb: number } {
  const notes: string[] = [];
  const trimDb = trimFor(opts.inputLufs);
  if (opts.inputLufs !== undefined && opts.inputLufs !== null && Number.isFinite(opts.inputLufs)) {
    const want = REF_INPUT_LUFS - opts.inputLufs;
    if (want > TRIM_RANGE.max + 0.05) notes.push(`prise très faible (${Math.round(opts.inputLufs)} LUFS) : monte le gain du clip, puis repose le preset`);
    if (want < TRIM_RANGE.min - 0.05) notes.push(`prise très forte (${Math.round(opts.inputLufs)} LUFS) : baisse le gain du clip et vérifie qu'elle ne sature pas`);
  }
  const keyKnown = typeof opts.projectKey === 'number' && !!opts.projectScale;
  const plugins = presetChain(preset, preset.calib).map(item => makeVoicePlugin(item.type,
    item.type === 'AUTOTUNE' ? { ...item.params, rootKey: keyKnown ? opts.projectKey : 0, scale: keyKnown ? opts.projectScale : 'CHROMATIC' } : item.params));
  // Envois : vers les retours qui existent dans le projet.
  const sends = (track.sends || []).map(s => ({ ...s }));
  (Object.keys(SEND_IDS) as (keyof typeof SEND_IDS)[]).forEach(k => {
    const id = SEND_IDS[k];
    const level = preset.sends[k];
    const has = opts.allTracks.some(t => t.id === id);
    const cur = sends.find(s => s.id === id);
    if (cur) { cur.level = level; cur.isEnabled = level > 0 ? true : cur.isEnabled; }
    else if (has && level > 0) sends.push({ id, level, isEnabled: true });
    else if (!has && level > 0) notes.push(`retour « ${k === 'delay' ? 'Écho' : k === 'verbShort' ? 'Réverbe courte' : 'Réverbe longue'} » absent du projet : envoi non posé`);
  });
  let volume = track.volume, pan = track.pan;
  if (!opts.keepFader) {
    volume = Math.round(dbToGain(preset.volumeDb) * 1000) / 1000;
    pan = preset.pan ? preset.pan * sideFor(track, preset.role, opts.allTracks) : 0;
  }
  const voiceChain: VoiceChainState = { presetId: preset.id, trimDb };
  // Trim d'entrée de la tranche (avant les effets) : calé sur la prise, ou laissé tel quel si la prise est inconnue.
  const inputTrimDb = opts.inputLufs !== undefined && opts.inputLufs !== null && Number.isFinite(opts.inputLufs) ? trimDb : track.inputTrimDb;
  return { track: { ...track, plugins, sends, volume, pan, inputTrimDb, voiceChain }, notes, trimDb };
}

/** Côté d'une voix secondaire : celui des deux qui a le moins de voix du même rôle (gauche d'abord). */
function sideFor(track: Track, role: VoicePresetRole, all: Track[]): -1 | 1 {
  if (track.pan < -0.05) return -1;
  if (track.pan > 0.05) return 1;
  let left = 0, right = 0;
  for (const t of all) {
    if (t.id === track.id || !t.voiceChain?.presetId) continue;
    if (findVoicePreset(t.voiceChain.presetId)?.role !== role) continue;
    if (t.pan < -0.05) left++; else if (t.pan > 0.05) right++;
  }
  return left <= right ? -1 : 1;
}

/** Résumé lisible d'un preset (liste, chat). */
export function describeVoicePreset(p: PresetDef): string {
  const parts: string[] = [];
  if (p.tune) parts.push(p.tune.ms <= 5 ? 'Nova Tune robot' : `Nova Tune ${p.tune.ms} ms`);
  if (p.shift) parts.push(`voix ${p.shift.pitch < 0 ? 'grave' : p.shift.pitch > 0 ? 'aiguë' : 'retimbrée'}`);
  const eq = p.eq;
  if (eq) parts.push(`coupe-bas ${eq.hp} Hz${eq.lp ? `, coupe-haut ${eq.lp >= 1000 ? `${eq.lp / 1000} kHz` : `${eq.lp} Hz`}` : ''}`);
  if (p.comp1 && p.comp2) parts.push(`2 compresseurs 2:1 (${p.comp2.kind === 'VOXSTRIP' ? 'Vox Strip' : 'Opto Vintage'})`);
  if (p.bus) parts.push(`FET 76${p.bus.leveler ? ' + Leveler 2A' : ''}`);
  if (p.deess) parts.push(`de-esser ${p.deess.freq / 1000} kHz`);
  if (p.sat) parts.push('saturation');
  if (p.lofi) parts.push('filtre lo-fi');
  if (p.width) parts.push('doubleur');
  const fx = [p.sends.verbShort > 0 && 'réverbe', p.sends.verbLong > 0 && 'réverbe longue', p.sends.delay > 0 && 'écho'].filter(Boolean);
  if (fx.length) parts.push(`${fx.join(' + ')} en envoi`);
  return parts.join(' · ');
}
