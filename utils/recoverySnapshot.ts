import { Clip, DAWState, Track, TrackType } from '../types';
import { trackBufferIds } from './freeze';
import { padSampleKey } from './drumSamples';
import { samplerBufferKey } from './melodicSampler';
import { countVoiceTakes } from './sessionSummary';
import type { RecoveredTake, StoredAudio, VersionRecord } from './recoveryStore';

/**
 * Passage projet <-> version gardée sur l'appareil (utils/recoveryStore).
 * Module pur : les sons sont fournis / créés par l'appelant.
 */

/** Beat du catalogue pas acheté : son audio n'est jamais copié (licence), il est rechargé depuis le catalogue. */
export const isUnlicensedBeat = (t: Track, owned: (string | number)[]) =>
  t.instrumentId !== undefined && t.instrumentId !== null && !owned.map(String).includes(String(t.instrumentId));

/** Tous les sons d'une piste, samples perso de la batterie compris. */
export function trackAudioIds(t: Track): string[] {
  const ids = trackBufferIds(t);
  const s = (t as any).drumMachine?.samples;
  if (s) for (const id of Object.keys(s)) ids.push(padSampleKey(id));
  if (t.melodicSampler?.sampleId) ids.push(samplerBufferKey(t.melodicSampler.sampleId));
  return ids;
}

const stripBuffers = (k: string, v: unknown) => {
  if (k === 'buffer') return undefined;          // AudioBuffer : référencé par bufferId
  if (typeof AudioBuffer !== 'undefined' && v instanceof AudioBuffer) return undefined;
  return v;
};

export interface Snapshot {
  json: string;
  audioIds: string[];
  tracks: number;
  takes: number;
  beatTitle: string | null;
  hasLyrics: boolean;
  needsCatalogBeat: boolean;
}

export function snapshotOf(state: DAWState, owned: (string | number)[] = []): Snapshot {
  const audioIds = new Set<string>();
  let needsCatalogBeat = false;
  for (const t of state.tracks) {
    if (isUnlicensedBeat(t, owned)) { needsCatalogBeat = needsCatalogBeat || t.clips.length > 0; continue; }
    for (const id of trackAudioIds(t)) audioIds.add(id);
  }
  // Ce qui est en cours (lecture, prise, armement) ne fait pas partie de la version.
  const clean = { ...state, isPlaying: false, isRecording: false, recStartTime: null };
  const beat = state.tracks.find(t => t.id === 'instrumental')?.clips[0];
  return {
    json: JSON.stringify(clean, stripBuffers),
    audioIds: [...audioIds],
    tracks: state.tracks.length,
    takes: countVoiceTakes(state.tracks),
    beatTitle: beat?.name?.replace(/^🚫\s*/, '').replace(/\s*\(Licence requise\)$/, '') || null,
    hasLyrics: !!((state as any).lyrics || '').trim(),
    needsCatalogBeat,
  };
}

/**
 * Projet d'une version : JSON relu, sons recréés et enregistrés sous leur
 * identifiant (les clips les retrouvent tels quels). Les sons manquants sont
 * signalés, le clip reste en place (hors ligne).
 */
export function stateFromVersion<B>(
  record: VersionRecord,
  audio: Map<string, StoredAudio>,
  makeBuffer: (a: StoredAudio) => B,
  register: (buffer: B, id: string) => void,
): { state: DAWState; report: string[] } {
  const state = JSON.parse(record.json) as DAWState;
  const report: string[] = [];
  let restored = 0;
  for (const [id, a] of audio) {
    try { register(makeBuffer(a), id); restored++; } catch { /* son illisible : clip hors ligne */ }
  }
  let offline = 0;
  for (const t of state.tracks) {
    t.isTrackArmed = false;
    for (const c of t.clips) {
      if (c.bufferId && !audio.has(c.bufferId) && t.type === TrackType.AUDIO) {
        // Beat du catalogue : rechargé ensuite (pas un son perdu).
        if (t.instrumentId === undefined || t.instrumentId === null) { (c as Clip).isOffline = true; offline++; }
      }
    }
  }
  if (offline) report.push(`${offline} clip${offline > 1 ? 's' : ''} sans son retrouvé (laissé${offline > 1 ? 's' : ''} en place, hors ligne)`);
  state.isPlaying = false;
  state.isRecording = false;
  if (!restored && record.audioIds.length) report.push("aucun son n'a pu être relu");
  return { state, report };
}

/** Prise récupérée -> clip mono à sa place (position de départ moins la latence mesurée). */
export function recoveredTakeClip(take: RecoveredTake, bufferId: string): Clip {
  const m = take.meta;
  const start = Math.max(0, (m.recordedAt || 0) - (m.latency || 0));
  const when = new Date(m.startedAt);
  const hh = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  return {
    id: bufferId,
    bufferId,
    name: `Prise récupérée (${hh})`,
    start,
    duration: take.seconds,
    offset: 0,
    fadeIn: 0.01,
    fadeOut: 0.01,
    type: TrackType.AUDIO,
    color: '#f59e0b',
    originStart: start,
  } as Clip;
}

/**
 * Ajoute les prises récupérées à leur piste (créée si elle n'existe plus), sans
 * couper les prises existantes : l'artiste choisit ensuite.
 */
export function addRecoveredTakes(state: DAWState, takes: { take: RecoveredTake; bufferId: string }[]): { state: DAWState; report: string[] } {
  if (!takes.length) return { state, report: [] };
  const tracks = state.tracks.map(t => ({ ...t, clips: [...t.clips] }));
  const report: string[] = [];
  for (const { take, bufferId } of takes) {
    const clip = recoveredTakeClip(take, bufferId);
    let t = tracks.find(x => x.id === take.meta.trackId);
    if (!t) {
      t = {
        id: take.meta.trackId || `recup-${bufferId}`, name: take.meta.trackName || 'Prises récupérées', type: TrackType.AUDIO, color: '#f59e0b',
        isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0, outputTrackId: tracks.some(x => x.id === 'master') ? 'master' : '',
        sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0,
      } as Track;
      tracks.push(t);
    }
    t.clips.push(clip);
    report.push(`prise de ${take.seconds.toFixed(1).replace('.', ',')} s récupérée sur « ${t.name} »`);
  }
  return { state: { ...state, tracks }, report };
}
