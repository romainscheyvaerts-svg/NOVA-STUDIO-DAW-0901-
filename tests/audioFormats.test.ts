import { describe, it, expect } from 'vitest';
import {
  encodeWav, decodeWav, encodeAiff, decodeAiff, readInfo, quantize, quantizeChannels, dequantize,
  buildId3v2, parseId3v2, applyTpdfDither, makeRng, applyLayout, keyToId3, type AudioMeta,
} from '../utils/audioFormats';
import { encodeFlac, encodeFlacInts, decodeFlac } from '../utils/flac';
import { md5Hex, md5 } from '../utils/md5';
import { resampleChannel, resampledLength } from '../utils/resample';

const SR = 48000;
function signal(n: number, seed = 1, kind: 'mix' | 'noise' | 'sine' | 'silence' = 'mix'): Float32Array {
  const r = makeRng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (kind === 'silence') out[i] = 0;
    else if (kind === 'noise') out[i] = (r() * 2 - 1) * 0.9;
    else if (kind === 'sine') out[i] = 0.7 * Math.sin(2 * Math.PI * 440 * t);
    else out[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 3150 * t) + (r() - 0.5) * 0.05;
  }
  return out;
}

const META: AudioMeta = {
  title: 'Nuit blanche', artist: 'Léo', bpm: 142, key: 'Do mineur', keyId3: 'Cm', isrc: 'FRZ032600001',
  timeSignature: { numerator: 4, denominator: 4 }, markers: [{ name: 'Refrain', time: 0.02 }, { name: 'Couplet 2', time: 0.05 }],
  cover: { mime: 'image/png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]) },
  loudness: { lufs: -14.2, truePeak: -1.1 }, timeReference: 12.5, date: new Date(2026, 9, 8, 14, 30, 0),
};

describe('md5', () => {
  it('vecteurs de la RFC 1321', () => {
    expect(md5Hex(new Uint8Array(0))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex(new TextEncoder().encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex(new TextEncoder().encode('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });
});

describe('quantification', () => {
  it('arrondi et écrêtage symétriques, aller-retour exact', () => {
    expect(quantize(1, 16)).toBe(32767);
    expect(quantize(-1, 16)).toBe(-32768);
    expect(quantize(2, 24)).toBe(8388607);
    for (const v of [-32768, -1, 0, 1, 12345, 32767]) expect(quantize(dequantize(v, 16), 16)).toBe(v);
  });
  it('dither TPDF reproductible, au plus ±1 LSB', () => {
    const a = [new Float32Array(1000)], b = [new Float32Array(1000)];
    applyTpdfDither(a, 16, makeRng(7)); applyTpdfDither(b, 16, makeRng(7));
    expect(Array.from(a[0])).toEqual(Array.from(b[0]));
    const lsb = 1 / 32768;
    expect(Math.max(...a[0].map(Math.abs))).toBeLessThanOrEqual(lsb + 1e-12);
    expect(a[0].some(v => v !== 0)).toBe(true);
  });
  it('mono-somme et double mono', () => {
    const L = new Float32Array([1, 0.5]), R = new Float32Array([0, 0.5]);
    expect(Array.from(applyLayout([L, R], 'mono-sum')[0][0])).toEqual([0.5, 0.5]);
    const dm = applyLayout([L, R], 'dual-mono');
    expect(dm.length).toBe(2); expect(dm[0][0]).toBe(L); expect(dm[1][0]).toBe(R);
    expect(applyLayout([L, R], 'stereo')[0].length).toBe(2);
  });
  it('tonalité en notation ID3', () => {
    expect(keyToId3(0, 'MINOR')).toBe('Cm');
    expect(keyToId3(6, 'MAJOR')).toBe('F#');
    expect(keyToId3(undefined)).toBeUndefined();
  });
});

describe('WAV', () => {
  for (const bits of [16, 24] as const) {
    it(`PCM ${bits} bits : aller-retour bit à bit, en-tête et chunks`, () => {
      const chs = [signal(5000, 1), signal(5000, 2, 'noise')];
      const bytes = encodeWav(chs, { sampleRate: SR, bits }, META);
      const dec = decodeWav(bytes);
      expect(dec.sampleRate).toBe(SR);
      expect(dec.bits).toBe(bits);
      expect(dec.float).toBe(false);
      const ref = quantizeChannels(chs, bits);
      expect(Array.from(dec.ints![0])).toEqual(Array.from(ref[0]));
      expect(Array.from(dec.ints![1])).toEqual(Array.from(ref[1]));
      // Réencoder ce qui a été lu redonne exactement les mêmes octets audio.
      const again = encodeWav(dec.ints!.map(c => Float32Array.from(c, v => dequantize(v, bits))), { sampleRate: SR, bits }, META);
      expect(decodeWav(again).ints![1]).toEqual(dec.ints![1]);
      const ids = dec.chunks.map(c => c.id);
      expect(ids).toEqual(['fmt ', 'bext', 'acid', 'cue ', 'LIST', 'LIST', 'id3 ', 'data']);
      // RIFF : taille cohérente
      const dv = new DataView(bytes.buffer);
      expect(dv.getUint32(4, true)).toBe(bytes.length - 8);
    });
  }
  it('32 bits flottants : format 3, chunk fact, valeurs exactes (au-delà de 0 dBFS compris)', () => {
    const chs = [Float32Array.from([0.1, -0.5, 1.5, -2]), Float32Array.from([0, 0.25, -0.75, 1])];
    const bytes = encodeWav(chs, { sampleRate: 96000, bits: 32, float: true });
    const dec = decodeWav(bytes);
    expect(dec.float).toBe(true);
    expect(dec.sampleRate).toBe(96000);
    expect(Array.from(dec.floats![0])).toEqual(Array.from(chs[0]));
    expect(dec.chunks.map(c => c.id)).toContain('fact');
  });
  it('BWF : description, date, position, loudness ; acid : tempo et mesure ; INFO ; repères', () => {
    const bytes = encodeWav([signal(SR, 3)], { sampleRate: SR, bits: 24 }, META);
    const dec = decodeWav(bytes);
    const bext = dec.chunks.find(c => c.id === 'bext')!.data;
    const txt = (o: number, n: number) => String.fromCharCode(...bext.subarray(o, o + n)).replace(/\0+$/, '');
    expect(txt(0, 256)).toContain('Nuit blanche');
    expect(txt(0, 256)).toContain('142 BPM');
    expect(txt(256, 32)).toBe('NOVA Studio');
    expect(txt(320, 10)).toBe('2026-10-08');
    const bdv = new DataView(bext.buffer, bext.byteOffset, bext.byteLength);
    expect(bdv.getUint32(338, true)).toBe(12.5 * SR);   // TimeReference
    expect(bdv.getUint16(346, true)).toBe(2);           // version
    expect(bdv.getInt16(412, true)).toBe(-1420);        // LoudnessValue × 100
    const acid = dec.chunks.find(c => c.id === 'acid')!.data;
    const adv = new DataView(acid.buffer, acid.byteOffset, acid.byteLength);
    expect(adv.getFloat32(20, true)).toBeCloseTo(142, 3);
    expect(adv.getUint16(18, true)).toBe(4);
    const info = readInfo(dec);
    expect(info.INAM).toBe('Nuit blanche');
    expect(info.IART).toBe('Léo');
    expect(info.ISRC).toBe('FRZ032600001');
    const cue = dec.chunks.find(c => c.id === 'cue ')!.data;
    const cdv = new DataView(cue.buffer, cue.byteOffset, cue.byteLength);
    expect(cdv.getUint32(0, true)).toBe(2);
    expect(cdv.getUint32(4 + 4, true)).toBe(0.02 * SR);
    const id3 = parseId3v2(dec.chunks.find(c => c.id === 'id3 ')!.data)!;
    expect(id3.frames.TBPM).toBe('142');
    expect(id3.frames.TKEY).toBe('Cm');
  });
});

describe('AIFF', () => {
  for (const [sr, bits] of [[44100, 16], [48000, 24], [96000, 24]] as const) {
    it(`${bits} bits à ${sr} Hz : fréquence (80 bits) et échantillons exacts`, () => {
      const chs = [signal(3000, 4), signal(3000, 5, 'noise')];
      const dec = decodeAiff(encodeAiff(chs, { sampleRate: sr, bits }, META));
      expect(dec.sampleRate).toBe(sr);
      expect(dec.bits).toBe(bits);
      const ref = quantizeChannels(chs, bits);
      expect(Array.from(dec.ints![0])).toEqual(Array.from(ref[0]));
      expect(Array.from(dec.ints![1])).toEqual(Array.from(ref[1]));
      expect(dec.chunks.map(c => c.id)).toEqual(['COMM', 'NAME', 'AUTH', 'ANNO', 'MARK', 'ID3 ', 'SSND']);
    });
  }
  it('AIFF-C fl32 pour le 32 bits flottant', () => {
    const chs = [Float32Array.from([0.5, -1.25, 0.001])];
    const bytes = encodeAiff(chs, { sampleRate: 44100, bits: 32, float: true });
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('AIFC');
    const dec = decodeAiff(bytes);
    expect(dec.float).toBe(true);
    expect(Array.from(dec.floats![0])).toEqual(Array.from(chs[0]));
  });
});

describe('FLAC', () => {
  const cases: [string, Float32Array[], 16 | 24, number][] = [
    ['stéréo 16 bits (mix)', [signal(20000, 1), signal(20000, 2)], 16, 44100],
    ['stéréo 24 bits (bruit, incompressible)', [signal(9000, 3, 'noise'), signal(9000, 4, 'noise')], 24, 48000],
    ['mono 24 bits (sinus)', [signal(12345, 5, 'sine')], 24, 96000],
    ['silence', [signal(5000, 6, 'silence'), signal(5000, 6, 'silence')], 16, 48000],
    ['stéréo identique (côté nul)', [signal(8192, 7), signal(8192, 7)], 24, 48000],
  ];
  for (const [name, chs, bps, sr] of cases) {
    it(`${name} : aller-retour bit à bit, CRC justes, MD5 exacte`, () => {
      const bytes = encodeFlac(chs, sr, bps, META);
      const dec = decodeFlac(bytes);
      expect(dec.sampleRate).toBe(sr);
      expect(dec.bps).toBe(bps);
      expect(dec.crcErrors).toBe(0);
      const ref = quantizeChannels(chs, bps);
      ref.forEach((c, i) => expect(Array.from(dec.channels[i])).toEqual(Array.from(c)));
      // signature MD5 : octets PCM petit-boutiste entrelacés
      const n = ref[0].length, bb = bps / 8, pcm = new Uint8Array(n * ref.length * bb);
      let o = 0;
      for (let i = 0; i < n; i++) for (const c of ref) for (let k = 0; k < bb; k++) pcm[o++] = (c[i] >> (8 * k)) & 0xff;
      expect(Array.from(dec.md5)).toEqual(Array.from(md5(pcm)));
      expect(dec.tags.TITLE).toBe('Nuit blanche');
      expect(dec.tags.BPM).toBe('142');
      expect(dec.tags.INITIALKEY).toBe('Cm');
      expect(dec.tags.ISRC).toBe('FRZ032600001');
      expect(dec.picture).toEqual({ mime: 'image/png', size: 9 });
    });
  }
  it('compresse un signal musical (plus petit que le WAV)', () => {
    const chs = [signal(48000, 8, 'sine'), signal(48000, 9, 'sine')];
    const flac = encodeFlac(chs, 48000, 24);
    expect(flac.length).toBeLessThan(48000 * 2 * 3 * 0.75);
  });
  it('valeurs extrêmes 24 bits', () => {
    const v = new Int32Array([8388607, -8388608, 8388607, -8388608, 0, 1, -1, 8388607]);
    const dec = decodeFlac(encodeFlacInts([v, v.map(x => -x - 1)], 48000, 24));
    expect(Array.from(dec.channels[0])).toEqual(Array.from(v));
    expect(Array.from(dec.channels[1])).toEqual(Array.from(v.map(x => -x - 1)));
  });
});

describe('ID3v2.3', () => {
  it('titre, artiste (accents), BPM, tonalité, ISRC, commentaire et pochette', () => {
    const tag = buildId3v2(META);
    expect(String.fromCharCode(...tag.subarray(0, 3))).toBe('ID3');
    const p = parseId3v2(tag)!;
    expect(p.frames.TIT2).toBe('Nuit blanche');
    expect(p.frames.TPE1).toBe('Léo');
    expect(p.frames.TBPM).toBe('142');
    expect(p.frames.TKEY).toBe('Cm');
    expect(p.frames.TSRC).toBe('FRZ032600001');
    expect(p.frames.COMM).toContain('142 BPM');
    expect(p.cover).toEqual({ mime: 'image/png', size: 9 });
    expect(p.size).toBe(tag.length);
  });
  it('texte hors Latin-1 en UTF-16', () => {
    const p = parseId3v2(buildId3v2({ title: 'Ciel ✦ 夜' }))!;
    expect(p.frames.TIT2).toBe('Ciel ✦ 夜');
  });
});

describe('rééchantillonnage', () => {
  const tone = (f: number, sr: number, n: number) => Float32Array.from({ length: n }, (_, i) => 0.8 * Math.sin(2 * Math.PI * f * i / sr));
  const rmsDb = (x: Float32Array, from = 0, to = x.length) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return 10 * Math.log10(s / (to - from) + 1e-30); };
  it('longueur exacte', () => {
    expect(resampledLength(48000, 48000, 44100)).toBe(44100);
    expect(resampleChannel(new Float32Array(96000), 96000, 44100).length).toBe(44100);
  });
  it('48 → 44,1 kHz : un 1 kHz garde son niveau (±0,05 dB) et sa fréquence', () => {
    const out = resampleChannel(tone(1000, 48000, 48000), 48000, 44100);
    const x = out.subarray(2000, 42000);
    expect(Math.abs(rmsDb(x) - rmsDb(tone(1000, 44100, 40000)))).toBeLessThan(0.05);
    let zc = 0; for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) zc++;
    expect(Math.abs(zc - 1000 * x.length / 44100)).toBeLessThanOrEqual(1);
    // erreur contre le sinus idéal à 44,1 kHz
    const ideal = tone(1000, 44100, 44100);
    let err = 0, sig = 0; for (let i = 2000; i < 42000; i++) { err += (out[i] - ideal[i]) ** 2; sig += ideal[i] ** 2; }
    expect(10 * Math.log10(err / sig)).toBeLessThan(-70);
  });
  it('96 → 44,1 kHz : un 30 kHz (au-delà de la Nyquist) est rejeté à plus de 70 dB', () => {
    const out = resampleChannel(tone(30000, 96000, 96000), 96000, 44100);
    expect(rmsDb(out, 2000, 42000) - rmsDb(tone(30000, 96000, 96000))).toBeLessThan(-70);
  });
  it('44,1 → 96 kHz : pas d\'image au-dessus de 22 kHz', () => {
    const out = resampleChannel(tone(5000, 44100, 44100), 44100, 96000);
    const ideal = tone(5000, 96000, 96000);
    let err = 0, sig = 0; for (let i = 4000; i < 90000; i++) { err += (out[i] - ideal[i]) ** 2; sig += ideal[i] ** 2; }
    expect(10 * Math.log10(err / sig)).toBeLessThan(-60);
  });
});
