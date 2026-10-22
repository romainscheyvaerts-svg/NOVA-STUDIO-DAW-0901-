import { describe, expect, it } from 'vitest';
import { computePdc, PdcNode, latencyPreroll, loopPrerollLatency } from '../utils/pdc';

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

describe('latencyPreroll (pré-roulement de latence, lecture = export)', () => {
  const SR = 44100;
  const lat = 1896 / SR;   // EQ à phase linéaire (≈ 43 ms)
  it('grosse caisse à 0 : le transport part la latence plus tôt, arrondie à l\'échantillon', () => {
    expect(latencyPreroll(lat, SR, [{ start: 0, duration: 0.5 }], 0) * SR).toBeCloseTo(1896, 9);
  });
  it('latence = nombre entier d\'échantillons : jamais un échantillon de trop', () => {
    const l = 2048 / 48000 + 1e-15;
    expect(Math.round(latencyPreroll(l, 48000, [{ start: 0, duration: 1 }], 0) * 48000)).toBe(2048);
  });
  it('lecture lancée au milieu : un son qui couvre le départ ou commence juste après', () => {
    expect(latencyPreroll(lat, SR, [{ start: 0, duration: 10 }], 5)).toBeGreaterThan(0);
    expect(latencyPreroll(lat, SR, [{ start: 5.02, duration: 1 }], 5)).toBeGreaterThan(0);
  });
  it('rien à couper : aucun pré-roulement', () => {
    expect(latencyPreroll(lat, SR, [{ start: 0.1, duration: 1 }], 0)).toBe(0);
    expect(latencyPreroll(lat, SR, [{ start: 0, duration: 1 }], 5)).toBe(0);
    expect(latencyPreroll(0, SR, [{ start: 0, duration: 1 }], 0)).toBe(0);
    expect(latencyPreroll(3, SR, [{ start: 0, duration: 1 }], 0)).toBe(0);
    expect(latencyPreroll(lat, SR, [{ start: 0, duration: 1 }], -1)).toBe(0);
  });
});

describe('loopPrerollLatency (retour de boucle avec un effet à latence)', () => {
  const lat = 1896 / 44100;
  it('piste à latence : le début de la boucle entre `lat` avant le retour', () => {
    expect(loopPrerollLatency(lat, 4, 8)).toBe(lat);
    expect(loopPrerollLatency(2, 0, 4)).toBe(2);
  });
  it('rien à pré-rouler : latence nulle, anormale (> 2 s) ou boucle plus courte que la latence', () => {
    expect(loopPrerollLatency(0, 4, 8)).toBe(0);
    expect(loopPrerollLatency(-0.01, 4, 8)).toBe(0);
    expect(loopPrerollLatency(2.5, 0, 10)).toBe(0);
    expect(loopPrerollLatency(lat, 4, 4 + lat)).toBe(0);
    expect(loopPrerollLatency(lat, 4, 4.02)).toBe(0);
  });
});
