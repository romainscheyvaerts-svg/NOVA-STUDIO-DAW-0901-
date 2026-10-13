import { describe, expect, it } from 'vitest';
import {
  activeWordInLine, alignWords, buildTranscript, clipLyricLabels, correctedTranscripts, isHeaderLine, lyricLineTimes,
  lyricsFromWords, normWord, projectTimedWords, shiftTranscript, timedAnchors, transcriptValid,
} from '../utils/voiceLyrics';
import { prompterLine } from '../utils/lyricsTiming';
import { makeClip, makeTrack } from './helpers/fixtures';
import type { ClipTranscript } from '../types';

/** Mots d'une phrase, posés à partir de t0 (0,4 s par mot, temps du son). */
const words = (text: string, t0: number, step = 0.4) => text.split(' ').map((w, i) => ({ w, s: t0 + i * step, e: t0 + i * step + 0.3, ...(i === 0 ? { b: true } : {}) }));
const tr = (ws: ReturnType<typeof words>, bufferId = 'buf-1'): ClipTranscript => ({ version: 1, language: 'fr', model: 'large-v3-turbo', words: ws, bufferId, at: 1 });

const TAKE = [
  ...words('Silence blanc, silence blanc, tu prends toute la place', 1),
  ...words('Silence blanc, silence blanc et mon cœur se lasse', 5),
  ...words("J'ai vu mes frères tomber", 12),
];

describe('R24 · paroles calées sur la voix', () => {
  it('normalise les mots (accents, ponctuation, apostrophes)', () => {
    expect(normWord('Cœur,')).toBe('coeur');
    expect(normWord('« Été »')).toBe('ete');
    expect(normWord('J’ai')).toBe("j'ai");
    expect(normWord('...')).toBe('');
    expect(isHeaderLine('[Refrain]')).toBe(true);
    expect(isHeaderLine('Refrain')).toBe(false);
  });

  it('mots du clip en temps du morceau : suivent le déplacement et le rognage', () => {
    const clip = makeClip({ id: 'c', start: 10, offset: 0, duration: 20, bufferId: 'buf-1', transcript: tr(TAKE) });
    const t = makeTrack({ id: 'lead', clips: [clip] });
    let w = projectTimedWords([t]);
    expect(w[0]).toMatchObject({ w: 'Silence', t: 11, clipId: 'c', trackId: 'lead' });
    // Clip rogné au début de 4 s (offset 4, start 14) : le 1er vers n'est plus montré.
    const trimmed = { ...clip, start: 14, offset: 4, duration: 16 };
    w = projectTimedWords([{ ...t, clips: [trimmed] }]);
    expect(w[0].w).toBe('place'); // dernier mot du 1er vers (4,2 s dans le son) : encore montré
    expect(w[0].t).toBeCloseTo(14.2, 5);
    expect(w[1]).toMatchObject({ w: 'Silence' });
    expect(w[1].t).toBeCloseTo(15, 5); // le mot à 5 s du son passe à 14 + (5 - 4)
    expect(w.length).toBe(TAKE.length - 8);
  });

  it('transcription caduque : autre son, clip inversé, clip coupé', () => {
    const clip = makeClip({ bufferId: 'buf-2', transcript: tr(TAKE, 'buf-1') });
    expect(transcriptValid(clip)).toBe(false);
    expect(transcriptValid({ ...clip, bufferId: 'buf-1' })).toBe(true);
    expect(transcriptValid({ ...clip, bufferId: 'buf-1', isReversed: true })).toBe(false);
    expect(projectTimedWords([makeTrack({ clips: [{ ...clip, bufferId: 'buf-1', isMuted: true }] })])).toEqual([]);
  });

  it('une prise qui recouvre la lead (double) est ignorée par le prompteur', () => {
    const lead = makeClip({ id: 'lead', start: 0, duration: 20, bufferId: 'b1', transcript: tr(TAKE, 'b1') });
    const dbl = makeClip({ id: 'dbl', start: 0.05, duration: 20, bufferId: 'b2', transcript: tr(TAKE, 'b2') });
    const w = projectTimedWords([makeTrack({ clips: [lead] }), makeTrack({ clips: [dbl] })]);
    expect(w.length).toBe(TAKE.length);
    expect(new Set(w.map(x => x.clipId))).toEqual(new Set(['lead']));
  });

  it('paroles tirées de la transcription : lignes, parties, sections', () => {
    const clip = makeClip({ start: 0, duration: 20, bufferId: 'buf-1', transcript: tr(TAKE) });
    const w = projectTimedWords([makeTrack({ clips: [clip] })]);
    expect(lyricsFromWords(w)).toBe([
      'Silence blanc, silence blanc, tu prends toute la place',
      'Silence blanc, silence blanc et mon cœur se lasse',
      '',
      "J'ai vu mes frères tomber",
    ].join('\n'));
    const text = lyricsFromWords(w, [{ name: 'Refrain', start: 0, end: 10 }, { name: 'Couplet 2', start: 10, end: 30 }]);
    expect(text.split('\n')).toEqual([
      '[Refrain]',
      'Silence blanc, silence blanc, tu prends toute la place',
      'Silence blanc, silence blanc et mon cœur se lasse',
      '',
      '[Couplet 2]',
      "J'ai vu mes frères tomber",
    ]);
  });

  it('chaque ligne a le temps de son premier mot ; corriger le texte garde les temps', () => {
    const clip = makeClip({ start: 2, duration: 20, bufferId: 'buf-1', transcript: tr(TAKE) });
    const w = projectTimedWords([makeTrack({ clips: [clip] })]);
    const text = lyricsFromWords(w, [{ name: 'Refrain', start: 0, end: 10 }, { name: 'Couplet', start: 10, end: 40 }]);
    expect(lyricLineTimes(text, w)).toEqual([null, 3, 7, null, null, 14]);
    // L'artiste corrige des mots, ajoute une ligne pas encore enregistrée.
    const fixed = text.replace('mon cœur se lasse', 'mon cœur se lace').replace("J'ai vu mes frères tomber", "J'ai vu mes frères tomber\nUne ligne toute neuve à enregistrer bientôt dans la cabine");
    const times = lyricLineTimes(fixed, w);
    expect(times[1]).toBe(3);
    expect(times[2]).toBe(7);
    expect(times[5]).toBe(14);
    expect(times[6]).toBeNull();
  });

  it('prompteur : la ligne passe sur la ligne de lecture quand elle est chantée', () => {
    const clip = makeClip({ start: 0, duration: 20, bufferId: 'buf-1', transcript: tr(TAKE) });
    const w = projectTimedWords([makeTrack({ clips: [clip] })]);
    const text = ['[Refrain]', 'Silence blanc, silence blanc, tu prends toute la place', 'Silence blanc, silence blanc et mon cœur se lasse', '', "J'ai vu mes frères tomber"].join('\n');
    const anchors = timedAnchors(text, w);
    expect(anchors.map(a => a.line)).toEqual([1, 2, 4, 5]);
    expect(prompterLine(0, { anchors, start: 0, speed: 16 })).toBe(1);
    expect(prompterLine(5, { anchors, start: 0, speed: 16 })).toBeCloseTo(2, 5);
    expect(prompterLine(3, { anchors, start: 0, speed: 16 })).toBeCloseTo(1.5, 5);
    expect(Math.floor(prompterLine(12.5, { anchors, start: 0, speed: 16 }))).toBe(4);
    // Mot en cours (surlignage) : à 6,3 s, le 4e mot du 2e vers est chanté.
    expect(activeWordInLine(text, w, 2, 6.3)).toBe(3);
    expect(activeWordInLine(text, w, 2, 4)).toBe(-1);
  });

  it('pas de transcription : aucun calage', () => {
    expect(timedAnchors('Une ligne', [])).toEqual([]);
    expect(lyricLineTimes('a\nb', [])).toEqual([null, null]);
  });

  it('alignement mot à mot : mots proches appariés, ajouts et retraits', () => {
    expect(alignWords(['je', 'marche', 'seul'], ['je', 'marche', 'seul'])).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(alignWords(['je', 'marche', 'tout', 'seul'], ['je', 'marche', 'seul'])).toEqual([[0, 0], [1, 1], [2, null], [3, 2]]);
    expect(alignWords(['lace'], ['lasse'])).toEqual([[0, 0]]);
  });

  it('le texte corrigé est reporté sur les mots du clip (texte au-dessus du clip)', () => {
    const clip = makeClip({ id: 'c', start: 10, offset: 1, duration: 20, bufferId: 'buf-1', transcript: tr(TAKE) });
    const t = makeTrack({ clips: [clip] });
    const text = 'Silence blanc, silence blanc, tu prends toute la place\nSilence blanc, silence blanc et mon cœur se lace\nJ\'ai vu tous mes frères tomber';
    const changed = correctedTranscripts([t], text);
    const ws = changed.get('c')!;
    expect(ws.find(x => x.w === 'lace')!.s).toBeCloseTo(5 + 8 * 0.4, 5); // même temps que « lasse »
    const tous = ws.find(x => x.w === 'tous')!; // mot ajouté entre « vu » et « mes »
    expect(tous.s).toBeGreaterThan(12.4);
    expect(tous.s).toBeLessThan(12.8);
    expect(ws.some(x => x.w === 'lasse')).toBe(false);
    // Rien de changé : aucun clip réécrit.
    expect(correctedTranscripts([t], lyricsFromWords(projectTimedWords([t]))).size).toBe(0);
  });

  it('AudioSuite (déréverbération) : les mots suivent le nouveau son', () => {
    const t0 = tr(TAKE);
    const s = shiftTranscript(t0, 0.5, 'buf-dv');
    expect(s.bufferId).toBe('buf-dv');
    expect(s.words[0].s).toBeCloseTo(0.5, 5);
    const clip = makeClip({ start: 0, offset: 0.5, duration: 20, bufferId: 'buf-dv', transcript: { ...s, show: true } });
    expect(clipLyricLabels(clip)[0]).toEqual({ text: 'Silence', at: 0 });
  });

  it('mots du pont → transcription du clip (son envoyé avec une poignée)', () => {
    const b = buildTranscript([{ w: ' Salut', s: 0.2, e: 0.5, p: 0.91234 }, { w: ' ', s: 1, e: 1.1 }], { from: 3, bufferId: 'x', language: 'fr', model: 'large-v3-turbo', now: 7 });
    expect(b).toEqual({ version: 1, language: 'fr', model: 'large-v3-turbo', words: [{ w: 'Salut', s: 3.2, e: 3.5, p: 0.912 }], bufferId: 'x', at: 7 });
    expect(buildTranscript([{ w: 'Yo', s: 0, e: 0.2, b: true }], { from: 0, language: 'fr', model: 'm', now: 1 }).words[0].b).toBe(true);
  });
});
