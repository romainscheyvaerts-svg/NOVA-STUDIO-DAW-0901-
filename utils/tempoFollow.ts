import { TrackType, type AutomationLane, type Clip, type DAWState, type Marker, type MidiNote, type Track } from '../types';
import type { ChordEvent } from './chordDetect';
import { buildTempoMap, quartersToTime, timeToQuarters, type TempoEvent, type TempoMap } from './tempoMap';

/**
 * L3 · Temps musical : quand le tempo (ou la piste tempo) change, le contenu
 * garde sa position MUSICALE (même mesure | temps | tick), comme dans tous les
 * DAW pro. Avant, tout restait en secondes : un beat passé de 140 à 150 BPM
 * voyait ses notes sortir de la grille.
 *
 * Le projet reste rangé en secondes (aucune réécriture des 300 modules qui le
 * lisent) : on convertit chaque instant ancienne carte → noires → nouvelle
 * carte. Pour un tempo constant, c'est une homothétie ; avec des changements
 * et des rampes, chaque instant suit sa propre position musicale.
 *
 * Ce qui suit :
 *  - les clips MIDI (début, longueur) et leurs notes (début ET fin : une
 *    noire reste une noire), contrôleurs (pitch bend, CC…) et source du groove ;
 *  - les clips audio CALÉS (warp) : leur début ; leur son est ré-étiré par le
 *    calage automatique existant (App, « suivi automatique du tempo ») ;
 *  - les clips audio non calés : leur DÉBUT suit (le son, lui, n'est pas
 *    étiré), sauf option « garder les clips audio à leur place » — choisie
 *    d'office quand le projet a un beat importé non calé (il ne suit pas le
 *    tempo : les voix posées dessus doivent rester calées sur lui) ;
 *  - l'automation, les repères, la piste d'accords et la boucle.
 * Ce qui ne bouge jamais : les clips verrouillés (« edit » ou « time »).
 *
 * Collaboration : chaque membre applique le même calcul en recevant
 * l'opération « tempo » (champ `follow`) ; les clips déjà déplacés pour ce
 * changement portent son identifiant (`tempoEpoch`) et ne bougent pas deux fois.
 *
 * Module pur : tests/tempoFollow.test.ts.
 */

export type TempoAudioMode = 'follow' | 'keep';

export interface TempoFollowOptions {
  /** Garder les clips audio non calés à leur place (en secondes). */
  keepAudio: boolean;
  /** Identifiant du changement (collaboration) : posé sur chaque clip déplacé. */
  epoch?: string;
}

export interface TempoFollowReport {
  /** Notes MIDI déplacées. */
  notes: number;
  midiClips: number;
  /** Clips audio dont le début a suivi. */
  audioMoved: number;
  /** Clips audio gardés à leur place (option). */
  audioKept: number;
  /** Clips verrouillés (jamais déplacés). */
  locked: number;
  /** Rien n'a bougé (même carte, projet vide). */
  unchanged: boolean;
}

type TempoPart = Pick<DAWState, 'bpm' | 'timeSignature' | 'tempoEvents'>;
export type FollowState = Pick<DAWState, 'tracks' | 'markers' | 'loopStart' | 'loopEnd'> & Partial<Pick<DAWState, 'chords' | 'tempoAudioMode'>> & TempoPart;

export const mapOf = (s: TempoPart): TempoMap => buildTempoMap(s.bpm, s.timeSignature, s.tempoEvents);

/** Les deux cartes placent-elles chaque instant au même endroit ? */
export function sameTiming(a: TempoMap, b: TempoMap): boolean {
  if (a.segments.length !== b.segments.length) return false;
  for (let i = 0; i < a.segments.length; i++) {
    const x = a.segments[i], y = b.segments[i];
    if (Math.abs(x.q - y.q) > 1e-9 || Math.abs(x.time - y.time) > 1e-9 || Math.abs(x.bpm - y.bpm) > 1e-9 || (x.bpmEnd ?? x.bpm) !== (y.bpmEnd ?? y.bpm)) return false;
  }
  return true;
}

/** Instant `t` (ancienne carte) → même position musicale dans la nouvelle carte. */
export const remapper = (from: TempoMap, to: TempoMap) => (t: number): number => {
  const r = quartersToTime(to, timeToQuarters(from, t));
  // Arrondi à la nanoseconde : des changements de tempo répétés ne laissent pas de poussière.
  return Math.round(r * 1e9) / 1e9;
};

/** Piste du beat importé (catalogue ou PC) : la piste « instrumental ». */
const isBeatTrackId = (t: Track) => t.id === 'instrumental';
export const isMidiClip = (c: Clip) => Array.isArray(c.notes) || c.type === TrackType.MIDI;
export const isWarpedClip = (c: Clip) => !!c.warp?.enabled;

/**
 * Option « garder les clips audio à leur place » : choix du projet s'il y en a
 * un, sinon automatique — oui quand un beat importé NON calé est dans le projet.
 */
export function keepAudioFor(s: Pick<FollowState, 'tracks' | 'tempoAudioMode'>): boolean {
  if (s.tempoAudioMode === 'keep') return true;
  if (s.tempoAudioMode === 'follow') return false;
  return hasUnwarpedBeat(s.tracks);
}

export const hasUnwarpedBeat = (tracks: Track[]): boolean =>
  tracks.some(t => isBeatTrackId(t) && t.clips.some(c => !isMidiClip(c) && !isWarpedClip(c) && !c.isMuted));

function remapNotes(notes: MidiNote[], oldStart: number, newStart: number, R: (t: number) => number): MidiNote[] {
  return notes.map(n => {
    const a = oldStart + n.start;
    const s = R(a) - newStart;
    const e = R(a + n.duration) - newStart;
    return { ...n, start: Math.max(0, s), duration: Math.max(1e-4, e - s) };
  });
}

function remapClip(c: Clip, R: (t: number) => number, opts: TempoFollowOptions, rep: TempoFollowReport): Clip {
  if (c.lock) { rep.locked++; return c; }
  if (opts.epoch && c.tempoEpoch === opts.epoch) return c;
  const start = Math.max(0, R(c.start));
  const stamp = opts.epoch ? { tempoEpoch: opts.epoch } : {};
  if (isMidiClip(c)) {
    const end = R(c.start + c.duration);
    const out: Clip = { ...c, ...stamp, start, duration: Math.max(1e-3, end - start) };
    if (c.notes?.length) { out.notes = remapNotes(c.notes, c.start, start, R); rep.notes += c.notes.length; }
    if (c.cc) {
      out.cc = Object.fromEntries(Object.entries(c.cc).map(([k, pts]) => [k, (pts || []).map(p => ({ ...p, t: Math.max(0, R(c.start + p.t) - start) }))]));
    }
    if (c.groove?.source?.length) out.groove = { ...c.groove, source: remapNotes(c.groove.source, c.start, start, R) };
    rep.midiClips++;
    return out;
  }
  if (!isWarpedClip(c) && opts.keepAudio) { rep.audioKept++; return c; }
  if (Math.abs(start - c.start) < 1e-9) return c;
  rep.audioMoved++;
  // Audio : seul le début suit (le calage ré-étire le son des clips calés).
  return { ...c, ...stamp, start };
}

function remapLane(l: AutomationLane, R: (t: number) => number): AutomationLane {
  if (!l.points?.length) return l;
  return { ...l, points: l.points.map(p => ({ ...p, time: Math.max(0, R(p.time)) })) };
}

function remapTrack(t: Track, R: (t: number) => number, opts: TempoFollowOptions, rep: TempoFollowReport): Track {
  let changed = false;
  const clips = t.clips.map(c => { const n = remapClip(c, R, opts, rep); if (n !== c) changed = true; return n; });
  const lanes = (t.automationLanes || []).map(l => { const n = remapLane(l, R); if (n !== l) changed = true; return n; });
  // Playlists rangées : leurs clips suivent aussi (on peut basculer dessus après le changement).
  const playlists = t.playlists?.map(p => {
    if (!p.clips?.length) return p;
    const cl = p.clips.map(c => remapClip(c, R, opts, { ...rep }));
    if (cl.every((c, i) => c === p.clips![i])) return p;
    changed = true;
    return { ...p, clips: cl };
  });
  if (!changed) return t;
  return { ...t, clips, automationLanes: lanes, ...(playlists ? { playlists } : {}) };
}

function remapMarker(m: Marker, R: (t: number) => number): Marker {
  const out: Marker = { ...m, time: Math.max(0, R(m.time)) };
  if (m.endTime !== undefined) out.endTime = Math.max(out.time, R(m.endTime));
  if (m.selection) out.selection = { ...m.selection, end: Math.max(out.time, R(m.selection.end)) };
  return out;
}

const remapChord = (c: ChordEvent, R: (t: number) => number): ChordEvent => {
  const start = Math.max(0, R(c.start));
  return { ...c, start, end: Math.max(start + 1e-3, R(c.end)) };
};

/**
 * Le projet après un changement de tempo : `next` donne le nouveau tempo,
 * la nouvelle mesure et la nouvelle piste tempo. Une seule mise à jour
 * (donc une seule étape d'annulation dans App).
 */
export function followTempo<S extends FollowState>(state: S, next: Partial<TempoPart>, opts: TempoFollowOptions): { state: S; report: TempoFollowReport } {
  const target: TempoPart = {
    bpm: next.bpm ?? state.bpm,
    timeSignature: next.timeSignature ?? state.timeSignature,
    tempoEvents: next.tempoEvents ?? state.tempoEvents,
  };
  const withTempo = { ...state, ...target } as S;
  const rep: TempoFollowReport = { notes: 0, midiClips: 0, audioMoved: 0, audioKept: 0, locked: 0, unchanged: true };
  const from = mapOf(state), to = mapOf(target);
  if (sameTiming(from, to)) return { state: withTempo, report: rep };
  const R = remapper(from, to);
  const tracks = state.tracks.map(t => remapTrack(t, R, opts, rep));
  const out: S = {
    ...withTempo,
    tracks,
    markers: (state.markers || []).map(m => remapMarker(m, R)),
    ...(state.chords?.length ? { chords: state.chords.map(c => remapChord(c, R)) } : {}),
    loopStart: Math.max(0, R(state.loopStart || 0)),
    loopEnd: Math.max(0, R(state.loopEnd || 0)),
  };
  rep.unchanged = tracks.every((t, i) => t === state.tracks[i]) && !(state.markers || []).length && !(state.chords || []).length;
  return { state: out, report: rep };
}

/** Phrase courte pour l'utilisateur (« 48 notes · 3 clips : même mesure qu'avant »), null si rien à dire. */
export function followSummary(r: TempoFollowReport): string | null {
  const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? 's' : ''}`;
  const parts: string[] = [];
  if (r.notes) parts.push(plural(r.notes, 'note'));
  const clips = r.midiClips + r.audioMoved;
  if (clips) parts.push(plural(clips, 'clip'));
  const out: string[] = [];
  if (parts.length) out.push(`${parts.join(' · ')} : même mesure qu'avant`);
  if (r.audioKept) out.push(`${plural(r.audioKept, 'clip')} audio gardé${r.audioKept > 1 ? 's' : ''} à sa place`);
  if (r.locked) out.push(`${plural(r.locked, 'clip')} verrouillé${r.locked > 1 ? 's' : ''} non déplacé${r.locked > 1 ? 's' : ''}`);
  return out.length ? out.join(' · ') : null;
}

/** Changements de tempo à envoyer (collaboration) : identifiant + option audio. */
export interface TempoFollowWire { id: string; keepAudio: boolean }

export function sanitizeFollow(raw: unknown): TempoFollowWire | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) return null;
  return { id: r.id.slice(0, 64), keepAudio: !!r.keepAudio };
}

let followSeq = 0;
export const newFollowId = () => `tf${Date.now().toString(36)}${(followSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export type { TempoEvent };
