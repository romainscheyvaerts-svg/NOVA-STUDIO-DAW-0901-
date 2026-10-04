import { describe, expect, it } from 'vitest';
import { computePdc, PdcNode } from '../utils/pdc';

const net = (o: Record<string, [number, string[]]>) => new Map<string, PdcNode>(Object.entries(o).map(([k, [latency, outputs]]) => [k, { latency, outputs }]));

describe('compensation de latence (PDC)', () => {
  it('voix → bus voix (30 ms) + envoi reverb (50 ms) : la reverb arrive avec la voix sèche', () => {
    const r = computePdc(net({ voix: [0.01, ['busvoix', 'verb']], busvoix: [0.03, ['master']], verb: [0.05, ['master']], beat: [0, ['master']], master: [0, []] }));
    expect(r.get('voix')!.total).toBeCloseTo(0.06, 6);        // 10 ms + max(30, 50)
    expect(r.get('voix')!.delays.get('busvoix')).toBeCloseTo(0.02, 6);
    expect(r.get('voix')!.delays.get('verb')).toBeCloseTo(0, 6);
    // Arrivée au master de chaque chemin, la voix partant `total` plus tôt : 0 pour tous.
    const v = r.get('voix')!;
    expect(-v.total + 0.01 + v.delays.get('busvoix')! + r.get('busvoix')!.total).toBeCloseTo(0, 6);
    expect(-v.total + 0.01 + v.delays.get('verb')! + r.get('verb')!.total).toBeCloseTo(0, 6);
    expect(r.get('beat')!.total).toBe(0);
  });
  it('sortie vers le master du moteur ("") : pas de retard inventé', () => {
    const r = computePdc(net({ a: [0.02, ['']] }));
    expect(r.get('a')!.total).toBeCloseTo(0.02, 6);
    expect(r.get('a')!.down).toBe(0);
  });
  it('bus en chaîne : piste → bus A (10 ms) → bus B (40 ms)', () => {
    const r = computePdc(net({ p: [0, ['A']], A: [0.01, ['B']], B: [0.04, ['']] }));
    expect(r.get('p')!.total).toBeCloseTo(0.05, 6);
    expect(r.get('A')!.total).toBeCloseTo(0.05, 6);
  });
  it('boucle de routage : pas de récursion infinie', () => {
    const r = computePdc(net({ a: [0.01, ['b']], b: [0.02, ['a']] }));
    expect(Number.isFinite(r.get('a')!.total)).toBe(true);
  });
  it('latence aberrante plafonnée, valeurs négatives ignorées', () => {
    const r = computePdc(net({ a: [99, ['']], b: [-1, ['']] }));
    expect(r.get('a')!.total).toBe(4);
    expect(r.get('b')!.total).toBe(0);
  });
});
