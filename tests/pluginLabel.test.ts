import { describe, expect, it } from 'vitest';
import { pluginDisplayName, pluginDetail, shortKey } from '../utils/pluginLabel';

describe('noms lisibles des effets', () => {
  it("l'autotune du PC s'affiche sous son vrai nom", () => {
    expect(pluginDisplayName({ type: 'AUTOTUNE', name: 'AutoTune' } as any, { engine: 'vst', pluginName: 'Auto-Tune Pro', keyText: 'F# mineur' })).toBe('Auto-Tune Pro');
    expect(pluginDetail({ type: 'AUTOTUNE' } as any, { engine: 'vst', pluginName: 'Auto-Tune Pro', keyText: 'F# mineur' })).toBe('F# mineur');
  });
  it("sans pont : l'autotune de NOVA", () => {
    expect(pluginDisplayName({ type: 'AUTOTUNE', name: 'AutoTune' } as any, null)).toBe('Autotune');
  });
  it('un VST garde son nom complet (plus de « PRO- » sur 4 lettres)', () => {
    expect(pluginDisplayName({ type: 'VST3', name: 'Pro-C 3' } as any)).toBe('Pro-C 3');
    expect(pluginDisplayName({ type: 'VST3', name: '  ' } as any)).toBe('Plugin VST');
  });
  it('effets de NOVA en français (plus de « COMPRESSOR »)', () => {
    expect(pluginDisplayName({ type: 'COMPRESSOR', name: 'COMPRESSOR' } as any)).toBe('Compresseur');
    expect(pluginDisplayName({ type: 'DENOISER', name: '' } as any)).toBe('Anti-bruit');
  });
  it('tonalité courte pour les pastilles', () => {
    expect(shortKey('F# mineur')).toBe('F#m');
    expect(shortKey('Do majeur')).toBe('Do');
  });
});
