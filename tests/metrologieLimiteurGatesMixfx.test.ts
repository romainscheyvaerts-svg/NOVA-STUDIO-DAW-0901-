/**
 * Banc de métrologie (22/10/2026) : limiteur, Gate (porte de bruit), Mastering Transient,
 * compresseur multibande et EQ dynamique. Chaque réglage AFFICHÉ est comparé au son PRODUIT par
 * le cœur DSP réel (le même code que l'AudioWorklet, en lecture comme à l'export), à 44,1 et 48 kHz.
 *
 * Conventions (voir tests/metrologie/outils.ts et D:\1 WORK\CONTENU\nova-metrologie\partie_dynB.md) :
 *  - niveaux en crête dBFS (un sinus de crête −20 dBFS « vaut » −20 dB pour un seuil) ;
 *  - temps = constante de temps (63 %) de la grandeur pilotée : gain linéaire (limiteur, gate),
 *    niveau détecté (multibande, EQ dynamique) ;
 *  - plafond en crête vraie : mesureur ITU-R BS.1770-4 (×4, 48 points, celui des plateformes) et
 *    arbitre fin (×8, 128 points par phase, Kaiser β = 10) ;
 *  - coupures du multibande : Linkwitz-Riley 4e ordre, −6,02 dB par bande au point de coupure ;
 *  - Q de l'EQ dynamique : Q du passe-bande de la bande (−3 dB) ; la cloche à mi-gain a Q / √g.
 * Tolérances : fréquence ±1 %, gain ±0,1 dB, taux ±1 %, temps ±5 %, plafond ≤ affiché.
 *
 * TEST_VERBOSE=1 affiche le tableau des mesures (affiché → mesuré → écart).
 */
import { describe, expect, it, afterAll } from 'vitest';
import { createLimiterCore, limiterLatencySamples } from '../engine/limiterCore';
import { createNoiseGateCore } from '../engine/noiseGateCore';
import { V21EffectNode } from '../engine/v21Nodes';
import { DEFAULT_GATE } from '../engine/v21Params';
import { createMasterTransientCore } from '../engine/masterTransientCore';
import { MASTER_TRANSIENT_PROFILE } from '../engine/masterTransientProfile';
import { MT_DEFAULTS, MT_PRESETS, MT_CENTERS, mtToCore } from '../engine/masterTransientParams';
import { createMultibandCore } from '../engine/mixfx/multibandCore';
import { createDynEqCore } from '../engine/mixfx/dynEqCore';
import { MB_DEFAULTS, DYN_DEFAULTS, mbEffectiveCrossovers, dynBandDb } from '../engine/mixfx/mixFxParams';
import {
  sine, pinkNoise, truePeakOs, truePeakBs1770, runCore, concat, dbOf, tone, rms, peak, crossing,
  loadWorkletCode, runProcessor, noter, lignes, fmt,
} from './metrologie/outils';

const RATES = [44100, 48000];
const dc = (lvlDb: number, n: number) => new Float32Array(n).fill(Math.pow(10, lvlDb / 20));
const ligne = (effet: string, reglage: string, affiche: string, mesure: string, ecart: string, ok: boolean) => noter({ effet, reglage, affiche, mesure, ecart, ok });

/** Passe-bas Butterworth d'ordre `order` (contenu de « vrai » morceau : rien au-dessus de fc). */
function lowpass(x: Float32Array, fc: number, sr: number, order = 8) {
  let y = Float32Array.from(x);
  for (let s = 0; s < order / 2; s++) {
    const w0 = 2 * Math.PI * fc / sr, al = Math.sin(w0) / (2 * Math.SQRT1_2), cw = Math.cos(w0), a0 = 1 + al;
    const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const o = new Float32Array(y.length);
    for (let i = 0; i < y.length; i++) { const v = b0 * y[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = y[i]; y2 = y1; y1 = v; o[i] = v; }
    y = o;
  }
  return y;
}

/** Instant (s, interpolé) où la suite g (à partir de `from`) franchit `target` (montante ou descendante). */
function cross(g: ArrayLike<number>, from: number, target: number, sr: number): number {
  const up = g[from] < target;
  for (let i = from + 1; i < g.length; i++) {
    if (up ? g[i] >= target : g[i] <= target) {
      const a = g[i - 1], b = g[i];
      return (i - 1 - from + (b === a ? 0 : (target - a) / (b - a))) / sr;
    }
  }
  return NaN;
}

// ════════════════════════════════════════════════════════════════════════════════════════════
describe('Limiteur NOVA : métrologie', () => {
  const lim = (sr: number, p: Record<string, any>) => { const c = createLimiterCore(sr); c.setParams({ ceilingDb: -1, inputGainDb: 0, releaseMs: 100, lookaheadMs: 3, oversample: 4, ...p }); return c; };
  const out = (c: ReturnType<typeof createLimiterCore>, x: Float32Array) => { const lat = c.latencySamples(); return runCore(c, concat(x, new Float32Array(lat)))[0].subarray(lat); };

  for (const sr of RATES) {
    it(`${sr} Hz : gain d'entrée exact (sous le plafond)`, () => {
      for (const g of [0, 6, 12, 24]) {
        const y = out(lim(sr, { inputGainDb: g }), sine(997, sr, sr, -40));
        const m = tone(y, 997, sr, 4000, sr).db + 40;
        ligne('Limiteur', `Entrée +${g} dB (${sr})`, `+${g} dB`, `${fmt(m, 3)} dB`, fmt(m - g, 3), Math.abs(m - g) < 0.01);
        expect(Math.abs(m - g)).toBeLessThan(0.01);
      }
    });

    it(`${sr} Hz : latence mesurée = latence annoncée au PDC (anticipation + 32 échantillons)`, () => {
      for (const la of [0.5, 3, 10]) {
        const c = lim(sr, { lookaheadMs: la });
        const x = new Float32Array(4000); x[100] = 0.01;
        const [y] = runCore(c, x);
        let pk = 0; for (let i = 1; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[pk])) pk = i;
        const meas = pk - 100;
        ligne('Limiteur', `Anticipation ${fmt(la, 1)} ms (${sr})`, `${limiterLatencySamples(sr, la)} éch. (PDC)`, `${meas} éch. = ${fmt(meas / sr * 1000, 3)} ms`, String(meas - limiterLatencySamples(sr, la)), meas === limiterLatencySamples(sr, la));
        expect(meas).toBe(c.latencySamples());
        expect(meas).toBe(limiterLatencySamples(sr, la));
      }
    });

    it(`${sr} Hz : relâchement = constante de temps du gain (63 %), + moitié de l'anticipation ; vumètre = réduction réelle`, () => {
      for (const rel of [30, 100, 300, 1000]) {
        const c = lim(sr, { releaseMs: rel });
        const lat = c.latencySamples(), loudN = Math.round(0.3 * sr);
        const x = concat(dc(6, loudN), dc(-20, Math.round((rel * 6 / 1000 + 0.1) * sr)));
        const [yy] = runCore(c, x);
        const g = new Float64Array(x.length - lat);
        for (let i = 0; i < g.length; i++) g[i] = yy[i + lat] / x[i];
        const g0 = g[loudN - 10];
        let t0 = loudN; while (t0 < g.length && g[t0] <= g0 * (1 + 1e-6)) t0++;
        const tau = cross(g, t0, g0 + 0.632 * (1 - g0), sr) * 1000;
        const expected = rel + 0.5 * 3; // la rampe d'anticipation (moyenne glissante de 3 ms) ajoute L / 2
        ligne('Limiteur', `Relâchement ${rel} ms (${sr})`, `${rel} ms (+1,5 ms de rampe)`, `${fmt(tau)} ms`, `${fmt((tau - rel) / rel * 100, 1)} %`, Math.abs(tau - expected) / expected < 0.05);
        expect(Math.abs(tau - expected) / expected).toBeLessThan(0.05);
      }
      // Vumètre : réduction tenue (mesures relevées sur un passage stable).
      const c = lim(sr, {});
      const lat = c.latencySamples();
      const x = sine(997, sr, sr, 6);
      runCore(c, x);
      c.takeMeters();
      const [y] = runCore(c, sine(997, sr, 8192, 6, 2 * Math.PI * 997 * x.length / sr));
      const meter = c.takeMeters().grDb;
      const real = 6 - tone(y, 997, sr, lat, 8192).db;
      ligne('Limiteur', `Vumètre de réduction (${sr})`, `${fmt(meter, 3)} dB`, `${fmt(real, 3)} dB`, fmt(meter - real, 3), Math.abs(meter - real) < 0.05);
      expect(Math.abs(meter - real)).toBeLessThan(0.05);
    });

    it(`${sr} Hz : plafond en crête vraie (sinus inter-échantillons, près de fs/2, attaque brutale)`, () => {
      for (const os of [4, 8]) for (const ceil of [-1, -0.1]) {
        const cases: [string, number, Float32Array][] = [
          ['sinus fs/4 déphasé 45°', sr / 4, sine(sr / 4, sr, sr, 6, Math.PI / 4)],
          ['sinus 0,45·fs', 0.45 * sr, sine(0.45 * sr, sr, sr, 6, 0.3)],
          ['sinus 997 Hz +12 dB', 997, sine(997, sr, sr, 12)],
        ];
        for (const [nm, f, x] of cases) {
          const y = out(lim(sr, { ceilingDb: ceil, oversample: os }), x);
          const tp = tone(y, f, sr, 4000, sr).db;  // crête vraie d'un sinus tenu = son amplitude
          ligne('Limiteur', `${nm}, ×${os}, plafond ${ceil} (${sr})`, `≤ ${ceil} dBTP`, `${fmt(tp, 3)} dBTP`, fmt(tp - ceil, 3), tp <= ceil + 1e-3);
          expect(tp).toBeLessThanOrEqual(ceil + 1e-3);
        }
        // Attaque brutale : silence puis sinus +12 dBFS, dès le premier échantillon.
        const step = concat(new Float32Array(2000), sine(3000, sr, 6000, 12));
        const ys = out(lim(sr, { ceilingDb: ceil, oversample: os }), step);
        const tps = dbOf(truePeakOs(ys));
        ligne('Limiteur', `Attaque brutale +12 dB, ×${os}, plafond ${ceil} (${sr})`, `≤ ${ceil} dBTP`, `${fmt(tps, 3)} dBTP`, fmt(tps - ceil, 3), tps <= ceil + 1e-3);
        expect(tps).toBeLessThanOrEqual(ceil + 1e-3);
      }
    });

    it(`${sr} Hz : plafond sur bruit rose poussé (+12 dB de crête) : BS.1770 ≤ plafond`, () => {
      const pinkFull = pinkNoise(sr, 0, 3);
      const pink20k = lowpass(pinkFull, Math.min(20000, sr * 0.43), sr);
      for (const os of [4, 8]) {
        const yf = out(lim(sr, { oversample: os }), pinkFull).subarray(2000);
        const y2 = out(lim(sr, { oversample: os }), pink20k).subarray(2000);
        const bsF = dbOf(truePeakBs1770(yf)), hqF = dbOf(truePeakOs(yf));
        const bs2 = dbOf(truePeakBs1770(y2)), hq2 = dbOf(truePeakOs(y2));
        ligne('Limiteur', `Rose plein spectre, ×${os} (${sr})`, '≤ −1 dBTP', `BS.1770 ${fmt(bsF, 3)} / fin ${fmt(hqF, 3)}`, fmt(bsF + 1, 3), bsF <= -1 + 1e-3);
        ligne('Limiteur', `Rose ≤ ${Math.round(Math.min(20000, sr * 0.43) / 100) / 10} kHz, ×${os} (${sr})`, '≤ −1 dBTP', `BS.1770 ${fmt(bs2, 3)} / fin ${fmt(hq2, 3)}`, fmt(Math.max(bs2, hq2) + 1, 3), Math.max(bs2, hq2) <= -1 + 1e-3);
        expect(bsF).toBeLessThanOrEqual(-1 + 1e-3);           // mesureur des plateformes
        expect(Math.max(bs2, hq2)).toBeLessThanOrEqual(-1 + 1e-3);
        // Limite connue (interpolateur de 32 points) : énergie entre 0,43 et 0,5·fs : l'arbitre fin
        // lit jusqu'à +0,35 dB. Garde-fou contre une régression.
        expect(hqF).toBeLessThan(-1 + 0.45);
      }
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════
describe('Gate (porte de bruit) : métrologie', () => {
  const gate = (sr: number, p: Record<string, number>) => { const c = createNoiseGateCore(sr); c.setParams({ threshold: -40, range: 80, attack: 0.5, hold: 20, release: 80, ...p }); c.reset(); return c; };

  for (const sr of RATES) {
    it(`${sr} Hz : seuil d'ouverture = seuil affiché (crête du sinus), fermeture ≈ 4 dB plus bas`, () => {
      for (const T of [-60, -40, -20]) {
        const opens = (lvl: number) => { const x = sine(1000, sr, Math.round(0.1 * sr), lvl); const [y] = runCore(gate(sr, { threshold: T }), x); return rms(y, y.length - 2400) / rms(x, x.length - 2400) > 0.5; };
        let lo = T - 3, hi = T + 3;
        for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (opens(m)) hi = m; else lo = m; }
        const closes = (lvl: number) => {
          const x = concat(sine(1000, sr, Math.round(0.05 * sr), T + 10), sine(1000, sr, Math.round(0.3 * sr), lvl, 2 * Math.PI * 1000 * 0.05));
          const [y] = runCore(gate(sr, { threshold: T }), x);
          return rms(y, y.length - 2400) / rms(x, x.length - 2400) < 0.5;
        };
        let lo2 = T - 6, hi2 = T;
        for (let i = 0; i < 30; i++) { const m = (lo2 + hi2) / 2; if (closes(m)) lo2 = m; else hi2 = m; }
        ligne('Gate', `Seuil ${T} dB (${sr})`, `${T} dB`, `ouvre à ${fmt(hi, 3)} dB, ferme sous ${fmt(lo2, 2)} dB`, fmt(hi - T, 3), Math.abs(hi - T) < 0.05);
        expect(Math.abs(hi - T)).toBeLessThan(0.05);
        expect(lo2).toBeLessThan(T - 3.7);
        expect(lo2).toBeGreaterThan(T - 4.05);
      }
    });

    it(`${sr} Hz : plage (atténuation porte fermée) exacte`, () => {
      for (const R of [6, 18, 40, 80]) {
        const x = dc(-60, Math.round(0.2 * sr));
        const [y] = runCore(gate(sr, { range: R }), x);
        const m = -dbOf(y[y.length - 1] / x[0]);
        ligne('Gate', `Plage ${R} dB (${sr})`, `${R} dB`, `${fmt(m, 4)} dB`, fmt(m - R, 4), Math.abs(m - R) < 0.01);
        expect(Math.abs(m - R)).toBeLessThan(0.01);
      }
    });

    it(`${sr} Hz : ouverture et fermeture = constantes de temps (63 % du gain linéaire)`, () => {
      for (const A of [0.5, 1, 5, 20, 50]) {
        const n0 = 1000, x = concat(dc(-70, n0), dc(-10, Math.round((A * 6 / 1000 + 0.05) * sr)));
        const [y] = runCore(gate(sr, { attack: A }), x);
        const g = Array.from(y, (v, i) => v / x[i]);
        const tau = cross(g, n0 - 1, g[n0 - 1] + 0.632 * (1 - g[n0 - 1]), sr) * 1000;
        ligne('Gate', `Ouverture ${A} ms (${sr})`, `${A} ms`, `${fmt(tau, 3)} ms`, `${fmt((tau - A) / A * 100, 1)} %`, Math.abs(tau - A) / A < 0.05);
        expect(Math.abs(tau - A) / A).toBeLessThan(0.05);
      }
      for (const Rl of [10, 80, 300]) {
        const n0 = Math.round(0.1 * sr), x = concat(dc(-20, n0), dc(-70, Math.round((Rl * 6 / 1000 + 0.2) * sr)));
        const [y] = runCore(gate(sr, { release: Rl, hold: 0 }), x);
        const g = Array.from(y, (v, i) => v / x[i]);
        let t0 = n0; while (g[t0] >= 0.999999) t0++;
        const tau = cross(g, t0 - 1, 1 - 0.632 * (1 - 1e-4), sr) * 1000;
        ligne('Gate', `Fermeture ${Rl} ms (${sr})`, `${Rl} ms`, `${fmt(tau)} ms`, `${fmt((tau - Rl) / Rl * 100, 1)} %`, Math.abs(tau - Rl) / Rl < 0.05);
        expect(Math.abs(tau - Rl) / Rl).toBeLessThan(0.05);
      }
    });

    it(`${sr} Hz : maintien compté depuis le passage de la détection sous le seuil (retombée 10 ms)`, () => {
      for (const [H, lvl] of [[0, -20], [20, -20], [100, -20], [20, -30]]) {
        const n0 = Math.round(0.1 * sr), x = concat(dc(lvl, n0), dc(-70, Math.round(0.5 * sr)));
        const [y] = runCore(gate(sr, { hold: H }), x);
        const g = Array.from(y, (v, i) => v / x[i]);
        let t0 = n0; while (g[t0] >= 0.999999) t0++;
        const meas = (t0 - n0) / sr * 1000;
        // Détection crête : retombée exponentielle (10 ms) de lvl vers le son restant (−70 dB), jusqu'au
        // seuil (−40) puis jusqu'à la fermeture (−44).
        const L = Math.pow(10, lvl / 20), a = Math.pow(10, -70 / 20);
        const decayOpen = 10 * Math.log((L - a) / (Math.pow(10, -40 / 20) - a));
        const decayClose = 10 * Math.log((L - a) / (Math.pow(10, -44 / 20) - a));
        const expected = Math.max(decayOpen + H, decayClose);
        ligne('Gate', `Maintien ${H} ms, son à ${lvl} dB (${sr})`, `${H} ms (+ ${fmt(decayOpen, 1)} ms de détection)`, `${fmt(meas)} ms`, fmt(meas - expected, 2), Math.abs(meas - expected) < 0.2);
        expect(Math.abs(meas - expected)).toBeLessThan(0.2);
      }
    });

    it(`${sr} Hz : même mesure à travers le code du worklet (réglages passés en AudioParam)`, () => {
      const fakeCtx: any = { sampleRate: sr, currentTime: 0, createGain: () => ({ connect() {}, disconnect() {}, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' }) };
      const spec = (new V21EffectNode(fakeCtx, 'GATE', {}) as any).spec;
      const run = loadWorkletCode(spec.code, sr);
      const P = run.classes[spec.processor];
      const params = { ...DEFAULT_GATE, threshold: -30, range: 24, attack: 1, hold: 50, release: 40 } as any;
      const proc = new P({ processorOptions: { params } });
      const n0 = Math.round(0.1 * sr), x = concat(dc(-10, n0), dc(-70, Math.round(0.8 * sr)));
      const [y] = runProcessor(run, proc, [[x, x]], 2, { threshold: -30, range: 24, attack: 1, hold: 50, release: 40, keyOn: 0, keyListen: 0 });
      const c = gate(sr, { threshold: -30, range: 24, attack: 1, hold: 50, release: 40 });
      const [yc] = runCore(c, x);
      let d = 0; for (let i = 0; i < y.length; i++) d = Math.max(d, Math.abs(y[i] - yc[i]));
      expect(d).toBeLessThan(1e-7);
      expect(dbOf(y[y.length - 1] / x[x.length - 1])).toBeCloseTo(-24, 3);
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════
describe('Mastering Transient : métrologie', () => {
  const NEUTRAL = { emphasis: 0, adaptive: 0, limitGain: 0, clipDrive: 0 };
  const make = (sr: number, p: Record<string, number>) => { const c = createMasterTransientCore(sr, MASTER_TRANSIENT_PROFILE as any, createLimiterCore); c.setParams(mtToCore({ ...MT_DEFAULTS, ...p })); return c; };
  const out = (c: any, x: Float32Array) => { const lat = c.latencySamples(); return runCore(c, concat(x, new Float32Array(lat)))[0].subarray(lat); };

  for (const sr of RATES) {
    it(`${sr} Hz : latence, gains d'entrée / de sortie`, () => {
      const c = make(sr, NEUTRAL);
      const x = new Float32Array(Math.round(0.05 * sr)); x[1000] = 0.1;
      const [y] = runCore(c, x);
      let pk = 0; for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[pk])) pk = i;
      expect(pk - 1000).toBe(c.latencySamples());
      for (const [gi, go] of [[6, 0], [0, -6], [-12, 12]]) {
        const m = tone(out(make(sr, { ...NEUTRAL, limiterOn: 0, inputGain: gi, outputGain: go }), sine(1000, sr, sr / 2, -30)), 1000, sr, sr / 4, sr / 2).db + 30;
        ligne('Mastering Transient', `Entrée ${gi} / sortie ${go} dB (${sr})`, `${gi + go} dB`, `${fmt(m, 4)} dB`, fmt(m - gi - go, 4), Math.abs(m - gi - go) < 0.01);
        expect(Math.abs(m - gi - go)).toBeLessThan(0.01);
      }
    });

    it(`${sr} Hz : afficheurs « Réduction » et « Emphase » = gains réellement appliqués`, () => {
      for (const lv of [-10, -2]) {
        const c = make(sr, { ...NEUTRAL, limitGain: 8, speed: 1, adaptiveGain: 0, adaptiveSpeed: 0, ceiling: -0.1, truePeak: 1, limiterOn: 1 });
        const n = Math.round(0.8 * sr), lat = c.latencySamples();
        const [y] = runCore(c, concat(sine(1000, sr, n, lv), new Float32Array(lat)));
        c.takeMeters();
        runCore(c, sine(1000, sr, Math.round(0.2 * sr), lv, 2 * Math.PI * 1000 * (n + lat) / sr));
        const meter = c.takeMeters().grDb;
        const real = 8 - (tone(y, 1000, sr, lat + n - sr / 4, lat + n).db - lv);
        ligne('Mastering Transient', `Réduction, sinus ${lv} dBFS, gain +8 (${sr})`, `${fmt(meter, 3)} dB`, `${fmt(real, 3)} dB`, fmt(meter - real, 3), Math.abs(meter - real) < 0.05);
        expect(Math.abs(meter - real)).toBeLessThan(0.05);
      }
      for (const e of [27, 100]) {
        const c = make(sr, { ...NEUTRAL, emphasis: e });
        const n = Math.round(0.4 * sr), on = Math.round(0.1 * sr), w = Math.round(sr / 1000);
        const x = new Float32Array(n); for (let i = on; i < n; i++) x[i] = 0.1 * Math.sin(2 * Math.PI * 1000 * (i - on) / sr);
        const y = out(c, x);
        const meter = c.takeMeters().emphDb;
        let best = -99;
        for (let k = 0; k < 40; k++) best = Math.max(best, dbOf(rms(y, on + k * w, on + (k + 1) * w) / rms(x, on + k * w, on + (k + 1) * w)));
        ligne('Mastering Transient', `Emphase ${e} % : afficheur (${sr})`, `${fmt(meter)} dB`, `${fmt(best)} dB (fenêtres de 1 ms)`, fmt(meter - best, 2), Math.abs(meter - best) < 0.1);
        expect(Math.abs(meter - best)).toBeLessThan(0.1);
      }
    });

    it(`${sr} Hz : plafond tenu avec le « gain adaptatif » (avant : écrêtage de sécurité, +1,3 dBTP)`, () => {
      const pr = MT_PRESETS.find(p => p.id === 'romain')!.params;
      const full = pinkNoise(sr * 1.5, -12, 5);
      const lp = lowpass(full, Math.min(20000, sr * 0.43), sr);
      const ceil = pr.ceiling;
      for (const [nm, x] of [['rose ≤ 19 kHz', lp], ['rose plein spectre', full]] as [string, Float32Array][]) {
        const y = out(make(sr, pr), x).subarray(sr / 4);
        const c = Math.pow(10, ceil / 20);
        let clipped = 0; for (const v of y) if (Math.abs(v) >= c * 0.99999) clipped++;
        const bs = dbOf(truePeakBs1770(y)), hq = dbOf(truePeakOs(y));
        ligne('Mastering Transient', `PRE MASTER Romain, ${nm} −12 dB RMS (${sr})`, `≤ ${ceil} dBTP`, `BS.1770 ${fmt(bs, 3)} / fin ${fmt(hq, 3)} ; ${clipped} éch. écrêtés`, fmt(bs - ceil, 3), clipped === 0 && bs <= ceil + 0.1);
        expect(clipped).toBe(0);
        if (nm.includes('19')) expect(Math.max(bs, hq)).toBeLessThanOrEqual(ceil + 1e-3);
        else expect(bs).toBeLessThanOrEqual(ceil + 0.2);    // limite connue de l'interpolateur (énergie > 0,43·fs)
      }
    });

    it(`${sr} Hz : gain par bande +6 dB au centre de la bande (formes mesurées sur l'original)`, () => {
      for (const b of [2, 8, 14, 20, 25]) {
        const f = Math.min(MT_CENTERS[b - 1], sr * 0.45);
        const m = tone(out(make(sr, { ...NEUTRAL, [`bg${b}`]: 6 }), sine(f, sr, sr / 2, -30)), f, sr, sr / 4, sr / 2).db + 30;
        ligne('Mastering Transient', `Bande ${b} (${Math.round(f)} Hz) +6 dB (${sr})`, '+6 dB', `${fmt(m)} dB`, fmt(m - 6, 2), m > 4.5 && m < 6.05);
        // Couleur voulue (modèle boîte noire) : l'original n'atteint pas +6 dB pile au centre.
        expect(m).toBeGreaterThan(4.5);
        expect(m).toBeLessThan(6.05);
      }
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════
describe('Compresseur multibande : métrologie', () => {
  const tonal = (sr: number, p: Record<string, any>, f: number, lvl = -20) => {
    const c = createMultibandCore(sr); c.setParams(p);
    const n = Math.round(Math.max(0.15, 30 / f) * sr);
    const [y] = runCore(c, sine(f, sr, n, lvl));
    return tone(y, f, sr, n >> 1, n).db - lvl;
  };

  for (const sr of RATES) {
    it(`${sr} Hz : coupures Linkwitz-Riley à −6,02 dB pile, somme plate`, () => {
      const p = { ...MB_DEFAULTS, bands: 4, x1: 120, x2: 1500, x3: 9000 };
      for (const k of [1, 2, 3]) {
        const x = (p as any)[`x${k}`];
        const lo = tonal(sr, { ...p, [`b${k}Solo`]: 1 }, x), hi = tonal(sr, { ...p, [`b${k + 1}Solo`]: 1 }, x);
        const f6 = crossing(f => tonal(sr, { ...p, [`b${k}Solo`]: 1 }, f), -6.0206, x / 1.5, x * 1.5, 30);
        ligne('Multibande', `Coupure ${k} = ${x} Hz (${sr})`, `${x} Hz à −6,02 dB`, `${fmt(f6, 1)} Hz ; bandes ${fmt(lo, 3)} / ${fmt(hi, 3)} dB`, `${fmt((f6 - x) / x * 100, 2)} %`, Math.abs(f6 - x) / x < 0.01);
        expect(Math.abs(f6 - x) / x).toBeLessThan(0.01);
        expect(Math.abs(lo + 6.0206)).toBeLessThan(0.05);
        expect(Math.abs(hi + 6.0206)).toBeLessThan(0.05);
      }
      let worst = 0;
      for (const f of [25, 60, 120, 400, 1500, 3000, 9000, 15000, 19000]) worst = Math.max(worst, Math.abs(tonal(sr, p, f)));
      ligne('Multibande', `Somme des bandes (${sr})`, '0 dB', `écart max ${fmt(worst, 4)} dB`, fmt(worst, 4), worst < 0.05);
      expect(worst).toBeLessThan(0.05);
    });

    it(`${sr} Hz : coupures trop proches : la fenêtre affiche la coupure réelle`, () => {
      for (const [x1, x2, x3] of [[200, 220, 12000], [1000, 1000, 1000]]) {
        // 3 bandes : la bande 3 va jusqu'en haut (LP3² + HP3² = passe-tout), la coupure 2 se lit seule.
        const p = { ...MB_DEFAULTS, bands: 3, x1, x2, x3 };
        const shown = mbEffectiveCrossovers(p, sr);
        const real2 = crossing(f => tonal(sr, { ...p, b2Solo: 1 }, f) - tonal(sr, { ...p, b3Solo: 1 }, f), 0, shown[0] * 1.05, 20000, 30);
        ligne('Multibande', `Coupure 2 réglée ${x2} Hz après ${x1} Hz (${sr})`, `${fmt(shown[1], 1)} Hz (affiché)`, `${fmt(real2, 1)} Hz`, `${fmt((real2 - shown[1]) / shown[1] * 100, 2)} %`, Math.abs(real2 - shown[1]) / shown[1] < 0.01);
        expect(Math.abs(real2 - shown[1]) / shown[1]).toBeLessThan(0.01);
      }
    });

    it(`${sr} Hz : seuil et taux exacts quels que soient attaque et relâchement ; vumètre = réduction réelle`, () => {
      for (const [att, rel] of [[10, 200], [0.1, 200], [50, 200], [30, 30], [200, 50]]) {
        for (const lvl of [-20, -6]) {
          const c = createMultibandCore(sr);
          c.setParams({ ...MB_DEFAULTS, bands: 3, x1: 100, x2: 8000, knee: 0, b2Thr: -30, b2Ratio: 4, b2Att: att, b2Rel: rel });
          const n = Math.round((att * 8 / 1000 + 0.5) * sr);
          const [y] = runCore(c, sine(1000, sr, n, lvl));
          const gr = -(tone(y, 1000, sr, n - 9600, n).db - lvl);
          const expected = (lvl + 30) * 0.75;
          const meter = c.takeMeters().grNow[1];
          ligne('Multibande', `Seuil −30, 4:1, att ${att} / rel ${rel} ms, sinus ${lvl} dBFS (${sr})`, `−${fmt(expected)} dB`, `−${fmt(gr, 3)} dB (vumètre ${fmt(meter, 3)})`, fmt(gr - expected, 3), Math.abs(gr - expected) < 0.1);
          expect(Math.abs(gr - expected)).toBeLessThan(0.1);
          expect(Math.abs(meter - gr)).toBeLessThan(0.05);
        }
      }
    });

    it(`${sr} Hz : attaque et relâchement = constantes de temps du niveau détecté`, () => {
      const thr = -60, k = 0.75;
      for (const [att, rel] of [[10, 200], [1, 50], [50, 500]]) {
        // Sinus 1 kHz dans la bande 2, coupures loin (20 Hz / 20 kHz) ; marche de −50 à −10 dBFS puis retour.
        const nUp = Math.round((att * 8 + 50) / 1000 * sr), nDn = Math.round((rel * 6 + 50) / 1000 * sr);
        const n0 = Math.round(0.3 * sr), N = n0 + nUp + nDn;
        const x = new Float32Array(N);
        for (let i = 0; i < N; i++) x[i] = Math.pow(10, (i < n0 || i >= n0 + nUp ? -50 : -10) / 20) * Math.sin(2 * Math.PI * 1000 * i / sr);
        const p = { ...MB_DEFAULTS, bands: 3, x1: 20, x2: 20000, knee: 0, b2Thr: thr, b2Ratio: 4, b2Att: att, b2Rel: rel };
        const c = createMultibandCore(sr);
        c.setParams(p);
        // Niveau détecté relu dans le vumètre de la bande, à chaque échantillon (réduction = taux × dépassement).
        const lvl = new Float64Array(N);
        const o = new Float32Array(1);
        for (let i = 0; i < N; i++) { c.process(x.subarray(i, i + 1), x.subarray(i, i + 1), o, o, 1); lvl[i] = Math.pow(10, (c.takeMeters().grNow[1] / k + thr) / 20); }
        // Le détecteur est EXACTEMENT celui documenté (crête relâchée en « rel », niveau qui monte en « att »).
        const solo = createMultibandCore(sr); solo.setParams({ ...p, b2Ratio: 1, b2Solo: 1 });
        const [band] = runCore(solo, x);
        const cA = 1 - Math.exp(-1 / (att * 0.001 * sr)), cR = 1 - Math.exp(-1 / (rel * 0.001 * sr));
        let pk = 0, ev = 0, dev = 0;
        for (let i = 0; i < N; i++) {
          const v = Math.abs(band[i]); pk = v > pk ? v : pk + (v - pk) * cR; ev = pk > ev ? ev + (pk - ev) * cA : pk;
          if (ev > Math.pow(10, thr / 20)) dev = Math.max(dev, Math.abs(lvl[i] - ev) / ev);
        }
        expect(dev).toBeLessThan(1e-5);
        const s1 = n0, s2 = n0 + nUp;
        const a = lvl[s1 - 1], b = lvl[s2 - 1], e = lvl[N - 1];
        const tA = cross(lvl, s1 - 1, a + 0.632 * (b - a), sr) * 1000;
        const tR = cross(lvl, s2 - 1, b - 0.632 * (b - e), sr) * 1000;
        // Sur un sinus, la montée part de la 1re crête (≤ ¼ de période, 0,25 ms à 1 kHz).
        const tolA = 0.05 * att + 0.25;
        ligne('Multibande', `Attaque ${att} ms, sinus 1 kHz (${sr})`, `${att} ms`, `${fmt(tA, 3)} ms`, `${fmt((tA - att) / att * 100, 1)} %`, Math.abs(tA - att) < tolA);
        ligne('Multibande', `Relâchement ${rel} ms, sinus 1 kHz (${sr})`, `${rel} ms`, `${fmt(tR, 2)} ms`, `${fmt((tR - rel) / rel * 100, 1)} %`, Math.abs(tR - rel) / rel < 0.05);
        expect(Math.abs(tA - att)).toBeLessThan(tolA);
        expect(Math.abs(tR - rel) / rel).toBeLessThan(0.05);
      }
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════
describe('EQ dynamique : métrologie', () => {
  /** Réponse (dB) d'une bande au gain tenu (clé forte au centre : la plage est atteinte), sonde à f. */
  function bandResp(sr: number, f0: number, Q: number, range: number, f: number) {
    const c = createDynEqCore(sr);
    c.setParams({ ...DYN_DEFAULTS, d1On: 0, d2On: 1, d3On: 0, d4On: 0, d2Freq: f0, d2Q: Q, d2Thr: -80, d2Range: range, d2Att: 0.1, d2Rel: 2000 });
    const n = Math.round(Math.max(0.2, 40 / f) * sr);
    const key = sine(f0, sr, n, -20), x = sine(f, sr, n, -40, 0.3);
    const y = new Float32Array(n), yr = new Float32Array(n);
    for (let i = 0; i < n; i += 128) { const m = Math.min(128, n - i); c.process(x.subarray(i, i + m), x.subarray(i, i + m), y.subarray(i, i + m), yr.subarray(i, i + m), m, key.subarray(i, i + m), key.subarray(i, i + m)); }
    return tone(y, f, sr, n >> 1, n).db + 40;
  }
  /** Réponse (dB) de l'écoute de la bande (le passe-bande seul, ce que surveille le détecteur). */
  function listenResp(sr: number, f0: number, Q: number, f: number) {
    const c = createDynEqCore(sr);
    c.setParams({ ...DYN_DEFAULTS, d1On: 0, d2On: 1, d3On: 0, d4On: 0, d2Freq: f0, d2Q: Q, d2Range: 0, listen: 2 });
    const n = Math.round(Math.max(0.2, 40 / f) * sr);
    const [y] = runCore(c, sine(f, sr, n, -20));
    return tone(y, f, sr, n >> 1, n).db + 20;
  }

  for (const sr of RATES) {
    it(`${sr} Hz : fréquence centrale, gain au centre = plage, Q de la bande exact jusque dans l'aigu`, () => {
      for (const [f0, Q] of [[100, 2], [1000, 0.7], [3500, 5], [10000, 2], [16000, 4]]) {
        const lo = crossing(f => listenResp(sr, f0, Q, f), -3.0103, f0 / 20, f0 * 0.999, 30);
        const hi = crossing(f => listenResp(sr, f0, Q, f), -3.0103, f0 * 1.001, sr * 0.4999, 30);
        const qm = Math.sqrt(lo * hi) / (hi - lo);
        // Préwarping RBJ de la largeur : exact dans le grave et le médium, ≤ 1,7 % au-delà de 0,3·fs (16 kHz à 44,1 kHz).
        const tolQ = f0 > 0.3 * sr ? 0.02 : 0.01;
        ligne('EQ dynamique', `Q ${Q} à ${f0} Hz : bande écoutée à −3 dB (${sr})`, `Q ${Q}`, `Q ${fmt(qm, 3)} (${fmt(lo, 1)}–${fmt(hi, 1)} Hz)`, `${fmt((qm - Q) / Q * 100, 2)} %`, Math.abs(qm - Q) / Q < tolQ);
        expect(Math.abs(qm - Q) / Q).toBeLessThan(tolQ);
        for (const range of [-6, 6]) {
          const g0 = bandResp(sr, f0, Q, range, f0);
          ligne('EQ dynamique', `Plage ${range} dB à ${f0} Hz : gain au centre (${sr})`, `${range} dB`, `${fmt(g0, 3)} dB`, fmt(g0 - range, 3), Math.abs(g0 - range) < 0.02);
          expect(Math.abs(g0 - range)).toBeLessThan(0.02);
          // Mi-gain (dB) : la cloche a un Q de Q / √g.
          const lo2 = crossing(f => bandResp(sr, f0, Q, range, f), range / 2, f0 / 20, f0 * 0.999, 26);
          const hi2 = crossing(f => bandResp(sr, f0, Q, range, f), range / 2, f0 * 1.001, sr * 0.4999, 26);
          const qMid = Math.sqrt(lo2 * hi2) / (hi2 - lo2), qTh = Q / Math.sqrt(Math.pow(10, range / 20));
          ligne('EQ dynamique', `Q ${Q} à ${f0} Hz, plage ${range} : cloche à mi-gain (${sr})`, `Q/√g = ${fmt(qTh, 3)}`, `${fmt(qMid, 3)}`, `${fmt((qMid - qTh) / qTh * 100, 2)} %`, Math.abs(qMid - qTh) / qTh < 0.03);
          expect(Math.abs(qMid - qTh) / qTh).toBeLessThan(0.03);   // ≤ 2,2 % dans l'aigu (loi analogique, préwarping du passe-bande)
        }
      }
    });

    it(`${sr} Hz : courbe dessinée dans la fenêtre = réponse mesurée`, () => {
      let worst = 0;
      for (const [f0, Q, range] of [[3500, 5, -3], [10000, 2, -6], [250, 0.7, 9]]) {
        for (const f of [f0 / 4, f0 / 2, f0 / 1.2, f0, f0 * 1.2, Math.min(f0 * 2, sr * 0.45), Math.min(f0 * 4, sr * 0.45)]) {
          worst = Math.max(worst, Math.abs(bandResp(sr, f0, Q, range, f) - dynBandDb(f, f0, Q, range, sr)));
        }
      }
      ligne('EQ dynamique', `Courbe affichée vs mesurée (${sr})`, 'écart 0 dB', `écart max ${fmt(worst, 4)} dB`, fmt(worst, 4), worst < 0.02);
      expect(worst).toBeLessThan(0.02);
    });

    it(`${sr} Hz : seuil exact quels que soient attaque et relâchement ; vumètre = gain réel`, () => {
      for (const [att, rel] of [[5, 100], [0.1, 100], [50, 100], [30, 30], [200, 50]]) {
        for (const lvl of [-14, -8]) {
          const c = createDynEqCore(sr);
          c.setParams({ ...DYN_DEFAULTS, d1On: 0, d2On: 1, d3On: 0, d4On: 0, d2Freq: 1000, d2Q: 2, d2Thr: -20, d2Range: -24, d2Att: att, d2Rel: rel });
          const n = Math.round((att * 8 / 1000 + 0.5) * sr);
          const [y] = runCore(c, sine(1000, sr, n, lvl));
          const g = tone(y, 1000, sr, n - 9600, n).db - lvl;
          const expected = -(lvl + 20);   // au-delà du genou de 3 dB : 1 dB de dépassement = 1 dB de gain
          const meter = c.takeMeters().gainNow[1];
          ligne('EQ dynamique', `Seuil −20, att ${att} / rel ${rel} ms, sinus ${lvl} dBFS (${sr})`, `${fmt(expected)} dB`, `${fmt(g, 3)} dB (vumètre ${fmt(meter, 3)})`, fmt(g - expected, 3), Math.abs(g - expected) < 0.1);
          expect(Math.abs(g - expected)).toBeLessThan(0.1);
          expect(Math.abs(meter - g)).toBeLessThan(0.05);
        }
      }
    });
  }
});

afterAll(() => {
  if (!process.env.TEST_VERBOSE) return;
  const rows = lignes.filter(l => ['Limiteur', 'Gate', 'Mastering Transient', 'Multibande', 'EQ dynamique'].includes(l.effet));
  console.log('| Effet | Réglage | Affiché | Mesuré | Écart | Verdict |\n|---|---|---|---|---|---|\n' +
    rows.map(l => `| ${l.effet} | ${l.reglage} | ${l.affiche} | ${l.mesure} | ${l.ecart} | ${l.ok ? 'OK' : 'ÉCART'} |`).join('\n'));
});
