import { describe, expect, it } from 'vitest';
import { pvStretch, resampleStep } from '../engine/phaseVocoder';
import {
  anchorsOf, detectMaterial, estimateTempo, editingElastic, elasticBlock, elasticLabel, elasticPatch, elasticRevertPatch, isNeutralElastic, mapTime,
  placeMarker, quantizeOnsets, rebaseVisible, removeMarker, renderElastic, renderPlan, semitoneText, unmapTime, withDuration, withSemitones, withTempo,
} from '../utils/clipTranspose';
import { analyzePitch } from '../utils/pitchAnalysis';
import { detectTransients } from '../utils/transients';
import type { ElasticInfo } from '../types';
import { synthVoice } from './helpers/synthVoice';
import { makeClip } from './helpers/fixtures';

const SR = 44100;

/** Fréquence d'un partiel isolé (pic de spectre interpolé), en Hz. */
function peakHz(x: Float32Array, near: number, from = 0.3, len = 1.2): number {
  const N = 65536;
  const re = new Float64Array(N), im = new Float64Array(N);
  const a = Math.round(from * SR), L = Math.min(Math.round(len * SR), x.length - a);
  for (let i = 0; i < L; i++) re[i] = x[a + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / L));
  // DFT seulement autour du pic attendu (pas besoin d'une FFT complète).
  const k0 = Math.round((near * 0.9 * N) / SR), k1 = Math.round((near * 1.1 * N) / SR);
  const mag = (k: number) => {
    let r = 0, s = 0;
    const w = (2 * Math.PI * k) / N;
    for (let i = 0; i < L; i += 1) { r += re[i] * Math.cos(w * i); s -= re[i] * Math.sin(w * i); }
    return Math.log(Math.hypot(r, s) + 1e-12);
  };
  let best = k0, bv = -Infinity;
  const step = 4;
  for (let k = k0; k <= k1; k += step) { const v = mag(k); if (v > bv) { bv = v; best = k; } }
  for (let k = best - step; k <= best + step; k++) { const v = mag(k); if (v > bv) { bv = v; best = k; } }
  const l = mag(best - 1), c = mag(best), r = mag(best + 1);
  const d = 0.5 * (l - r) / (l - 2 * c + r);
  void im;
  return ((best + d) * SR) / N;
}
const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

/** Médiane de la hauteur (MIDI) des trames chantées. */
function medianMidi(x: Float32Array): number {
  const t = analyzePitch(x, SR);
  const v = Array.from(t.midi).filter(m => !Number.isNaN(m)).sort((a, b) => a - b);
  return v[v.length >> 1];
}

/** « Beat » de synthèse : kick, caisse claire, charleston, basse et nappe (La 440 Hz + quinte). */
function synthBeat(dur: number, bpm = 120, lateSnareMs = 0): { x: Float32Array; snareAt: number } {
  const n = Math.round(dur * SR);
  const x = new Float32Array(n);
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const beat = 60 / bpm;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] = 0.08 * Math.sin(2 * Math.PI * 440 * t) + 0.05 * Math.sin(2 * Math.PI * 659.255 * t) + 0.1 * Math.sin(2 * Math.PI * 55 * t);
  }
  let snareAt = 0;
  for (let b = 0; b * beat < dur - 0.3; b++) {
    const t0 = b * beat + (b === 3 && lateSnareMs ? lateSnareMs / 1000 : 0);
    if (b === 3) snareAt = t0;
    const s0 = Math.round(t0 * SR);
    for (let i = 0; i < Math.round(0.2 * SR) && s0 + i < n; i++) {
      const t = i / SR;
      if (b % 2 === 0) x[s0 + i] += 0.7 * Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-t * 30)) * t) * Math.exp(-t * 12);
      else x[s0 + i] += 1.5 * rnd() * Math.exp(-t * 25);
    }
    const h0 = Math.round((b * beat + beat / 2) * SR);
    for (let i = 0; i < Math.round(0.05 * SR) && h0 + i < n; i++) x[h0 + i] += 0.25 * rnd() * Math.exp(-(i / SR) * 80);
  }
  return { x, snareAt };
}

/** Attaque mesurée : 1er échantillon au-dessus de 30 % de la crête, cherché autour de `near` (s). */
function onsetNear(x: Float32Array, near: number, span = 0.08): number {
  const a = Math.max(0, Math.round((near - span) * SR)), b = Math.min(x.length, Math.round((near + span) * SR));
  // Énergie de fond retirée : on cherche la montée de la caisse claire (bruit) sur la nappe.
  let peak = 0;
  for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let i = a; i < b; i++) if (Math.abs(x[i]) >= peak * 0.6) return i / SR;
  return NaN;
}

const info0 = (o: Partial<ElasticInfo> = {}): ElasticInfo => ({
  version: 1, sourceOffset: 1, sourceDuration: 2, regionStart: 0, regionEnd: 0, renderedOffset: 0, duration: 2,
  semitones: 0, formants: true, algo: 'auto', ...o,
});

describe('vocodeur de phase', () => {
  it('étire à la longueur exacte, hauteur inchangée (sinus 440 Hz, +10 %)', () => {
    const n = 2 * SR;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const [y] = pvStretch([x], Math.round(n * 1.1), { sampleRate: SR });
    expect(y.length).toBe(Math.round(n * 1.1));
    expect(Math.abs(cents(peakHz(y, 440), 440))).toBeLessThan(1);
    // Niveau gardé (bords compris : pas d'extinction en fin de son).
    const rms = (a: Float32Array, s: number, e: number) => Math.sqrt(a.subarray(s, e).reduce((q, v) => q + v * v, 0) / (e - s));
    expect(rms(y, 1000, y.length - 1000) / rms(x, 1000, n - 1000)).toBeGreaterThan(0.95);
    expect(rms(y, y.length - 800, y.length) / rms(x, n - 800, n)).toBeGreaterThan(0.8);
  });

  it('stéréo : l’écart gauche / droite est gardé', () => {
    const n = SR;
    const l = new Float32Array(n), r = new Float32Array(n);
    for (let i = 0; i < n; i++) { l[i] = 0.5 * Math.sin((2 * Math.PI * 330 * i) / SR); r[i] = 0.25 * Math.sin((2 * Math.PI * 330 * i) / SR); }
    const [yl, yr] = pvStretch([l, r], Math.round(n * 1.25), { sampleRate: SR });
    let el = 0, er = 0, cross = 0;
    for (let i = 2000; i < yl.length - 2000; i++) { el += yl[i] ** 2; er += yr[i] ** 2; cross += yl[i] * yr[i]; }
    expect(Math.sqrt(er / el)).toBeCloseTo(0.5, 2);
    expect(cross / Math.sqrt(el * er)).toBeGreaterThan(0.999);
  });

  it('rééchantillonnage : longueur exacte et fréquence × pas', () => {
    const n = SR;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 300 * i) / SR);
    const y = resampleStep(x, 1.5, 20000);
    expect(y.length).toBe(20000);
    expect(Math.abs(cents(peakHz(y, 450, 0.05, 0.35), 450))).toBeLessThan(0.5);
  });
});

describe('transposer un clip (rendu)', () => {
  const voice = synthVoice(SR, 2.4, [{ midi: 57, at: 0.1, len: 2.2, vibratoCents: 0 }]);
  const seg = (n: number, m = n) => [{ s0: 0, s1: n, d0: 0, d1: m }];

  it.each([3, -5])('voix %i demi-tons (PSOLA, formants gardés) : hauteur à ±5 cents, durée identique', (st) => {
    const r = renderElastic({ channels: [voice], sr: SR, segments: seg(voice.length), semitones: st, formants: true, algo: 'voice' });
    expect(r.used).toBe('voice');
    expect(r.channels[0].length).toBe(voice.length);
    expect(Math.abs((medianMidi(r.channels[0]) - medianMidi(voice)) * 100 - st * 100)).toBeLessThan(5);
  });

  it.each([3, -5])('beat %i demi-tons (vocodeur de phase) : hauteur à ±5 cents, durée identique', (st) => {
    const { x } = synthBeat(2.5);
    const r = renderElastic({ channels: [x, x], sr: SR, segments: seg(x.length), semitones: st, formants: false, algo: 'poly' });
    expect(r.used).toBe('poly');
    expect(r.channels).toHaveLength(2);
    expect(r.channels[0].length).toBe(x.length);
    const want = 440 * Math.pow(2, st / 12);
    expect(Math.abs(cents(peakHz(r.channels[0], want), want))).toBeLessThan(5);
  });

  it('au cent près : +0,37 demi-ton', () => {
    const { x } = synthBeat(2);
    const r = renderElastic({ channels: [x], sr: SR, segments: seg(x.length), semitones: 0.37, formants: false, algo: 'poly' });
    expect(Math.abs(cents(peakHz(r.channels[0], 440 * Math.pow(2, 0.37 / 12)), 440) - 37)).toBeLessThan(2);
  });

  it('étirement de 10 % : durée exacte, hauteur inchangée', () => {
    const { x } = synthBeat(2.5);
    const m = Math.round(x.length * 1.1);
    const r = renderElastic({ channels: [x], sr: SR, segments: seg(x.length, m), semitones: 0, formants: false, algo: 'poly' });
    expect(r.channels[0].length).toBe(m);
    expect(Math.abs(cents(peakHz(r.channels[0], 440), 440))).toBeLessThan(2);
  });

  it('tempo d’un sample estimé (warp automatique) : boucle à 120 BPM', () => {
    const t = estimateTempo(synthBeat(8, 120).x, SR);
    expect(t).not.toBeNull();
    expect(Math.abs(t!.bpm - 120)).toBeLessThan(1);
    const t2 = estimateTempo(synthBeat(8, 92).x, SR);
    expect(Math.abs(t2!.bpm - 92)).toBeLessThan(1);
  });

  it('choix automatique : voix seule → PSOLA, beat → polyphonique', () => {
    expect(detectMaterial(voice, SR).kind).toBe('voice');
    expect(detectMaterial(synthBeat(4).x, SR).kind).toBe('poly');
  });
});

describe('warp : recaler une attaque', () => {
  it('caisse claire en retard de 30 ms recalée sur la grille (±1 ms), le reste ne bouge pas', () => {
    const bpm = 120, beat = 0.5;
    const { x, snareAt } = synthBeat(3, bpm, 30);
    expect(snareAt).toBeCloseTo(1.53, 6);
    const onsets = detectTransients(x, SR);
    expect(onsets.some(o => Math.abs(o - snareAt) < 0.003)).toBe(true);
    const base = info0({ sourceOffset: 0, sourceDuration: x.length / SR, duration: x.length / SR });
    const q = quantizeOnsets(base, onsets, 0, beat, 1);
    const m = q.markers!.find(k => Math.abs(k.src - snareAt) < 0.003)!;
    expect(m.dst).toBeCloseTo(1.5, 6);
    const plan = renderPlan(q, SR, x.length);
    const r = renderElastic({ channels: [x], sr: SR, segments: plan.segments, semitones: 0, formants: false, algo: 'poly' });
    const y = r.channels[0];
    expect(y.length).toBe(x.length);
    // Attaque mesurée dans le son rendu (repère : début du clip = renderedOffset).
    const at = onsetNear(y, 1.5 + plan.renderedOffset) - plan.renderedOffset;
    const was = onsetNear(x, snareAt);
    expect(Math.abs(at - 1.5 - (was - snareAt))).toBeLessThan(0.001);
    // Kick suivant (2,0 s) à sa place.
    expect(Math.abs(onsetNear(y, 2.0) - onsetNear(x, 2.0))).toBeLessThan(0.001);
  });
});

describe('temps du clip (fonction affine par morceaux)', () => {
  const info = info0({ sourceOffset: 1, sourceDuration: 2, duration: 2.2, markers: [{ id: 'a', src: 2, dst: 1.2 }] });
  it('ancres, aller-retour', () => {
    expect(anchorsOf(info)).toEqual([{ src: 1, dst: 0 }, { src: 2, dst: 1.2 }, { src: 3, dst: 2.2 }]);
    for (const s of [0.5, 1, 1.5, 2, 2.7, 3, 3.4]) expect(unmapTime(info, mapTime(info, s))).toBeCloseTo(s, 9);
    expect(mapTime(info, 0.5)).toBeCloseTo(-0.6, 9); // marge avant : pente du 1er morceau (1,2)
    expect(mapTime(info, 3.5)).toBeCloseTo(2.7, 9);  // marge après : pente du dernier (1,0)
  });
  it('plan de rendu : morceaux contigus coupés aux marqueurs, marges comprises', () => {
    const p = renderPlan(info, 1000, 5000);
    expect(p.segments.map(s => [s.s0, s.s1, s.d0, s.d1])).toEqual([[0, 1500, 0, 1800], [1500, 3000, 1800, 3300]]);
    expect(p.renderedOffset).toBeCloseTo(0.6, 9);
    expect(p.regionStart).toBe(0.5);
  });
  it('Trim TCE : durée et marqueurs mis à l’échelle, bornés (25 % à 400 %)', () => {
    const t = withDuration(info, 4.4);
    expect(t.duration).toBe(4.4);
    expect(t.markers![0].dst).toBeCloseTo(2.4, 9);
    expect(withDuration(info, 100).duration).toBe(8);
  });
  it('rogné après le rendu : réglage ramené à la partie montrée', () => {
    const r = rebaseVisible(info, 0.6, 1.0); // montre [0,6 ; 1,6] du temps du clip
    expect(r.sourceOffset).toBeCloseTo(1.5, 9);
    expect(r.duration).toBe(1);
    expect(r.markers![0].dst).toBeCloseTo(0.6, 9);
    expect(mapTime(r, 2)).toBeCloseTo(0.6, 9);
  });
  it('marqueur posé entre ses voisins, jamais d’inversion', () => {
    const a = placeMarker(info, 1.5, 5); // trop loin : borné avant le marqueur suivant
    const m = a.markers!.find(k => k.src === 1.5)!;
    expect(m.dst).toBeLessThan(1.2);
    expect(removeMarker(a, m.id).markers).toHaveLength(1);
    expect(placeMarker(info, 0.9, 0.1)).toBe(info); // hors de la partie montrée
  });
  it('calage au tempo : 90 → 120 BPM = 75 %', () => {
    const t = withTempo(info0(), 90, 120);
    expect(t.duration).toBeCloseTo(1.5, 9);
    expect(t.tempo).toEqual({ sourceBpm: 90, bpm: 120 });
  });
  it('libellés', () => {
    expect(semitoneText(3)).toBe('+3 demi-tons');
    expect(semitoneText(-5.2)).toBe('−5 demi-tons −20 ct');
    expect(semitoneText(0.3)).toBe('+30 cents');
    expect(elasticLabel(withSemitones(info, -1))).toBe('−1 demi-ton · 110 % · 1 marqueur');
    expect(isNeutralElastic(info0())).toBe(true);
    expect(isNeutralElastic(withSemitones(info0(), 0.01))).toBe(false);
  });
});

describe('clip non destructif', () => {
  const has = (id: string) => id === 'orig' || id === 'rendu';
  const clip = makeClip({ id: 'c', bufferId: 'orig', start: 4, offset: 1, duration: 2, name: 'Beat', fadeIn: 0.1, gainPoints: [{ t: 2, db: -3 }], syncPoint: 1.5 });

  it('appliquer puis revenir à l’original : même son, même place', () => {
    const ed = editingElastic(clip, has);
    expect(ed.fromOriginal).toBe(false);
    expect(ed.info.sourceOffset).toBe(1);
    const set = withDuration(withSemitones(ed.info, 3), 2.2);
    const plan = renderPlan(set, 1000, 10000);
    const full = { ...set, regionStart: plan.regionStart, regionEnd: plan.regionEnd, renderedOffset: plan.renderedOffset };
    const p = elasticPatch(clip, { newBufferId: 'rendu', info: full, sourceBufferId: 'orig' });
    expect(p.bufferId).toBe('rendu');
    expect(p.duration).toBe(2.2);
    expect(p.offset).toBeCloseTo(0.55, 9);
    expect(p.name).toBe('Beat (transposé +3 demi-tons · 110 %)');
    expect(p.gainPoints![0].t).toBeCloseTo(0.55 + 1.1, 9);
    expect(p.syncPoint).toBeCloseTo(0.55 + 0.55, 9);
    const after = { ...clip, ...p } as typeof clip;
    // Rouvrir : on repart de l'original, réglage retrouvé.
    const again = editingElastic(after, has);
    expect(again.fromOriginal).toBe(true);
    expect(again.bufferId).toBe('orig');
    expect(again.info.semitones).toBe(3);
    expect(again.info.duration).toBeCloseTo(2.2, 9);
    // Revenir.
    const back = { ...after, ...elasticRevertPatch(after, has)! };
    expect(back.bufferId).toBe('orig');
    expect(back.offset).toBeCloseTo(1, 9);
    expect(back.duration).toBeCloseTo(2, 9);
    expect(back.elastic).toBeUndefined();
    expect(back.name).toBe('Beat');
    expect(back.gainPoints![0].t).toBeCloseTo(2, 9);
    expect(back.syncPoint).toBeCloseTo(1.5, 9);
  });

  it('retouche depuis l’original : la ligne de gain reste au même endroit du morceau', () => {
    const set = withSemitones(editingElastic(clip, has).info, 2);
    const pl = renderPlan(set, 1000, 10000);
    const a = { ...clip, ...elasticPatch(clip, { newBufferId: 'rendu', info: { ...set, ...pl }, sourceBufferId: 'orig' }) } as typeof clip;
    const ed = editingElastic(a, has);
    const set2 = withDuration(ed.info, 3);
    const pl2 = renderPlan(set2, 1000, 10000);
    const b = { ...a, ...elasticPatch(a, { newBufferId: 'rendu2', info: { ...set2, ...pl2 }, sourceBufferId: ed.bufferId }) } as typeof clip;
    // Point de gain : instant 2 s de l'original = 1 s après le début montré → 1,5 s une fois étiré à 150 %.
    expect(b.gainPoints![0].t - b.offset).toBeCloseTo(1.5, 6);
  });

  it('reçu en collaboration (sans l’original) : on repart du son rendu, pas de retour', () => {
    const remote = { ...clip, bufferId: 'r2', elastic: info0({ sourceBufferId: 'absent', semitones: 3 }) };
    expect(elasticRevertPatch(remote, has)).toBeNull();
    const ed = editingElastic(remote, id => id === 'r2');
    expect(ed.fromOriginal).toBe(false);
    expect(ed.bufferId).toBe('r2');
    expect(ed.info.semitones).toBe(0);
  });

  it('refus lisibles', () => {
    expect(elasticBlock(makeClip({ notes: [] }))).toMatch(/piano roll/);
    expect(elasticBlock(makeClip({ bufferId: 'x', isReversed: true }))).toMatch(/inversé/);
    expect(elasticBlock(clip)).toBeNull();
  });
});
