import { describe, expect, it } from 'vitest';
import { createMasterTransientCore } from '../engine/masterTransientCore';
import { createLimiterCore } from '../engine/limiterCore';
import { MASTER_TRANSIENT_PROFILE } from '../engine/masterTransientProfile';
import { MT_DEFAULTS, MT_PRESETS, mtToCore, sanitizeMt } from '../engine/masterTransientParams';

const SR = 48000;

function make(params: Record<string, number>) {
  const core = createMasterTransientCore(SR, MASTER_TRANSIENT_PROFILE as any, createLimiterCore);
  core.setParams(mtToCore({ ...MT_DEFAULTS, ...params }));
  return core;
}

/** Traite (2, n) en blocs de 128 et retire la latence. */
function run(core: ReturnType<typeof make>, L: Float32Array, R: Float32Array) {
  const lat = core.latencySamples();
  const n = L.length, tot = n + lat;
  const iL = new Float32Array(tot), iR = new Float32Array(tot), oL = new Float32Array(tot), oR = new Float32Array(tot);
  iL.set(L); iR.set(R);
  for (let i = 0; i < tot; i += 128) {
    const m = Math.min(128, tot - i);
    core.process(iL.subarray(i, i + m), iR.subarray(i, i + m), oL.subarray(i, i + m), oR.subarray(i, i + m), m);
  }
  return { L: oL.subarray(lat), R: oR.subarray(lat), lat };
}

function noise(n: number, amp: number, seed = 1) {
  let s = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = ((s / 4294967296) * 2 - 1) * amp; }
  return out;
}

const NEUTRAL = { emphasis: 0, adaptive: 0, limitGain: 0, clipDrive: 0 };

describe('Mastering Transient : banc de filtres auditifs', () => {
  it('reconstruit parfaitement à plat (tous gains égaux) : null < −100 dB après la latence', () => {
    const core = make(NEUTRAL);
    const L = noise(SR, 0.1, 3), R = noise(SR, 0.1, 7);
    const y = run(core, L, R);
    let e = 0, s = 0;
    for (let i = 0; i < SR; i++) { e += (y.L[i] - L[i]) ** 2 + (y.R[i] - R[i]) ** 2; s += L[i] ** 2 + R[i] ** 2; }
    expect(10 * Math.log10(e / s)).toBeLessThan(-100);
  });

  it('latence fixe quels que soient les réglages (PDC)', () => {
    const lats = [NEUTRAL, MT_PRESETS[0].params, { limiterOn: 0 }, { truePeak: 0 }].map(p => make(p).latencySamples());
    expect(new Set(lats).size).toBe(1);
    expect(lats[0]).toBeGreaterThan(512);
    expect(lats[0]).toBeLessThan(0.03 * SR);
  });
});

describe('Mastering Transient : emphase des attaques', () => {
  /** Gain (dB) d'un sinus 1 kHz qui démarre d'un coup, mesuré sur des fenêtres de 1 ms à partir de l'attaque. */
  function attackGain(params: Record<string, number>) {
    const n = Math.round(0.6 * SR), on = Math.round(0.1 * SR);
    const x = new Float32Array(n);
    for (let i = on; i < n; i++) x[i] = 0.1 * Math.sin(2 * Math.PI * 1000 * (i - on) / SR);
    const y = run(make(params), x, x).L;
    const g: number[] = [];
    for (let ms = 0; ms < 400; ms++) {
      let ex = 0, ey = 0;
      for (let i = on + ms * 48; i < on + (ms + 1) * 48; i++) { ex += x[i] * x[i]; ey += y[i] * y[i]; }
      g.push(10 * Math.log10(ey / ex));
    }
    return g;
  }

  it('emphase 100 % : pic ≈ +13,7 dB (mesuré sur l’original) puis retour à 0 dB', () => {
    const g = attackGain({ ...NEUTRAL, emphasis: 100 });
    const peak = Math.max(...g.slice(0, 20));
    expect(peak).toBeGreaterThan(12);
    expect(peak).toBeLessThan(15);
    expect(Math.abs(g[300])).toBeLessThan(0.2);
  });

  it("emphase 27 % (Romain) : pic ≈ +1,1 dB ; emphase 0 : aucun effet", () => {
    const g = attackGain({ ...NEUTRAL, emphasis: 27 });
    const peak = Math.max(...g.slice(0, 20));
    expect(peak).toBeGreaterThan(0.8);
    expect(peak).toBeLessThan(1.4);
    const g0 = attackGain({ ...NEUTRAL, emphasis: 0 });
    expect(Math.max(...g0.map(Math.abs))).toBeLessThan(0.01);
  });

  it('dosage par bande : la bande de 1,1 kHz à 0 % n’accentue presque plus un sinus à son centre', () => {
    const fc = MASTER_TRANSIENT_PROFILE.centers[7];
    const n = Math.round(0.5 * SR), on = Math.round(0.1 * SR);
    const x = new Float32Array(n);
    for (let i = on; i < n; i++) x[i] = 0.1 * Math.sin(2 * Math.PI * fc * (i - on) / SR);
    const gainAt = (bt8: number) => {
      const y = run(make({ ...NEUTRAL, emphasis: 100, bt8 }), x, x).L;
      let ex = 0, ey = 0;
      for (let i = on + 5 * 48; i < on + 15 * 48; i++) { ex += x[i] * x[i]; ey += y[i] * y[i]; }
      return 10 * Math.log10(ey / ex);
    };
    expect(gainAt(100)).toBeGreaterThan(10);
    // l’original : ≈ 1,6 dB ; NOVA ≈ 3,4 dB (débordement spectral de l’attaque sur les bandes voisines, détection plus grossière)
    expect(gainAt(0)).toBeLessThan(4);
    expect(gainAt(200)).toBeGreaterThan(gainAt(100) + 3);
  });
});

describe('Mastering Transient : limiteur', () => {
  it('préréglage « PRE MASTER Romain » : sortie sous le plafond −0,1 dBTP, plus forte que l’entrée', () => {
    const pr = MT_PRESETS.find(p => p.id === 'romain')!;
    const n = 2 * SR;
    const L = noise(n, 0.15, 11), R = noise(n, 0.15, 13);
    // salves fortes (attaques) sur le bruit
    for (let k = 0; k < 8; k++) for (let i = 0; i < 2000; i++) { L[k * 12000 + i] *= 5; R[k * 12000 + i] *= 5; }
    const y = run(make(pr.params), L, R);
    let pk = 0, rin = 0, rout = 0;
    for (let i = 0; i < n; i++) { pk = Math.max(pk, Math.abs(y.L[i]), Math.abs(y.R[i])); rin += L[i] * L[i]; rout += y.L[i] * y.L[i]; }
    expect(20 * Math.log10(pk)).toBeLessThanOrEqual(-0.1 + 1e-3);
    expect(10 * Math.log10(rout / rin)).toBeGreaterThan(1);
  });

  it('réglages assainis : bornes et bascules', () => {
    const s = sanitizeMt({ emphasis: 250, bt3: 500, bg2: -40, limiterOn: true, ceiling: 3, inconnu: 1 });
    expect(s).toEqual({ emphasis: 100, bt3: 200, bg2: -6, limiterOn: 1, ceiling: 0 });
  });
});
