import { describe, expect, it } from 'vitest';
import { barsBeats, dragTipText, fadeWithPreset, secFr } from '../utils/dragLabels';

describe('dragLabels (G8 : bulle en français)', () => {
  it('durées lisibles', () => {
    expect(secFr(0.05)).toBe('50 ms');
    expect(secFr(0.25)).toBe('0,25 s');
    expect(secFr(12.34)).toBe('12,3 s');
  });
  it('mesure.temps comme la règle', () => {
    expect(barsBeats(0, 120)).toBe('1.1');
    expect(barsBeats(2, 120)).toBe('2.1');
    expect(barsBeats(8.5, 120)).toBe('5.2');
  });
  it('plus de [FADE_IN] ni de secondes à 3 décimales', () => {
    const c = { start: 8.5, duration: 4, fadeIn: 0.25, fadeOut: 0 };
    expect(dragTipText('FADE_IN', c, 120)).toBe("Fondu d'entrée · 0,25 s");
    expect(dragTipText('MOVE', c, 120)).toBe('Déplacer · mes. 5.2');
    expect(dragTipText('TRIM_START', c, 120)).toBe('Rogner le début · mes. 5.2');
    expect(dragTipText(null, c, 120)).toBeNull();
  });
});

describe('fadeWithPreset (G7 : fondus du menu du clip)', () => {
  it('10 ms, 50 ms, 1 temps', () => {
    const c = { duration: 4, fadeIn: 0, fadeOut: 0 };
    expect(fadeWithPreset(c, 'in', '10ms', 120)).toEqual({ fadeIn: 0.01 });
    expect(fadeWithPreset(c, 'out', '50ms', 120)).toEqual({ fadeOut: 0.05 });
    expect(fadeWithPreset(c, 'in', 'beat', 120)).toEqual({ fadeIn: 0.5 });
  });
  it('borné par l’autre fondu (clip court)', () => {
    expect(fadeWithPreset({ duration: 0.6, fadeIn: 0, fadeOut: 0.4 }, 'in', 'beat', 120)).toEqual({ fadeIn: 0.6 - 0.4 });
  });
});
