// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectLowEnd, isLiteFor, readPerfChoice, setPerfChoice, isLiteMode, playheadFrameMs } from '../utils/perfMode';
import { meterClock } from '../engine/meters/meterBank';

describe('mode léger (PC peu puissants)', () => {
  afterEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-perf'); });

  it('détecte les PC peu puissants', () => {
    expect(detectLowEnd(2, 8)).toBe(true);
    expect(detectLowEnd(4, 4)).toBe(true);
    expect(detectLowEnd(4, 8)).toBe(false);
    expect(detectLowEnd(8, 4)).toBe(false);
    expect(detectLowEnd(undefined, undefined)).toBe(false);
  });

  it('le choix de l’utilisateur passe avant la détection', () => {
    expect(isLiteFor('leger', 16, 32)).toBe(true);
    expect(isLiteFor('complet', 2, 2)).toBe(false);
    expect(isLiteFor('auto', 2, 2)).toBe(true);
  });

  it('réglage mémorisé et appliqué tout de suite', () => {
    setPerfChoice('leger');
    expect(readPerfChoice()).toBe('leger');
    expect(document.documentElement.getAttribute('data-perf')).toBe('lite');
    expect(isLiteMode()).toBe(true);
    expect(playheadFrameMs()).toBeCloseTo(1000 / 30);
    setPerfChoice('complet');
    expect(document.documentElement.hasAttribute('data-perf')).toBe(false);
    expect(playheadFrameMs()).toBe(0);
    setPerfChoice('auto');
    expect(readPerfChoice()).toBe('auto');
  });
});

describe('horloge des vumètres : 0 image/s sans signal', () => {
  it('s’arrête après la retombée, repart au premier message', () => {
    let t = 0;
    const queue: ((n: number) => void)[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: any) => { queue.push(cb); return queue.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const step = (ms: number) => { t += ms; const cbs = queue.splice(0); cbs.forEach(cb => cb(t)); return cbs.length; };
    let frames = 0;
    meterClock.wake(0);
    const off = meterClock.subscribe(() => { frames++; });
    for (let i = 0; i < 10; i++) step(40);
    expect(frames).toBeGreaterThan(5);
    for (let i = 0; i < 100 && queue.length; i++) step(40);   // plus de message : retombée puis arrêt
    expect(queue.length).toBe(0);
    const avant = frames;
    step(40);
    expect(frames).toBe(avant);                                // à l'arrêt : rien ne tourne
    meterClock.wake(t);                                        // un signal revient
    expect(queue.length).toBe(1);
    step(40);
    expect(frames).toBe(avant + 1);
    off();
    vi.restoreAllMocks();
  });
});
