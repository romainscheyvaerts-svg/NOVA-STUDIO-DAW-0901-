/**
 * Écart 7 · « Réparer la voix » : preuves chiffrées sur des signaux synthétiques
 * (plosive, clics de bouche, bourdonnement secteur, écrêtage), plus le patch du
 * clip (original gardé, paroles qui suivent).
 */
import { describe, expect, it } from 'vitest';
import { fft } from './helpers/spectrum';
import { declipChannels, findClipRuns } from '../utils/repair/declip';
import { detectHum, notchHum, removeHum } from '../utils/repair/hum';
import { detectClicks, removeClicks } from '../utils/repair/mouthClicks';
import { reducePlosives } from '../utils/repair/plosives';
import { DEFAULT_REPAIR_OPTIONS, repairBlock, repairChannels, repairNothingFound, repairPatch, repairStepName, repairSummary } from '../utils/repair';
import { audioSuiteRevertPatch, patchClip } from '../utils/clipProcess';
import { TrackType, type Clip } from '../types';

const SR = 48000;

/** Graine fixe : bruit reproductible. */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
}

/** « Voix » : harmoniques d'une fondamentale qui glisse doucement, enveloppe de formants, légère respiration de niveau. */
function voice(seconds: number, o: { f0?: number; minHz?: number; maxHz?: number; level?: number } = {}): Float32Array {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const f0 = o.f0 ?? 180, minHz = o.minHz ?? 0, maxHz = o.maxHz ?? 5000, level = o.level ?? 0.25;
  const formant = (f: number) => Math.exp(-((f - 700) ** 2) / (2 * 400 ** 2)) + 0.6 * Math.exp(-((f - 1800) ** 2) / (2 * 500 ** 2)) + 0.25 * Math.exp(-((f - 3000) ** 2) / (2 * 700 ** 2)) + 0.05;
  const H = Math.floor(maxHz / (f0 * 0.9));
  // Les harmoniques entrent et sortent de la bande en fondu (une coupure nette ferait de vrais clics).
  const edge = (d: number, span: number) => (d <= 0 ? 0 : d >= span ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * d) / span));
  const phase = new Float64Array(H + 1);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f0 * (1 + 0.04 * Math.sin(2 * Math.PI * 0.7 * t)); // glissé lent
    let v = 0;
    for (let h = 1; h <= H; h++) {
      const fh = h * f;
      phase[h] += (2 * Math.PI * fh) / SR;
      const w = edge(fh - minHz, 60) * edge(maxHz - fh, 400); if (w <= 0) continue;
      v += w * formant(fh) * Math.sin(phase[h] + h * 0.37) / Math.sqrt(h);
    }
    x[i] = v;
  }
  let pk = 0; for (const v of x) pk = Math.max(pk, Math.abs(v));
  const g = level / pk;
  // Bruit de fond d'une bonne prise maison (≈ −70 dBFS) : une vraie voix n'est jamais « parfaite ».
  const nz = rng(99);
  for (let i = 0; i < n; i++) x[i] = x[i] * g * (0.8 + 0.2 * Math.sin(2 * Math.PI * 0.3 * (i / SR))) + 3e-4 * 3.46 * nz();
  return x;
}

/** Énergie (somme des |X|²) entre fa et fb Hz, sur la tranche [a, b) s (fenêtre de Hann, une seule FFT). */
function bandEnergy(x: Float32Array | Float64Array, a: number, b: number, fa: number, fb: number): number {
  const i0 = Math.round(a * SR), len = Math.round((b - a) * SR);
  let N = 1; while (N < len) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < len; i++) re[i] = (x[i0 + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len));
  fft(re, im);
  let e = 0;
  for (let k = Math.max(1, Math.floor((fa * N) / SR)); k <= Math.min(N / 2 - 1, Math.ceil((fb * N) / SR)); k++) e += re[k] * re[k] + im[k] * im[k];
  return e;
}
const db = (r: number) => 10 * Math.log10(Math.max(1e-30, r));
const diff = (a: Float32Array, b: Float32Array) => { const d = new Float32Array(a.length); for (let i = 0; i < a.length; i++) d[i] = a[i] - b[i]; return d; };

/** Énergie par tiers d'octave entre 300 Hz et 5 kHz (dB). */
function thirdOctaves(x: Float32Array, a: number, b: number): number[] {
  const out: number[] = [];
  for (let f = 315; f <= 5000; f *= Math.pow(2, 1 / 3)) out.push(db(bandEnergy(x, a, b, f / Math.pow(2, 1 / 6), f * Math.pow(2, 1 / 6))));
  return out;
}

/** Pire écart (dB) par tiers d'octave, sur les bandes où la voix de référence a du son (à moins de 40 dB de la plus forte). */
function worstBandDiff(ref: Float32Array, y: Float32Array, a: number, b: number): number {
  const r = thirdOctaves(ref, a, b), o = thirdOctaves(y, a, b);
  const top = Math.max(...r);
  return Math.max(...r.map((v, i) => (v > top - 40 ? Math.abs(v - o[i]) : 0)));
}

describe('Plosives', () => {
  // Voix entièrement au-dessus de 200 Hz + plosive « p » à 1 s : souffle grave (≈ 45 Hz) de 80 ms, attaque raide.
  const clean = voice(2.5, { f0: 200, minHz: 200 });
  const pop = new Float32Array(clean.length);
  const t0 = Math.round(1.0 * SR);
  for (let i = 0; i < Math.round(0.08 * SR); i++) {
    const t = i / SR;
    pop[t0 + i] = 0.7 * (1 - Math.exp(-t / 0.002)) * Math.exp(-t / 0.025) * Math.sin(2 * Math.PI * 45 * t);
  }
  const x = new Float32Array(clean.length);
  for (let i = 0; i < x.length; i++) x[i] = clean[i] + pop[i];

  it('baisse le grave sous 120 Hz d’au moins 12 dB sur l’attaque, sans toucher la voix au-dessus de 200 Hz', () => {
    const { channels: [y], stats } = reducePlosives([x], SR, 'medium');
    expect(stats.count).toBe(1);
    const lowBefore = bandEnergy(x, 1.0, 1.06, 10, 120), lowAfter = bandEnergy(y, 1.0, 1.06, 10, 120);
    const reduction = db(lowBefore / lowAfter);
    console.log(`[plosive] grave < 120 Hz sur l'attaque : −${reduction.toFixed(1)} dB`);
    expect(reduction).toBeGreaterThanOrEqual(12);
    // Ce qui a changé au-dessus de 200 Hz, rapporté à la voix au-dessus de 200 Hz, pendant la plosive.
    const changeHigh = db(bandEnergy(diff(y, x), 0.95, 1.15, 200, 8000) / bandEnergy(clean, 0.95, 1.15, 200, 8000));
    console.log(`[plosive] changement au-dessus de 200 Hz : ${changeHigh.toFixed(1)} dB sous la voix`);
    expect(changeHigh).toBeLessThan(-30);
    // Loin de la plosive : son d'origine à l'échantillon près.
    for (let i = 0; i < Math.round(0.9 * SR); i++) if (y[i] !== x[i]) throw new Error(`échantillon ${i} modifié`);
    for (let i = Math.round(1.3 * SR); i < x.length; i++) if (y[i] !== x[i]) throw new Error(`échantillon ${i} modifié`);
  });

  it('ne touche pas une voix grave sans plosive (fondamentale à 100 Hz)', () => {
    const v = voice(2, { f0: 100 });
    const { channels: [y], stats } = reducePlosives([v], SR, 'medium');
    expect(stats.count).toBe(0);
    expect(y).toBe(v);
  });
});

describe('Clics de bouche', () => {
  // 10 « prises » de 1 s × 10 clics chacune : 100 clics, très courts (0,3-1,5 ms), aigus, bien plus faibles que la voix.
  const takes = 10;
  const clean = voice(takes, { f0: 160 });
  const x = new Float32Array(clean);
  const r = rng(7);
  const positions: number[] = [];
  for (let k = 0; k < takes * 10; k++) {
    const at = Math.round((0.05 + k * 0.1 + (r() + 0.5) * 0.04) * SR);
    positions.push(at);
    const len = Math.round((0.0003 + (r() + 0.5) * 0.0012) * SR);
    const amp = 0.04 + (r() + 0.5) * 0.06; // −28 à −16 dB sous la crête de la voix
    // Claquement : bruit blanc dérivé (aigu, large bande) sous une enveloppe qui s'éteint vite.
    let prev = 0;
    for (let i = 0; i < len; i++) {
      const env = Math.exp(-i / (len / 3));
      const w = 2 * r();
      x[at + i] += amp * env * (w - prev);
      prev = w;
    }
  }

  it('trouve et retire au moins 95 % des 100 clics, voix intacte à ±0,5 dB entre 300 Hz et 5 kHz', () => {
    const { events } = detectClicks(x, SR, 'medium');
    const found = positions.filter(p => events.some(e => e.from <= p + 4 && e.to >= p)).length;
    const { channel: y, stats } = removeClicks(x, SR, 'medium');
    console.log(`[clics] ${found}/100 trouvés · ${stats.count} passages réparés · ${events.length} détections`);
    expect(found).toBeGreaterThanOrEqual(95);
    expect(events.length).toBeLessThanOrEqual(110); // pas d'avalanche de fausses détections
    // Clics retirés : l'énergie restante autour de chaque clic (sortie − voix propre) chute.
    let before = 0, after = 0;
    for (const p of positions) for (let i = p - 10; i < p + 100; i++) { before += (x[i] - clean[i]) ** 2; after += (y[i] - clean[i]) ** 2; }
    const gainDb = db(before / after);
    console.log(`[clics] énergie des clics : −${gainDb.toFixed(1)} dB`);
    expect(gainDb).toBeGreaterThan(15);
    // Voix : spectre par tiers d'octave identique à la voix propre à ±0,5 dB.
    const worst = worstBandDiff(clean, y, 0, takes);
    console.log(`[clics] écart de spectre 300 Hz-5 kHz : ${worst.toFixed(2)} dB au pire`);
    expect(worst).toBeLessThanOrEqual(0.5);
  });

  it('les silences d’une vraie prise (bruit « pointu » à −70 dBFS) ne sont pas des clics', () => {
    const v = voice(4, { f0: 150 });
    const r = rng(23);
    // Deux silences de 0,8 s : bruit de pièce à −70 dBFS avec des pointes (loi de Laplace, crêtes à −50 dBFS).
    // La voix s'éteint et revient en fondu de 30 ms (une coupure nette serait un vrai clic).
    const F = Math.round(0.03 * SR);
    for (const [a, b] of [[0.5, 1.3], [2.4, 3.2]]) {
      const i0 = Math.round(a * SR), i1 = Math.round(b * SR);
      for (let i = i0 - F; i < i1 + F; i++) {
        const g = i < i0 ? (i0 - i) / F : i >= i1 ? (i - i1 + 1) / F : 0;
        const u = r() + 0.5;
        v[i] = v[i] * (0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, g))) + 3e-4 * Math.sign(r()) * -Math.log(Math.max(1e-9, u)) * 0.7;
      }
    }
    const { events } = detectClicks(v, SR, 'medium');
    expect(events.length).toBe(0);
  });

  it('une voix sans clic ressort à l’identique', () => {
    const v = voice(3, { f0: 140 });
    const { channel, stats } = removeClicks(v, SR, 'medium');
    expect(stats.count).toBe(0);
    expect(channel).toBe(v);
  });
});

describe('Bourdonnement secteur', () => {
  const secs = 4;
  const clean = voice(secs, { f0: 210, level: 0.3 });
  const hum = new Float32Array(clean.length);
  // 50 Hz et 7 harmoniques à −40 dBFS chacune (fréquence réelle 50,03 Hz : le réseau n'est jamais pile).
  const F = 50.03;
  for (let i = 0; i < hum.length; i++) for (let h = 1; h <= 8; h++) hum[i] += 0.01 * Math.sin(2 * Math.PI * h * F * (i / SR) + h);
  const x = new Float32Array(clean.length);
  for (let i = 0; i < x.length; i++) x[i] = clean[i] + hum[i];

  it('trouve 50 Hz (pas 60) et la fréquence exacte', () => {
    const d = detectHum([x], SR, 'auto');
    expect(d).not.toBeNull();
    expect(Math.abs(d!.f0 - F)).toBeLessThan(0.05);
    expect(d!.harmonics.length).toBeGreaterThanOrEqual(6);
  });

  it('baisse le bourdonnement et ses harmoniques d’au moins 30 dB, voix gardée', () => {
    const { channels: [y], stats, ranks } = removeHum([x], SR, 'auto');
    expect(stats.f0).not.toBeNull();
    // Résidu de bourdonnement = sortie − voix passée dans les mêmes coupe-bandes (on isole le bourdonnement).
    const [vf] = notchHum([clean], SR, detectHum([x], SR, 'auto')!.f0, ranks);
    const resid = diff(y, vf);
    let worst = Infinity;
    for (let h = 1; h <= 8; h++) {
      const f = h * F;
      const r = db(bandEnergy(hum, 0, secs, f - 1, f + 1) / bandEnergy(resid, 0, secs, f - 1, f + 1));
      worst = Math.min(worst, r);
    }
    const total = db(bandEnergy(hum, 0, secs, 20, 1000) / bandEnergy(resid, 0, secs, 20, 1000));
    console.log(`[bourdonnement] ${stats.f0} Hz, ${stats.harmonics} fréquences · baisse totale ${total.toFixed(1)} dB · pire harmonique ${worst.toFixed(1)} dB`);
    expect(total).toBeGreaterThanOrEqual(30);
    expect(worst).toBeGreaterThanOrEqual(30);
    // Y compris dans la première et la dernière demi-seconde (prolongement périodique).
    const edge = db(bandEnergy(hum, 0, 0.5, 20, 1000) / bandEnergy(resid, 0, 0.5, 20, 1000));
    expect(edge).toBeGreaterThanOrEqual(30);
    // Voix : ce que les coupe-bandes font à la voix seule, par tiers d'octave, à ±0,5 dB entre 300 Hz et 5 kHz.
    const vd = worstBandDiff(clean, vf, 0, secs);
    console.log(`[bourdonnement] voix : ${vd.toFixed(2)} dB au pire par tiers d'octave`);
    expect(vd).toBeLessThanOrEqual(0.5);
  });

  it('pas de bourdonnement : rien trouvé, son intact', () => {
    const { channels: [y], stats } = removeHum([clean], SR, 'auto');
    expect(stats.f0).toBeNull();
    expect(y).toBe(clean);
  });
});

describe('Écrêtage', () => {
  it('reconstruit un sinus écrêté : erreur mesurée avant / après', () => {
    const n = SR;
    const truth = new Float32Array(n), clipped = new Float32Array(n);
    for (let i = 0; i < n; i++) { truth[i] = 0.9 * Math.sin(2 * Math.PI * 440 * (i / SR)); clipped[i] = Math.max(-0.6, Math.min(0.6, truth[i])); }
    const { runs } = findClipRuns(clipped, SR);
    expect(runs.length).toBeGreaterThan(800); // 2 crêtes par période
    const { channels: [y], stats } = declipChannels([clipped], SR, { lowerGain: false });
    const rms = (a: Float32Array) => { let e = 0, s = 0; for (let i = 2000; i < n - 2000; i++) { e += (a[i] - truth[i]) ** 2; s += truth[i] ** 2; } return db(e / s); };
    const before = rms(clipped), after = rms(y);
    console.log(`[écrêtage] erreur avant ${before.toFixed(1)} dB · après ${after.toFixed(1)} dB (rapportée au signal) · ${stats.runs} crêtes`);
    expect(before).toBeGreaterThan(-25);
    expect(after).toBeLessThan(-50);
    expect(before - after).toBeGreaterThanOrEqual(25);
  });

  it('voix écrêtée : crêtes reconstruites, puis baissée juste sous −1 dBFS', () => {
    const v = voice(1.5, { f0: 170, level: 1.4 });
    const c = v.map(s => Math.max(-1, Math.min(1, s)));
    const { channels: [y], stats } = declipChannels([c], SR);
    expect(stats.runs).toBeGreaterThan(10);
    expect(stats.gainDb).toBeLessThan(0);
    let pk = 0; for (const s of y) pk = Math.max(pk, Math.abs(s));
    expect(20 * Math.log10(pk)).toBeLessThanOrEqual(-0.99);
    // Erreur vers la vraie voix (même gain) bien plus faible qu'avant.
    const g = Math.pow(10, stats.gainDb / 20);
    let eb = 0, ea = 0;
    for (let i = 0; i < v.length; i++) { eb += (c[i] - v[i]) ** 2; ea += (y[i] / g - v[i]) ** 2; }
    console.log(`[écrêtage] voix : erreur −${db(eb / ea).toFixed(1)} dB`);
    expect(db(eb / ea)).toBeGreaterThan(10);
  });

  it('un son non écrêté (même un sinus grave à 30 Hz) n’est pas touché', () => {
    const s = new Float32Array(SR);
    for (let i = 0; i < SR; i++) s[i] = 0.8 * Math.sin(2 * Math.PI * 30 * (i / SR) + 0.3);
    const { channels: [y], stats } = declipChannels([s], SR);
    expect(stats.runs).toBe(0);
    expect(y).toBe(s);
  });
});

describe('Chaîne complète et clip', () => {
  it('rien trouvé : stats vides et message clair', () => {
    const v = voice(1.2, { f0: 220, minHz: 220 });
    const { channels: [y], stats } = repairChannels([v], SR, DEFAULT_REPAIR_OPTIONS);
    expect(y).toBe(v);
    expect(repairSummary(stats)).toBe('');
    expect(repairNothingFound(DEFAULT_REPAIR_OPTIONS)).toMatch(/Rien à réparer/);
  });

  it('bilan lisible et nom d’étape', () => {
    expect(repairSummary({ clicks: { count: 12, samples: 300 }, hum: { f0: 50.03, harmonics: 6, prominenceDb: 20 }, plosives: { count: 1, maxReductionDb: 18.2 } }))
      .toBe('12 clics de bouche retirés · bourdonnement 50 Hz (6 fréquences) retiré · 1 plosive adoucie (jusqu’à −18 dB de grave)');
    expect(repairStepName(DEFAULT_REPAIR_OPTIONS)).toBe('Voix réparée (tout)');
    expect(repairStepName({ ...DEFAULT_REPAIR_OPTIONS, declip: false, hum: 'off' })).toBe('Voix réparée (clics, plosives)');
  });

  it('patch du clip : nouveau son, original récupérable au même endroit, paroles qui suivent', () => {
    const clip: Clip = { id: 'c1', trackId: 't1', name: 'Couplet', start: 4, duration: 3, offset: 2, bufferId: 'b0', type: TrackType.AUDIO,
      transcript: { version: 1, language: 'fr', model: 'm', words: [{ w: 'salut', s: 2.5, e: 2.9 }], bufferId: 'b0', at: 1 } } as Clip;
    expect(repairBlock(clip)).toBeNull();
    const p = repairPatch(clip, { newBufferId: 'b1', from: 1, name: 'Voix réparée (clics)', now: 5 });
    const after = patchClip(clip, p);
    expect(after.bufferId).toBe('b1');
    expect(after.offset).toBe(1);
    expect(after.audioSuite?.steps[0]).toEqual({ type: 'VOICE_REPAIR', name: 'Voix réparée (clics)', at: 5 });
    expect(after.transcript?.bufferId).toBe('b1');
    expect(after.transcript?.words[0].s).toBe(1.5);
    const back = patchClip(after, audioSuiteRevertPatch(after, () => true)!);
    expect(back.bufferId).toBe('b0');
    expect(back.offset).toBe(2);
    expect(back.name).toBe('Couplet');
    expect(repairBlock({ ...clip, type: TrackType.MIDI, notes: [] } as unknown as Clip)).toMatch(/La réparation/);
  });
});
