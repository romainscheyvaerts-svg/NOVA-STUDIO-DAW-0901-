import { describe, expect, it } from 'vitest';
import { makeDrumMachine, DrumMachine, setBars } from '../utils/drumKits';
import {
  addPattern, drumRhythmSig, drumSongClips, ensurePatterns, rowLength, rowStepAt, rowStepsPerBar, selectPattern,
  setRowLength, setRowRate, setStepParam, whereAt,
} from '../utils/drumPatterns';
import { removePad } from '../utils/drumSamples';
import {
  DEFAULT_SAMPLER, normalizeSampler, noteName, pickZone, playbackRateFor, rootFromFrequency, sampleZones, SamplerZone, velocityGain,
} from '../utils/melodicSampler';
import { detectRoot } from '../utils/samplerRoot';
import { trimSilence } from '../utils/micSample';
import { applyKit, kitFromDrumMachine, kitFromFile, kitSignature, kitToFile, parseKit } from '../utils/userKits';
import { contentBufferIds, contentOf } from '../services/Collab';
import { chopPoints } from '../components/ChopClipDialog';
import { pointsToSlices } from '../utils/chop';
import { Track, TrackType } from '../types';

const BPM = 120; // pas 1/16 = 0,125 s ; mesure = 2 s

const withKick = (steps: number[]): DrumMachine => {
  const dm = makeDrumMachine('empty');
  return { ...dm, rows: dm.rows.map(r => (r.id === 'kick' ? { ...r, steps } : r)) };
};

describe('R18 · pas : vélocité, pan, hauteur (Graph Editor)', () => {
  it('chaque pas garde sa vélocité, son pan et sa hauteur dans les notes jouées', () => {
    let dm = withKick([127, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    dm = setStepParam(dm, 0, 0, 'pan', -0.5);
    dm = setStepParam(dm, 0, 4, 'pitch', 7);
    dm = setStepParam(dm, 0, 4, 'vel', 32);
    const notes = drumSongClips(dm, BPM, 2, 'x')[0].notes!;
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ start: 0, velocity: 1, pan: -0.5 });
    expect(notes[0].tune).toBeUndefined();
    expect(notes[1].start).toBeCloseTo(0.5, 9);
    expect(notes[1].velocity).toBeCloseTo(32 / 127, 6);
    expect(notes[1]).toMatchObject({ tune: 7 });
    expect(notes[1].pan).toBeUndefined();
  });

  it('un pas éteint n’a pas de vélocité ; pan et hauteur sont bornés', () => {
    const dm = withKick(new Array(16).fill(0));
    expect(setStepParam(dm, 0, 3, 'vel', 90)).toBe(dm);
    expect(setStepParam(dm, 0, 3, 'pan', 5).rows[0].stepPan![3]).toBe(1);
    expect(setStepParam(dm, 0, 3, 'pitch', -40).rows[0].stepPitch![3]).toBe(-12);
  });

  it('pan et hauteur suivent les motifs (A / B) et la suppression d’un pad', () => {
    let dm = ensurePatterns(setStepParam(withKick([100, ...new Array(15).fill(0)]), 0, 0, 'pitch', 5));
    const a = dm.activePattern!;
    dm = addPattern(dm);
    expect(dm.rows[0].stepPitch).toBeUndefined();
    dm = selectPattern(dm, a);
    expect(dm.rows[0].stepPitch![0]).toBe(5);
    const removed = removePad(dm, 0);
    expect(removed.patterns!.every(p => !p.pitch || !('kick' in p.pitch))).toBe(true);
  });

  it('l’empreinte du rythme change avec le pan ou la hauteur (clip régénéré)', () => {
    const dm = withKick([100, ...new Array(15).fill(0)]);
    expect(drumRhythmSig(setStepParam(dm, 0, 0, 'pan', 0.4))).not.toBe(drumRhythmSig(dm));
  });

  it('un projet d’avant R18 donne exactement les mêmes notes (rien d’ajouté)', () => {
    const dm = makeDrumMachine('trap');
    const notes = drumSongClips(dm, BPM, 4, 'x')[0].notes!;
    expect(notes.every(n => n.pan === undefined && n.tune === undefined)).toBe(true);
    expect(ensurePatterns(dm).patterns![0].pan).toBeUndefined();
  });
});

describe('R18 · résolution, longueur et swing par rangée', () => {
  it('1/32 : 32 pas par mesure, recalés depuis la grille 1/16', () => {
    let dm = withKick([100, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    dm = setRowRate(dm, 0, '32');
    expect(rowStepsPerBar(dm.rows[0])).toBe(32);
    expect(dm.rows[0].steps).toHaveLength(32);
    expect(dm.rows[0].steps[0]).toBe(100);
    expect(dm.rows[0].steps[8]).toBe(100);
    dm.rows[0].steps[1] = 90; // triple-croche juste après
    const t = drumSongClips(dm, BPM, 2, 'x')[0].notes!.map(n => +n.start.toFixed(6));
    expect(t).toEqual([0, 0.0625, 0.5]);
  });

  it('triolets de doubles (1/16 T) : 24 pas par mesure, sans swing', () => {
    let dm = { ...withKick(new Array(16).fill(0)), swing: 0.5 };
    dm = setRowRate(dm, 0, '16t');
    dm.rows[0].steps = dm.rows[0].steps.map((_, i) => (i < 3 ? 100 : 0));
    const t = drumSongClips(dm, BPM, 2, 'x')[0].notes!.map(n => n.start);
    expect(t[0]).toBeCloseTo(0, 9);
    expect(t[1]).toBeCloseTo(2 / 24, 9);
    expect(t[2]).toBeCloseTo(4 / 24, 9);
  });

  it('longueur propre : une rangée de 3 pas boucle toute seule sur la mesure (polymétrie)', () => {
    let dm = withKick([100, ...new Array(15).fill(0)]);
    dm = setRowLength(dm, 0, 3);
    expect(dm.rows[0].steps).toHaveLength(3);
    expect(rowLength(dm.rows[0], 1)).toBe(3);
    const t = drumSongClips(dm, BPM, 4, 'x')[0].notes!.filter(n => n.pitch === 60).map(n => +(n.start / 0.125).toFixed(6));
    // pas 0, 3, 6, 9, 12, 15, puis la mesure suivante continue le cycle (18 → 2 dans la mesure 2)
    expect(t.slice(0, 8)).toEqual([0, 3, 6, 9, 12, 15, 18, 21]);
    // la longueur ne change pas avec le nombre de mesures du motif
    expect(setBars(dm, 2).rows[0].steps).toHaveLength(3);
  });

  it('tête de lecture d’une rangée à longueur propre', () => {
    const dm = setRowLength(withKick([100, ...new Array(15).fill(0)]), 0, 3);
    const w = whereAt(dm, BPM, 0.125 * 7 + 0.01)!;
    expect(rowStepAt(dm.rows[0], w, 1)).toBe(1);
  });

  it('swing par rangée : seule la rangée réglée balance', () => {
    let dm = makeDrumMachine('empty');
    dm = { ...dm, swing: 0, rows: dm.rows.map(r => (r.id === 'kick' || r.id === 'hatc' ? { ...r, steps: r.steps.map((_, i) => (i === 1 ? 100 : 0)) } : r)) };
    dm = { ...dm, rows: dm.rows.map(r => (r.id === 'hatc' ? { ...r, swing: 0.4 } : r)) };
    const notes = drumSongClips(dm, BPM, 2, 'x')[0].notes!;
    const kick = notes.find(n => n.pitch === 60)!;
    const hat = notes.find(n => n.pitch === 63)!;
    expect(kick.start).toBeCloseTo(0.125, 9);
    expect(hat.start).toBeCloseTo(0.125 + 0.4 * 0.125 * 0.5, 9);
  });
});

describe('R18 · sampler mélodique : zones, hauteur, réglages', () => {
  const zones: SamplerZone[] = [
    { file: 'C4p', root: 60, lo: 58, hi: 62, velLo: 1, velHi: 63 },
    { file: 'C4f', root: 60, lo: 58, hi: 62, velLo: 64, velHi: 127 },
    { file: 'E4a', root: 64, lo: 63, hi: 66, velLo: 1, velHi: 127, rr: 0 },
    { file: 'E4b', root: 64, lo: 63, hi: 66, velLo: 1, velHi: 127, rr: 1 },
  ];
  it('choisit la zone par note et par vélocité', () => {
    expect(pickZone(zones, 60, 30)!.file).toBe('C4p');
    expect(pickZone(zones, 61, 100)!.file).toBe('C4f');
  });
  it('round-robin : les prises alternent', () => {
    expect([0, 1, 2].map(k => pickZone(zones, 64, 80, k)!.file)).toEqual(['E4a', 'E4b', 'E4a']);
  });
  it('hors tessiture : la zone la plus proche', () => {
    expect(pickZone(zones, 80, 80)!.root).toBe(64);
    expect(pickZone(zones, 20, 20)!.file).toBe('C4p');
  });
  it('vitesse de lecture : racine, accord fin', () => {
    expect(playbackRateFor(72, 60)).toBeCloseTo(2, 12);
    expect(playbackRateFor(60, 60, 100)).toBeCloseTo(Math.pow(2, 1 / 12), 12);
  });
  it('tranches : une zone exacte par note, silence ailleurs', () => {
    const s = normalizeSampler({ ...DEFAULT_SAMPLER, sampleId: 'm1', slices: [{ start: 0, end: 0.5 }, { start: 0.5, end: 1 }], sliceBase: 48 });
    const z = sampleZones(s, 2);
    expect(z).toHaveLength(2);
    expect(z[1]).toMatchObject({ root: 49, offset: 1, end: 2, exact: true });
    expect(pickZone(z, 50, 100)).toBeNull();
    expect(pickZone(z, 48, 100)!.offset).toBe(0);
  });
  it('réglages lus d’un collaborateur : bornés', () => {
    const s = normalizeSampler({ rootKey: 300, attack: -1, glide: 99, sampleId: '../x', instrument: 'piano' } as never);
    expect(s.rootKey).toBe(127);
    expect(s.attack).toBe(0);
    expect(s.glide).toBe(2);
    expect(s.sampleId).toBeUndefined();
    expect(s.instrument).toBe('piano');
  });
  it('vélocité : sensibilité 0 = niveau fixe', () => {
    expect(velocityGain(0.2, 0)).toBe(1);
    expect(velocityGain(1, 1)).toBe(1);
    expect(velocityGain(0.5, 1)).toBeCloseTo(0.25, 9);
  });
  it('noms de notes et fréquence → racine', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(69)).toBe('A4');
    expect(rootFromFrequency(440)).toEqual({ midi: 69, cents: 0 });
  });
});

describe('R18 · note racine trouvée toute seule', () => {
  const tone = (hz: number, sr = 48000, sec = 1.5) => {
    const x = new Float32Array(Math.round(sr * sec));
    for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = 0.5 * Math.exp(-t * 1.2) * (Math.sin(2 * Math.PI * hz * t) + 0.4 * Math.sin(4 * Math.PI * hz * t) + 0.2 * Math.sin(6 * Math.PI * hz * t)); }
    return x;
  };
  it('A3 juste : racine 57, accord fin ~0', () => {
    const r = detectRoot([tone(220)], 48000)!;
    expect(r.midi).toBe(57);
    expect(Math.abs(r.fineTune)).toBeLessThan(3);
  });
  it('C4 trop haut de 20 cents : racine 60, accord fin -20', () => {
    const r = detectRoot([tone(261.6256 * Math.pow(2, 20 / 1200))], 48000)!;
    expect(r.midi).toBe(60);
    expect(r.fineTune).toBeGreaterThan(-24);
    expect(r.fineTune).toBeLessThan(-16);
  });
  it('bruit : pas de racine sûre', () => {
    let s = 1;
    const n = new Float32Array(48000).map(() => { s = (s * 16807) % 2147483647; return (s / 2147483647 - 0.5) * 0.5; });
    const r = detectRoot([n], 48000);
    expect(!r || r.voiced < 0.35).toBe(true);
  });
});

describe('R18 · micro : silence retiré', () => {
  it('coupe le silence du début, garde 5 ms', () => {
    const x = new Float32Array(48000);
    for (let i = 24000; i < 36000; i++) x[i] = Math.sin(i / 10) * 0.5;
    const y = trimSilence(x, 48000);
    expect(y.length).toBeLessThan(20000);
    expect(y.length).toBeGreaterThan(12000);
  });
  it('rien d’audible : vide', () => { expect(trimSilence(new Float32Array(1000), 48000).length).toBe(0); });
});

describe('R18 · kits perso', () => {
  const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3]).buffer;
  const source = (): DrumMachine => {
    const dm = makeDrumMachine('trap');
    return {
      ...dm,
      samples: { s1: { name: 'Mon kick', duration: 0.4 } },
      rows: dm.rows.map(r => (r.id === 'kick' ? { ...r, sound: 'user:s1', name: 'Mon kick', tune: -3, decay: 0.6, mix: { comp: 0.4 }, rate: '32' as const, steps: new Array(32).fill(0) } : r)),
    };
  };
  it('enregistré dans un projet, chargé dans un autre : sons et réglages identiques, pas du projet gardés', () => {
    const kit = kitFromDrumMachine(source(), 'Mon kit trap', id => (id === 's1' ? wav : undefined));
    expect(kit.samples.s1.wav).toBe(wav);
    expect(kit.pads.every(p => !('steps' in p))).toBe(true);
    const other = makeDrumMachine('boombap');
    const loaded = applyKit(other, kit);
    expect(kitSignature(loaded)).toBe(kitSignature(source()));
    expect(loaded.samples).toEqual({ s1: { name: 'Mon kick', duration: 0.4 } });
    // le motif boom bap reste sur les pads de même id (snare)
    expect(loaded.rows.find(r => r.id === 'snare')!.steps).toEqual(other.rows.find(r => r.id === 'snare')!.steps);
  });
  it('sans batterie : batterie vide avec les pads du kit', () => {
    const kit = kitFromDrumMachine(source(), 'K', () => undefined);
    const dm = applyKit(null, kit);
    expect(dm.rows).toHaveLength(source().rows.length);
    expect(dm.rows.every(r => r.steps.every(v => v === 0))).toBe(true);
  });
  it('fichier .novakit : aller-retour avec le son', async () => {
    const kit = kitFromDrumMachine(source(), 'Échange', id => (id === 's1' ? wav : undefined));
    const blob = await kitToFile(kit);
    const back = await kitFromFile(await blob.arrayBuffer());
    expect(back.name).toBe('Échange');
    expect(back.pads).toEqual(kit.pads);
    expect(new Uint8Array(back.samples.s1.wav!)).toEqual(new Uint8Array(wav));
    expect(back.id).not.toBe(kit.id);
  });
  it('kit abîmé refusé', () => {
    expect(parseKit({ pads: [] })).toBeNull();
    expect(parseKit(null)).toBeNull();
    expect(parseKit({ name: 'x', pads: [{ id: 'a', sound: 'synth:kick', name: 'K', volume: 'x' }] })!.pads[0].volume).toBe(0.85);
  });
});

describe('R18 · collaboration : le sampler voyage avec la piste', () => {
  const t: Track = {
    id: 't1', name: 'SAMPLER', type: TrackType.MIDI, color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
    volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0,
    melodicSampler: normalizeSampler({ ...DEFAULT_SAMPLER, sampleId: 'mabc', sampleName: 'Voix', rootKey: 57 }),
  };
  it('réglages dans le contenu, son dans les buffers envoyés', () => {
    expect((contentOf(t) as { melodicSampler?: unknown }).melodicSampler).toMatchObject({ sampleId: 'mabc', rootKey: 57 });
    expect(contentBufferIds(t)).toContain('msample-mabc');
  });
  it('instrument NOVA : rien à envoyer (fichiers du site)', () => {
    const inst = { ...t, melodicSampler: normalizeSampler({ instrument: 'piano' }) };
    expect(contentBufferIds(inst)).toEqual([]);
  });
  it('piste synthé : null (retour au synthé propagé)', () => {
    const { melodicSampler: _m, ...synth } = t;
    expect((contentOf(synth as Track) as { melodicSampler?: unknown }).melodicSampler).toBeNull();
  });
});

describe('R18 · découpe d’un clip', () => {
  it('8 coups réguliers → 8 tranches sur les attaques, bout à bout', () => {
    const sr = 48000, n = sr * 2;
    const x = new Float32Array(n);
    for (let k = 0; k < 8; k++) for (let i = 0; i < 4000; i++) x[k * 12000 + i + 200] = Math.sin(i / 3) * Math.exp(-i / 800);
    const pts = chopPoints([x], sr, 'transients', { sensitivity: 0.5, bpm: 120, perBar: 8, count: 8 });
    const sl = pointsToSlices(pts, n);
    expect(sl).toHaveLength(8);
    sl.forEach((s, i) => { if (i) expect(s.start).toBe(sl[i - 1].end); });
    expect(sl[sl.length - 1].end).toBe(1);
  });
  it('à la grille : croches au tempo', () => {
    const sr = 48000;
    const pts = chopPoints([new Float32Array(sr * 2)], sr, 'grid', { sensitivity: 0.5, bpm: 120, perBar: 8, count: 8 });
    expect(pts).toHaveLength(8);
  });
});
