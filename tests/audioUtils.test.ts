import { describe, expect, it } from 'vitest';
import { audioBufferToWav, losslessDepth, wav16Of, wavOf } from '../services/AudioUtils';
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
    // Premier échantillon : gauche puis droite, sur UNE échelle (×32768) des deux côtés de zéro.
    // Avant : ×32767 au-dessus de zéro (0,125 → 4095), si bien qu'un son 16 bits perdait un pas à
    // chaque sauvegarde puis réouverture.
    const v = new DataView(ab);
    expect(v.getInt16(44, true)).toBe(4096);
    expect(v.getInt16(46, true)).toBe(-8192);
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

  it('le Blob mis en cache est un WAV valide du buffer (sans perte : flottant 32 bits pour un son quelconque)', async () => {
    const buf = makeBuffer(2, 300, 22050);
    const h = parseWavHeader(await blobBytes(wavOf(buf)));
    expect(h).toMatchObject({ format: 3, bitsPerSample: 32, numChannels: 2, sampleRate: 22050, dataSize: 300 * 2 * 4 });
  });

  it('wav16Of : cache à part, toujours 16 bits', async () => {
    const buf = makeBuffer(2, 300, 22050);
    expect(wav16Of(buf)).toBe(wav16Of(buf));
    expect(wav16Of(buf)).not.toBe(wavOf(buf));
    expect(parseWavHeader(await blobBytes(wav16Of(buf)))).toMatchObject({ format: 1, bitsPerSample: 16, dataSize: 300 * 4 });
  });
});

/** Sons de projet SANS PERTE (audit de nuit, 22/10/2026) : relus = identiques au bit près. */
describe('sons de projet sans perte (wavOf)', () => {
  const same = (a: AudioBuffer, b: AudioBuffer) => {
    expect(b.numberOfChannels).toBe(a.numberOfChannels);
    expect(b.length).toBe(a.length);
    for (let c = 0; c < a.numberOfChannels; c++) expect(Array.from(b.getChannelData(c))).toEqual(Array.from(a.getChannelData(c)));
  };
  const roundTrip = async (b: AudioBuffer) => decodeWav(await blobBytes(audioBufferToWav(b, 'lossless')));

  it('son déjà en 16 bits : écrit en 16 bits, relu identique', async () => {
    const buf = makeBuffer(2, 4000, 48000, (c, i) => Math.round(Math.sin(i / 7 + c) * 30000) / 32768);
    expect(losslessDepth(buf)).toBe(16);
    same(buf, await roundTrip(buf));
    // -1 et la plus grande valeur positive du 16 bits passent aussi.
    const edge = makeBuffer(1, 3, 48000, (_c, i) => [-1, 32767 / 32768, 0][i]);
    expect(losslessDepth(edge)).toBe(16);
    same(edge, await roundTrip(edge));
  });

  it('prise 24 bits : écrite en 24 bits (pas tronquée à 16), relue identique', async () => {
    const buf = makeBuffer(1, 4000, 48000, (_c, i) => Math.round(Math.sin(i / 9) * 8000000) / 8388608);
    expect(losslessDepth(buf)).toBe(24);
    const ab = await blobBytes(audioBufferToWav(buf, 'lossless'));
    expect(parseWavHeader(ab)).toMatchObject({ format: 1, bitsPerSample: 24, blockAlign: 3, dataSize: 4000 * 3 });
    same(buf, decodeWav(ab));
  });

  it('son traité (flottant quelconque, crêtes au-delà de 0 dBFS) : flottant 32 bits, relu identique, rien n’est écrêté', async () => {
    const buf = makeBuffer(2, 4000, 44100, (c, i) => Math.sin(i / 5.3 + c) * 1.3);
    expect(losslessDepth(buf)).toBe(32);
    const back = await roundTrip(buf);
    same(buf, back);
    expect(Math.max(...Array.from(back.getChannelData(0)))).toBeGreaterThan(1.2);
  });

  it('sauvegarder puis rouvrir 5 fois : aucun écart (avant : un pas de moins à chaque cycle sur les échantillons positifs)', async () => {
    const start = makeBuffer(1, 2000, 48000, (_c, i) => Math.round(Math.sin(i / 11) * 20000) / 32768);
    let cur = start;
    for (let k = 0; k < 5; k++) cur = await roundTrip(cur);
    same(start, cur);
    // Le chemin 16 bits (séances en ligne, collaboration) ne dérive pas non plus.
    let c16 = start;
    for (let k = 0; k < 5; k++) c16 = decodeWav(await blobBytes(audioBufferToWav(c16, 16)));
    same(start, c16);
  });
});
