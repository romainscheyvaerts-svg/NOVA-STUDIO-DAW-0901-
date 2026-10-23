/**
 * Lot 5 · Contenu et pose des boucles NOVA et des one-shots du navigateur de sons.
 *
 * - `loopContent` : notes d'une boucle au tempo du projet (accords, 808) ou motif de batterie.
 * - `placeLoop` : pose une boucle dans le projet, calée sur la mesure, en UNE étape d'annulation
 *   (rend l'état suivant) ; `placeStudioSound` : un son de la batterie du studio sur un pad.
 *   Les sons des kits passent par l'événement déjà en place (KIT_SOUND_DROP_EVENT, App.tsx).
 * - Aucune adresse de fichier n'est exposée : on ne manipule que des références internes.
 *
 * Données pures (aucun React) : tests/soundPlace.test.ts.
 */
import { FADER_MAX_GAIN } from './faderLaw';
import type { Clip, DAWState, MidiNote, Track } from '../types';
import { TrackType } from '../types';
import { newChordId, replaceRange } from './chordTrack';
import type { DrumMachine, DrumRow } from './drumKits';
import { drumPadsFor, makeDrumMachine } from './drumKits';
import { commitActive, drumSongClips, STEPS_PER_BAR } from './drumPatterns';
import type { KitIndex } from './drumKitLibrary';
import { MAX_PADS } from './drumSamples';
import { libUrl } from './drumLibrary';
import { libSoundLabel } from './drumKits';
import { BASS808_TRACK_ID, kit808Style } from './bass808';
import { DEFAULT_SAMPLER, normalizeSampler } from './melodicSampler';
import { instrumentPreset, settingsForInstrument } from './instrumentPresets';
import { PROGRESSIONS, genreRecipe } from './beatRecipes';
import { BEAT_CHORDS_TRACK_ID, DRUM_TRACK_ID, bassNotesFor, chordNotesFor, drumMachineFor, buildBeat, layoutChords, projectScaleOf, hasLoadedBeat, keyNameFr } from './beatStarter';
import { parseLoopRef, type LoopRef } from './soundSearch';

const pc = (n: number) => ((Math.round(n) % 12) + 12) % 12;
let seq = 0;
/** Identifiant unique même pour plusieurs boucles posées dans la même milliseconde (Palette). */
const stampId = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Longueur d'une boucle d'accords / de 808 en mesures : la suite entière, au moins 4 mesures. */
export function loopBars(prog: { chords: { beats: number }[] }, beatsPerBar = 4): number {
  const beats = prog.chords.reduce((s, c) => s + c.beats, 0);
  const bars = Math.ceil(beats / beatsPerBar);
  return Math.max(4, bars);
}

export interface LoopContent {
  ref: LoopRef;
  bars: number;
  /** Notes (s depuis le début de la boucle), au tempo demandé. */
  notes: MidiNote[];
  chords: { start: number; end: number; root: number; quality: import('./chordDetect').ChordQuality }[];
  instrument?: string;
  dm?: DrumMachine;
  name: string;
}

/** Contenu d'une boucle au tempo `bpm`. Null si la référence est inconnue. */
export function loopContent(refStr: string, bpm: number, ix: KitIndex | null = null): LoopContent | null {
  const ref = parseLoopRef(refStr);
  if (!ref) return null;
  if (ref.t === 'drums') {
    const g = genreRecipe(ref.genre);
    const variant = Math.max(0, Math.min(g.drums.length - 1, ref.variant));
    const sk = buildBeat({ genre: g.id, bpm, variant, bars: g.drums[variant].bars });
    // buildBeat choisit le motif par variante : on force celui de la boucle.
    const d = g.drums[variant];
    const skd = { ...sk, drums: { bars: d.bars, swing: d.swing ?? g.swing ?? 0, lines: d.lines, name: d.name } };
    return { ref, bars: d.bars, notes: [], chords: [], dm: drumMachineFor(skd, ix, variant), name: `${g.name} · Batterie ${String.fromCharCode(65 + variant)}` };
  }
  const p = PROGRESSIONS.find(x => x.id === ref.prog);
  if (!p) return null;
  const g = genreRecipe(p.genre);
  const bars = loopBars(p);
  const chords = layoutChords(p, ref.root, bpm, bars);
  if (ref.t === 'chords') {
    return { ref, bars, chords, instrument: ref.instrument, notes: chordNotesFor(chords, g, bpm, 0, bars), name: `Accords ${g.name} · ${keyNameFr(ref.root, p.scale)}` };
  }
  return { ref, bars, chords, notes: bassNotesFor(chords, g, bpm, 0, bars), name: `808 ${g.name} · ${keyNameFr(ref.root, p.scale)}` };
}

/** Début de mesure le plus proche avant `t` (s). */
export const snapToBar = (t: number, bpm: number, beatsPerBar = 4) => {
  const bar = (60 / bpm) * beatsPerBar;
  return Math.max(0, Math.floor((t + 1e-6) / bar) * bar);
};

/** Boîte à rythmes posée (ou remplacée) sur la piste PERCUSSIONS, clips régénérés. */
export function withDrumMachine(st: DAWState, dmIn: DrumMachine): DAWState {
  const bpm = st.bpm || 120;
  const bar = (60 / bpm) * 4;
  const beat = st.tracks.find(t => t.id === 'instrumental');
  const beatEnd = beat ? Math.max(0, ...beat.clips.map(c => c.start + c.duration)) : 0;
  const songEnd = Math.max(0, ...st.tracks.flatMap(t => t.clips.map(c => c.start + c.duration)));
  let dm = commitActive(dmIn);
  const end = Math.max(beatEnd, bar * 8, songEnd);
  const clips = drumSongClips(dm, bpm, end, `clip-drums-${Date.now().toString(36)}`) as Clip[];
  dm = { ...dm, bpmUsed: bpm };
  const tracks = [...st.tracks];
  const i = tracks.findIndex(t => t.id === DRUM_TRACK_ID);
  if (i >= 0) tracks[i] = { ...tracks[i], clips, drumMachine: dm, drumPads: drumPadsFor(dm) as any };
  else {
    const t: Track = {
      id: DRUM_TRACK_ID, name: 'PERCUSSIONS', type: TrackType.DRUM_RACK, color: '#f97316', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
      volume: 0.85, pan: 0, outputTrackId: 'master', sends: [], clips, plugins: [],
      automationLanes: [{ id: `auto-${Date.now().toString(36)}-drums`, parameterName: 'volume', points: [], color: '#f97316', isExpanded: false, min: 0, max: FADER_MAX_GAIN }],
      totalLatency: 0, drumMachine: dm, drumPads: drumPadsFor(dm) as any,
    } as Track;
    tracks.splice(tracks.findIndex(x => x.id === 'instrumental') + 1, 0, t);
  }
  return { ...st, tracks };
}

/** Clips MIDI de [from, to[ retirés ou raccourcis sur une piste (la boucle posée prend la place). */
function clearRange(clips: Clip[], from: number, to: number): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    const end = c.start + c.duration;
    if (end <= from + 1e-6 || c.start >= to - 1e-6) { out.push(c); continue; }
    if (c.start < from - 1e-6) {
      const d = from - c.start;
      out.push({ ...c, duration: d, notes: c.notes?.filter(n => n.start < d - 1e-6).map(n => ({ ...n, duration: Math.min(n.duration, d - n.start) })) });
    }
    // Ce qui dépasse après la boucle est gardé, décalé.
    if (end > to + 1e-6 && c.type === TrackType.MIDI) {
      const cut = to - c.start;
      out.push({ ...c, id: `${c.id}-b`, start: to, duration: end - to, notes: c.notes?.filter(n => n.start >= cut - 1e-6).map(n => ({ ...n, start: n.start - cut })) });
    }
  }
  return out;
}

export interface PlaceResult { state: DAWState; message: string }

/**
 * Pose une boucle à `at` (s, ramené au début de mesure). Batterie : la boîte à rythmes (tout le
 * morceau). Accords : nouvelle piste d'instrument + accords sur la piste d'accords. 808 : piste 808.
 * La tonalité du projet est prise sur la boucle quand le projet n'en a pas (et pas d'instru chargée).
 */
export function placeLoop(st: DAWState, refStr: string, at: number, ix: KitIndex | null): PlaceResult | null {
  const bpm = st.bpm || 120;
  const c = loopContent(refStr, bpm, ix);
  if (!c) return null;
  const bpb = st.timeSignature?.numerator || 4;
  if (c.ref.t === 'drums' && c.dm) {
    const next = withDrumMachine(st, c.dm);
    // La 808 suit le style du kit (saturée en drill).
    const g = genreRecipe(c.ref.genre);
    const tracks = next.tracks.map(t => (t.id === BASS808_TRACK_ID && t.bass808 ? { ...t, bass808: { ...t.bass808, style: g.dist808 ? '808-dist' as const : kit808Style(c.dm!.kitId) } } : t));
    return { state: { ...next, tracks }, message: `🥁 ${c.name} posée dans la boîte à rythmes : elle tourne sur tout le morceau, à ${Math.round(bpm)} BPM. Ctrl+Z pour annuler.` };
  }
  const start = snapToBar(at, bpm, bpb);
  const len = c.bars * (60 / bpm) * bpb;
  const stamp = stampId();
  const shift = (ns: MidiNote[]) => ns.map(n => ({ ...n }));
  const lr = c.ref;
  if (lr.t === 'drums') return null;
  const p = PROGRESSIONS.find(x => x.id === lr.prog);
  if (!p) return null;
  const noKey = typeof st.projectKey !== 'number' && !hasLoadedBeat(st);
  const keyPatch = noKey ? { projectKey: pc(lr.root), projectScale: projectScaleOf(p.scale) } : {};
  const evs = c.chords.map(ch => ({ id: newChordId(), start: start + ch.start, end: start + ch.end, root: ch.root, quality: ch.quality }));
  const tracks = [...st.tracks];
  const barNo = Math.round(start / ((60 / bpm) * bpb)) + 1;

  if (c.ref.t === 'chords') {
    const inst = instrumentPreset(c.instrument);
    const n = tracks.filter(t => t.id.startsWith('track-boucle-')).length + 1;
    const id = `track-boucle-${stamp}`;
    const color = '#22d3ee';
    const clip: Clip = { id: `clip-boucle-${stamp}`, start, duration: len, offset: 0, fadeIn: 0, fadeOut: 0, name: c.name, color, type: TrackType.MIDI, notes: shift(c.notes), isMuted: false, gain: 1 };
    const t: Track = {
      id, name: `${(inst?.name || 'Accords').toUpperCase()} ${n}`.slice(0, 28), type: TrackType.MIDI, color, isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
      volume: 0.7, pan: 0, outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0,
      melodicSampler: normalizeSampler({ ...DEFAULT_SAMPLER, ...settingsForInstrument(c.instrument || 'piano') }), clips: [clip],
    } as Track;
    const after = Math.max(tracks.findIndex(x => x.id === BEAT_CHORDS_TRACK_ID), tracks.findIndex(x => x.id === BASS808_TRACK_ID), tracks.findIndex(x => x.id === DRUM_TRACK_ID), tracks.findIndex(x => x.id === 'instrumental'));
    tracks.splice(after + 1, 0, t);
    return {
      state: { ...st, ...keyPatch, tracks, chords: replaceRange(st.chords || [], start, start + len, evs), selectedTrackId: id },
      message: `🎹 ${c.name} (${inst?.name || 'instrument'}) posée mesure ${barNo}, ${c.bars} mesures, accords ajoutés à la piste d'accords. Ctrl+Z pour annuler.`,
    };
  }
  // 808.
  const clip: Clip = { id: `clip-808-${stamp}`, start, duration: len, offset: 0, fadeIn: 0, fadeOut: 0, name: c.name, color: '#d946ef', type: TrackType.MIDI, notes: shift(c.notes), isMuted: false, gain: 1 };
  const i = tracks.findIndex(t => t.id === BASS808_TRACK_ID);
  const g = genreRecipe(p.genre);
  if (i >= 0) tracks[i] = { ...tracks[i], clips: [...clearRange(tracks[i].clips, start, start + len), clip] };
  else {
    const drumKit = (st.tracks.find(t => t.id === DRUM_TRACK_ID)?.drumMachine as DrumMachine | undefined)?.kitId;
    const t: Track = {
      id: BASS808_TRACK_ID, name: '808', type: TrackType.MIDI, color: '#d946ef', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
      volume: 0.85, pan: 0, outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0,
      bass808: { style: g.dist808 ? '808-dist' : kit808Style(drumKit), glide: true } as any, clips: [clip],
    } as Track;
    const after = Math.max(tracks.findIndex(x => x.id === DRUM_TRACK_ID), tracks.findIndex(x => x.id === 'instrumental'));
    tracks.splice(after + 1, 0, t);
  }
  const hasChords = (st.chords || []).some(ch => ch.end > start + 1e-6 && ch.start < start + len - 1e-6);
  return {
    state: { ...st, ...keyPatch, tracks, ...(hasChords ? {} : { chords: replaceRange(st.chords || [], start, start + len, evs) }) },
    message: `🔊 ${c.name} posée mesure ${barNo} sur la piste 808 (${c.bars} mesures, elle suit les fondamentales). Ctrl+Z pour annuler.`,
  };
}

/** Un son de la batterie du studio sur un nouveau pad (ou le pad `rowIndex`). */
export function placeStudioSound(dm: DrumMachine | null | undefined, libId: string, rowIndex: number | null = null): { dm: DrumMachine; rowIndex: number } | null {
  const cur = dm || makeDrumMachine('empty');
  const ref = libUrl(libId);
  const label = (libSoundLabel(ref) || 'Son du studio').split(' · ')[0];
  if (rowIndex !== null && cur.rows[rowIndex]) {
    const rows = cur.rows.map((r, i) => (i === rowIndex ? { ...r, sound: ref, name: label, tune: 0, decay: 1, start: undefined, end: undefined } : r));
    return { dm: { ...cur, rows }, rowIndex };
  }
  if (cur.rows.length >= MAX_PADS) return null;
  const len = STEPS_PER_BAR * (cur.bars || 1);
  let n = cur.rows.length + 1, rid = `lib${n}`;
  while (cur.rows.some(r => r.id === rid)) rid = `lib${++n}`;
  const row: DrumRow = { id: rid, name: label, sound: ref, steps: new Array(len).fill(0), ratchet: new Array(len).fill(1), volume: 0.85, pan: 0 };
  return { dm: { ...cur, rows: [...cur.rows, row] }, rowIndex: cur.rows.length };
}
