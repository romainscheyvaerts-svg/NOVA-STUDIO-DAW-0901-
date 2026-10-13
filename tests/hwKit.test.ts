import { describe, expect, it } from 'vitest';
import { angleOf, detentIndex, fromNorm, nudge, quantize, toNorm } from '../plugins/hw/knobMath';
import { vuPos } from '../plugins/hw/VuMeter';

describe('kit matériel : calculs des boutons rotatifs', () => {
  it('course linéaire : aller-retour valeur ↔ position', () => {
    const r = { min: -60, max: 20, step: 0.1 };
    expect(toNorm(r, -60)).toBe(0);
    expect(toNorm(r, 20)).toBe(1);
    expect(toNorm(r, -20)).toBeCloseTo(0.5, 6);
    expect(fromNorm(r, 0.5)).toBe(-20);
    expect(fromNorm(r, 0.37)).toBe(-30.4);
  });

  it('course logarithmique : le milieu est la moyenne géométrique', () => {
    const r = { min: 20, max: 20000, curve: 'log' as const };
    expect(fromNorm(r, 0.5)).toBeCloseTo(Math.sqrt(20 * 20000), 3);
    expect(toNorm(r, 632.4555)).toBeCloseTo(0.5, 4);
  });

  it('arrondi au pas sans erreur flottante, et bornes', () => {
    const r = { min: 0, max: 10, step: 0.1 };
    expect(quantize(r, 0.30000000000000004)).toBe(0.3);
    expect(quantize(r, 11)).toBe(10);
    expect(quantize(r, -1)).toBe(0);
  });

  it('crans : la valeur ne prend que les positions prévues', () => {
    const r = { min: 0, max: 220, detents: [{ v: 0 }, { v: 80 }, { v: 220 }] };
    expect(fromNorm(r, 0.4)).toBe(80);
    expect(fromNorm(r, 0.9)).toBe(220);
    expect(detentIndex(r, 100)).toBe(1);
    expect(nudge(r, 80, 1)).toBe(220);
    expect(nudge(r, 0, -1)).toBe(0);
  });

  it('clavier / molette : un cran fait toujours bouger la valeur', () => {
    const r = { min: 1, max: 7, step: 1 };
    expect(nudge(r, 3, 1)).toBe(4);
    expect(nudge(r, 3, -1)).toBe(2);
    const fine = { min: -60, max: 20, step: 0.1 };
    expect(nudge(fine, -30, 1)).toBeCloseTo(-29.2, 6);
    expect(nudge(fine, -30, 1, { fine: true })).toBe(-29.9);
  });

  it('angle du pointeur : 270° centrés sur midi', () => {
    expect(angleOf(0)).toBe(-135);
    expect(angleOf(1)).toBe(135);
    expect(angleOf(0.5)).toBe(0);
    expect(angleOf(0.5, 120)).toBe(0);
  });
});

describe('kit matériel : échelle du VU-mètre', () => {
  it('0 VU vers 71 % de la course, +3 VU au bout, −20 presque au début', () => {
    expect(vuPos(3)).toBeCloseTo(1, 6);
    expect(vuPos(0)).toBeCloseTo(0.708, 3);
    expect(vuPos(-20)).toBeCloseTo(0.0708, 3);
    expect(vuPos(10)).toBe(1);
  });
});
