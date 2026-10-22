/**
 * Banc de métrologie : filtres hors égaliseur (22/10/2026) — Filtre DJ, bande passante du Lo-fi,
 * coupures du rack parallèle (mode « bandes »). Son mesuré (cœurs tels qu'exécutés dans le worklet,
 * graphe de nœuds natifs du rack), à 44,1 et 48 kHz.
 *
 * Conventions : coupure = point à −3 dB d'un filtre Butterworth (Filtre DJ sans résonance, Lo-fi) ;
 * avec de la résonance, la fréquence affichée est la fréquence propre du filtre (sommet de la
 * résonance), comme sur tout filtre de synthé / DJ. Rack « bandes » : Linkwitz-Riley 24 dB/oct,
 * −6 dB par bande au point de coupure, somme plate.
 * METRO_OUT=<dossier> : écrit les mesures (filtres_test.json).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createDjFilterCore, createLofiCore } from '../engine/colorFxCore';
import { FxRackNode } from '../engine/FxRackNode';
import { fakeAudioContext, graphDb } from './metrologie/grapheWebAudio';
import { sine, tone, crossing } from './metrologie/outils';

const RATES = [44100, 48000];
const rowsOut: any[] = [];
const note = (r: any) => { rowsOut.push(r); return r; };

/** Gain (dB) d'un cœur stéréo pour un sinus à f (régime établi). */
function coreGain(proc: (iL: Float32Array, iR: Float32Array, oL: Float32Array, oR: Float32Array, n: number) => void, f: number, sr: number) {
  const per = sr / f;
  const n = Math.max(8192, Math.ceil(per * 40 / 128) * 128 + 8192);
  const x = sine(f, sr, n, -12);
  const oL = new Float32Array(n), oR = new Float32Array(n);
  for (let i = 0; i < n; i += 128) proc(x.subarray(i, i + 128), x.subarray(i, i + 128), oL.subarray(i, i + 128), oR.subarray(i, i + 128), Math.min(128, n - i));
  const from = n - Math.max(4096, Math.ceil(per * 8));
  return tone(oL, f, sr, from, n).db - tone(x, f, sr, from, n).db;
}

describe('Métrologie Filtre DJ', () => {
  it('sans résonance : −3 dB pile à la fréquence affichée (12 et 24 dB/oct), pente annoncée', () => {
    for (const sr of RATES) for (const slope of [12, 24]) for (const pos of [-0.8, -0.5, -0.2, 0.2, 0.5, 0.8]) {
      const c = createDjFilterCore(sr);
      c.setParams({ filter: pos, resonance: 0, slope, output: 0 });
      c.reset();
      const shown = c.cutoffHz();
      const g = (f: number) => coreGain(c.process as any, f, sr);
      const at = g(shown);
      note({ effet: 'Filtre DJ', sr, reglage: `${pos < 0 ? 'Passe-bas' : 'Passe-haut'} ${Math.round(Math.abs(pos) * 100)} % · ${slope} dB/oct · gain à la coupure affichée (${Math.round(shown)} Hz)`, affiche: '−3,01 dB', mesure: at });
      expect(Math.abs(at + 3.0103)).toBeLessThan(0.1);
      // Pente : entre 2 et 3 octaves dans la bande coupée (si loin des bords).
      const f2 = pos < 0 ? shown * 4 : shown / 4, f3 = pos < 0 ? shown * 8 : shown / 8;
      if (f3 > 30 && f3 < sr * 0.2) {
        const s = g(f2) - g(f3);
        note({ effet: 'Filtre DJ', sr, reglage: `${pos < 0 ? 'Passe-bas' : 'Passe-haut'} ${Math.round(Math.abs(pos) * 100)} % · pente`, affiche: `${slope} dB/oct`, mesure: s });
        expect(Math.abs(s - slope)).toBeLessThan(0.6);
      }
    }
  });
  it('centre : transparent (0 dB), sortie : gain exact', () => {
    for (const sr of RATES) for (const out of [-6, 0, 6]) {
      const c = createDjFilterCore(sr);
      c.setParams({ filter: 0, resonance: 0.25, slope: 24, output: out });
      c.reset();
      expect(coreGain(c.process as any, 1000, sr)).toBeCloseTo(out, 3);
    }
  });
});

describe('Métrologie Lo-fi : bande passante affichée', () => {
  it('coupe-bas et coupe-haut : −3 dB pile aux fréquences affichées (bitcrush et échantillonnage intacts)', () => {
    for (const sr of RATES) for (const [lo, hi] of [[400, 3400], [300, 5000], [100, 9000], [25, 15000]] as const) {
      const c = createLofiCore(sr);
      c.setParams({ bits: 16, rate: 48000, lowCut: lo, highCut: hi, drive: 0, noise: 0, mix: 1, output: 0 });
      const g = (f: number) => coreGain(c.process as any, f, sr);
      if (lo > 25) {
        const a = g(lo);
        note({ effet: 'Lo-fi', sr, reglage: `Coupe-bas ${lo} Hz · gain à la fréquence`, affiche: '−3,01 dB', mesure: a });
        expect(Math.abs(a + 3.0103)).toBeLessThan(0.1);
      }
      const b = g(hi);
      note({ effet: 'Lo-fi', sr, reglage: `Coupe-haut ${hi} Hz · gain à la fréquence`, affiche: '−3,01 dB', mesure: b });
      expect(Math.abs(b + 3.0103)).toBeLessThan(0.1);
      // Milieu de bande : 0 dB.
      const mid = Math.sqrt(Math.max(lo, 30) * hi);
      expect(Math.abs(g(mid))).toBeLessThan(0.15);
    }
  });
});

describe('Métrologie rack parallèle : coupures du mode « bandes »', () => {
  const host = { createPlugin: () => null } as any;
  const rack = (sr: number, bandCount: number, x1: number, x2: number, solo = -1) => {
    const ctx = fakeAudioContext(sr);
    const branches = Array.from({ length: bandCount }, (_, i) => ({ id: `b${i}`, plugins: [], level: 0, solo: i === solo }));
    const node: any = new FxRackNode(ctx, { id: 'r', type: 'FXRACK', name: 'Rack', isEnabled: true, params: { mode: 'bandes', bandCount, x1, x2, branches, mix: 100, outGain: 0 } } as any, host);
    return (f: number) => graphDb(node.input, node.output, f);
  };
  it('2 et 3 bandes : chaque bande à −6 dB à sa coupure, somme plate (±0,05 dB), 24 dB/oct', () => {
    for (const sr of RATES) for (const [n, x1, x2] of [[2, 200, 3000], [3, 120, 2500], [3, 400, 6000]] as const) {
      const sum = rack(sr, n, x1, x2);
      let worst = 0;
      for (let i = 0; i <= 200; i++) worst = Math.max(worst, Math.abs(sum(20 * Math.pow(1000, i / 200))));
      note({ effet: 'Rack parallèle', sr, reglage: `${n} bandes (${x1} / ${x2} Hz) · somme 20 Hz–20 kHz, écart max`, affiche: '0 dB', mesure: worst });
      expect(worst).toBeLessThan(0.05);
      const low = rack(sr, n, x1, x2, 0), high = rack(sr, n, x1, x2, 1);
      const a = low(x1), b = high(x1);
      note({ effet: 'Rack parallèle', sr, reglage: `${n} bandes · grave et bande suivante à la 1re coupure (${x1} Hz)`, affiche: '−6,02 dB', mesure: (a + b) / 2 });
      expect(Math.abs(a + 6.0206)).toBeLessThan(0.1);
      expect(Math.abs(b + 6.0206)).toBeLessThan(0.1);
      // Pente côté grave de la bande suivante (loin de Nyquist : pas d'effet de la transformée bilinéaire).
      expect(Math.abs((high(x1 / 8) - high(x1 / 16)) - 24)).toBeLessThan(0.3);
      if (n === 3) {
        const top = rack(sr, n, x1, x2, 2);
        const c = top(x2), d = high(x2);
        note({ effet: 'Rack parallèle', sr, reglage: `3 bandes · bandes à la 2e coupure (${x2} Hz)`, affiche: '−6,02 dB', mesure: (c + d) / 2 });
        expect(Math.abs(c + 6.0206)).toBeLessThan(0.15);
        expect(Math.abs(d + 6.0206)).toBeLessThan(0.15);
      }
    }
    if (process.env.METRO_OUT) fs.writeFileSync(path.join(process.env.METRO_OUT, 'filtres_test.json'), JSON.stringify(rowsOut, null, 1));
  });
  it('fréquence de coupure pile (dichotomie) : grave à −6 dB à x1', () => {
    for (const sr of RATES) {
      const low = rack(sr, 2, 250, 3000, 0);
      expect(crossing(low, -6.0206, 50, 2000)).toBeCloseTo(250, 0);
    }
  });
});
