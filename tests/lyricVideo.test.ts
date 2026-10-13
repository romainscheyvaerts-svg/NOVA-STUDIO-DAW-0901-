import { describe, expect, it } from 'vitest';
import {
  ClipSpectrum, LIMITED_MAX, clampRange, clipFileName, clipLyricLines, clipRights, energyEnvelope, fft, lineRawWords, linesInRange,
  loudestWindow, lyricsAt, nearestVoiceRange, rangeProblem, songEnd, suggestRanges, voiceCoverage, voiceSpans,
} from '../utils/lyricVideo';
import { projectTimedWords } from '../utils/voiceLyrics';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';
import type { ClipTranscript, Marker } from '../types';

/** Mots d'une phrase posés à partir de t0 (temps du son du clip). */
const words = (text: string, t0: number, step = 0.4) => text.split(' ').map((w, i) => ({ w, s: t0 + i * step, e: t0 + i * step + 0.3, ...(i === 0 ? { b: true } : {}) }));
const tr = (ws: ReturnType<typeof words>): ClipTranscript => ({ version: 1, language: 'fr', model: 'large-v3-turbo', words: ws, bufferId: 'buf-1', at: 1 });

const TAKE = [
  ...words('Silence blanc tu prends toute la place', 1),
  ...words('Et mon cœur se lasse', 5),
  ...words("J'ai vu mes frères tomber", 12),
];

function voiceProject(start = 10) {
  const clip = makeClip({ start, duration: 20, bufferId: 'buf-1', transcript: tr(TAKE) });
  const lead = makeTrack({ id: 'lead', name: 'Lead', clips: [clip] });
  const beat = makeTrack({ id: 'instrumental', name: 'Beat', clips: [makeClip({ start: 0, duration: 60 })] });
  return makeState([beat, lead]);
}

describe('Lot 2a · paroles du clip', () => {
  it('transcription : un mot = son temps exact, dans le temps du morceau', () => {
    const st = voiceProject(10);
    const ws = projectTimedWords(st.tracks);
    const r = clipLyricLines({ lyrics: '', words: ws, end: 60 });
    expect(r.source).toBe('voix');
    expect(r.lines.length).toBe(3);
    expect(r.lines[0].words.map(w => w.text).join(' ')).toBe('Silence blanc tu prends toute la place');
    expect(r.lines[0].words[0].t).toBeCloseTo(11, 5); // 10 (clip) + 1 (son)
    expect(r.lines[0].words[1].t).toBeCloseTo(11.4, 5);
    expect(r.lines[2].words[0].t).toBeCloseTo(22, 5);
    // Fin de mot = fin transcrite (0,3 s), pas le début du suivant.
    expect(r.lines[0].words[0].e).toBeCloseTo(11.3, 5);
  });

  it('paroles corrigées à la main : mots ajoutés interpolés, lignes non chantées ignorées', () => {
    const st = voiceProject(0);
    const ws = projectTimedWords(st.tracks);
    const text = '[Couplet]\nSilence blanc tu prends vraiment toute la place\nEt mon cœur se lasse\n\n[Refrain]\nUne ligne jamais chantée ici\nJ\'ai vu mes frères tomber';
    const r = clipLyricLines({ lyrics: text, words: ws, end: 40 });
    expect(r.source).toBe('voix');
    const l0 = r.lines[0];
    expect(l0.words.map(w => w.text)).toEqual(['Silence', 'blanc', 'tu', 'prends', 'vraiment', 'toute', 'la', 'place']);
    const vr = l0.words[4];
    expect(vr.t).toBeGreaterThan(l0.words[3].t);
    expect(vr.t).toBeLessThan(l0.words[5].t);
    expect(r.lines.some(l => l.words[0].text === 'Une')).toBe(false);
    expect(r.lines[r.lines.length - 1].section).toBe('Refrain');
  });

  it('paroles tapées sans transcription : calées comme le prompteur (départ + vitesse)', () => {
    const r = clipLyricLines({ lyrics: 'un deux trois\nquatre cinq', words: [], lyricsStart: 4, lyricsSpeed: 12, end: 60 });
    expect(r.source).toBe('vitesse');
    expect(r.lines[0].t).toBeCloseTo(4, 2);
    expect(r.lines[1].t).toBeCloseTo(9, 2); // 12 lignes / min = 5 s par ligne
    expect(r.lines[0].words.length).toBe(3);
    expect(r.lines[0].words[1].t).toBeCloseTo(4 + 1.5, 2);
  });

  it('paroles tapées calées sur des régions', () => {
    const markers: Marker[] = [
      { id: 'r1', name: 'Couplet', time: 10, endTime: 20, type: 'REGION', color: '#fff' },
      { id: 'r2', name: 'Refrain', time: 30, endTime: 40, type: 'REGION', color: '#fff' },
    ];
    const text = 'a b\nc d\n\ne f\ng h';
    const r = clipLyricLines({ lyrics: text, words: [], markers, lyricsRegions: { 0: 'r1', 1: 'r2' }, end: 60 });
    expect(r.source).toBe('regions');
    expect(r.lines.map(l => Math.round(l.t))).toEqual([10, 15, 30, 35]);
  });

  it('aucune parole : source « aucune »', () => {
    expect(clipLyricLines({ lyrics: '  ', words: [], end: 30 })).toEqual({ lines: [], source: 'aucune', text: '' });
  });

  it('mots chantables : ponctuation et guillemets retirés', () => {
    expect(lineRawWords('« Oh, là » ... (yeah)')).toEqual(['Oh,', 'là', 'yeah']);
  });

  it('à l’instant t : ligne affichée juste avant, mot chanté, silence entre deux parties', () => {
    const st = voiceProject(0);
    const { lines } = clipLyricLines({ lyrics: '', words: projectTimedWords(st.tracks), end: 40 });
    expect(lyricsAt(lines, 0.5).line).toBe(-1);
    const pre = lyricsAt(lines, 0.8); // 0,2 s avant le 1er mot : la ligne est là, aucun mot chanté
    expect(pre.line).toBe(0);
    expect(pre.sung).toBe(-1);
    expect(lyricsAt(lines, 1.0).sung).toBe(0); // le 1er mot s'allume à son temps exact
    expect(lyricsAt(lines, 1.39).sung).toBe(0);
    expect(lyricsAt(lines, 1.4).sung).toBe(1);
    expect(lyricsAt(lines, 10).line).toBe(-1); // trou de 5,9 → 13 : rien
    expect(lyricsAt(lines, 10).next).toBe(2);
    expect(lyricsAt(lines, 12.1).line).toBe(2);
  });

  it('lignes d’une plage', () => {
    const st = voiceProject(0);
    const { lines } = clipLyricLines({ lyrics: '', words: projectTimedWords(st.tracks), end: 40 });
    expect(linesInRange(lines, 10, 5).length).toBe(1);
    expect(linesInRange(lines, 0, 30).length).toBe(3);
  });
});

describe('Lot 2a · plages', () => {
  it('voix : part de la plage où l’artiste chante (chevauchements comptés une fois)', () => {
    const spans = [{ start: 10, duration: 10 }, { start: 15, duration: 10 }];
    expect(voiceCoverage(spans, { start: 10, duration: 15 })).toBeCloseTo(1, 5);
    expect(voiceCoverage(spans, { start: 0, duration: 20 })).toBeCloseTo(0.5, 5);
    expect(voiceCoverage([], { start: 0, duration: 20 })).toBe(0);
  });

  it('borne la plage au morceau et à la durée permise', () => {
    expect(clampRange({ start: 50, duration: 30 }, 60, 30)).toEqual({ start: 30, duration: 30 });
    expect(clampRange({ start: -3, duration: 60 }, 60, 30)).toEqual({ start: 0, duration: 30 });
    expect(clampRange({ start: 0, duration: 30 }, 12, 30)).toEqual({ start: 0, duration: 12 });
  });

  it('passage le plus fort', () => {
    const env = new Float32Array(40); // 20 s par tranches de 0,5 s
    for (let i = 24; i < 34; i++) env[i] = 1;
    expect(loudestWindow(env, 0.5, 5)).toBe(12);
    expect(loudestWindow(new Float32Array(0), 0.5, 5)).toBeNull();
  });

  it('énergie : tirée des sons chargés, gain et volume compris', () => {
    const sr = 1000;
    const data = new Float32Array(4 * sr);
    for (let i = 2 * sr; i < 3 * sr; i++) data[i] = 0.5;
    const buf = { sampleRate: sr, length: data.length, getChannelData: () => data };
    const t = makeTrack({ volume: 1, clips: [makeClip({ start: 10, duration: 4, bufferId: 'b' })] });
    const env = energyEnvelope([t], () => buf, 20, 0.5);
    expect(env.length).toBe(40);
    const at = loudestWindow(env, 0.5, 1);
    expect(at).toBe(12); // 10 s (clip) + 2 s (son)
    expect(energyEnvelope([t], () => undefined, 20).length).toBe(0);
  });

  it('suggestions : la région « Refrain » d’abord, puis le plus fort, la boucle, la voix', () => {
    const st = voiceProject(10);
    st.markers = [{ id: 'r', name: 'Refrain', time: 24, endTime: 40, type: 'REGION', color: '#fff' }];
    st.isLoopActive = true; st.loopStart = 4; st.loopEnd = 12;
    const env = new Float32Array(120); for (let i = 80; i < 100; i++) env[i] = 1;
    const s = suggestRanges({ state: st, lines: [], duration: 15, env, bin: 0.5 });
    expect(s.map(x => x.id)).toEqual(['refrain', 'fort', 'boucle', 'voix']);
    expect(s[0].start).toBe(24);
    expect(s[3].start).toBe(9);
    expect(songEnd(st.tracks)).toBe(60);
  });

  it('suggestion du refrain par les titres des paroles quand il n’y a pas de région', () => {
    const st = voiceProject(0);
    const { lines } = clipLyricLines({ lyrics: '[Couplet]\nSilence blanc tu prends toute la place\n\n[Refrain]\nJ\'ai vu mes frères tomber', words: projectTimedWords(st.tracks), end: 60 });
    const s = suggestRanges({ state: st, lines, duration: 15 });
    expect(s[0].id).toBe('refrain');
    expect(s[0].start).toBeCloseTo(11.5, 2);
  });
});

describe('Lot 2a · règles de l’extrait et de l’export (inchangées)', () => {
  it('admin : clip complet', () => {
    expect(clipRights({ admin: true, unboughtCatalog: 2, hasCatalogBeat: true, exportPaid: null }).full).toBe(true);
  });
  it('instru du catalogue pas achetée : limité comme l’extrait (30 s, sur la voix)', () => {
    const r = clipRights({ admin: false, unboughtCatalog: 1, hasCatalogBeat: true, exportPaid: null });
    expect(r).toMatchObject({ full: false, maxDuration: LIMITED_MAX, needsVoice: true });
    expect(r.reason).toMatch(/pas encore achetée/);
  });
  it('instru importée : limité tant que l’export n’est pas payé (vérification en cours = non payé)', () => {
    expect(clipRights({ admin: false, unboughtCatalog: 0, hasCatalogBeat: false, exportPaid: null }).full).toBe(false);
    expect(clipRights({ admin: false, unboughtCatalog: 0, hasCatalogBeat: false, exportPaid: false }).reason).toMatch(/pas encore payé/);
    expect(clipRights({ admin: false, unboughtCatalog: 0, hasCatalogBeat: false, exportPaid: true }).full).toBe(true);
  });
  it('tout acheté : complet (60 s)', () => {
    expect(clipRights({ admin: false, unboughtCatalog: 0, hasCatalogBeat: true, exportPaid: null })).toMatchObject({ full: true, maxDuration: 60 });
  });
  it('plage refusée : trop longue, ou sans la voix quand c’est limité', () => {
    const lim = clipRights({ admin: false, unboughtCatalog: 1, hasCatalogBeat: true, exportPaid: null });
    const full = clipRights({ admin: true, unboughtCatalog: 0, hasCatalogBeat: true, exportPaid: null });
    const spans = voiceSpans(voiceProject(10).tracks);
    expect(spans).toEqual([{ start: 10, duration: 20 }]);
    expect(rangeProblem({ start: 10, duration: 45 }, lim, spans)).toMatch(/30 s au plus/);
    expect(rangeProblem({ start: 40, duration: 15 }, lim, spans)).toMatch(/ta voix/);
    expect(rangeProblem({ start: 12, duration: 15 }, lim, spans)).toBeNull();
    expect(rangeProblem({ start: 40, duration: 15 }, full, spans)).toBeNull();
    expect(rangeProblem({ start: 0, duration: 60 }, full, spans)).toBeNull();
  });
  it('passage chanté le plus proche', () => {
    const spans = [{ start: 10, duration: 20 }];
    const r = nearestVoiceRange({ start: 45, duration: 15 }, spans, 60)!;
    expect(voiceCoverage(spans, r)).toBeGreaterThanOrEqual(0.5);
    expect(r.start).toBe(22.5);
    expect(nearestVoiceRange({ start: 0, duration: 15 }, [], 60)).toBeNull();
  });
  it('nom du fichier', () => {
    expect(clipFileName('Mon/son: "test"', 'mp4')).toBe('Mon son test - clip paroles.mp4');
  });
});

describe('Lot 2a · visualiseur (FFT hors temps réel)', () => {
  it('FFT : un sinus tombe dans la bonne case', () => {
    const n = 1024, k = 37;
    const re = new Float32Array(n), im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * k * i) / n);
    fft(re, im);
    let best = 0;
    for (let i = 1; i < n / 2; i++) if (Math.hypot(re[i], im[i]) > Math.hypot(re[best], im[best])) best = i;
    expect(best).toBe(k);
  });
  it('spectre : la bande du sinus monte, le silence reste à zéro, déterministe', () => {
    const sr = 48000;
    const x = new Float32Array(sr);
    for (let i = 0; i < sr / 2; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sr);
    const a = new ClipSpectrum(x, sr, 32);
    const loud = a.at(0.25, false);
    const quiet = a.at(0.8, false);
    expect(Math.max(...loud.bands)).toBeGreaterThan(0.6);
    expect(Math.max(...quiet.bands)).toBe(0);
    expect(loud.level).toBeGreaterThan(0.5);
    expect(quiet.level).toBe(0);
    const b = new ClipSpectrum(x, sr, 32);
    expect(Array.from(b.at(0.25, false).bands)).toEqual(Array.from(loud.bands));
  });
});
