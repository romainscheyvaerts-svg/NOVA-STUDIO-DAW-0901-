/**
 * Lot 5 · Pré-écoute du navigateur de sons (navigateur seulement).
 *
 * - One-shots : le son du kit (808 et basses réaccordées sur la tonique du projet) ou de la
 *   batterie du studio, tel que les pads le jouent.
 * - Boucles : rendues hors temps réel (OfflineAudioContext) AU TEMPO DU PROJET avec les vrais
 *   sons NOVA (pads du kit, instrument multi-échantillons, 808), puis jouées sur le bus de
 *   pré-écoute. Les coups tombent sur la grille exacte (`loopHitTimes`, testé à 1 ms près).
 * - Aucun fichier n'est jamais proposé au téléchargement : le son n'existe qu'en mémoire.
 */
import type { MidiNote } from '../types';
import type { KitIndex } from './drumKitLibrary';
import { loadKitSound } from './drumKitLibrary';
import { drumSongClips } from './drumPatterns';
import { loadPadBuffer } from './padBuffers';
import { loadDrumSound } from './drumSounds';
import { libUrl } from './drumLibrary';
import { loadSamplerZones } from './samplerLoad';
import { pickZone, playbackRateFor, type MelodicSamplerSettings } from './melodicSampler';
import type { LoadedZone } from '../engine/MelodicSamplerNode';
import { loopContent, type LoopContent } from './soundPlace';
import type { SoundEntry } from './soundSearch';

const pc = (n: number) => ((Math.round(n) % 12) + 12) % 12;
const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Coups de batterie d'une boucle (s depuis le début), au tempo `bpm` : la grille du moteur. */
export function loopHitTimes(c: LoopContent, bpm: number): { row: number; t: number; vel: number }[] {
  if (!c.dm) return c.notes.map(n => ({ row: -1, t: n.start, vel: n.velocity }));
  const len = c.bars * 4 * (60 / bpm);
  const clips = drumSongClips(c.dm, bpm, len, 'preview');
  const out: { row: number; t: number; vel: number }[] = [];
  for (const cl of clips) for (const n of cl.notes || []) {
    if (cl.start + n.start >= len - 1e-6) continue;
    out.push({ row: n.pitch - 60, t: cl.start + n.start, vel: n.velocity > 1 ? n.velocity / 127 : n.velocity });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function renderChordNotes(off: OfflineAudioContext, notes: MidiNote[], instrument: string) {
  const zones = await loadSamplerZones({ instrument } as MelodicSamplerSettings, off) as LoadedZone[];
  if (!zones.length) throw new Error('instrument indisponible');
  notes.forEach((n, i) => {
    const z = pickZone(zones, n.pitch, Math.round(n.velocity * 127), i);
    if (!z) return;
    const src = off.createBufferSource();
    src.buffer = z.buffer;
    src.playbackRate.value = playbackRateFor(n.pitch, z.root, z.tune || 0);
    if (z.loopStart !== undefined && z.loopEnd !== undefined && z.loopEnd > z.loopStart) { src.loop = true; src.loopStart = z.loopStart; src.loopEnd = z.loopEnd; }
    const g = off.createGain();
    const t0 = n.start, t1 = n.start + n.duration;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.32 * (0.5 + 0.5 * n.velocity), t0 + 0.005);
    g.gain.setValueAtTime(0.32 * (0.5 + 0.5 * n.velocity), t1);
    g.gain.exponentialRampToValueAtTime(0.0005, t1 + 0.35);
    src.connect(g).connect(off.destination);
    src.start(t0, z.offset || 0);
    src.stop(t1 + 0.4);
  });
}

/** 808 de pré-écoute : sinus avec petite chute de hauteur à l'attaque, tenue, glissés entre notes qui se chevauchent. */
function render808(off: OfflineAudioContext, notes: MidiNote[]) {
  notes.forEach(n => {
    const o = off.createOscillator();
    o.type = 'sine';
    const f = midiToHz(n.pitch);
    o.frequency.setValueAtTime(f * 1.6, n.start);
    o.frequency.exponentialRampToValueAtTime(f, n.start + 0.03);
    const g = off.createGain();
    g.gain.setValueAtTime(0, n.start);
    g.gain.linearRampToValueAtTime(0.7 * n.velocity, n.start + 0.004);
    g.gain.setTargetAtTime(0.45 * n.velocity, n.start + 0.05, 0.25);
    g.gain.setValueAtTime(0.45 * n.velocity, n.start + n.duration);
    g.gain.exponentialRampToValueAtTime(0.0005, n.start + n.duration + 0.06);
    const sh = off.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(1.8 * x) / Math.tanh(1.8); }
    sh.curve = curve;
    o.connect(sh).connect(g).connect(off.destination);
    o.start(n.start); o.stop(n.start + n.duration + 0.08);
  });
}

/** Boucle rendue au tempo `bpm` (sons NOVA). `root` : tonique du projet pour les 808 des kits. */
export async function renderLoop(ref: string, bpm: number, sampleRate: number, ix: KitIndex | null, root = 0): Promise<AudioBuffer> {
  const c = loopContent(ref, bpm, ix);
  if (!c) throw new Error('boucle inconnue');
  const len = c.bars * 4 * (60 / bpm);
  const off = new OfflineAudioContext(2, Math.ceil((len + 0.6) * sampleRate), sampleRate);
  if (c.dm) {
    const rows = c.dm.rows;
    const bufs = await Promise.all(rows.map(r => loadPadBuffer(r, off, root).catch(() => null)));
    for (const h of loopHitTimes(c, bpm)) {
      const b = bufs[h.row];
      if (!b) continue;
      const src = off.createBufferSource();
      src.buffer = b;
      const g = off.createGain();
      g.gain.value = Math.max(0.15, Math.min(1, h.vel)) * (rows[h.row].volume ?? 0.85);
      src.connect(g).connect(off.destination);
      src.start(h.t);
    }
  } else if (c.ref.t === 'chords') {
    await renderChordNotes(off, c.notes, c.instrument || 'piano');
  } else {
    render808(off, c.notes);
  }
  return off.startRendering();
}

/** Pré-écoute d'un instrument : un accord de la tonalité du projet (Do majeur sinon). */
export async function renderInstrumentChord(instrument: string, sampleRate: number, root: number | null, minor: boolean): Promise<AudioBuffer> {
  const off = new OfflineAudioContext(2, Math.ceil(2.4 * sampleRate), sampleRate);
  const r = root === null ? 0 : pc(root);
  const base = 48 + r + (r > 6 ? 0 : 12);
  const notes: MidiNote[] = [0, minor ? 3 : 4, 7, 12].map((iv, i) => ({ id: `p${i}`, pitch: base + iv, start: i * 0.06, duration: 1.6, velocity: 0.75 }));
  await renderChordNotes(off, notes, instrument);
  return off.startRendering();
}

/** Son prêt à écouter pour une entrée du navigateur. */
export async function previewBuffer(e: SoundEntry, ctx: BaseAudioContext, o: { bpm: number; root: number | null; minor: boolean; ix: KitIndex | null }): Promise<AudioBuffer> {
  if (e.ref.startsWith('kit:')) return loadKitSound(e.ref, ctx, o.root ?? 0);
  if (e.ref.startsWith('lib:')) return loadDrumSound(libUrl(e.ref.slice(4)), ctx);
  if (e.ref.startsWith('inst:')) return renderInstrumentChord(e.ref.slice(5), ctx.sampleRate, o.root, o.minor);
  return renderLoop(e.ref, o.bpm, ctx.sampleRate, o.ix, o.root ?? 0);
}

/** Notes jouées par un instrument NOVA (pré-écoute de « Varier »), ou par la 808 de pré-écoute. */
export async function renderNotes(notes: MidiNote[], sampleRate: number, o: { instrument?: string; is808?: boolean }): Promise<AudioBuffer> {
  const end = Math.max(1, ...notes.map(n => n.start + n.duration));
  const off = new OfflineAudioContext(2, Math.ceil(Math.min(40, end + 0.6) * sampleRate), sampleRate);
  if (o.is808) render808(off, notes);
  else await renderChordNotes(off, notes, o.instrument || 'piano');
  return off.startRendering();
}

/** Squelette « Démarrer un beat » rendu (4 premières mesures) : batterie + accords + 808. */
export async function renderSkeleton(sk: import('./beatStarter').BeatSkeleton, sampleRate: number, ix: KitIndex | null): Promise<AudioBuffer> {
  const { drumMachineFor } = await import('./beatStarter');
  const bars = Math.min(4, sk.bars);
  const len = bars * 4 * (60 / sk.bpm);
  const off = new OfflineAudioContext(2, Math.ceil((len + 0.6) * sampleRate), sampleRate);
  const dm = drumMachineFor(sk, ix);
  const c: LoopContent = { ref: { t: 'drums', genre: sk.genre, variant: sk.variant }, bars, notes: [], chords: [], dm, name: '' };
  const bufs = await Promise.all(dm.rows.map(r => loadPadBuffer(r, off, sk.root).catch(() => null)));
  for (const h of loopHitTimes(c, sk.bpm)) {
    const b = bufs[h.row];
    if (!b) continue;
    const src = off.createBufferSource();
    src.buffer = b;
    const g = off.createGain();
    g.gain.value = Math.max(0.15, Math.min(1, h.vel)) * (dm.rows[h.row].volume ?? 0.85) * 0.9;
    src.connect(g).connect(off.destination);
    src.start(h.t);
  }
  const inRange = (n: MidiNote) => n.start < len - 1e-6;
  await renderChordNotes(off, sk.chordNotes.filter(inRange).map(n => ({ ...n, velocity: n.velocity * 0.8 })), sk.instrument).catch(() => {});
  render808(off, sk.bassNotes.filter(inRange));
  return off.startRendering();
}
