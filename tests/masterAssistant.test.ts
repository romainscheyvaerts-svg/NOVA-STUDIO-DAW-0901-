import { describe, it, expect } from 'vitest';
import { spectralBalance, eqCorrections, eqParamsFor, proposeChain, nextLimiterGain, analyzeMix, PLATFORM_TARGETS, eqMoveLabel, fmtDb, referenceMatchGainDb } from '../utils/masterAssistant';
import { createLimiterCore } from '../engine/limiterCore';
import { lufsOf, truePeakOf } from '../utils/audioMeasure';

const SR = 44100;
const beat = (sec: number, level: number) => {
  const n = Math.round(sec * SR), L = new Float32Array(n), R = new Float32Array(n);
  let seed = 99, z1 = 0, z2 = 0;
  const r0 = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (let i = 0; i < n; i++) {
    const t = i / SR, b = t % 0.5, s = t % 0.25;
    const v = r0(), hat = (v + 2 * z1 + z2) / 4; z2 = z1; z1 = v;
    const kick = Math.sin(2 * Math.PI * (45 + 100 * Math.exp(-b * 25)) * b) * Math.exp(-b * 6);
    const keys = 0.25 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 554 * t) + Math.sin(2 * Math.PI * 659 * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.25 * t));
    L[i] = level * (kick + keys + 0.3 * hat * Math.exp(-s * 40));
    R[i] = level * (kick + keys * 0.9 - 0.3 * hat * Math.exp(-s * 40));
  }
  return [L, R];
};

describe('Master Nova : analyse', () => {
  it('équilibre spectral : un mix sans grave montre un sub très bas', () => {
    const n = SR * 2, x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 1500 * i / SR);
    const bal = spectralBalance([x], SR);
    expect(bal.mid).toBe(0);
    expect(bal.sub).toBeLessThan(-30);
  });

  it('corrections dosées et bornées (±3,5 dB max), médiums jamais touchés', () => {
    const moves = eqCorrections({ sub: -40, bass: -30, lowmid: 0, mid: 0, presence: 10, air: 10 }, 1, 'propre');
    moves.forEach(m => expect(Math.abs(m.gainDb)).toBeLessThanOrEqual(3.5));
    expect(moves.find(m => m.band === 'mid')!.gainDb).toBe(0);
    expect(moves.find(m => m.band === 'sub')!.gainDb).toBeGreaterThan(0);
    expect(eqCorrections({ sub: -40 }, 0, 'propre').every(m => m.gainDb === 0)).toBe(true);
    const p = eqParamsFor(moves);
    expect(p.bands).toHaveLength(12);
    expect(eqMoveLabel({ band: 'sub', label: 'sub (808)', freq: 45, gainDb: 1.5 })).toBe('+1,5 dB sur sub (808) (45 Hz)');
    expect(fmtDb(-14.04)).toBe('−14,0');
  });

  it('chaîne proposée : plafond de la plateforme, gain de départ vers la cible', () => {
    const a = analyzeMix(beat(6, 0.2), SR);
    const spotify = PLATFORM_TARGETS.find(t => t.id === 'spotify')!;
    const c = proposeChain(a, spotify, 'punch');
    expect(c.limiterParams.ceiling).toBe(-1);
    expect(c.limiterParams.inputGain).toBeGreaterThan(0);
    expect(c.compParams.ratio).toBe(2);
  });
});

describe('morceau de référence', () => {
  it('aligné sur la loudness du mix, sans dépasser −1 dBTP', () => {
    expect(referenceMatchGainDb(-8, -0.2, -14).gainDb).toBeCloseTo(-6);
    const up = referenceMatchGainDb(-16, -3, -9);
    expect(up.limited).toBe(true);
    expect(up.gainDb).toBeCloseTo(2);
    expect(referenceMatchGainDb(-8, -1, NaN).gainDb).toBe(0);
  });
});

describe('Master Nova : la cible LUFS est atteinte à ±0,5 dB', () => {
  for (const target of PLATFORM_TARGETS) {
    it(`${target.label} (${target.lufs} LUFS)`, () => {
      const [L, R] = beat(8, 0.15);
      const history: { gain: number; lufs: number }[] = [];
      let gain = target.lufs - lufsOf([L, R], SR);
      let out: Float32Array[] = [L, R];
      for (let k = 0; k < 8; k++) {
        const core = createLimiterCore(SR);
        core.setParams({ ceilingDb: target.ceiling, inputGainDb: gain, oversample: 4 });
        const oL = new Float32Array(L.length), oR = new Float32Array(L.length);
        core.process(L, R, oL, oR, L.length);
        out = [oL, oR];
        const l = lufsOf(out, SR);
        history.push({ gain, lufs: l });
        if (Math.abs(l - target.lufs) < 0.1) break;
        gain = nextLimiterGain(history, target.lufs);
      }
      expect(Math.abs(history[history.length - 1].lufs - target.lufs)).toBeLessThanOrEqual(0.5);
      expect(truePeakOf(out)).toBeLessThanOrEqual(target.ceiling);
    });
  }
});
