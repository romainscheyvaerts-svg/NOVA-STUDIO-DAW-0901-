/**
 * Chantier C1 · prise écrite par le pont : lecture du WAV, calage identique à la prise du
 * navigateur, message des blocs perdus, morceaux de fichier, repères carte ↔ contexte.
 */
import { describe, expect, it } from 'vitest';
import { bridgeTakePlacement, bridgeTrackSpec, lossMessage, lostBlocks, newBridgeTakeId, parseWav } from '../utils/bridgeTake';
import { decodeFileChunk, FILE_MAGIC, joinFileChunks } from '../utils/asioProtocol';
import { srcFrameFromAnchors } from '../engine/ASIOInput';

/** WAV float 32 comme celui du pont (en-tête de 58 octets : fmt de 18 + fact). */
function bridgeWav(channels: Float32Array[], sr: number, truncateHeader = false): ArrayBuffer {
  const nc = channels.length, n = channels[0].length;
  const data = n * nc * 4;
  const buf = new ArrayBuffer(58 + data);
  const v = new DataView(buf);
  const str = (o: number, t: string) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 50 + data, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 18, true); v.setUint16(20, 3, true); v.setUint16(22, nc, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 4 * nc, true); v.setUint16(32, 4 * nc, true); v.setUint16(34, 32, true); v.setUint16(36, 0, true);
  str(38, 'fact'); v.setUint32(42, 4, true); v.setUint32(46, n, true);
  // Pont arrêté net : l'en-tête annonce moins que ce qui est sur le disque (dernier passage).
  str(50, 'data'); v.setUint32(54, truncateHeader ? Math.floor(n / 2) * nc * 4 : data, true);
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) v.setFloat32(58 + (i * nc + c) * 4, channels[c][i], true);
  return buf;
}

const MOD = 1 << 20;
const ramp = (from: number, n: number, off = 0) => Float32Array.from({ length: n }, (_, i) => ((from + i + off) % MOD) / MOD - 0.5);

describe('parseWav', () => {
  it('relit le WAV float 32 du pont au bit près (mono et stéréo)', () => {
    const a = ramp(1000, 4801), b = ramp(1000, 4801, 1000);
    const w = parseWav(bridgeWav([a], 48000));
    expect(w.sampleRate).toBe(48000);
    expect(w.frames).toBe(4801);
    expect(Array.from(w.channels[0])).toEqual(Array.from(a));
    const s = parseWav(bridgeWav([a, b], 44100));
    expect(s.channels.length).toBe(2);
    expect(Array.from(s.channels[1])).toEqual(Array.from(b));
  });
  it("se fie à l'en-tête (fichier réparé par le pont) et lit aussi le PCM 24 bits", () => {
    const a = ramp(0, 1000);
    expect(parseWav(bridgeWav([a], 48000, true)).frames).toBe(500);
    const buf = new ArrayBuffer(44 + 3 * 2);
    const v = new DataView(buf);
    const str = (o: number, t: string) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + 6, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 48000, true); v.setUint32(28, 144000, true); v.setUint16(32, 3, true); v.setUint16(34, 24, true);
    str(36, 'data'); v.setUint32(40, 6, true);
    v.setUint8(44, 0); v.setUint8(45, 0); v.setUint8(46, 0x40);          // +0,5
    v.setUint8(47, 0); v.setUint8(48, 0); v.setUint8(49, 0xc0);          // −0,5
    expect(Array.from(parseWav(buf).channels[0])).toEqual([0.5, -0.5]);
  });
  it('refuse un fichier qui n\'est pas un WAV', () => {
    expect(() => parseWav(new ArrayBuffer(8))).toThrow();
  });
});

describe('bridgeTakePlacement : même calage que la prise du navigateur', () => {
  /** Prise du navigateur (AudioEngine.stopCalibratedRecording) : début et 1re image gardée. */
  function browser(pos0: number, lead: number, lat: number, sr: number) {
    const rawStart = pos0 + lead / sr;
    let start = rawStart - lat;
    let skip = 0;
    if (start < 0) { skip = Math.round(-start * sr); start = 0; }
    return { start, from: lead + skip };
  }

  for (const c of [
    { name: 'lecture en cours', pos0: 4.2, lead: 0, lat: 0.0123 },
    { name: 'pré-roll / décompte (avance retirée)', pos0: 1.5, lead: 9600, lat: 0.02 },
    { name: 'prise à 0 s (début rogné, pas décalé)', pos0: 0.001, lead: 0, lat: 0.03 },
  ]) {
    it(c.name, () => {
      const sr = 48000, S = 100000, Y = S + 48000 + 37;   // le pont a commencé 1 s (+37) avant la page
      const b = browser(c.pos0, c.lead, c.lat, sr);
      const p = bridgeTakePlacement({ startFrame: S, anchorFrame: Y, pos0: c.pos0, latency: c.lat, lead: c.lead, sampleRate: sr, frames: 10 * sr });
      expect(p.start).toBe(b.start);
      // La 1re image gardée du fichier du pont EST l'image de la carte de la 1re image gardée par la page.
      expect(S + p.from).toBe(Y + b.from);
      expect(p.frames).toBe(10 * sr - p.from);
    });
  }

  it('pont parti après la page : le clip commence plus tard, rien ne glisse', () => {
    const sr = 48000;
    const p = bridgeTakePlacement({ startFrame: 1000, anchorFrame: 900, pos0: 2, latency: 0, lead: 0, sampleRate: sr, frames: sr });
    expect(p.from).toBe(0);
    expect(p.start).toBeCloseTo(2 + 100 / sr, 12);
  });
});

describe('message des blocs perdus', () => {
  it('« 2 blocs perdus pendant la prise, à 0:43 »', () => {
    const msg = lossMessage([{ frame: 1000 + 43 * 48000, frames: 512, kind: 'asio' }], 256, f => (f - 1000) / 48000);
    expect(msg).toContain('2 blocs perdus pendant la prise, à 0:43');
    expect(msg).toContain('carte son');
    expect(msg).toContain('calée');
  });
  it('plusieurs pertes, disque en retard ; rien perdu : pas de message', () => {
    const m = lossMessage([{ frame: 0, frames: 100, kind: 'tampon' }, { frame: 48000 * 72, frames: 300, kind: 'tampon' }], 256, f => f / 48000);
    expect(m).toContain('2 blocs perdus pendant la prise, à 0:00 et 1:12');
    expect(m).toContain('disque');
    expect(lossMessage([], 256, f => f)).toBeNull();
    expect(lostBlocks([{ frame: 0, frames: 10, kind: 'asio' }], 256)).toBe(1);
  });
});

describe('protocole du fichier de prise (NVF1)', () => {
  it('morceaux remis dans l\'ordre ; il en manque un : rien', () => {
    const mk = (i: number, count: number, bytes: number[]) => {
      const b = new ArrayBuffer(16 + bytes.length);
      const v = new DataView(b);
      v.setUint32(0, FILE_MAGIC, true); v.setUint32(4, 7, true); v.setUint32(8, i, true); v.setUint32(12, count, true);
      new Uint8Array(b, 16).set(bytes);
      return decodeFileChunk(b)!;
    };
    const parts = [mk(1, 3, [4, 5]), mk(0, 3, [1, 2, 3]), mk(2, 3, [6])];
    expect(parts[0].req).toBe(7);
    expect(Array.from(new Uint8Array(joinFileChunks(parts)!))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(joinFileChunks(parts.slice(0, 2))).toBeNull();
    expect(decodeFileChunk(new ArrayBuffer(32))).toBeNull();    // bloc audio, pas un fichier
  });
});

describe('repères carte ↔ contexte (lecteur d\'entrée ASIO)', () => {
  it('droite entre deux discontinuités, repère suivant si aucun avant', () => {
    const a = [{ ctx: 1000, src: 5000, ratio: 1 }, { ctx: 3000, src: 9000, ratio: 1 }];
    expect(srcFrameFromAnchors(a, 1500)).toBe(5500);
    expect(srcFrameFromAnchors(a, 3200)).toBe(9200);       // après le saut (page figée puis rattrapage)
    expect(srcFrameFromAnchors(a, 500)).toBe(4500);
    expect(srcFrameFromAnchors([], 10)).toBeNull();
  });
});

describe('pistes côté pont', () => {
  it('mono, stéréo, entrée auto (1+2 additionnées)', () => {
    expect(bridgeTrackSpec([3], 1)).toEqual({ inputs: [3], mode: 'mono' });
    expect(bridgeTrackSpec([2, 3], 2)).toEqual({ inputs: [2, 3], mode: 'stereo' });
    expect(bridgeTrackSpec([0, 1], 1)).toEqual({ inputs: [0, 1], mode: 'sum' });
    expect(newBridgeTakeId()).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
