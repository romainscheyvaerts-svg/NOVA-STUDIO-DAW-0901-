import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { createRnnoise, denoiseChannel, RNNOISE_FRAME, type RnnoiseEngine } from '../utils/rnnoise';

const SR = 48000;
let engine: Promise<RnnoiseEngine> | null = null;
const load = () => (engine ??= createRnnoise(readFileSync(new URL('../public/wasm/rnnoise/rnnoise.wasm', import.meta.url))));

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; }
const rms = (x: Float32Array, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };

/** Voyelle de synthèse : impulsions glottiques à 120 Hz, 3 formants, syllabes à 4 Hz. */
function vowel(n: number): Float32Array {
  const x = new Float32Array(n);
  const period = Math.round(SR / 120);
  for (let i = 0; i < n; i += period) x[i] = 1;
  let y = x;
  for (const [f, bw] of [[700, 110], [1200, 120], [2600, 200]]) {
    const r = Math.exp(-Math.PI * bw / SR), th = 2 * Math.PI * f / SR;
    const a1 = -2 * r * Math.cos(th), a2 = r * r;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = y[i] - a1 * (out[i - 1] || 0) - a2 * (out[i - 2] || 0);
    y = out;
  }
  const g = 0.25 / Math.max(...Array.from(y.subarray(0, SR), Math.abs));
  for (let i = 0; i < n; i++) y[i] *= g * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * i / SR));
  return y;
}

describe('RNNoise WASM (lot 1 « Voix propre »)', () => {
  it('se charge sans la colle Emscripten et traite une trame de 10 ms', async () => {
    const e = await load();
    const st = e.create();
    const f = new Float32Array(RNNOISE_FRAME);
    const vad = st.process(f);
    expect(vad).toBeGreaterThanOrEqual(0);
    expect(vad).toBeLessThanOrEqual(1);
    st.destroy();
    st.destroy(); // sans erreur
    expect(() => st.process(f)).toThrow();
  });

  it('baisse un souffle seul d’au moins 8 dB, sortie de même longueur, sans NaN', async () => {
    const e = await load();
    const r = rng(7);
    const n = SR * 2 + 123;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.05 * r();
    const { out, vad } = denoiseChannel(e, x);
    expect(out.length).toBe(n);
    expect(vad.length).toBe(Math.ceil(n / RNNOISE_FRAME));
    expect(out.every(Number.isFinite)).toBe(true);
    const db = 20 * Math.log10(rms(out, SR / 2) / rms(x, SR / 2));
    expect(db).toBeLessThan(-8);
  });

  it('compense son retard : la voix ressort calée à l’échantillon près', async () => {
    const e = await load();
    const x = vowel(SR * 2);
    const { out } = denoiseChannel(e, x);
    let best = -Infinity, lag = 99;
    for (let l = -600; l <= 600; l += 1) {
      let s = 0;
      for (let i = 4000; i < x.length - 4000; i += 3) s += x[i] * out[i + l];
      if (s > best) { best = s; lag = l; }
    }
    expect(Math.abs(lag)).toBeLessThanOrEqual(2);
    expect(rms(out)).toBeGreaterThan(rms(x) * 0.3); // la voix n'est pas effacée
  });
});
