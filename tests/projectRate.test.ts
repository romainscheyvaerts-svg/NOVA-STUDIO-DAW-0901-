/**
 * Fréquence d'échantillonnage du projet (12/10/2026) : réglage, lecture de la
 * fréquence d'un fichier, conversion studio, collaboration, modèles, réparation.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  currentRate, isProjectRate, LEGACY_PROJECT_RATE, NEW_PROJECT_RATE, projectRateOf, rateChangeMessage, rateLabel,
  sanitizeRate, setCurrentRate, sniffSampleRate,
} from '../utils/projectRate';
import { resampleChannel } from '../utils/resample';
import { encodeAiff, encodeWav } from '../utils/audioFormats';
import { encodeFlac } from '../utils/flac';
import { SONG_FIELDS, sanitizeSongField, songFieldsOf } from '../utils/collabContent';
import { createTemplateFromState, instantiateTemplate, parseTemplate, templateRate } from '../utils/sessionTemplate';
import { repairProject } from '../utils/projectRepair';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { convertRegistryTo, registryConversionPlan, resampleBuffer } from '../utils/hqAudio';
import { FakeAudioBuffer, makeBuffer } from './helpers/audio';
import { makeState, makeTrack } from './helpers/fixtures';

const tone = (f: number, sr: number, n = sr) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / sr); return x; };
/** Amplitude (dB rel. 0,5) de la fréquence f au milieu du signal. */
const levelDb = (y: Float32Array, sr: number, f: number) => {
  const a = Math.floor(y.length * 0.25), b = Math.floor(y.length * 0.75);
  let s = 0, c = 0;
  for (let i = a; i < b; i++) { s += y[i] * Math.sin(2 * Math.PI * f * i / sr); c += y[i] * Math.cos(2 * Math.PI * f * i / sr); }
  return 20 * Math.log10(2 * Math.hypot(s, c) / (b - a) / 0.5 + 1e-12);
};

describe('fréquence du projet : réglage', () => {
  it('nouveau projet 48 kHz ; projet sans fréquence = 44,1 kHz (ancien moteur) ; valeurs invalides refusées', () => {
    expect(NEW_PROJECT_RATE).toBe(48000);
    expect(LEGACY_PROJECT_RATE).toBe(44100);
    expect(projectRateOf({})).toBe(44100);
    expect(projectRateOf(null)).toBe(44100);
    expect(projectRateOf({ sampleRate: 96000 })).toBe(96000);
    expect(projectRateOf({ sampleRate: 22050 })).toBe(44100);
    expect([44100, 48000, 88200, 96000].every(isProjectRate)).toBe(true);
    expect(sanitizeRate('48000')).toBe(48000);
    expect(sanitizeRate(192000)).toBeNull();
    expect(rateLabel(44100)).toBe('44,1 kHz');
    expect(rateLabel(48000)).toBe('48 kHz');
    expect(rateLabel(88200)).toBe('88,2 kHz');
  });

  it("l'avertissement dit ce qui sera converti et comment revenir en arrière", () => {
    const m = rateChangeMessage({ from: 44100, to: 48000, buffers: 3, seconds: 185 });
    expect(m).toMatch(/44,1 kHz à 48 kHz/);
    expect(m).toMatch(/3 sons \(3 min 05 s\) seront rééchantillonnés/);
    expect(m).toMatch(/Ctrl\+Z/);
    expect(rateChangeMessage({ from: 48000, to: 96000, buffers: 0, seconds: 0 })).toMatch(/Aucun son à convertir/);
  });

  it('fréquence en cours (repli des modules sans moteur) suit le moteur', () => {
    const was = currentRate();
    setCurrentRate(96000);
    expect(currentRate()).toBe(96000);
    setCurrentRate(was);
  });
});

describe("fréquence d'origine d'un fichier (en-tête)", () => {
  const ch = [tone(1000, 48000, 480), tone(1000, 48000, 480)];
  it('WAV, AIFF, FLAC à toutes les fréquences du projet', () => {
    for (const sr of [44100, 48000, 88200, 96000]) {
      expect(sniffSampleRate(encodeWav(ch, { sampleRate: sr, bits: 24 }))).toBe(sr);
      expect(sniffSampleRate(encodeWav(ch, { sampleRate: sr, bits: 32, float: true }))).toBe(sr);
      expect(sniffSampleRate(encodeAiff(ch, { sampleRate: sr, bits: 16 }))).toBe(sr);
      expect(sniffSampleRate(encodeFlac(ch, sr, 24))).toBe(sr);
    }
  });
  it('MP3 (après ID3), Ogg Opus / Vorbis, WebM Opus ; inconnu = null', () => {
    const id3 = [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0];
    const mp3 = (b2: number) => new Uint8Array([...id3, 0xff, 0xfb, b2, 0x64, ...new Array(64).fill(0)]);
    expect(sniffSampleRate(mp3(0x90))).toBe(44100);   // MPEG-1, 128 kb/s, index 0
    expect(sniffSampleRate(mp3(0x94))).toBe(48000);   // index 1
    const ogg = (body: string) => new Uint8Array([...'OggS'].map(c => c.charCodeAt(0)).concat(new Array(24).fill(0), [...body].map(c => c.charCodeAt(0)), new Array(32).fill(0)));
    expect(sniffSampleRate(ogg('OpusHead'))).toBe(48000);
    const vorbis = ogg('\x01vorbis');
    const at = 28 + 7 + 5;  // \x01vorbis + version (4) + canaux (1)
    new DataView(vorbis.buffer).setUint32(at, 44100, true);
    expect(sniffSampleRate(vorbis)).toBe(44100);
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...[...'xxxxA_OPUSxxxx'].map(c => c.charCodeAt(0))]);
    expect(sniffSampleRate(webm)).toBe(48000);
    expect(sniffSampleRate(new Uint8Array(64))).toBeNull();
    expect(sniffSampleRate(new Uint8Array(4))).toBeNull();
  });
});

describe('conversion studio (utils/resample) : plate jusqu’à 20 kHz', () => {
  it('44,1 → 48 et 48 → 44,1 : ≤ 0,05 dB de 1 à 20 kHz ; repliement ≤ −100 dB', () => {
    for (const [from, to] of [[44100, 48000], [48000, 44100], [44100, 96000], [96000, 48000]]) {
      for (const f of [1000, 10000, 18000, 19000, 20000]) {
        const y = resampleChannel(tone(f, from, Math.round(from / 4)), from, to);
        expect(Math.abs(levelDb(y, to, f)), `${from}→${to} à ${f} Hz`).toBeLessThan(0.05);
      }
    }
    // 23 kHz à 48 kHz → 44,1 kHz : se replierait à 21,1 kHz.
    const y = resampleChannel(tone(23000, 48000, 12000), 48000, 44100);
    expect(levelDb(y, 44100, 21100)).toBeLessThan(-100);
  });
});

describe('sons du projet convertis une fois (utils/hqAudio)', () => {
  beforeAll(() => { (globalThis as any).AudioBuffer = FakeAudioBuffer; });
  afterEach(() => audioBufferRegistry.clear());

  it('registre : plan, conversion sous le même identifiant, un seul calcul par son', async () => {
    const a = makeBuffer(2, 4410, 44100, (c, i) => Math.sin(2 * Math.PI * 1000 * i / 44100) * 0.5);
    const b = makeBuffer(1, 4800, 48000);
    audioBufferRegistry.register(a, 'clip-a');
    audioBufferRegistry.register(a, 'clip-a-copie');
    audioBufferRegistry.register(b, 'clip-b');
    expect(registryConversionPlan(48000)).toEqual({ buffers: 2, seconds: 0.2 });
    await convertRegistryTo(48000);
    const na = audioBufferRegistry.get('clip-a')!;
    expect(na.sampleRate).toBe(48000);
    expect(na.length).toBe(4800);
    expect(na.numberOfChannels).toBe(2);
    expect(audioBufferRegistry.get('clip-a-copie')).toBe(na);     // même calcul partagé
    expect(audioBufferRegistry.get('clip-b')).toBe(b);            // déjà à la bonne fréquence
    expect(registryConversionPlan(48000).buffers).toBe(0);
    expect(Math.abs(levelDb(na.getChannelData(0), 48000, 1000))).toBeLessThan(0.05);
    expect(await resampleBuffer(b, 48000)).toBe(b);
  });
});

describe('collaboration : une seule fréquence, celle du projet', () => {
  it('voyage avec les champs de la session (dernière écriture gagne), vérifiée à la réception', () => {
    expect(SONG_FIELDS).toContain('sampleRate');
    expect(songFieldsOf({ sampleRate: 48000 }).sampleRate).toBe(48000);
    expect(songFieldsOf({}).sampleRate).toBeNull();               // ancien projet : 44,1 kHz chez l'autre aussi
    expect(sanitizeSongField('sampleRate', 96000)).toBe(96000);
    expect(sanitizeSongField('sampleRate', 12345)).toBeUndefined();
    expect(sanitizeSongField('sampleRate', null)).toBeNull();
  });
});

describe('modèles : fréquence de la session d’origine', () => {
  const dir = path.resolve(__dirname, '../templates');
  it('LENNON : 44,1 kHz (session Pro Tools relue par PTSL) ; Make Music : 48 kHz', () => {
    const lennon = parseTemplate(fs.readFileSync(path.join(dir, 'romain-lennon-depart.novatemplate'), 'utf8'));
    const mm = parseTemplate(fs.readFileSync(path.join(dir, 'make-music-voix.novatemplate'), 'utf8'));
    expect(templateRate(lennon)).toBe(44100);
    expect(templateRate(mm)).toBe(48000);
    expect(instantiateTemplate(mm, { plugins: null }).state.sampleRate).toBe(48000);
    expect(instantiateTemplate(mm, { plugins: null, sampleRate: 96000 }).state.sampleRate).toBe(96000);
  });
  it('un projet enregistré comme modèle garde sa fréquence', () => {
    const st = makeState([makeTrack({ id: 'voix', name: 'Voix' })], { sampleRate: 88200 });
    const tpl = createTemplateFromState(st, { name: 'M', id: 'tpl-x', now: 1 });
    expect(tpl.session.sampleRate).toBe(88200);
    expect(instantiateTemplate(tpl, { plugins: null }).state.sampleRate).toBe(88200);
  });
});

describe('projet abîmé : fréquence illisible', () => {
  it('retirée (projet ouvert en 44,1 kHz), avec un rapport', () => {
    const st = makeState([makeTrack({ id: 'voix', name: 'Voix' })]) as any;
    const ok = repairProject({ ...st, sampleRate: 96000 });
    expect(ok.state!.sampleRate).toBe(96000);
    expect(ok.report.join(" ")).not.toMatch(/Fréquence/);
    const bad = repairProject({ ...st, sampleRate: 'abc' });
    expect(bad.state!.sampleRate).toBeUndefined();
    expect(bad.report.join(' ')).toMatch(/Fréquence d'échantillonnage illisible/);
  });
});
