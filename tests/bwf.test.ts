import { describe, expect, it } from 'vitest';
import {
  encodeBwf, parseBwf, samplesToTimecode, safeFilePart, splitU64, takeFileName, takeRegion, timecodeToSamples, toInt24,
} from '../utils/bwf';

/** Pont Pro Tools (chantier 9) : BWF horodaté, TimeReference à l'échantillon près. */

const ramp = (n: number, k = 1) => Float32Array.from({ length: n }, (_x, i) => Math.fround(((i * k) % 2000) / 2000 - 0.5));

describe('BWF : TimeReference exact à l’échantillon', () => {
  for (const sr of [44100, 48000]) {
    it(`${sr} Hz : position du morceau + départ de séance 01:00:00:00, relus tels quels`, () => {
      const pos = 12.345678 * sr;  // pas un multiple entier : on part d'un nombre d'échantillons entier
      const position = Math.round(pos);
      const start = timecodeToSamples('01:00:00:00', 25, sr)!;
      expect(start).toBe(3600 * sr);
      const bytes = encodeBwf({ channels: [ramp(sr)], sampleRate: sr, format: '24', timeReference: start + position, info: { track: 'Voix lead', take: 3, artist: 'Lina' } });
      const p = parseBwf(bytes);
      expect(p.timeReference).toBe(3600 * sr + position);
      expect(p.sampleRate).toBe(sr);
      expect(p.bits).toBe(24);
      expect(p.frames).toBe(sr);
      expect(p.description).toBe('NOVA - Voix lead - Prise 3 - Lina');
      expect(p.originator).toBe('NOVA Studio');
      expect(p.codingHistory).toContain(`A=PCM,F=${sr},W=24,M=mono`);
    });
  }
  it('au-delà de 2^32 échantillons (23 h à 96 kHz) : mot de poids fort écrit', () => {
    const tr = 23 * 3600 * 96000 + 7;
    expect(tr).toBeGreaterThan(2 ** 32);
    const p = parseBwf(encodeBwf({ channels: [ramp(10)], sampleRate: 96000, format: '24', timeReference: tr, info: { track: 'A', take: 1 } }));
    expect(p.timeReference).toBe(tr);
    expect(splitU64(tr)).toEqual([Math.floor(tr / 2 ** 32), tr % 2 ** 32]);
  });
  it('position négative refusée (avant le départ de la séance)', () => {
    expect(() => encodeBwf({ channels: [ramp(10)], sampleRate: 48000, format: '24', timeReference: -1, info: { track: 'A', take: 1 } })).toThrow();
  });
});

describe('BWF : contenu', () => {
  it('32 bits flottants : identique au bit près (stéréo entrelacée)', () => {
    const l = ramp(4800, 1), r = ramp(4800, 7);
    l[5] = -1; r[9] = 0.999999; l[10] = 1e-30;
    const p = parseBwf(encodeBwf({ channels: [l, r], sampleRate: 48000, format: '32f', timeReference: 0, info: { track: 'Voix', take: 1 } }));
    expect(p.float).toBe(true);
    expect(p.channels).toBe(2);
    expect(Array.from(p.samples[0] as Float32Array)).toEqual(Array.from(l));
    expect(Array.from(p.samples[1] as Float32Array)).toEqual(Array.from(r));
    expect(p.codingHistory).toContain('A=PCM_FLOAT,F=48000,W=32,M=stereo');
  });
  it('24 bits : arrondi à l’entier le plus proche, écrêté ; un son venu d’un WAV 16 bits ressort exact', () => {
    const x = Float32Array.from([0, 0.5, -0.5, 1, -1, 1.5, -2, 1 / 32768, -12345 / 32768]);
    const p = parseBwf(encodeBwf({ channels: [x], sampleRate: 44100, format: '24', timeReference: 5, info: { track: 'V', take: 2 } }));
    expect(Array.from(p.samples[0])).toEqual(Array.from(x, toInt24));
    expect(p.samples[0][7]).toBe(256);            // 1 LSB16 = 256 LSB24, exact
    expect(p.samples[0][8]).toBe(-12345 * 256);
    expect(p.samples[0][3]).toBe(8388607);        // +1 écrêté
  });
  it('iXML : projet, piste, prise, horodatage en échantillons depuis minuit, cadence', () => {
    const p = parseBwf(encodeBwf({ channels: [ramp(10)], sampleRate: 48000, format: '24', timeReference: 172800123,
      info: { project: 'Séance <LENNON>', track: 'Voix lead', take: 4, artist: 'Lina', fps: 25 } }));
    expect(p.ixml).toContain('<PROJECT>Séance &lt;LENNON&gt;</PROJECT>');
    expect(p.ixml).toContain('<SCENE>Voix lead</SCENE>');
    expect(p.ixml).toContain('<TAKE>4</TAKE>');
    expect(p.ixml).toContain('<TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>172800123</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>');
    expect(p.ixml).toContain('<TIMESTAMP_SAMPLE_RATE>48000</TIMESTAMP_SAMPLE_RATE>');
    expect(p.ixml).toContain('<TIMECODE_RATE>25/1</TIMECODE_RATE>');
  });
  it('taille RIFF cohérente, chunks pairs', () => {
    const b = encodeBwf({ channels: [ramp(3)], sampleRate: 48000, format: '24', timeReference: 0, info: { track: 'V', take: 1 } });
    const dv = new DataView(b.buffer);
    expect(dv.getUint32(4, true)).toBe(b.length - 8);
    expect(b.length % 2).toBe(0);
  });
});

describe('timecode de départ de séance', () => {
  it('HH:MM:SS:FF → échantillons, et retour', () => {
    expect(timecodeToSamples('00:00:00:00', 25, 48000)).toBe(0);
    expect(timecodeToSamples('01:00:00:00', 30, 44100)).toBe(3600 * 44100);
    expect(timecodeToSamples('00:00:01:12', 24, 48000)).toBe(48000 + 24000);
    expect(timecodeToSamples('00:00:00:01', 24, 44100)).toBe(1838);   // 1837,5 arrondi
    expect(samplesToTimecode(3600 * 48000 + 48000 + 1920, 25, 48000)).toBe('01:00:01:01');
  });
  it('invalide : null', () => {
    for (const bad of ['', '1:00', '24:00:00:00', '00:60:00:00', '00:00:00:25', 'abc']) expect(timecodeToSamples(bad, 25, 48000)).toBeNull();
  });
});

describe('prise → région écrite', () => {
  it('clip recoupé : début, décalage et longueur en échantillons entiers', () => {
    expect(takeRegion({ start: 2, offset: 0.5, duration: 3 }, 48000 * 10, 48000)).toEqual({ position: 96000, from: 24000, length: 144000 });
  });
  it('clip qui dépasse la fin du son : borné', () => {
    expect(takeRegion({ start: 1, offset: 0, duration: 5 }, 48000 * 2, 48000)).toEqual({ position: 48000, from: 0, length: 96000 });
  });
  it('clip avant le début du morceau : coupé à 0', () => {
    expect(takeRegion({ start: -0.5, offset: 0, duration: 2 }, 48000 * 2, 48000)).toEqual({ position: 0, from: 24000, length: 72000 });
  });
  it('vide : null', () => {
    expect(takeRegion({ start: 0, offset: 3, duration: 1 }, 48000, 48000)).toBeNull();
  });
});

describe('nom de fichier', () => {
  it('<piste>_Prise <n>_<artiste>.wav, caractères interdits retirés', () => {
    expect(takeFileName('Voix lead', 3, 'Lina')).toBe('Voix lead_Prise 3_Lina.wav');
    expect(takeFileName('Voix: "lead"/2?', 12, 'Léa <3')).toBe('Voix lead 2_Prise 12_Léa 3.wav');
    expect(takeFileName('CON', 1, '')).toBe('Piste_Prise 1_Artiste.wav');
    expect(safeFilePart('a_b', 'x')).toBe('a-b');                   // « _ » réservé au séparateur
    expect(safeFilePart('fin. . ', 'x')).toBe('fin');
  });
});
