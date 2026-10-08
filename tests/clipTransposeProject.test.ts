// @vitest-environment jsdom
/**
 * R13 · Transposition / étirement / warp : le son d'origine voyage avec le
 * projet (rouvrir le réglage, revenir à l'original après réouverture), reste en
 * mémoire tant que le clip rendu existe, et voyage comme un clip normal en
 * collaboration (réglage vérifié à la réception). Gel périmé : tests/frozenStale.
 * Les anciens projets (sans le champ) s'ouvrent tels quels.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectIO } from '../services/ProjectIO';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { trackBufferIds } from '../utils/freeze';
import { editingElastic, elasticPatch, elasticRevertPatch, renderPlan, withDuration, withSemitones } from '../utils/clipTranspose';
import { sanitizeIncomingClips } from '../utils/collabMerge';
import { clampPractice, nextPreset, practiceSpeedStore } from '../utils/practiceSpeed';
import { patchClip } from '../utils/clipProcess';
import type { Clip, ElasticInfo } from '../types';
import { makeBuffer } from './helpers/audio';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

beforeEach(() => audioBufferRegistry.clear());

const has = (id: string) => audioBufferRegistry.has(id);

function transposed(orig: Clip, st: number, stretch = 1): Clip {
  const info = withDuration(withSemitones(editingElastic(orig, has).info, st), orig.duration * stretch);
  const plan = renderPlan(info, 44100, 44100);
  return patchClip(orig, elasticPatch(orig, { newBufferId: 'el-1', info: { ...info, ...plan, segments: undefined } as unknown as ElasticInfo, sourceBufferId: orig.bufferId }));
}

describe('clip transposé dans le fichier projet', () => {
  it('le son d’origine reste en mémoire tant que le clip rendu existe', () => {
    const t = makeTrack({ clips: [makeClip({ id: 'c', bufferId: 'el-1', elastic: { version: 1, sourceBufferId: 'beat-1', sourceOffset: 0, sourceDuration: 1, regionStart: 0, regionEnd: 1, renderedOffset: 0, duration: 1, semitones: 2, formants: false, algo: 'poly' } })] });
    expect(trackBufferIds(t)).toEqual(expect.arrayContaining(['el-1', 'beat-1']));
  });

  it('aller-retour fichier : le son rendu joue, l’original et le réglage reviennent après réouverture', async () => {
    audioBufferRegistry.register(makeBuffer(2, 44100, 44100), 'beat-1');
    audioBufferRegistry.register(makeBuffer(2, 48510, 44100), 'el-1');
    const original = makeClip({ id: 'c1', name: 'Beat', bufferId: 'beat-1', start: 2, offset: 0.1, duration: 0.6 });
    const t = transposed(original, -5, 1.1);
    expect(t.duration).toBeCloseTo(0.66, 9);
    const blob = await ProjectIO.saveProject(makeState([makeTrack({ id: 'instrumental', name: 'Beat', clips: [t] })]), []);
    audioBufferRegistry.clear();
    const st = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    const c = st.tracks[0].clips[0];
    expect(c.bufferId && audioBufferRegistry.get(c.bufferId)?.length).toBe(48510);
    expect(c.elastic?.sourceRef).toBeUndefined();
    expect(c.elastic?.sourceBufferId && audioBufferRegistry.get(c.elastic.sourceBufferId)?.length).toBe(44100);
    // Réglage rouvert depuis l'original.
    const ed = editingElastic(c, has);
    expect(ed.fromOriginal).toBe(true);
    expect(ed.info.semitones).toBe(-5);
    const back = patchClip(c, elasticRevertPatch(c, has)!);
    expect([back.name, back.start, back.elastic]).toEqual(['Beat', 2, undefined]);
    expect(back.offset).toBeCloseTo(0.1, 9);
    expect(back.duration).toBeCloseTo(0.6, 9);
    expect(audioBufferRegistry.get(back.bufferId!)?.length).toBe(44100);
  });

  it('ancien projet (sans le champ) : s’ouvre et joue tel quel', async () => {
    audioBufferRegistry.register(makeBuffer(1, 4410, 44100), 'old-1');
    const blob = await ProjectIO.saveProject(makeState([makeTrack({ clips: [makeClip({ id: 'o', bufferId: 'old-1', duration: 0.1 })] })]), []);
    audioBufferRegistry.clear();
    const st = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    expect(st.tracks[0].clips[0].elastic).toBeUndefined();
    expect(audioBufferRegistry.get(st.tracks[0].clips[0].bufferId!)?.length).toBe(4410);
  });
});

describe('collaboration', () => {
  it('réglage reçu vérifié : abîmé → retiré (le son rendu joue quand même) ; correct → gardé', () => {
    const ok = makeClip({ id: 'a', bufferId: 'x', elastic: { version: 1, sourceOffset: 0, sourceDuration: 1, regionStart: 0, regionEnd: 1, renderedOffset: 0, duration: 1.1, semitones: 3, formants: true, algo: 'auto', markers: [{ id: 'm', src: 0.5, dst: 0.6 }, { id: 'bad', src: NaN, dst: 1 } as any] } });
    const bad = makeClip({ id: 'b', bufferId: 'y', elastic: { semitones: 99 } as any });
    const [a, b] = sanitizeIncomingClips([ok, bad]);
    expect(a.elastic?.markers).toEqual([{ id: 'm', src: 0.5, dst: 0.6 }]);
    expect(b.elastic).toBeUndefined();
    expect(b.bufferId).toBe('y');
  });

});

describe('vitesse de lecture (réglage d’écoute)', () => {
  it('bornée de 50 à 100 %, préréglages en boucle', () => {
    expect(clampPractice(0.2)).toBe(0.5);
    expect(clampPractice(1.4)).toBe(1);
    expect(clampPractice(0.754)).toBe(0.75);
    expect([1, 0.85, 0.75, 0.6, 0.5].map(nextPreset)).toEqual([0.85, 0.75, 0.6, 0.5, 1]);
    practiceSpeedStore.set(0.75);
    expect(practiceSpeedStore.get()).toBe(0.75);
    practiceSpeedStore.set(1);
  });
});
