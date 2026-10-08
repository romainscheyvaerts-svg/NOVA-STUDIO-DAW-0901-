/**
 * Passage entre les fichiers .mid (utils/midiFile) et les pistes de NOVA (V25).
 *
 * Import : chaque piste du fichier (ou chaque canal d'une piste de format 0)
 * devient une piste MIDI de NOVA ; le canal 10 devient une boîte à rythmes
 * (les notes General MIDI sont rangées sur les pads Kick, Snare, Clap…).
 * Deux façons de caler le temps :
 *  - « project » : les notes gardent leur place en temps (mesures, temps) et
 *    suivent le tempo du projet (comme Live, FL et Logic par défaut) ;
 *  - « file » : le projet prend le tempo du fichier ; si le fichier change de
 *    tempo en route, les notes gardent leur instant réel.
 *
 * Export : un clip (le clip commence au tick 0), une piste ou toutes les
 * pistes MIDI (positions absolues dans le morceau), au format 1.
 */
import { Clip, MidiNote, Track, TrackType } from '../types';
import {
  DEFAULT_PPQ, DRUM_CHANNEL, MidiFileData, MidiFileNote, MidiFileTrack, initialBpm, secondsToTicks, ticksToSeconds,
} from './midiFile';

export type TempoMode = 'project' | 'file';

/** Rangées de la boîte à rythmes NOVA, dans l'ordre (note 60 = rangée 1). Voir utils/drumKits ROW_DEFS. */
export const DRUM_ROW_IDS = ['kick', 'snare', 'clap', 'hatc', 'hato', 'perc', 'fx'] as const;

/** Note General MIDI → rangée de la boîte à rythmes. */
export function gmToDrumRow(pitch: number): number {
  if (pitch === 35 || pitch === 36) return 0;
  if (pitch === 38 || pitch === 40) return 1;
  if (pitch === 39) return 2;
  if (pitch === 42 || pitch === 44) return 3;
  if (pitch === 46) return 4;
  if (pitch === 37 || pitch === 49 || pitch === 51 || pitch === 52 || pitch === 53 || pitch === 55 || pitch === 57 || pitch === 59) return 6;
  return 5; // toms, congas, shaker, cloche…
}

/** Rangée (id ou nom) → note General MIDI à l'export. */
export function drumRowToGm(rowId: string | undefined, name?: string, sound?: string): number {
  const id = (rowId || '').toLowerCase();
  const n = `${name || ''} ${sound || ''}`.toLowerCase();
  if (id === 'kick' || /kick|bd\b/.test(n)) return 36;
  if (id === '808' || /808/.test(n)) return 35;
  if (id === 'snare' || /snare|caisse/.test(n)) return 38;
  if (id === 'clap' || /clap/.test(n)) return 39;
  if (id === 'hato' || /ouvert|open/.test(n)) return 46;
  if (id === 'hatc' || /hat|hh/.test(n)) return 42;
  if (id === 'fx' || /crash|cymb/.test(n)) return /crash/.test(n) ? 49 : 37;
  if (/rim/.test(n)) return 37;
  if (/tom/.test(n)) return 47;
  if (id === 'perc' || /perc|conga/.test(n)) return 63;
  return 47;
}

const GM_FAMILIES = ['Piano', 'Clochettes', 'Orgue', 'Guitare', 'Basse', 'Cordes', 'Ensemble', 'Cuivres', 'Anches', 'Flûtes', 'Lead', 'Nappe', 'Effets synthé', 'Ethnique', 'Percussions', 'Effets'];
export const gmFamilyName = (program?: number): string | null =>
  typeof program === 'number' && program >= 0 && program < 128 ? GM_FAMILIES[Math.floor(program / 8)] : null;

export interface PlannedPart {
  name: string;
  isDrums: boolean;
  channel: number;
  program?: number;
  /** Notes du clip (secondes depuis le début du clip, vélocité 0-1). Batterie : notes 60+ (pads). */
  notes: MidiNote[];
}

export interface ImportPlan {
  parts: PlannedPart[];
  /** Tempo à donner au projet (celui du fichier en mode « file », sinon celui du projet). */
  bpm: number;
  fileBpm: number;
  timeSignature?: { numerator: number; denominator: number };
  /** Longueur des clips (s), arrondie à la mesure. */
  clipDuration: number;
  noteCount: number;
}

let idSeq = 0;
const nid = (p: string) => `${p}-${Date.now().toString(36)}-${(idSeq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Prépare l'import : parties (pistes × canaux), notes en secondes, longueur. */
export function planMidiImport(data: MidiFileData, opts: { projectBpm: number; tempoMode: TempoMode; drumsToRack?: boolean }): ImportPlan {
  const fileBpm = initialBpm(data);
  const bpm = opts.tempoMode === 'file' ? fileBpm : (opts.projectBpm || 120);
  const toSec = (tick: number) => (opts.tempoMode === 'file' ? ticksToSeconds(tick, data.ppq, data.tempos) : (tick / data.ppq) * (60 / bpm));
  const drumsToRack = opts.drumsToRack !== false;
  const parts: PlannedPart[] = [];
  data.tracks.forEach((tr, ti) => {
    const byCh = new Map<number, MidiFileNote[]>();
    tr.notes.forEach(n => { const l = byCh.get(n.channel) || []; l.push(n); byCh.set(n.channel, l); });
    const chans = Array.from(byCh.keys()).sort((a, b) => a - b);
    // Batterie : canal 10 (General MIDI), ou piste nommée « Drums / Batterie » (exports d'outils qui
    // la mettent sur un autre canal, comme les « Cover » à 11).
    const namedDrums = !!tr.name && /(^|[^a-z])(drums?|batterie|drum ?kit|percs?|percussions?)([^a-z]|$)/i.test(tr.name) && chans.length === 1;
    chans.forEach(ch => {
      const isDrums = ch === DRUM_CHANNEL || namedDrums;
      const fam = gmFamilyName(tr.program);
      const base = tr.name || (isDrums ? 'Batterie' : fam || `Piste ${ti + 1}`);
      const name = chans.length > 1 ? (isDrums ? (tr.name ? `${tr.name} · batterie` : 'Batterie') : `${base} · canal ${ch + 1}`) : base;
      const notes: MidiNote[] = byCh.get(ch)!.map(n => {
        const start = toSec(n.startTick);
        const end = toSec(n.startTick + n.durationTicks);
        return {
          id: nid('n'),
          pitch: isDrums && drumsToRack ? 60 + gmToDrumRow(n.pitch) : n.pitch,
          start,
          duration: Math.max(1e-4, end - start),
          velocity: Math.max(1, Math.min(127, n.velocity)) / 127,
        };
      });
      parts.push({ name, isDrums, channel: ch, program: tr.program, notes });
    });
  });
  const sig = data.timeSignatures[0];
  const beatsPerBar = sig ? (sig.numerator * 4) / sig.denominator : 4;
  const bar = (60 / bpm) * beatsPerBar;
  const lastEnd = Math.max(0, ...parts.flatMap(p => p.notes.map(n => n.start + n.duration)));
  const clipDuration = Math.max(bar, Math.ceil(lastEnd / bar - 1e-6) * bar);
  return {
    parts, bpm, fileBpm,
    timeSignature: sig ? { numerator: sig.numerator, denominator: sig.denominator } : undefined,
    clipDuration,
    noteCount: parts.reduce((s, p) => s + p.notes.length, 0),
  };
}

const COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#60a5fa', '#fb7185', '#4ade80'];

/** Clip MIDI d'une partie, posé à `start` (s). */
export function partClip(part: PlannedPart, start: number, duration: number, color: string, name?: string): Clip {
  return {
    id: nid('clip-mid'), start: Math.max(0, start), duration, offset: 0, fadeIn: 0, fadeOut: 0,
    name: name || part.name, color, type: TrackType.MIDI, notes: part.notes, isMuted: false, gain: 1,
  };
}

/** Nouvelle piste MIDI (ou batterie) pour une partie. `drum` : réglages de la boîte à rythmes fournis par l'appelant. */
export function partTrack(part: PlannedPart, clip: Clip, index: number, drum?: { drumMachine: any; drumPads: any[] }): Track {
  const color = part.isDrums ? '#f97316' : COLORS[index % COLORS.length];
  const t: Track = {
    id: nid(part.isDrums ? 'track-middrums' : 'track-mid'),
    name: part.name.toUpperCase().slice(0, 40),
    type: part.isDrums && drum ? TrackType.DRUM_RACK : TrackType.MIDI,
    color, isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
    volume: 0.8, pan: 0, outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0,
    clips: [{ ...clip, color }],
  };
  if (part.isDrums && drum) { (t as any).drumMachine = drum.drumMachine; t.drumPads = drum.drumPads; }
  else if (part.isDrums) t.midiChannel = 10; // notes General MIDI gardées telles quelles
  return t;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Piste de batterie de NOVA (boîte à rythmes ou drum rack) : export sur le canal 10. */
export const isDrumTrack = (t: Track): boolean => t.type === TrackType.DRUM_RACK || !!(t as any).drumMachine;

/** Clips joués comme des notes (les clips audio sont ignorés). */
export const midiClipsOf = (t: Track): Clip[] => (t.clips || []).filter(c => Array.isArray(c.notes) && c.notes.length > 0 && c.type === TrackType.MIDI && !c.isFreezeSlice);

/** Piste qui a des notes à exporter. */
export const hasMidi = (t: Track): boolean => midiClipsOf(t).length > 0;

/** Note de pad (60 + rangée) → note General MIDI. */
function drumPitchOut(t: Track, pitch: number): number {
  const dm = (t as any).drumMachine as { rows?: { id: string; name: string; sound: string }[] } | undefined;
  const idx = pitch - 60;
  const row = dm?.rows?.[idx];
  if (row) return drumRowToGm(row.id, row.name, row.sound);
  const pad = t.drumPads?.find(p => p.id === idx + 1);
  if (pad) return drumRowToGm(undefined, pad.name, pad.sampleName);
  return pitch >= 60 && pitch < 67 ? drumRowToGm(DRUM_ROW_IDS[idx]) : pitch;
}

export interface ExportSource { track: Track; clips: Clip[] }

/**
 * Construit le fichier : une piste .mid par piste NOVA. `relativeTo` : instant
 * (s) qui devient le tick 0 (début du clip exporté seul, sinon 0).
 */
export function novaToMidi(sources: ExportSource[], opts: { bpm: number; timeSignature?: { numerator: number; denominator: number }; relativeTo?: number; ppq?: number }): MidiFileData {
  const ppq = opts.ppq || DEFAULT_PPQ;
  const bpm = opts.bpm || 120;
  const origin = opts.relativeTo || 0;
  const MELODIC = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
  let nextCh = 0;
  const tracks: MidiFileTrack[] = sources.map(({ track, clips }) => {
    const drums = isDrumTrack(track);
    const gmDrums = !drums && track.midiChannel === 10;
    const ch = drums || gmDrums ? DRUM_CHANNEL : MELODIC[nextCh++ % MELODIC.length];
    const notes: MidiFileNote[] = [];
    for (const c of clips) {
      for (const n of c.notes || []) {
        const abs = c.start + n.start - origin;
        if (abs + n.duration <= 0) continue;
        const s = Math.max(0, abs);
        const startTick = secondsToTicks(s, bpm, ppq);
        const endTick = secondsToTicks(abs + n.duration, bpm, ppq);
        notes.push({
          pitch: drums ? drumPitchOut(track, n.pitch) : n.pitch,
          velocity: Math.max(1, Math.min(127, Math.round((n.velocity ?? 0.8) * 127))),
          startTick,
          durationTicks: Math.max(1, endTick - startTick),
          channel: ch,
        });
      }
    }
    notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
    return { name: track.name, notes };
  });
  return {
    format: 1, ppq, tracks,
    tempos: [{ tick: 0, usPerQuarter: Math.round(60_000_000 / bpm), bpm }],
    timeSignatures: [{ tick: 0, numerator: opts.timeSignature?.numerator || 4, denominator: opts.timeSignature?.denominator || 4 }],
  };
}

/** Sources d'un export : 'clip' (un clip), 'track' (une piste), 'all' (toutes les pistes MIDI). */
export function exportSources(tracks: Track[], scope: 'clip' | 'track' | 'all', trackId?: string, clipId?: string): { sources: ExportSource[]; relativeTo: number; name: string } {
  if (scope === 'clip') {
    const t = tracks.find(x => x.id === trackId);
    const c = t?.clips.find(x => x.id === clipId);
    if (!t || !c) return { sources: [], relativeTo: 0, name: 'clip' };
    return { sources: [{ track: t, clips: [c] }], relativeTo: c.start, name: `${t.name} - ${c.name}` };
  }
  if (scope === 'track') {
    const t = tracks.find(x => x.id === trackId);
    return { sources: t && hasMidi(t) ? [{ track: t, clips: midiClipsOf(t) }] : [], relativeTo: 0, name: t?.name || 'piste' };
  }
  return { sources: tracks.filter(hasMidi).map(t => ({ track: t, clips: midiClipsOf(t) })), relativeTo: 0, name: 'pistes MIDI' };
}
