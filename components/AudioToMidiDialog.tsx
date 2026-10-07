import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { produce } from 'immer';
import type { Clip, DAWState, MidiNote, Track } from '../types';
import { TrackType } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { analyzeRegion, AnalysisResult } from '../utils/pitchEdit';
import {
  applyDrumSteps, buildMidiTrack, chordsToNotes, clipDurationFor, clipStartFor, detectDrumHits, DrumHit, DRUM_KIND_LABEL, DrumKind,
  hitsToGmNotes, hitsToSteps, HUM_INSTRUMENTS, HumInstrument, humInstrument, loopBars, melodyAccuracy, melodyNotes, MelodyNote,
} from '../utils/audioToMidi';
import { chordNameFr, chordSymbol, ChordEvent } from '../utils/chordDetect';
import { detectChordsInClips, replaceRange, sanitizeChords } from '../utils/chordTrack';
import { monoSlice } from '../utils/spectrum';
import { keyLabelFr, noteNameFr } from '../utils/scales';
import { makeDrumMachineLib, suggestDrumKit, DrumMachine } from '../utils/drumKits';
import { playheadStore } from '../utils/playheadStore';
import { presetSettings } from '../utils/novaSynthPresets';
import { plan808 } from '../utils/bass808';
import { chordColor } from './ChordLane';
import { openNovaWindow } from '../utils/novaWindows';

/**
 * Audio → MIDI (V20) : « Convert Melody / Drums / Harmony to MIDI »
 * d'Ableton Live, « Create MIDI » du Flex Pitch de Logic.
 *
 *  - Mélodie : une voix (clip, ou chantonnée au micro) devient une piste
 *    MIDI : 808 qui suit la mélodie, piano, lead ou nappe du synthé NOVA.
 *    Calage gamme et grille dosés, nuances gardées ou non, aperçu avant de
 *    valider (« Fredonne → 808 / piano »).
 *  - Batterie : une boucle devient le motif de la boîte à rythmes (kick,
 *    snare / clap, hi-hat) ou une piste MIDI General MIDI (36 / 38 / 42).
 *  - Harmonie : les accords d'un sample deviennent des accords MIDI (et,
 *    au choix, remplissent la piste d'accords).
 * Rien n'est détruit : une piste est ajoutée (Ctrl+Z pour revenir).
 * Téléphone : version simple (Fredonne → 808 / piano, Écouter, Créer).
 */

export type ConvertMode = 'melody' | 'drums' | 'harmony';

export interface AudioToMidiRequest {
  mode: ConvertMode;
  trackId?: string;
  clipId?: string;
  /** Chanter au micro plutôt que partir d'un clip. */
  mic?: boolean;
  instrument?: HumInstrument;
  /** Version simple (téléphone, bouton « Fredonne → 808 »). */
  simple?: boolean;
}

interface Props {
  request: AudioToMidiRequest | null;
  tracks: Track[];
  bpm: number;
  beatsPerBar?: number;
  projectKey?: number;
  projectScale?: string;
  setState: (fn: (prev: DAWState) => DAWState) => void;
  onClose: () => void;
}

type Status = 'idle' | 'countin' | 'recording' | 'analyzing' | 'ready' | 'empty' | 'error';

const notify = (detail: string) => { try { window.dispatchEvent(new CustomEvent('nova:notify', { detail })); } catch { /* hors navigateur */ } };
const isPhone = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches;
const TITLES: Record<ConvertMode, { title: string; tip: string; icon: string }> = {
  melody: { title: 'Fredonne → MIDI', icon: 'fa-microphone-lines', tip: 'Ta mélodie chantée ou fredonnée devient des notes MIDI (comme Convert Melody to MIDI d’Ableton Live ou « Create MIDI » du Flex Pitch de Logic).' },
  drums: { title: 'Batterie → MIDI', icon: 'fa-drum', tip: 'Une boucle de batterie devient un motif : kick, snare / clap et hi-hat (comme Convert Drums to MIDI d’Ableton Live).' },
  harmony: { title: 'Harmonie → MIDI', icon: 'fa-guitar', tip: 'Les accords d’un sample ou d’un beat deviennent des accords MIDI (comme Convert Harmony to MIDI d’Ableton Live ou Chord ID de Logic).' },
};
const GRID_CHOICES = [{ v: 1, label: '1/4' }, { v: 0.5, label: '1/8' }, { v: 0.25, label: '1/16' }];

/** Dernière prise de voix du projet (clip audio d'une piste voix). */
export function lastVoiceClip(tracks: Track[]): { trackId: string; clipId: string } | null {
  let best: { trackId: string; clipId: string; at: number } | null = null;
  for (const t of tracks) {
    if (t.type !== TrackType.AUDIO || t.id === 'instrumental' || t.instrumentId || /beat|instru|sample|stem/i.test(t.name)) continue;
    for (const c of t.clips) {
      if (c.isMuted || !(c.buffer || (c.bufferId && audioBufferRegistry.has(c.bufferId)))) continue;
      const at = (c.takeNumber || 0) * 1e6 + c.start;
      if (!best || at > best.at) best = { trackId: t.id, clipId: c.id, at };
    }
  }
  return best ? { trackId: best.trackId, clipId: best.clipId } : null;
}

const bufferOf = (c?: Clip) => (c?.buffer || (c?.bufferId ? audioBufferRegistry.get(c.bufferId) : undefined));

// ---------------------------------------------------------------------------
// Aperçu sonore (son du synthé NOVA / de la 808, batterie simple)
// ---------------------------------------------------------------------------

function usePreview() {
  const ctxRef = useRef<AudioContext | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const [playing, setPlaying] = useState(false);
  const stop = useCallback(() => { stopRef.current?.(); stopRef.current = null; setPlaying(false); }, []);
  useEffect(() => () => { stop(); void ctxRef.current?.close().catch(() => {}); }, [stop]);
  const ctx = () => {
    if (!ctxRef.current || ctxRef.current.state === 'closed') ctxRef.current = new AudioContext();
    void ctxRef.current.resume();
    return ctxRef.current;
  };
  /** Joue des notes (temps relatifs, s) avec l'instrument choisi, et éventuellement l'audio d'origine. */
  const playNotes = useCallback(async (notes: { pitch: number; start: number; duration: number; velocity: number }[], kind: HumInstrument | 'keys', withAudio?: { buffer: AudioBuffer; offset: number; duration: number; delay: number }) => {
    stop();
    const c = ctx();
    const out = c.createGain(); out.gain.value = 0.8; out.connect(c.destination);
    const t0 = c.currentTime + 0.12;
    const end = notes.reduce((m, n) => Math.max(m, n.start + n.duration), 0) + 0.6;
    const nodes: { stop: () => void }[] = [];
    if (kind === '808') {
      const { Bass808Node } = await import('../engine/Bass808Node');
      const b = new Bass808Node(c, '808');
      await b.ready;
      b.output.connect(out);
      b.playVoices(plan808(notes, true), -t0);
      nodes.push({ stop: () => { try { b.stopAll(); b.output.disconnect(); } catch { /* */ } } });
    } else {
      const { NovaSynthNode } = await import('../engine/NovaSynthNode');
      const s = new NovaSynthNode(c, kind === 'keys' ? presetSettings('keys-rnb') : presetSettings(humInstrument(kind).presetId || 'piano-doux'));
      await s.ready;
      s.output.connect(out);
      for (const n of notes) { s.triggerAttack(n.pitch, n.velocity, t0 + n.start); s.triggerRelease(n.pitch, t0 + n.start + n.duration); }
      nodes.push({ stop: () => { try { s.releaseAll(); s.output.disconnect(); } catch { /* */ } } });
    }
    if (withAudio) {
      const src = c.createBufferSource(); src.buffer = withAudio.buffer;
      const g = c.createGain(); g.gain.value = 0.7; src.connect(g); g.connect(out);
      src.start(t0 + withAudio.delay, withAudio.offset, withAudio.duration);
      nodes.push({ stop: () => { try { src.stop(); } catch { /* */ } } });
    }
    setPlaying(true);
    const timer = window.setTimeout(() => stop(), (end + 0.2) * 1000);
    stopRef.current = () => { window.clearTimeout(timer); nodes.forEach(n => n.stop()); try { out.disconnect(); } catch { /* */ } };
  }, [stop]);
  /** Batterie de l'aperçu : kick, snare, hi-hat synthétisés. */
  const playDrums = useCallback((hits: { time: number; kind: DrumKind; velocity: number }[], loopLen: number) => {
    stop();
    const c = ctx();
    const out = c.createGain(); out.gain.value = 0.8; out.connect(c.destination);
    const t0 = c.currentTime + 0.1;
    const noise = c.createBuffer(1, c.sampleRate * 0.3, c.sampleRate);
    const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const play = (k: DrumKind, at: number, v: number) => {
      if (k === 'kick') {
        const o = c.createOscillator(), g = c.createGain();
        o.frequency.setValueAtTime(150, at); o.frequency.exponentialRampToValueAtTime(45, at + 0.12);
        g.gain.setValueAtTime(v, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.35);
        o.connect(g); g.connect(out); o.start(at); o.stop(at + 0.4);
      } else {
        const s = c.createBufferSource(); s.buffer = noise;
        const f = c.createBiquadFilter(); f.type = k === 'hat' ? 'highpass' : 'bandpass'; f.frequency.value = k === 'hat' ? 7000 : 1800;
        const g = c.createGain(); g.gain.setValueAtTime(v * (k === 'hat' ? 0.35 : 0.8), at); g.gain.exponentialRampToValueAtTime(0.001, at + (k === 'hat' ? 0.05 : 0.18));
        s.connect(f); f.connect(g); g.connect(out); s.start(at); s.stop(at + 0.25);
      }
    };
    for (let rep = 0; rep < 2; rep++) for (const h of hits) play(h.kind, t0 + rep * loopLen + h.time, h.velocity);
    setPlaying(true);
    const timer = window.setTimeout(() => stop(), (loopLen * 2 + 0.5) * 1000);
    stopRef.current = () => { window.clearTimeout(timer); try { out.disconnect(); } catch { /* */ } };
  }, [stop]);
  return { playing, stop, playNotes, playDrums };
}

// ---------------------------------------------------------------------------
// Prise au micro (décompte d'une mesure, clic au tempo)
// ---------------------------------------------------------------------------

function useMicHum(bpm: number, beatsPerBar: number) {
  const ref = useRef<{ ctx: AudioContext; stream: MediaStream; proc: ScriptProcessorNode; chunks: Float32Array[]; startAt: number; timer: number } | null>(null);
  const start = useCallback(async (onPhase: (s: 'countin' | 'recording') => void) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const ctx = new AudioContext();
    await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const beat = 60 / Math.max(20, bpm);
    const startAt = ctx.currentTime + 0.15 + beat * beatsPerBar; // après une mesure de décompte
    const chunks: Float32Array[] = [];
    proc.onaudioprocess = (e) => {
      const at = e.playbackTime;
      const data = e.inputBuffer.getChannelData(0);
      const skip = Math.max(0, Math.round((startAt - at) * ctx.sampleRate));
      if (skip < data.length) chunks.push(data.slice(skip));
    };
    src.connect(proc); proc.connect(ctx.destination);
    // Clic : décompte puis tempo (plus aigu sur le 1er temps).
    let next = ctx.currentTime + 0.15, k = 0;
    const tick = () => {
      while (next < ctx.currentTime + 0.5) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = k % beatsPerBar === 0 ? 1600 : 1100;
        g.gain.setValueAtTime(k < beatsPerBar ? 0.35 : 0.15, next); g.gain.exponentialRampToValueAtTime(0.001, next + 0.05);
        o.connect(g); g.connect(ctx.destination); o.start(next); o.stop(next + 0.06);
        next += beat; k++;
      }
    };
    tick();
    const timer = window.setInterval(tick, 100);
    ref.current = { ctx, stream, proc, chunks, startAt, timer };
    onPhase('countin');
    window.setTimeout(() => { if (ref.current?.ctx === ctx) onPhase('recording'); }, Math.max(0, (startAt - ctx.currentTime) * 1000));
  }, [bpm, beatsPerBar]);
  const stop = useCallback((): { data: Float32Array; sr: number } | null => {
    const r = ref.current;
    if (!r) return null;
    ref.current = null;
    window.clearInterval(r.timer);
    try { r.proc.disconnect(); } catch { /* */ }
    r.stream.getTracks().forEach(t => t.stop());
    const n = r.chunks.reduce((a, c) => a + c.length, 0);
    const data = new Float32Array(n);
    let o = 0; for (const c of r.chunks) { data.set(c, o); o += c.length; }
    const sr = r.ctx.sampleRate;
    void r.ctx.close().catch(() => {});
    return { data, sr };
  }, []);
  useEffect(() => () => { stop(); }, [stop]);
  return { start, stop };
}

/** Faux AudioBuffer mono (prise au micro) pour l'analyse. */
const monoBuffer = (data: Float32Array, sr: number): AudioBuffer => ({
  sampleRate: sr, length: data.length, duration: data.length / sr, numberOfChannels: 1,
  getChannelData: () => data, copyFromChannel: () => {}, copyToChannel: () => {},
}) as unknown as AudioBuffer;

// ---------------------------------------------------------------------------
// Fenêtre
// ---------------------------------------------------------------------------

const AudioToMidiDialog: React.FC<Props> = ({ request, tracks, bpm, beatsPerBar = 4, projectKey, projectScale, setState, onClose }) => {
  const open = !!request;
  const mode: ConvertMode = request?.mode || 'melody';
  const simple = !!request?.simple || isPhone();
  const beat = 60 / Math.max(20, bpm || 120);
  const bar = beat * beatsPerBar;
  const hasKey = typeof projectKey === 'number' && !!projectScale && !/CHROMATIC/i.test(projectScale);

  // Source : un clip, ou le micro.
  const [source, setSource] = useState<{ trackId: string; clipId: string } | 'mic' | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [melody, setMelody] = useState<{ analysis: AnalysisResult; timeOffset: number; audio?: { buffer: AudioBuffer; offset: number; duration: number } } | null>(null);
  const [drums, setDrums] = useState<{ hits: DrumHit[]; clipStart: number; duration: number } | null>(null);
  const [chords, setChords] = useState<ChordEvent[]>([]);
  // Réglages
  const [instrument, setInstrument] = useState<HumInstrument>('808');
  const [scaleAmt, setScaleAmt] = useState(100);
  const [gridAmt, setGridAmt] = useState(75);
  const [gridBeats, setGridBeats] = useState(0.25);
  const [keepVel, setKeepVel] = useState(true);
  const [drumDest, setDrumDest] = useState<'machine' | 'gm'>('machine');
  const [sens, setSens] = useState(50);
  const [muteLoop, setMuteLoop] = useState(false);
  const [harmInst, setHarmInst] = useState<'keys' | 'piano' | 'pad'>('keys');
  const [harmBass, setHarmBass] = useState(true);
  const [fillLane, setFillLane] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const preview = usePreview();
  const mic = useMicHum(bpm, beatsPerBar);
  const micStartRef = useRef(0);

  const sourceClip = source && source !== 'mic' ? tracks.find(t => t.id === source.trackId)?.clips.find(c => c.id === source.clipId) : undefined;
  const sourceTrack = source && source !== 'mic' ? tracks.find(t => t.id === source.trackId) : undefined;

  // Ouverture : source et instrument par défaut.
  useEffect(() => {
    if (!request) return;
    setStatus('idle'); setError(''); setMelody(null); setDrums(null); setChords([]); setShowSettings(false);
    setInstrument(request.instrument || '808');
    if (request.mic) setSource('mic');
    else if (request.trackId && request.clipId) setSource({ trackId: request.trackId, clipId: request.clipId });
    else if (request.mode === 'melody') setSource(lastVoiceClip(tracks) || 'mic');
    else setSource(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
  useEffect(() => { if (!open) { preview.stop(); mic.stop(); } }, [open, preview, mic]);

  // Analyse du clip choisi.
  useEffect(() => {
    if (!open || !source || source === 'mic') return;
    const clip = sourceClip;
    const buffer = bufferOf(clip);
    if (!clip || !buffer) { setStatus('error'); setError("Le son de ce clip n'est pas chargé : lance la lecture une fois puis réessaie."); return; }
    if (clip.isReversed) { setStatus('error'); setError('Ce clip est inversé : remets-le à l’endroit (menu du clip) pour le convertir.'); return; }
    let alive = true;
    const off = clip.offset || 0;
    const end = Math.min(buffer.duration, off + clip.duration);
    setStatus('analyzing');
    const run = async () => {
      if (mode === 'melody') {
        const analysis = await analyzeRegion(buffer, off, end);
        if (!alive) return;
        setMelody({ analysis, timeOffset: clip.start, audio: { buffer, offset: off, duration: end - off } });
        setStatus(analysis.notes.length ? 'ready' : 'empty');
      } else if (mode === 'drums') {
        await new Promise(r => setTimeout(r, 20));
        const hits = detectDrumHits(monoSlice(buffer, off, end), buffer.sampleRate, { sensitivity: sens / 100 });
        if (!alive) return;
        setDrums({ hits, clipStart: clip.start, duration: end - off });
        setStatus(hits.length ? 'ready' : 'empty');
      } else {
        await new Promise(r => setTimeout(r, 20));
        const found = detectChordsInClips([{ start: clip.start, duration: end - off, offset: off, buffer }], bpm, beatsPerBar);
        if (!alive) return;
        setChords(found);
        setStatus(found.length ? 'ready' : 'empty');
      }
    };
    run().catch(e => { if (alive) { setStatus('error'); setError(`Analyse impossible : ${e?.message || e}`); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source && source !== 'mic' ? `${source.trackId}/${source.clipId}` : source, mode, mode === 'drums' ? sens : 0]);

  // Notes de la mélodie avec les réglages.
  const notes: MelodyNote[] = useMemo(() => {
    if (!melody) return [];
    return melodyNotes(melody.analysis.notes, melody.analysis.track, {
      bpm, keyRoot: hasKey ? projectKey : undefined, scale: hasKey ? projectScale : undefined, scaleAmount: scaleAmt / 100,
      gridAmount: gridAmt / 100, gridBeats, keepVelocity: keepVel, instrument, timeOffset: melody.timeOffset,
    });
  }, [melody, bpm, hasKey, projectKey, projectScale, scaleAmt, gridAmt, gridBeats, keepVel, instrument]);

  const drumBars = drums ? loopBars(drums.duration, bpm, beatsPerBar) : 1;
  const drumOrigin = drums ? Math.floor(drums.clipStart / bar + 1e-6) * bar - drums.clipStart : 0;
  const steps = useMemo(() => (drums ? hitsToSteps(drums.hits, { bpm, origin: drumOrigin, bars: drumBars }) : null), [drums, bpm, drumOrigin, drumBars]);

  // ----- Micro -----
  const startMic = async () => {
    preview.stop();
    micStartRef.current = Math.max(0, Math.round(playheadStore.get() / bar) * bar);
    try {
      await mic.start(phase => setStatus(phase));
    } catch (e: any) {
      setStatus('error');
      setError(e?.name === 'NotAllowedError' ? 'Micro refusé : autorise le micro pour NOVA (icône du cadenas dans la barre d’adresse), puis réessaie.' : `Micro indisponible : ${e?.message || e}`);
    }
  };
  const stopMic = async () => {
    const r = mic.stop();
    if (!r || r.data.length < r.sr * 0.3) { setStatus('empty'); return; }
    setStatus('analyzing');
    try {
      const buf = monoBuffer(r.data, r.sr);
      const analysis = await analyzeRegion(buf, 0, buf.duration);
      setMelody({ analysis, timeOffset: micStartRef.current, audio: { buffer: buf, offset: 0, duration: buf.duration } });
      setStatus(analysis.notes.length ? 'ready' : 'empty');
    } catch (e: any) { setStatus('error'); setError(`Analyse impossible : ${e?.message || e}`); }
  };

  // ----- Écoute -----
  const listen = (withVoice = false) => {
    if (preview.playing) { preview.stop(); return; }
    if (mode === 'melody' && notes.length) {
      const t0 = clipStartFor(notes[0].start, bpm, beatsPerBar);
      const rel = notes.map(n => ({ ...n, start: n.start - t0 }));
      const a = melody?.audio;
      void preview.playNotes(rel, instrument, withVoice && a ? { buffer: a.buffer, offset: a.offset, duration: a.duration, delay: melody!.timeOffset - t0 } : undefined);
    } else if (mode === 'drums' && drums) {
      void preview.playDrums(drums.hits.flatMap(h => [h, ...(h.also || []).map(k => ({ ...h, kind: k, velocity: h.velocity * 0.85 }))]), Math.max(drums.duration, beat));
    } else if (mode === 'harmony' && chords.length) {
      const t0 = chords[0].start;
      void preview.playNotes(chordsToNotes(chords, { origin: t0, bass: harmBass }), harmInst === 'keys' ? 'keys' : harmInst);
    }
  };

  // ----- Validation -----
  const insertTrack = (track: Track, afterId?: string) => setState(prev => produce(prev, (d: DAWState) => {
    const i = afterId ? d.tracks.findIndex(t => t.id === afterId) : -1;
    const master = d.tracks.findIndex(t => t.id === 'master');
    d.tracks.splice(i >= 0 ? i + 1 : master >= 0 ? master : d.tracks.length, 0, track as any);
    d.selectedTrackId = track.id;
  }));
  const create = () => {
    preview.stop();
    const stamp = Date.now().toString(36);
    if (mode === 'melody') {
      if (!notes.length) return;
      const start = clipStartFor(notes[0].start, bpm, beatsPerBar);
      const mids: MidiNote[] = notes.map((n, i) => ({ id: `hum-${stamp}-${i}`, pitch: n.pitch, start: n.start - start, duration: n.duration, velocity: n.velocity }));
      const inst = humInstrument(instrument);
      const track = buildMidiTrack({ id: `track-hum-${stamp}`, clipId: `clip-hum-${stamp}`, name: `Fredonne → ${inst.label}`, kind: instrument, start, duration: clipDurationFor(mids, bpm, beatsPerBar), notes: mids });
      insertTrack(track, sourceTrack?.id);
      notify(`${inst.emoji} Piste « ${track.name} » créée : ${mids.length} notes${hasKey && scaleAmt > 0 ? `, dans la gamme ${keyLabelFr(projectKey, projectScale)}` : ''}. Double-clique le clip pour l’ouvrir au piano roll (Ctrl+Z pour revenir).`);
    } else if (mode === 'drums' && drums && steps) {
      if (drumDest === 'machine') {
        const cur = tracks.find(t => t.id === 'track-drums')?.drumMachine as DrumMachine | undefined;
        const dm = applyDrumSteps(cur || makeDrumMachineLib(suggestDrumKit(bpm)), steps, drumBars);
        try { window.dispatchEvent(new CustomEvent('nova:apply-drum-machine', { detail: { dm } })); } catch { /* */ }
        const count = (['kick', 'snare', 'hat'] as DrumKind[]).map(k => `${steps[k].filter(v => v > 0).length} ${DRUM_KIND_LABEL[k].toLowerCase()}`).join(', ');
        notify(`🥁 Motif de la boucle posé dans la boîte à rythmes (${drumBars} mesure${drumBars > 1 ? 's' : ''} : ${count}). Ouvre la batterie pour changer les sons.`);
      } else {
        const q = (t: number) => Math.round(t / (beat / 4)) * (beat / 4);
        const mids = hitsToGmNotes(drums.hits).map(n => ({ ...n, id: `gm-${stamp}-${n.id}`, start: Math.max(0, q(drums.clipStart + n.start) - drums.clipStart) }));
        const track = buildMidiTrack({ id: `track-gm-${stamp}`, clipId: `clip-gm-${stamp}`, name: 'Batterie (MIDI)', kind: 'gm-drums', start: drums.clipStart, duration: clipDurationFor(mids, bpm, beatsPerBar), notes: mids });
        insertTrack(track, sourceTrack?.id);
        notify('🥁 Piste MIDI créée (General MIDI : 36 kick, 38 snare, 42 hi-hat) : charge-lui un instrument de batterie VST.');
      }
      if (muteLoop && source && source !== 'mic') setState(prev => produce(prev, (d: DAWState) => {
        const c = d.tracks.find(t => t.id === source.trackId)?.clips.find(x => x.id === source.clipId);
        if (c) c.isMuted = true;
      }));
    } else if (mode === 'harmony' && chords.length) {
      const start = chords[0].start;
      const mids = chordsToNotes(chords, { origin: start, bass: harmBass }).map((n, i) => ({ ...n, id: `harm-${stamp}-${i}` }));
      const name = harmInst === 'keys' ? 'Accords (keys)' : harmInst === 'piano' ? 'Accords (piano)' : 'Accords (nappe)';
      const track = buildMidiTrack({ id: `track-harm-${stamp}`, clipId: `clip-harm-${stamp}`, name, kind: harmInst, start, duration: clipDurationFor(mids, bpm, beatsPerBar), notes: mids });
      setState(prev => produce(prev, (d: DAWState) => {
        const i = sourceTrack ? d.tracks.findIndex(t => t.id === sourceTrack.id) : -1;
        const master = d.tracks.findIndex(t => t.id === 'master');
        d.tracks.splice(i >= 0 ? i + 1 : master >= 0 ? master : d.tracks.length, 0, track as any);
        if (fillLane) {
          const end = chords[chords.length - 1].end;
          d.chords = replaceRange(sanitizeChords(d.chords), start, end, chords);
        }
      }));
      notify(`🎹 ${chords.length} accords en MIDI (${chords.slice(0, 4).map(c => chordSymbol(c.root, c.quality)).join(' · ')}${chords.length > 4 ? '…' : ''})${fillLane ? ', et dans la piste d’accords' : ''}.`);
    }
    onClose();
  };

  if (!open) return null;
  const T = TITLES[mode];
  const acc = mode === 'melody' && notes.length ? melodyAccuracy(notes) : null;
  const canCreate = status === 'ready' && ((mode === 'melody' && notes.length > 0) || (mode === 'drums' && !!drums?.hits.length) || (mode === 'harmony' && chords.length > 0));
  const voiceChoices = tracks.filter(t => t.type === TrackType.AUDIO && t.id !== 'master').flatMap(t => t.clips.filter(c => bufferOf(c)).map(c => ({ t, c })));

  return (
    <div className="fixed inset-0 z-[620] flex items-end sm:items-center justify-center bg-black/60" onClick={onClose} role="dialog" aria-label={T.title} data-testid="audio-to-midi">
      <div className="w-full sm:max-w-[640px] max-h-[92dvh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-white/10 shadow-2xl p-4 sm:p-5 text-white"
        style={{ backgroundColor: 'var(--bg-surface, #12141a)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/15 text-cyan-300 flex items-center justify-center shrink-0"><i className={`fas ${T.icon}`} /></div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-black">{T.title}</h2>
            <p className="text-[11px] text-slate-400" title={T.tip}>{T.tip}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" className="w-9 h-9 rounded-lg hover:bg-white/10 text-slate-400 shrink-0"><i className="fas fa-times" /></button>
        </div>

        {/* Source */}
        {mode === 'melody' && (
          <div className="mb-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Source">
            <button type="button" role="radio" aria-checked={source !== 'mic'} disabled={!voiceChoices.length}
              onClick={() => { const v = (source !== 'mic' && source) || lastVoiceClip(tracks); if (v) setSource(v); }}
              className={`min-h-11 px-3 rounded-xl border text-[12px] font-bold text-left disabled:opacity-40 ${source !== 'mic' ? 'bg-cyan-500/15 border-cyan-400/50 text-cyan-100' : 'bg-white/5 border-white/10 text-slate-300'}`}>
              <i className="fas fa-wave-square mr-1.5" />{sourceClip ? `Clip « ${sourceClip.name} »` : 'Une prise du projet'}
            </button>
            <button type="button" role="radio" aria-checked={source === 'mic'} data-testid="hum-mic" onClick={() => { setSource('mic'); setStatus('idle'); setMelody(null); }}
              className={`min-h-11 px-3 rounded-xl border text-[12px] font-bold text-left ${source === 'mic' ? 'bg-cyan-500/15 border-cyan-400/50 text-cyan-100' : 'bg-white/5 border-white/10 text-slate-300'}`}>
              <i className="fas fa-microphone mr-1.5" />Chantonner au micro
            </button>
            {source !== 'mic' && voiceChoices.length > 1 && !simple && (
              <select aria-label="Clip à convertir" value={source ? `${source.trackId}/${source.clipId}` : ''}
                onChange={e => { const [a, b] = e.target.value.split('/'); setSource({ trackId: a, clipId: b }); }}
                className="col-span-2 h-9 rounded-lg bg-white/5 border border-white/10 text-[12px] px-2">
                {voiceChoices.map(({ t, c }) => <option key={c.id} value={`${t.id}/${c.id}`} className="bg-[#12141a]">{t.name} · {c.name}</option>)}
              </select>
            )}
          </div>
        )}
        {mode !== 'melody' && sourceClip && <p className="mb-3 text-[11px] text-slate-400"><i className="fas fa-wave-square mr-1" />Clip « {sourceClip.name} » ({sourceTrack?.name})</p>}

        {/* Micro */}
        {source === 'mic' && (status === 'idle' || status === 'countin' || status === 'recording') && (
          <div className="mb-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-center">
            {status === 'idle' && <>
              <p className="text-[12px] text-slate-300 mb-3">Une mesure de décompte au clic ({Math.round(bpm)} BPM), puis chante ou fredonne ta mélodie. Elle se place à la tête de lecture.</p>
              <button type="button" onClick={startMic} data-testid="hum-record" className="h-12 px-6 rounded-full bg-rose-500 text-white font-black text-[14px]"><i className="fas fa-circle mr-2" />Chanter</button>
            </>}
            {status === 'countin' && <p className="text-[14px] font-black text-amber-300" aria-live="polite">Décompte… prépare-toi</p>}
            {status === 'recording' && <>
              <p className="text-[14px] font-black text-rose-300 mb-3" aria-live="polite"><i className="fas fa-circle animate-pulse mr-2" />Je t’écoute…</p>
              <button type="button" onClick={stopMic} data-testid="hum-stop" className="h-12 px-6 rounded-full bg-white text-black font-black text-[14px]"><i className="fas fa-stop mr-2" />Terminé</button>
            </>}
          </div>
        )}

        {status === 'analyzing' && <p className="my-6 text-center text-[13px] text-slate-300" aria-live="polite"><i className="fas fa-circle-notch fa-spin mr-2" />J’écoute{mode === 'melody' ? ' ta mélodie' : mode === 'drums' ? ' la batterie' : ' les accords'}…</p>}
        {status === 'error' && <p className="my-4 rounded-lg border border-rose-400/40 bg-rose-500/10 p-3 text-[12px] text-rose-200">{error}</p>}
        {status === 'empty' && <p className="my-4 rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-[12px] text-amber-200">
          {mode === 'melody' ? 'Je n’entends pas de mélodie claire : chante plus près du micro, des notes tenues (« la la la », « mmm »), sans le beat derrière.'
            : mode === 'drums' ? 'Je ne trouve pas d’attaques de batterie : monte la sensibilité, ou choisis une boucle de batterie seule.'
            : 'Pas d’accords clairs ici (batterie seule ?). Pose-les à la main dans la piste d’accords.'}
        </p>}

        {/* ---- Mélodie ---- */}
        {mode === 'melody' && status === 'ready' && melody && (
          <>
            <div className="mb-3 grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Instrument">
              {HUM_INSTRUMENTS.filter(i => !simple || i.id === '808' || i.id === 'piano').map(i => (
                <button key={i.id} type="button" role="radio" aria-checked={instrument === i.id} data-instrument={i.id} onClick={() => setInstrument(i.id)} title={i.hint}
                  className={`min-h-11 rounded-xl border text-[12px] font-black ${simple ? 'col-span-2' : ''} ${instrument === i.id ? 'bg-cyan-400 text-black border-cyan-300' : 'bg-white/5 border-white/10 text-slate-200 hover:bg-white/10'}`}>
                  {i.emoji} {i.label}
                </button>
              ))}
            </div>
            <MelodyPreview notes={notes} analysis={melody.analysis} timeOffset={melody.timeOffset} beat={beat} bar={bar} color={humInstrument(instrument).color} />
            <p className="mt-1.5 mb-3 text-[11px] text-slate-400" data-testid="hum-summary">
              {notes.length} notes · de {noteNameFr(Math.min(...notes.map(n => n.pitch)))} à {noteNameFr(Math.max(...notes.map(n => n.pitch)))}
              {acc ? ` · ${Math.round(acc.within * 100)} % des notes à moins d’un demi-ton de ce que tu as chanté` : ''}
            </p>
            {(!simple || showSettings) && (
              <div className="mb-3 space-y-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <Slider label={hasKey ? `Caler sur la gamme (${keyLabelFr(projectKey, projectScale)})` : 'Caler sur la gamme (pas de tonalité dans le projet)'} value={scaleAmt} onChange={setScaleAmt} disabled={!hasKey}
                  hint="0 % : la note la plus proche de ce que tu chantes ; 100 % : toujours une note de la gamme (comme le Scale de Live ou la gamme du Flex Pitch de Logic)." testId="hum-scale" />
                <div className="flex items-end gap-2">
                  <div className="flex-1"><Slider label="Caler sur la grille" value={gridAmt} onChange={setGridAmt} hint="0 % : ton timing exact ; 100 % : pile sur la grille (quantification, comme le Quantize de Logic et Live)." testId="hum-grid" /></div>
                  <div className="flex gap-1 pb-0.5" role="radiogroup" aria-label="Pas de grille">
                    {GRID_CHOICES.map(g => (
                      <button key={g.v} type="button" role="radio" aria-checked={gridBeats === g.v} onClick={() => setGridBeats(g.v)}
                        className={`h-8 px-2 rounded-md text-[11px] font-bold border ${gridBeats === g.v ? 'bg-white text-black border-white' : 'bg-white/5 border-white/10 text-slate-300'}`}>{g.label}</button>
                    ))}
                  </div>
                </div>
                <Toggle label="Garder les nuances (vélocités)" checked={keepVel} onChange={setKeepVel} hint="Les notes chantées plus fort jouent plus fort ; sinon toutes à la même force." />
              </div>
            )}
            {simple && !showSettings && <button type="button" onClick={() => setShowSettings(true)} className="mb-3 text-[11px] text-cyan-300 underline">Réglages (gamme, grille, nuances)</button>}
          </>
        )}

        {/* ---- Batterie ---- */}
        {mode === 'drums' && status === 'ready' && drums && steps && (
          <>
            <DrumPreview steps={steps} bars={drumBars} />
            <p className="mt-1.5 mb-3 text-[11px] text-slate-400" data-testid="drum-summary">
              {drums.hits.length} coups · {(['kick', 'snare', 'hat'] as DrumKind[]).map(k => `${drums.hits.filter(h => h.kind === k || h.also?.includes(k)).length} ${DRUM_KIND_LABEL[k].toLowerCase()}`).join(' · ')} · motif de {drumBars} mesure{drumBars > 1 ? 's' : ''}
              {drums.duration > bar * 4 + 0.05 ? ' (les 4 premières mesures de la boucle)' : ''}
            </p>
            <div className="mb-3 space-y-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Destination">
                <button type="button" role="radio" aria-checked={drumDest === 'machine'} onClick={() => setDrumDest('machine')} title="Le motif remplace celui de la boîte à rythmes NOVA (kick, snare, hi-hat fermé), avec ses sons."
                  className={`min-h-11 rounded-xl border text-[12px] font-bold ${drumDest === 'machine' ? 'bg-orange-400 text-black border-orange-300' : 'bg-white/5 border-white/10 text-slate-200'}`}>🥁 Boîte à rythmes</button>
                <button type="button" role="radio" aria-checked={drumDest === 'gm'} onClick={() => setDrumDest('gm')} title="Une piste MIDI aux notes General MIDI (36 kick, 38 snare, 42 hi-hat) : pour un instrument de batterie VST."
                  className={`min-h-11 rounded-xl border text-[12px] font-bold ${drumDest === 'gm' ? 'bg-orange-400 text-black border-orange-300' : 'bg-white/5 border-white/10 text-slate-200'}`}>🎛️ Piste MIDI (GM)</button>
              </div>
              <Slider label="Sensibilité" value={sens} onChange={setSens} hint="Plus haut : plus d’attaques retenues (ghost notes, hats discrets)." testId="drum-sens" />
              <Toggle label="Couper la boucle d’origine" checked={muteLoop} onChange={setMuteLoop} hint="Le clip audio est muté (pas supprimé) pour n’entendre que le nouveau motif." />
            </div>
          </>
        )}

        {/* ---- Harmonie ---- */}
        {mode === 'harmony' && status === 'ready' && chords.length > 0 && (
          <>
            <div className="mb-2 flex flex-wrap gap-1.5" data-testid="harmony-chords">
              {chords.map(c => (
                <span key={c.id} title={`${chordNameFr(c.root, c.quality)} · ${(c.start).toFixed(2)} s`} className="px-2 py-1 rounded-md text-[12px] font-black border"
                  style={{ borderColor: chordColor(c.root), backgroundColor: `color-mix(in srgb, ${chordColor(c.root)} 22%, transparent)` }}>
                  {chordSymbol(c.root, c.quality)}<span className="ml-1 text-[9px] font-semibold opacity-60">{Math.round((c.end - c.start) / beat)}t</span>
                </span>
              ))}
            </div>
            <div className="mb-3 space-y-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Son des accords">
                {([['keys', '🎹 Keys R&B'], ['piano', '🎹 Piano'], ['pad', '🌫️ Nappe']] as const).map(([id, label]) => (
                  <button key={id} type="button" role="radio" aria-checked={harmInst === id} onClick={() => setHarmInst(id)}
                    className={`min-h-11 rounded-xl border text-[12px] font-bold ${harmInst === id ? 'bg-cyan-400 text-black border-cyan-300' : 'bg-white/5 border-white/10 text-slate-200'}`}>{label}</button>
                ))}
              </div>
              <Toggle label="Ajouter la basse (fondamentale)" checked={harmBass} onChange={setHarmBass} />
              <Toggle label="Remplir aussi la piste d’accords" checked={fillLane} onChange={setFillLane} hint="Les accords apparaissent dans le couloir d’accords et guident le piano roll." />
            </div>
          </>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button type="button" onClick={() => listen(false)} disabled={!canCreate} data-testid="a2m-listen"
            className="h-11 px-4 rounded-xl border border-white/15 bg-white/5 text-[13px] font-bold disabled:opacity-40 hover:bg-white/10">
            <i className={`fas ${preview.playing ? 'fa-stop' : 'fa-play'} mr-1.5`} />{preview.playing ? 'Stop' : 'Écouter'}
          </button>
          {mode === 'melody' && melody?.audio && !simple && (
            <button type="button" onClick={() => listen(true)} disabled={!canCreate || preview.playing}
              className="h-11 px-4 rounded-xl border border-white/15 bg-white/5 text-[13px] font-bold disabled:opacity-40 hover:bg-white/10" title="Écouter les notes avec ta voix par-dessus, pour comparer">
              <i className="fas fa-headphones mr-1.5" />Avec ma voix
            </button>
          )}
          <button type="button" onClick={create} disabled={!canCreate} data-testid="a2m-create"
            className="ml-auto h-11 px-5 rounded-xl bg-cyan-400 text-black text-[13px] font-black disabled:opacity-40">
            <i className="fas fa-check mr-1.5" />
            {mode === 'melody' ? `Créer la piste ${humInstrument(instrument).label}` : mode === 'drums' ? (drumDest === 'machine' ? 'Poser dans la boîte à rythmes' : 'Créer la piste MIDI') : 'Créer les accords MIDI'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AudioToMidiDialog;

// ---------------------------------------------------------------------------
// Petits éléments
// ---------------------------------------------------------------------------

const Slider: React.FC<{ label: string; value: number; onChange: (v: number) => void; hint?: string; disabled?: boolean; testId?: string }> = ({ label, value, onChange, hint, disabled, testId }) => (
  <label className={`block ${disabled ? 'opacity-50' : ''}`} title={hint}>
    <span className="flex justify-between text-[11px] font-bold text-slate-200"><span>{label}</span><span className="font-mono text-cyan-300">{value} %</span></span>
    <input type="range" min={0} max={100} step={5} value={value} disabled={disabled} data-testid={testId} onChange={e => onChange(+e.target.value)} className="w-full accent-cyan-400 h-6" />
  </label>
);

const Toggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }> = ({ label, checked, onChange, hint }) => (
  <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} title={hint} className="w-full flex items-center gap-3 text-left min-h-9">
    <span className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${checked ? 'bg-cyan-500' : 'bg-white/15'}`}>
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
    </span>
    <span className="text-[12px] font-semibold text-slate-200">{label}</span>
  </button>
);

/** Aperçu des notes (et de la hauteur chantée, en pointillé gris). */
const MelodyPreview: React.FC<{ notes: MelodyNote[]; analysis: AnalysisResult; timeOffset: number; beat: number; bar: number; color: string }> = ({ notes, analysis, timeOffset, beat, bar, color }) => {
  if (!notes.length) return null;
  const t0 = Math.floor(notes[0].start / bar) * bar;
  const t1 = Math.max(...notes.map(n => n.start + n.duration)) + beat / 2;
  const shift = Math.round((notes[0].pitch - notes[0].sung) / 12) * 12; // octave de l'instrument
  const lo = Math.min(...notes.map(n => n.pitch)) - 2, hi = Math.max(...notes.map(n => n.pitch)) + 2;
  const W = 600, H = 150;
  const x = (t: number) => ((t - t0) / Math.max(1e-6, t1 - t0)) * W;
  const y = (p: number) => H - ((p - lo) / Math.max(1, hi - lo)) * H;
  const tr = analysis.track;
  const hopSec = tr.hop / tr.sr;
  let path = '';
  let pen = false;
  for (let i = 0; i < tr.midi.length; i += 2) {
    const m = tr.midi[i];
    const t = timeOffset + i * hopSec;
    if (Number.isNaN(m) || t < t0 || t > t1) { pen = false; continue; }
    path += `${pen ? 'L' : 'M'}${x(t).toFixed(1)},${y(m + shift).toFixed(1)}`;
    pen = true;
  }
  const lines: React.ReactNode[] = [];
  for (let b = t0; b <= t1 + 1e-6; b += beat) {
    const isBar = Math.abs((b - t0) / bar - Math.round((b - t0) / bar)) < 1e-6;
    lines.push(<line key={b} x1={x(b)} x2={x(b)} y1={0} y2={H} stroke="currentColor" strokeOpacity={isBar ? 0.18 : 0.06} />);
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[150px] rounded-xl bg-black/30 border border-white/10 text-white" preserveAspectRatio="none" data-testid="hum-preview" role="img"
      aria-label={`Aperçu : ${notes.length} notes`}>
      {lines}
      {notes.map((n, i) => (
        <rect key={i} x={x(n.start)} y={y(n.pitch) - 4} width={Math.max(2, x(n.start + n.duration) - x(n.start) - 1)} height={8} rx={2}
          fill={color} fillOpacity={0.35 + 0.6 * n.velocity} data-pitch={n.pitch}><title>{noteNameFr(n.pitch)}</title></rect>
      ))}
      <path d={path} fill="none" stroke="#e2e8f0" strokeOpacity={0.55} strokeWidth={1.2} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

/** Aperçu du motif : 3 rangées × pas de 16e. */
const DrumPreview: React.FC<{ steps: Record<DrumKind, number[]>; bars: number }> = ({ steps, bars }) => {
  const n = 16 * bars;
  return (
    <div className="rounded-xl bg-black/30 border border-white/10 p-2 space-y-1" data-testid="drum-preview">
      {(['kick', 'snare', 'hat'] as DrumKind[]).map(k => (
        <div key={k} className="flex items-center gap-1">
          <span className="w-16 shrink-0 text-[10px] font-bold text-slate-300">{DRUM_KIND_LABEL[k]}</span>
          <div className="flex-1 grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
            {steps[k].slice(0, n).map((v, i) => (
              <span key={i} data-step={i} data-on={v > 0 ? '1' : undefined} className={`h-4 rounded-[2px] ${i % 4 === 0 ? 'outline outline-1 outline-white/10' : ''}`}
                style={{ backgroundColor: v > 0 ? `rgba(251,146,60,${0.35 + 0.65 * v / 127})` : 'rgba(255,255,255,0.05)' }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

/**
 * Boutons directs « Fredonne → 808 / piano » (panneau voix, téléphone) :
 * ta dernière prise (ou le micro s'il n'y en a pas) devient une 808 ou un piano.
 */
export const HumQuickButtons: React.FC<{ onOpen?: () => void; compact?: boolean }> = ({ onOpen, compact }) => {
  const open = (instrument: HumInstrument) => {
    onOpen?.();
    openNovaWindow('audio-to-midi', { convert: { mode: 'melody', instrument, simple: true } });
  };
  return (
    <div className={compact ? 'flex gap-2' : 'grid grid-cols-2 gap-2'} data-testid="hum-quick">
      {(['808', 'piano'] as HumInstrument[]).map(id => {
        const i = humInstrument(id);
        return (
          <button key={id} type="button" onClick={() => open(id)} data-hum={id}
            title={`Fredonne ta mélodie (ou prends ta dernière prise) : elle devient ${id === '808' ? 'une ligne de 808' : 'un piano'} (comme Convert Melody to MIDI d’Ableton Live ou « Create MIDI » du Flex Pitch de Logic).`}
            className="min-h-11 px-3 rounded-xl border border-fuchsia-400/40 bg-fuchsia-500/10 text-fuchsia-100 text-[12px] font-black hover:bg-fuchsia-500/20 flex-1">
            {i.emoji} Fredonne → {i.label}
          </button>
        );
      })}
    </div>
  );
};
