import { describe, expect, it } from 'vitest';
import { audioBufferToWav, wavOf } from '../services/AudioUtils';
import { blobBytes, decodeWav, makeBuffer, parseWavHeader } from './helpers/audio';

describe('audioBufferToWav', () => {
  it('mono : en-têtes RIFF/fmt/data et longueur exacte', async () => {
    const buf = makeBuffer(1, 1000, 48000);
    const wav = audioBufferToWav(buf);
    expect(wav.type).toBe('audio/wav');
    expect(wav.size).toBe(44 + 1000 * 2);
    const ab = await blobBytes(wav);
    const h = parseWavHeader(ab);
    expect(h).toMatchObject({
      numChannels: 1, sampleRate: 48000, bitsPerSample: 16, blockAlign: 2, byteRate: 48000 * 2,
      riffSize: 36 + 1000 * 2, dataOffset: 44, dataSize: 1000 * 2,
    });
  });

  it('stéréo : canaux entrelacés, blockAlign 4, byteRate = sr × 4', async () => {
    const buf = makeBuffer(2, 500, 44100, (ch, i) => (ch === 0 ? 0.25 : -0.5) * (i % 2 ? 1 : 0.5));
    const ab = await blobBytes(audioBufferToWav(buf));
    const h = parseWavHeader(ab);
    expect(h).toMatchObject({ numChannels: 2, blockAlign: 4, byteRate: 44100 * 4, dataSize: 500 * 4, riffSize: 36 + 500 * 4 });
    expect(ab.byteLength).toBe(44 + 500 * 4);
    // Premier échantillon : gauche puis droite
    const v = new DataView(ab);
    expect(v.getInt16(44, true)).toBe(Math.trunc(0.125 * 0x7fff));
    expect(v.getInt16(46, true)).toBe(Math.trunc(-0.25 * 0x8000));
  });

  it('aller-retour : les échantillons survivent (précision 16 bits)', async () => {
    const buf = makeBuffer(2, 2048, 44100);
    const back = decodeWav(await blobBytes(audioBufferToWav(buf)));
    expect(back.numberOfChannels).toBe(2);
    expect(back.length).toBe(2048);
    expect(back.sampleRate).toBe(44100);
    for (let c = 0; c < 2; c++) {
      const a = buf.getChannelData(c), b = back.getChannelData(c);
      for (let i = 0; i < a.length; i += 97) expect(Math.abs(a[i] - b[i])).toBeLessThan(2 / 32768);
    }
  });

  it('écrête au-delà de ±1 sans déborder', async () => {
    const buf = makeBuffer(1, 4, 8000, (_c, i) => [2, -2, 1, -1][i]);
    const v = new DataView(await blobBytes(audioBufferToWav(buf)));
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)])
      .toEqual([32767, -32768, 32767, -32768]);
  });
});

describe('wavOf (cache)', () => {
  it('même buffer -> même Blob (pas de ré-encodage)', () => {
    const buf = makeBuffer(1, 100);
    const a = wavOf(buf);
    expect(wavOf(buf)).toBe(a);
  });

  it('buffers différents -> Blobs différents', () => {
    const a = makeBuffer(1, 100), b = makeBuffer(1, 100);
    expect(wavOf(a)).not.toBe(wavOf(b));
  });

  it('le Blob mis en cache est un WAV valide du buffer', async () => {
    const buf = makeBuffer(2, 300, 22050);
    const h = parseWavHeader(await blobBytes(wavOf(buf)));
    expect(h).toMatchObject({ numChannels: 2, sampleRate: 22050, dataSize: 300 * 4 });
  });
});
