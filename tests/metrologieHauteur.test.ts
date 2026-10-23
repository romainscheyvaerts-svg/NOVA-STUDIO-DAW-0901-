/**
 * Métrologie de la HAUTEUR (22/10/2026) : demi-tons et cents affichés = hauteur mesurée.
 *
 *  - « Voix grave / aiguë » (cœur PSOLA, même code qu'à l'export) : ±24 demi-tons au dixième ;
 *  - Harmoniseur : degrés de la gamme → notes exactes ;
 *  - Nova Tune (auto-tune) : notes cibles calées sur La = 440 Hz, gamme du projet ;
 *  - tolérance : ±1 cent.
 */
import { afterAll, afterEach, describe, it } from 'vitest';
import { createPsolaCore, createHarmonyMath, type PsolaCoreParams } from '../engine/psolaCore';
import { voiceShiftToCore } from '../engine/v21Nodes';
import { SCALE_INTERVALS } from '../utils/scales';
import { vowel, f0Of } from './helpers/v21Signals';
import { assertMetro, cents, flushMetroLog, freqOf, metro } from './helpers/metro';

afterAll(() => flushMetroLog('hauteur'));
afterEach(() => assertMetro());

const math = createHarmonyMath();
/** Rend la main entre deux mesures longues (sinon vitest perd le contact avec le fil de test). */
const tick = () => new Promise<void>(r => setTimeout(r, 0));
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

function run(x: Float32Array, params: Partial<PsolaCoreParams>, sr: number) {
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
  return { L: L.subarray(lat), R: R.subarray(lat) };
}

/**
 * Fondamentale au centième de cent : période approchée (f0Of), puis pic d'autocorrélation
 * normalisée autour de 8 périodes, interpolé (l'erreur d'interpolation est divisée par 8).
 */
function f0Precise(x: Float32Array, sr: number): number {
  const f1 = f0Of(x, sr);
  if (!(f1 > 0)) return NaN;
  const K = 8, T = sr / f1;
  const lag0 = Math.round(K * T);
  const W = x.length - lag0 - 8;
  const nsdf = (lag: number) => { let ac = 0, e1 = 0, e2 = 0; for (let j = 0; j < W; j++) { ac += x[j] * x[j + lag]; e1 += x[j] * x[j]; e2 += x[j + lag] * x[j + lag]; } return 2 * ac / (e1 + e2 + 1e-20); };
  let best = lag0, bv = -Infinity;
  for (let l = lag0 - 4; l <= lag0 + 4; l++) { const v = nsdf(l); if (v > bv) { bv = v; best = l; } }
  const a = nsdf(best - 1), b = nsdf(best), c = nsdf(best + 1), den = a - 2 * b + c;
  const t = best + (Math.abs(den) > 1e-12 ? 0.5 * (a - c) / den : 0);
  return sr * K / t;
}

describe('Voix grave / aiguë : hauteur affichée (demi-tons, au dixième) = hauteur mesurée (±1 cent)', () => {
  for (const sr of [44100, 48000]) {
    it(`${sr} Hz`, async () => {
      for (const f0 of [110, 196, 330]) {
        const x = vowel(f0, 1.6, sr);
        for (const semis of [-12, -7, -5, -1, -0.3, 0.1, 0.5, 1, 4, 7, 12]) {
          const want = f0 * Math.pow(2, semis / 12);
          if (want > 1000 || want < 55) continue;
          for (const link of [0, 1]) {
            await tick();
            const p = voiceShiftToCore({ pitch: semis, formant: 0, link, mix: 1, output: 0 });
            const { L } = run(x, p as any, sr);
            const f = f0Precise(L.subarray(Math.round(0.4 * sr), Math.round(1.4 * sr)), sr);
            metro('Voix grave / aiguë', `${semis > 0 ? '+' : ''}${semis} demi-ton(s) sur ${f0} Hz, formant ${link ? 'lié' : 'préservé'}, ${sr} Hz`, 0, cents(f, want), 'cents', 1, cents(f, want), 2);
          }
        }
      }
    }, 300_000);
  }
});

describe('Harmoniseur : degrés de la gamme → notes exactes (±1 cent)', () => {
  it('La3 en Do majeur et La mineur : tierce, quinte, octave, en dessous', async () => {
    const sr = 48000;
    const x = vowel(hz(57), 1.6, sr);
    const voice = (v: any) => ({ on: true, semis: 0, degree: null, formant: 0, follow: false, gainL: 1, gainR: 1, delayMs: 0, detune: 0, drift: 0, ...v });
    for (const [name, root, scale, deg, want] of [
      ['Do majeur', 0, SCALE_INTERVALS.MAJOR, 2, 60], ['Do majeur', 0, SCALE_INTERVALS.MAJOR, 4, 64], ['Do majeur', 0, SCALE_INTERVALS.MAJOR, -2, 53], ['Do majeur', 0, SCALE_INTERVALS.MAJOR, 7, 69],
      ['La mineur', 9, SCALE_INTERVALS.MINOR, 2, 60], ['La mineur', 9, SCALE_INTERVALS.MINOR, 4, 64], ['La mineur', 9, SCALE_INTERVALS.MINOR, -7, 45],
    ] as [string, number, number[], number, number][]) {
      await tick();
      const { L } = run(x, { dry: 0, root, scale, voices: [voice({ degree: deg })] }, sr);
      const f = f0Precise(L.subarray(Math.round(0.4 * sr), Math.round(1.4 * sr)), sr);
      metro('Harmoniseur', `La3 (220 Hz) en ${name}, degré ${deg > 0 ? '+' : ''}${deg} → ${hz(want).toFixed(2)} Hz`, 0, cents(f, hz(want)), 'cents', 1, cents(f, hz(want)), 2);
    }
  }, 300_000);
});

// ───────────────────────────── Nova Tune (auto-tune) ─────────────────────────────

import { AutoTuneNode } from '../plugins/AutoTunePlugin';
import { installMiniWebAudio, MiniOfflineAudioContext } from './helpers/miniWebAudio';
import { speedFromRetuneMs } from '../utils/tuneSpeed';

async function autotune(sr: number, x: Float32Array, p: Record<string, any>) {
  const restore = installMiniWebAudio();
  try {
    const ctx = new MiniOfflineAudioContext(1, x.length, sr) as unknown as AudioContext;
    const at = new AutoTuneNode(ctx);
    await at.ready;
    at.updateParams({ humanize: 0, mix: 1, isEnabled: true, ...p } as any);
    const b = ctx.createBuffer(1, x.length, sr); b.copyToChannel(x as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource(); src.buffer = b; src.connect(at.input); at.output.connect(ctx.destination); src.start(0);
    const out = await (ctx as unknown as OfflineAudioContext).startRendering();
    return { y: out.getChannelData(0), lat: Math.round(at.latency * sr) };
  } finally { restore(); }
}

describe('Nova Tune : notes cibles calées sur La = 440 Hz, gamme du projet', () => {
  it('voix désaccordée → note juste de la gamme (±1 cent), vitesse « Robot »', async () => {
    for (const sr of [44100, 48000]) for (const [name, scale, root, sungMidi, wantMidi] of [
      ['chromatique, La3 + 40 cents', 'CHROMATIC', 0, 57.4, 57],
      ['chromatique, Mi3 − 35 cents', 'CHROMATIC', 0, 51.65, 52],
      ['Do majeur, Do#4 + 10 cents → Ré4', 'MAJOR', 0, 61.1, 62],
      ['La mineur, Sol#3 → La3 (hors gamme, plus proche)', 'MINOR', 9, 56.4, 57],
    ] as [string, string, number, number, number][]) {
      const f0 = hz(sungMidi);
      const x = vowel(f0, 1.6, sr);
      const { y, lat } = await autotune(sr, x, { speed: 0, scale, rootKey: root });
      const f = f0Precise(y.subarray(lat + Math.round(0.5 * sr), lat + Math.round(1.4 * sr)), sr);
      metro('Nova Tune', `${name} (${f0.toFixed(2)} Hz) → ${hz(wantMidi).toFixed(2)} Hz, ${sr} Hz`, 0, cents(f, hz(wantMidi)), 'cents', 1, cents(f, hz(wantMidi)), 2);
    }
  }, 300_000);

  // Convention d'affichage du 22/10/2026 (utils/tuneSpeed.ts) : ms affichés = demi-vie de l'écart,
  // comme la référence du marché mesurée en boîte noire (avant : constante de temps, 63 %).
  it('vitesse affichée (ms) = demi-vie de la correction (moitié du chemin en ce temps), ±10 %', async () => {
    const sr = 48000;
    for (const ms of [25, 75, 150]) {
      const speed = speedFromRetuneMs(ms);
      const f0 = hz(57.4), x = vowel(f0, 1.4, sr);
      const { y, lat } = await autotune(sr, x, { speed, scale: 'CHROMATIC', rootKey: 0 });
      // Écart à la note (cents) au fil du temps : fondamentale isolée (passe-bas 300 Hz), passages
      // par zéro sur des fenêtres de 15 ms tous les 5 ms.
      const lp = Float32Array.from(y);
      const al = 1 - Math.exp(-2 * Math.PI * 300 / sr);
      for (let k = 0; k < 4; k++) { let st = 0; for (let i = 0; i < lp.length; i++) { st += al * (lp[i] - st); lp[i] = st; } }
      const pts: [number, number][] = [];
      const W = Math.round(0.015 * sr), H = Math.round(0.005 * sr);
      for (let a = lat; a + W < y.length; a += H) {
        const f = freqOf(lp, sr, a, a + W);
        if (f > 0) pts.push([(a + W / 2 - lat) / sr, cents(f, hz(57))]);
      }
      // Décroissance exponentielle de l'écart (40 cents → 0), une fois la détection lancée (après 40 ms) :
      // pente de ln(écart − écart final) entre 25 et 3 cents.
      const tail = pts.filter(p => p[0] > 0.9);
      const rest = tail.reduce((a, p) => a + p[1], 0) / Math.max(1, tail.length);
      const fit = pts.map(p => [p[0], p[1] - rest] as [number, number]).filter(p => p[0] > 0.04 && p[1] < 25 && p[1] > 3);
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const [t, d] of fit) { const l = Math.log(d); sx += t; sy += l; sxx += t * t; sxy += t * l; }
      const n = fit.length, slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      const half = -1000 * Math.LN2 / slope;
      metro('Nova Tune', `vitesse ${ms} ms : demi-vie mesurée de la correction (40 cents)`, ms, half, 'ms', ms * 0.1, undefined, 1);
    }
  }, 300_000);

  it('hauteur stable d’une période à l’autre (gigue ≤ 1 cent), voix tenue à La3 et La4', async () => {
    for (const sr of [44100, 48000]) for (const midi of [57.3, 69.3]) {
      const f0 = hz(midi), x = vowel(f0, 1.2, sr);
      const { y, lat } = await autotune(sr, x, { speed: 0, scale: 'CHROMATIC', rootKey: 0 });
      // Fondamentale isolée (passe-bas à 1,5 × f), puis durée de chaque période (passages par zéro).
      const want = hz(Math.round(midi));
      const lp = Float32Array.from(y);
      const al = 1 - Math.exp(-2 * Math.PI * 1.5 * want / sr);
      for (let k = 0; k < 4; k++) { let st = 0; for (let i = 0; i < lp.length; i++) { st += al * (lp[i] - st); lp[i] = st; } }
      const zc: number[] = [];
      for (let i = lat + Math.round(0.4 * sr); i < lp.length; i++) if (lp[i - 1] < 0 && lp[i] >= 0) zc.push(i - 1 + (-lp[i - 1]) / (lp[i] - lp[i - 1]));
      let worst = 0;
      for (let k = 1; k < zc.length; k++) worst = Math.max(worst, Math.abs(cents(sr / (zc[k] - zc[k - 1]), want)));
      metro('Nova Tune', `gigue de hauteur (pire période), voix à ${f0.toFixed(1)} Hz corrigée à ${want.toFixed(2)} Hz, ${sr} Hz`, 0, worst, 'cents', 1, worst, 2);
    }
  }, 300_000);
});
