/**
 * Égaliseur 12 bandes « pro » (écart 12, 22/10/2026) : preuves DSP du cœur engine/eqLinearCore.ts.
 *  - Mid / Side par bande : bande sur les côtés seulement → le centre ne bouge pas (< −100 dB),
 *    et inversement ; bande à gauche → la droite est intacte AU BIT PRÈS ; bandes neutres en
 *    Mid / Side → sortie = entrée au bit près ;
 *  - phase naturelle du cœur = courbes des filtres du navigateur (formules du Web Audio) ;
 *  - phase linéaire : réponse impulsionnelle symétrique (phase plate < 1°), latence EXACTE de D
 *    échantillons, module = celui de la phase naturelle (± 0,25 dB de 60 Hz à 18 kHz), chaîne
 *    neutre = retard pur au bit près, matrice complète (gauche + centre) = convolution directe ;
 *  - réglage tourné en phase linéaire : nouveau filtre calculé par étapes, sans NaN ni clic ;
 *  - repos et rattrapage (veille), latence annoncée = latence réelle.
 */
import { describe, it, expect } from 'vitest';
import { createEqProCore, eqLinearLatencySamples, eqProNeeded, type EqProBand } from '../engine/eqLinearCore';

const SR = 48000;
const db = (x: number) => 20 * Math.log10(Math.max(1e-30, x));

const NEUTRAL: EqProBand[] = [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000].map((f, i) => ({
  type: 'peaking', frequency: f, gain: 0, q: 1, isEnabled: true, isSolo: false, channel: 'stereo',
}));
const bands = (patch: Record<number, Partial<EqProBand>>) => NEUTRAL.map((b, i) => ({ ...b, ...(patch[i] || {}) }));

function run(core: ReturnType<typeof createEqProCore>, L: Float32Array, R: Float32Array, onBlock?: (blk: number) => void) {
  const n = L.length, oL = new Float32Array(n), oR = new Float32Array(n);
  for (let i = 0, blk = 0; i < n; i += 128, blk++) {
    onBlock?.(blk);
    const m = Math.min(128, n - i);
    core.process(L.subarray(i, i + m), R.subarray(i, i + m), oL.subarray(i, i + m), oR.subarray(i, i + m), m);
  }
  return [oL, oR];
}
function noise(n: number, seed: number, amp = 0.3) {
  let s = seed; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; x[i] = amp * (s / 0x7fffffff * 2 - 1); }
  return x;
}
const sine = (f: number, amp: number, n: number) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / SR); return x; };
const rms = (x: Float32Array | Float64Array, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
const maxAbs = (x: ArrayLike<number>, a = 0, b = x.length) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(x[i])); return m; };

/** Réponse (module, dB) d'un biquad du Web Audio — référence indépendante du cœur. */
function webAudioDb(type: string, f0: number, gain: number, Q: number, f: number, sr = SR) {
  const w0 = 2 * Math.PI * f0 / sr, cw = Math.cos(w0), sw = Math.sin(w0), A = Math.pow(10, gain / 40);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  if (type === 'peaking') { const al = sw / (2 * Q); b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
  else if (type === 'highshelf') { const al = sw / 2 * Math.SQRT2, sA = 2 * Math.sqrt(A) * al;
    b0 = A * ((A + 1) + (A - 1) * cw + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sA);
    a0 = (A + 1) - (A - 1) * cw + sA; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sA; }
  else if (type === 'highpass') { const al = sw / (2 * Math.pow(10, Q / 20)); b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  const w = 2 * Math.PI * f / sr;
  const nr = b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), ni = -(b1 * Math.sin(w) + b2 * Math.sin(2 * w));
  const dr = a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w), di = -(a1 * Math.sin(w) + a2 * Math.sin(2 * w));
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** DFT d'un signal réel aux fréquences données (module et phase). */
function dftAt(x: Float32Array | Float64Array, f: number, shift = 0) {
  let re = 0, im = 0;
  for (let n = 0; n < x.length; n++) { const a = -2 * Math.PI * f * (n - shift) / SR; re += x[n] * Math.cos(a); im += x[n] * Math.sin(a); }
  return { mag: Math.hypot(re, im), phaseDeg: Math.atan2(im, re) * 180 / Math.PI };
}

describe('EQ pro : choix du chemin et latence', () => {
  it('le chemin classique reste celui des anciens projets (aucune bande hors stéréo, phase naturelle)', () => {
    expect(eqProNeeded({ bands: NEUTRAL })).toBe(false);
    expect(eqProNeeded({ bands: bands({}) as any, phase: 'minimum' })).toBe(false);
    expect(eqProNeeded({ bands: bands({ 3: { channel: 'side' } }) as any })).toBe(true);
    expect(eqProNeeded({ bands: NEUTRAL, phase: 'linear' })).toBe(true);
    expect(eqProNeeded(null)).toBe(false);
  });
  it('latence annoncée = latence du cœur (44,1 / 48 / 96 kHz, normale et haute)', () => {
    for (const sr of [44100, 48000, 96000]) for (const q of ['normale', 'haute']) {
      const c = createEqProCore(sr);
      c.setParams({ bands: NEUTRAL, phase: 'linear', linQuality: q });
      expect(c.latency()).toBe(eqLinearLatencySamples(sr, q));
    }
    expect(eqLinearLatencySamples(48000, 'normale')).toBe(2048);
    expect(eqLinearLatencySamples(96000, 'normale')).toBe(4096);
    expect(eqLinearLatencySamples(48000, 'haute')).toBe(8192);
    const m = createEqProCore(SR); m.setParams({ bands: NEUTRAL });
    expect(m.latency()).toBe(0);
  });
});

describe('EQ pro : Mid / Side par bande, phase naturelle', () => {
  const n = 48000;
  const L = noise(n, 3), R = noise(n, 11);

  it('bandes neutres réglées en centre / côtés / gauche : sortie = entrée au bit près', () => {
    const c = createEqProCore(SR);
    c.setParams({ bands: bands({ 2: { channel: 'mid' }, 5: { channel: 'side' }, 8: { channel: 'left' }, 11: { type: 'peaking', channel: 'right' } }) });
    const [oL, oR] = run(c, L, R);
    expect(Array.from(oL)).toEqual(Array.from(L));
    expect(Array.from(oR)).toEqual(Array.from(R));
  });

  it('bande sur les côtés seulement : le centre reste identique (< −100 dB), les côtés changent', () => {
    const c = createEqProCore(SR);
    c.setParams({ bands: bands({ 4: { channel: 'side', gain: 9, frequency: 2000, q: 0.7 }, 0: { type: 'highpass', frequency: 200, channel: 'side' } }) });
    const [oL, oR] = run(c, L, R);
    let dM = 0, dS = 0;
    for (let i = 0; i < n; i++) {
      dM = Math.max(dM, Math.abs((oL[i] + oR[i]) / 2 - (L[i] + R[i]) / 2));
      dS = Math.max(dS, Math.abs((oL[i] - oR[i]) / 2 - (L[i] - R[i]) / 2));
    }
    expect(db(dM)).toBeLessThan(-100);
    expect(db(dS)).toBeGreaterThan(-20);
  });

  it('bande sur le centre seulement : les côtés restent identiques (< −100 dB)', () => {
    const c = createEqProCore(SR);
    c.setParams({ bands: bands({ 6: { channel: 'mid', gain: -12, frequency: 4000, q: 2 } }) });
    const [oL, oR] = run(c, L, R);
    let dS = 0, dM = 0;
    for (let i = 0; i < n; i++) {
      dS = Math.max(dS, Math.abs((oL[i] - oR[i]) / 2 - (L[i] - R[i]) / 2));
      dM = Math.max(dM, Math.abs((oL[i] + oR[i]) / 2 - (L[i] + R[i]) / 2));
    }
    expect(db(dS)).toBeLessThan(-100);
    expect(db(dM)).toBeGreaterThan(-30);
  });

  it('bande à gauche : la droite est intacte au bit près', () => {
    const c = createEqProCore(SR);
    c.setParams({ bands: bands({ 3: { channel: 'left', gain: 6, frequency: 500 } }) });
    const [oL, oR] = run(c, L, R);
    expect(Array.from(oR)).toEqual(Array.from(R));
    expect(maxAbs(oL.map((v, i) => v - L[i]))).toBeGreaterThan(0.01);
  });

  it('module = courbe des filtres du navigateur (cloche, étagère aiguë, coupe-bas)', () => {
    const cases: [string, number, number, number, number][] = [['peaking', 1000, 6, 1.4, 1000], ['peaking', 1000, 6, 1.4, 1500], ['highshelf', 6000, -5, 1, 12000], ['highpass', 120, 0, 3, 90]];
    for (const [type, f0, g, q, f] of cases) {
      const c = createEqProCore(SR);
      c.setParams({ bands: bands({ 4: { type, frequency: f0, gain: g, q, channel: 'left' } }) });
      const x = sine(f, 0.25, 24000);
      const [oL] = run(c, x, x);
      const meas = db(rms(oL, 12000) / rms(x, 12000));
      expect(Math.abs(meas - webAudioDb(type, f0, g, q, f))).toBeLessThan(0.05);
    }
  });

  it('réglages tournés pendant le son : aucun NaN, aucun saut (fondus et glissements)', () => {
    const c = createEqProCore(SR);
    c.setParams({ bands: bands({ 4: { channel: 'mid', gain: 6 } }) });
    const x = sine(440, 0.3, 48000);
    const [oL] = run(c, x, x, blk => {
      if (blk === 40) c.setParams({ bands: bands({ 4: { channel: 'side', gain: 6 } }) });
      if (blk === 80) c.setParams({ bands: bands({ 4: { channel: 'mid', type: 'notch', frequency: 440, q: 4 } }) });
      if (blk === 120) c.setAuto(4 * 3 + 0, 2000);
      if (blk === 200) c.setParams({ bands: bands({ 4: { channel: 'mid', gain: 6, isEnabled: false } }) });
    });
    let jump = 0;
    for (let i = 1; i < oL.length; i++) { expect(Number.isFinite(oL[i])).toBe(true); jump = Math.max(jump, Math.abs(oL[i] - oL[i - 1])); }
    // Pente max d'un sinus 440 Hz à 0,3 (×2 de marge pour le gain) : 2π·440/48000·0,3·2 ≈ 0,035.
    expect(jump).toBeLessThan(0.06);
  });

  it('repos après le silence, rattrapage (veille) sans effet', () => {
    const c = createEqProCore(SR);
    c.setParams({ bands: bands({ 4: { channel: 'side', gain: 6 }, 0: { type: 'highpass', frequency: 40, channel: 'mid' } }) });
    run(c, noise(4800, 5), noise(4800, 6));
    expect(c.atRest()).toBe(false);
    const z = new Float32Array(48000 * 3);
    run(c, z, z);
    expect(c.atRest()).toBe(true);
    c.catchUp(48000);
    expect(c.atRest()).toBe(true);
  });
});

describe('EQ pro : phase linéaire', () => {
  const D = eqLinearLatencySamples(SR, 'normale');

  function impulseResponse(c: ReturnType<typeof createEqProCore>, len = 3 * D, chan: 'L' | 'R' | 'both' = 'both') {
    const L = new Float32Array(len), R = new Float32Array(len);
    if (chan !== 'R') L[0] = 1;
    if (chan !== 'L') R[0] = 1;
    return run(c, L, R);
  }

  it('chaîne neutre : retard pur de D échantillons, au bit près', () => {
    const c = createEqProCore(SR);
    c.setParams({ bands: NEUTRAL, phase: 'linear' });
    expect(c.linearInfo().mode).toBe('retard');
    const L = noise(20000, 21), R = noise(20000, 22);
    const [oL, oR] = run(c, L, R);
    for (let i = 0; i < D; i++) { expect(oL[i]).toBe(0); expect(oR[i]).toBe(0); }
    for (let i = D; i < L.length; i++) { if (oL[i] !== L[i - D] || oR[i] !== R[i - D]) throw new Error(`écart à ${i}`); }
  });

  it('cloche +6 dB : réponse symétrique autour de D (phase plate < 1°), latence exacte, module = phase naturelle ± 0,25 dB', () => {
    const c = createEqProCore(SR);
    c.setParams({ bands: bands({ 4: { gain: 6, frequency: 1000, q: 1 }, 9: { type: 'highshelf', frequency: 8000, gain: -4 } }), phase: 'linear' });
    expect(c.latency()).toBe(D);
    const [h] = impulseResponse(c);
    // Pic exactement à D, symétrie au bit près à l'arrondi 32 bits près.
    let pk = 0; for (let i = 0; i < h.length; i++) if (Math.abs(h[i]) > Math.abs(h[pk])) pk = i;
    expect(pk).toBe(D);
    let asym = 0; for (let k = 1; k <= D; k++) asym = Math.max(asym, Math.abs(h[D + k] - h[D - k]));
    expect(asym).toBeLessThan(1e-7);
    // Rien avant 0 ni après 2D (RIF de 2D + 1 points).
    expect(maxAbs(h, 2 * D + 1)).toBeLessThan(1e-9);
    let worstPh = 0, worstMag = 0;
    for (const f of [60, 100, 250, 700, 1000, 1500, 3000, 6000, 8000, 12000, 18000]) {
      const r = dftAt(h, f, D);
      const ph = Math.abs(r.phaseDeg) > 90 ? 180 - Math.abs(r.phaseDeg) : Math.abs(r.phaseDeg);
      worstPh = Math.max(worstPh, ph);
      const ref = webAudioDb('peaking', 1000, 6, 1, f) + webAudioDb('highshelf', 8000, -4, 1, f);
      worstMag = Math.max(worstMag, Math.abs(db(r.mag) - ref));
    }
    expect(worstPh).toBeLessThan(1);
    expect(worstMag).toBeLessThan(0.25);
  });

  it('bande sur les côtés : le centre ressort intact, retardé de D (< −100 dB)', () => {
    const c = createEqProCore(SR);
    c.setParams({ bands: bands({ 7: { channel: 'side', gain: 8, frequency: 6000, q: 0.7 } }), phase: 'linear' });
    expect(c.linearInfo().mode).toBe('complet');
    const L = noise(24000, 31), R = noise(24000, 37);
    const [oL, oR] = run(c, L, R);
    let dM = 0, dS = 0;
    for (let i = D; i < L.length; i++) {
      dM = Math.max(dM, Math.abs((oL[i] + oR[i]) / 2 - (L[i - D] + R[i - D]) / 2));
      dS = Math.max(dS, Math.abs((oL[i] - oR[i]) / 2 - (L[i - D] - R[i - D]) / 2));
    }
    expect(db(dM)).toBeLessThan(-100);
    expect(db(dS)).toBeGreaterThan(-30);
  });

  it('matrice complète (gauche + centre) = convolution directe par ses 4 filtres', () => {
    const c = createEqProCore(SR);
    c.setParams({ bands: bands({ 2: { channel: 'left', gain: 5, frequency: 300 }, 6: { channel: 'mid', gain: -6, frequency: 4000, q: 2 } }), phase: 'linear' });
    const info = c.linearInfo();
    expect(info.mode).toBe('complet');
    const [hLL, hRL, hLR, hRR] = info.taps.map(t => (t ? Float64Array.from(t) : null));
    const n = 9000, L = noise(n, 41), R = noise(n, 43);
    const [oL, oR] = run(c, L, R);
    let err = 0;
    for (const i of [D, D + 17, 5000, 8999]) {
      let yl = 0, yr = 0;
      for (let k = 0; k <= 2 * D && k <= i; k++) {
        yl += (hLL ? hLL[k] * L[i - k] : 0) + (hRL ? hRL[k] * R[i - k] : 0);
        yr += (hLR ? hLR[k] * L[i - k] : 0) + (hRR ? hRR[k] * R[i - k] : 0);
      }
      err = Math.max(err, Math.abs(yl - oL[i]), Math.abs(yr - oR[i]));
    }
    expect(err).toBeLessThan(2e-6);
  });

  it('réglage tourné : calcul par étapes (jamais tout dans un bloc), fondu sans NaN ni saut', () => {
    const c = createEqProCore(SR);
    c.setParams({ bands: bands({ 4: { gain: 3 } }), phase: 'linear' });
    const x = sine(1000, 0.3, 48000);
    let readyAt = -1;
    const [oL] = run(c, x, x, blk => {
      if (blk === 60) c.setAuto(4 * 3 + 1, -9);
      if (blk > 60 && readyAt < 0 && !c.linearInfo().pending) readyAt = blk;
    });
    expect(readyAt).toBeGreaterThan(61);       // plusieurs blocs : budget fixe par bloc
    expect(readyAt).toBeLessThan(60 + 40);     // mais en moins de ~100 ms
    let jump = 0;
    for (let i = 1; i < oL.length; i++) { expect(Number.isFinite(oL[i])).toBe(true); jump = Math.max(jump, Math.abs(oL[i] - oL[i - 1])); }
    expect(jump).toBeLessThan(0.06);
    // Après le fondu : niveau du 1 kHz = −9 dB (cloche) à ± 0,3 dB.
    const tail = rms(oL, 40000, 48000) / rms(x, 40000, 48000);
    expect(Math.abs(db(tail) - webAudioDb('peaking', 1000, -9, 1, 1000))).toBeLessThan(0.3);
  });

  it('bascule phase naturelle → linéaire : la latence suit, fondu sans NaN', () => {
    const c = createEqProCore(SR);
    c.setParams({ bands: bands({ 4: { gain: 4, channel: 'mid' } }) });
    expect(c.latency()).toBe(0);
    const x = sine(300, 0.2, 48000);
    const [oL] = run(c, x, x, blk => { if (blk === 30) c.setParams({ bands: bands({ 4: { gain: 4, channel: 'mid' } }), phase: 'linear' }); });
    expect(c.latency()).toBe(D);
    for (let i = 0; i < oL.length; i++) expect(Number.isFinite(oL[i])).toBe(true);
    expect(rms(oL, 40000)).toBeGreaterThan(0.1);
  });

  it('reset = instance neuve (départ de lecture identique à l’export)', () => {
    const p = { bands: bands({ 3: { gain: 5, channel: 'side' }, 8: { gain: -3 } }), phase: 'linear' as const };
    const a = createEqProCore(SR); a.setParams(p);
    run(a, noise(6000, 1), noise(6000, 2));
    a.reset();
    const b = createEqProCore(SR); b.setParams(p);
    const L = noise(9000, 7), R = noise(9000, 8);
    const [aL, aR] = run(a, L, R), [bL, bR] = run(b, L, R);
    expect(Array.from(aL)).toEqual(Array.from(bL));
    expect(Array.from(aR)).toEqual(Array.from(bR));
  });

  it('repos après le silence (veille) et sortie nulle', () => {
    const c = createEqProCore(SR);
    c.setParams({ bands: bands({ 4: { gain: 6 } }), phase: 'linear' });
    run(c, noise(4096, 3), noise(4096, 4));
    expect(c.atRest()).toBe(false);
    const z = new Float32Array(D * 3 + 2048);
    const [oL] = run(c, z, z);
    expect(c.atRest()).toBe(true);
    expect(maxAbs(oL, oL.length - 512)).toBe(0);
  });
});
