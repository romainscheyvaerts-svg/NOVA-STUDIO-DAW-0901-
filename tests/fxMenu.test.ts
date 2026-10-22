import { describe, expect, it } from 'vitest';
import { quickEffects, groupEffects } from '../components/AddEffectMenu';
import { toggledFavorite, withRecent } from '../utils/fxFavorites';
import { vstMenuEntries } from '../utils/vstMenu';

describe('menu « Ajouter un effet » : favoris, récents, VST du PC', () => {
  const list = [{ id: 'PROEQ12', name: 'Égaliseur' }, { id: 'COMPRESSOR', name: 'Compresseur' }, { id: 'REVERB', name: 'Reverb' }];
  it('favoris puis récents (sans doublon), en tête', () => {
    const q = quickEffects(list, ['REVERB'], ['COMPRESSOR', 'REVERB']);
    expect(q.map(g => [g.cat, g.items.map(e => e.id)])).toEqual([['Favoris', ['REVERB']], ['Récents', ['COMPRESSOR']]]);
    expect(withRecent(['A', 'B', 'C', 'D', 'E', 'F'], 'C')).toEqual(['C', 'A', 'B', 'D', 'E', 'F']);
    expect(withRecent(['A', 'B', 'C', 'D', 'E', 'F'], 'G')).toHaveLength(6);
    expect(toggledFavorite(['A'], 'A')).toEqual([]);
    expect(toggledFavorite(['A'], 'B')).toEqual(['A', 'B']);
  });
  it('VST : une ligne par plugin (variantes regroupées), rangés par éditeur, sans instruments ni ARA', () => {
    const P = (name: string, vendor: string, extra: any = {}) => ({ id: name, name, vendor, category: 'Effect', path: `C:/VST3/${name}.vst3`, uid: '', ...extra });
    const e = vstMenuEntries([
      P('C6 Stereo', 'Waves', { shell: 'WaveShell', pluginName: 'C6 Stereo' }), P('C6 Mono', 'Waves', { shell: 'WaveShell', pluginName: 'C6 Mono' }),
      P('Pro-Q 3', 'FabFilter'), P('Serum', 'Xfer', { category: 'Instrument' }), P('Melodyne', 'Celemony'),
    ] as any);
    expect(e.map(x => [x.name, x.cat])).toEqual([['C6', 'VST · Waves'], ['Pro-Q 3', 'VST · FabFilter']]);
    const groups = groupEffects([...list, ...e], '');
    expect(groups.map(g => g.cat).slice(-2)).toEqual(['VST · FabFilter', 'VST · Waves']);
    expect(groupEffects([...list, ...e], 'waves')[0].items[0].name).toBe('C6');
  });
});
