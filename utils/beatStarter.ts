/**
 * Lot 10 · « Démarrer un beat » à base de RÈGLES (aucune IA, aucun audio généré) :
 *
 *   genre → tempo typique, motif de batterie d'une recette connue (beatRecipes.ts, sources dans
 *   CONTENU/nova-151/sons-beat/RECETTES_BEAT.md), suite d'accords classique du genre dans la
 *   tonalité choisie (piste d'accords + piste d'instrument NOVA), ligne de 808 qui suit les
 *   fondamentales. Le dé donne 3 variantes (motif, suite, rythme de 808), toutes différentes.
 *
 * Le beatmaker reste l'auteur : on pose un squelette (8 mesures) qu'il modifie à la main.
 * Tout s'applique en UNE étape d'annulation (`applyBeatSkeleton` rend l'état suivant).
 *
 * Données pures (aucun React) : tests/beatStarter.test.ts.
 */
import type { Clip, DAWState, MidiNote, Track } from '../types';
import { TrackType } from '../types';
import type { ChordEvent, ChordQuality } from './chordDetect';
import { QUALITY_INTERVALS } from './chordDetect';
import { newChordId, replaceRange } from './chordTrack';
import type { DrumMachine, DrumRow } from './drumKits';
import { makeDrumMachine, drumPadsFor } from './drumKits';
import { commitActive, drumSongClips, rowStepsPerBar, type StepRate } from './drumPatterns';
import { applyKitDef, KIT_PAD_LAYOUT, type KitDef, type KitIndex } from './drumKitLibrary';
import { BASS808_TRACK_ID, kit808Style } from './bass808';
import { DEFAULT_SAMPLER, normalizeSampler } from './melodicSampler';
import { settingsForInstrument, instrumentPreset } from './instrumentPresets';
import { BEAT_GENRES, PROGRESSIONS, genreRecipe, type BeatGenreId, type BeatScale, type DrumLine, type GenreRecipe, type ProgressionDef } from './beatRecipes';
import { NOTE_NAMES_FR } from './scales';

export const DRUM_TRACK_ID = 'track-drums';
export const BEAT_CHORDS_TRACK_ID = 'track-beat-accords';
export const SKELETON_BARS = 8;

const pc = (n: number) => ((Math.round(n) % 12) + 12) % 12;
const MINOR: ReadonlySet<string> = new Set(['MINOR', 'MINOR_HARMONIC', 'PHRYGIAN', 'DORIAN']);
export const isMinor = (s?: string) => MINOR.has(s || '');
export const keyNameFr = (root: number, scale?: string) => `${NOTE_NAMES_FR[pc(root)]} ${isMinor(scale) ? 'mineur' : 'majeur'}`;

// ── Motifs de batterie ────────────────────────────────────────────────────────────────────
/**
 * Lecture d'une ligne de motif : « X » accent (118), « x » coup (100), « o » ghost (64), « . » silence,
 * « 2 » / « 3 » / « 4 » roll de 2, 3 ou 4 coups sur le pas (hi-hats trap). « | » sépare les mesures.
 */
export function parseHits(pattern: string): { vel: number[]; ratchet: number[] } {
  const vel: number[] = [], ratchet: number[] = [];
  for (const ch of pattern.replace(/[|\s]/g, '')) {
    const v = ch === 'X' ? 118 : ch === 'x' ? 100 : ch === 'o' ? 64 : /[234]/.test(ch) ? 92 : 0;
    vel.push(v);
    ratchet.push(/[234]/.test(ch) ? Number(ch) : 1);
  }
  return { vel, ratchet };
}

const ROLE_PAD: Record<string, string> = Object.fromEntries(KIT_PAD_LAYOUT.map(s => [s.role, s.id]));
/** Rôle d'une ligne de recette → pad de la boîte à rythmes. Les rôles sans pad du même nom vont sur un pad voisin. */
const padFor = (role: string) => ROLE_PAD[role] || (role === 'snap' ? 'clap' : role === 'rim' ? 'fx' : 'perc');

// ── Squelette ─────────────────────────────────────────────────────────────────────────────
export interface SkeletonDrums {
  bars: 1 | 2;
  swing: number;
  lines: DrumLine[];
  name: string;
}

export interface BeatSkeleton {
  genre: BeatGenreId;
  genreName: string;
  bpm: number;
  root: number;
  scale: BeatScale;
  bars: number;
  variant: number;
  progression: ProgressionDef;
  /** Piste d'accords (s, depuis le début du morceau). */
  chords: { start: number; end: number; root: number; quality: ChordQuality }[];
  /** Instrument NOVA des accords. */
  instrument: string;
  chordNotes: MidiNote[];
  bassNotes: MidiNote[];
  drums: SkeletonDrums;
  /** Résumé lisible (« Trap · 140 BPM · La mineur · i – VI – III – VII »). */
  summary: string;
}

export interface BeatOptions {
  genre: BeatGenreId;
  root?: number | null;
  /** Mineur ou majeur voulu (sinon le mode habituel du genre). */
  mode?: 'minor' | 'major' | null;
  bpm?: number | null;
  /** Variante 0, 1 ou 2 (le dé). */
  variant?: number;
  /** Graine du dé : change l'attribution motif / suite / 808 des 3 variantes. */
  seed?: number;
  bars?: number;
  beatsPerBar?: number;
}

/** Suites d'accords du genre dans le mode voulu (mineur / majeur), sinon toutes celles du genre. */
export function progressionsFor(genre: BeatGenreId, mode?: 'minor' | 'major' | null): ProgressionDef[] {
  const all = PROGRESSIONS.filter(p => p.genre === genre);
  if (!mode) return all;
  const f = all.filter(p => (mode === 'minor') === isMinor(p.scale));
  return f.length ? f : all;
}

/** Notes d'un accord (classes 0-11) : tierce, quinte, septième… */
export const chordPcs = (root: number, q: ChordQuality) => (QUALITY_INTERVALS[q] || QUALITY_INTERVALS.maj).map(i => pc(root + i));

/**
 * Voicing d'un accord au plus près du précédent (conduite des voix : renversement qui bouge le
 * moins), entre Mi3 et Sol5 environ.
 */
export function voiceChord(root: number, q: ChordQuality, prev: number[] | null, center = 62): number[] {
  const iv = QUALITY_INTERVALS[q] || QUALITY_INTERVALS.maj;
  const cands: number[][] = [];
  for (let base = 48; base <= 64; base++) {
    if (pc(base) !== pc(root)) continue;
    const pos = iv.map(i => base + i);
    for (let inv = 0; inv < pos.length; inv++) {
      const v = [...pos.slice(inv), ...pos.slice(0, inv).map(p => p + 12)].sort((a, b) => a - b);
      if (v[0] >= 52 && v[v.length - 1] <= 79) cands.push(v);
    }
  }
  const cost = (v: number[]) => {
    if (!prev) return Math.abs(v.reduce((a, b) => a + b, 0) / v.length - center);
    return v.reduce((s, p) => s + Math.min(...prev.map(x => Math.abs(x - p))), 0);
  };
  cands.sort((a, b) => cost(a) - cost(b));
  return cands[0] || iv.map(i => 60 + pc(root) + i);
}

/** Note de 808 (Do1 … Si1, MIDI 24-35) de la fondamentale. */
export const bassPitch = (root: number) => 24 + pc(root);

let nid = 0;
const noteId = (p: string) => `${p}-${Date.now().toString(36)}-${(nid++).toString(36)}`;

/** Accords posés sur `bars` mesures (la suite se répète). */
export function layoutChords(p: ProgressionDef, root: number, bpm: number, bars: number, beatsPerBar = 4) {
  const beat = 60 / bpm;
  const total = bars * beatsPerBar;
  const out: { start: number; end: number; root: number; quality: ChordQuality }[] = [];
  let b = 0;
  while (b < total - 1e-6) {
    for (const c of p.chords) {
      if (b >= total - 1e-6) break;
      const len = Math.min(c.beats, total - b);
      out.push({ start: b * beat, end: (b + len) * beat, root: pc(root + c.off), quality: c.q });
      b += len;
    }
  }
  return out;
}

/** Accords joués par l'instrument : rythme d'accompagnement du genre (« x--- » = attaque + tenue). */
export function chordNotesFor(chords: BeatSkeleton['chords'], g: GenreRecipe, bpm: number, variant: number, bars: number): MidiNote[] {
  const six = 60 / bpm / 4;
  const comp = g.comp[variant % g.comp.length].replace(/[|\s]/g, '');
  const span = comp.length; // en doubles-croches (1 ou 2 mesures)
  const total = bars * 16;
  const notes: MidiNote[] = [];
  let prev: number[] | null = null;
  const voiced = chords.map(c => { const v = voiceChord(c.root, c.quality, prev); prev = v; return v; });
  for (let s = 0; s < total; s++) {
    const ch = comp[s % span];
    if (ch !== 'x' && ch !== 'X') continue;
    let len = 1;
    while (s + len < total && comp[(s + len) % span] === '-') len++;
    const t = s * six;
    const ci = chords.findIndex(c => t >= c.start - 1e-6 && t < c.end - 1e-6);
    if (ci < 0) continue;
    // La note ne déborde pas sur l'accord suivant.
    const end = Math.min(t + len * six, chords[ci].end);
    voiced[ci].forEach(p => notes.push({ id: noteId('acc'), pitch: p, start: t, duration: Math.max(six / 2, end - t) * 0.98, velocity: ch === 'X' ? 0.82 : 0.7 }));
  }
  return notes;
}

/**
 * Ligne de 808 : la fondamentale de l'accord en cours sur le rythme de la recette, une attaque
 * obligatoire à chaque changement d'accord, tenue jusqu'au coup suivant. Drill : glissé (note
 * qui chevauche) vers la fondamentale suivante juste avant le changement.
 */
export function bassNotesFor(chords: BeatSkeleton['chords'], g: GenreRecipe, bpm: number, variant: number, bars: number, kickHits?: string): MidiNote[] {
  const six = 60 / bpm / 4;
  const rule = g.bass[variant % g.bass.length];
  const kick = kickHits ?? g.drums[variant % g.drums.length].lines.find(l => l.role === 'kick')?.hits;
  const pat = parseHits((rule.followKick && kick) || rule.hits || 'x...............').vel;
  const span = pat.length;
  const total = bars * 16;
  const hits = new Set<number>();
  for (let s = 0; s < total; s++) if (pat[s % span] > 0) hits.add(s);
  chords.forEach(c => hits.add(Math.round(c.start / six)));
  const sorted = [...hits].filter(s => s < total).sort((a, b) => a - b);
  const notes: MidiNote[] = [];
  sorted.forEach((s, i) => {
    const t = s * six;
    const c = chords.find(x => t >= x.start - 1e-6 && t < x.end - 1e-6) || chords[chords.length - 1];
    const next = i + 1 < sorted.length ? sorted[i + 1] : total;
    const oct = rule.octave && i % 4 === 3 ? 12 : 0;
    notes.push({ id: noteId('808'), pitch: bassPitch(c.root) + oct, start: t, duration: (next - s) * six * 0.98, velocity: s % 16 === 0 ? 0.95 : 0.88 });
  });
  if (rule.slides) {
    // Glissé : une note qui démarre une croche avant le changement et chevauche la note d'arrivée.
    chords.forEach((c, i) => {
      if (i === 0) return;
      const prev = chords[i - 1];
      if (pc(prev.root) === pc(c.root)) return;
      const st = c.start - 2 * six;
      if (st <= prev.start + 1e-6) return;
      notes.push({ id: noteId('808s'), pitch: bassPitch(c.root), start: st, duration: 3 * six, velocity: 0.8 });
    });
  }
  return notes.sort((a, b) => a.start - b.start);
}

/** Combinaison (motif de batterie, suite d'accords, rythme de 808 / accompagnement) d'une variante. */
export function variantPlan(g: GenreRecipe, progs: ProgressionDef[], variant: number, seed = 0) {
  // Le dé fait tourner motifs, suites et rythmes de 808 à des vitesses différentes : chaque lancer
  // donne d'autres combinaisons, et les 3 variantes d'un même lancer gardent 3 motifs différents.
  const v = ((variant % 3) + 3) % 3;
  const s = Math.max(0, Math.floor(seed));
  return {
    drum: (v + s) % g.drums.length,
    prog: progs.length ? progs[(v + 2 * s + Math.floor(s / 3)) % progs.length] : PROGRESSIONS.find(p => p.genre === g.id)!,
    bassRule: (v + s + Math.floor(s / 2)) % g.bass.length,
    comp: (v + s) % g.comp.length,
  };
}

export function buildBeat(o: BeatOptions): BeatSkeleton {
  const g = genreRecipe(o.genre);
  const progs = progressionsFor(g.id, o.mode ?? null);
  const plan = variantPlan(g, progs, o.variant ?? 0, o.seed ?? 0);
  const p = plan.prog;
  const root = typeof o.root === 'number' && Number.isFinite(o.root) ? pc(o.root) : g.defaultRoot;
  const bpm = o.bpm && o.bpm >= 40 && o.bpm <= 240 ? o.bpm : g.bpm;
  const bars = Math.max(1, Math.min(32, Math.round(o.bars ?? SKELETON_BARS)));
  const chords = layoutChords(p, root, bpm, bars, o.beatsPerBar || 4);
  const d = g.drums[plan.drum];
  return {
    genre: g.id, genreName: g.name, bpm, root, scale: p.scale, bars, variant: o.variant ?? 0, progression: p, chords,
    instrument: g.instruments[0],
    chordNotes: chordNotesFor(chords, g, bpm, plan.comp, bars),
    bassNotes: bassNotesFor(chords, g, bpm, plan.bassRule, bars, d.lines.find(l => l.role === 'kick')?.hits),
    drums: { bars: d.bars, swing: d.swing ?? g.swing ?? 0, lines: d.lines, name: d.name },
    summary: `${g.name} · ${Math.round(bpm)} BPM · ${keyNameFr(root, p.scale)} · ${p.roman}`,
  };
}

/** Les 3 variantes du dé (mêmes genre, tonalité et tempo). */
export function beatVariants(o: Omit<BeatOptions, 'variant'>): BeatSkeleton[] {
  return [0, 1, 2].map(variant => buildBeat({ ...o, variant }));
}

/** Coups de batterie d'un squelette, sur 8 mesures : « rôle@pas ». */
export function drumHits(sk: BeatSkeleton): string[] {
  const out: string[] = [];
  for (const l of sk.drums.lines) {
    const per = rowStepsPerBar({ rate: l.rate as StepRate | undefined });
    const { vel } = parseHits(l.hits);
    for (let s = 0; s < per * sk.bars; s++) if (vel[s % vel.length] > 0) out.push(`${l.role}@${(s / per).toFixed(3)}`);
  }
  return out;
}

/**
 * Distance entre deux squelettes : part des notes (accords, 808) et des coups de batterie de
 * l'un absents de l'autre (même hauteur, même départ à 1 ms près), dans les deux sens.
 */
export function skeletonDistance(a: BeatSkeleton, b: BeatSkeleton): number {
  const keys = (sk: BeatSkeleton) => [
    ...sk.chordNotes.map(n => `c${n.pitch}@${Math.round(n.start * 1000)}`),
    ...sk.bassNotes.map(n => `b${n.pitch}@${Math.round(n.start * 1000)}`),
    ...drumHits(sk),
  ];
  const ka = keys(a), kb = keys(b);
  const sa = new Set(ka), sb = new Set(kb);
  const ma = ka.filter(k => !sb.has(k)).length / Math.max(1, ka.length);
  const mb = kb.filter(k => !sa.has(k)).length / Math.max(1, kb.length);
  return Math.max(ma, mb);
}

// ── Pose dans le projet (une étape d'annulation) ──────────────────────────────────────────
/** Kit NOVA du genre (le n-ième de son style), null si l'index des kits n'est pas chargé. */
export function kitForGenre(g: GenreRecipe, ix: KitIndex | null, variant = 0): KitDef | null {
  if (!ix) return null;
  const list = ix.kits.filter(k => g.kitStyles.includes(k.style));
  const pool = list.length ? list : ix.kits;
  return pool.length ? pool[((variant % pool.length) + pool.length) % pool.length] : null;
}

/** Boîte à rythmes du squelette : kit NOVA du genre (sinon le kit synthé le plus proche) + motif. */
export function drumMachineFor(sk: BeatSkeleton, ix: KitIndex | null, variant = sk.variant): DrumMachine {
  const g = genreRecipe(sk.genre);
  const kit = kitForGenre(g, ix, variant);
  const base: DrumMachine = makeDrumMachine(g.fallbackKit);
  let dm: DrumMachine = { ...base, bars: sk.drums.bars, swing: sk.drums.swing, rows: base.rows.map(r => ({ ...r, steps: new Array(16 * sk.drums.bars).fill(0), ratchet: new Array(16 * sk.drums.bars).fill(1) })) };
  if (kit) dm = applyKitDef({ ...dm, rows: [] }, kit, ix);
  const rows: DrumRow[] = dm.rows.map(r => ({ ...r, steps: new Array(16 * sk.drums.bars).fill(0), ratchet: new Array(16 * sk.drums.bars).fill(1), rate: undefined }));
  for (const l of sk.drums.lines) {
    const row = rows.find(r => r.id === padFor(l.role));
    if (!row) continue;
    const per = rowStepsPerBar({ rate: l.rate as StepRate | undefined });
    const { vel, ratchet } = parseHits(l.hits);
    const len = per * sk.drums.bars;
    row.steps = Array.from({ length: len }, (_, i) => vel[i % vel.length] || 0);
    row.ratchet = Array.from({ length: len }, (_, i) => ratchet[i % ratchet.length] || 1);
    if (l.rate && l.rate !== '16') row.rate = l.rate as StepRate;
  }
  return { ...dm, kitId: kit ? `nova:${kit.id}` : base.kitId, rows, patterns: undefined, activePattern: undefined, song: undefined };
}

/** Gamme du projet (Auto-Tune, aimant du piano roll) : phrygien et dorien comptent comme mineur. */
export const projectScaleOf = (s: BeatScale): string => (s === 'MAJOR' ? 'MAJOR' : s === 'MINOR_HARMONIC' ? 'MINOR_HARMONIC' : 'MINOR');

export interface ApplyBeatResult { state: DAWState; message: string; keptTempo: boolean }

/** Le projet a-t-il déjà une instru (piste BEAT avec un clip) ? Le squelette suit alors son tempo et sa tonalité. */
export const hasLoadedBeat = (st: Pick<DAWState, 'tracks'>) => !!st.tracks.find(t => t.id === 'instrumental')?.clips.some(c => !c.isMuted && c.duration > 0);

/**
 * Pose le squelette : batterie (piste PERCUSSIONS), 808, piste d'accords et piste d'instrument,
 * tempo et tonalité du projet. Remplace les pistes du squelette précédent. État suivant, pur.
 */
export function applyBeatSkeleton(st: DAWState, sk: BeatSkeleton, ix: KitIndex | null): ApplyBeatResult {
  const g = genreRecipe(sk.genre);
  const keptTempo = hasLoadedBeat(st);
  const bpm = keptTempo ? st.bpm : sk.bpm;
  const bpb = st.timeSignature?.numerator || 4;
  const bar = (60 / bpm) * bpb;
  const songLen = sk.bars * bar;
  const beatTrack = st.tracks.find(t => t.id === 'instrumental');
  const beatEnd = beatTrack ? Math.max(0, ...beatTrack.clips.map(c => c.start + c.duration)) : 0;
  const tracks: Track[] = st.tracks.map(t => t);

  // 1. Batterie.
  let dm = commitActive(drumMachineFor(sk, ix));
  const drumEnd = Math.max(beatEnd, bar * Math.max(8, sk.bars));
  const stamp = Date.now().toString(36);
  const drumClips = drumSongClips(dm, bpm, drumEnd, `clip-drums-${stamp}`);
  dm = { ...dm, bpmUsed: bpm };
  const di = tracks.findIndex(t => t.id === DRUM_TRACK_ID);
  const drumTrack: Track = di >= 0
    ? { ...tracks[di], clips: drumClips as Clip[], drumMachine: dm, drumPads: drumPadsFor(dm) as any, isMuted: false }
    : {
      id: DRUM_TRACK_ID, name: 'PERCUSSIONS', type: TrackType.DRUM_RACK, color: '#f97316', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
      volume: 0.85, pan: 0, outputTrackId: 'master', sends: [], clips: drumClips as Clip[], plugins: [],
      automationLanes: [{ id: `auto-${stamp}-drums`, parameterName: 'volume', points: [], color: '#f97316', isExpanded: false, min: 0, max: 1.5 }],
      totalLatency: 0, drumMachine: dm, drumPads: drumPadsFor(dm) as any,
    } as Track;
  if (di >= 0) tracks[di] = drumTrack;
  else { const bi = tracks.findIndex(t => t.id === 'instrumental'); tracks.splice(bi + 1, 0, drumTrack); }

  // Notes au tempo réellement retenu (une instru déjà chargée garde le sien).
  const rescale = (ns: MidiNote[]) => (bpm === sk.bpm ? ns : ns.map(n => ({ ...n, start: (n.start * sk.bpm) / bpm, duration: (n.duration * sk.bpm) / bpm })));
  const chordNotes = rescale(sk.chordNotes), bassNotes = rescale(sk.bassNotes);

  // 2. 808.
  const kitId = dm.kitId;
  const clip808: Clip = { id: `clip-808-${stamp}`, start: 0, duration: songLen, offset: 0, fadeIn: 0, fadeOut: 0, name: '808', color: '#d946ef', type: TrackType.MIDI, notes: bassNotes, isMuted: false, gain: 1 };
  const bi8 = tracks.findIndex(t => t.id === BASS808_TRACK_ID);
  const style808 = g.dist808 ? '808-dist' : kit808Style(kitId);
  const t808: Track = bi8 >= 0
    ? { ...tracks[bi8], clips: [clip808], bass808: { ...(tracks[bi8].bass808 || { glide: true }), style: style808, glide: true } as any }
    : {
      id: BASS808_TRACK_ID, name: '808', type: TrackType.MIDI, color: '#d946ef', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
      volume: 0.85, pan: 0, outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0,
      bass808: { style: style808, glide: true } as any, clips: [clip808],
    } as Track;
  if (bi8 >= 0) tracks[bi8] = t808;
  else tracks.splice(tracks.findIndex(t => t.id === DRUM_TRACK_ID) + 1, 0, t808);

  // 3. Accords : piste d'instrument NOVA.
  const inst = instrumentPreset(sk.instrument);
  const clipAcc: Clip = { id: `clip-accords-${stamp}`, start: 0, duration: songLen, offset: 0, fadeIn: 0, fadeOut: 0, name: `Accords ${sk.genreName}`, color: '#22d3ee', type: TrackType.MIDI, notes: chordNotes, isMuted: false, gain: 1 };
  const ci = tracks.findIndex(t => t.id === BEAT_CHORDS_TRACK_ID);
  const tAcc: Track = {
    ...(ci >= 0 ? tracks[ci] : {
      id: BEAT_CHORDS_TRACK_ID, type: TrackType.MIDI, color: '#22d3ee', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
      volume: 0.7, pan: 0, outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0,
    }),
    name: `ACCORDS ${(inst?.name || sk.instrument).toUpperCase()}`.slice(0, 28),
    melodicSampler: normalizeSampler({ ...DEFAULT_SAMPLER, ...settingsForInstrument(sk.instrument) }),
    clips: [clipAcc],
  } as Track;
  if (ci >= 0) tracks[ci] = tAcc;
  else tracks.splice(tracks.findIndex(t => t.id === BASS808_TRACK_ID) + 1, 0, tAcc);

  // 4. Piste d'accords (remplace les accords des 8 premières mesures).
  const evs: ChordEvent[] = sk.chords.map(c => ({ id: newChordId(), start: (c.start * sk.bpm) / bpm, end: (c.end * sk.bpm) / bpm, root: c.root, quality: c.quality }));
  const chords = replaceRange(st.chords || [], 0, songLen, evs);

  const next: DAWState = {
    ...st, tracks, chords,
    ...(keptTempo ? {} : { bpm, projectKey: sk.root, projectScale: projectScaleOf(sk.scale) }),
  };
  const message = keptTempo
    ? `🥁 Squelette ${sk.genreName} posé sur ton instru (${Math.round(bpm)} BPM gardés) : batterie, 808 et accords ${sk.progression.roman}. Ctrl+Z pour annuler.`
    : `🥁 Squelette ${sk.summary} posé : batterie, 808 qui suit les accords, ${inst?.name || 'instrument'} et piste d'accords. Ctrl+Z pour annuler.`;
  return { state: next, message, keptTempo };
}

export { BEAT_GENRES };
