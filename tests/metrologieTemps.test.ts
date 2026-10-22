/**
 * Métrologie des effets TEMPORELS et de MODULATION (22/10/2026) : ce que la fenêtre
 * affiche = ce que l'on entend, mesuré sur le rendu hors ligne du VRAI nœud de
 * l'effet (même code qu'à l'export), dans le mini Web Audio du banc
 * (tests/helpers/miniWebAudio.ts), à 44,1 et 48 kHz.
 *
 * Tolérances : temps ±0,1 ms ou ±1 échantillon ; gain ±0,1 dB ; hauteur ±1 cent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installMiniWebAudio, MiniOfflineAudioContext } from './helpers/miniWebAudio';
import { assertMetro, dB, flushMetroLog, metro, toneAt } from './helpers/metro';
import { SyncDelayNode, type DelayDivision } from '../plugins/DelayPlugin';
import { buildTempoMap, quartersToTime, tempoMapStore, timeToQuarters } from '../utils/tempoMap';

const RATES = [44100, 48000];
let restore: () => void = () => {};
beforeAll(() => { restore = installMiniWebAudio(); });
afterAll(() => { restore(); flushMetroLog('temps'); });
// Chaque mesure hors tolérance fait échouer le test, après avoir tout mesuré (rapport complet).
afterEach(() => assertMetro());

type Fx = { input: AudioNode; output: AudioNode };

/** Rend la main à la boucle d'événements (les rendus du banc sont longs et synchrones : sans ça, vitest perd le contact avec le fil de test). */
const tick = () => new Promise<void>(r => setTimeout(r, 0));

/** Rend `input` (canaux) à travers l'effet créé par `make`, dans un contexte hors ligne neuf. */
async function render(sr: number, seconds: number, input: Float32Array[], make: (ctx: BaseAudioContext) => Fx, before?: (fx: any, ctx: BaseAudioContext) => void): Promise<Float32Array[]> {
  await tick();
  const n = Math.round(seconds * sr);
  const ctx = new MiniOfflineAudioContext(2, n, sr) as unknown as OfflineAudioContext;
  const fx = make(ctx);
  // Comme l'export (AudioEngine.renderProject) : on attend les effets qui chargent un AudioWorklet.
  if ((fx as any).ready instanceof Promise) await (fx as any).ready;
  before?.(fx, ctx);
  const b = ctx.createBuffer(input.length, n, sr);
  input.forEach((c, i) => b.copyToChannel(c.subarray(0, n) as Float32Array<ArrayBuffer>, i));
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.connect(fx.input);
  fx.output.connect(ctx.destination);
  src.start(0);
  const out = await ctx.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}

/**
 * Position (échantillons, fractionnaire) du pic le plus fort de |x| dans [a, b) : barycentre
 * ±2 échantillons. NaN s'il n'y a rien au-dessus de `floor` (une fuite du son sec à −300 dB
 * ne compte pas comme un écho).
 */
function peakPos(x: Float32Array, a: number, b: number, floor = 1e-3): number {
  let k = a, m = 0;
  for (let i = Math.max(0, a); i < Math.min(b, x.length); i++) if (Math.abs(x[i]) > m) { m = Math.abs(x[i]); k = i; }
  if (m < floor) return NaN;
  let s = 0, w = 0;
  for (let i = k - 2; i <= k + 2; i++) { const v = Math.abs(x[i] || 0); s += v * i; w += v; }
  return w > 0 ? s / w : k;
}

const impulse = (sr: number, seconds: number, at: number, amp = 0.25) => { const x = new Float32Array(Math.round(sr * seconds)); x[Math.round(at * sr)] = amp; return x; };

/** Salve sinusoïdale à fenêtre de Hann. */
function burst(sr: number, seconds: number, at: number, f: number, len: number, amp = 0.25) {
  const x = new Float32Array(Math.round(sr * seconds));
  const a = Math.round(at * sr), n = Math.round(len * sr);
  for (let i = 0; i < n; i++) x[a + i] = amp * Math.sin(2 * Math.PI * f * i / sr) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
  return x;
}

// ───────────────────────────── Écho / délai ─────────────────────────────

const DIVS: [DelayDivision, number][] = [
  ['1/1', 4], ['1/2', 2], ['1/2D', 3], ['1/4', 1], ['1/4D', 1.5], ['1/4T', 2 / 3], ['1/8', 0.5], ['1/8D', 0.75], ['1/8T', 1 / 3],
  ['1/16', 0.25], ['1/16D', 0.375], ['1/16T', 1 / 6], ['1/32', 0.125],
];

const delayFx = (bpm: number, p: Record<string, any>) => (ctx: BaseAudioContext) => {
  const d = new SyncDelayNode(ctx as AudioContext, bpm);
  d.updateParams({ mode: 'DIGITAL', mix: 1, feedback: 0, feedbackHP: 20, feedbackLP: 20000, saturation: 0, bpm, ...p } as any);
  return d;
};

describe('Écho (Nova Delay) : temps synchronisés au tempo', () => {
  for (const sr of RATES) {
    it(`${sr} Hz : toutes les valeurs de note à 90, 120 et 140 BPM, gauche et droite (±1 échantillon)`, async () => {
      for (const bpm of [90, 120, 140]) {
        for (const [div, q] of DIVS) {
          const want = Math.min(3.99, (60 / bpm) * q);
          if (want > 3.5) continue; // au-delà du rendu court du banc
          const t0 = 0.05;
          const [L, R] = await render(sr, t0 + want + 0.05, [impulse(sr, t0 + want + 0.05, t0)], delayFx(bpm, { division: div, divisionR: div }));
          const pL = (peakPos(L, Math.round((t0 + want / 2) * sr), L.length) - t0 * sr) / sr;
          const pR = (peakPos(R, Math.round((t0 + want / 2) * sr), R.length) - t0 * sr) / sr;
          const tolMs = 1000 / sr;
          metro('Écho', `${div} à ${bpm} BPM, gauche, ${sr} Hz`, want * 1000, pL * 1000, 'ms', tolMs + 1e-9);
          metro('Écho', `${div} à ${bpm} BPM, droite, ${sr} Hz`, want * 1000, pR * 1000, 'ms', tolMs + 1e-9);
        }
      }
    }, 120_000);
  }

  it('répétitions (feedback) : chaque écho = le précédent × la valeur affichée (±0,1 dB), à 1 kHz', async () => {
    for (const sr of RATES) for (const fb of [0.2, 0.4, 0.7, 0.95]) {
      const bpm = 120, d = 0.25; // croche à 120 BPM
      const x = burst(sr, 1.2, 0.05, 1000, 0.04);
      const [L] = await render(sr, 1.2, [x], delayFx(bpm, { division: '1/8', divisionR: '1/8', feedback: fb, feedbackHP: 80, feedbackLP: 8000 }));
      const seg = (k: number) => { const a = Math.round((0.05 + k * d) * sr); return toneAt(L, sr, 1000, a, a + Math.round(0.04 * sr)).amp; };
      const r = dB(seg(2) / seg(1));
      metro('Écho', `répétitions ${Math.round(fb * 100)} %, 2e / 1er écho à 1 kHz, ${sr} Hz`, dB(fb), r, 'dB', 0.1);
    }
  });

  it('filtres de la boucle : coupe-bas et coupe-haut à −3 dB pile à la fréquence affichée', async () => {
    for (const sr of RATES) for (const [what, f, p] of [['coupe-haut', 3000, { feedbackLP: 3000, feedbackHP: 20 }], ['coupe-bas', 500, { feedbackHP: 500, feedbackLP: 20000 }]] as [string, number, any][]) {
      const fb = 0.5, d = 0.25;
      const x = burst(sr, 1, 0.05, f, 0.06);
      const [L] = await render(sr, 1, [x], delayFx(120, { division: '1/8', divisionR: '1/8', feedback: fb, ...p }));
      const seg = (k: number) => { const a = Math.round((0.05 + k * d) * sr); return toneAt(L, sr, f, a, a + Math.round(0.06 * sr)).amp; };
      const r = dB(seg(2) / seg(1)) - dB(fb);
      metro('Écho', `${what} ${f} Hz : atténuation à ${f} Hz, ${sr} Hz`, -3.01, r, 'dB', 0.1);
    }
  });

  it('carte de tempo : marche 90 → 140 BPM puis rampe 140 → 90 BPM, chaque écho tombe sur la note (±1 échantillon)', async () => {
    const sr = 48000;
    const before = tempoMapStore.get();
    // 4/4 : 2 mesures à 90, marche à 140 (mesure 2), rampe jusqu'à 90 atteint à la mesure 6.
    const map = buildTempoMap(90, { numerator: 4, denominator: 4 }, [{ id: 'a', bar: 2, bpm: 140 }, { id: 'b', bar: 6, bpm: 90, ramp: true }]);
    tempoMapStore.set(map);
    try {
      for (const [div, q] of [['1/4', 1], ['1/8D', 0.75], ['1/8T', 1 / 3]] as [DelayDivision, number][]) {
        // Une impulsion sur chaque temps des mesures 1 à 7.
        const beats: number[] = [];
        for (let k = 2; k < 28; k++) beats.push(quartersToTime(map, k));
        const end = quartersToTime(map, 29.5);
        const x = new Float32Array(Math.round(end * sr));
        // Impulsions légères ; l'écho de chacune est cherché juste avant l'impulsion suivante.
        for (const b of beats) x[Math.round(b * sr)] = 0.25;
        const [L] = await render(sr, end, [x], delayFx(90, { division: div, divisionR: div }), (fx) => fx.syncTimeline(0));
        let worst = 0, worstAt = '';
        for (const b of beats) {
          const s = Math.round(b * sr) / sr;
          const want = quartersToTime(map, timeToQuarters(map, s) + q);
          const p = peakPos(L, Math.round((want - 0.004) * sr), Math.round((want + 0.004) * sr)) / sr;
          const e = Math.abs(p - want) * sr;
          if (!(e <= worst)) { worst = e; worstAt = `${s.toFixed(3)} s`; }
          if (Number.isNaN(worst)) break;
        }
        metro('Écho', `${div} dans une carte de tempo (marche 90→140, rampe 140→90), pire écart (à ${worstAt}), ${sr} Hz`, 0, worst, 'éch.', 1, worst, 2);
      }
    } finally { tempoMapStore.set(before); }
  }, 120_000);
});

// ───────────────────────────── Réverbe ─────────────────────────────

import { ReverbNode, type ReverbMode } from '../plugins/ReverbPlugin';
import { convolverNormalizationScale } from './helpers/miniWebAudio';
import { rt60 } from './helpers/metro';
import { irCalibration, shapeIr } from '../utils/userIr';

const reverbFx = (p: Record<string, any>) => (ctx: BaseAudioContext) => {
  const r = new ReverbNode(ctx as AudioContext);
  r.updateParams({ mix: 1, ducking: 0, modDepth: 0, bassBoost: 0, lowCut: 20, highCut: 20000, ...p } as any);
  return r;
};

describe('Réverbe : durée (RT60), pré-délai, coupe-bas / coupe-haut, réponse importée', () => {
  const MODES: ReverbMode[] = ['ROOM', 'HALL', 'PLATE', 'CATHEDRAL', 'SHIMMER', 'SPRING'];

  it('durée affichée = RT60 mesuré aux fréquences moyennes (500 Hz et 1 kHz, ISO 3382 T30) ±5 %', async () => {
    for (const sr of RATES) for (const mode of MODES) for (const decay of [0.6, 2.5, 6]) for (const damping of [0, 0.5]) {
      await tick();
      const ctx = new MiniOfflineAudioContext(2, sr, sr) as unknown as BaseAudioContext;
      const r: any = reverbFx({ mode, decay, damping, size: 0.7, diffusion: 0.8 })(ctx);
      const ir: AudioBuffer = r.convA.buffer || r.convB.buffer;
      // Moyenne de 4 mesures (gauche, droite × 500 Hz, 1 kHz) : deux bruits indépendants, comme
      // plusieurs positions de micro (ISO 3382) — une seule réalisation de bruit varie de ±5 %.
      const L = ir.getChannelData(0), R = ir.getChannelData(1);
      const tmid = (rt60(L, sr, 500) + rt60(L, sr, 1000) + rt60(R, sr, 500) + rt60(R, sr, 1000)) / 4;
      const ecart = (tmid / decay - 1) * 100;
      metro('Réverbe', `durée ${decay} s, ${mode}, amorti ${Math.round(damping * 100)} %, ${sr} Hz (T30 moyen 500 Hz–1 kHz)`, decay, tmid, 's', null, undefined, 2);
      metro('Réverbe', `écart relatif : durée ${decay} s, ${mode}, amorti ${Math.round(damping * 100)} %, ${sr} Hz`, 0, ecart, '%', 5, ecart, 1);
    }
  }, 300_000);

  it('pré-délai : rien n’arrive avant le temps affiché, la réverbe (et ses premières réflexions) commence pile à ce temps (±1 échantillon)', async () => {
    for (const sr of RATES) for (const mode of ['ROOM', 'HALL', 'PLATE'] as ReverbMode[]) for (const pre of [0, 0.001, 0.01, 0.025, 0.05, 0.12]) for (const er of [0, 0.3]) for (const md of [0, 0.1]) {
      const t0 = 0.02;
      const [L, R] = await render(sr, t0 + pre + 0.15, [impulse(sr, t0 + pre + 0.15, t0, 0.5)], reverbFx({ mode, decay: 1, preDelay: pre, erLevel: er, modDepth: md }));
      // 1er échantillon au-dessus de −200 dB sous la crête du son réverbéré : le bruit de calcul
      // de la convolution (FFT) et la fuite du son sec à mix 100 % (cos 90° = 6·10⁻¹⁷) restent dessous,
      // le tout début de la montée de la queue (≈ −110 dB) passe.
      let pk = 0; for (let i = 0; i < L.length; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
      const thr = pk * 1e-10;
      let k = -1;
      for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > thr || Math.abs(R[i]) > thr) { k = i; break; }
      const got = (k - Math.round(t0 * sr)) / sr * 1000;
      // Une réverbe modulée ne peut pas commencer avant l'amplitude du balayage (profondeur × 1,5 ms).
      const want = Math.max(pre, md > 0 ? md * 0.0015 + 2 / sr : 0) * 1000;
      // Modulée, la queue arrive à ± l'amplitude du balayage autour du pré-délai.
      metro('Réverbe', `pré-délai ${pre * 1000} ms, ${mode}, réflexions ${Math.round(er * 100)} %, modulation ${Math.round(md * 100)} %, ${sr} Hz (1er son réverbéré)`, want, got, 'ms', 1000 / sr + md * 1.5 + 1e-9);
    }
  }, 300_000);

  it('coupe-bas et coupe-haut : −3,01 dB pile à la fréquence affichée (Butterworth)', () => {
    for (const sr of RATES) for (const [lc, hc] of [[160, 10000], [400, 6000], [80, 15000]]) {
      const ctx = new MiniOfflineAudioContext(2, sr, sr) as unknown as BaseAudioContext;
      const r: any = reverbFx({ lowCut: lc, highCut: hc })(ctx);
      const resp = (f: any, hz: number) => { const m = new Float32Array(1), ph = new Float32Array(1); f.getFrequencyResponse(Float32Array.of(hz), m, ph); return dB(m[0]); };
      metro('Réverbe', `coupe-bas ${lc} Hz : niveau à ${lc} Hz, ${sr} Hz`, -3.01, resp(r.lowCutFilter, lc), 'dB', 0.1);
      metro('Réverbe', `coupe-haut ${hc} Hz : niveau à ${hc} Hz, ${sr} Hz`, -3.01, resp(r.highCutFilter, hc), 'dB', 0.1);
      // Pas de bosse dans la bande passante
      let mx = -99; for (const f of [lc * 1.2, lc * 1.5, lc * 2, hc / 2, hc / 1.5, hc / 1.2]) mx = Math.max(mx, resp(r.lowCutFilter, f), resp(r.highCutFilter, f));
      metro('Réverbe', `coupe-bas ${lc} / coupe-haut ${hc} : bosse max dans la bande, ${sr} Hz`, 0, mx, 'dB', 0.1);
    }
  });

  it('réponse importée : niveau calibré = normalisation d’un convolveur (spec), longueur gardée exacte', () => {
    for (const sr of RATES) {
      const n = Math.round(1.3 * sr);
      let a = 3;
      const rnd = () => { a = (a * 16807) % 2147483647; return a / 2147483647 - 0.5; };
      const chs = [0, 1].map(() => Float32Array.from({ length: n }, (_, i) => rnd() * Math.exp(-i / (0.3 * sr))));
      const k = irCalibration(chs, sr);
      const ref = convolverNormalizationScale({ numberOfChannels: 2, length: n, sampleRate: sr, getChannelData: (c: number) => chs[c] });
      metro('Réverbe', `réponse importée : niveau calibré vs convolveur normalisé, ${sr} Hz`, 0, dB(k / ref), 'dB', 0.01, dB(k / ref), 3);
      const out = shapeIr(chs, sr, { lengthSec: 0.5, fadeSec: 0.1 });
      metro('Réverbe', `réponse importée : longueur gardée 0,5 s, ${sr} Hz`, 0.5 * 1000, out[0].length / sr * 1000, 'ms', 1000 / sr);
      expect(out[0][out[0].length - 1]).toBe(0);
    }
  });
});

// ───────────────────────── Modulation : chorus, flanger, doubleur, stéréo ─────────────────────────

import { ChorusNode } from '../plugins/ChorusPlugin';
import { FlangerNode } from '../plugins/FlangerPlugin';
import { VocalDoublerNode } from '../plugins/DoublerPlugin';
import { StereoSpreaderNode } from '../plugins/StereoSpreaderPlugin';
import { rms } from './helpers/metro';

/**
 * Retard instantané (s) d'un sinus de fréquence f entre l'entrée et la sortie, mesuré par
 * fenêtres de `win` s (phase de la composante à f), déroulé à partir de `d0` (retard approché).
 */
function delayTrack(inp: Float32Array, out: Float32Array, sr: number, f: number, win: number, from: number, to: number, d0: number) {
  const n = Math.round(win * sr), ts: number[] = [], ds: number[] = [];
  let prev = d0;
  for (let a = Math.round(from * sr); a + n <= Math.round(to * sr); a += n) {
    const pi = toneAt(inp, sr, f, a, a + n).phase, po = toneAt(out, sr, f, a, a + n).phase;
    let d = (pi - po) / (2 * Math.PI * f);
    d += Math.round((prev - d) * f) / f;
    ts.push((a + n / 2) / sr); ds.push(d); prev = d;
  }
  return { ts, ds };
}

/** Sinusoïde ajustée (moindres carrés) à fréquence r sur une suite (t, y) : amplitude et phase (rad, à t = 0). */
function fitSine(ts: number[], ys: number[], r: number) {
  const m = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sc = 0, ss = 0, cc = 0, s2 = 0;
  for (let i = 0; i < ts.length; i++) { const w = 2 * Math.PI * r * ts[i], y = ys[i] - m; sc += y * Math.cos(w); ss += y * Math.sin(w); cc += Math.cos(w) ** 2; s2 += Math.sin(w) ** 2; }
  const A = sc / cc, B = ss / s2;
  return { amp: Math.hypot(A, B), phase: Math.atan2(A, B), mean: m };
}

/** Fréquence d'une modulation lente (passages par zéro montants de y − moyenne). */
function modRate(ts: number[], ys: number[]) {
  const m = ys.reduce((a, b) => a + b, 0) / ys.length;
  const zc: number[] = [];
  for (let i = 1; i < ys.length; i++) if (ys[i - 1] - m < 0 && ys[i] - m >= 0) zc.push(ts[i - 1] + (ts[i] - ts[i - 1]) * (m - ys[i - 1]) / (ys[i] - ys[i - 1]));
  return zc.length > 1 ? (zc.length - 1) / (zc[zc.length - 1] - zc[0]) : NaN;
}

const sineIn = (sr: number, sec: number, f: number, amp = 0.25) => Float32Array.from({ length: Math.round(sr * sec) }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / sr));

describe('Chorus : vitesse (Hz), voix en quadrature, coupe-bas / coupe-haut', () => {
  const chorusFx = (p: Record<string, any>) => (ctx: BaseAudioContext) => {
    const c = new ChorusNode(ctx as AudioContext);
    c.updateParams({ mix: 1, feedback: 0, lowCut: 20, highCut: 20000, spread: 1, ...p } as any);
    return c;
  };
  it('vitesse affichée = fréquence de l’ondulation mesurée (±0,5 %), voix 1 et 2', async () => {
    const sr = 48000, f = 1000;
    for (const rate of [0.5, 1.2, 4]) {
      const sec = Math.max(2.5, 4 / rate);
      const x = sineIn(sr, sec, f);
      const [L, R] = await render(sr, sec, [x, x], chorusFx({ mode: 'CLASSIC', rate, depth: 0.5 }), fx => fx.syncTimeline(0));
      const tl = delayTrack(x, L, sr, f, 0.004, 0.05, sec, 0.007), tr = delayTrack(x, R, sr, f, 0.004, 0.05, sec, 0.010);
      metro('Chorus', `vitesse ${rate} Hz, voix 1 (gauche), 48000 Hz`, rate, modRate(tl.ts, tl.ds), 'Hz', rate * 0.005, undefined, 3);
      metro('Chorus', `vitesse ${rate} Hz, voix 2 (droite), 48000 Hz`, rate, modRate(tr.ts, tr.ds), 'Hz', rate * 0.005, undefined, 3);
    }
  }, 120_000);
  it('mode Classique : 2 voix « en quadrature » (90° ±3°)', async () => {
    const sr = 48000, f = 1000, rate = 1.2, sec = 2.5;
    const x = sineIn(sr, sec, f);
    const [L, R] = await render(sr, sec, [x, x], chorusFx({ mode: 'CLASSIC', rate, depth: 0.5 }), fx => fx.syncTimeline(0));
    const tl = delayTrack(x, L, sr, f, 0.004, 0.05, sec, 0.007), tr = delayTrack(x, R, sr, f, 0.004, 0.05, sec, 0.010);
    const a = fitSine(tl.ts, tl.ds, rate), b = fitSine(tr.ts, tr.ds, rate);
    let dphi = ((a.phase - b.phase) * 180 / Math.PI) % 360; if (dphi < 0) dphi += 360; if (dphi > 180) dphi = 360 - dphi;
    metro('Chorus', 'Classique : écart de phase entre les 2 voix (annoncé : quadrature)', 90, dphi, '°', 3, undefined, 1);
  }, 120_000);
  it('coupe-bas / coupe-haut : −3,01 dB pile à la fréquence affichée', () => {
    for (const sr of RATES) for (const [lc, hc] of [[100, 12000], [300, 4000]]) {
      const ctx = new MiniOfflineAudioContext(2, sr, sr) as unknown as BaseAudioContext;
      const c: any = chorusFx({ lowCut: lc, highCut: hc })(ctx);
      const resp = (f: any, hz: number) => { const m = new Float32Array(1), ph = new Float32Array(1); f.getFrequencyResponse(Float32Array.of(hz), m, ph); return dB(m[0]); };
      metro('Chorus', `coupe-bas ${lc} Hz : niveau à ${lc} Hz, ${sr} Hz`, -3.01, resp(c.lowCutFilter, lc), 'dB', 0.1);
      metro('Chorus', `coupe-haut ${hc} Hz : niveau à ${hc} Hz, ${sr} Hz`, -3.01, resp(c.highCutFilter, hc), 'dB', 0.1);
    }
  });
});

describe('Flanger : position (retard de base, ms) et vitesse (Hz)', () => {
  const flangerFx = (p: Record<string, any>) => (ctx: BaseAudioContext) => {
    const fl = new FlangerNode(ctx as AudioContext);
    fl.updateParams({ mix: 1, feedback: 0, depth: 0, invertPhase: false, ...p } as any);
    return fl;
  };
  it('position affichée (1 à 15 ms) = retard mesuré (±1 échantillon)', async () => {
    for (const sr of RATES) for (const manual of [0, 0.05, 0.1, 0.3, 1]) {
      const want = (1 + manual * 14);
      const t0 = 0.01;
      const x = impulse(sr, 0.05, t0, 0.5);
      const [L] = await render(sr, 0.05, [x], flangerFx({ manual }));
      // Sortie = 0,5 × sec + effet : on retire le sec (gain exact 1 − mix / 2).
      const wet = L.map((v, i) => v - 0.5 * x[i]);
      const p = (peakPos(wet, Math.round((t0 + 0.0002) * sr), wet.length) - t0 * sr) / sr * 1000;
      metro('Flanger', `position ${want.toFixed(1)} ms (réglage ${Math.round(manual * 100)} %), ${sr} Hz`, want, p, 'ms', 1000 / sr + 1e-9);
    }
  }, 120_000);
  it('retour affiché = gain de chaque recirculation (±0,1 dB), normal et inversé', async () => {
    for (const sr of RATES) for (const [fb, inv] of [[0.5, false], [0.7, false], [0.7, true]] as [number, boolean][]) {
      const t0 = 0.01, x = impulse(sr, 0.05, t0, 0.5);
      const [L] = await render(sr, 0.05, [x], flangerFx({ manual: 0.3, feedback: fb, invertPhase: inv }));
      const wet = L.map((v, i) => v - 0.5 * x[i]);
      // Somme des échantillons autour de chaque passage : l'interpolation linéaire étale l'impulsion
      // (retard fractionnaire) mais garde sa somme.
      const d = 0.0052, at = (k: number) => { const c = Math.round((t0 + k * d) * sr); let m = 0; for (let i = c - 4; i <= c + 4; i++) m += wet[i]; return m; };
      const r = at(2) / at(1);
      metro('Flanger', `retour ${Math.round(fb * 100)} %${inv ? ' (phase inversée)' : ''} : 2e / 1er passage, ${sr} Hz`, (inv ? -1 : 1) * fb, r, '', 0.012, undefined, 4);
    }
  });
  it('vitesse affichée = fréquence du balayage mesurée (±0,5 %)', async () => {
    const sr = 48000, f = 1000;
    for (const rate of [0.25, 1, 4]) {
      const sec = Math.max(2.5, 4 / rate);
      const x = sineIn(sr, sec, f);
      const [L] = await render(sr, sec, [x], flangerFx({ manual: 0.5, depth: 0.5, rate }), fx => fx.syncTimeline(0));
      const wet = L.map((v, i) => v - 0.5 * x[i]);
      const tr = delayTrack(x, wet, sr, f, 0.004, 0.05, sec, 0.008);
      metro('Flanger', `vitesse ${rate} Hz, 48000 Hz`, rate, modRate(tr.ts, tr.ds), 'Hz', rate * 0.005, undefined, 3);
    }
  }, 120_000);
});

describe('Doubleur : décalages 16 / 24 ms et désaccord (cents)', () => {
  const doublerFx = (p: Record<string, any>) => (ctx: BaseAudioContext) => {
    const d = new VocalDoublerNode(ctx as AudioContext);
    d.updateParams({ directOn: false, width: 1, gainL: 1, gainR: 1, ...p } as any);
    return d;
  };
  it('décalages annoncés (16 ms à gauche, 24 ms à droite) ±0,1 ms', async () => {
    for (const sr of RATES) {
      const t0 = 0.01, x = impulse(sr, 0.06, t0, 0.5);
      const [L, R] = await render(sr, 0.06, [x], doublerFx({ detune: 0 }));
      const pl = (peakPos(L, Math.round((t0 + 0.005) * sr), L.length) - t0 * sr) / sr * 1000;
      const pr = (peakPos(R, Math.round((t0 + 0.005) * sr), R.length) - t0 * sr) / sr * 1000;
      metro('Doubleur', `décalage gauche, ${sr} Hz`, 16, pl, 'ms', 0.1);
      metro('Doubleur', `décalage droite, ${sr} Hz`, 24, pr, 'ms', 0.1);
    }
  });
  it('désaccord affiché (±15 cents à 100 %) = écart de hauteur crête mesuré (±1 cent)', async () => {
    const sr = 44100, f = 1000, sec = 9;
    for (const detune of [0.4, 1]) {
      const x = sineIn(sr, sec, f);
      const [L] = await render(sr, sec, [x], doublerFx({ detune }), fx => fx.syncTimeline(0));
      const tr = delayTrack(x, L, sr, f, 0.004, 0.1, sec, 0.016);
      let mx = 0;
      for (let i = 1; i < tr.ds.length; i++) {
        const slope = (tr.ds[i] - tr.ds[i - 1]) / (tr.ts[i] - tr.ts[i - 1]);
        mx = Math.max(mx, Math.abs(1200 * Math.log2(1 - slope)));
      }
      metro('Doubleur', `désaccord ${Math.round(detune * 15)} cents (réglage ${Math.round(detune * 100)} %), voix gauche, crête sur ${sec} s`, Math.round(detune * 15 * 10) / 10, mx, 'cents', 1, undefined, 2);
    }
  }, 300_000);
});

describe('Stéréo (Stereo Spreader) : largeur, graves en mono, 3 bandes, Haas', () => {
  const spreadFx = (p: Record<string, any>) => (ctx: BaseAudioContext) => {
    const s = new StereoSpreaderNode(ctx as AudioContext);
    s.updateParams({ safeMonoBass: false, multiBand: false, haasAmount: 0, balance: 0, ...p } as any);
    return s;
  };
  const noise = (n: number, seed: number) => { let a = seed; return Float32Array.from({ length: n }, () => { a = (a * 16807) % 2147483647; return a / 2147483647 - 0.5; }); };
  it('largeur affichée = gain mesuré du signal Côtés (S), le Milieu (M) intact (±0,1 dB)', async () => {
    for (const sr of RATES) for (const w of [0, 0.5, 1, 1.5, 2]) {
      const n = Math.round(sr * 0.5), L = noise(n, 3), R = noise(n, 11);
      const [oL, oR] = await render(sr, 0.5, [L, R], spreadFx({ width: w }));
      const a = Math.round(0.05 * sr);
      const S = (x: Float32Array, y: Float32Array) => rms(Float32Array.from(x, (v, i) => (v - y[i]) / 2), a);
      const M = (x: Float32Array, y: Float32Array) => rms(Float32Array.from(x, (v, i) => (v + y[i]) / 2), a);
      metro('Stéréo', `largeur ${Math.round(w * 100)} % : gain Milieu, ${sr} Hz`, 0, dB(M(oL, oR) / M(L, R)), 'dB', 0.1);
      if (w > 0) metro('Stéréo', `largeur ${Math.round(w * 100)} % : gain Côtés, ${sr} Hz`, dB(w), dB(S(oL, oR) / S(L, R)), 'dB', 0.1);
      else metro('Stéréo', `largeur 0 % : Côtés restants, ${sr} Hz`, '−∞', dB(S(oL, oR) / S(L, R)), 'dB', null);
    }
  });
  it('graves en mono : Côtés à −3 dB pile à la fréquence affichée', () => {
    for (const sr of RATES) for (const fm of [80, 120, 250]) {
      const ctx = new MiniOfflineAudioContext(2, sr, sr) as unknown as BaseAudioContext;
      const s: any = spreadFx({ safeMonoBass: true, monoFreq: fm })(ctx);
      const m = new Float32Array(1), ph = new Float32Array(1);
      s.sideHighpass.getFrequencyResponse(Float32Array.of(fm), m, ph);
      metro('Stéréo', `graves en mono sous ${fm} Hz : Côtés à ${fm} Hz, ${sr} Hz`, -3.01, dB(m[0]), 'dB', 0.1);
    }
  });
  it('3 bandes : toutes à 100 % = son d’origine (±0,1 dB) ; coupures à la fréquence affichée (graves = médiums, médiums = aigus)', async () => {
    const sr = 48000;
    const freqs = [60, 150, 250, 400, 1000, 2500, 4000, 6000, 12000];
    for (const f of freqs) {
      const n = Math.round(sr * 0.3);
      const L = sineIn(sr, 0.3, f), R = Float32Array.from(L, v => -v); // tout en Côtés
      const [oL] = await render(sr, 0.3, [L, R], spreadFx({ multiBand: true, lowWidth: 1, midWidth: 1, highWidth: 1, lowMidFreq: 250, midHighFreq: 4000 }));
      const a = Math.round(0.1 * sr);
      metro('Stéréo', `3 bandes à 100 % : gain des Côtés à ${f} Hz`, 0, dB(toneAt(oL, sr, f, a, n).amp / 0.25), 'dB', 0.1);
    }
    // Source d'un seul côté (gauche seule) : l'image reste intacte à 100 % (droite muette, gauche à 0 dB).
    for (const f of [250, 4000, 1000]) {
      const n = Math.round(sr * 0.3);
      const L = sineIn(sr, 0.3, f), R = new Float32Array(n);
      const [oL, oR] = await render(sr, 0.3, [L, R], spreadFx({ multiBand: true, lowWidth: 1, midWidth: 1, highWidth: 1, lowMidFreq: 250, midHighFreq: 4000 }));
      const a = Math.round(0.1 * sr);
      metro('Stéréo', `3 bandes à 100 %, son à gauche seulement, ${f} Hz : gauche`, 0, dB(toneAt(oL, sr, f, a, n).amp / 0.25), 'dB', 0.1);
      metro('Stéréo', `3 bandes à 100 %, son à gauche seulement, ${f} Hz : fuite à droite`, '< −60', dB(toneAt(oR, sr, f, a, n).amp / 0.25), 'dB', null);
      if (!(dB(toneAt(oR, sr, f, a, n).amp / 0.25) < -60)) metro('Stéréo', `fuite à droite ${f} Hz`, -60, dB(toneAt(oR, sr, f, a, n).amp / 0.25), 'dB', 0);
    }
    // Coupure : à la fréquence affichée, la bande du dessous et celle du dessus pèsent autant.
    for (const [fc, lo, hi] of [[250, 'lowWidth', 'midWidth'], [4000, 'midWidth', 'highWidth']] as [number, string, string][]) {
      const n = Math.round(sr * 0.3);
      const L = sineIn(sr, 0.3, fc), R = Float32Array.from(L, v => -v);
      const base = { multiBand: true, lowWidth: 0, midWidth: 0, highWidth: 0, lowMidFreq: 250, midHighFreq: 4000 };
      const [a1] = await render(sr, 0.3, [L, R], spreadFx({ ...base, [lo]: 1 }));
      const [b1] = await render(sr, 0.3, [L, R], spreadFx({ ...base, [hi]: 1 }));
      const a = Math.round(0.1 * sr);
      const gLo = dB(toneAt(a1, sr, fc, a, n).amp / 0.25), gHi = dB(toneAt(b1, sr, fc, a, n).amp / 0.25);
      metro('Stéréo', `coupure ${fc} Hz : bande du dessous − bande du dessus, à ${fc} Hz`, 0, gLo - gHi, 'dB', 0.1);
    }
  }, 120_000);
  it('Haas : retard du côté droit = décalage × dose (±1 échantillon)', async () => {
    for (const sr of RATES) for (const [hd, ha] of [[0.015, 1], [0.03, 0.5], [0.01, 0.25]]) {
      const t0 = 0.01, x = impulse(sr, 0.06, t0, 0.5);
      const [, R] = await render(sr, 0.06, [x, x], spreadFx({ haasDelay: hd, haasAmount: ha }));
      const p = (peakPos(R, Math.round(t0 * sr) - 2, R.length) - t0 * sr) / sr * 1000;
      metro('Stéréo', `Haas ${hd * 1000} ms × dose ${ha * 100} %, ${sr} Hz`, hd * ha * 1000, p, 'ms', 1000 / sr + 1e-9);
    }
  });
});
