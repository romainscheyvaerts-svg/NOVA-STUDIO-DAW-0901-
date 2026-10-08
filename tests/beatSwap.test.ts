import { describe, expect, it } from 'vitest';
import {
  analyzeBeatGrid, applySwap, attackNear, audioClipsToRender, doneText, effectiveTempo, hasVoicesToKeep, keyName, mapChords, planSummary, planSwap,
  relativeMinorRoot, semitoneChoices, swapTime, BeatInfo,
} from '../utils/beatSwap';
import { estimateTempo, renderElastic, renderPlan, splitAtOnsets, editingElastic, withDuration, withSemitones, monoMix } from '../utils/clipTranspose';
import { analyzePitch } from '../utils/pitchAnalysis';
import { TrackType } from '../types';
import type { Clip, DAWState } from '../types';
import { makeClip, makeTrack } from './helpers/fixtures';
import { synthBeat } from './helpers/synthBeat';
import { synthVoice } from './helpers/synthVoice';

const G_MIN = { root: 7, scale: 'MINOR' };
const A_MIN = { root: 9, scale: 'MINOR' };

describe('tonalités : l’intervalle le plus court', () => {
  it('Sol mineur → La mineur : +2 (pas −10)', () => {
    expect(semitoneChoices(G_MIN, A_MIN)).toEqual({ best: 2, other: -10 });
    expect(semitoneChoices(A_MIN, G_MIN)).toEqual({ best: -2, other: 10 });
  });
  it('relatif majeur / mineur : pas de transposition', () => {
    expect(semitoneChoices({ root: 0, scale: 'MAJOR' }, A_MIN)).toEqual({ best: 0, other: null });
    expect(relativeMinorRoot({ root: 10, scale: 'MAJOR' })).toBe(7);
    // Ré mineur → Si♭ majeur (= Sol mineur) : +5.
    expect(semitoneChoices({ root: 2, scale: 'MINOR' }, { root: 10, scale: 'MAJOR' }).best).toBe(5);
  });
  it('triton : vers le bas ; tonalité inconnue : rien', () => {
    expect(semitoneChoices(G_MIN, { root: 1, scale: 'MINOR' })).toEqual({ best: -6, other: 6 });
    expect(semitoneChoices(null, A_MIN)).toEqual({ best: 0, other: null });
    expect(keyName(A_MIN)).toBe('La mineur');
    expect(keyName(null)).toBe('tonalité inconnue');
  });
});

describe('tempo et plan', () => {
  it('demi-tempo / double tempo seulement quand il évite un gros étirement', () => {
    expect(effectiveTempo(94, 100)).toEqual({ bpm: 100, folded: null });
    expect(effectiveTempo(94, 188)).toEqual({ bpm: 94, folded: 'half' });
    expect(effectiveTempo(140, 72)).toEqual({ bpm: 144, folded: 'double' });
    expect(effectiveTempo(94, 120).folded).toBeNull();
  });
  const A: BeatInfo = { bpm: 94, key: G_MIN, downbeat: 0.35 };
  const B: BeatInfo = { bpm: 100, key: A_MIN, downbeat: 0.12 };
  it('94 → 100 BPM, Sol → La mineur : voix 6 % plus courtes, +2, pas d’alerte', () => {
    const p = planSwap(A, B);
    expect(p.factor).toBeCloseTo(0.94, 6);
    expect(p.semitones).toBe(2);
    expect(p.altSemitones).toBe(-10);
    expect(p.warnings).toEqual([]);
    // Même position musicale : le 3e temps de l'ancien beat tombe sur le 3e du nouveau.
    expect(swapTime(p, 0.35 + 2 * 60 / 94)).toBeCloseTo(0.12 + 2 * 60 / 100, 9);
    expect(planSummary(p)).toContain('Sol mineur → La mineur (+2 demi-tons)');
    expect(doneText(p, 3, 'B')).toContain('3 clips de voix recalés');
  });
  it('alertes au-delà de ±15 % et ±3 demi-tons', () => {
    const p = planSwap(A, { bpm: 120, key: { root: 2, scale: 'MINOR' }, downbeat: 0 });
    expect(p.warnings.join(' ')).toMatch(/\+28 %.*trafiquée/);
    expect(p.semitones).toBe(-5);
    expect(p.warnings.join(' ')).toMatch(/demi-tons.*trafiquée/);
  });
  it('réglages : l’autre sens, sans transposition, sans recalage, calage fin', () => {
    expect(planSwap(A, B, { semitones: -10 }).semitones).toBe(-10);
    expect(planSwap(A, B, { semitones: -10 }).altSemitones).toBe(2);
    expect(planSwap(A, B, { transpose: false }).semitones).toBe(0);
    const n = planSwap(A, B, { retime: false });
    expect(n.factor).toBe(1);
    expect(planSwap(A, B, { offsetMs: 20 }).dbNew).toBeCloseTo(0.14, 9);
    expect(planSwap(A, B, { beatShift: 1 }).dbNew).toBeCloseTo(0.72, 9);
    expect(planSwap(A, { ...B, key: null }).warnings.join(' ')).toMatch(/inconnue/);
  });
});

describe('le projet après le changement de beat (une seule opération)', () => {
  const base = (): DAWState => {
    const beat = makeTrack({ id: 'instrumental', name: 'BEAT', clips: [makeClip({ id: 'old-beat', bufferId: 'b-old', duration: 60 })] }) as any;
    beat.instrumentId = 12;
    const voice = makeTrack({ id: 'voix', name: 'Voix lead', clips: [
      makeClip({ id: 'v1', bufferId: 'v1b', start: 0.35 + 4 * 60 / 94, duration: 5 }),
      makeClip({ id: 'pickup', bufferId: 'pb', start: 0.2, duration: 1 }),
    ], plugins: [{ id: 'at', type: 'AUTOTUNE', name: 'Auto-Tune', isEnabled: true, params: { rootKey: 7, scale: 'MINOR' } } as any] });
    const synth = makeTrack({ id: 'synth', type: TrackType.MIDI, clips: [makeClip({ id: 'm1', type: TrackType.MIDI, start: 0.35, duration: 4 * 60 / 94, notes: [{ id: 'n', pitch: 60, start: 60 / 94, duration: 60 / 94, velocity: 100 }] })] });
    const drums = makeTrack({ id: 'drums', type: TrackType.DRUM_RACK, clips: [makeClip({ id: 'd1', type: TrackType.MIDI, start: 0.35, duration: 2, notes: [{ id: 'k', pitch: 36, start: 0, duration: 0.1, velocity: 100 }] })] });
    const bus = makeTrack({ id: 'bus', type: TrackType.BUS, clips: [] });
    return {
      id: 'p', name: 'P', bpm: 94, tracks: [beat, voice, synth, drums, bus], markers: [{ id: 'm', name: 'Couplet', time: 0.35 + 8 * 60 / 94, type: 'REGION', endTime: 0.35 + 16 * 60 / 94, color: '#fff' }],
      chords: [{ id: 'c', start: 0.35, end: 0.35 + 4 * 60 / 94, root: 7, quality: 'min' }],
      loopStart: 0.35, loopEnd: 0.35 + 16 * 60 / 94, isLoopActive: false,
      punch: { enabled: true, punchIn: 0.35 + 60 / 94, punchOut: 0.35 + 2 * 60 / 94, preRoll: 0, postRoll: 0 },
      projectKey: 7, projectScale: 'MINOR', tempoEvents: [{ id: 't', bar: 4, bpm: 96 }, { id: 'm', bar: 8, numerator: 3, denominator: 4 }],
    } as unknown as DAWState;
  };
  const plan = planSwap({ bpm: 94, key: G_MIN, downbeat: 0.35 }, { bpm: 100, key: A_MIN, downbeat: 0.12 });

  it('voix, MIDI, repères, accords, boucle, tempo et tonalité suivent', () => {
    const s0 = base();
    expect(hasVoicesToKeep(s0.tracks)).toBe(true);
    expect(audioClipsToRender(s0.tracks).map(r => r.clip.id)).toEqual(['v1', 'pickup']);
    const beatClip = makeClip({ id: 'new-beat', bufferId: 'b-new', duration: 50 });
    const s = applySwap(s0, {
      plan, beatClip, beat: { title: 'Beat B' },
      renders: [{ trackId: 'voix', clipId: 'v1', patch: { bufferId: 'v1-rendu', duration: 4.7, offset: 0.5, elastic: { version: 1 } as any } }],
      usesProjectKey: t => t === 'AUTOTUNE',
    });
    const beat = s.tracks.find(t => t.id === 'instrumental')!;
    expect(beat.clips.map(c => c.id)).toEqual(['new-beat']);
    expect((beat as any).instrumentId).toBeUndefined();
    const v = s.tracks.find(t => t.id === 'voix')!;
    const v1 = v.clips.find(c => c.id === 'v1')!;
    expect(v1.start).toBeCloseTo(0.12 + 4 * 60 / 100, 6);
    expect(v1.bufferId).toBe('v1-rendu');
    expect(v1.duration).toBe(4.7);
    // Anacrouse avant le 1er temps qui partirait avant 0 : début rogné.
    const pk = v.clips.find(c => c.id === 'pickup')!;
    expect(pk.start).toBe(0);
    expect(pk.offset).toBeGreaterThan(0);
    expect(v.plugins[0].params).toMatchObject({ rootKey: 9, scale: 'MINOR' });
    const m1 = s.tracks.find(t => t.id === 'synth')!.clips[0];
    expect(m1.start).toBeCloseTo(0.12, 6);
    expect(m1.notes![0].start).toBeCloseTo(60 / 100, 6);
    expect(m1.notes![0].pitch).toBe(62);
    expect(s.tracks.find(t => t.id === 'drums')!.clips[0].notes![0].pitch).toBe(36);
    expect(s.markers[0].time).toBeCloseTo(0.12 + 8 * 60 / 100, 6);
    expect(s.markers[0].endTime).toBeCloseTo(0.12 + 16 * 60 / 100, 6);
    expect(s.chords![0]).toMatchObject({ root: 9 });
    expect(s.chords![0].end).toBeCloseTo(0.12 + 4 * 60 / 100, 6);
    expect(s.loopEnd).toBeCloseTo(0.12 + 16 * 60 / 100, 6);
    expect(s.punch).toBe(s0.punch);
    expect(s.bpm).toBe(100);
    expect(s.projectKey).toBe(9);
    expect(s.beatTitle).toBe('Beat B');
    expect(s.tempoEvents).toEqual([{ id: 'm', bar: 8, numerator: 3, denominator: 4 }]);
    // L'état d'origine n'est pas touché (annulation = l'état d'avant).
    expect(s0.tracks[1].clips[0].start).toBeCloseTo(0.35 + 4 * 60 / 94, 9);
    expect(s0.bpm).toBe(94);
  });

  it('beat du catalogue : la licence suit le nouveau beat', () => {
    const s = applySwap(base(), { plan, beatClip: makeClip({ id: 'nb' }), beat: { instrumentId: 'abc', title: 'C' }, renders: [] });
    expect((s.tracks.find(t => t.id === 'instrumental') as any).instrumentId).toBe('abc');
    // Sans rendu (son absent) : la durée suit quand même.
    expect(s.tracks.find(t => t.id === 'voix')!.clips[0].duration).toBeCloseTo(5 * 0.94, 6);
  });

  it('accords sans transposition', () => {
    const c = mapChords([{ id: 'x', start: 1, end: 2, root: 11, quality: 'min' }], t => t * 2, 1);
    expect(c![0]).toMatchObject({ start: 2, end: 4, root: 0 });
  });
});

describe('grille du beat : tempo et premier temps', () => {
  for (const [bpm, db, root] of [[94, 0.35, 55], [100, 0.12, 57], [140, 0.8, 50], [87.5, 1.1, 60]] as const) {
    it(`${bpm} BPM, premier temps à ${db} s (levée de charley avant)`, () => {
      const x = synthBeat({ bpm, root, firstDownbeat: db, bars: 12 });
      const est = estimateTempo(x, 44100);
      const g = analyzeBeatGrid(x, 44100, est?.bpm || bpm)!;
      expect(g.bpm).toBeCloseTo(bpm, 2);
      // Attaque lue au moment où le kick monte (biais identique pour les deux beats).
      expect(Math.abs(g.downbeat - db)).toBeLessThan(0.004);
    });
  }
  it('attaque d’un son : à la ms ; silence : null', () => {
    const x = new Float32Array(44100);
    for (let i = 22050; i < 30000; i++) x[i] = 0.5 * Math.sin(i / 3);
    expect(attackNear(x, 44100, 0.5, 0.03)!).toBeCloseTo(0.5, 2);
    expect(attackNear(new Float32Array(44100), 44100, 0.5)).toBeNull();
  });
});

describe('attaques ancrées (R23) : la voix tombe sur la grille', () => {
  it('splitAtOnsets coupe sans changer la fonction du temps', () => {
    const segs = splitAtOnsets([{ s0: 0, s1: 10000, d0: 0, d1: 9400 }], [100, 3000, 3020, 7000, 9990], 200);
    expect(segs.map(s => s.s0)).toEqual([0, 3000, 7000]);
    expect(segs[1]).toEqual({ s0: 3000, s1: 7000, d0: 2820, d1: 6580 });
    expect(segs[segs.length - 1].d1).toBe(9400);
  });
  it('voix étirée à 94 % et transposée de +2 : attaques à leur place, hauteur à ±5 cents', () => {
    const sr = 44100;
    const notes = [0.3, 0.9, 1.5, 2.1].map((at, i) => ({ midi: 55 + [0, 3, 5, 7][i], at, len: 0.45 }));
    const x = synthVoice(sr, 2.8, notes);
    const clip = makeClip({ id: 'v', bufferId: 'v', duration: 2.8 }) as Clip;
    let info = editingElastic(clip, () => true).info;
    info = withSemitones(withDuration(info, info.duration * 0.94), 2);
    const plan = renderPlan(info, sr, x.length);
    const res = renderElastic({ channels: [x], sr, segments: plan.segments, semitones: 2, formants: true, algo: 'voice', attacks: true });
    const y = monoMix(res.channels);
    for (const n of notes) {
      const at = attackNear(y, sr, n.at * 0.94, 0.03)!;
      expect(Math.abs(at - (attackNear(x, sr, n.at, 0.03)! * 0.94))).toBeLessThan(0.005);
    }
    const pa = analyzePitch(x, sr), pb = analyzePitch(y, sr);
    const cents: number[] = [];
    for (let i = 0; i < pa.midi.length; i++) {
      const j = Math.round(i * 0.94);
      if (j < pb.midi.length && !Number.isNaN(pa.midi[i]) && !Number.isNaN(pb.midi[j])) cents.push((pb.midi[j] - pa.midi[i]) * 100);
    }
    cents.sort((a, b) => a - b);
    expect(Math.abs(cents[cents.length >> 1] - 200)).toBeLessThan(5);
  });
});
