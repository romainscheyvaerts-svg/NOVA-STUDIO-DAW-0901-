/**
 * Banc de métrologie : égaliseur 12 bandes (22/10/2026).
 *
 * On mesure le SON (réponse du graphe de nœuds tel que le moteur le câble, filtres du navigateur
 * selon la spécification Web Audio — vérifiée dans le vrai Chrome par qa/metrologie_navigateur.py —
 * et cœur « pro » exécuté tel qu'il tourne dans l'AudioWorklet), pour des réglages donnés tels
 * que la fenêtre les AFFICHE, à 44,1 et 48 kHz. Conventions (engine/eqQ.ts) :
 *  - coupe-bas / coupe-haut : fréquence = point à −3 dB au réglage d'usine Q 0,71 (Butterworth),
 *    Q linéaire = gain au point de coupure ; pente 12 dB/octave ;
 *  - cloche : fréquence = sommet, gain = gain au sommet, Q = largeur entre les points à mi-gain ;
 *  - encoche : Q = largeur à −3 dB ; étagère : mi-gain à la fréquence, plateau = gain.
 * Tolérances : fréquence ±1 % (±1 Hz sous 100 Hz), gain ±0,1 dB, Q ±2,5 % (mesuré < 0,1 %).
 *
 * METRO_OUT=<dossier> : écrit les mesures (eq_test.json) pour le rapport.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { mesurerEQClassique, eqOne, RATES, FREQS12 } from './metrologie/mesuresEQ';
import { fakeAudioContext, graphDb, webAudioBiquad, coefsAt } from './metrologie/grapheWebAudio';
import { ProEQ12Node } from '../plugins/ProEQ12Plugin';
import { BUTTERWORTH_Q, eqBandDb, eqDigitalQ, eqNativeQ, eqParamsV2, eqPassMinus3Hz, legacyBandToV2 } from '../engine/eqQ';
import { createEqProCore } from '../engine/eqLinearCore';
import { crossing } from './metrologie/outils';

const nativeQs = (node: any) => (node.voices as any[]).map(v => ({ type: v.filters[v.slot].type, f: v.filters[v.slot].frequency.value, q: v.filters[v.slot].Q.value }));
const legacyBands = (patch: Record<number, any>) => FREQS12.map((frequency, id) => ({ id, type: id === 0 ? 'highpass' : id === 11 ? 'lowpass' : 'peaking', frequency, gain: 0, q: 1, isEnabled: true, isSolo: false, ...(patch[id] || {}) }));

describe('Métrologie EQ 12 bandes : affiché = mesuré (chemin classique, filtres du navigateur)', () => {
  const rows = mesurerEQClassique();
  if (process.env.METRO_OUT) fs.writeFileSync(path.join(process.env.METRO_OUT, 'eq_test.json'), JSON.stringify(rows, null, 1));

  it('toutes les mesures sont dans la tolérance (44,1 et 48 kHz)', () => {
    const ko = rows.filter(r => !r.ok).map(r => `${r.sr} ${r.reglage} : affiché ${r.affiche}, mesuré ${r.mesure.toFixed(4)} ${r.unite}`);
    expect(ko).toEqual([]);
    expect(rows.length).toBeGreaterThan(1000);
  });

  it('coupe-bas 200 Hz (réglage d’usine) : −3 dB pile à 200 Hz, 12 dB/oct, aucune bosse', () => {
    for (const sr of RATES) {
      const { db } = eqOne(sr, { type: 'highpass', frequency: 200, q: BUTTERWORTH_Q });
      expect(crossing(db, -3.0103, 20, 400)).toBeCloseTo(200, 1);
      expect(db(25) - db(12.5)).toBeGreaterThan(11.9);
      for (let f = 20; f < 20000; f *= 1.05) expect(db(f)).toBeLessThan(1e-6);
    }
  });

  it('Q d’un coupe-bas : gain au point de coupure = 20·log10(Q), relu par la fenêtre (−3 dB à …)', () => {
    for (const sr of RATES) for (const q of [0.5, BUTTERWORTH_Q, 1, 2, 5]) {
      const { db } = eqOne(sr, { type: 'highpass', frequency: 1000, q });
      expect(db(1000)).toBeCloseTo(20 * Math.log10(q), 3);
      // La fenêtre affiche « −3 dB à … » : même valeur que la mesure.
      const f3 = crossing(db, -3.0103, 20, 8000);
      expect(Math.abs(eqPassMinus3Hz('highpass', 1000, q, sr) - f3) / f3).toBeLessThan(1e-4);
    }
  });

  it('courbe dessinée par la fenêtre = réponse mesurée (toute la bande, toutes les bandes)', () => {
    for (const sr of RATES) {
      const bands = [
        { type: 'highpass', frequency: 35, q: 1.3 }, { type: 'lowshelf', frequency: 120, gain: 4 }, { type: 'peaking', frequency: 300, gain: -5, q: 2 },
        { type: 'notch', frequency: 1200, q: 8 }, { type: 'peaking', frequency: 3500, gain: 3, q: 0.6 }, { type: 'highshelf', frequency: 9000, gain: -3 },
        { type: 'peaking', frequency: 16000, gain: 6, q: 0.8 }, { type: 'lowpass', frequency: 19000, q: BUTTERWORTH_Q },
      ];
      const ctx = fakeAudioContext(sr);
      const all = FREQS12.map((frequency, id) => ({ id, type: 'peaking', frequency, gain: 0, q: 1, isEnabled: false, isSolo: false }));
      bands.forEach((b, i) => { all[i] = { ...all[i], gain: 0, ...b, isEnabled: true } as any; });
      const node = new ProEQ12Node(ctx, { isEnabled: true, masterGain: 1, qVersion: 2, bands: all } as any);
      let worst = 0;
      for (let i = 0; i <= 600; i++) {
        const f = 20 * Math.pow(1000, i / 600);
        const shown = bands.reduce((a, b) => a + eqBandDb(b, f, sr), 0);
        worst = Math.max(worst, Math.abs(shown - graphDb(node.input, node.output, f)));
      }
      expect(worst).toBeLessThan(1e-6);
    }
  });

  it('automation du Q d’un coupe-bas : la voie (Q linéaire) arrive au filtre dans son unité', () => {
    const ctx = fakeAudioContext(48000);
    const node = new ProEQ12Node(ctx, { isEnabled: true, masterGain: 1, qVersion: 2, bands: legacyBands({}) } as any);
    const mp = node.automationParam('b1Q')!;
    mp.setValueAtTime(2, 0);
    expect(nativeQs(node)[0].q).toBeCloseTo(20 * Math.log10(2), 6);
    const mp5 = node.automationParam('b5Q')!;
    mp5.setValueAtTime(4, 0);
    expect(nativeQs(node)[4].q).toBeCloseTo(eqDigitalQ(4, 1000, 48000), 9);
  });
});

describe('Métrologie EQ : anciens projets (réglages sans qVersion)', () => {
  it('coupe-bas / coupe-haut au réglage d’usine (Q 1) ou des préréglages (0,7 / 0,71) → Butterworth : −3 dB pile à la fréquence (correction)', () => {
    for (const sr of RATES) for (const q of [1, 0.71, 0.7]) {
      const ctx = fakeAudioContext(sr);
      const node = new ProEQ12Node(ctx, { isEnabled: true, masterGain: 1, bands: legacyBands({ 0: { frequency: 200, q }, 11: { isEnabled: false } }).map((b, i) => (i > 0 && i < 11 ? { ...b, isEnabled: false } : b)) } as any);
      const db = (f: number) => graphDb(node.input, node.output, f);
      expect(crossing(db, -3.0103, 20, 400)).toBeCloseTo(200, 1);
    }
  });

  it('résonance choisie (Q > 1) et cloches / encoches : même son AU BIT PRÈS (Q du filtre en 32 bits identique)', () => {
    let n = 0;
    for (const sr of RATES) for (const f of [40, 200, 1000, 5000, 9000, 12000, 16000, 19000]) for (const q of [0.1, 0.5, 1, 1.4, 3, 7, 10]) for (const type of ['peaking', 'notch', 'highpass', 'lowpass']) {
      if ((type === 'highpass' || type === 'lowpass') && q <= 1) continue;
      const old = { type, frequency: f, gain: 3, q };
      const v2 = legacyBandToV2(old, sr);
      const before = Math.fround(q); // l'ancien moteur posait q tel quel sur BiquadFilterNode.Q
      const after = Math.fround(eqNativeQ(type, v2.q, f, sr));
      expect(after).toBe(before);
      n++;
    }
    expect(n).toBeGreaterThan(300);
  });

  it('lecture = export : le projet ancien ouvert, puis re-réglé par le moteur (updateParams des réglages du projet), reste identique', () => {
    for (const sr of RATES) {
      const legacy = { isEnabled: true, masterGain: 1, bands: legacyBands({ 4: { gain: 5, q: 2, frequency: 9000 }, 0: { q: 3 } }) };
      const a = new ProEQ12Node(fakeAudioContext(sr), legacy as any);
      const b = new ProEQ12Node(fakeAudioContext(sr), legacy as any);
      b.updateParams({ ...legacy, isEnabled: true } as any); // comme AudioEngine.createPluginNode
      expect(nativeQs(b)).toEqual(nativeQs(a));
      // Traduction idempotente et sans effet de bord.
      const once = eqParamsV2(legacy as any, sr);
      expect(eqParamsV2(once, sr)).toBe(once);
      expect((legacy.bands[4] as any).q).toBe(2);
    }
  });
});

describe('Métrologie EQ : cœur « pro » (Mid / Side, phase linéaire)', () => {
  /** Réponse impulsionnelle du cœur, stéréo identique. */
  function impulse(sr: number, params: any, n: number) {
    const c = createEqProCore(sr);
    c.setParams(params);
    const x = new Float32Array(n); x[0] = 1;
    const oL = new Float32Array(n), oR = new Float32Array(n);
    for (let i = 0; i < n; i += 128) c.process(x.subarray(i, i + 128), x.subarray(i, i + 128), oL.subarray(i, i + 128), oR.subarray(i, i + 128), 128);
    return { y: oL, lat: c.latency() };
  }
  const dft = (y: Float32Array, f: number, sr: number) => { let re = 0, im = 0; for (let k = 0; k < y.length; k++) { if (y[k] === 0) continue; const a = -2 * Math.PI * f * k / sr; re += y[k] * Math.cos(a); im += y[k] * Math.sin(a); } return { db: 10 * Math.log10(re * re + im * im + 1e-300), re, im }; };

  it('phase naturelle du cœur = égaliseur classique (même Q compensé, même courbe ±0,01 dB)', () => {
    for (const sr of RATES) {
      const b = [{ type: 'peaking', frequency: 9000, gain: 6, q: 1.5 }, { type: 'highpass', frequency: 90, q: 1.2 }, { type: 'notch', frequency: 3000, q: 5 }];
      const bands = FREQS12.map((frequency, i) => ({ type: 'peaking', frequency, gain: 0, q: 1, isEnabled: false, ...(b[i] ? { ...b[i], isEnabled: true, channel: 'left' } : {}) }));
      const { y } = impulse(sr, { bands, phase: 'minimum' }, 32768);
      for (const f of [40, 90, 300, 2900, 3100, 6000, 9000, 12000, 17000]) {
        const shown = b.reduce((a, x) => a + eqBandDb(x, f, sr), 0);
        expect(Math.abs(dft(y, f, sr).db - shown)).toBeLessThan(0.01);
      }
      // Copie du calcul du Q compensé (sérialisée dans le worklet) = celle du moteur.
      for (const f of [100, 5000, 15000, 20000]) for (const q of [0.3, 1, 8]) {
        const one = FREQS12.map((frequency, i) => ({ type: 'peaking', frequency, gain: 0, q: 1, isEnabled: i === 0, ...(i === 0 ? { frequency: f, gain: 12, q, channel: 'left' } : {}) }));
        const r = impulse(sr, { bands: one, phase: 'minimum' }, 16384).y;
        const c = webAudioBiquad('peaking', f, eqDigitalQ(q, f, sr), 12, sr);
        for (const fx of [f * 0.7, f, Math.min(f * 1.2, sr * 0.49)]) {
          const h = coefsAt(c, fx, sr);
          expect(Math.abs(dft(r, fx, sr).db - 10 * Math.log10(h.re * h.re + h.im * h.im))).toBeLessThan(0.01);
        }
      }
    }
  });

  it('phase linéaire : latence annoncée exacte, phase plate, module = courbe affichée (écarts mesurés)', () => {
    const out: string[] = [];
    for (const sr of RATES) for (const quality of ['normale', 'haute']) {
      const b = [{ type: 'highpass', frequency: 30, q: BUTTERWORTH_Q }, { type: 'peaking', frequency: 100, gain: 6, q: 4 }, { type: 'peaking', frequency: 2500, gain: -4, q: 1 }, { type: 'highshelf', frequency: 10000, gain: 3 }];
      const bands = FREQS12.map((frequency, i) => ({ type: 'peaking', frequency, gain: 0, q: 1, isEnabled: false, ...(b[i] ? { ...b[i], isEnabled: true } : {}) }));
      const { y, lat } = impulse(sr, { bands, phase: 'linear', linQuality: quality }, 4 * 8192 + 4096);
      // Phase linéaire : réponse symétrique autour de la latence annoncée.
      let asym = 0, peakAbs = 0;
      for (let k = 1; k < lat; k++) { asym = Math.max(asym, Math.abs(y[lat + k] - y[lat - k])); peakAbs = Math.max(peakAbs, Math.abs(y[lat + k])); }
      expect(asym).toBeLessThan(1e-6);
      // Module : écart à la courbe affichée (phase naturelle) de 20 Hz à 20 kHz.
      let worstLow = 0, worstMid = 0, worstHigh = 0;
      for (let i = 0; i <= 120; i++) {
        const f = 20 * Math.pow(1000, i / 120);
        const shown = b.reduce((a, x) => a + eqBandDb(x, f, sr), 0);
        const d = Math.abs(dft(y, f, sr).db - shown);
        if (shown < -20) continue; // fond de la coupure : pas un écart audible
        if (f < 60) worstLow = Math.max(worstLow, d); else if (f < 200) worstMid = Math.max(worstMid, d); else worstHigh = Math.max(worstHigh, d);
      }
      out.push(`${sr} ${quality} (latence ${lat} éch.) : écart max ${worstLow.toFixed(2)} dB (20–60 Hz), ${worstMid.toFixed(2)} dB (60–200 Hz), ${worstHigh.toFixed(3)} dB (200 Hz–20 kHz)`);
      expect(lat).toBe(quality === 'haute' ? 8192 : 2048);
      if (process.env.METRO_OUT) fs.writeFileSync(path.join(process.env.METRO_OUT, `eq_lineaire_${sr}_${quality}.txt`), out[out.length - 1]);
      expect(worstHigh).toBeLessThan(0.05);
      expect(worstMid).toBeLessThan(quality === 'haute' ? 0.1 : 0.6);
      expect(worstLow).toBeLessThan(quality === 'haute' ? 0.5 : 3.5);
    }
    if (process.env.METRO_OUT) fs.writeFileSync(path.join(process.env.METRO_OUT, 'eq_lineaire.txt'), out.join('\n'));
  });

  it('Mid / Side : bande Mid +6 dB → le centre prend +6 dB, les côtés 0 dB', () => {
    for (const sr of RATES) {
      const c = createEqProCore(sr);
      const bands = FREQS12.map((frequency, i) => ({ type: 'peaking', frequency, gain: 0, q: 1, isEnabled: i === 4, ...(i === 4 ? { gain: 6, frequency: 1000, q: 1, channel: 'mid' } : {}) }));
      c.setParams({ bands });
      const n = 16384, L = new Float32Array(n), R = new Float32Array(n), oL = new Float32Array(n), oR = new Float32Array(n);
      for (let i = 0; i < n; i++) { const s = Math.sin(2 * Math.PI * 1000 * i / sr); L[i] = 0.25 * s; R[i] = 0.05 * s; }
      for (let i = 0; i < n; i += 128) c.process(L.subarray(i, i + 128), R.subarray(i, i + 128), oL.subarray(i, i + 128), oR.subarray(i, i + 128), 128);
      let mi = 0, mo = 0, si = 0, so = 0;
      for (let i = n / 2; i < n; i++) { mi += ((L[i] + R[i]) / 2) ** 2; mo += ((oL[i] + oR[i]) / 2) ** 2; si += ((L[i] - R[i]) / 2) ** 2; so += ((oL[i] - oR[i]) / 2) ** 2; }
      expect(10 * Math.log10(mo / mi)).toBeCloseTo(6, 1);
      expect(Math.abs(10 * Math.log10(so / si))).toBeLessThan(0.01);
    }
  });
});
