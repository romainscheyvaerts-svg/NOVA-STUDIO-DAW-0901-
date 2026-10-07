import { describe, expect, it } from 'vitest';
import { foldInternalPower, gainDbFr, numFr, termHelp } from '../utils/pluginUi';

describe('gainDbFr (G16 : gains en dB, plus de « 1.74x »)', () => {
  it('multiplicateur → dB français', () => {
    expect(gainDbFr(1.74)).toBe('+4,8 dB');
    expect(gainDbFr(1)).toBe('0,0 dB');
    expect(gainDbFr(0.5)).toBe('−6,0 dB');
    expect(gainDbFr(0)).toBe('−∞ dB');
  });
  it('numFr', () => { expect(numFr(1.5)).toBe('1,5'); });
  it('infobulles des termes de studio', () => {
    expect(termHelp('Seuil')).toMatch(/threshold/);
    expect(termHelp('Inconnu')).toBe('');
  });
});

describe('foldInternalPower (G17 : un seul marche / arrêt)', () => {
  it('interne coupé + effet actif : on réactive dedans et on passe en bypass', () => {
    expect(foldInternalPower({ isEnabled: false, mix: 1 }, true)).toEqual({ params: { isEnabled: true, mix: 1 }, toggleBypass: true });
  });
  it('déjà en bypass : on ne rebascule pas', () => {
    expect(foldInternalPower({ isEnabled: false }, false)?.toggleBypass).toBe(false);
  });
  it('rien à faire', () => {
    expect(foldInternalPower({ isEnabled: true }, true)).toBeNull();
    expect(foldInternalPower(undefined, true)).toBeNull();
  });
});
