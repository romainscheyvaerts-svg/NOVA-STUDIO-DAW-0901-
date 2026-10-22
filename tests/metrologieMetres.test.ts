/**
 * Métrologie des MÈTRES (22/10/2026) : ce que l'écran affiche = ce qui est mesuré.
 *
 *  - LUFS momentané / court terme / intégré et LRA (ITU-R BS.1770-4, EBU Tech 3341 / 3342),
 *    en direct (noyau AudioWorklet + LoudnessMeter) ET hors ligne (export, distribution),
 *    à 44,1 et 48 kHz, avec les signaux de test EBU ; tolérance ±0,1 LU (LRA : ±1 LU, Tech 3342) ;
 *  - crête échantillon (dBFS) et crête vraie (dBTP, ×4) : ±0,1 dB ;
 *  - corrélation de phase ;
 *  - vumètre : 0 VU = sinus de référence annoncé (−18 dBFS), balistique 99 % en 300 ms,
 *    dans les conditions réelles (un message toutes les 33 ms, images entre deux) ;
 *  - analyseur de spectre : niveau et fréquence d'un sinus.
 *
 * Chaque mesure est notée dans le journal du banc (tests/helpers/metro.ts).
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createMeterCore } from '../engine/meters/meterCore';
import { LoudnessMeter, correlationOf } from '../engine/meters/loudness';
import { meterBank } from '../engine/meters/meterBank';
import { METER_SCALES, scaleById, meterMainDb, scaleReading } from '../engine/meters/scales';
import { octaveSmooth, SPECTRUM_SINE_DB } from '../engine/meters/spectrum';
import { integratedLufs, truePeakDb } from '../utils/loudness';
import { loudnessRangeOf, lufsOf } from '../utils/audioMeasure';
import { installMiniWebAudio, MiniOfflineAudioContext } from './helpers/miniWebAudio';
import { dB, flushMetroLog, metro } from './helpers/metro';

const RATES = [44100, 48000];

function tone(sr: number, seconds: number, f: number, dbfs: number, phase = 0) {
  const n = Math.round(seconds * sr), a = Math.pow(10, dbfs / 20), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = a * Math.sin(2 * Math.PI * f * i / sr + phase);
  return x;
}
const cat = (...xs: Float32Array[]) => { const o = new Float32Array(xs.reduce((s, x) => s + x.length, 0)); let k = 0; for (const x of xs) { o.set(x, k); k += x.length; } return o; };
/** Attaque douce (20 ms) : pas de vraie crête de Gibbs au premier échantillon. */
const soft = (x: Float32Array, sr: number) => { const f = Math.round(0.02 * sr); for (let i = 0; i < f; i++) x[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / f); return x; };

/** Le noyau des mètres par blocs de 128 (comme l'AudioWorklet), relevé 30 fois par seconde. */
function live(L: Float32Array, R: Float32Array, sr: number, opt = { loudness: true, tpTaps: 16, tpGate: false }) {
  const core = createMeterCore(sr, opt);
  const lm = new LoudnessMeter();
  const every = Math.max(1, Math.round(sr / 30 / 128));
  let tp = 0, pk = 0, cnt = 0, mMax = -Infinity;
  for (let s = 0; s < L.length; s += 128) {
    const k = Math.min(128, L.length - s);
    core.process(L.subarray(s, s + k), R.subarray(s, s + k), k);
    if (++cnt % every === 0 || s + k >= L.length) {
      const t = core.take();
      tp = Math.max(tp, t.tpL, t.tpR); pk = Math.max(pk, t.peakL, t.peakR);
      for (const e of t.k) { lm.push(e); mMax = Math.max(mMax, lm.momentary()); }
    }
  }
  return { lm, tp, pk, mMax };
}

afterAll(() => flushMetroLog('metres'));

describe('LUFS en direct (noyau des mètres) — EBU Tech 3341', () => {
  for (const sr of RATES) {
    it(`${sr} Hz : cas 1 et 2 (sinus 1 kHz stéréo −23 / −33 dBFS) — M, S, I = niveau ±0,1 LU`, () => {
      for (const lvl of [-23, -33]) {
        const x = tone(sr, 20, 1000, lvl);
        const r = live(x, x, sr);
        const m = r.lm.momentary(), s = r.lm.shortTerm(), I = r.lm.integrated();
        expect(metro('LUFS momentané (direct)', `sinus 1 kHz ${lvl} dBFS, ${sr} Hz`, lvl, m, 'LUFS', 0.1)).toBe(true);
        expect(metro('LUFS court terme (direct)', `sinus 1 kHz ${lvl} dBFS, ${sr} Hz`, lvl, s, 'LUFS', 0.1)).toBe(true);
        expect(metro('LUFS intégré (direct)', `sinus 1 kHz ${lvl} dBFS, ${sr} Hz`, lvl, I, 'LUFS', 0.1)).toBe(true);
      }
    });
    it(`${sr} Hz : cas 3, 4, 5 (portillons) — intégré = −23,0 ±0,1 LU`, () => {
      const cases: [string, Float32Array][] = [
        ['cas 3 −36/−23/−36', cat(tone(sr, 10, 1000, -36), tone(sr, 60, 1000, -23), tone(sr, 10, 1000, -36))],
        ['cas 4 −72/−36/−23/−36/−72', cat(tone(sr, 10, 1000, -72), tone(sr, 10, 1000, -36), tone(sr, 60, 1000, -23), tone(sr, 10, 1000, -36), tone(sr, 10, 1000, -72))],
        ['cas 5 −26/−20/−26', cat(tone(sr, 20, 1000, -26), tone(sr, 20.1, 1000, -20), tone(sr, 20, 1000, -26))],
      ];
      for (const [name, x] of cases) {
        const I = live(x, x, sr).lm.integrated();
        expect(metro('LUFS intégré (direct)', `${name}, ${sr} Hz`, -23, I, 'LUFS', 0.1)).toBe(true);
      }
    });
    it(`${sr} Hz : LRA Tech 3342 (cas 1 à 4) ±1 LU`, () => {
      const cases: [string, Float32Array, number][] = [
        ['−20/−30', cat(tone(sr, 20, 1000, -20), tone(sr, 20, 1000, -30)), 10],
        ['−20/−15', cat(tone(sr, 20, 1000, -20), tone(sr, 20, 1000, -15)), 5],
        ['−40/−20', cat(tone(sr, 20, 1000, -40), tone(sr, 20, 1000, -20)), 20],
        ['−50/−35/−20/−35/−50', cat(tone(sr, 20, 1000, -50), tone(sr, 20, 1000, -35), tone(sr, 20, 1000, -20), tone(sr, 20, 1000, -35), tone(sr, 20, 1000, -50)), 15],
      ];
      for (const [name, x, want] of cases) {
        const lra = live(x, x, sr).lm.lra();
        expect(metro('LRA (direct)', `Tech 3342 ${name}, ${sr} Hz`, want, lra, 'LU', 1)).toBe(true);
      }
    });
  }
});

describe('LUFS, LRA et crête vraie HORS LIGNE (export, distribution)', () => {
  const buf = (L: Float32Array, R: Float32Array, sr: number) => ({ sampleRate: sr, numberOfChannels: 2, length: L.length, getChannelData: (c: number) => (c ? R : L) }) as unknown as AudioBuffer;
  for (const sr of RATES) {
    it(`${sr} Hz : intégré EBU cas 1, 3, 5 ±0,1 LU`, () => {
      const cases: [string, Float32Array][] = [
        ['cas 1 −23', tone(sr, 20, 1000, -23)],
        ['cas 3 −36/−23/−36', cat(tone(sr, 10, 1000, -36), tone(sr, 60, 1000, -23), tone(sr, 10, 1000, -36))],
        ['cas 5 −26/−20/−26', cat(tone(sr, 20, 1000, -26), tone(sr, 20.1, 1000, -20), tone(sr, 20, 1000, -26))],
      ];
      for (const [name, x] of cases) {
        const I = integratedLufs(buf(x, x, sr));
        expect(metro('LUFS intégré (export)', `${name}, ${sr} Hz`, -23, I, 'LUFS', 0.1)).toBe(true);
        expect(Math.abs(lufsOf([x, x], sr) - I)).toBeLessThan(1e-9);
      }
    });
    it(`${sr} Hz : LRA de l'export (Tech 3342) ±1 LU`, () => {
      const cases: [string, Float32Array, number][] = [
        ['−20/−30', cat(tone(sr, 20, 1000, -20), tone(sr, 20, 1000, -30)), 10],
        ['−40/−20', cat(tone(sr, 20, 1000, -40), tone(sr, 20, 1000, -20)), 20],
        ['−50/−35/−20/−35/−50', cat(tone(sr, 20, 1000, -50), tone(sr, 20, 1000, -35), tone(sr, 20, 1000, -20), tone(sr, 20, 1000, -35), tone(sr, 20, 1000, -50)), 15],
      ];
      for (const [name, x, want] of cases) {
        const lra = loudnessRangeOf([x, x], sr);
        expect(metro('LRA (export)', `Tech 3342 ${name}, ${sr} Hz`, want, lra, 'LU', 1)).toBe(true);
      }
    });
    it(`${sr} Hz : LRA de l'export pondéré K comme la norme (graves forts puis aigus, même niveau crête)`, () => {
      // 20 s de sinus 60 Hz puis 20 s de sinus 3 kHz, même amplitude : la pondération K donne
      // 4,2 dB d'écart réel de loudness ; un LRA sans pondération K voyait 0 LU.
      const x = cat(tone(sr, 20, 60, -20), tone(sr, 20, 3000, -20));
      const ref = live(x, x, sr).lm.lra();
      const lra = loudnessRangeOf([x, x], sr);
      expect(metro('LRA (export)', `60 Hz puis 3 kHz à −20 dBFS, ${sr} Hz (référence = mètre direct)`, ref, lra, 'LU', 1)).toBe(true);
    });
    it(`${sr} Hz : crête vraie de l'export (×4, 16 coefficients) ±0,1 dB`, () => {
      for (const [f, ph] of [[sr / 4, Math.PI / 4], [sr / 6, 0.3], [997, 1.1], [15000, 0.7]] as [number, number][]) {
        const x = soft(tone(sr, 1, f, -1, ph), sr);
        const tp = truePeakDb(buf(x, x, sr));
        expect(metro('Crête vraie (export)', `sinus ${Math.round(f)} Hz −1 dBFS, ${sr} Hz`, -1, tp, 'dBTP', 0.1)).toBe(true);
      }
    });
  }
});

describe('Crête échantillon et crête vraie en direct (master ×4/16, pistes ×4/8 avec portillon)', () => {
  for (const sr of RATES) {
    it(`${sr} Hz : sinus à fs/4 déphasé de 45° (échantillons à −3,01 dB sous la crête vraie)`, () => {
      const x = soft(tone(sr, 1, sr / 4, -6, Math.PI / 4), sr);
      const m = live(x, x, sr);
      const t = live(x, x, sr, { loudness: false, tpTaps: 8, tpGate: true } as any);
      expect(metro('Crête échantillon (direct)', `sinus fs/4 45° −6 dBFS, ${sr} Hz`, -6 - 3.0103, dB(m.pk), 'dBFS', 0.1)).toBe(true);
      expect(metro('Crête vraie master (direct)', `sinus fs/4 45° −6 dBFS, ${sr} Hz`, -6, dB(m.tp), 'dBTP', 0.1)).toBe(true);
      expect(metro('Crête vraie piste (direct)', `sinus fs/4 45° −6 dBFS, ${sr} Hz`, -6, dB(t.tp), 'dBTP', 0.1)).toBe(true);
    });
    it(`${sr} Hz : sinus 997 Hz, fs/6, 15 kHz, quelle que soit la phase : crête vraie ±0,1 dB`, () => {
      for (const f of [997, sr / 6, 15000]) for (const ph of [0, 0.4, 1.3]) {
        const x = soft(tone(sr, 0.5, f, -3, ph), sr);
        const m = live(x, x, sr);
        expect(metro('Crête vraie master (direct)', `sinus ${Math.round(f)} Hz phase ${ph}, ${sr} Hz`, -3, dB(m.tp), 'dBTP', 0.1)).toBe(true);
      }
    });
  }
});

describe('Corrélation de phase', () => {
  it('+1 (mono), −1 (inversé), 0 (quadrature, bruits indépendants)', () => {
    const sr = 48000, n = sr;
    const s = tone(sr, 1, 440, -6), c = tone(sr, 1, 440, -6, Math.PI / 2), neg = s.map(v => -v);
    let a = 1, b = 7;
    const rnd = () => { a = (a * 16807) % 2147483647; return a / 2147483647 - 0.5; };
    const rnd2 = () => { b = (b * 48271) % 2147483647; return b / 2147483647 - 0.5; };
    const n1 = Float32Array.from({ length: n }, rnd), n2 = Float32Array.from({ length: n }, rnd2);
    const corr = (L: Float32Array, R: Float32Array) => {
      const core = createMeterCore(sr, {}); core.process(L, R, L.length); const t = core.take();
      return correlationOf(t.lr, t.sumL, t.sumR);
    };
    expect(metro('Corrélation', 'G = D', 1, corr(s, s), '', 0.01)).toBe(true);
    expect(metro('Corrélation', 'G = −D', -1, corr(s, neg), '', 0.01)).toBe(true);
    expect(metro('Corrélation', 'sinus / cosinus (90°)', 0, corr(s, c), '', 0.01)).toBe(true);
    expect(metro('Corrélation', 'deux bruits indépendants', 0, corr(n1, n2), '', 0.05)).toBe(true);
  });
});

describe('Vumètre de la console (MeterBank) : référence et balistique, au rythme réel', () => {
  /**
   * Simule la vraie vie : le worklet envoie un message toutes les ~33 ms (12 blocs à 48 kHz),
   * et l'écran redessine entre deux (view()). L'horloge murale (performance.now) avance en vrai.
   */
  function vuRun(sr: number, x: Float32Array, onFrame?: (tMs: number, rmsDb: number) => void) {
    const bank: any = meterBank;
    const id = `vu-${Math.random()}`;
    bank.sampleRate = sr;
    let clock = 1000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const core = createMeterCore(sr, { tpTaps: 8, tpGate: true });
    const every = Math.max(1, Math.round(sr / 30 / 128));
    let cnt = 0;
    try {
      for (let s = 0; s + 128 <= x.length; s += 128) {
        core.process(x.subarray(s, s + 128), x.subarray(s, s + 128), 128);
        if (++cnt % every === 0) {
          const t = core.take();
          // Message arrivé : l'horloge murale a avancé du temps du son couvert.
          clock += (t.n / sr) * 1000 / 2;
          bank.view(id, clock); // une image entre deux messages
          clock += (t.n / sr) * 1000 / 2;
          bank.onMessage({ t: 0, d: Float64Array.from([0, t.n, t.peakL, t.peakR, t.tpL, t.tpR, t.sumL, t.sumR, t.lr, 1]), x: null }, [id]);
          const v = bank.view(id, clock);
          onFrame?.((s + 128) / sr * 1000, v.rms[0]);
        }
      }
      return bank.view(id, clock);
    } finally { spy.mockRestore(); bank.points.delete(id); }
  }

  for (const sr of RATES) {
    it(`${sr} Hz : sinus 1 kHz à −18 dBFS (crête) = 0,0 VU ; K-20 : −20 dBFS = 0 ; K-14 : −14 dBFS = 0`, () => {
      for (const [sid, lvl] of [['vu', -18], ['k20', -20], ['k14', -14], ['k12', -12]] as [string, number][]) {
        const s = scaleById(sid);
        const v = vuRun(sr, tone(sr, 3, 1000, lvl));
        const shown = meterMainDb(s, v.peak[0], v.rms[0]) - s.refDb;
        expect(metro(`Vumètre ${s.label}`, `sinus 1 kHz ${lvl} dBFS (régime établi), ${sr} Hz`, 0, shown, s.id === 'vu' ? 'VU' : 'dB', 0.1)).toBe(true);
        expect(scaleReading(s, meterMainDb(s, v.peak[0], v.rms[0]))).toMatch(/^[−+]?0,[01]$/);
      }
    });
    it(`${sr} Hz : balistique VU — 99 % de la déviation finale en 300 ms (±10 %)`, () => {
      const s = scaleById('vu');
      const x = cat(new Float32Array(Math.round(0.5 * sr)), tone(sr, 2, 1000, -18));
      const trace: [number, number][] = [];
      vuRun(sr, x, (t, r) => trace.push([t - 500, r]));
      const final = trace[trace.length - 1][1];
      // Déviation (amplitude) relative à la valeur finale
      const at = (ms: number) => trace.reduce((best, p) => (Math.abs(p[0] - ms) < Math.abs(best[0] - ms) ? p : best))[1];
      // Instant où la déviation passe 99 % (interpolé entre deux messages, ~33 ms d'écart).
      let t99 = NaN;
      for (let k = 1; k < trace.length; k++) {
        const [t0, r0] = trace[k - 1], [t1, r1] = trace[k];
        const d0 = Math.pow(10, (r0 - final) / 20), d1 = Math.pow(10, (r1 - final) / 20);
        if (t1 > 0 && d1 >= 0.99) { t99 = d1 === d0 ? t1 : t0 + (t1 - t0) * (0.99 - d0) / (d1 - d0); break; }
      }
      expect(metro('Vumètre VU', `montée à 99 %, sinus −18 dBFS, ${sr} Hz`, 300, t99, 'ms', 30, undefined, 0)).toBe(true);
      expect(Math.pow(10, (at(300) - final) / 20)).toBeGreaterThan(0.97);
      expect(s.ballistics).toBe('rms');
    });
  }
});

describe('Analyseur de spectre du master : niveau et fréquence d’un sinus', () => {
  it('sinus 100 Hz, 1 kHz, 10 kHz à −12 dBFS : pic du tracé à la bonne fréquence, niveau ±0,1 dB (1/3 et 1/6 d’octave)', async () => {
    const restore = installMiniWebAudio();
    try {
      for (const sr of RATES) for (const f of [100, 1000, 10000]) for (const frac of [1 / 3, 1 / 6]) {
        const ctx = new MiniOfflineAudioContext(2, Math.round(sr * 0.75), sr);
        const osc = ctx.createOscillator(); osc.frequency.value = f;
        const g = ctx.createGain(); g.gain.value = Math.pow(10, -12 / 20);
        const an = ctx.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0.55;
        osc.connect(g); g.connect(an); an.connect(ctx.destination); osc.start(0);
        await ctx.startRendering();
        const bins = new Float32Array(an.frequencyBinCount);
        for (let k = 0; k < 12; k++) an.getFloatFrequencyData(bins); // lissage temporel établi
        const sm = octaveSmooth(bins, sr, frac);
        let k0 = 0; for (let i = 1; i < sm.length; i++) if (sm[i] > sm[k0]) k0 = i;
        // Fréquence lue : centre (géométrique) du plateau à −0,1 dB du maximum
        let a = k0, b = k0;
        while (a > 1 && sm[a - 1] >= sm[k0] - 0.1) a--;
        while (b < sm.length - 1 && sm[b + 1] >= sm[k0] - 0.1) b++;
        const fRead = Math.sqrt(a * b) * sr / an.fftSize;
        const level = sm[k0] + SPECTRUM_SINE_DB;
        expect(metro('Analyseur de spectre', `niveau, sinus ${f} Hz −12 dBFS, 1/${Math.round(1 / frac)} oct, ${sr} Hz`, -12, level, 'dBFS', 0.1)).toBe(true);
        const cents = 1200 * Math.log2(fRead / f);
        expect(metro('Analyseur de spectre', `fréquence, sinus ${f} Hz, 1/${Math.round(1 / frac)} oct, ${sr} Hz`, 0, cents, 'cents', 25, cents, 1)).toBe(true);
      }
    } finally { restore(); }
  });
});

describe('Échelles des vumètres', () => {
  it('chaque échelle : sa référence est à sa graduation 0', () => {
    for (const s of METER_SCALES) {
      const zero = s.marks.find(m => m.label === '0');
      expect(zero?.db).toBe(s.refDb);
    }
  });
});
