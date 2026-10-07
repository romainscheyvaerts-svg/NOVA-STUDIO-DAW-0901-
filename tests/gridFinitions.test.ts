import { describe, expect, it } from 'vitest';
import { GRID_OPTIONS, gridLabel, gridStepSeconds, snapToGrid, timeGridStep } from '../utils/grid';
import { moveClipStart, sanitizeEditMode, trimEdgeTime } from '../utils/editModes';
import { nudgeSeconds } from '../utils/fades';

const rel = { mode: 'GRID' as const, gridKind: 'RELATIVE' as const, gridSize: '1/4' };
const abs = { ...rel, gridKind: 'ABSOLUTE' as const };

describe('Grid relatif : le rognage garde le décalage (Pro Tools : Relative Grid)', () => {
  // 120 BPM : un temps = 0,5 s. Bord à 2,125 s (un peu après le temps).
  it('relatif : le bord avance par temps entiers et reste 0,125 s après le temps', () => {
    expect(trimEdgeTime({ settings: rel, bpm: 120, origEdge: 2.125, rawEdge: 2.9 })).toBeCloseTo(3.125, 9);
    expect(trimEdgeTime({ settings: rel, bpm: 120, origEdge: 2.125, rawEdge: 1.2 })).toBeCloseTo(1.125, 9);
    // Petit geste (moins d'un demi-pas) : le bord ne bouge pas.
    expect(trimEdgeTime({ settings: rel, bpm: 120, origEdge: 2.125, rawEdge: 2.3 })).toBeCloseTo(2.125, 9);
  });
  it('absolu : le bord tombe sur la grille ; Ctrl/Maj (inversion) : libre, à l’échantillon', () => {
    expect(trimEdgeTime({ settings: abs, bpm: 120, origEdge: 2.125, rawEdge: 2.9 })).toBeCloseTo(3, 9);
    expect(trimEdgeTime({ settings: rel, bpm: 120, origEdge: 2.125, rawEdge: 2.9001, invert: true, sr: 48000 })).toBeCloseTo(Math.round(2.9001 * 48000) / 48000, 9);
  });
  it('même logique que le déplacement relatif (cohérence)', () => {
    const m = moveClipStart({ settings: rel, bpm: 120, origStart: 2.125, rawStart: 2.9 });
    expect(m).toBeCloseTo(trimEdgeTime({ settings: rel, bpm: 120, origEdge: 2.125, rawEdge: 2.9 }), 9);
  });
});

describe('grille en millisecondes et en images (Pro Tools : min:sec, timecode)', () => {
  it('pas de la grille indépendant du tempo', () => {
    expect(timeGridStep('ms:100')).toBeCloseTo(0.1);
    expect(timeGridStep('fps:25')).toBeCloseTo(0.04);
    expect(timeGridStep('1/4')).toBeNull();
    expect(gridStepSeconds('ms:10', 90)).toBeCloseTo(0.01);
    expect(gridStepSeconds('fps:24', 140)).toBeCloseTo(1 / 24);
    expect(gridStepSeconds('1/4', 120)).toBeCloseTo(0.5);
  });
  it('aimantation, déplacement absolu et relatif, nudge « grille »', () => {
    expect(snapToGrid(1.234, 120, 'ms:100', true)).toBeCloseTo(1.2);
    expect(moveClipStart({ settings: { ...abs, gridSize: 'fps:25' }, bpm: 120, origStart: 0.5, rawStart: 1.013 })).toBeCloseTo(1.0);
    expect(moveClipStart({ settings: { ...rel, gridSize: 'ms:100' }, bpm: 120, origStart: 0.537, rawStart: 0.79 })).toBeCloseTo(0.837);
    expect(nudgeSeconds('GRID', 120, 'fps:30')).toBeCloseTo(1 / 30);
    // (Au passage : le nudge « grille » en triolet donnait un temps entier.)
    expect(nudgeSeconds('GRID', 120, '1/8T')).toBeCloseTo(0.5 / 2 * 2 / 3);
  });
  it('dans le menu, rangées à part, et acceptées dans un projet sauvé', () => {
    const temps = GRID_OPTIONS.filter(o => o.kind === 'temps').map(o => o.value);
    expect(temps).toEqual(['ms:10', 'ms:100', 'ms:1000', 'fps:24', 'fps:25', 'fps:30']);
    expect(gridLabel('ms:100')).toBe('100 ms');
    expect(sanitizeEditMode({ mode: 'GRID', gridSize: 'fps:25' }).gridSize).toBe('fps:25');
    expect(sanitizeEditMode({ mode: 'GRID', gridSize: 'ms:7' }).gridSize).toBe('1/4');
  });
});
