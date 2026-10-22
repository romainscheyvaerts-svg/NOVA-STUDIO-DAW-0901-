import { describe, expect, it } from 'vitest';
import {
  ampEnvelope, bakeChannels, bakeKey, cleanSampler, cutoffAt, dbToGain, envValue, filterEnvAt, filterSections, gainToDb, loopTimes, needsBake,
  nearestZeroCrossing, notePeak, noteSemis, peakOf, pickLayer, pitchEnvAt, sectionGainDb, semisToRatio, timeStretch, MIN_RELEASE,
} from '../utils/padSampler';
import { padLoadKey } from '../utils/drumSamples';

/**
 * Métrologie du sampler de pad : chaque valeur affichée est la valeur réelle. Les mêmes grandeurs
 * sont mesurées sur le vrai rendu du navigateur par qa/sampler_pads.py.
 */
const SR = 48000;
const totalDb = (type: 'lp' | 'hp' | 'bp', slope: 12 | 24, reso: number, fc: number, f: number) =>
  filterSections(type, slope, reso).reduce((s, sec) => s + sectionGainDb(sec, fc, f, SR), 0);

describe('niveau et hauteur', () => {
  it('+6 dB = ×1,995 ; −12 dB = ×0,251 ; aller-retour exact', () => {
    expect(dbToGain(6)).toBeCloseTo(1.99526, 5);
    expect(dbToGain(-12)).toBeCloseTo(0.25119, 5);
    expect(gainToDb(dbToGain(3.7))).toBeCloseTo(3.7, 9);
    expect(notePeak({ gainDb: 6 }, 1, 1)).toBeCloseTo(1.99526, 5);
  });
  it('+12 demi-tons = octave exacte (×2) ; +7 = ×1,4983 ; centièmes, suivi des pas et vélocité', () => {
    expect(semisToRatio(12)).toBe(2);
    expect(semisToRatio(-12)).toBe(0.5);
    expect(semisToRatio(7)).toBeCloseTo(1.498307, 6);
    expect(noteSemis({ cents: 50 }, 2, 0, 1)).toBeCloseTo(2.5, 12);
    expect(noteSemis({ keytrack: 0.5 }, 0, 12, 1)).toBeCloseTo(6, 12);
    expect(noteSemis({ velToPitch: 4 }, 0, 0, 0.5)).toBeCloseTo(2, 12);
    expect(noteSemis(undefined, 3, 2, 1)).toBe(5);
  });
  it('vélocité → volume : 1 = proportionnel (comme avant), 0 = fixe', () => {
    expect(notePeak(undefined, 0.9, 0.5)).toBeCloseTo(0.45, 12);
    expect(notePeak({ velToVol: 0 }, 0.9, 0.5)).toBeCloseTo(0.9, 12);
  });
});

describe('enveloppe d\'amplitude', () => {
  it('attaque 10 ms : maximum atteint à 10 ms pile (moitié à 5 ms en droite)', () => {
    const e = ampEnvelope({ attack: 0.01 }, 1, null);
    expect(envValue(e, 0)).toBe(0);
    expect(envValue(e, 0.005)).toBeCloseTo(0.5, 12);
    expect(envValue(e, 0.01)).toBe(1);
    expect(envValue(e, 0.0099)).toBeLessThan(1);
  });
  it('maintien 20 ms, décroissance 100 ms vers sustain 25 % (−12,04 dB) : sustain atteint à 130 ms pile', () => {
    const e = ampEnvelope({ attack: 0.01, hold: 0.02, decay: 0.1, sustain: 0.25 }, 1, null);
    expect(envValue(e, 0.029)).toBe(1);
    expect(envValue(e, 0.1299)).toBeGreaterThan(0.25);
    expect(envValue(e, 0.13)).toBeCloseTo(0.25, 12);
    expect(gainToDb(envValue(e, 0.5))).toBeCloseTo(-12.04, 2);
  });
  it('relâchement 200 ms depuis la valeur atteinte à la fin de la note ; 2 ms au moins', () => {
    const e = ampEnvelope({ mode: 'gate', decay: 0.1, sustain: 0.5, release: 0.2, releaseCurve: 0 }, 1, 0.3);
    expect(envValue(e, 0.3)).toBeCloseTo(0.5, 12);
    expect(envValue(e, 0.4)).toBeCloseTo(0.25, 12);
    expect(envValue(e, 0.5)).toBe(0);
    // Note coupée pendant l'attaque : le relâchement part de la valeur atteinte.
    const c = ampEnvelope({ attack: 0.1, release: 0.1, releaseCurve: 0 }, 1, 0.05);
    expect(envValue(c, 0.05)).toBeCloseTo(0.5, 12);
    expect(envValue(c, 0.1)).toBeCloseTo(0.25, 12);
    expect(ampEnvelope({ release: 0 }, 1, 0.1).at(-1)!.t1 - 0.1).toBeCloseTo(MIN_RELEASE, 12);
  });
  it('par défaut : enveloppe plate (le son d\'avant)', () => {
    const e = ampEnvelope(undefined, 0.8, null);
    for (const t of [0, 0.001, 0.5, 3]) expect(envValue(e, t)).toBe(0.8);
  });
  it('courbe exponentielle : mêmes extrémités, plus rapide au début', () => {
    const e = ampEnvelope({ decay: 0.1, sustain: 0, decayCurve: 1 }, 1, null);
    expect(envValue(e, 0.1)).toBe(0);
    expect(envValue(e, 0.05)).toBeLessThan(0.5);
  });
});

describe('enveloppes de hauteur et de filtre', () => {
  it('hauteur : +12 dt au départ, 0 à la fin de la décroissance (droite en demi-tons)', () => {
    expect(pitchEnvAt({ pitchEnvAmt: 12, pitchEnvDecay: 0.1 }, 0)).toBe(12);
    expect(pitchEnvAt({ pitchEnvAmt: 12, pitchEnvDecay: 0.1 }, 0.05)).toBeCloseTo(6, 12);
    expect(pitchEnvAt({ pitchEnvAmt: 12, pitchEnvDecay: 0.1 }, 0.1)).toBe(0);
  });
  it('filtre : enveloppe +2 octaves à l\'attaque, sustain ; vélocité +1 octave à vélocité max', () => {
    const p = { filterType: 'lp' as const, cutoff: 1000, filterEnvAmt: 2, filterAttack: 0, filterDecay: 0.1, filterSustain: 0.5 };
    expect(cutoffAt(p, 0, 0, SR)).toBeCloseTo(4000, 6);
    expect(cutoffAt(p, 0, 0.1, SR)).toBeCloseTo(2000, 6);
    expect(filterEnvAt(p, 1)).toBeCloseTo(0.5, 12);
    expect(cutoffAt({ cutoff: 1000, filterVel: 1 }, 1, 0, SR)).toBeCloseTo(2000, 6);
    expect(cutoffAt({ cutoff: 30000 }, 0, 0, SR)).toBeLessThan(SR / 2);
  });
});

describe('filtre multimode : coupure affichée = coupure mesurée', () => {
  for (const type of ['lp', 'hp'] as const) for (const slope of [12, 24] as const) {
    it(`${type} ${slope} dB/oct : −3,01 dB à 1 kHz, pente ${slope} dB/oct`, () => {
      expect(totalDb(type, slope, 0, 1000, 1000)).toBeCloseTo(-3.01, 2);
      // Deux octaves de la coupure : au moins 2 × la pente (passe-bas : la transformée bilinéaire creuse encore plus vers Nyquist).
      const twoOct = totalDb(type, slope, 0, 1000, type === 'lp' ? 4000 : 250);
      if (type === 'hp') expect(Math.abs(twoOct + 2 * slope)).toBeLessThan(0.6);
      else expect(twoOct).toBeLessThan(-2 * slope + 0.6);
    });
  }
  it('passe-bande 12 et 24 : 0 dB au centre (1 kHz)', () => {
    expect(totalDb('bp', 12, 0, 1000, 1000)).toBeCloseTo(0, 6);
    expect(totalDb('bp', 24, 0.5, 1000, 1000)).toBeCloseTo(0, 6);
  });
  it('résonance : bosse à la coupure (+18 dB à fond en 12 dB/oct)', () => {
    expect(totalDb('lp', 12, 1, 1000, 1000)).toBeCloseTo(20 * Math.log10(Math.SQRT1_2 * 16), 2);
    expect(totalDb('lp', 24, 0.5, 1000, 1000)).toBeGreaterThan(0);
    expect(filterSections('off', 12, 0)).toEqual([]);
  });
});

describe('traitement du son (calculé une fois, lecture = export)', () => {
  const sine = (n: number, a = 0.5, f = 440) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / SR));
  it('normaliser : crête à 0 dBFS ; polarité : signe inversé', () => {
    const x = [sine(4800, 0.25)];
    expect(peakOf(bakeChannels(x, SR, { normalize: true }))).toBeCloseTo(1, 6);
    const inv = bakeChannels(x, SR, { invert: true })[0];
    expect(inv[100]).toBe(-x[0][100]);
  });
  it('réduction : 4 bits = 8 niveaux par demi-échelle ; un échantillon sur 4 (12 kHz à 48 kHz)', () => {
    const y = bakeChannels([sine(4800)], SR, { crushBits: 4 })[0];
    expect(new Set(Array.from(y).map(v => Math.round(v * 8))).size).toBeLessThanOrEqual(17);
    expect(y.every(v => Math.abs(v * 8 - Math.round(v * 8)) < 1e-6)).toBe(true);
    const z = bakeChannels([sine(4800)], SR, { crushDown: 4 })[0];
    expect(z[5]).toBe(z[4]);
    expect(z[7]).toBe(z[4]);
  });
  it('drive : crête gardée (±1), les petits signaux sont poussés', () => {
    const y = bakeChannels([Float32Array.from([1, -1, 0.1])], SR, { drive: 0.5 })[0];
    expect(y[0]).toBeCloseTo(1, 6);
    expect(y[1]).toBeCloseTo(-1, 6);
    expect(y[2]).toBeGreaterThan(0.1);
  });
  it('durée gardée : +12 dt sur le pad → son étiré ×2 (joué ×2 plus vite : même durée)', () => {
    const x = [sine(9600)];
    const y = timeStretch(x, SR, 2)[0];
    expect(y.length).toBe(19200);
    expect(bakeChannels(x, SR, { stretch: true }, 12)[0].length).toBe(19200);
    expect(needsBake({ stretch: true }, 0)).toBe(false);
    // La hauteur ne bouge pas : 440 Hz étiré ×2 compte toujours 440 passages par zéro montants par seconde.
    const ups = (z: Float32Array, a: number, b: number) => { let n = 0; for (let i = a + 1; i < b; i++) if (z[i - 1] < 0 && z[i] >= 0) n++; return n; };
    const f = ups(y, 2400, 2400 + SR / 4) * 4;
    expect(Math.abs(f - 440)).toBeLessThanOrEqual(4);
  });
  it('fondu de boucle : la fin de boucle rejoint en douceur ce qui précède le début de boucle', () => {
    const x = [Float32Array.from({ length: 4800 }, (_, i) => i / 4800)];
    const y = bakeChannels(x, SR, { loop: true, loopStart: 0.25, loopEnd: 0.75, loopXfade: 0.01 })[0];
    const L1 = 3600, L0 = 1200;
    expect(y[L1 - 1]).toBeCloseTo(x[0][L0 - 1], 6);
    expect(loopTimes({ loop: true, loopStart: 0.25, loopEnd: 0.75 }, 2)).toEqual({ start: 0.5, end: 1.5 });
  });
  it('clé de chargement : celle d\'un pad d\'avant ne change pas', () => {
    const row = { sound: 'synth:kick-punch', tune: 0 };
    expect(padLoadKey(row, 0)).toBe('synth:kick-punch|0|');
    expect(padLoadKey({ ...row, smp: { attack: 0.01, gainDb: 3 } }, 0)).toBe('synth:kick-punch|0|');
    expect(padLoadKey({ ...row, smp: { normalize: true } }, 0)).toContain('|smp:');
    expect(bakeKey(undefined)).toBe('');
  });
  it('passage par zéro le plus proche (coupes sans clic)', () => {
    const x = sine(4800);
    const i = nearestZeroCrossing(x, 60, 100);
    expect(Math.abs(x[i])).toBeLessThan(0.05);
  });
});

describe('couches et réglages reçus', () => {
  it('couches de vélocité (parts égales du doux au fort) et alternance', () => {
    expect([0.1, 0.4, 0.6, 1].map(v => pickLayer(3, 'vel', v, 0))).toEqual([0, 1, 1, 2]);
    expect([0, 1, 2, 3, 4].map(r => pickLayer(3, 'rr', 1, r))).toEqual([0, 1, 2, 0, 1]);
    expect(pickLayer(1, 'rr', 1, 5)).toBe(0);
  });
  it('nettoyage : bornes, types, valeurs par défaut retirées', () => {
    expect(cleanSampler({ gainDb: 99, attack: -1, filterType: 'xx' as never, mode: 'gate', sustain: 1, loop: false })).toEqual({ gainDb: 24, mode: 'gate' });
    expect(cleanSampler({})).toBeUndefined();
    expect(cleanSampler({ layers: [{ sound: 'user:a' }, { bad: 1 } as never] })).toEqual({ layers: [{ sound: 'user:a' }] });
  });
});
