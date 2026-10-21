import type { Clip, MidiNote, Track } from '../../types';
import { arpSequence, arpRateBeats, type ArpPattern, type ArpRate } from '../../services/MidiEffectsService';
import { CHORD_INTERVALS, diatonicChord, snapToScale } from '../../utils/scales';
import { quartersToTime, timeToQuarters, tempoMapStore, type TempoMap } from '../../utils/tempoMap';

/**
 * L3 · Effets MIDI en temps réel (arpège, accord, gamme forcée) sur une piste
 * MIDI : posés AVANT l'instrument, ils transforment les notes jouées, sans
 * toucher aux notes du clip (on les règle pendant la lecture ; « Figer en
 * notes » les écrit dans le clip).
 *
 * Même calcul en lecture, à l'export et pour le rendu d'un instrument du PC :
 * le moteur lit `clipsWithMidiFx(track, clips)` à la place des clips (lecture
 * = export). L'arpège est calé sur la grille du MORCEAU (piste tempo et rampes
 * comprises), pas sur le début du clip : deux clips à la suite enchaînent sans
 * trou. Aléatoire reproductible (même graine = mêmes notes à chaque lecture).
 *
 * Réglages par défaut neutres (aucun préréglage inventé) : arpège montant à la
 * croche, 1 octave, notes à 90 % du pas ; accord dans la gamme du projet ;
 * gamme du projet. Le clavier en direct passe par engine/midiFx/live.
 *
 * Module pur (hors contexte : tonalité du projet et carte des tempos lues dans
 * des stores) : tests/midiFx.test.ts.
 */

export type MidiFxType = 'arp' | 'chord' | 'scale';
export type ChordShape = 'DIATONIC' | keyof typeof CHORD_INTERVALS;

export interface MidiFxArp { rate: ArpRate; pattern: ArpPattern; octaves: number; /** Longueur de chaque note, % du pas (5 à 100). */ gate: number }
export interface MidiFxChord { shape: ChordShape }
export interface MidiFxScale {
  /** Tonique (0 = Do) ; absente : tonalité du projet. */
  root?: number;
  /** Gamme (utils/scales) ; absente : gamme du projet. */
  scale?: string;
  dir?: 'nearest' | 'up' | 'down';
}

export interface MidiFxSlot {
  id: string;
  type: MidiFxType;
  on: boolean;
  arp?: MidiFxArp;
  chord?: MidiFxChord;
  scale?: MidiFxScale;
}

export const ARP_RATES: ArpRate[] = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
export const FX_LABEL: Record<MidiFxType, string> = { arp: 'Arpège', chord: 'Accord', scale: 'Gamme forcée' };

export const defaultSlot = (type: MidiFxType, id = `mfx-${type}-${Date.now().toString(36)}`): MidiFxSlot => ({
  id, type, on: true,
  ...(type === 'arp' ? { arp: { rate: '1/8', pattern: 'UP', octaves: 1, gate: 90 } as MidiFxArp } : {}),
  ...(type === 'chord' ? { chord: { shape: 'DIATONIC' } as MidiFxChord } : {}),
  ...(type === 'scale' ? { scale: { dir: 'nearest' } as MidiFxScale } : {}),
});

// --- Contexte : tonalité du projet (posée par App) -------------------------------------

export interface ProjectKey { root: number; scale: string }
let projectKey: ProjectKey | null = null;
export const midiFxKeyStore = {
  get: () => projectKey,
  set(k: ProjectKey | null) { projectKey = k; },
};

const RATES = new Set<string>(['1/1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/4T', '1/8T', '1/16T']);
const PATTERNS = new Set<string>(['UP', 'DOWN', 'UP_DOWN', 'DOWN_UP', 'RANDOM', 'ORDER', 'CONVERGE', 'DIVERGE', 'PINKY_UP', 'PINKY_DOWN']);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Réglages reçus (projet ouvert, collaboration) : bornés, champs inconnus retirés. 8 effets au plus. */
export function sanitizeMidiFx(raw: unknown): MidiFxSlot[] {
  if (!Array.isArray(raw)) return [];
  const out: MidiFxSlot[] = [];
  for (const r of raw.slice(0, 8)) {
    if (!r || typeof r !== 'object') continue;
    const type = (r as any).type;
    if (type !== 'arp' && type !== 'chord' && type !== 'scale') continue;
    const s: MidiFxSlot = { id: typeof (r as any).id === 'string' ? (r as any).id.slice(0, 64) : `mfx-${out.length}`, type, on: (r as any).on !== false };
    if (type === 'arp') {
      const a = (r as any).arp || {};
      s.arp = { rate: RATES.has(a.rate) ? a.rate : '1/8', pattern: PATTERNS.has(a.pattern) ? a.pattern : 'UP', octaves: clamp(Math.round(Number(a.octaves) || 1), 1, 4), gate: clamp(Number(a.gate) || 90, 5, 100) };
    } else if (type === 'chord') {
      const c = (r as any).chord || {};
      s.chord = { shape: c.shape === 'DIATONIC' || c.shape in CHORD_INTERVALS ? c.shape : 'DIATONIC' };
    } else {
      const g = (r as any).scale || {};
      s.scale = {
        ...(Number.isInteger(g.root) && g.root >= 0 && g.root < 12 ? { root: g.root } : {}),
        ...(typeof g.scale === 'string' && g.scale.length < 32 ? { scale: g.scale } : {}),
        dir: g.dir === 'up' || g.dir === 'down' ? g.dir : 'nearest',
      };
    }
    out.push(s);
  }
  return out;
}

export const activeFx = (t: Pick<Track, 'midiFx' | 'type'>): MidiFxSlot[] => (t.midiFx || []).filter(s => s.on);

// --- Transformations (temps relatifs au clip) ---------------------------------------------

export interface FxContext {
  /** Début du clip (s). */
  clipStart: number;
  /** Longueur du clip (s) : l'arpège s'arrête à la fin du clip. */
  clipDuration: number;
  map: TempoMap;
  key: ProjectKey | null;
  /** Graine de l'aléatoire (identifiant du clip). */
  seed: string;
}

const keyOf = (s: MidiFxScale | undefined, k: ProjectKey | null): ProjectKey => ({
  root: s?.root ?? k?.root ?? 0,
  scale: s?.scale ?? k?.scale ?? 'CHROMATIC',
});

function forceScale(notes: MidiNote[], p: MidiFxScale | undefined, ctx: FxContext): MidiNote[] {
  const k = keyOf(p, ctx.key);
  const seen = new Set<string>();
  const out: MidiNote[] = [];
  for (const n of notes) {
    const pitch = snapToScale(n.pitch, k.root, k.scale, p?.dir || 'nearest');
    // Deux touches qui tombent sur la même note de la gamme au même instant : une seule note.
    const key = `${pitch}@${Math.round(n.start * 1e6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pitch === n.pitch ? n : { ...n, pitch });
  }
  return out;
}

function addChords(notes: MidiNote[], p: MidiFxChord | undefined, ctx: FxContext): MidiNote[] {
  const shape = p?.shape || 'DIATONIC';
  const out: MidiNote[] = [];
  const seen = new Set<string>();
  const push = (n: MidiNote) => {
    const key = `${n.pitch}@${Math.round(n.start * 1e6)}`;
    if (seen.has(key) || n.pitch < 0 || n.pitch > 127) return;
    seen.add(key); out.push(n);
  };
  for (const n of notes) {
    const k = ctx.key;
    const pitches = shape === 'DIATONIC'
      ? (k ? diatonicChord(n.pitch, k.root, k.scale) : CHORD_INTERVALS.MAJOR.map(i => n.pitch + i))
      : CHORD_INTERVALS[shape].map(i => n.pitch + i);
    // La note jouée reste la fondamentale (une note hors gamme décale l'accord avec elle).
    const delta = n.pitch - pitches[0];
    push(n);
    for (let i = 1; i < pitches.length; i++) push({ ...n, id: `${n.id}~c${i}`, pitch: pitches[i] + delta });
  }
  return out;
}

/** Hachage FNV (graine + pas) → 0…1 : aléatoire reproductible. */
function rnd(seed: string, k: number): number {
  let h = 0x811c9dc5;
  const s = `${seed}:${k}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h / 4294967296;
}

function arpeggiate(notes: MidiNote[], p: MidiFxArp | undefined, ctx: FxContext): MidiNote[] {
  if (!notes.length) return notes;
  const a = p || { rate: '1/8', pattern: 'UP', octaves: 1, gate: 90 };
  const stepQ = arpRateBeats(a.rate) || 0.5;
  const { map } = ctx;
  const q = (t: number) => timeToQuarters(map, ctx.clipStart + t);
  const half = stepQ / 2;
  const spans = notes.map(n => ({ n, qs: q(n.start), qe: q(n.start + n.duration) }));
  const qClipEnd = q(ctx.clipDuration);
  const first = Math.ceil((Math.min(...spans.map(s => s.qs)) - half) / stepQ - 1e-9);
  const last = Math.min(qClipEnd, Math.max(...spans.map(s => s.qe)));
  const out: MidiNote[] = [];
  let counter = 0;
  let prevEmpty = true;
  for (let k = first; k * stepQ < last - 1e-9 && k - first < 20000; k++) {
    const t = k * stepQ;
    // Note « tenue » au pas t : sa durée couvre le pas (arrondie au pas le plus proche).
    const held = spans.filter(s => s.qs - half <= t + 1e-9 && s.qe - half > t + 1e-9);
    if (!held.length) { prevEmpty = true; continue; }
    if (prevEmpty) counter = 0;
    prevEmpty = false;
    const ordered = a.pattern === 'ORDER' ? [...held].sort((x, y) => x.qs - y.qs || x.n.pitch - y.n.pitch) : held;
    const pitches = ordered.map(s => s.n.pitch);
    const seq = a.pattern === 'RANDOM' ? arpSequence(pitches, 'UP', a.octaves) : arpSequence(pitches, a.pattern, a.octaves);
    if (!seq.length) continue;
    const idx = a.pattern === 'RANDOM' ? Math.floor(rnd(ctx.seed, k) * seq.length) : counter % seq.length;
    counter++;
    const start = quartersToTime(map, t) - ctx.clipStart;
    const end = quartersToTime(map, t + stepQ * clamp(a.gate, 5, 100) / 100) - ctx.clipStart;
    if (start < -1e-9 || start >= ctx.clipDuration - 1e-9) continue;
    const vel = Math.max(...held.map(s => s.n.velocity));
    out.push({ id: `arp~${k}`, pitch: clamp(seq[idx], 0, 127), start: Math.max(0, start), duration: Math.max(0.005, end - start), velocity: vel });
  }
  return out;
}

/** Notes entendues d'un clip après la chaîne d'effets (dans l'ordre de la chaîne). */
export function applyMidiFx(notes: MidiNote[], slots: MidiFxSlot[], ctx: FxContext): MidiNote[] {
  let cur = notes;
  for (const s of slots) {
    if (!s.on) continue;
    if (s.type === 'scale') cur = forceScale(cur, s.scale, ctx);
    else if (s.type === 'chord') cur = addChords(cur, s.chord, ctx);
    else if (s.type === 'arp') cur = arpeggiate(cur, s.arp, ctx);
  }
  return cur === notes ? notes : [...cur].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

// --- Branchement moteur (lecture, export, rendu d'instrument) -----------------------------

const clipCache = new WeakMap<Clip, { slots: MidiFxSlot[]; map: TempoMap; key: ProjectKey | null; out: Clip }>();
const arrCache = new WeakMap<Clip[], { slots: MidiFxSlot[]; map: TempoMap; key: ProjectKey | null; out: Clip[] }>();

/**
 * Clips d'une piste tels que l'instrument les entend : mêmes objets si la piste
 * n'a aucun effet MIDI actif (coût nul), sinon des copies aux notes transformées
 * (mémorisées tant que clip, réglages, tempo et tonalité ne changent pas).
 */
export function clipsWithMidiFx(track: Pick<Track, 'midiFx' | 'type'>, clips: Clip[], map: TempoMap = tempoMapStore.get(), key: ProjectKey | null = midiFxKeyStore.get()): Clip[] {
  const slots = track.midiFx;
  if (!slots || !slots.some(s => s.on)) return clips;
  // Même liste de clips, mêmes réglages : même tableau (les caches du moteur, 808 comprise, restent valables).
  const arr = arrCache.get(clips);
  if (arr && arr.slots === slots && arr.map === map && arr.key === key) return arr.out;
  const out = clips.map(c => {
    if (!Array.isArray(c.notes) || !c.notes.length) return c;
    const hit = clipCache.get(c);
    if (hit && hit.slots === slots && hit.map === map && hit.key === key) return hit.out;
    const out: Clip = { ...c, notes: applyMidiFx(c.notes, slots, { clipStart: c.start, clipDuration: c.duration, map, key, seed: c.id }) };
    clipCache.set(c, { slots, map, key, out });
    return out;
  });
  arrCache.set(clips, { slots, map, key, out });
  return out;
}

/** « Figer en notes » : les notes entendues écrites dans les clips, effets coupés (une étape d'annulation). */
export function freezeMidiFx(track: Track, map: TempoMap = tempoMapStore.get(), key: ProjectKey | null = midiFxKeyStore.get()): Track {
  if (!activeFx(track).length) return track;
  const clips = clipsWithMidiFx(track, track.clips, map, key).map((c, i) => {
    const src = track.clips[i];
    if (c === src) return c;
    // Identifiants neufs et stables (le piano roll et la collaboration suivent les notes par identifiant).
    return { ...src, notes: (c.notes || []).map((n, j) => ({ ...n, id: `${src.id}-fx${j}` })) };
  });
  return { ...track, clips, midiFx: (track.midiFx || []).map(s => ({ ...s, on: false })) };
}
