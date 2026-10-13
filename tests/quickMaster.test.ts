import { describe, expect, it } from 'vitest';
import {
  QM_STYLES, QM_INTENSITIES, QM_TARGETS, analyzeTrack, renderQuickMaster, referenceTarget, listenGainsDb,
  platformPlayback, masterFileName, mtParamsFor, eqFor, QmCache, QmCancelled,
} from '../utils/quickMaster';
import { truePeakOf, lufsOf } from '../utils/audioMeasure';
import { encodeWav, decodeWav, dequantize } from '../utils/audioFormats';
import { applyEq, thirdOctaveSpectrum, spectralDistance } from '../utils/referenceMatch';
import { sniffSampleRate } from '../services/quickMasterEngine';
import { syntheticSong } from './quickMasterFixture';

const SR = 44100;
const song = syntheticSong(16, SR);
const before = analyzeTrack(song, SR);
const T = (id: string) => QM_TARGETS.find(t => t.id === id)!;

describe('Master express : styles, intensités, cibles', () => {
  it('6 styles et 3 intensités, libellés en français', () => {
    expect(QM_STYLES.map(s => s.label)).toEqual(['Rap / Trap', 'R&B', 'Afro', 'Pop', 'Drill', 'Doux / Acoustique']);
    expect(QM_INTENSITIES.map(i => i.label)).toEqual(['Léger', 'Moyen', 'Fort']);
  });
  it('toutes les cibles plafonnent la crête vraie à −1 dBTP au plus (club compris)', () => {
    for (const t of QM_TARGETS) expect(t.ceiling).toBeLessThanOrEqual(-1);
    expect(T('spotify').lufs).toBe(-14);
    expect(T('apple').lufs).toBe(-16);
  });
  it('cible « comme la référence » bornée à −20 / −7 LUFS', () => {
    expect(referenceTarget(-5).lufs).toBe(-7);
    expect(referenceTarget(-25).lufs).toBe(-20);
    expect(referenceTarget(-10.43).lufs).toBe(-10.4);
  });
  it('Mastering Transient : entrée ramenée à −18 LUFS, intensité qui dose emphase et densité', () => {
    const leger = mtParamsFor('rap', 'leger', -22), fort = mtParamsFor('rap', 'fort', -22);
    expect(leger.inputGain).toBeCloseTo(4, 5);
    expect(fort.emphasis).toBeGreaterThan(leger.emphasis);
    expect(fort.limitGain).toBeGreaterThan(leger.limitGain);
    expect(leger.clipperOn).toBe(0);
  });
  it('EQ de style douce (±3 dB) ; EQ de référence ±4 dB au plus', () => {
    const st = eqFor(before.curve, SR, { style: 'drill', intensity: 'fort', target: T('spotify') });
    expect(st.source).toBe('style');
    for (const b of st.bands) expect(Math.abs(b.gainDb)).toBeLessThanOrEqual(3);
    const dark = applyEq(song, SR, [{ type: 'highshelf', freq: 3000, q: 0.7, gainDb: -8 }]);
    const r = eqFor(before.curve, SR, { style: 'rap', intensity: 'moyen', target: T('spotify'), refCurve: thirdOctaveSpectrum(dark, SR) });
    expect(r.source).toBe('reference');
    for (const b of r.bands) expect(Math.abs(b.gainDb)).toBeLessThanOrEqual(4);
  });
});

describe('Master express : rendu', () => {
  it('Spotify −14 : LUFS à ±0,5 LU, crête vraie ≤ −1 dBTP (mesure ×8), et rendu identique au bit près d’une fois sur l’autre', async () => {
    const a = await renderQuickMaster(song, SR, before, { style: 'rap', intensity: 'moyen', target: T('spotify') });
    expect(Math.abs(a.after.lufs + 14)).toBeLessThanOrEqual(0.5);
    expect(truePeakOf(a.out, 8, 64)).toBeLessThanOrEqual(-1);
    expect(a.reached).toBe(true);
    const b = await renderQuickMaster(song, SR, before, { style: 'rap', intensity: 'moyen', target: T('spotify') });
    expect(b.out.every((x, c) => x.every((v, i) => v === a.out[c][i]))).toBe(true);
  }, 120_000);

  it('Apple −16 et club −9 (Drill fort) : cibles tenues, plafond −1 dBTP', async () => {
    for (const [id, style, intensity] of [['apple', 'doux', 'leger'], ['club', 'drill', 'fort']] as const) {
      const r = await renderQuickMaster(song, SR, before, { style, intensity, target: T(id) });
      expect(Math.abs(r.after.lufs - T(id).lufs)).toBeLessThanOrEqual(0.5);
      expect(r.after.truePeak).toBeLessThanOrEqual(-1);
    }
  }, 180_000);

  it('écoute = export : le WAV 24 bits relu reste à moins de 1 LSB 16 bits du tampon écouté', async () => {
    const r = await renderQuickMaster(song, SR, before, { style: 'pop', intensity: 'moyen', target: T('youtube') });
    const dec = decodeWav(encodeWav(r.out, { sampleRate: SR, bits: 24 }));
    let worst = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < r.out[c].length; i++) worst = Math.max(worst, Math.abs(r.out[c][i] - dequantize(dec.ints![c][i], 24)) * 32768);
    expect(worst).toBeLessThan(1 / 256 + 1e-9); // ½ LSB 24 bits = 1/512 LSB 16
    expect(dec.sampleRate).toBe(SR);
  }, 120_000);

  it('référence : l’écart spectral avec la référence diminue (EQ calée, ±4 dB au plus)', async () => {
    // Référence : la même musique, plus brillante et moins grave (un autre mix).
    const ref = applyEq(syntheticSong(16, SR, { seed: 777, bright: 1.6 }), SR, [{ type: 'lowshelf', freq: 150, q: 0.7, gainDb: -4 }, { type: 'highshelf', freq: 5000, q: 0.7, gainDb: 4 }]);
    const refA = analyzeTrack(ref, SR);
    const r = await renderQuickMaster(song, SR, before, { style: 'rap', intensity: 'moyen', target: referenceTarget(refA.lufs), refCurve: refA.curve });
    expect(r.eqSource).toBe('reference');
    expect(r.refDistance!.after).toBeLessThan(r.refDistance!.before * 0.7);
    expect(r.refDistance!.tonalAfter).toBeLessThan(r.refDistance!.tonalBefore * 0.6);
    expect(Math.abs(r.after.lufs - referenceTarget(refA.lufs).lufs)).toBeLessThanOrEqual(0.5);
    for (const b of r.eq) expect(Math.abs(b.gainDb)).toBeLessThanOrEqual(4);
    expect(spectralDistance(r.after.curve, refA.curve)).toBeCloseTo(r.refDistance!.after, 6);
  }, 120_000);

  it('cache : changer de cible ne refait pas le Mastering Transient, et le résultat est le même qu’un rendu complet', async () => {
    const store = new Map<string, QmCache>();
    let sets = 0;
    const cache = { get: (k: string) => store.get(k), set: (c: QmCache) => { sets++; store.set(c.key, c); } };
    await renderQuickMaster(song, SR, before, { style: 'afro', intensity: 'moyen', target: T('spotify') }, {}, cache);
    const viaCache = await renderQuickMaster(song, SR, before, { style: 'afro', intensity: 'moyen', target: T('apple') }, {}, cache);
    expect(sets).toBe(1);
    const direct = await renderQuickMaster(song, SR, before, { style: 'afro', intensity: 'moyen', target: T('apple') });
    expect(viaCache.out.every((x, c) => x.every((v, i) => v === direct.out[c][i]))).toBe(true);
  }, 180_000);

  it('annulation : un rendu interrompu lève QmCancelled', async () => {
    let calls = 0;
    await expect(renderQuickMaster(song, SR, before, { style: 'rap', intensity: 'moyen', target: T('spotify') }, {
      yieldNow: () => new Promise(r => setTimeout(r, 0)), isCancelled: () => ++calls > 1,
    })).rejects.toBeInstanceOf(QmCancelled);
  }, 60_000);

  it('un silence est refusé avec un message clair', async () => {
    const z = [new Float32Array(SR * 2), new Float32Array(SR * 2)];
    await expect(renderQuickMaster(z, SR, analyzeTrack(z, SR), { style: 'rap', intensity: 'moyen', target: T('spotify') })).rejects.toThrow(/silencieux/);
  });
});

describe('Écoute honnête et plateformes', () => {
  it('même volume perçu : on baisse le plus fort, jamais on ne monte', () => {
    const g = listenGainsDb({ original: -19, master: -14, reference: -9 });
    expect(g.original).toBeCloseTo(0);
    expect(g.master).toBeCloseTo(-5);
    expect(g.reference).toBeCloseTo(-10);
    expect(listenGainsDb({ original: -10, master: -16 }).original).toBeCloseTo(-6);
  });
  it('normalisation des plateformes : un master à −9 LUFS est baissé de 5 dB sur Spotify, de 7 sur Apple', () => {
    const p = platformPlayback(-9);
    expect(p.find(x => x.id === 'spotify')!.changeDb).toBeCloseTo(-5);
    expect(p.find(x => x.id === 'apple')!.changeDb).toBeCloseTo(-7);
    expect(platformPlayback(-16).every(x => x.changeDb === 0)).toBe(true);
  });
  it('nom du fichier exporté', () => {
    expect(masterFileName('Mon son.mp3', 'rap', T('spotify'), 'wav')).toBe('Mon son (master Nova Rap-Trap -14 LUFS).wav');
    expect(masterFileName('a/b:c.wav', 'doux', referenceTarget(-10.5), 'mp3')).toBe('a b c (master Nova Doux-Acoustique -10,5 LUFS).mp3');
  });
});

describe('Lecture du fichier à sa fréquence d’origine', () => {
  it('WAV : fréquence lue dans le chunk fmt', () => {
    expect(sniffSampleRate(encodeWav([new Float32Array(10)], { sampleRate: 96000, bits: 24 }))).toBe(96000);
  });
  it('MP3 : trame MPEG-1 à 44,1 kHz après une étiquette ID3', () => {
    const b = new Uint8Array(64);
    b.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 4]); // ID3, taille 4
    b.set([0xff, 0xfb, 0x90, 0x64], 14); // MPEG-1 couche III, 128 kb/s, 44,1 kHz
    expect(sniffSampleRate(b)).toBe(44100);
    b[16] = 0x94; // indice 1 : 48 kHz
    expect(sniffSampleRate(b)).toBe(48000);
  });
  it('FLAC : STREAMINFO', () => {
    const b = new Uint8Array(42);
    b.set([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 34]);
    const sr = 88200;
    b[18] = (sr >> 12) & 0xff; b[19] = (sr >> 4) & 0xff; b[20] = (sr & 0xf) << 4;
    expect(sniffSampleRate(b)).toBe(88200);
  });
  it('inconnu : null', () => { expect(sniffSampleRate(new Uint8Array(100))).toBeNull(); });
});

describe('Mesures', () => {
  it('le morceau synthétique ressemble à un mix non masterisé (≈ −20 LUFS, crêtes ≈ −5 dBTP)', () => {
    expect(before.lufs).toBeGreaterThan(-22);
    expect(before.lufs).toBeLessThan(-18);
    expect(before.truePeak).toBeLessThan(-3);
    expect(lufsOf(song, SR)).toBeCloseTo(before.lufs, 6);
  });
});
