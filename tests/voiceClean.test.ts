import { describe, expect, it } from 'vitest';
import {
  applyFrameGains, blendChannels, cleanBlock, cleanEngineFor, cleanPatch, cleanRegion, cleanStepName, cleanSummary, cleanVoice,
  DEFAULT_CLEAN_OPTIONS, describeCleanError, estimateCleanSeconds, levelVoice, noiseFloorDb, pickCleanTarget, silenceGainsDb,
  STRENGTH_ORDER, STRENGTHS, type CleanOptions,
} from '../utils/voiceClean';
import { RNNOISE_FRAME, type RnnoiseEngine } from '../utils/rnnoise';
import { audioSuiteRevertPatch, patchClip } from '../utils/clipProcess';
import { makeClip } from './helpers/fixtures';
import { TrackType } from '../types';

const SR = 48000;
const rms = (x: Float32Array, a = 0, b = x.length) => { a = Math.round(a); b = Math.round(b); let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
const db = (v: number) => 20 * Math.log10(v);
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; }
const sine = (n: number, amp: number, f = 220, sr = SR) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr));

/** Faux RNNoise : divise par 10 les trames calmes, garde les fortes ; probabilité de voix = énergie. */
function fakeEngine(): RnnoiseEngine & { created: number } {
  const e = {
    created: 0,
    create() {
      e.created++;
      return {
        process(f: Float32Array) {
          let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i];
          const loud = Math.sqrt(s / f.length) > 3000; // ≈ −21 dBFS
          if (!loud) for (let i = 0; i < f.length; i++) f[i] *= 0.1;
          return loud ? 0.95 : 0.02;
        },
        destroy() { /* rien */ },
      };
    },
  };
  return e;
}

/** Voix de test : 1 s de « phrase » forte, 1 s de silence bruité, 1 s de phrase plus basse. */
function take(): Float32Array {
  const r = rng(3);
  const x = new Float32Array(SR * 3);
  for (let i = 0; i < x.length; i++) x[i] = 0.003 * r();
  const a = sine(SR, 0.3), b = sine(SR, 0.08, 330);
  for (let i = 0; i < SR; i++) { x[i] += a[i]; x[2 * SR + i] += b[i]; }
  return x;
}

describe('lot 1 · nettoyer la voix : réglages et clip', () => {
  it('Léger → Fort : de plus en plus de traitement', () => {
    expect(STRENGTH_ORDER).toEqual(['light', 'medium', 'strong']);
    const [l, m, s] = STRENGTH_ORDER.map(k => STRENGTHS[k]);
    expect(l.mix).toBeLessThan(m.mix + 1e-9);
    expect(l.silenceDb).toBeLessThan(m.silenceDb);
    expect(m.silenceDb).toBeLessThan(s.silenceDb);
    expect(l.level).toBeLessThan(m.level);
    expect(m.level).toBeLessThan(s.level);
    expect(DEFAULT_CLEAN_OPTIONS.strength).toBe('medium');
  });

  it('clips refusés avec ce qu’il faut faire', () => {
    expect(cleanBlock(null)).toMatch(/introuvable/);
    expect(cleanBlock(makeClip({ type: TrackType.MIDI }))).toMatch(/MIDI/);
    expect(cleanBlock(makeClip({ bufferId: 'b', isReversed: true }))).toMatch(/inversé/);
    expect(cleanBlock(makeClip({ bufferId: 'b', duration: 0.2 }))).toMatch(/trop court/);
    expect(cleanBlock(makeClip({ bufferId: 'b' }))).toBeNull();
  });

  it('appliquer = AudioSuite : original gardé, transcription qui suit, retour à l’original exact', () => {
    const clip = makeClip({ id: 'v', name: 'Lead', start: 4, offset: 2, duration: 3, bufferId: 'orig',
      transcript: { version: 1, language: 'fr', model: 'm', words: [{ w: 'Salut', s: 2.5, e: 2.9 }], bufferId: 'orig', at: 1 } });
    const reg = cleanRegion(clip, 10);
    expect(reg).toEqual({ from: 1.5, to: 5.5, lead: 0.5 });
    const after = patchClip(clip, cleanPatch(clip, { newBufferId: 'vc', from: reg.from, options: { strength: 'strong' }, now: 9 }));
    expect(after.bufferId).toBe('vc');
    expect(after.offset).toBeCloseTo(0.5, 9);
    expect(after.name).toBe('Lead (traité : Voix nettoyée (Fort))');
    expect(after.audioSuite?.steps[0]).toEqual({ type: 'AI_VOICE_CLEAN', name: 'Voix nettoyée (Fort)', at: 9 });
    expect(after.audioSuite?.sourceBufferId).toBe('orig');
    expect(after.transcript?.bufferId).toBe('vc');
    const back = patchClip(after, audioSuiteRevertPatch(after, id => id === 'orig')!);
    expect(back.bufferId).toBe('orig'); // le son d'origine, jamais modifié : identique au bit près
    expect(back.offset).toBe(2);
    expect(back.name).toBe('Lead');
    expect(back.audioSuite).toBeUndefined();
    expect(cleanStepName({ strength: 'light' })).toBe('Voix nettoyée (Léger)');
  });

  it('palette : clip sélectionné, sinon celui sous la tête de lecture, sinon le premier ; jamais le MIDI', () => {
    const tracks = [
      { id: 'beat', clips: [{ id: 'm', start: 0, duration: 8, type: TrackType.MIDI, notes: [] as any }] },
      { id: 'lead', clips: [{ id: 'a', start: 0, duration: 4, type: TrackType.AUDIO }, { id: 'b', start: 4, duration: 4, type: TrackType.AUDIO }] },
    ];
    expect(pickCleanTarget(tracks as any, { clipIds: ['b'] })).toEqual({ trackId: 'lead', clipId: 'b' });
    expect(pickCleanTarget(tracks as any, { clipIds: ['m'], trackId: 'lead', playhead: 5 })).toEqual({ trackId: 'lead', clipId: 'b' });
    expect(pickCleanTarget(tracks as any, { clipIds: [], trackId: 'lead', playhead: 20 })).toEqual({ trackId: 'lead', clipId: 'a' });
    expect(pickCleanTarget(tracks as any, { clipIds: [], trackId: 'beat' })).toBeNull();
    expect(pickCleanTarget(tracks as any, { clipIds: [] })).toBeNull();
  });

  it('moteur : DeepFilterNet 3 seulement avec l’appli Windows et le module installé', () => {
    expect(cleanEngineFor({ status: 'idle', voice: false }, null)).toBe('rnnoise');
    expect(cleanEngineFor({ status: 'connected', voice: true }, false)).toBe('rnnoise');
    expect(cleanEngineFor({ status: 'connected', voice: false }, true)).toBe('rnnoise');
    expect(cleanEngineFor({ status: 'connected', voice: true }, true)).toBe('deepfilter');
  });
});

describe('lot 1 · nettoyer la voix : signal', () => {
  it('mélange avant / après', () => {
    const o = [Float32Array.from([1, 1, 1])], w = [Float32Array.from([0, 0, 0])];
    expect(Array.from(blendChannels(o, w, 0)[0])).toEqual([1, 1, 1]);
    expect(Array.from(blendChannels(o, w, 1)[0])).toEqual([0, 0, 0]);
    expect(Array.from(blendChannels(o, w, 0.25)[0])).toEqual([0.75, 0.75, 0.75]);
    expect(blendChannels([new Float32Array(5)], [new Float32Array(3)], 1)[0].length).toBe(5);
  });

  it('silences : 0 dB autour de la voix (attaques et fins gardées), −N dB dans le vide', () => {
    const vad = new Float32Array(100);
    vad.fill(1, 40, 50);
    const g = silenceGainsDb(vad, 20);
    expect(g[45]).toBeCloseTo(0, 5);
    expect(g[38]).toBeGreaterThan(-3);   // 20 ms avant le mot
    expect(g[60]).toBeGreaterThan(-3);   // 100 ms après le mot
    expect(g[5]).toBeCloseTo(-20, 1);
    expect(g[95]).toBeCloseTo(-20, 1);
    expect(Array.from(silenceGainsDb(vad, 0))).toEqual(Array.from(new Float32Array(100)));
    const x = new Float32Array(RNNOISE_FRAME * 3).fill(1);
    const y = applyFrameGains(x, Float32Array.from([-6.0206, -6.0206, -6.0206]), RNNOISE_FRAME);
    expect(y[700]).toBeCloseTo(0.5, 3);
    expect(applyFrameGains(x, new Float32Array(3), RNNOISE_FRAME)[100]).toBe(1);
  });

  it('plancher de bruit lu sur les passages calmes', () => {
    const r = rng(1);
    const x = Float32Array.from({ length: SR }, () => r());
    const k = 0.01 / rms(x);
    for (let i = 0; i < x.length; i++) x[i] *= k; // −40 dBFS efficaces
    expect(noiseFloorDb([x], SR)).toBeGreaterThan(-42);
    expect(noiseFloorDb([x], SR)).toBeLessThan(-39);
    expect(noiseFloorDb([new Float32Array(SR)], SR)).toBe(-120);
  });

  it('niveau : écarts entre phrases réduits, silences jamais remontés seuls, crête ≤ −1 dBFS', () => {
    const x = take();
    const before = db(rms(x, 0, SR)) - db(rms(x, 2 * SR, 3 * SR));
    const { out, gainDb, phraseLufs } = levelVoice([x], SR, 0.7);
    const after = db(rms(out[0], 0, SR)) - db(rms(out[0], 2 * SR, 3 * SR));
    expect(before).toBeGreaterThan(11);
    expect(after).toBeLessThan(before - 4);
    expect(phraseLufs).not.toBeNull();
    expect(gainDb).not.toBeNull();
    let pk = 0; for (const v of out[0]) pk = Math.max(pk, Math.abs(v));
    expect(db(pk)).toBeLessThanOrEqual(-1 + 1e-6);
    // Le bruit du silence suit le gain des phrases voisines, il n'est pas poussé plus fort qu'elles.
    const gSil = db(rms(out[0], 1.4 * SR, 1.6 * SR)) - db(rms(x, 1.4 * SR, 1.6 * SR));
    const gLoud = db(rms(out[0], 0.2 * SR, 0.8 * SR)) - db(rms(x, 0.2 * SR, 0.8 * SR));
    const gSoft = db(rms(out[0], 2.2 * SR, 2.8 * SR)) - db(rms(x, 2.2 * SR, 2.8 * SR));
    expect(gSil).toBeLessThanOrEqual(Math.max(gLoud, gSoft) + 0.5);
    // Silence complet : rien à niveler.
    expect(levelVoice([new Float32Array(SR)], SR, 0.5).gainDb).toBeNull();
  });

  it('chaîne complète (site) : même longueur, mêmes canaux, premier passage réutilisé, 44,1 kHz', () => {
    const eng = fakeEngine();
    const x = take();
    const opts: CleanOptions = { noise: true, reverb: true, level: false, strength: 'medium' };
    const steps: number[] = [];
    const a = cleanVoice({ channels: [x, x.slice()], sampleRate: SR, options: opts }, { engine: eng, onProgress: p => steps.push(p) });
    expect(a.channels.length).toBe(2);
    expect(a.channels[0].length).toBe(x.length);
    expect(a.stats.engine).toBe('rnnoise');
    expect(a.stats.reverb).toBe(false); // pas de réverbe retirée sur le site
    expect(a.stats.noiseReductionDb).toBeLessThan(-15);
    expect(steps[steps.length - 1]).toBe(100);
    expect(steps.every((p, i) => i === 0 || p >= steps[i - 1])).toBe(true);
    expect(eng.created).toBe(2); // un état par canal
    const b = cleanVoice({ channels: [x, x.slice()], sampleRate: SR, options: { ...opts, strength: 'strong' } }, { engine: eng, cache: a.cache });
    expect(eng.created).toBe(2); // RNNoise pas relancé
    expect(b.stats.noiseAfterDb).toBeLessThan(a.stats.noiseAfterDb);
    const light = cleanVoice({ channels: [x], sampleRate: SR, options: { ...opts, strength: 'light' } }, { engine: fakeEngine() });
    expect(light.stats.noiseAfterDb).toBeGreaterThan(a.stats.noiseAfterDb);
    const n44 = Math.round(x.length * 44100 / SR);
    const x44 = sine(n44, 0.2, 220, 44100);
    const c = cleanVoice({ channels: [x44], sampleRate: 44100, options: { ...opts, level: true } }, { engine: fakeEngine() });
    expect(c.sampleRate).toBe(44100);
    expect(c.channels[0].length).toBe(n44);
    expect(c.channels[0].every(Number.isFinite)).toBe(true);
  });

  it('appli Windows : finition sur la voix de DeepFilterNet 3, réverbe annoncée', () => {
    const x = take();
    const wet = x.map(v => v * 0.5);
    const r = cleanVoice({ channels: [x], sampleRate: SR, options: { ...DEFAULT_CLEAN_OPTIONS, level: false, strength: 'light' } },
      { external: { channels: [wet], reverb: true, rt60: 0.62 } });
    expect(r.stats.engine).toBe('deepfilter');
    expect(r.stats.reverb).toBe(true);
    expect(r.stats.rt60).toBe(0.62);
    expect(r.channels[0][1000]).toBeCloseTo(x[1000] * (0.15 + 0.85 * 0.5), 5);
    // Moyen : les silences laissés par DeepFilterNet 3 baissent aussi (probabilité de voix de RNNoise).
    const eng = fakeEngine();
    const m = cleanVoice({ channels: [x], sampleRate: SR, options: { ...DEFAULT_CLEAN_OPTIONS, level: false } },
      { engine: eng, external: { channels: [wet], reverb: false } });
    expect(m.stats.reverb).toBe(false);
    expect(db(rms(m.channels[0], 1.3 * SR, 1.7 * SR)) - db(rms(wet, 1.3 * SR, 1.7 * SR))).toBeLessThan(-8);
    expect(db(rms(m.channels[0], 0.3 * SR, 0.7 * SR)) - db(rms(wet, 0.3 * SR, 0.7 * SR))).toBeGreaterThan(-0.5);
    const again = cleanVoice({ channels: [x], sampleRate: SR, options: { ...DEFAULT_CLEAN_OPTIONS, level: false, strength: 'strong' } },
      { engine: eng, external: { channels: [wet], reverb: false }, cache: m.cache });
    expect(eng.created).toBe(1); // probabilité de voix calculée une fois
    expect(again.stats.noiseAfterDb).toBeLessThan(m.stats.noiseAfterDb);
  });

  it('niveau seul : pas de moteur de bruit ; clip vide refusé', () => {
    const x = take();
    const r = cleanVoice({ channels: [x], sampleRate: SR, options: { noise: false, reverb: false, level: true, strength: 'medium' } });
    expect(r.stats.engine).toBe('none');
    expect(r.stats.levelGainDb).not.toBeNull();
    expect(() => cleanVoice({ channels: [new Float32Array(0)], sampleRate: SR, options: DEFAULT_CLEAN_OPTIONS })).toThrow(/vide/);
    expect(() => cleanVoice({ channels: [x], sampleRate: SR, options: DEFAULT_CLEAN_OPTIONS })).toThrow(/Moteur/);
  });
});

describe('lot 1 · nettoyer la voix : textes', () => {
  it('résumé lisible', () => {
    const st = { engine: 'rnnoise' as const, noiseBeforeDb: -50, noiseAfterDb: -74.3, noiseReductionDb: -24.3, reverb: false, rt60: null, levelGainDb: 3.2, seconds: 1.2, duration: 10 };
    expect(cleanSummary(st, DEFAULT_CLEAN_OPTIONS)).toBe('Bruit de fond −24,3 dB · niveau +3,2 dB');
    expect(cleanSummary({ ...st, engine: 'deepfilter', reverb: true, rt60: 0.6, levelGainDb: -2 }, DEFAULT_CLEAN_OPTIONS)).toBe('Bruit de fond −24,3 dB · réverbe de la pièce retirée · niveau −2 dB');
    expect(cleanSummary({ ...st, noiseReductionDb: 0 }, { ...DEFAULT_CLEAN_OPTIONS, level: false })).toBe('Peu de bruit de fond trouvé');
    expect(cleanSummary({ ...st, noiseReductionDb: -64.1 }, { ...DEFAULT_CLEAN_OPTIONS, level: false })).toBe('Bruit de fond retiré (plus de 40 dB en moins)');
  });

  it('erreurs qui disent quoi faire', () => {
    expect(describeCleanError(new Error('wasm introuvable (404)'))).toMatch(/connexion/);
    expect(describeCleanError(new RangeError('Array buffer allocation failed'))).toMatch(/coupe-le/);
    expect(describeCleanError({ code: 'cancelled', message: 'x' })).toBe('Nettoyage annulé.');
    expect(describeCleanError(new Error('boum'))).toBe('Le nettoyage a échoué : boum');
  });

  it('temps annoncé', () => {
    expect(estimateCleanSeconds(1, 'rnnoise')).toBe(1);
    expect(estimateCleanSeconds(180, 'rnnoise', 48000)).toBeLessThanOrEqual(estimateCleanSeconds(180, 'rnnoise', 44100));
    expect(estimateCleanSeconds(180, 'deepfilter')).toBeGreaterThan(0);
  });
});
