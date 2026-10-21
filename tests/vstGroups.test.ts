import { describe, expect, it } from 'vitest';
import type { BridgePlugin } from '../services/NovaBridge';
import { groupVstPlugins, variantLabel, vstFamily } from '../utils/vstGroups';

const shell = 'WaveShell1-VST3 17.1_x64';
const w = (name: string, extra: Partial<BridgePlugin> = {}): BridgePlugin =>
  ({ id: `path:x#${name}`, name, vendor: 'Waves', category: 'Effect', path: 'x', uid: '', shell, ...extra } as BridgePlugin);

describe('onglet VST : une ligne par plugin', () => {
  it('retire le format de canaux du nom', () => {
    expect(vstFamily('C6 Stereo')).toBe('C6');
    expect(vstFamily('RVerb Mono/Stereo')).toBe('RVerb');
    expect(vstFamily('H-Reverb Mono/5.1')).toBe('H-Reverb');
    expect(vstFamily('B360 5.0/Quad')).toBe('B360');
    expect(vstFamily('Abbey Road Reel ADT Live Mono')).toBe('Abbey Road Reel ADT Live');
    expect(vstFamily('L3-16')).toBe('L3-16');
  });

  it('regroupe les variantes Waves, stéréo d’abord, et garde les autres plugins tels quels', () => {
    const rows = groupVstPlugins([
      w('C6 Mono'), w('C6 Stereo'), w('C6 Mono', { id: 'autre-shell#C6 Mono', shell: 'WaveShell1-VST3 16.7_x64' }),
      w('RVerb Mono/Stereo'), w('RVerb Mono'), w('RVerb Stereo'),
      w('Grand Rhapsody Piano Stereo', { category: 'Instrument' }),
      { id: 'p1', name: 'Auto-Tune Pro', vendor: 'Antares', category: 'Effect', path: 'a', uid: '' } as BridgePlugin,
    ]);
    expect(rows.map(r => r.name)).toEqual(['C6', 'RVerb', 'Grand Rhapsody Piano', 'Auto-Tune Pro']);
    expect(rows[0].main.name).toBe('C6 Stereo');
    expect(rows[0].variants.map(v => v.name)).toEqual(['C6 Stereo', 'C6 Mono', 'C6 Mono']);
    expect(rows[1].variants.map(v => variantLabel(v, 'RVerb'))).toEqual(['Stéréo', 'Mono → stéréo', 'Mono']);
    expect(rows[2].variants).toEqual([]);
    expect(rows[2].main.name).toBe('Grand Rhapsody Piano Stereo');
    expect(rows[3].variants).toEqual([]);
  });

  it('libellé des autres formats', () => {
    expect(variantLabel(w('H-Reverb Mono/5.1'), 'H-Reverb')).toBe('Mono/5.1');
    expect(variantLabel(w('B360 5.0/Quad'), 'B360')).toBe('5.0/Quad');
  });
});
