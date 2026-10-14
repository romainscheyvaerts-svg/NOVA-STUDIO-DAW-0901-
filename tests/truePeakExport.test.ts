import { describe, expect, it } from 'vitest';
import { truePeakDb } from '../utils/loudness';

/** AudioBuffer minimal (la fonction ne lit que numberOfChannels et getChannelData). */
const buf = (ch: Float32Array[]) => ({ numberOfChannels: ch.length, getChannelData: (c: number) => ch[c] }) as unknown as AudioBuffer;

describe('truePeakDb (export, plafond MP3)', () => {
  it('voit une crête de 0 dBTP placée entre deux échantillons (fs/4, phase 45°)', () => {
    // sin(2π·n/4 + π/4) : les échantillons valent ±0,707 (−3 dBFS) mais la crête vraie est à 0 dBTP.
    const x = new Float32Array(4096);
    for (let n = 0; n < x.length; n++) x[n] = Math.sin(2 * Math.PI * n / 4 + Math.PI / 4);
    const tp = truePeakDb(buf([x]));
    expect(tp).toBeGreaterThan(-0.3);
    expect(tp).toBeLessThan(0.3);
  });
  it('signal à −6 dBFS sur les échantillons : crête vraie ≈ −6 dBTP (pas de surévaluation)', () => {
    const x = new Float32Array(4096);
    for (let n = 0; n < x.length; n++) x[n] = 0.5 * Math.sin(2 * Math.PI * 440 * n / 48000);
    expect(truePeakDb(buf([x]))).toBeCloseTo(-6.02, 1);
  });
});
