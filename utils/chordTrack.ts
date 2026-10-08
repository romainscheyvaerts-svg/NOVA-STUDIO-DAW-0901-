/**
 * Piste d'accords (V20, Chord Track de Logic) : édition, sauvegarde dans le
 * projet (DAWState.chords), collaboration (opération « chords », comme les
 * repères : le plus récent du journal gagne, accord par accord) et
 * détection sur les clips du beat.
 *
 * Logique pure + deux petits magasins (affichage du couloir, accords en
 * cours pour le piano roll). Tests : tests/chordTrack.test.ts.
 */
import { useSyncExternalStore } from 'react';
import { CHORD_QUALITIES, chordAt, ChordEvent, ChordQuality, detectChords } from './chordDetect';
import { monoSlice } from './spectrum';

export type { ChordEvent } from './chordDetect';

const pc = (n: number) => ((Math.round(n) % 12) + 12) % 12;
export const newChordId = () => `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Accords valides, triés, sans chevauchement (le plus tardif coupe le précédent). */
export function sanitizeChords(raw: unknown): ChordEvent[] {
  const list: ChordEvent[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const c = r as Partial<ChordEvent>;
    if (!c || typeof c.id !== 'string' || typeof c.start !== 'number' || typeof c.end !== 'number') continue;
    if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start || c.start < 0) continue;
    if (typeof c.root !== 'number' || !CHORD_QUALITIES.includes(c.quality as ChordQuality)) continue;
    list.push({
      id: c.id.slice(0, 80), start: c.start, end: c.end, root: pc(c.root), quality: c.quality as ChordQuality,
      ...(c.auto ? { auto: true } : {}), ...(typeof c.by === 'string' && c.by ? { by: c.by.slice(0, 60) } : {}),
    });
  }
  list.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < list.length; i++) if (list[i].end > list[i + 1].start) list[i].end = list[i + 1].start;
  return list.filter(c => c.end - c.start > 1e-3);
}

/**
 * Pose un accord sur [start, end[ : les accords recouverts sont raccourcis,
 * coupés en deux ou retirés (comme poser une région).
 */
export function placeChord(chords: ChordEvent[], ev: ChordEvent): ChordEvent[] {
  const out: ChordEvent[] = [];
  for (const c of chords) {
    if (c.id === ev.id) continue;
    if (c.end <= ev.start + 1e-6 || c.start >= ev.end - 1e-6) { out.push(c); continue; }
    if (c.start < ev.start - 1e-6) out.push({ ...c, end: ev.start });
    if (c.end > ev.end + 1e-6) out.push({ ...c, id: c.start < ev.start - 1e-6 ? newChordId() : c.id, start: ev.end });
  }
  out.push(ev);
  return sanitizeChords(out);
}

/** Change la fin d'un accord (sans dépasser le suivant, au moins `min` s). */
export function resizeChord(chords: ChordEvent[], id: string, end: number, min = 0.05): ChordEvent[] {
  const i = chords.findIndex(c => c.id === id);
  if (i < 0) return chords;
  const next = chords[i + 1];
  const c = chords[i];
  const e = Math.max(c.start + min, next ? Math.min(end, next.start) : end);
  return chords.map(x => (x.id === id ? { ...x, end: e } : x));
}

/** Remplace les accords de [from, to[ par ceux trouvés à l'analyse. */
export function replaceRange(chords: ChordEvent[], from: number, to: number, found: ChordEvent[]): ChordEvent[] {
  const keep: ChordEvent[] = [];
  for (const c of chords) {
    if (c.end <= from + 1e-6 || c.start >= to - 1e-6) { keep.push(c); continue; }
    if (c.start < from - 1e-6) keep.push({ ...c, end: from });
    if (c.end > to + 1e-6) keep.push({ ...c, id: newChordId(), start: to });
  }
  return sanitizeChords([...keep, ...found]);
}

/** Accord joué à l'instant t (s). */
export const chordAtTime = (chords: ChordEvent[] | undefined, t: number) => chordAt(chords, t);

// ---------------------------------------------------------------------------
// Collaboration
// ---------------------------------------------------------------------------

export const chordSig = (c: ChordEvent): string => JSON.stringify([Math.round(c.start * 1000), Math.round(c.end * 1000), c.root, c.quality, !!c.auto]);

/** Accords ajoutés / modifiés / supprimés ici depuis la dernière synchronisation. */
export function chordChanges(known: Map<string, string>, chords: ChordEvent[]): { upsert: ChordEvent[]; remove: string[] } {
  const upsert = chords.filter(c => known.get(c.id) !== chordSig(c));
  const ids = new Set(chords.map(c => c.id));
  const remove = [...known.keys()].filter(id => !ids.has(id));
  return { upsert, remove };
}

/**
 * Applique des accords reçus. `accept` : « dernière écriture gagne » accord
 * par accord (horloge du journal) ; `pending` : nos accords modifiés ici et
 * pas encore enregistrés par le serveur. Ceux-là ne sont ni remplacés ni
 * recouverts : notre opération, plus récente dans le journal, gagnera chez
 * tout le monde (même résultat partout).
 */
export function applyChordOps(chords: ChordEvent[], upsert: unknown, remove: unknown, accept: (id: string) => boolean = () => true, pending?: Set<string>): ChordEvent[] {
  const incoming = sanitizeChords(Array.isArray(upsert) ? upsert : []);
  const ok = (id: string) => !pending?.has(id) && accept(id);
  const taken = incoming.filter(c => ok(c.id));
  const gone = new Set((Array.isArray(remove) ? remove : []).filter((id): id is string => typeof id === 'string' && ok(id)));
  let out = sanitizeChords(chords.filter(c => !gone.has(c.id) && !taken.some(i => i.id === c.id)));
  // Un accord reçu recouvre les nôtres (même règle que « poser un accord »)…
  for (const c of taken) out = placeChord(out, c);
  // …sauf ceux qui attendent de partir : ils restent par-dessus.
  if (pending?.size) for (const c of chords) if (pending.has(c.id)) out = placeChord(out, c);
  return out;
}

// (File d'envoi hors ligne : les lots se cumulent accord par accord, comme
// les repères : utils/collabMerge, mergeQueuedOps.)

// ---------------------------------------------------------------------------
// Détection sur les clips du projet
// ---------------------------------------------------------------------------

export interface AudioClipSource {
  start: number;
  duration: number;
  offset: number;
  buffer: { sampleRate: number; length: number; numberOfChannels: number; duration: number; getChannelData(c: number): Float32Array };
}

/**
 * Accords des clips (temps de la timeline), grille au tempo du projet à
 * partir de 0. Les clips qui se recouvrent : le premier gagne.
 */
export function detectChordsInClips(clips: AudioClipSource[], bpm: number, beatsPerBar = 4, by?: string): ChordEvent[] {
  let out: ChordEvent[] = [];
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    const from = Math.max(0, c.offset || 0);
    const to = Math.min(c.buffer.duration, from + c.duration);
    if (to - from < 0.5) continue;
    const x = monoSlice(c.buffer, from, to);
    // Grille : un premier temps de la timeline (0) ramené dans l'audio de la tranche.
    const origin = -(c.start - 0);
    const found = detectChords(x, c.buffer.sampleRate, { bpm, beatsPerBar, gridOrigin: origin });
    const evs: ChordEvent[] = found.map(f => ({
      id: newChordId(), start: c.start + f.start, end: c.start + f.end, root: f.root, quality: f.quality, auto: true, ...(by ? { by } : {}),
    }));
    out = replaceRange(out, c.start, c.start + (to - from), evs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Magasins
// ---------------------------------------------------------------------------

const LANE_KEY = 'nova_chord_lane';
const readLane = (): boolean | null => {
  try { const v = localStorage.getItem(LANE_KEY); return v === '1' ? true : v === '0' ? false : null; } catch { return null; }
};
let lanePref: boolean | null = readLane();
const laneListeners = new Set<() => void>();

/**
 * Affichage du couloir d'accords (menu Affichage). Sans choix : visible en
 * mode avancé, masqué en mode simple.
 */
export const chordLaneStore = {
  get: () => lanePref,
  set(on: boolean) {
    lanePref = on;
    try { localStorage.setItem(LANE_KEY, on ? '1' : '0'); } catch { /* stockage indisponible */ }
    laneListeners.forEach(l => l());
  },
  subscribe(l: () => void) { laneListeners.add(l); return () => { laneListeners.delete(l); }; },
};
export const chordLaneVisible = (pref: boolean | null, simple: boolean): boolean => (pref === null ? !simple : pref);
export const useChordLanePref = (): boolean | null => useSyncExternalStore(chordLaneStore.subscribe, chordLaneStore.get, chordLaneStore.get);

/** Accords du projet en cours, pour le piano roll (App les publie). */
let current: ChordEvent[] = [];
const curListeners = new Set<() => void>();
export const chordsStore = {
  get: () => current,
  set(list: ChordEvent[] | undefined) {
    const next = list || [];
    if (next === current) return;
    current = next;
    curListeners.forEach(l => l());
  },
  subscribe(l: () => void) { curListeners.add(l); return () => { curListeners.delete(l); }; },
};
export const useProjectChords = (): ChordEvent[] => useSyncExternalStore(chordsStore.subscribe, chordsStore.get, chordsStore.get);
