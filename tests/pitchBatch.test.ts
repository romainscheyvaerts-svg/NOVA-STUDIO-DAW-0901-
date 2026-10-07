import { beforeEach, describe, expect, it, vi } from 'vitest';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { analyzePitch, segmentNotes } from '../utils/pitchAnalysis';
import { correctClipsBatch, pitchBatchReason } from '../utils/pitchBatch';
import { FakeAudioBuffer, FakeAudioContext } from './helpers/audio';
import { makeClip } from './helpers/fixtures';
import { synthVoice } from './helpers/synthVoice';
import type { Clip } from '../types';

vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));

const SR = 44100;
const reg = (id: string, x: Float32Array) => {
  const b = new FakeAudioBuffer({ numberOfChannels: 1, length: x.length, sampleRate: SR });
  b.getChannelData(0).set(x);
  audioBufferRegistry.register(b as unknown as AudioBuffer, id);
};
/** Hauteurs des notes chantées dans un son (centres, MIDI). */
const centers = (id: string) => {
  const b = audioBufferRegistry.get(id)!;
  return segmentNotes(analyzePitch(b.getChannelData(0), b.sampleRate)).map(n => n.center);
};

beforeEach(() => audioBufferRegistry.clear());

describe('Justesse : corriger tout sur plusieurs clips', { timeout: 60000 }, () => {
  // Deux prises chantées 40 cents trop haut (La2 + 40 ct, Do3 + 40 ct, Mi3 + 35 ct), en La mineur.
  const voice = () => synthVoice(SR, 1.6, [{ midi: 57.4, at: 0.1, len: 0.5 }, { midi: 60.4, at: 0.65, len: 0.4 }, { midi: 64.35, at: 1.1, len: 0.4 }]);
  const clips = (): { trackId: string; clip: Clip }[] => {
    reg('v1', voice()); reg('v2', voice());
    return [
      { trackId: 'lead', clip: makeClip({ id: 'c1', name: 'Couplet', bufferId: 'v1', start: 0, duration: 1.6 }) },
      { trackId: 'back', clip: makeClip({ id: 'c2', name: 'Back', bufferId: 'v2', start: 4, duration: 1.6 }) },
      { trackId: 'synth', clip: makeClip({ id: 'm', name: 'Synthé', type: 'MIDI' as any, notes: [] }) },
    ];
  };

  it('tous les clips corrigés à 100 % : notes sur la gamme, prises d’origine gardées, MIDI ignoré', async () => {
    const ctx = new FakeAudioContext(SR) as unknown as BaseAudioContext;
    let n = 0;
    const res = await correctClipsBatch(ctx, clips(), { amount: 1, style: 'naturel', key: { root: 9, scale: 'MINOR' }, makeId: c => `fix-${c.id}-${n++}` });
    expect(res.patches.map(p => p.clipId)).toEqual(['c1', 'c2']);
    expect(res.skipped).toEqual([{ trackId: 'synth', clipId: 'm', name: 'Synthé', reason: 'clip MIDI' }]);
    for (const p of res.patches) {
      expect(p.patch.pitchEdit).toMatchObject({ sourceBufferId: p.clipId === 'c1' ? 'v1' : 'v2', amount: 1, style: 'naturel' });
      const cs = centers(p.patch.bufferId!);
      expect(cs.length).toBe(3);
      cs.forEach(c => expect(Math.abs(c - Math.round(c))).toBeLessThan(0.08));
    }
  });

  it('dosage 50 % : à mi-chemin ; gamme inconnue : devinée sur toutes les notes des clips', async () => {
    const ctx = new FakeAudioContext(SR) as unknown as BaseAudioContext;
    const res = await correctClipsBatch(ctx, clips().slice(0, 2), { amount: 0.5, style: 'robot' });
    expect(res.key?.root).toBeTypeOf('number');
    const cs = centers(res.patches[0].patch.bufferId!);
    expect(cs[0]).toBeGreaterThan(57.1);
    expect(cs[0]).toBeLessThan(57.3);
    expect(res.patches[0].patch.pitchEdit?.style).toBe('robot');
  });

  it('fenêtre fermée en cours de route : rien n’est appliqué, les sons rendus sont libérés', async () => {
    const ctx = new FakeAudioContext(SR) as unknown as BaseAudioContext;
    let calls = 0;
    const before = clips();
    const res = await correctClipsBatch(ctx, before, { amount: 1, style: 'naturel', key: { root: 9, scale: 'MINOR' }, cancelled: () => ++calls > 4 });
    expect(res.patches).toEqual([]);
    expect(Array.from((audioBufferRegistry as any).buffers?.keys?.() ?? []).filter((k: string) => k.startsWith('justesse-'))).toEqual([]);
  });

  it('raisons lisibles des clips laissés de côté', () => {
    expect(pitchBatchReason(makeClip({ isReversed: true, bufferId: 'x' }))).toBe('clip inversé');
    expect(pitchBatchReason(makeClip({ bufferId: 'absent' }))).toBe('son pas encore chargé');
  });
});
