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

/** Rend `input` (canaux) à travers l'effet créé par `make`, dans un contexte hors ligne neuf. */
async function render(sr: number, seconds: number, input: Float32Array[], make: (ctx: BaseAudioContext) => Fx, before?: (fx: any, ctx: BaseAudioContext) => void): Promise<Float32Array[]> {
  const n = Math.round(seconds * sr);
  const ctx = new MiniOfflineAudioContext(2, n, sr) as unknown as OfflineAudioContext;
  const fx = make(ctx);
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

  it('durée affichée = RT60 mesuré aux fréquences moyennes (500 Hz et 1 kHz, ISO 3382 T30) ±5 %', () => {
    for (const sr of RATES) for (const mode of MODES) for (const decay of [0.6, 2.5, 6]) for (const damping of [0, 0.5]) {
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
