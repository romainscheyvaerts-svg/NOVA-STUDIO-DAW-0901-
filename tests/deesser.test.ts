import { describe, expect, it } from 'vitest';
import { createDeesserCore, type DeesserCoreParams } from '../engine/deesserCore';
import { DEESSER_DEFAULTS, deesserResponseDb, deesserMaxRangeDb } from '../plugins/DeEsserPlugin';
import { defaultBuiltinParams } from '../utils/sessionTemplate';
import { VOCAL_MIX_STYLES } from '../utils/vocalPresets';

const SR = 48000;

function sine(f: number, db: number, n: number, phase = 0) {
  const a = Math.pow(10, db / 20);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = a * Math.sin(2 * Math.PI * f * i / SR + phase);
  return x;
}
function add(...xs: Float32Array[]) {
  const y = new Float32Array(xs[0].length);
  for (const x of xs) for (let i = 0; i < y.length; i++) y[i] += x[i];
  return y;
}
/** Bruit « corps de voix » sans aigus : somme de partiels entre 100 Hz et 2 kHz. */
function bodyNoise(db: number, n: number) {
  let y = new Float32Array(n);
  let seed = 7;
  for (let k = 0; k < 24; k++) {
    seed = (seed * 16807) % 2147483647;
    const f = 100 + (k * 79) % 1900;
    y = add(y, sine(f, db - 14, n, (seed / 2147483647) * 6.28));
  }
  return y;
}
function run(p: DeesserCoreParams, inL: Float32Array, inR: Float32Array | null = null) {
  const c = createDeesserCore(SR);
  c.setParams(p);
  const n = inL.length;
  const outL = new Float32Array(n), outR = new Float32Array(n);
  let grMax = 0, grEnd = 0;
  for (let i = 0; i < n; i += 128) {
    const m = Math.min(128, n - i);
    c.process(inL.subarray(i, i + m), inR ? inR.subarray(i, i + m) : null, outL.subarray(i, i + m), outR.subarray(i, i + m), m);
    const mt = c.takeMeters();
    grMax = Math.max(grMax, mt.grDb);
    grEnd = mt.grNowDb;
  }
  return { outL, outR, grMax, grEnd };
}
/** Amplitude du sinus de fréquence f sur la seconde moitié (projection). */
function ampAt(y: Float32Array, f: number) {
  let c = 0, s = 0;
  const n0 = Math.floor(y.length / 2);
  for (let i = n0; i < y.length; i++) { c += y[i] * Math.cos(2 * Math.PI * f * i / SR); s += y[i] * Math.sin(2 * Math.PI * f * i / SR); }
  const m = y.length - n0;
  return 2 * Math.hypot(c, s) / m;
}
const db = (x: number) => 20 * Math.log10(x);

describe('De-esser NOVA (cœur engine/deesserCore.ts)', () => {
  it('8 kHz et détection relative par défaut (nouvelles instances, modèles, presets voix)', () => {
    expect(DEESSER_DEFAULTS.frequency).toBe(8000);
    expect(DEESSER_DEFAULTS.detection).toBe('RELATIVE');
    expect(defaultBuiltinParams('DEESSER').frequency).toBe(8000);
    const presetDs = VOCAL_MIX_STYLES.flatMap(s => s.chain).filter(c => c.type === 'DEESSER');
    expect(presetDs.length).toBeGreaterThan(0);
    // tous à 8 kHz sauf la voix « téléphone », filtrée 500 Hz-3,5 kHz (de-esser dans sa bande utile)
    expect(presetDs.filter(c => c.params.frequency !== 8000).every(c => c.params.frequency === 3200)).toBe(true);
  });

  it('reconstruction exacte quand il ne travaille pas (réduction 0, coupé, voix sans « s »)', () => {
    const x = add(bodyNoise(-12, 24000), sine(8000, -20, 24000));
    for (const p of [{ reduction: 0 }, { isEnabled: false }]) {
      const { outL } = run({ ...DEESSER_DEFAULTS, ...p } as any, x);
      let e = 0;
      for (let i = 0; i < x.length; i++) e = Math.max(e, Math.abs(outL[i] - x[i]));
      expect(e).toBeLessThan(1e-7);
    }
    // voix sans aigus : il ne déclenche pas, sortie identique après le démarrage des filtres
    const v = bodyNoise(-10, 48000);
    const { outL, grEnd } = run({ ...DEESSER_DEFAULTS } as any, v);
    let e2 = 0;
    for (let i = 2400; i < v.length; i++) e2 = Math.max(e2, Math.abs(outL[i] - v[i]));
    expect(e2).toBeLessThan(1e-4);
    expect(grEnd).toBeLessThan(0.01);
  });

  it('réduction ciblée : la bande des « s » baisse, le grave ne bouge pas', () => {
    const n = 48000;
    // « s » : la bande domine le reste de la voix de 12 dB -> réduction maximale (12,4 dB à 60 %)
    const lo = sine(200, -20, n), hi = sine(8000, -8, n);
    const { outL, grEnd } = run({ ...DEESSER_DEFAULTS } as any, add(lo, hi));
    expect(grEnd).toBeGreaterThan(12);
    expect(Math.abs(db(ampAt(outL, 200) / ampAt(lo, 200)))).toBeLessThan(0.05);
    expect(db(ampAt(outL, 8000) / ampAt(hi, 8000))).toBeLessThan(-12);
    // voyelle claire : aigus 14 dB sous le reste -> il ne touche à rien
    const v = run({ ...DEESSER_DEFAULTS } as any, add(sine(200, -10, n), sine(8000, -24, n)));
    expect(v.grEnd).toBeLessThan(0.01);
  });

  it('rien hors bande : un son fort à 1 kHz, 2 kHz ou 200 Hz garde son niveau', () => {
    for (const f of [200, 1000, 2000]) {
      const x = sine(f, -6, 24000);
      const { outL } = run({ ...DEESSER_DEFAULTS } as any, x);
      expect(Math.abs(db(ampAt(outL, f) / ampAt(x, f)))).toBeLessThan(0.1);
    }
  });

  it('détection relative indépendante du niveau d’enregistrement', () => {
    const n = 48000;
    const r: number[] = [];
    for (const g of [-30, -10]) {
      const { outL } = run({ ...DEESSER_DEFAULTS } as any, add(sine(300, g, n), sine(8000, g - 4, n)));
      r.push(db(ampAt(outL, 8000) / Math.pow(10, (g - 4) / 20)));
    }
    expect(Math.abs(r[0] - r[1])).toBeLessThan(0.2);
  });

  it('écoute de la bande et de ce qui est retiré', () => {
    const n = 48000;
    const lo = sine(200, -10, n), hi = sine(8000, -14, n);
    const band = run({ ...DEESSER_DEFAULTS, listen: 1 } as any, add(lo, hi)).outL;
    expect(db(ampAt(band, 200) / ampAt(lo, 200))).toBeLessThan(-25);
    expect(Math.abs(db(ampAt(band, 8000) / ampAt(hi, 8000)))).toBeLessThan(0.2);
    const removed = run({ ...DEESSER_DEFAULTS, listen: 2 } as any, add(lo, hi)).outL;
    const normal = run({ ...DEESSER_DEFAULTS } as any, add(lo, hi)).outL;
    // normal + retiré = entrée
    const x = add(lo, hi);
    let e = 0;
    for (let i = 0; i < n; i++) e = Math.max(e, Math.abs(normal[i] + removed[i] - x[i]));
    expect(e).toBeLessThan(1e-6);
  });

  it('mode absolu (anciens projets) : seuil fixe, courbe de l’ancien de-esser', () => {
    const p = { detection: 'ABSOLUTE', threshold: -35, frequency: 8000, q: 1, reduction: 0.6, mode: 'BELL' };
    const quiet = run(p, sine(8000, -50, 24000)).outL;
    expect(Math.abs(db(ampAt(quiet, 8000) / Math.pow(10, -50 / 20)))).toBeLessThan(0.05);
    const loud = run(p, sine(8000, -20, 24000)).outL;
    const g = db(ampAt(loud, 8000) / Math.pow(10, -20 / 20));
    expect(g).toBeLessThan(-7);
    expect(g).toBeGreaterThan(-11);
  });

  it('stéréo couplée et réduction affichée = réduction appliquée au centre de la bande', () => {
    const n = 48000;
    const L = add(sine(300, -10, n), sine(8000, -6, n));
    const R = sine(300, -10, n);
    const { outL, outR, grEnd } = run({ ...DEESSER_DEFAULTS } as any, L, R);
    const gL = db(ampAt(outL, 8000) / Math.pow(10, -6 / 20));
    expect(grEnd).toBeGreaterThan(4);
    expect(Math.abs(-gL - grEnd)).toBeLessThan(0.3);
    expect(Math.abs(db(ampAt(outR, 300) / Math.pow(10, -10 / 20)))).toBeLessThan(0.05);
    expect(deesserResponseDb(8000, DEESSER_DEFAULTS, 6)).toBeCloseTo(-6, 1);
    expect(deesserResponseDb(500, DEESSER_DEFAULTS, 6)).toBeGreaterThan(-0.1);
    expect(deesserMaxRangeDb(0.6)).toBeCloseTo(12.4, 5);
  });
});
