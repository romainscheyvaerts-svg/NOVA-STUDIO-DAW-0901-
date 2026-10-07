import { describe, it, expect } from 'vitest';
import { createPsolaCore, createHarmonyMath, psolaLatencySamples, PsolaCoreParams } from '../engine/psolaCore';
import { SCALE_INTERVALS } from '../utils/scales';
import { vowel, f0Of } from './helpers/v21Signals';

const SR = 48000;
const math = createHarmonyMath();

const cents = (f: number, ref: number) => 1200 * Math.log2(f / ref);

/** Passe un signal mono dans le cœur, par blocs de 128 comme l'AudioWorklet. */
function run(x: Float32Array, params: Partial<PsolaCoreParams>, sr = SR) {
  const core = createPsolaCore(sr, math);
  core.setParams(params);
  const lat = core.latencySamples();
  const n = x.length + lat;
  const inp = new Float32Array(n); inp.set(x);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let s = 0; s < n; s += 128) {
    const k = Math.min(128, n - s);
    core.process(inp.subarray(s, s + k), null, L.subarray(s, s + k), R.subarray(s, s + k), k);
  }
  return { L: L.subarray(lat), R: R.subarray(lat), lat, core };
}

const MINOR = SCALE_INTERVALS.MINOR, MAJOR = SCALE_INTERVALS.MAJOR;
const voice = (v: any) => ({ on: true, semis: 0, degree: null, formant: 0, follow: false, gainL: 1, gainR: 1, delayMs: 0, detune: 0, drift: 0, ...v });
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

describe('Harmoniseur : intervalles dans la gamme', { timeout: 60000 }, () => {
  it('tierce au-dessus en Do majeur : La → Do (+3), Do → Mi (+4), Mi → Sol (+3)', () => {
    expect(math.shiftFor(57, 0, MAJOR, 2)).toBe(3);
    expect(math.shiftFor(60, 0, MAJOR, 2)).toBe(4);
    expect(math.shiftFor(64, 0, MAJOR, 2)).toBe(3);
  });
  it('quinte, quarte, sixte et octave en La mineur', () => {
    // La mineur : La Si Do Ré Mi Fa Sol.
    expect(math.shiftFor(57, 9, MINOR, 4)).toBe(7);    // La → Mi
    expect(math.shiftFor(59, 9, MINOR, 4)).toBe(6);    // Si → Fa (quinte diminuée, dans la gamme)
    expect(math.shiftFor(57, 9, MINOR, 3)).toBe(5);    // La → Ré
    expect(math.shiftFor(57, 9, MINOR, 5)).toBe(8);    // La → Fa
    expect(math.shiftFor(57, 9, MINOR, 7)).toBe(12);
    expect(math.shiftFor(57, 9, MINOR, -7)).toBe(-12);
  });
  it('tierce en dessous et note hors gamme ramenée dans la gamme', () => {
    expect(math.shiftFor(60, 0, MAJOR, -2)).toBe(-3);  // Do → La
    // Do# en Do majeur : ramené sur Do, tierce = Mi ; la voix d'harmonie tombe sur Mi (+3 depuis Do#).
    expect(math.shiftFor(61, 0, MAJOR, 2)).toBe(3);
  });
  it('gamme chromatique (tonalité inconnue) : intervalles majeurs fixes ; penta mineure : note la plus proche', () => {
    const CHR = SCALE_INTERVALS.CHROMATIC;
    expect(math.shiftFor(61, 0, CHR, 2)).toBe(4);
    expect(math.shiftFor(61, 0, CHR, 4)).toBe(7);
    const P = SCALE_INTERVALS.PENTATONIC;               // La penta mineure : La Do Ré Mi Sol
    expect(math.shiftFor(57, 9, P, 2)).toBe(3);         // La → Do
    expect(math.shiftFor(57, 9, P, 4)).toBe(7);         // La → Mi
    expect(math.shiftFor(57, 9, P, 7)).toBe(12);
  });
  it('chaque harmonie tombe dans la gamme, pour toutes les notes et tous les degrés', () => {
    for (const [name, sc] of Object.entries(SCALE_INTERVALS)) {
      for (let root = 0; root < 12; root++) {
        const pcs = math.pitchClasses(root, sc);
        for (let note = 48; note < 72; note++) for (const deg of [-7, -5, -4, -3, -2, 2, 3, 4, 5, 7]) {
          const t = note + math.shiftFor(note, root, sc, deg);
          expect(math.inScale(t, pcs), `${name} ${root} ${note} ${deg}`).toBe(true);
          expect(Math.sign(t - note) === Math.sign(deg) || t === note).toBe(true);
        }
      }
    }
  });
});

describe('Cœur PSOLA : latence déclarée exacte', { timeout: 60000 }, () => {
  it('latence fixe ≈ 57 ms, la même à 44,1 / 48 / 96 kHz (en ms, à 2 ms près)', () => {
    const l48 = psolaLatencySamples(48000) / 48000, l44 = psolaLatencySamples(44100) / 44100, l96 = psolaLatencySamples(96000) / 96000;
    expect(l48).toBeGreaterThan(0.04); expect(l48).toBeLessThan(0.07);
    expect(Math.abs(l44 - l48)).toBeLessThan(0.006);
    expect(Math.abs(l96 - l48)).toBeLessThan(0.006);
  });
  it('un clic traverse le sec ET une voix non transposée exactement à la latence déclarée', () => {
    const x = new Float32Array(SR); x[24000] = 1;
    for (const params of [{ dry: 1, voices: [] }, { dry: 0, voices: [voice({ semis: 0 })] }, { dry: 0, voices: [voice({ semis: 7 })] }, { dry: 0, voices: [voice({ degree: 2 })], root: 0, scale: MAJOR }]) {
      const { L, core } = run(x, params);
      let first = -1; for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > 0.05) { first = i; break; }
      expect(first, JSON.stringify(params)).toBe(24000);
      expect(Math.abs(L[24000])).toBeGreaterThan(0.9);
      expect(core.lateSamples()).toBe(0);
    }
  });
});

describe('Cœur PSOLA : hauteur et formant', { timeout: 60000 }, () => {
  it('transpose une voix de +7, −12, +12 et +4 demi-tons à quelques cents près', () => {
    for (const f0 of [110, 196, 330]) {
      const x = vowel(f0, 1.2);
      for (const semis of [7, -12, 12, 4, -5]) {
        if (f0 * Math.pow(2, semis / 12) > 1000 || f0 * Math.pow(2, semis / 12) < 55) continue;
        const { L, core } = run(x, { dry: 0, voices: [voice({ semis })] });
        const seg = L.subarray(Math.round(0.4 * SR), Math.round(0.9 * SR));
        const f = f0Of(seg);
        expect(Math.abs(cents(f, f0 * Math.pow(2, semis / 12))), `${f0} Hz ${semis} st → ${f.toFixed(2)} Hz`).toBeLessThan(5);
        expect(core.lateSamples()).toBe(0);
      }
    }
  });
  it('le formant seul ne change pas la hauteur (±12 demi-tons de formant)', () => {
    const f0 = 180;
    const x = vowel(f0, 1.2);
    for (const formant of [-12, -5, 5, 12]) {
      const { L, core } = run(x, { dry: 0, voices: [voice({ semis: 0, formant })] });
      const f = f0Of(L.subarray(Math.round(0.4 * SR), Math.round(0.9 * SR)));
      expect(Math.abs(cents(f, f0)), `formant ${formant} → ${f.toFixed(2)} Hz`).toBeLessThan(3);
      expect(core.lateSamples()).toBe(0);
    }
  });
  it('harmoniseur : La2 en Do majeur, tierce + quinte au-dessus → Do3 et Mi3', () => {
    const x = vowel(hz(57), 1.2);
    for (const [deg, want] of [[2, 60], [4, 64], [-2, 53], [7, 69]] as const) {
      const { L } = run(x, { dry: 0, root: 0, scale: MAJOR, voices: [voice({ degree: deg })] });
      const f = f0Of(L.subarray(Math.round(0.4 * SR), Math.round(0.9 * SR)));
      expect(Math.abs(cents(f, hz(want))), `degré ${deg} → ${f.toFixed(2)} Hz`).toBeLessThan(5);
    }
  });
  // PSOLA : le niveau dépend un peu de l'endroit où tombent les nouvelles harmoniques (creux d'environ 3 dB vers une quinte).
  it('niveau : une voix transposée garde à peu près le niveau de la voix (±4 dB)', () => {
    const x = vowel(150, 1.2);
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    const ref = rms(x.subarray(Math.round(0.4 * SR), Math.round(0.9 * SR)));
    for (const [semis, formant] of [[0, 0], [7, 0], [-12, 0], [12, 0], [0, 7], [0, -7]]) {
      const { L } = run(x, { dry: 0, voices: [voice({ semis, formant })] });
      const db = 20 * Math.log10(rms(L.subarray(Math.round(0.4 * SR), Math.round(0.9 * SR))) / ref);
      expect(Math.abs(db), `${semis}/${formant} : ${db.toFixed(1)} dB`).toBeLessThan(4);
    }
  });
});
