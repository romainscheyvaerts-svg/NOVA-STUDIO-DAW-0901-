import { describe, expect, it } from 'vitest';
import { makeDrumMachine } from '../utils/drumKits';
import { drumSongClips, selectPattern } from '../utils/drumPatterns';
import {
  chopIntoPads, detectTransients, equalPoints, estimateLoopBpm, gridPoints, normalizePoints, pointsToSlices,
  reorderSlices, shuffledOrder, snapToZero, stepOfSlice, toggleMarker,
} from '../utils/chop';
import {
  assignSample, clipRegionChannels, hasRegion, padLoadKey, padSampleFiles, pruneSamples, regionOf, removePad, renderRegion,
  restorePadSamples, userRef,
} from '../utils/drumSamples';

const SR = 44100;

/** Boucle de test : coups (bruit décroissant) aux instants donnés (s). */
function hits(times: number[], dur: number, amp = 0.8): Float32Array {
  const x = new Float32Array(Math.round(dur * SR));
  let seed = 7;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed / 2 ** 32) * 2 - 1; };
  times.forEach(t => {
    const s = Math.round(t * SR);
    for (let i = 0; i < SR * 0.12 && s + i < x.length; i++) x[s + i] += amp * rnd() * Math.exp(-i / (SR * 0.025));
  });
  return x;
}

describe('découpe : transitoires, grille, à la main', () => {
  it('trouve les 8 coups d\'une boucle (à 10 ms près)', () => {
    const times = [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75];
    const x = hits(times, 2);
    const pts = detectTransients([x], SR, { sensitivity: 0.5 });
    expect(pts).toHaveLength(8);
    pts.forEach((p, i) => expect(Math.abs(p / SR - times[i])).toBeLessThan(0.01));
  });

  it('coups faibles : trouvés avec une sensibilité haute, ignorés avec une basse', () => {
    const x = hits([0, 0.5, 1.0, 1.5], 2);
    const soft = hits([0.25, 0.75], 2, 0.02);
    for (let i = 0; i < x.length; i++) x[i] += soft[i];
    expect(detectTransients([x], SR, { sensitivity: 0.95 }).length).toBeGreaterThan(detectTransients([x], SR, { sensitivity: 0 }).length);
  });

  it('respecte le nombre maximal de tranches et le silence', () => {
    const x = hits(Array.from({ length: 30 }, (_, i) => i * 0.1), 3);
    expect(detectTransients([x], SR, { maxSlices: 8 }).length).toBeLessThanOrEqual(8);
    expect(detectTransients([new Float32Array(SR)], SR)).toEqual([0]);
  });

  it('grille : 8 tranches par mesure à 120 BPM = une toutes les 0,25 s', () => {
    expect(gridPoints(2 * SR, SR, 120, 8)).toEqual(Array.from({ length: 8 }, (_, k) => Math.round(k * 0.25 * SR)));
    expect(equalPoints(800, 4)).toEqual([0, 200, 400, 600]);
  });

  it('repères à la main : ajout, retrait près du doigt, 0 toujours gardé', () => {
    let p = [0];
    p = toggleMarker(p, 400, 1000, 20);
    p = toggleMarker(p, 700, 1000, 20);
    expect(p).toEqual([0, 400, 700]);
    p = toggleMarker(p, 410, 1000, 20);
    expect(p).toEqual([0, 700]);
    expect(toggleMarker(p, 5, 1000, 20)).toEqual([0, 5, 700]);
    expect(normalizePoints([300, 300, 100], 1000)).toEqual([0, 100, 300]);
    expect(pointsToSlices([0, 250, 500], 1000)).toEqual([{ start: 0, end: 0.25 }, { start: 0.25, end: 0.5 }, { start: 0.5, end: 1 }]);
  });

  it('passage par zéro', () => {
    const x = new Float32Array([0.5, 0.4, 0.2, -0.1, -0.3]);
    expect(snapToZero(x, 1, 4)).toBe(3);
  });

  it('tempo d\'une boucle d\'après sa durée', () => {
    expect(estimateLoopBpm(2, 120)).toEqual({ bpm: 120, bars: 1 });
    expect(estimateLoopBpm(8, 140)).toEqual({ bpm: 120, bars: 4 });
    expect(estimateLoopBpm(3.2, 150).bars).toBe(2);
  });
});

describe('tranches sur les pads', () => {
  const slices = pointsToSlices(gridPoints(2 * SR, SR, 120, 8), 2 * SR);

  it('8 tranches → 8 pads (même sample, zones différentes) + motif « Découpe » à leur place', () => {
    const { dm, padIndexes } = chopIntoPads(makeDrumMachine('empty'), 'abc', { name: 'Boucle', duration: 2, bpm: 120 }, slices, { bufferBpm: 120, duration: 2 });
    expect(padIndexes).toHaveLength(8);
    const pads = padIndexes.map(i => dm.rows[i]);
    expect(pads.every(r => r.sound === userRef('abc') && r.choke === 9)).toBe(true);
    expect(pads[2]).toMatchObject({ name: 'Tranche 3', start: 0.25, end: 0.375, slice: 3 });
    expect(dm.patterns!.find(p => p.id === dm.activePattern)!.name).toBe('Découpe');
    // la tranche k joue au pas 2k (une croche à 120 BPM)
    pads.forEach((r, k) => expect(r.steps.findIndex(v => v > 0)).toBe(2 * k));
    const notes = drumSongClips(dm, 120, 2, 'c')[0].notes!;
    expect(notes.map(n => n.pitch)).toEqual(padIndexes.map(i => 60 + i));
    expect(dm.samples!.abc).toMatchObject({ name: 'Boucle', duration: 2 });
  });

  it('rejouées dans un autre ordre (« Remixer »), sans perdre de coup', () => {
    const { dm, padIndexes } = chopIntoPads(makeDrumMachine('empty'), 'abc', { name: 'Boucle', duration: 2 }, slices, { bufferBpm: 120, duration: 2 });
    const order = [7, 6, 5, 4, 3, 2, 1, 0];
    const re = reorderSlices(dm, order);
    padIndexes.forEach((ri, k) => expect(re.rows[ri].steps.findIndex(v => v > 0)).toBe(2 * (7 - k)));
    const notes = drumSongClips(re, 120, 2, 'c')[0].notes!;
    expect(notes.map(n => n.pitch)).toEqual([...padIndexes].reverse().map(i => 60 + i));
    const sh = shuffledOrder(8, 42);
    expect([...sh].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(sh).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(shuffledOrder(8, 42)).toEqual(sh);
  });

  it('remplacer une découpe : les anciennes tranches et leur sample disparaissent ; les motifs restent', () => {
    const a = chopIntoPads(makeDrumMachine('empty'), 'one', { name: 'A', duration: 2 }, slices, { bufferBpm: 120, duration: 2 }).dm;
    const back = selectPattern(a, a.patterns![0].id);
    const b = chopIntoPads(back, 'two', { name: 'B', duration: 2 }, slices.slice(0, 4), { bufferBpm: 120, duration: 2, replace: true }).dm;
    expect(b.rows.filter(r => r.slice)).toHaveLength(4);
    expect(Object.keys(b.samples!)).toEqual(['two']);
    expect(b.rows.length).toBe(7 + 4);
  });

  it('jamais plus de 30 pads', () => {
    const many = pointsToSlices(equalPoints(16000, 16), 16000);
    let dm = makeDrumMachine('empty');
    dm = chopIntoPads(dm, 'a', { name: 'a', duration: 1 }, many, { bufferBpm: 120, duration: 1, makePattern: false }).dm;
    dm = chopIntoPads(dm, 'b', { name: 'b', duration: 1 }, many, { bufferBpm: 120, duration: 1, makePattern: false }).dm;
    expect(dm.rows.length).toBe(30);
  });

  it('pas d\'une tranche selon le tempo du son', () => {
    expect(stepOfSlice(0.5, { bufferBpm: 120, duration: 2 })).toBe(8);
    expect(stepOfSlice(0.5, { bufferBpm: 90, duration: 2 })).toBe(6);
  });
});

describe('samples perso des pads', () => {
  it('poser un sample sur un pad existant garde ses pas ; sur un nouveau pad, l\'ajoute', () => {
    const dm = makeDrumMachine('trap');
    const kickSteps = dm.rows[0].steps;
    const a = assignSample({ ...dm, rows: dm.rows.map((r, i) => (i === 0 ? { ...r, start: 0.3, reverse: true } : r)) }, 'k1', { name: 'Mon kick.wav', duration: 0.4 }, { rowIndex: 0 })!;
    expect(a.dm.rows[0]).toMatchObject({ sound: 'user:k1', name: 'Mon kick', steps: kickSteps });
    expect(hasRegion(a.dm.rows[0])).toBe(false);
    const b = assignSample(a.dm, 'v1', { name: 'Vox chop.mp3', duration: 1 }, {})!;
    expect(b.rowIndex).toBe(7);
    expect(b.dm.rows[7]).toMatchObject({ name: 'Vox chop', sound: 'user:v1' });
    expect(Object.keys(b.dm.samples!).sort()).toEqual(['k1', 'v1']);
    const c = removePad(b.dm, 7);
    expect(c.rows).toHaveLength(7);
    expect(Object.keys(c.samples!)).toEqual(['k1']);
    expect(pruneSamples({ ...c, rows: c.rows.map(r => ({ ...r, sound: 'synth:kick-punch' })) }).samples).toEqual({});
  });

  it('zone jouée : début / fin, reverse, fondus, micro-fondu anti-clic', () => {
    const src = new Float32Array(1000).map((_, i) => i / 1000 + 0.001);
    const [cut] = renderRegion([src], 1000, regionOf({ start: 0.2, end: 0.6 }));
    expect(cut.length).toBe(400);
    expect(cut[0]).toBe(0); // micro-fondu d'entrée (coupe au milieu)
    expect(cut[200]).toBeCloseTo(0.401, 3);
    const [rev] = renderRegion([src], 1000, regionOf({ reverse: true }));
    expect(rev[0]).toBeCloseTo(1.0, 3);
    expect(rev[999]).toBeCloseTo(0, 6); // fin coupée → micro-fondu de sortie
    const [faded] = renderRegion([new Float32Array(1000).fill(1)], 1000, regionOf({ fadeIn: 0.1, fadeOut: 0.2 }));
    expect(faded[50]).toBeCloseTo(0.5, 2);
    expect(faded[899]).toBeCloseTo(0.5, 2);
    expect(faded[500]).toBe(1);
    expect(regionOf({ start: 0.8, end: 0.2 })).toMatchObject({ start: 0.8, end: 0.8 });
    expect(padLoadKey({ sound: 'x' }, 0)).not.toBe(padLoadKey({ sound: 'x', end: 0.5 }, 0));
  });

  it('clip de la session → sample (offset, durée, gain, reverse)', () => {
    const src = new Float32Array(100).map((_, i) => i);
    const [o] = clipRegionChannels([src], 10, { offset: 2, duration: 3, gain: 2, isReversed: true });
    expect(Array.from(o.slice(0, 3))).toEqual([98, 96, 94]);
    expect(o.length).toBe(30);
  });

  it('sauvegarde et ouverture du projet : un fichier par sample, relu à l\'ouverture', async () => {
    const buf = { tag: 'wav' };
    const track = { drumMachine: { ...makeDrumMachine('empty'), samples: { k1: { name: 'Kick', duration: 0.3 }, gone: { name: 'x', duration: 1 } } } };
    const files = padSampleFiles(track, key => (key === 'padsample-k1' ? buf : undefined));
    expect(files).toEqual([{ id: 'k1', filename: 'pad-k1.wav', buffer: buf }]);
    const saved = JSON.parse(JSON.stringify(track));
    saved.drumMachine.samples.k1.audioRef = 'audio/pad-k1.wav';
    const reg = new Map<string, unknown>();
    const n = await restorePadSamples(saved, async ref => (ref === 'audio/pad-k1.wav' ? buf : null), (b, k) => reg.set(k, b));
    expect(n).toBe(1);
    expect(reg.get('padsample-k1')).toBe(buf);
    expect(saved.drumMachine.samples.k1.audioRef).toBeUndefined();
  });
});
