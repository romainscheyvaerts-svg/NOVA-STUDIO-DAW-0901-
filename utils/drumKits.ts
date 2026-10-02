import { Clip, DrumPad, TrackType } from '../types';
import { FACTORY_KITS } from './drumFactory';

/**
 * Boîte à rythmes Make Music : 8 rangées de pads, un motif de 16 pas par
 * mesure (1 ou 2 mesures), vélocités, « rolls » (×2 ×3 ×4 sur un pas, pour
 * les hi-hats trap / drill) et swing. Les kits partent des rythmes d'usine du
 * sampler Make Music, enrichis par genre (808 suivant le kick, rolls…).
 */

export interface DrumRow {
  id: string;
  name: string;
  /** Référence de son (voir utils/drumSounds.ts). */
  sound: string;
  /** Vélocité 0-127 par pas (longueur = 16 × mesures). */
  steps: number[];
  /** Répétitions par pas (1 = normal, 2-4 = roll). */
  ratchet: number[];
  volume: number;
  pan: number;
  /** Les pads d'un même groupe se coupent (hi-hat fermé / ouvert, 808). */
  choke?: number;
}

export interface DrumMachine {
  kitId: string;
  bars: 1 | 2;
  swing: number; // 0 - 0.6
  rows: DrumRow[];
}

export interface DrumKitDef {
  id: string;
  name: string;
  emoji: string;
  bpm: number;
  build: () => DrumRow[];
}

const STEPS = 16;
const z = () => new Array(STEPS).fill(0);
const one = () => new Array(STEPS).fill(1);
const at = (vel: number, ...pos: number[]) => { const a = z(); pos.forEach(p => { a[p] = vel; }); return a; };

/** Rangées standard : l'ordre donne les notes MIDI (60 = rangée 1). */
const ROW_DEFS: { id: string; name: string; sound: string; choke?: number; volume?: number; pan?: number }[] = [
  { id: 'kick', name: 'Kick', sound: 'synth:kick-punch' },
  { id: '808', name: '808', sound: 'synth:808', choke: 2, volume: 0.9 },
  { id: 'snare', name: 'Snare', sound: 'synth:snare-crisp' },
  { id: 'clap', name: 'Clap', sound: 'synth:clap' },
  { id: 'hatc', name: 'Hi-hat fermé', sound: 'synth:hat-closed', choke: 1, volume: 0.7, pan: 0.15 },
  { id: 'hato', name: 'Hi-hat ouvert', sound: 'synth:hat-open', choke: 1, volume: 0.6, pan: 0.15 },
  { id: 'perc', name: 'Perc', sound: 'synth:perc-conga', volume: 0.7, pan: -0.2 },
  { id: 'fx', name: 'Rim / Crash', sound: 'synth:rim', volume: 0.7, pan: -0.1 },
];

const blankRows = (): DrumRow[] => ROW_DEFS.map(d => ({
  id: d.id, name: d.name, sound: d.sound, steps: z(), ratchet: one(), volume: d.volume ?? 0.85, pan: d.pan ?? 0, choke: d.choke,
}));

/** Rangée cible d'un pad d'usine d'après son nom. */
const factoryRowFor = (name: string): string | null => {
  const n = name.toLowerCase();
  if (n.includes('kick')) return 'kick';
  if (n.includes('snare')) return 'snare';
  if (n.includes('clap')) return 'clap';
  if (n.includes('ouvert') || n.includes('open')) return 'hato';
  if (n.includes('hat')) return 'hatc';
  if (n.includes('perc')) return 'perc';
  if (n.includes('rim') || n.includes('crash')) return 'fx';
  return null;
};

function fromFactory(name: string): DrumRow[] {
  const rows = blankRows();
  const k = FACTORY_KITS.find(f => f.name.toLowerCase().startsWith(name.toLowerCase()));
  if (!k) return rows;
  k.pads.forEach((pad, i) => {
    const id = factoryRowFor(pad);
    const row = rows.find(r => r.id === id);
    if (row && k.rows[i]) row.steps = k.rows[i].slice(0, STEPS).map(v => Math.max(0, Math.min(127, v | 0)));
    if (id === 'fx' && /crash/i.test(pad) && row) row.sound = 'synth:crash';
  });
  return rows;
}

const set = (rows: DrumRow[], id: string, patch: Partial<DrumRow>) => {
  const r = rows.find(x => x.id === id); if (r) Object.assign(r, patch);
};

/** Enrichissements par genre : ce qu'un beatmaker ajouterait au motif d'usine. */
export const DRUM_KITS: DrumKitDef[] = [
  { id: 'trap', name: 'Trap', emoji: '🔥', bpm: 140, build: () => {
    const r = fromFactory('Trap');
    set(r, 'kick', { sound: 'synth:kick-boom' });
    set(r, '808', { steps: at(110, 0, 7, 10) });
    set(r, 'hatc', { sound: 'synth:hat-tight', steps: Array.from({ length: STEPS }, (_, i) => (i % 2 === 0 ? (i % 4 === 0 ? 100 : 80) : 0)), ratchet: one().map((_, i) => (i === 6 || i === 14 ? 3 : i === 11 ? 2 : 1)) });
    // roll : les pas 6, 11 et 14 doivent jouer
    const hat = r.find(x => x.id === 'hatc')!; hat.steps[6] = hat.steps[6] || 80; hat.steps[11] = 70; hat.steps[14] = hat.steps[14] || 80;
    return r;
  } },
  { id: 'drill', name: 'Drill', emoji: '🔪', bpm: 142, build: () => {
    const r = fromFactory('Drill');
    set(r, 'kick', { sound: 'synth:kick-boom' });
    set(r, '808', { sound: 'synth:808-dist', steps: at(115, 0, 3, 6, 10, 13) });
    set(r, 'snare', { sound: 'synth:snare-fat' });
    const hat = r.find(x => x.id === 'hatc')!; hat.sound = 'synth:hat-tight';
    hat.ratchet = one().map((_, i) => (i === 7 ? 3 : i === 15 ? 2 : 1)); hat.steps[7] = hat.steps[7] || 80; hat.steps[15] = hat.steps[15] || 75;
    set(r, 'perc', { sound: 'synth:rim', steps: at(70, 11) });
    return r;
  } },
  { id: 'boombap', name: 'Boom Bap', emoji: '🎤', bpm: 90, build: () => {
    const r = fromFactory('Boom Bap');
    set(r, 'kick', { sound: 'synth:kick-dusty' });
    set(r, 'snare', { sound: 'synth:snare-fat' });
    set(r, 'perc', { sound: 'synth:shaker', steps: at(55, 2, 6, 10, 14) });
    return r;
  } },
  { id: 'rnb', name: 'R&B', emoji: '🎶', bpm: 72, build: () => {
    const r = fromFactory('R&B');
    set(r, 'snare', { sound: 'synth:snap', name: 'Snap' });
    set(r, '808', { steps: at(95, 0, 10) });
    set(r, 'perc', { sound: 'synth:shaker', steps: at(50, 3, 7, 11, 15) });
    return r;
  } },
  { id: 'afro', name: 'Afrobeats', emoji: '🌍', bpm: 105, build: () => {
    const r = fromFactory('Afrobeats');
    set(r, 'fx', { sound: 'synth:rim', steps: at(80, 3, 6, 10, 13) });
    set(r, 'perc', { sound: 'synth:perc-conga' });
    return r;
  } },
  { id: 'amapiano', name: 'Amapiano', emoji: '🎹', bpm: 112, build: () => {
    const r = fromFactory('Amapiano');
    set(r, 'perc', { sound: 'synth:perc-log', name: 'Log drum', steps: at(110, 0, 3, 6, 11, 14), volume: 0.8 });
    set(r, 'fx', { sound: 'synth:shaker', steps: Array.from({ length: STEPS }, (_, i) => (i % 2 ? 50 : 30)) });
    return r;
  } },
  { id: 'dembow', name: 'Reggaeton', emoji: '💃', bpm: 95, build: () => fromFactory('Reggaeton') },
  { id: 'dancehall', name: 'Dancehall', emoji: '🇯🇲', bpm: 100, build: () => fromFactory('Dancehall') },
  { id: 'pop', name: 'Pop', emoji: '✨', bpm: 110, build: () => { const r = fromFactory('Pop'); set(r, 'clap', { steps: at(90, 4, 12) }); return r; } },
  { id: 'house', name: 'House', emoji: '🏠', bpm: 124, build: () => fromFactory('House') },
  { id: 'ukg', name: 'UK Garage', emoji: '🇬🇧', bpm: 132, build: () => fromFactory('UK Garage') },
  { id: 'dnb', name: 'Drum & Bass', emoji: '⚡', bpm: 174, build: () => fromFactory('Drum & Bass') },
  { id: 'reggae', name: 'Reggae', emoji: '🌴', bpm: 80, build: () => fromFactory('Reggae') },
  { id: 'funk', name: 'Funk', emoji: '🕺', bpm: 100, build: () => fromFactory('Funk') },
  { id: 'empty', name: 'Vide', emoji: '⬜', bpm: 120, build: () => blankRows() },
];

/** Kit proposé d'office d'après le genre / tempo du morceau. */
export function suggestDrumKit(bpm: number, genre?: string | null, title?: string | null): string {
  const g = `${genre || ''} ${title || ''}`.toLowerCase();
  if (/drill/.test(g)) return 'drill';
  if (/amapiano|piano/.test(g)) return 'amapiano';
  if (/afro|zouk|kompa/.test(g)) return 'afro';
  if (/reggaeton|dembow|latin/.test(g)) return 'dembow';
  if (/r ?&? ?b|rnb|soul|love/.test(g)) return 'rnb';
  if (/boom ?bap|old ?school|lofi|jazz/.test(g)) return 'boombap';
  if (/house/.test(g)) return 'house';
  if (/trap|cloud|rage|plugg/.test(g)) return 'trap';
  if (bpm >= 160 && bpm < 200) return 'dnb';
  if (bpm >= 125) return 'trap';
  if (bpm <= 80) return 'rnb';
  return 'boombap';
}

export function makeDrumMachine(kitId: string): DrumMachine {
  const kit = DRUM_KITS.find(k => k.id === kitId) || DRUM_KITS[0];
  return { kitId: kit.id, bars: 1, swing: kit.id === 'boombap' ? 0.25 : kit.id === 'rnb' ? 0.15 : 0, rows: kit.build() };
}

/** Passe le motif à 1 ou 2 mesures (la 2e reprend la 1re). */
export function setBars(dm: DrumMachine, bars: 1 | 2): DrumMachine {
  const len = STEPS * bars;
  return {
    ...dm, bars,
    rows: dm.rows.map(r => ({
      ...r,
      steps: Array.from({ length: len }, (_, i) => r.steps[i] ?? r.steps[i % STEPS] ?? 0),
      ratchet: Array.from({ length: len }, (_, i) => r.ratchet[i] ?? r.ratchet[i % STEPS] ?? 1),
    })),
  };
}

/** Pads du drum rack (moteur) : id = rangée + 1, note MIDI = 59 + id. */
export function drumPadsFor(dm: DrumMachine): DrumPad[] {
  return dm.rows.map((r, i) => ({
    id: i + 1, name: r.name, sampleName: r.sound, volume: r.volume, pan: r.pan,
    isMuted: false, isSolo: false, midiNote: 60 + i, audioRef: `nova-drum:${r.sound}`,
    // le groupe de choke voyage avec le pad (lu par DrumRackNode)
    ...(r.choke ? { chokeGroup: r.choke } as any : {}),
  }));
}

/**
 * Clip MIDI de la batterie : le motif répété de `start` à `end` (s), au tempo
 * du projet, avec swing et rolls.
 */
export function drumClipFor(dm: DrumMachine, bpm: number, start: number, end: number, clipId: string): Clip {
  const stepDur = 60 / bpm / 4;
  const patLen = STEPS * dm.bars;
  const total = Math.max(stepDur * patLen, end - start);
  const notes: { id: string; pitch: number; start: number; duration: number; velocity: number }[] = [];
  const nSteps = Math.floor(total / stepDur + 1e-6);
  for (let s = 0; s < nSteps; s++) {
    const ps = s % patLen;
    const swing = ps % 2 === 1 ? dm.swing * stepDur * 0.5 : 0;
    dm.rows.forEach((r, ri) => {
      const v = r.steps[ps] || 0;
      if (v <= 0) return;
      const n = Math.max(1, Math.min(4, r.ratchet[ps] || 1));
      for (let k = 0; k < n; k++) {
        const t = s * stepDur + swing + (k * stepDur) / n;
        notes.push({ id: `d${s}-${ri}-${k}`, pitch: 60 + ri, start: t, duration: Math.min(0.1, stepDur / n), velocity: Math.min(1, (v / 127) * (k === 0 ? 1 : 0.8)) });
      }
    });
  }
  return {
    id: clipId, name: 'Batterie', type: TrackType.MIDI, start, duration: nSteps * stepDur, offset: 0,
    fadeIn: 0, fadeOut: 0, color: '#f97316', notes,
  } as unknown as Clip;
}
