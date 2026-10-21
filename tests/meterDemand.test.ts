import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeterDemand } from '../engine/meterDemand';

describe('MeterDemand (mesures des effets envoyées seulement si on les lit)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it('demande la mesure à la 1re lecture, une seule fois, et la coupe après le délai sans lecture', () => {
    const sent: boolean[] = [];
    const d = new MeterDemand(on => sent.push(on), 1500);
    expect(d.active).toBe(false);
    d.read(1000);
    d.read(1100);
    d.read(2000);
    expect(sent).toEqual([true]);
    expect(d.check(3000)).toBe(true);    // lu il y a 1 s : encore demandée
    expect(sent).toEqual([true]);
    expect(d.check(3600)).toBe(false);   // 1,6 s sans lecture : coupée
    expect(sent).toEqual([true, false]);
    expect(d.active).toBe(false);
    d.read(4000);                        // relue : redemandée
    expect(sent).toEqual([true, false, true]);
  });
});
