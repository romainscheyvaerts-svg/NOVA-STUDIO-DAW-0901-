import { describe, expect, it } from 'vitest';
import {
  anchorClipsToRender, canBakeTrack, coveredClipIds, freezeIndex, freezeSignature, frozenPlayback, hasVst,
  isFreezeStale, isPluginBaked, isTrackFrozen, lastVstIndex, needsRerender, pluginsSignature, postFreezePlugins,
  preFreezePlugins, uncoveredClips, FREEZE_SLICE_TAIL,
} from '../utils/freeze';
import { Clip, PluginInstance, PluginType, Track } from '../types';
import { makeClip, makeTrack } from './helpers/fixtures';

const plug = (id: string, type = 'COMPRESSOR', params: Record<string, any> = { t: 1 }): PluginInstance =>
  ({ id, name: id, type: type as PluginType, isEnabled: true, params, latency: 0 });

describe('règles du gel', () => {
  it('isTrackFrozen : drapeau ET rendu', () => {
    expect(isTrackFrozen(makeTrack({ isFrozen: true }))).toBe(false);
    expect(isTrackFrozen(makeTrack({ isFrozen: false, frozenClip: makeClip() }))).toBe(false);
    expect(isTrackFrozen(makeTrack({ isFrozen: true, frozenClip: makeClip() }))).toBe(true);
  });

  it('freezeIndex : absent = tous les effets, borné, entier', () => {
    const plugins = [plug('a'), plug('b'), plug('c')];
    expect(freezeIndex(makeTrack({ plugins }))).toBe(2);
    expect(freezeIndex(makeTrack({ plugins, frozenUpToPluginIndex: 1 }))).toBe(1);
    expect(freezeIndex(makeTrack({ plugins, frozenUpToPluginIndex: 1.7 }))).toBe(1);
    expect(freezeIndex(makeTrack({ plugins, frozenUpToPluginIndex: 9 }))).toBe(2);
    expect(freezeIndex(makeTrack({ plugins, frozenUpToPluginIndex: -5 }))).toBe(-1);
    expect(freezeIndex(makeTrack({ plugins, frozenUpToPluginIndex: NaN }))).toBe(2);
    expect(freezeIndex(makeTrack({ plugins: [] }))).toBe(-1);
  });

  it('effets avant / après le rendu', () => {
    const plugins = [plug('a'), plug('b'), plug('c')];
    const t = makeTrack({ plugins, frozenUpToPluginIndex: 0 });
    expect(preFreezePlugins(t).map(p => p.id)).toEqual(['a']);
    expect(postFreezePlugins(t).map(p => p.id)).toEqual(['b', 'c']);
  });

  it('VST3 : présence et dernier index', () => {
    const t = makeTrack({ plugins: [plug('v1', 'VST3'), plug('eq'), plug('v2', 'VST3'), plug('comp')] });
    expect(hasVst(t)).toBe(true);
    expect(lastVstIndex(t)).toBe(2);
    expect(lastVstIndex(makeTrack({ plugins: [plug('eq')] }))).toBe(-1);
  });

  it('canBakeTrack : jamais le beat ni un instrument du catalogue', () => {
    expect(canBakeTrack(makeTrack({ id: 'instrumental' }))).toBe(false);
    expect(canBakeTrack(makeTrack({ instrumentId: 'uuid' }))).toBe(false);
    expect(canBakeTrack(makeTrack({ instrumentId: 12 }))).toBe(false);
    expect(canBakeTrack(makeTrack({ instrumentId: '' }))).toBe(true);
    expect(canBakeTrack(makeTrack({ instrumentId: null as any }))).toBe(true);
    expect(canBakeTrack(makeTrack())).toBe(true);
  });

  it('isPluginBaked : seulement les effets compris dans le rendu d\'une piste gelée', () => {
    const t = makeTrack({ plugins: [plug('a'), plug('b')], isFrozen: true, frozenClip: makeClip(), frozenUpToPluginIndex: 0 });
    expect(isPluginBaked(t, 0)).toBe(true);
    expect(isPluginBaked(t, 1)).toBe(false);
    expect(isPluginBaked({ ...t, isFrozen: false }, 0)).toBe(false);
  });

  it('coveredClipIds : null pour les anciens projets', () => {
    expect(coveredClipIds(makeTrack())).toBeNull();
    expect(coveredClipIds(makeTrack({ frozenClipIds: ['a'] }))).toEqual(new Set(['a']));
  });
});

describe('empreintes', () => {
  const clips = () => [makeClip({ id: 'c1', start: 1, bufferId: 'b1' }), makeClip({ id: 'c2', start: 5, bufferId: 'b2' })];

  it('freezeSignature : stable, sensible aux clips et aux effets rendus seulement', () => {
    const plugins = [plug('a'), plug('b')];
    const base = freezeSignature(clips(), plugins, 0);
    expect(freezeSignature(clips(), plugins, 0)).toBe(base);
    const moved = clips(); moved[1].start = 5.5;
    expect(freezeSignature(moved, plugins, 0)).not.toBe(base);
    const louder = clips(); louder[0].gain = 0.5;
    expect(freezeSignature(louder, plugins, 0)).not.toBe(base);
    // Effet après le rendu : ignoré
    expect(freezeSignature(clips(), [plug('a'), plug('b', 'EQ', { z: 9 })], 0)).toBe(base);
    // Effet rendu modifié : change
    expect(freezeSignature(clips(), [plug('a', 'COMPRESSOR', { t: 2 }), plug('b')], 0)).not.toBe(base);
  });

  it('pluginsSignature : l\'état binaire du VST compte', () => {
    const a = pluginsSignature([plug('v', 'VST3', { stateB64: 'AAA', x: 1 })], 0);
    expect(pluginsSignature([plug('v', 'VST3', { stateB64: 'AAA', x: 1 })], 0)).toBe(a);
    expect(pluginsSignature([plug('v', 'VST3', { stateB64: 'BBB', x: 1 })], 0)).not.toBe(a);
    expect(pluginsSignature([{ ...plug('v', 'VST3', { stateB64: 'AAA', x: 1 }), isEnabled: false }], 0)).not.toBe(a);
  });

  it('needsRerender (ancien modèle) : clip rendu modifié ou supprimé', () => {
    const plugins = [plug('v', 'VST3')];
    const c = clips();
    const t = makeTrack({ clips: c, plugins, frozenClip: makeClip(), frozenClipIds: ['c1', 'c2'], frozenSourceSig: freezeSignature(c, plugins, 0) });
    expect(needsRerender(t)).toBe(false);
    expect(isFreezeStale(t)).toBe(false);
    expect(needsRerender({ ...t, clips: [c[0]] })).toBe(true);
    expect(needsRerender({ ...t, clips: [c[0], { ...c[1], start: 9 }] })).toBe(true);
    expect(isFreezeStale({ ...t, clips: [c[0], { ...c[1], start: 9 }] })).toBe(true);
    // Clip ajouté après le rendu : pas couvert, rendu toujours bon
    expect(needsRerender({ ...t, clips: [...c, makeClip({ id: 'new' })] })).toBe(false);
  });

  it('isFreezeStale (clips ancrés) : éditer les clips ne périme pas, changer un effet rendu oui', () => {
    const plugins = [plug('v', 'VST3'), plug('eq')];
    const c = clips();
    const t = makeTrack({
      clips: c, plugins, frozenClip: makeClip(), frozenUpToPluginIndex: 0, frozenClipIds: ['c1', 'c2'],
      frozenSourceSig: freezeSignature(c, plugins, 0), frozenPluginSig: pluginsSignature(plugins, 0),
    });
    expect(isFreezeStale({ ...t, clips: [{ ...c[0], start: 3 }] })).toBe(false);
    expect(isFreezeStale({ ...t, plugins: [plugins[0], plug('eq', 'EQ', { gain: 6 })] })).toBe(false);
    expect(isFreezeStale({ ...t, plugins: [plug('v', 'VST3', { t: 5 }), plugins[1]] })).toBe(true);
    expect(isFreezeStale({ ...t, frozenClip: undefined })).toBe(false);
  });
});

describe('clips ancrés et lecture d\'une piste gelée', () => {
  const fc = (): Clip => makeClip({ id: 'fz', bufferId: 'fzb', start: 0, duration: 20 });

  it('anchorClipsToRender : audio non inversé seulement', () => {
    const m = anchorClipsToRender([
      makeClip({ id: 'a', start: 3, offset: 1, duration: 2, bufferId: 'b', fadeIn: 0.1, gain: 0.8 }),
      makeClip({ id: 'nobuf' }),
      makeClip({ id: 'rev', bufferId: 'b', isReversed: true }),
      makeClip({ id: 'midi', bufferId: 'b', notes: [] }),
    ], 'fz');
    expect(Array.from(m.keys())).toEqual(['a']);
    expect(m.get('a')).toEqual({ renderId: 'fz', anchor: 2, from: 1, to: 3, fadeIn: 0.1, fadeOut: 0, gain: 0.8 });
  });

  function anchored(edit: Partial<Clip> = {}, src: Partial<Clip> = {}): Track {
    const orig = makeClip({ id: 'c', start: 2, offset: 0, duration: 4, bufferId: 'b', ...src });
    const ref = anchorClipsToRender([orig], 'fz').get('c')!;
    return makeTrack({ clips: [{ ...orig, freezeRef: ref, ...edit }], frozenClip: fc(), isFrozen: true, frozenPluginSig: 'sig' });
  }

  it('clip intact : une tranche du rendu, queue d\'effets gardée, rien en direct', () => {
    const { render, live } = frozenPlayback(anchored());
    expect(live).toEqual([]);
    expect(render).toHaveLength(1);
    expect(render[0]).toMatchObject({
      id: 'c~fz', bufferId: 'fzb', start: 2, offset: 2, duration: 4 + FREEZE_SLICE_TAIL,
      gain: 1, fadeIn: 0, fadeOut: 0, isFreezeSlice: true,
    });
    expect(render[0].freezeRef).toBeUndefined();
  });

  it('clip déplacé : la tranche suit, toujours lue au même endroit du rendu', () => {
    const { render } = frozenPlayback(anchored({ start: 10 }));
    expect(render[0]).toMatchObject({ start: 10, offset: 2 });
  });

  it('clip raccourci : pas de queue, fondu de 5 ms', () => {
    const { render } = frozenPlayback(anchored({ duration: 3 }));
    expect(render[0]).toMatchObject({ duration: 3, fadeOut: 0.005 });
  });

  it('volume du clip changé : seul le rapport est appliqué', () => {
    const { render } = frozenPlayback(anchored({ gain: 0.5 }, { gain: 0.8 }));
    expect(render[0].gain).toBeCloseTo(0.625);
  });

  it('clip rallongé à gauche : la partie non rendue passe en direct', () => {
    // Rendu fait avec offset 1 ; l'utilisateur ramène le début à offset 0.
    const t = anchored({ start: 2, offset: 0, duration: 4 }, { start: 3, offset: 1, duration: 3 });
    const { render, live } = frozenPlayback(t);
    expect(render[0]).toMatchObject({ start: 3, offset: 3 });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: 'c~pre', start: 2, duration: 1, fadeOut: 0.005 });
  });

  it('clip rallongé à droite : la fin passe en direct', () => {
    const { live } = frozenPlayback(anchored({ duration: 6 }));
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: 'c~post', start: 6, offset: 4, duration: 2, fadeIn: 0.005 });
  });

  it('ancien modèle : le rendu entier, plus les clips ajoutés après', () => {
    const t = makeTrack({
      clips: [makeClip({ id: 'old' }), makeClip({ id: 'new' })],
      frozenClip: fc(), isFrozen: true, frozenClipIds: ['old'],
    });
    const { render, live } = frozenPlayback(t);
    expect(render.map(c => c.id)).toEqual(['fz']);
    expect(live.map(c => c.id)).toEqual(['new']);
    expect(uncoveredClips(t).map(c => c.id)).toEqual(['new']);
    expect(uncoveredClips({ ...t, frozenClip: undefined })).toEqual([]);
  });

  it('résultat mis en cache par objet piste', () => {
    const t = anchored();
    expect(frozenPlayback(t)).toBe(frozenPlayback(t));
  });
});
