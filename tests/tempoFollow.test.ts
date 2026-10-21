import { describe, it, expect } from 'vitest';
import { TrackType, type Clip, type Track, type Marker } from '../types';
import {
  buildTempoMap, barToTime, beatsInRange, timeToPosition, timeToQuarters, quartersToTime, tempoAt, snapTimeToMap,
  gridLinesInRange, positionToTime, rampSteps, hasRamps, tempoSignature, type TempoEvent,
} from '../utils/tempoMap';
import { followTempo, keepAudioFor, hasUnwarpedBeat, followSummary, remapper, mapOf, type FollowState } from '../utils/tempoFollow';
import { sanitizeTempoOp, applyTempoOpFollowing, tempoOpOf } from '../utils/collabTempo';
import { novaToMidi } from '../utils/midiImport';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);
const TS = { numerator: 4, denominator: 4 };

/** Générateur pseudo-aléatoire reproductible. */
function rng(seed: number) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }

const midiTrack = (id: string, clips: Clip[]): Track => ({ id, name: id, type: TrackType.MIDI, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips, plugins: [], automationLanes: [], totalLatency: 0 });
const audioTrack = (id: string, clips: Clip[]): Track => ({ ...midiTrack(id, clips), type: TrackType.AUDIO });
const midiClip = (id: string, start: number, duration: number, notes: { s: number; d: number; p?: number }[]): Clip => ({
  id, start, duration, offset: 0, fadeIn: 0, fadeOut: 0, name: id, color: '#0ff', type: TrackType.MIDI,
  notes: notes.map((n, i) => ({ id: `${id}-n${i}`, pitch: n.p ?? 60, start: n.s, duration: n.d, velocity: 0.8 })),
});
const audioClip = (id: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({ id, start, duration, offset: 0, fadeIn: 0, fadeOut: 0, name: id, color: '#f0f', type: TrackType.AUDIO, bufferId: `b-${id}`, ...extra });

const state = (tracks: Track[], extra: Partial<FollowState> = {}): FollowState => ({ bpm: 90, timeSignature: TS, tempoEvents: [], tracks, markers: [], loopStart: 0, loopEnd: 0, ...extra });

/** Position musicale lisible « mesure|temps|tick » (960 ticks par temps). */
const pos = (m: ReturnType<typeof buildTempoMap>, t: number) => {
  const p = timeToPosition(m, t + 1e-7);
  return `${p.bar}|${p.beat}|${Math.min(959, Math.floor(p.frac * 960 + 1e-4))}`;
};

describe('rampes de tempo (L3)', () => {
  // 90 → 120 BPM sur 4 mesures de 4/4 (16 noires), puis 120 constant.
  const ev: TempoEvent[] = [{ id: 'r', bar: 4, bpm: 120, ramp: true }];
  const m = buildTempoMap(90, TS, ev);
  const theo = (x: number) => (60 * 16 / 30) * Math.log((90 + 30 * x / 16) / 90); // t(x) exact, x en noires

  it('la rampe arrive pile au tempo cible, à l’instant théorique', () => {
    expect(hasRamps(m)).toBe(true);
    close(barToTime(m, 4), theo(16), 1e-9);
    close(tempoAt(m, theo(8)), 105, 1e-6);
    close(tempoAt(m, barToTime(m, 5)), 120, 1e-9);
    // Après la rampe : 120 constant.
    close(barToTime(m, 5) - barToTime(m, 4), 2, 1e-9);
  });
  it('clic : 16 temps dans la rampe, chacun à ±1 ms de la position théorique (en fait < 1 µs)', () => {
    const clicks = beatsInRange(m, 0, barToTime(m, 4) - 1e-6);
    expect(clicks.length).toBe(16);
    clicks.forEach((c, i) => close(c.time, theo(i), 1e-6));
    // Les écarts raccourcissent (accélération).
    for (let i = 2; i < clicks.length; i++) expect(clicks[i].time - clicks[i - 1].time).toBeLessThan(clicks[i - 1].time - clicks[i - 2].time);
  });
  it('intégration numérique indépendante : même durée à 0,1 ms près', () => {
    let t = 0; const N = 200000;
    for (let i = 0; i < N; i++) { const x = (i + 0.5) * 16 / N; t += (60 / (90 + 30 * x / 16)) * 16 / N; }
    close(barToTime(m, 4), t, 1e-4);
  });
  it('noires ↔ secondes : aller-retour exact, dans et hors de la rampe', () => {
    for (const q of [0, 0.25, 3.3, 8, 15.99, 16, 17.5, 40]) close(timeToQuarters(m, quartersToTime(m, q)), q, 1e-9);
    for (const t of [0, 1, 5.5, 9, 9.3, 20]) close(quartersToTime(m, timeToQuarters(m, t)), t, 1e-9);
  });
  it('grille et aimantation suivent la rampe', () => {
    const lines = gridLinesInRange(m, 0, barToTime(m, 1) + 1e-9, '1/4').map(l => l.time);
    expect(lines.length).toBe(5);
    lines.slice(0, 4).forEach((x, i) => close(x, theo(i), 1e-9));
    close(snapTimeToMap(m, theo(5) + 0.01, '1/4'), theo(5), 1e-9);
    close(positionToTime(m, 2, 1), theo(9), 1e-9);
  });
  it('rampe vers le bas (ralentissement) et signature de collaboration', () => {
    const d = buildTempoMap(140, TS, [{ id: 'x', bar: 2, bpm: 70, ramp: true }]);
    expect(barToTime(d, 2)).toBeGreaterThan(8 * 60 / 140);
    expect(barToTime(d, 2)).toBeLessThan(8 * 60 / 70);
    expect(tempoSignature(90, TS, ev)).not.toBe(tempoSignature(90, TS, [{ id: 'r', bar: 4, bpm: 120 }]));
    // Sans rampe : la même signature qu'avant L3 (une ancienne version s'y retrouve).
    expect(tempoSignature(90, TS, [{ id: 'r', bar: 4, bpm: 120 }])).toBe('90|4/4|4:120:/');
  });
  it('export MIDI : la rampe devient des paliers qui gardent les notes à leur place', () => {
    const steps = rampSteps(m.segments[0], 0.25);
    expect(steps.length).toBe(64);
    // Durée totale des paliers = durée exacte de la rampe.
    const dur = steps.reduce((a, s) => a + (60 * 0.25) / s.bpm, 0);
    close(dur, barToTime(m, 4), 1e-9);
    const track = midiTrack('p', []);
    const clip = midiClip('c', 0, barToTime(m, 6), [{ s: theo(8), d: theo(12) - theo(8) }]);
    const d = novaToMidi([{ track, clips: [clip] }], { bpm: 90, tempoMap: m, ppq: 960 });
    expect(d.tracks[0].notes[0].startTick).toBe(8 * 960);
    expect(d.tracks[0].notes[0].durationTicks).toBe(4 * 960);
    expect(d.tempos.length).toBeGreaterThan(60);
    expect(Math.round(d.tempos[d.tempos.length - 1].bpm)).toBe(120);
  });
});

describe('le contenu garde sa mesure quand le tempo change (L3)', () => {
  it('90 → 140 BPM : 100 % des notes et des débuts de clips sur la même mesure | temps | tick', () => {
    const r = rng(7);
    const beat = 60 / 90;
    const clips: Clip[] = [];
    for (let c = 0; c < 8; c++) {
      const start = Math.floor(r() * 32) * beat;
      const notes = Array.from({ length: 20 }, () => ({ s: Math.floor(r() * 64) * beat / 4, d: (1 + Math.floor(r() * 8)) * beat / 4, p: 36 + Math.floor(r() * 48) }));
      clips.push(midiClip(`c${c}`, start, 16 * beat, notes));
    }
    const s0 = state([midiTrack('m', clips)]);
    const before = mapOf(s0);
    const { state: s1, report } = followTempo(s0, { bpm: 140 }, { keepAudio: false });
    const after = mapOf(s1);
    expect(s1.bpm).toBe(140);
    expect(report.notes).toBe(160);
    let checked = 0;
    s0.tracks[0].clips.forEach((c, i) => {
      const c1 = s1.tracks[0].clips[i];
      expect(pos(after, c1.start)).toBe(pos(before, c.start));
      close(c1.duration, c.duration * 90 / 140, 1e-9);
      c.notes!.forEach((n, j) => {
        const n1 = c1.notes![j];
        expect(pos(after, c1.start + n1.start)).toBe(pos(before, c.start + n.start));
        expect(pos(after, c1.start + n1.start + n1.duration)).toBe(pos(before, c.start + n.start + n.duration));
        checked++;
      });
    });
    expect(checked).toBe(160);
  });
  it('avec changements de tempo et une rampe dans le morceau', () => {
    const clips = [midiClip('a', 0, 40, Array.from({ length: 60 }, (_, i) => ({ s: i * 0.5, d: 0.25 })))];
    const s0 = state([midiTrack('m', clips)], { bpm: 120, tempoEvents: [{ id: 'e', bar: 4, bpm: 100 }] });
    const ev: TempoEvent[] = [{ id: 'e', bar: 4, bpm: 100 }, { id: 'f', bar: 8, bpm: 150, ramp: true }];
    const { state: s1 } = followTempo(s0, { tempoEvents: ev }, { keepAudio: false });
    const A = mapOf(s0), B = mapOf(s1);
    s0.tracks[0].clips[0].notes!.forEach((n, j) => {
      const n1 = s1.tracks[0].clips[0].notes![j];
      close(timeToQuarters(B, s1.tracks[0].clips[0].start + n1.start), timeToQuarters(A, n.start), 1e-6);
    });
    // Avant la mesure 4 rien ne change (la carte y est identique).
    close(s1.tracks[0].clips[0].notes![3].start, 1.5, 1e-9);
  });
  it('clips audio : calés et non calés suivent, sauf option ; clips verrouillés jamais', () => {
    const tr = audioTrack('a', [
      audioClip('libre', 4, 2),
      audioClip('cale', 8, 2, { warp: { enabled: true, mode: 'BEATS', preservePitch: true, originalBpm: 90 } }),
      audioClip('verrou', 12, 2, { lock: 'time' }),
    ]);
    const s0 = state([tr], { bpm: 120 });
    const a = followTempo(s0, { bpm: 60 }, { keepAudio: false });
    expect(a.state.tracks[0].clips.map(c => c.start)).toEqual([8, 16, 12]);
    // Le son n'est pas étiré ici (le calage s'en charge pour le clip calé).
    expect(a.state.tracks[0].clips.map(c => c.duration)).toEqual([2, 2, 2]);
    const k = followTempo(s0, { bpm: 60 }, { keepAudio: true });
    expect(k.state.tracks[0].clips.map(c => c.start)).toEqual([4, 16, 12]);
    expect(k.report.audioKept).toBe(1);
    expect(k.report.locked).toBe(1);
    expect(followSummary(k.report)).toMatch(/gardé à sa place/);
  });
  it('« garder l’audio » automatique : oui avec un beat importé non calé, réglable par projet', () => {
    const beat = { ...audioTrack('instrumental', [audioClip('beat', 0, 120)]), name: 'BEAT' };
    expect(hasUnwarpedBeat([beat])).toBe(true);
    expect(keepAudioFor({ tracks: [beat] })).toBe(true);
    expect(keepAudioFor({ tracks: [beat], tempoAudioMode: 'follow' })).toBe(false);
    expect(keepAudioFor({ tracks: [audioTrack('v', [audioClip('x', 0, 1)])] })).toBe(false);
    expect(keepAudioFor({ tracks: [audioTrack('v', [])], tempoAudioMode: 'keep' })).toBe(true);
    const calé = { ...beat, clips: [audioClip('beat', 0, 120, { warp: { enabled: true, mode: 'BEATS', preservePitch: true, originalBpm: 90 } })] };
    expect(hasUnwarpedBeat([calé])).toBe(false);
  });
  it('automation, repères, accords et boucle suivent', () => {
    const t = midiTrack('m', []);
    t.automationLanes = [{ id: 'l', parameterName: 'volume', points: [{ id: 'p', time: 4, value: 0.5 }, { id: 'q', time: 8, value: 1 }], color: '#fff', isExpanded: false, min: 0, max: 1 } as any];
    const markers: Marker[] = [{ id: 'mk', name: 'Refrain', time: 8, type: 'MARKER' as any, color: '#fff' }, { id: 'rg', name: 'R', time: 2, endTime: 6, type: 'REGION' as any, color: '#fff' }];
    const s0 = state([t], { bpm: 120, markers, loopStart: 2, loopEnd: 10, chords: [{ id: 'c', start: 4, end: 6, root: 0, quality: 'maj' as any }] });
    const { state: s1 } = followTempo(s0, { bpm: 60 }, { keepAudio: false });
    expect(s1.tracks[0].automationLanes[0].points.map(p => p.time)).toEqual([8, 16]);
    expect(s1.markers.map(m => [m.time, m.endTime])).toEqual([[16, undefined], [4, 12]]);
    expect([s1.loopStart, s1.loopEnd]).toEqual([4, 20]);
    expect(s1.chords!.map(c => [c.start, c.end])).toEqual([[8, 12]]);
  });
  it('aller-retour 140 → 150 → 140 : retour exact ; glisser le tempo (100 pas) ne dérive pas', () => {
    const s0 = state([midiTrack('m', [midiClip('a', 1.2345, 8, [{ s: 0.3, d: 0.21 }, { s: 5.5, d: 1 }])])], { bpm: 140 });
    let s = s0;
    for (let b = 141; b <= 240; b++) s = followTempo(s, { bpm: b }, { keepAudio: false }).state;
    s = followTempo(s, { bpm: 140 }, { keepAudio: false }).state;
    const c0 = s0.tracks[0].clips[0], c1 = s.tracks[0].clips[0];
    close(c1.start, c0.start, 1e-7);
    c0.notes!.forEach((n, i) => { close(c1.notes![i].start, n.start, 1e-7); close(c1.notes![i].duration, n.duration, 1e-7); });
  });
  it('même carte : rien ne bouge (mêmes objets), un ancien projet reste tel quel', () => {
    const s0 = state([midiTrack('m', [midiClip('a', 1, 2, [{ s: 0, d: 1 }])])]);
    const r = followTempo(s0, { bpm: 90 }, { keepAudio: false });
    expect(r.state.tracks).toBe(s0.tracks);
    expect(r.report.unchanged).toBe(true);
    // Mesure 3/4 au lieu de 4/4 au début : la noire ne change pas, les secondes non plus.
    const r2 = followTempo(s0, { timeSignature: { numerator: 3, denominator: 4 } }, { keepAudio: false });
    expect(r2.state.tracks[0].clips[0].start).toBe(1);
  });
  it('remapper : homothétie pour un tempo constant', () => {
    const R = remapper(buildTempoMap(100, TS, []), buildTempoMap(200, TS, []));
    close(R(10), 5);
    close(R(0), 0);
  });
});

describe('collaboration : le même déplacement chez tous (fuzz 300 séances)', () => {
  it('opération « tempo » avec follow : nettoyée, appliquée une seule fois, convergence', () => {
    const r = rng(42);
    for (let run = 0; run < 300; run++) {
      const tracks: Track[] = [];
      const nT = 1 + Math.floor(r() * 3);
      for (let i = 0; i < nT; i++) {
        const nc = 1 + Math.floor(r() * 3);
        const clips = Array.from({ length: nc }, (_, k) => r() < 0.6
          ? midiClip(`t${i}c${k}`, r() * 30, 1 + r() * 8, Array.from({ length: 1 + Math.floor(r() * 6) }, () => ({ s: r() * 4, d: 0.05 + r() })))
          : audioClip(`t${i}c${k}`, r() * 30, 1 + r() * 4, r() < 0.3 ? { warp: { enabled: true, mode: 'BEATS', preservePitch: true, originalBpm: 100 } } : {}));
        tracks.push(i === 0 && r() < 0.3 ? { ...audioTrack('instrumental', [audioClip('beat', 0, 60)]) } : midiTrack(`t${i}`, clips));
      }
      const base = state(tracks, { bpm: 60 + Math.floor(r() * 120), tempoEvents: r() < 0.4 ? [{ id: 'e', bar: 2 + Math.floor(r() * 4), bpm: 70 + Math.floor(r() * 90), ramp: r() < 0.5 }] : [] });
      const nextBpm = 60 + Math.floor(r() * 120);
      const keepAudio = keepAudioFor(base);
      // Chez l'auteur.
      const id = `tf${run}`;
      const a = followTempo(base, { bpm: nextBpm }, { keepAudio, epoch: id }).state;
      // Sur le fil, puis chez l'autre (opération nettoyée).
      const wire = JSON.parse(JSON.stringify({ ...tempoOpOf(a), follow: { id, keepAudio } }));
      const op = sanitizeTempoOp(wire)!;
      expect(op.follow).toEqual({ id, keepAudio });
      // Cas 1 : l'opération tempo arrive d'abord, puis le contenu de l'auteur (mêmes valeurs).
      const b1 = applyTempoOpFollowing(base, op).state;
      expect(JSON.stringify(b1.tracks)).toBe(JSON.stringify(a.tracks));
      // Cas 2 : le contenu d'une piste arrive AVANT l'opération tempo : ses clips ne bougent pas deux fois.
      const early = { ...base, tracks: base.tracks.map((t, i) => (i === 0 ? a.tracks[0] : t)) };
      const b2 = applyTempoOpFollowing(early, op).state;
      expect(JSON.stringify(b2.tracks)).toBe(JSON.stringify(a.tracks));
      // Rejouée (déjà au bon tempo) : rien ne bouge.
      expect(applyTempoOpFollowing(a, op).state).toBe(a);
    }
  });
  it('ancienne opération sans follow : le tempo seul, comme avant', () => {
    const s0 = state([midiTrack('m', [midiClip('a', 2, 2, [{ s: 0, d: 1 }])])]);
    const op = sanitizeTempoOp({ bpm: 120, timeSignature: TS, tempoEvents: [{ id: 'x', bar: 2, bpm: 100, ramp: true }] })!;
    expect(op.tempoEvents[0].ramp).toBe(true);
    const r = applyTempoOpFollowing(s0, op);
    expect(r.state.bpm).toBe(120);
    expect(r.state.tracks).toBe(s0.tracks);
  });
});
