/**
 * Compresseur multibande et EQ dynamique (engine/mixfx) : preuves DSP sur les cœurs, sous Node.
 *  - multibande : somme plate (impulsion et bruit rose, ≤ 0,1 dB) en 3 et 4 bandes ;
 *    réduction mesurée = loi seuil / taux sur un sinus dans une bande, rien dans les autres ;
 *  - EQ dynamique : sous le seuil, sortie identique à l'entrée au bit près ; au-dessus,
 *    atténuation = min(dépassement, |plage|), jamais plus que la plage ; renfort ; écoute ;
 *  - pas de NaN, pas de clic quand on tourne un réglage, veille (catchUp) exacte ;
 *  - registre, menu, automation, valeurs par défaut neutres, préréglages sourcés.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createMultibandCore } from '../engine/mixfx/multibandCore';
import { createDynEqCore } from '../engine/mixfx/dynEqCore';
import { MB_DEFAULTS, DYN_DEFAULTS, MB_PRESETS, DYN_PRESETS, MB_SPECS, DYN_SPECS, sanitizeMixFx, mixFxAutomatable, mixFxParamLabel } from '../engine/mixfx/mixFxParams';
import { getRegisteredPlugin, registryBrowserItems, registryMenuItems } from '../engine/pluginRegistry';
import { groupEffects } from '../components/AddEffectMenu';
import { SLEEP_SAFE } from '../engine/effectSleep';

const SR = 48000;
const db = (x: number) => 20 * Math.log10(x);

type Core = { process: (a: Float32Array, b: Float32Array | null, c: Float32Array, d: Float32Array | null, n: number) => void };
/** Passe un signal stéréo dans un cœur, par blocs de 128 ; `onBlock` peut changer un réglage avant un bloc. */
function run(core: Core, L: Float32Array, R: Float32Array = L, onBlock?: (blk: number) => void) {
  const n = L.length, oL = new Float32Array(n), oR = new Float32Array(n);
  for (let i = 0, blk = 0; i < n; i += 128, blk++) {
    onBlock?.(blk);
    const m = Math.min(128, n - i);
    core.process(L.subarray(i, i + m), R.subarray(i, i + m), oL.subarray(i, i + m), oR.subarray(i, i + m), m);
  }
  return [oL, oR];
}
const sine = (f: number, amp: number, sec: number) => { const n = Math.round(sec * SR), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / SR); return x; };
const rms = (x: Float32Array, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
function pink(n: number, seed = 1) {
  // Bruit rose (filtre de Paul Kellet) à graine fixe.
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; };
  const x = new Float32Array(n); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd();
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    x[i] = 0.06 * (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362); b6 = w * 0.115926;
  }
  return x;
}
function fftMag2(x: Float32Array): Float64Array {
  const n = x.length, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0, j = 0; i < n; i++) { re[j] = x[i]; let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  const m = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) m[k] = re[k] * re[k] + im[k] * im[k];
  return m;
}
/** Plus grande dérivée (|y[n] − y[n−1]|) d'un signal. */
const maxStep = (x: Float32Array, a = 1, b = x.length) => { let m = 0; for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1])); return m; };
/**
 * Détecteur de clic : plus grande dérivée seconde |y[n] − 2y[n−1] + y[n−2]|, rapportée à celle d'un
 * sinus pur de même fréquence (A·ω², ω = 2πf/SR) et d'amplitude égale à la crête locale (±64 éch.).
 * Un sinus dont le gain glisse reste à ~1 ; une marche de gain de 1 dB sur ce sinus donne ≈ 0,12/ω² ≈ 7.
 */
function clickRatio(y: Float32Array, f: number, from = Math.round(0.05 * SR)) {
  // Les 50 premières ms (mise en route des filtres sur un sinus qui démarre d'un coup) ne comptent pas.
  const w2 = (2 * Math.PI * f / SR) ** 2;
  let worst = 0;
  for (let i = Math.max(2, from); i < y.length; i++) {
    let pk = 0;
    for (let j = Math.max(0, i - 64); j < Math.min(y.length, i + 64); j++) pk = Math.max(pk, Math.abs(y[j]));
    if (pk < 1e-3) continue;
    worst = Math.max(worst, Math.abs(y[i] - 2 * y[i - 1] + y[i - 2]) / (pk * w2));
  }
  return worst;
}
const finite = (x: Float32Array) => x.every(v => Number.isFinite(v));

describe('Compresseur multibande : somme plate (Linkwitz-Riley 4e ordre)', () => {
  for (const bands of [3, 4]) {
    it(`${bands} bandes : réponse en amplitude plate à ±0,1 dB de 20 Hz à 20 kHz (impulsion)`, () => {
      const core = createMultibandCore(SR);
      core.setParams({ ...MB_DEFAULTS, bands });
      const N = 1 << 16;
      const imp = new Float32Array(N); imp[0] = 1;
      const [y] = run(core, imp);
      const mag = fftMag2(y);
      let worst = 0;
      for (let k = 1; k < N / 2; k++) {
        const f = k * SR / N;
        if (f < 20 || f > 20000) continue;
        worst = Math.max(worst, Math.abs(10 * Math.log10(mag[k])));
      }
      expect(worst).toBeLessThan(0.1);
      expect(worst).toBeLessThan(0.001);   // en pratique : erreur de calcul flottant seulement
    });
    it(`${bands} bandes : bruit rose, même énergie par octave (écart ≤ 0,1 dB)`, () => {
      const core = createMultibandCore(SR);
      core.setParams({ ...MB_DEFAULTS, bands, x1: 120, x2: 1500, x3: 7000 });
      const N = 1 << 17;
      const x = pink(N);
      const [y] = run(core, x);
      const mx = fftMag2(x), my = fftMag2(y);
      const ecarts: number[] = [];
      for (let lo = 31.25; lo * 2 <= 16000; lo *= 2) {
        let ex = 0, ey = 0;
        for (let k = Math.ceil(lo * N / SR); k < Math.floor(2 * lo * N / SR); k++) { ex += mx[k]; ey += my[k]; }
        ecarts.push(Math.abs(10 * Math.log10(ey / ex)));
      }
      expect(Math.max(...ecarts)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(db(rms(y) / rms(x)))).toBeLessThan(0.1);
    });
  }
});

describe('Compresseur multibande : réduction conforme au seuil et au taux', () => {
  const cases = [
    { thr: -20, ratio: 4, amp: 0.5 },
    { thr: -30, ratio: 2, amp: 0.5 },
    { thr: -24, ratio: 10, amp: 0.25 },
  ];
  for (const c of cases) {
    it(`sinus 1 kHz à ${db(c.amp).toFixed(1)} dBFS, bande 2 à ${c.thr} dB et ${c.ratio}:1 : réduction = (1 − 1/taux) × dépassement, bandes 1 et 3 intactes`, () => {
      const core = createMultibandCore(SR);
      // Toutes les bandes réglées pour comprimer : seule celle qui contient le sinus doit réagir.
      core.setParams({ ...MB_DEFAULTS, bands: 3, x1: 100, x2: 8000, knee: 0,
        b1Thr: c.thr, b1Ratio: c.ratio, b2Thr: c.thr, b2Ratio: c.ratio, b3Thr: c.thr, b3Ratio: c.ratio, b2Att: 1, b2Rel: 300 });
      const x = sine(1000, c.amp, 1.5);
      const [y] = run(core, x);
      const m = core.takeMeters();
      const expected = (1 - 1 / c.ratio) * (db(c.amp) - c.thr);
      const measured = -db(rms(y, SR, x.length) / rms(x, SR, x.length));
      expect(Math.abs(measured - expected)).toBeLessThan(0.25);
      expect(Math.abs(m.grNow[1] - expected)).toBeLessThan(0.25);
      expect(m.grNow[0]).toBe(0);
      expect(m.grNow[2]).toBe(0);
    });
  }
  it('taux 1:1 par défaut : aucune réduction, même à −60 dB de seuil', () => {
    const core = createMultibandCore(SR);
    core.setParams({ ...MB_DEFAULTS, b1Thr: -60, b2Thr: -60, b3Thr: -60 });
    run(core, sine(1000, 0.5, 0.5));
    expect(core.takeMeters().gr).toEqual([0, 0, 0, 0]);
  });
  it('gain de bande, solo et contournement', () => {
    const base = { ...MB_DEFAULTS, bands: 3, x1: 100, x2: 8000, b2Thr: -20, b2Ratio: 4, knee: 0 };
    const x = sine(1000, 0.5, 1);
    const lvl = (p: any) => { const c = createMultibandCore(SR); c.setParams(p); const [y] = run(c, x); return db(rms(y, SR / 2, x.length) / rms(x, SR / 2, x.length)); };
    expect(lvl({ ...base, b2Gain: 6 }) - lvl(base)).toBeCloseTo(6, 1);
    expect(lvl({ ...base, b2Byp: 1 })).toBeCloseTo(0, 1);          // contournée : ni compression ni gain
    expect(lvl({ ...base, b1Solo: 1 })).toBeLessThan(-60);          // solo du grave : le sinus 1 kHz disparaît
    expect(lvl({ ...base, b2Solo: 1 })).toBeCloseTo(lvl(base), 1);  // solo de la bande du sinus : rien ne change
  });
});

describe('EQ dynamique : gain nul sous le seuil, plage respectée au-dessus', () => {
  it('sous le seuil : sortie identique à l\'entrée au bit près (aucune coloration)', () => {
    const core = createDynEqCore(SR);
    core.setParams({ ...DYN_DEFAULTS, d3Freq: 3500, d3Q: 5, d3Thr: -20, d3Range: -6, d2Range: 6, d2Thr: -10 });
    const x = sine(3500, 0.03, 1);           // −30 dBFS dans la bande, seuil −20
    const xr = pink(x.length, 3).map(v => v * 0.05);
    const [yl, yr] = run(core, x, xr);
    expect(Array.from(yl)).toEqual(Array.from(x));
    expect(Array.from(yr)).toEqual(Array.from(xr));
  });
  const cut = [
    { range: -6, expected: 6 },        // dépassement 14 dB, plage 6 : −6 dB
    { range: -3, expected: 3 },        // recette « voix dure » : 2 à 4 dB
    { range: -20, expected: 20 * Math.log10(0.5) + 20 },   // plage plus grande que le dépassement : bande tenue au seuil
  ];
  for (const c of cut) {
    it(`sinus 3,5 kHz à −6 dBFS, seuil −20 dB, plage ${c.range} dB : −${c.expected.toFixed(1)} dB`, () => {
      const core = createDynEqCore(SR);
      // Attaque rapide : le détecteur crête lit la vraie crête du sinus (à 5 ms il reste ~0,7 dB dessous).
      core.setParams({ ...DYN_DEFAULTS, d3Freq: 3500, d3Q: 5, d3Thr: -20, d3Range: c.range, d3Att: 0.1 });
      const x = sine(3500, 0.5, 1.2);
      const [y] = run(core, x);
      const measured = -db(rms(y, SR / 2, x.length) / rms(x, SR / 2, x.length));
      expect(Math.abs(measured - c.expected)).toBeLessThan(0.2);
      expect(measured).toBeLessThanOrEqual(Math.abs(c.range) + 0.05);
      const m = core.takeMeters();
      expect(m.gainNow[2]).toBeGreaterThanOrEqual(c.range - 1e-9);
      expect(m.gainNow[0] + m.gainNow[1] + m.gainNow[3]).toBe(0);
    });
  }
  it('plage positive : renfort quand la bande ressort, au plus de la plage', () => {
    const core = createDynEqCore(SR);
    core.setParams({ ...DYN_DEFAULTS, d2Freq: 1000, d2Q: 2, d2Thr: -30, d2Range: 4 });
    const x = sine(1000, 0.25, 1);
    const [y] = run(core, x);
    expect(db(rms(y, SR / 2, x.length) / rms(x, SR / 2, x.length))).toBeCloseTo(4, 1);
  });
  it('jamais plus que la plage, quel que soit le signal (bruit fort, plage −4 dB)', () => {
    const core = createDynEqCore(SR);
    core.setParams({ ...DYN_DEFAULTS, d1Range: -4, d1Thr: -60, d2Range: -4, d2Thr: -60, d3Range: -4, d3Thr: -60, d4Range: -4, d4Thr: -60 });
    let lowest = 0;
    const x = pink(SR, 9).map(v => v * 8);
    for (let i = 0; i < x.length; i += 128) {
      const o = new Float32Array(128);
      core.process(x.subarray(i, i + 128), null, o, null, 128);
      lowest = Math.min(lowest, ...core.takeMeters().gainNow);
    }
    expect(lowest).toBeGreaterThanOrEqual(-4 - 1e-9);
    expect(lowest).toBeLessThan(-3.9);
  });
  it('une résonance hors de la bande ne déclenche rien (300 Hz fort, bande à 3,5 kHz Q 5)', () => {
    const core = createDynEqCore(SR);
    core.setParams({ ...DYN_DEFAULTS, d3Freq: 3500, d3Q: 5, d3Thr: -20, d3Range: -6 });
    run(core, sine(300, 0.5, 0.5));
    expect(core.takeMeters().gainPeak[2]).toBe(0);
  });
  it('écoute de la bande : on n\'entend que le passe-bande (centre ≈ 0 dB, loin ≈ silence)', () => {
    const at = (f: number) => {
      const core = createDynEqCore(SR);
      core.setParams({ ...DYN_DEFAULTS, d3Freq: 3500, d3Q: 5, listen: 3 });
      const x = sine(f, 0.5, 0.5);
      const [y] = run(core, x);
      return db(rms(y, SR / 4, x.length) / rms(x, SR / 4, x.length));
    };
    expect(Math.abs(at(3500))).toBeLessThan(0.1);
    expect(at(200)).toBeLessThan(-30);
  });
});

describe('Robustesse : pas de NaN, pas de clic au changement de réglage', () => {
  it('multibande : réglages extrêmes et absurdes, signal fort : tout reste fini', () => {
    const core = createMultibandCore(SR);
    const x = pink(SR, 5).map(v => v * 20);
    const [y] = run(core, x, x, blk => {
      if (blk % 20 === 0) core.setParams({ bands: blk % 40 ? 4 : 3, x1: blk % 3 ? 20 : 25000, x2: NaN, x3: -5, knee: Infinity, output: 99,
        b1Thr: -999, b1Ratio: 0, b2Ratio: 1e9, b2Att: 0, b2Rel: 0, b3Gain: 'x' as any, b4Thr: 50, b1Solo: blk % 2 } as any);
    });
    expect(finite(y)).toBe(true);
  });
  it('EQ dynamique : réglages extrêmes, fréquence au-delà de Nyquist : tout reste fini', () => {
    const core = createDynEqCore(SR);
    const x = pink(SR, 6).map(v => v * 20);
    const [y] = run(core, x, x, blk => {
      if (blk % 15 === 0) core.setParams({ d1Freq: blk % 2 ? 1e6 : -3, d1Q: 0, d1Thr: -1e9, d1Range: -1e9, d2Q: 1e9, d2Range: 1e9, d2Thr: -80, listen: blk % 5, output: NaN } as any);
    });
    expect(finite(y)).toBe(true);
  });
  it('multibande : tourner seuil, taux, gain, coupures, solo, contournement et 3/4 bandes en pleine lecture : aucune marche', () => {
    const x = sine(1000, 0.4, 2);
    const ref = (2 * Math.PI * 1000 / SR) * 0.4 * 1.0;   // plus grande pente naturelle du sinus d'entrée
    const core = createMultibandCore(SR);
    const p: any = { ...MB_DEFAULTS, bands: 3, x1: 200, x2: 4000, b2Thr: -10, b2Ratio: 2 };
    core.setParams(p);
    const steps = [
      { b2Thr: -40, b2Ratio: 10 }, { b2Gain: 12 }, { x1: 900, x2: 1100 }, { b2Solo: 1 }, { b2Solo: 0, b1Solo: 1 }, { b1Solo: 0, b2Byp: 1 },
      { b2Byp: 0, bands: 4, x3: 1200 }, { output: -12 }, { knee: 0 }, { x2: 6000 },
    ];
    const [y] = run(core, x, x, blk => { if (blk > 0 && blk % 50 === 0 && steps[blk / 50 - 1]) core.setParams(Object.assign(p, steps[blk / 50 - 1])); });
    expect(finite(y)).toBe(true);
    // Un sinus de 1 kHz à 48 kHz ne bouge jamais de plus de 2π·1000/48000 ≈ 0,13 × son amplitude par échantillon (gain ≤ +12 dB : 4×).
    expect(maxStep(y)).toBeLessThan(ref * 4 * 1.2);
    expect(clickRatio(y, 1000)).toBeLessThan(1.5);
  });
  it('EQ dynamique : fréquence, Q, plage, seuil, marche et écoute en pleine lecture : aucune marche', () => {
    const x = sine(3000, 0.5, 2);
    const ref = (2 * Math.PI * 3000 / SR) * 0.5;
    const core = createDynEqCore(SR);
    const p: any = { ...DYN_DEFAULTS, d3Freq: 3000, d3Q: 4, d3Thr: -20, d3Range: -6 };
    core.setParams(p);
    const steps = [{ d3Freq: 4500 }, { d3Q: 0.5 }, { d3Range: -18 }, { d3Thr: -40 }, { d3On: 0 }, { d3On: 1 }, { listen: 3 }, { listen: 0 }, { d3Range: 12 }, { output: -6 }];
    const [y] = run(core, x, x, blk => { if (blk > 0 && blk % 60 === 0 && steps[blk / 60 - 1]) core.setParams(Object.assign(p, steps[blk / 60 - 1])); });
    expect(finite(y)).toBe(true);
    expect(maxStep(y)).toBeLessThan(ref * 4 * 1.2);   // +12 dB au plus : pente ≤ 4× celle du sinus
    expect(clickRatio(y, 3000)).toBeLessThan(1.5);
  });
});

describe('Veille des effets : au repos et rattrapage exact', () => {
  for (const kind of ['MBCOMP', 'DYNEQ'] as const) {
    it(`${kind} : au repos après le silence, et rattraper K blocs muets = les calculer`, () => {
      const mk = () => {
        const c = kind === 'MBCOMP' ? createMultibandCore(SR) : createDynEqCore(SR);
        c.setParams(kind === 'MBCOMP' ? { ...MB_DEFAULTS, b2Thr: -30, b2Ratio: 4, b2Rel: 800 } : { ...DYN_DEFAULTS, d3Freq: 1000, d3Thr: -30, d3Range: -6, d3Rel: 800 });
        return c;
      };
      const a = mk(), b = mk();
      const loud = sine(1000, 0.5, 0.3), after = sine(1000, 0.5, 0.2);
      run(a, loud); run(b, loud);
      // a : 2 s de silence calculés ; b : silence jusqu'au repos, puis le reste rattrapé d'un coup.
      const silent = new Float32Array(8 * SR - (8 * SR) % 128);
      run(a, silent);
      let done = 0;
      const blk = new Float32Array(128), o = new Float32Array(128);
      while (!b.atRest() && done < silent.length) { b.process(blk, blk, o, o, 128); done += 128; }
      expect(b.atRest()).toBe(true);
      expect(done).toBeLessThan(silent.length);
      b.catchUp(silent.length - done);
      const [ya] = run(a, after), [yb] = run(b, after);
      let d = 0; for (let i = 0; i < ya.length; i++) d = Math.max(d, Math.abs(ya[i] - yb[i]));
      expect(d).toBeLessThan(1 / 32768 / 100);   // bien sous le centième de LSB 16 bits
    });
  }
  it('les deux effets savent dormir (liste SLEEP_SAFE)', () => {
    expect(SLEEP_SAFE.has('MBCOMP')).toBe(true);
    expect(SLEEP_SAFE.has('DYNEQ')).toBe(true);
  });
});

describe('Déclaration : registre, menu, automation, préréglages', () => {
  it('registre : nom, rubrique, réglages par défaut NEUTRES, automation', () => {
    const mb = getRegisteredPlugin('MBCOMP')!, dq = getRegisteredPlugin('DYNEQ')!;
    expect(mb.name).toBe('Compresseur multibande');
    expect(dq.name).toBe('EQ dynamique');
    const d = mb.defaultParams();
    for (let b = 1; b <= 4; b++) expect(d[`b${b}Ratio`]).toBe(1);
    const e = dq.defaultParams();
    for (let b = 1; b <= 4; b++) expect(e[`d${b}Range`]).toBe(0);
    expect(mb.automatable!.map(a => a.id)).toEqual(expect.arrayContaining(['b1Thr', 'b2Ratio', 'b3Gain', 'output']));
    expect(dq.automatable!.map(a => a.id)).toEqual(expect.arrayContaining(['d1Freq', 'd2Thr', 'd3Range', 'output']));
    expect(mixFxAutomatable('MBCOMP').every(a => a.min < a.max)).toBe(true);
    expect(mixFxParamLabel('DYNEQ', 'd3Range')).toBe('Bande 3 · plage');
    for (const t of ['MBCOMP', 'DYNEQ']) {
      expect(registryMenuItems().some(i => i.id === t)).toBe(true);
      expect(registryBrowserItems().some(i => i.id === t)).toBe(true);
    }
  });
  it('menu « Ajouter un effet » : rangés en Dynamique et Égaliseur, trouvés par « multibande » et « dynamique »', () => {
    const list = registryMenuItems();
    const g1 = groupEffects(list, 'multibande');
    expect(g1.flatMap(g => g.items.map(i => i.id))).toContain('MBCOMP');
    expect(g1.find(g => g.items.some(i => i.id === 'MBCOMP'))!.cat).toBe('Dynamique');
    const g2 = groupEffects(list, 'eq dynamique');
    expect(g2.find(g => g.items.some(i => i.id === 'DYNEQ'))!.cat).toBe('Égaliseur');
    expect(groupEffects(list, 'resonance').flatMap(g => g.items.map(i => i.id))).toContain('DYNEQ');
  });
  it('les défauts neutres ne changent rien au son (EQ dynamique au bit près)', () => {
    const core = createDynEqCore(SR);
    core.setParams({ ...DYN_DEFAULTS });
    const x = pink(SR / 2, 4).map(v => v * 6);
    const [y] = run(core, x);
    expect(Array.from(y)).toEqual(Array.from(x));
  });
  it('préréglages : bornés, et chacun renvoie à une recette sourcée de RECETTES.md', () => {
    const md = fs.readFileSync(path.resolve(__dirname, '../engine/mixfx/RECETTES.md'), 'utf8');
    for (const [presets, specs, kind] of [[MB_PRESETS, MB_SPECS, 'MBCOMP'], [DYN_PRESETS, DYN_SPECS, 'DYNEQ']] as const) {
      for (const pr of presets) {
        expect(sanitizeMixFx(kind, pr.params)).toEqual(pr.params);
        for (const k of Object.keys(pr.params)) expect(specs.some(s => s.id === k)).toBe(true);
        if (pr.id !== 'neutre') {
          expect(md).toContain(`| ${pr.source} |`);
          expect(md).toContain(pr.name);
          // Le seuil dépend de la prise : jamais imposé par un préréglage.
          expect(Object.keys(pr.params).some(k => /Thr$/.test(k))).toBe(false);
        }
      }
    }
  });
});

describe('Charge processeur (indicatif)', () => {
  it('10 s de stéréo 48 kHz : moins de 400 ms par effet sous Node', () => {
    const x = pink(10 * SR, 8);
    for (const mk of [() => { const c = createMultibandCore(SR); c.setParams({ ...MB_DEFAULTS, bands: 4, b1Thr: -30, b1Ratio: 3, b2Thr: -30, b2Ratio: 3, b3Thr: -30, b3Ratio: 3, b4Thr: -30, b4Ratio: 3 }); return c; },
      () => { const c = createDynEqCore(SR); c.setParams({ ...DYN_DEFAULTS, d1Range: -6, d2Range: -6, d3Range: -6, d4Range: -6, d1Thr: -40, d2Thr: -40, d3Thr: -40, d4Thr: -40 }); return c; }]) {
      const c = mk();
      run(c, x.subarray(0, SR));   // chauffe du JIT
      const t0 = performance.now();
      run(c, x, x);
      const ms = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.log(`[mixfx] ${ms.toFixed(0)} ms pour 10 s stéréo`);
      expect(ms).toBeLessThan(400);
    }
  });
});

describe('Clé externe (side-chain, 22/10/2026) : chaque bande détecte dans la même bande de la clé', () => {
  type KeyCore = { process: (a: Float32Array, b: Float32Array | null, c: Float32Array, d: Float32Array | null, n: number, kl?: Float32Array | null, kr?: Float32Array | null) => void };
  /** Comme run(), avec une clé (null = pas de clé). */
  function runKey(core: KeyCore, L: Float32Array, K: Float32Array | null) {
    const n = L.length, oL = new Float32Array(n), oR = new Float32Array(n);
    for (let i = 0; i < n; i += 128) {
      const m = Math.min(128, n - i);
      core.process(L.subarray(i, i + m), L.subarray(i, i + m), oL.subarray(i, i + m), oR.subarray(i, i + m), m, K ? K.subarray(i, i + m) : null, K ? K.subarray(i, i + m) : null);
    }
    return oL;
  }
  const lvl = (y: Float32Array, x: Float32Array) => db(rms(y, SR / 2, x.length) / rms(x, SR / 2, x.length));
  const silence = (sec: number) => new Float32Array(Math.round(sec * SR));

  it('multibande : sans clé = comme avant au bit près ; clé muette = rien ; clé grave = le grave se creuse ; clé aiguë = le grave intact', () => {
    const P = { ...MB_DEFAULTS, bands: 3, x1: 200, x2: 4000, knee: 0, b1Thr: -30, b1Ratio: 8, b1Att: 1, b1Rel: 100 };
    const x = sine(80, 0.3, 1.2);           // basse de la piste (bande 1), −10,5 dBFS
    const mk = () => { const c = createMultibandCore(SR); c.setParams(P); return c; };
    const [ref] = run(mk(), x);
    expect(Array.from(runKey(mk(), x, null))).toEqual(Array.from(ref));      // chemin sans clé inchangé
    expect(lvl(ref, x)).toBeLessThan(-10);                                    // la piste se comprime elle-même
    expect(Math.abs(lvl(runKey(mk(), x, silence(1.2)), x))).toBeLessThan(0.05);   // clé muette : aucune réduction
    const ducked = lvl(runKey(mk(), x, sine(60, 0.5, 1.2)), x);               // kick grave dans la clé
    expect(ducked).toBeLessThan(-12);
    expect(Math.abs(lvl(runKey(mk(), x, sine(8000, 0.5, 1.2)), x))).toBeLessThan(0.05);   // clé dans l'aigu : le grave ne bouge pas
  });

  it('EQ dynamique : sans clé = comme avant ; la cloche ne baisse que quand la clé passe dans sa bande', () => {
    const P = { ...DYN_DEFAULTS, d1On: 1, d1Freq: 1000, d1Q: 2, d1Thr: -30, d1Range: -6, d1Att: 0.1 };
    const x = sine(1000, 0.05, 1.2);        // −26 dBFS dans la bande : se déclenche seul
    const mk = () => { const c = createDynEqCore(SR); c.setParams(P); return c; };
    const [ref] = run(mk(), x);
    expect(Array.from(runKey(mk(), x, null))).toEqual(Array.from(ref));
    expect(Math.abs(lvl(runKey(mk(), x, silence(1.2)), x))).toBeLessThan(1e-6);   // clé muette : au bit près
    expect(lvl(runKey(mk(), x, sine(1000, 0.5, 1.2)), x)).toBeCloseTo(-6, 0);     // voix forte dans la bande : −6 dB (plage)
    expect(Math.abs(lvl(runKey(mk(), x, sine(100, 0.5, 1.2)), x))).toBeLessThan(0.05);   // clé hors bande : rien
  });

  it('déclarés comme effets à clé (fenêtre « Clé », câblage du moteur)', async () => {
    const { supportsSidechain } = await import('../engine/sidechain');
    expect(supportsSidechain('MBCOMP')).toBe(true);
    expect(supportsSidechain('DYNEQ')).toBe(true);
  });
});
