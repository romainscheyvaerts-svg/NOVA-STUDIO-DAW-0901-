/**
 * Melodyne / VocAlign en insert sur une piste, comme Pro Tools (utils/araInsert) :
 *  - document ARA de la piste : un son = une source, un clip = une région, à jour après
 *    déplacer / couper / rogner / supprimer / dupliquer (et Shuffle, qui ne fait que déplacer) ;
 *  - contexte musical : piste tempo (points instant / noires, mesures) et accords ;
 *  - insert placé en tête de chaîne, un seul par piste ;
 *  - état de l'insert (archive ARA + état VST3) et message chez un collaborateur sans plugin.
 */
import { describe, expect, it } from 'vitest';
import { TrackType } from '../types';
import type { Clip, PluginInstance, Track } from '../types';
import {
  araArchiveOfState, araChangedRegions, araDocSignature, araDocumentFor, araInsertKind, araInsertMetadata, araInsertOf,
  araMissingMessage, araMusicFor, araSelectionFor, circleOfFifths, effectsBeforeAraInsert, isAraInsert, withAraInsertFirst,
} from '../utils/araInsert';
import { buildTempoMap } from '../utils/tempoMap';
import { hasVst, lastVstIndex } from '../utils/freeze';

const clip = (id: string, start: number, offset: number, duration: number, extra: Partial<Clip> = {}): Clip => ({
  id, start, offset, duration, fadeIn: 0, fadeOut: 0, name: `Clip ${id}`, color: '#fff', type: TrackType.AUDIO, bufferId: 'buf-voix', ...extra,
});
const ara = (kind = 'melodyne', extra: Partial<PluginInstance> = {}): PluginInstance => ({
  id: `p-${kind}`, name: kind === 'melodyne' ? 'Melodyne' : 'VocAlign', type: 'VST3', isEnabled: true, latency: 0,
  params: { name: kind, localPath: `C:\\VST3\\${kind}.vst3`, ara: kind }, ...extra,
});
const comp: PluginInstance = { id: 'p-comp', name: 'Compresseur', type: 'COMPRESSOR' as any, isEnabled: true, latency: 0, params: {} };
const track = (clips: Clip[], plugins: PluginInstance[] = [ara()]): Track => ({ id: 't1', name: 'Voix lead', clips, plugins } as unknown as Track);
const len = (id: string) => (id === 'buf-voix' ? 9 : id === 'buf-2' ? 4 : null);

describe('insert ARA : reconnaissance et place dans la chaîne', () => {
  it('un VST3 avec params.ara est un insert ARA', () => {
    expect(isAraInsert(ara())).toBe(true);
    expect(araInsertKind(ara('vocalign'))).toBe('vocalign');
    expect(isAraInsert({ ...ara(), params: { localPath: 'x' } })).toBe(false);
    expect(isAraInsert(comp)).toBe(false);
  });

  it('métadonnées posées depuis la liste des plugins du pont', () => {
    expect(araInsertMetadata({ name: 'Melodyne', path: 'C:\\Program Files\\Common Files\\VST3\\Celemony\\Melodyne\\Melodyne.vst3' })?.ara).toBe('melodyne');
    expect(araInsertMetadata({ name: 'VocAlign 6 Standard', path: 'C:\\VST3\\VocAlign6Standard.vst3' })?.ara).toBe('vocalign');
    expect(araInsertMetadata({ name: 'Pro-Q 4', path: 'C:\\VST3\\FabFilter Pro-Q 4.vst3' })).toBeNull();
  });

  it('tout en haut de la chaîne (il lit les clips eux-mêmes) ; effets placés avant signalés', () => {
    const list = withAraInsertFirst([comp], ara());
    expect(list.map(p => p.id)).toEqual(['p-melodyne', 'p-comp']);
    expect(effectsBeforeAraInsert(track([], [comp, ara()])).map(p => p.id)).toEqual(['p-comp']);
    expect(effectsBeforeAraInsert(track([], list))).toEqual([]);
  });

  it('un insert inactif ne compte pas', () => {
    expect(araInsertOf(track([], [{ ...ara(), isInactive: true }]))).toBeNull();
    expect(araInsertOf(track([], [comp, ara()]))?.id).toBe('p-melodyne');
  });
});

describe('document ARA de la piste, à chaque édition', () => {
  it('un son = une source, un clip = une région (début dans le fichier, place, durée)', () => {
    const d = araDocumentFor(track([clip('c1', 1.5, 0, 9)]), len);
    expect(d.sources).toEqual([{ id: 'buf-voix', name: 'Clip c1', persistent_id: 'nova:buf-voix' }]);
    expect(d.regions).toEqual([{ id: 'c1', source: 'buf-voix', name: 'Clip c1', offset: 0, start: 1.5, duration: 9 }]);
    expect(d.track.name).toBe('Voix lead');
  });

  it('déplacer, couper, rogner, supprimer, dupliquer : régions à jour, la source reste la même', () => {
    const base = araDocumentFor(track([clip('c1', 1.5, 0, 9)]), len);
    const moved = araDocumentFor(track([clip('c1', 2.5, 0, 9)]), len);
    expect(araChangedRegions(base, moved)).toEqual({ added: [], removed: [], moved: ['c1'] });
    const split = araDocumentFor(track([clip('c1', 2.5, 0, 1.5), clip('c1b', 4, 1.5, 7.5)]), len);
    expect(split.sources).toHaveLength(1);
    expect(split.regions.map(r => [r.id, r.offset, r.start, r.duration])).toEqual([['c1', 0, 2.5, 1.5], ['c1b', 1.5, 4, 7.5]]);
    expect(araChangedRegions(moved, split)).toEqual({ added: ['c1b'], removed: [], moved: ['c1'] });
    const trimmed = araDocumentFor(track([clip('c1', 3.3, 0.8, 0.7), clip('c1b', 4, 1.5, 7.5)]), len);
    expect(trimmed.regions[0]).toMatchObject({ offset: 0.8, start: 3.3, duration: 0.7 });
    const dup = araDocumentFor(track([clip('c1', 3.3, 0.8, 0.7), clip('c1b', 4, 1.5, 7.5), clip('c1c', 13, 1.5, 7.5)]), len);
    expect(araChangedRegions(trimmed, dup).added).toEqual(['c1c']);
    const del = araDocumentFor(track([clip('c1b', 4, 1.5, 7.5), clip('c1c', 13, 1.5, 7.5)]), len);
    expect(araChangedRegions(dup, del).removed).toEqual(['c1']);
  });

  it('région bornée au fichier ; clips muets, MIDI, inversés ou pas encore chargés : absents', () => {
    const d = araDocumentFor(track([
      clip('long', 0, 8, 5), clip('muet', 0, 0, 1, { isMuted: true }), clip('midi', 0, 0, 1, { type: TrackType.MIDI }),
      clip('inv', 0, 0, 1, { isReversed: true }), clip('attente', 0, 0, 1, { bufferId: 'buf-inconnu' }), clip('autre', 5, 0, 2, { bufferId: 'buf-2' }),
    ]), len);
    expect(d.regions.find(r => r.id === 'long')?.duration).toBe(1);
    expect(d.regions.map(r => r.id).sort()).toEqual(['autre', 'long']);
    expect(d.sources.map(s => s.id).sort()).toEqual(['buf-2', 'buf-voix']);
    expect(d.skipped.map(s => s.reason)).toEqual(['muet', 'inversé', 'son pas encore chargé']);
  });

  it('empreinte : identique tant que rien ne bouge (rien renvoyé au pont)', () => {
    const a = araDocumentFor(track([clip('c1', 1.5, 0, 9)]), len);
    const b = araDocumentFor(track([clip('c1', 1.5, 0, 9)]), len);
    expect(araDocSignature(a)).toBe(araDocSignature(b));
    expect(araDocSignature(a)).not.toBe(araDocSignature(araDocumentFor(track([clip('c1', 1.6, 0, 9)]), len)));
  });

  it('l’éditeur suit la sélection : clips de la piste seulement', () => {
    const t = track([clip('c1', 0, 0, 1), clip('c2', 2, 0, 1)]);
    expect(araSelectionFor(t, ['c2', 'ailleurs'])).toEqual(['c2']);
    expect(araSelectionFor(t, [])).toEqual([]);
  });
});

describe('contexte musical : piste tempo et accords', () => {
  it('tempo constant : deux points (instant, noires), une mesure 4/4', () => {
    const m = araMusicFor(buildTempoMap(95, { numerator: 4, denominator: 4 }));
    expect(m.bpm).toBe(95);
    expect(m.tempo[0]).toEqual({ t: 0, q: 0 });
    expect(m.tempo[1].q / m.tempo[1].t).toBeCloseTo(95 / 60, 9);
    expect(m.signatures).toEqual([{ q: 0, num: 4, den: 4 }]);
  });

  it('changement de tempo et de mesure (R2) : points et signatures au bon endroit', () => {
    const map = buildTempoMap(120, { numerator: 4, denominator: 4 }, [{ id: 'e', bar: 2, bpm: 60, numerator: 3, denominator: 4 }]);
    const m = araMusicFor(map);
    expect(m.tempo[1]).toEqual({ t: 4, q: 8 });
    expect(m.signatures[1]).toEqual({ q: 8, num: 3, den: 4 });
    expect((m.tempo[2].q - m.tempo[1].q) / (m.tempo[2].t - m.tempo[1].t)).toBeCloseTo(1, 9);
  });

  it('accords (V20) : position en noires, racine sur le cycle des quintes, intervalles ARA', () => {
    expect([0, 7, 2, 5, 6, 10].map(circleOfFifths)).toEqual([0, 1, 2, -1, 6, -2]);
    const m = araMusicFor(buildTempoMap(120, { numerator: 4, denominator: 4 }), [
      { id: 'a', start: 2, end: 4, root: 9, quality: 'min' } as any, { id: 'b', start: 0, end: 2, root: 0, quality: 'maj' } as any,
    ]);
    expect(m.chords.map(c => [c.q, c.root, c.name])).toEqual([[0, 0, 'C'], [4, 3, 'Am']]);
    expect(m.chords[0].intervals).toEqual([1, 0, 0, 0, 3, 0, 0, 5, 0, 0, 0, 0]);
    expect(m.chords[1].intervals).toEqual([1, 0, 0, 3, 0, 0, 0, 5, 0, 0, 0, 0]);
  });
});

describe('état de l’insert et collaboration', () => {
  it('archive ARA lue dans l’état « NARA1. » (et ancienne archive nue)', () => {
    const st = 'NARA1.' + btoa(JSON.stringify({ ara: 'QVJBQVJD', vst: 'VlNU' }));
    expect(araArchiveOfState(st)).toBe('QVJBQVJD');
    expect(araArchiveOfState('QVJBQVJD')).toBe('QVJBQVJD');
    expect(araArchiveOfState(null)).toBeUndefined();
    expect(araArchiveOfState('NARA1.%%%')).toBeUndefined();
  });

  it('collaboration : la piste à insert ARA est rendue à la sauvegarde comme une piste à VST', () => {
    const t = track([clip('c1', 1.5, 0, 9)]);
    expect(hasVst(t)).toBe(true);
    expect(lastVstIndex(t)).toBe(0);
  });

  it('sans le plugin : le son retouché (rendu) est joué tel quel', () => {
    expect(araMissingMessage('melodyne', { bridgeConnected: true, pluginInstalled: false, frozen: true }))
      .toBe('Melodyne absent sur ce PC : le son retouché est joué tel quel.');
    expect(araMissingMessage('melodyne', { bridgeConnected: false, pluginInstalled: false, frozen: true })).toMatch(/joué tel quel/);
    expect(araMissingMessage('vocalign', { bridgeConnected: true, pluginInstalled: false, frozen: false })).toMatch(/sans les retouches/);
    expect(araMissingMessage('melodyne', { bridgeConnected: true, pluginInstalled: true, frozen: false })).toBeNull();
  });
});
