import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_SEC, STORAGE_FULL_BYTES, STORAGE_LOW_BYTES, addOrigin, audioOnsets, captureOffset, coverCrop, defaultPass, filmedSpan, fitClock,
  fmtBytes, frameDurations, frameTimeline, frameTimelines, measureSync, passList, perfToCtx, planExportFrames, segmentAt, storageAdvice,
  performanceProblem, visualEvents, type ClockPair, type TakeSync,
} from '../utils/videoTake';

/** Paires (performance.now ms → horloge de sortie s) d'une carte son qui dérive de `drift` (1.0001 = +0,01 %). */
const pairs = (from: number, to: number, step: number, a: number, drift = 1, noiseMs = 0, seed = 1): ClockPair[] => {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const out: ClockPair[] = [];
  for (let p = from; p <= to; p += step) out.push({ p, c: a + drift * (p / 1000) + (noiseMs ? rnd() * noiseMs / 1000 : 0) });
  return out;
};

const baseSync = (extra: Partial<TakeSync> = {}): TakeSync => ({
  fit: fitClock(pairs(0, 10000, 200, -5)), renderLead: 0.042, outputSide: 0.042, segments: [{ from: 0, t0: 2 }], offsetMs: 0, ...extra,
});

describe('fitClock : horloge du contexte en fonction de performance.now()', () => {
  it('droite exacte, dérive de la carte son mesurée (0,01 % sur 3 min)', () => {
    const f = fitClock(pairs(1000, 181000, 200, 3.25, 1.0001));
    expect(f.b).toBeCloseTo(1.0001, 7);
    expect(perfToCtx(f, 181000)).toBeCloseTo(3.25 + 1.0001 * 181, 6);
    expect(f.residualMs).toBeLessThan(0.01);
  });
  it('paires bruitées (±5 ms) : erreur de la droite < 1 ms partout', () => {
    const f = fitClock(pairs(0, 180000, 200, 1, 1.00005, 10));
    for (const p of [0, 60000, 120000, 180000]) expect(Math.abs(perfToCtx(f, p) - (1 + 1.00005 * p / 1000)) * 1000).toBeLessThan(1);
  });
  it('moins de 3 paires ou moins de 2 s : pente 1, décalage médian', () => {
    expect(fitClock([{ p: 1000, c: 2 }]).b).toBe(1);
    const f = fitClock(pairs(0, 1000, 200, 7));
    expect(f.b).toBe(1);
    expect(perfToCtx(f, 500)).toBeCloseTo(7.5, 9);
    expect(fitClock([]).n).toBe(0);
  });
  it('pente absurde (paires fausses) : repli pente 1', () => {
    expect(fitClock([{ p: 0, c: 0 }, { p: 3000, c: 9 }, { p: 6000, c: 18 }]).b).toBe(1);
  });
});

describe('frameTimeline : instant de capture → temps du morceau', () => {
  it('temps entendu = horloge de sortie − origine (navigateur : renderLead = outputSide)', () => {
    // Sortie : c = p/1000 − 5 ; origine du morceau 2 s ; image capturée à p = 9000 → c = 4 → t = 2.
    expect(frameTimeline(9000, baseSync()).t).toBeCloseTo(2, 9);
  });
  it('décalage de la caméra retiré (image en retard de 40 ms)', () => {
    expect(frameTimeline(9000, baseSync({ offsetMs: 40 })).t).toBeCloseTo(1.96, 9);
  });
  it('pont ASIO : le retard de sortie retiré est celui du pont', () => {
    expect(frameTimeline(9000, baseSync({ outputSide: 0.012 })).t).toBeCloseTo(2.03, 9);
  });
  it('tours de boucle : chaque image dans son tour, au bon endroit de la boucle', () => {
    // Boucle 4 → 8 s : origine 0 puis, au retour (instant 8 du contexte), origine 4.
    let segs = addOrigin([], 0, 0);
    segs = addOrigin(segs, 8, 4);
    segs = addOrigin(segs, 8, 4); // relevé répété : ignoré
    expect(segs).toEqual([{ from: 0, t0: 0 }, { from: 8, t0: 4 }]);
    const s = baseSync({ fit: fitClock(pairs(0, 20000, 200, 0)), segments: segs });
    expect(frameTimeline(7000, s)).toEqual({ t: expect.closeTo(7, 6), pass: 0 });
    expect(frameTimeline(9000, s)).toEqual({ t: expect.closeTo(5, 6), pass: 1 });
    expect(segmentAt(segs, 7.99)).toBe(0);
    expect(segmentAt(segs, 8)).toBe(1);
    const r = frameTimelines([5000, 11000], s);
    expect(r.passes).toEqual([0, 1]);
  });
});

describe('calage image ↔ son : même instant physique, même temps du morceau', () => {
  /**
   * Modèle du moteur (AudioEngine.stopCalibratedRecording) : un son qui arrive au micro à
   * l'instant physique P est écrit à l'image F du contexte, F/sr = rendu(P) + entrée ; la prise
   * est posée à F/sr − origine − (sortie + entrée). La vidéo du même instant doit tomber au même
   * temps du morceau, avec ou sans dérive, avec ou sans pont, quelle que soit la latence.
   */
  const cases = [
    { nom: 'navigateur, casque', sortie: 0.042, entree: 0.01, drift: 1 },
    { nom: 'navigateur, Bluetooth (sortie 180 ms)', sortie: 0.19, entree: 0.02, drift: 1.00002 },
    { nom: 'longue prise, carte qui dérive (+0,01 %)', sortie: 0.03, entree: 0.005, drift: 1.0001 },
  ];
  for (const k of cases) {
    it(k.nom, () => {
      const sr = 48000, origin = 12.5;
      // Horloge de calcul du contexte : rendu(P) = −3 + drift·P ; sortie = rendu − sortie.
      const render = (pMs: number) => -3 + k.drift * pMs / 1000;
      const outPairs: ClockPair[] = [];
      for (let p = 20000; p <= 200000; p += 200) outPairs.push({ p, c: render(p) - k.sortie });
      const sync: TakeSync = { fit: fitClock(outPairs), renderLead: k.sortie, outputSide: k.sortie, segments: [{ from: 0, t0: origin }], offsetMs: 0 };
      for (const P of [25000, 90000, 199000]) {
        const F = Math.round((render(P) + k.entree) * sr);
        const audioT = F / sr - origin - (k.sortie + k.entree);
        const videoT = frameTimeline(P, sync).t;
        expect(Math.abs(videoT - audioT) * 1000).toBeLessThan(0.1);
      }
    });
  }
});

describe('captureOffset : horloge de capture de la caméra → performance.now()', () => {
  it('borne par les lectures (lecture toujours après capture)', () => {
    const OFF = 53159188.0;
    const reads = [0.3, 0.9, 0.2, 2.5].map((lag, i) => ({ tsUs: (OFF + 100 + i * 33.3) * 1000, readMs: 100 + i * 33.3 + lag }));
    expect(captureOffset(reads)!).toBeCloseTo(OFF - 0.2, 6);
  });
  it('paires exactes (requestVideoFrameCallback) : médiane', () => {
    expect(captureOffset([], [{ tsUs: 5_000_000, captureMs: 10 }, { tsUs: 5_033_000, captureMs: 43 }, { tsUs: 5_066_000, captureMs: 80 }])).toBe(4990);
    expect(captureOffset([])).toBeNull();
  });
});

describe('clap / flash : mesure du décalage', () => {
  const sr = 48000;
  const take = (clicks: number[], len = 4) => {
    const x = new Float32Array(len * sr);
    let s = 7;
    for (let i = 0; i < x.length; i++) { s = (s * 16807) % 2147483647; x[i] = (s / 2147483647 - 0.5) * 0.004; }
    for (const c of clicks) { const i0 = Math.round(c * sr); for (let i = 0; i < 400; i++) x[i0 + i] += 0.7 * Math.exp(-i / 80) * (i % 2 ? 1 : -1); }
    return x;
  };
  it('attaques retrouvées à 0,1 ms près, sans fausse attaque dans le bruit', () => {
    const at = [0.5, 1.5, 2.5];
    const o = audioOnsets(take(at), sr);
    expect(o.length).toBe(3);
    o.forEach((t, i) => expect(Math.abs(t - at[i]) * 1000).toBeLessThan(0.1));
    expect(audioOnsets(new Float32Array(sr), sr)).toEqual([]);
  });
  it('flash : saut de luminosité ; clap : pic de mouvement', () => {
    const frames = Array.from({ length: 90 }, (_, k) => ({ t: k / 30, luma: k === 30 || k === 60 ? 230 : 40, motion: 2 }));
    expect(visualEvents(frames).map(e => [Math.round(e.t * 30), e.kind])).toEqual([[30, 'flash'], [60, 'flash']]);
    const claps = Array.from({ length: 90 }, (_, k) => ({ t: k / 30, luma: 80, motion: k === 20 ? 40 : k === 19 || k === 21 ? 15 : 2 }));
    expect(visualEvents(claps)).toEqual([{ t: 20 / 30, kind: 'mouvement' }]);
    expect(visualEvents(Array.from({ length: 30 }, (_, k) => ({ t: k / 30, luma: 50, motion: 2 })))).toEqual([]);
  });
  it('décalage médian : image 40 ms en retard, une paire aberrante ignorée par la médiane', () => {
    const audio = [1, 2, 3];
    const video = [{ t: 1.04, kind: 'flash' as const }, { t: 2.04, kind: 'flash' as const }, { t: 3.2, kind: 'flash' as const }];
    const m = measureSync(audio, video)!;
    expect(m.offsetMs).toBeCloseTo(40, 6);
    expect(m.pairs).toBe(3);
    expect(m.kind).toBe('flash');
    expect(measureSync([1], [{ t: 2, kind: 'flash' }])).toBeNull();
  });
});

describe('planExportFrames : images de l\'export à leur instant exact', () => {
  // 30 i/s avec du jitter, images clés toutes les 60.
  const times = Array.from({ length: 300 }, (_, i) => 10 + i / 30 + ((i * 7) % 5) * 0.001);
  const keys = [0, 60, 120, 180, 240];
  it('image tenue à t = 0, instants exacts, strictement croissants, décodage depuis l\'image clé', () => {
    const { frames, decodeFrom, decodeTo } = planExportFrames(times, keys, { start: 13.01, duration: 2 });
    expect(frames[0].t).toBe(0);
    expect(times[frames[0].src]).toBeLessThanOrEqual(13.01);
    expect(times[frames[0].src + 1]).toBeGreaterThan(13.01);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].t).toBeGreaterThan(frames[i - 1].t);
      expect(frames[i].t).toBeCloseTo(times[frames[i].src] - 13.01, 12);
    }
    expect(decodeFrom).toBe(60);
    expect(decodeTo).toBe(frames[frames.length - 1].src);
    expect(frameDurations(frames, 2).reduce((a, b) => a + b, 0)).toBeCloseTo(2, 9);
  });
  it('avant la 1re image filmée : noir jusqu\'à la 1re image', () => {
    const { frames } = planExportFrames(times, keys, { start: 8, duration: 3 });
    expect(frames[0]).toEqual({ src: -1, t: 0 });
    expect(frames[1].src).toBe(0);
    expect(frames[1].t).toBeCloseTo(2, 9);
  });
  it('tour de boucle choisi : seules ses images', () => {
    const t2 = [4.0, 5.0, 6.0, 4.1, 5.1, 6.1];
    const passes = [0, 0, 0, 1, 1, 1];
    const { frames } = planExportFrames(t2, [0, 3], { start: 4, duration: 3 }, { passes, pass: 1 });
    expect(frames.map(f => f.src)).toEqual([-1, 3, 4, 5]);
    expect(passList(passes)).toEqual([{ pass: 0, frames: 3 }, { pass: 1, frames: 3 }]);
    expect(defaultPass([0, 0, 0, 1, 1, 1, 2])).toBe(1);
    expect(filmedSpan(t2, passes, 1)).toEqual({ start: 4.1, end: 6.1 });
  });
});

describe('cadrage et stockage', () => {
  it('recadrage au centre : 16:9 → 9:16 et l\'inverse', () => {
    expect(coverCrop(1280, 720, 720, 1280)).toEqual({ sx: (1280 - 405) / 2, sy: 0, sw: 405, sh: 720 });
    const r = coverCrop(720, 1280, 1280, 720);
    expect(r.sw).toBe(720);
    expect(r.sh).toBeCloseTo(405, 9);
  });
  it('place : pleine, basse, ok, inconnue ; minutes de vidéo', () => {
    expect(storageAdvice(null).level).toBe('unknown');
    expect(storageAdvice({ usage: 0, quota: STORAGE_FULL_BYTES - 1 }).level).toBe('full');
    expect(storageAdvice({ usage: 0, quota: STORAGE_LOW_BYTES - 1 }).level).toBe('low');
    const ok = storageAdvice({ usage: 1e9, quota: 11e9 });
    expect(ok.level).toBe('ok');
    expect(ok.minutes).toBe(Math.floor(10e9 / BYTES_PER_SEC / 60));
    expect(Math.round(BYTES_PER_SEC * 60 / 1e6)).toBe(19);
    expect(fmtBytes(2.5 * 1024 ** 3)).toBe('2,5 Go');
    expect(fmtBytes(30 * 1024 ** 2)).toBe('30 Mo');
  });
});

describe('performanceProblem : mêmes règles que le clip et l\'export', () => {
  const voice = [{ start: 2, duration: 20 }];
  it('droits complets : toute la prise, même longue', () => {
    expect(performanceProblem({ start: 0, duration: 180 }, { full: true, needsVoice: false }, voice)).toBeNull();
  });
  it('sans licence : 30 s au plus, sur la voix ; une prise courte (4 s) reste exportable', () => {
    const lim = { full: false, needsVoice: true };
    expect(performanceProblem({ start: 2, duration: 31 }, lim, voice)).toMatch(/30 s au plus/);
    expect(performanceProblem({ start: 2, duration: 4 }, lim, voice)).toBeNull();
    expect(performanceProblem({ start: 25, duration: 10 }, lim, voice)).toMatch(/ta voix/);
    expect(performanceProblem({ start: 2, duration: 0.5 }, lim, voice)).toMatch(/1 s au moins/);
  });
});
