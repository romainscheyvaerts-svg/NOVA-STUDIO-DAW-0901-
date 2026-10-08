import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBreathPlan, DEFAULT_BREATH_SETTINGS, planBreaths } from '../utils/breaths';
import { clipGainAt } from '../utils/fades';
import { anchorClipsToRender, breathsNeedRefreeze, freezeSignature, frozenPlayback, sliceBreaths } from '../utils/freeze';
import { clipRegion, correctedClipPatch, revertClipPatch, shiftBreaths } from '../utils/pitchEdit';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { rapPhrases } from './helpers/breathSignals';
import { FakeAudioBuffer } from './helpers/audio';
import { makeClip, makeTrack } from './helpers/fixtures';
import type { Clip, Track } from '../types';

vi.mock('../services/supabase', () => ({ supabase: null, isSupabaseConfigured: () => false }));
vi.mock('../engine/AudioEngine', () => ({ audioEngine: { init: async () => {}, ctx: null } }));

const SR = 44100;
const bufferOf = (x: Float32Array) => {
  const b = new FakeAudioBuffer({ numberOfChannels: 1, length: x.length, sampleRate: SR });
  b.getChannelData(0).set(x);
  return b as unknown as AudioBuffer;
};
/** « Son corrigé » de même durée : ici l'audio identique, rendu sur la région [a, b[ (comme V19). */
const sliceBuffer = (buf: AudioBuffer, a: number, b: number) => bufferOf(buf.getChannelData(0).slice(Math.floor(a * SR), Math.round(b * SR)));
const has = (id: string) => audioBufferRegistry.has(id);

beforeEach(() => audioBufferRegistry.clear());

/** Gain des respirations à chaque instant du morceau (timeline) couvert par le clip. */
const gainCurve = (c: Clip, step = 0.005) => {
  const out: number[] = [];
  for (let t = c.start; t <= c.start + c.duration; t += step) out.push(clipGainAt(c, t - c.start));
  return out;
};

describe('respirations et justesse (V19) : un nouveau son de même durée', { timeout: 30000 }, () => {
  const v = rapPhrases(3);
  const orig = bufferOf(v.x);

  function treatedLead(offset: number, duration: number): Clip {
    audioBufferRegistry.register(orig, 'rec');
    const t = makeTrack({ id: 'lead', name: 'LEAD', clips: [makeClip({ id: 'c', bufferId: 'rec', start: 10, offset, duration })] });
    const plans = planBreaths([t], c => audioBufferRegistry.get(c.bufferId!), DEFAULT_BREATH_SETTINGS);
    const c = applyBreathPlan([t], plans)[0].clips[0];
    expect(c.breaths!.length).toBeGreaterThan(0);
    return c;
  }

  function correct(c: Clip): Clip {
    // Comme PitchEditor.apply : région = clip + marge, nouveau son qui commence à region.start.
    const src = c.pitchEdit?.sourceBufferId && has(c.pitchEdit.sourceBufferId)
      ? { id: c.pitchEdit.sourceBufferId, offset: (c.offset || 0) + c.pitchEdit.regionStart }
      : { id: c.bufferId!, offset: c.offset || 0 };
    const buf = audioBufferRegistry.get(src.id)!;
    const region = clipRegion({ offset: src.offset, duration: c.duration }, buf.duration);
    const id = `justesse-${Math.random()}`;
    audioBufferRegistry.register(sliceBuffer(buf, region.start, region.end), id);
    return { ...c, ...correctedClipPatch(c, { newBufferId: id, sourceBufferId: src.id, sourceOffset: src.offset, regionStart: region.start, edits: [] }) };
  }

  it('respirations puis justesse : les zones restent au même endroit du morceau (clip découpé, offset 6 s)', () => {
    const before = treatedLead(6, orig.duration - 6);
    const after = correct(before);
    expect(after.offset).toBeCloseTo(0.25);
    expect(after.breaths!.length).toBe(before.breaths!.length);
    // Chaque zone est décalée de (nouvel offset − ancien offset) : même instant du morceau.
    after.breaths!.forEach((e, i) => expect(e.start - after.offset).toBeCloseTo(before.breaths![i].start - before.offset, 4));
    expect(gainCurve(after)).toEqual(gainCurve(before).map(g => expect.closeTo(g, 6)));
  });

  it('retoucher une deuxième fois (depuis la prise d’origine), puis revenir à l’origine : toujours au même endroit', () => {
    const before = treatedLead(6, orig.duration - 6);
    const twice = correct(correct(before));
    expect(gainCurve(twice)).toEqual(gainCurve(before).map(g => expect.closeTo(g, 6)));
    const back = { ...twice, ...revertClipPatch(twice, has)! };
    expect(back.bufferId).toBe('rec');
    expect(back.offset).toBeCloseTo(6);
    expect(back.breaths).toEqual(before.breaths!.filter(e => e.end > 6 - 0.25).map(e => ({ ...e, start: expect.closeTo(e.start, 4), end: expect.closeTo(e.end, 4) })));
    expect(gainCurve(back)).toEqual(gainCurve(before).map(g => expect.closeTo(g, 6)));
  });

  it('justesse puis respirations : détectées sur le son corrigé aux mêmes endroits, gardées au retour à l’origine', () => {
    const ref = treatedLead(6, orig.duration - 6);
    audioBufferRegistry.register(orig, 'rec');
    const raw = makeClip({ id: 'c', bufferId: 'rec', start: 10, offset: 6, duration: orig.duration - 6 });
    const corrected = correct(raw);
    const t = makeTrack({ id: 'lead', name: 'LEAD', clips: [corrected] });
    const treated = applyBreathPlan([t], planBreaths([t], c => audioBufferRegistry.get(c.bufferId!), DEFAULT_BREATH_SETTINGS))[0].clips[0];
    // Mêmes zones (l'audio est le même) : même gain le long du morceau.
    expect(gainCurve(treated)).toEqual(gainCurve(ref).map(g => expect.closeTo(g, 4)));
    const back = { ...treated, ...revertClipPatch(treated, has)! };
    expect(gainCurve(back)).toEqual(gainCurve(ref).map(g => expect.closeTo(g, 4)));
  });

  it('shiftBreaths : zones avant le début du nouveau son retirées, rien si aucune', () => {
    expect(shiftBreaths(undefined, 3)).toBeUndefined();
    expect(shiftBreaths([{ start: 1, end: 1.3, gainDb: -15 }, { start: 5, end: 5.4, gainDb: -15 }], -4)).toEqual([{ start: 1, end: 1.4, gainDb: -15 }]);
    expect(shiftBreaths([{ start: 1, end: 1.3, gainDb: -15 }], -2)).toBeUndefined();
  });

  it('un clip sans respirations reste sans champ breaths après la correction', () => {
    audioBufferRegistry.register(orig, 'rec');
    const p = correctedClipPatch(makeClip({ bufferId: 'rec', offset: 2 }), { newBufferId: 'x', sourceBufferId: 'rec', sourceOffset: 2, regionStart: 1.75, edits: [] });
    expect('breaths' in p).toBe(false);
  });
});

describe('respirations sur une piste gelée', () => {
  const render = (): Clip => makeClip({ id: 'fz', bufferId: 'fzb', start: 0, duration: 30 });
  const edits = [{ start: 3.2, end: 3.6, gainDb: -15, fade: 0.01 }, { start: 5, end: 5.3, gainDb: -15, fade: 0.01 }];

  function frozen(atRender: Partial<Clip>, now: Partial<Clip>): Track {
    const orig = makeClip({ id: 'c', start: 12, offset: 2, duration: 6, bufferId: 'b', ...atRender });
    const ref = anchorClipsToRender([orig], 'fz').get('c')!;
    return makeTrack({ clips: [{ ...orig, ...now, freezeRef: ref }], frozenClip: render(), isFrozen: true, frozenPluginSig: 'sig' });
  }

  it('traitées après le gel : la tranche du rendu joue les zones au bon endroit (repère du rendu), tout de suite', () => {
    const t = frozen({}, { breaths: edits });
    const slice = frozenPlayback(t).render[0];
    expect(slice.offset).toBe(12); // ancrage 10 + offset 2
    expect(slice.breaths).toEqual(edits.map(e => ({ ...e, start: e.start + 10, end: e.end + 10 })));
    // Même gain que le clip d'origine, instant par instant, sur sa durée.
    for (let x = 0; x < 6; x += 0.003) expect(clipGainAt(slice, x)).toBeCloseTo(clipGainAt(t.clips[0], x), 9);
    expect(breathsNeedRefreeze(t)).toBe(false);
  });

  it('traitées avant le gel : déjà dans le rendu, jamais appliquées deux fois', () => {
    const t = frozen({ breaths: edits }, {});
    expect(t.clips[0].freezeRef!.breaths).toEqual(edits);
    expect(frozenPlayback(t).render[0].breaths).toBeUndefined();
    expect(breathsNeedRefreeze(t)).toBe(false);
  });

  it('une respiration ajoutée après le gel : seule la nouvelle est jouée par la tranche', () => {
    const extra = { start: 6.5, end: 6.8, gainDb: -15, fade: 0.01 };
    const t = frozen({ breaths: edits }, { breaths: [...edits, extra] });
    expect(sliceBreaths(t.clips[0], t.clips[0].freezeRef!)).toEqual({ edits: [{ ...extra, start: 16.5, end: 16.8 }], exact: true });
    expect(breathsNeedRefreeze(t)).toBe(false);
  });

  it('dosage changé ou traitement retiré après le gel : le rendu doit être refait (regel)', () => {
    expect(breathsNeedRefreeze(frozen({ breaths: edits }, { breaths: edits.map(e => ({ ...e, gainDb: -25 })) }))).toBe(true);
    expect(breathsNeedRefreeze(frozen({ breaths: edits }, { breaths: undefined }))).toBe(true);
    // Piste non gelée : jamais.
    expect(breathsNeedRefreeze({ ...frozen({ breaths: edits }, { breaths: undefined }), isFrozen: false })).toBe(false);
  });

  it('empreinte du rendu : sensible aux respirations, inchangée pour un clip sans respirations', () => {
    const c = makeClip({ id: 'k', bufferId: 'b' });
    const s0 = freezeSignature([c], [], -1);
    expect(freezeSignature([{ ...c, breaths: undefined }], [], -1)).toBe(s0);
    expect(freezeSignature([{ ...c, breaths: edits }], [], -1)).not.toBe(s0);
  });

  it('ancien modèle (un seul rendu) : des respirations changées demandent un regel', () => {
    const c = makeClip({ id: 'old', bufferId: 'b' });
    const base = makeTrack({ clips: [c], frozenClip: render(), isFrozen: true, frozenClipIds: ['old'], frozenSourceSig: freezeSignature([c], [], -1), frozenUpToPluginIndex: -1 });
    expect(breathsNeedRefreeze(base)).toBe(false);
    expect(breathsNeedRefreeze({ ...base, clips: [{ ...c, breaths: edits }] })).toBe(true);
  });
});
