import { describe, expect, it } from 'vitest';
import {
  applyTranscriptions, blendDeverb, deverbBlock, deverbPatch, deverbRegion, describeVoiceError, formatBytes, installButtonLabel,
  setTranscriptShown, sliceChannels, transcribeBlock, transcribeRegion, transcriptionSummary, voiceAvailability, voiceMenuState,
  VOICE_WEB_TOOLTIP,
} from '../services/VoiceAI';
import { audioSuiteRevertPatch, patchClip } from '../utils/clipProcess';
import { lyricLineTimes, projectTimedWords } from '../utils/voiceLyrics';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';
import { TrackType } from '../types';

const fakeBuffer = (n: number, sr = 48000, ch = 1) => ({
  numberOfChannels: ch, sampleRate: sr, length: n, duration: n / sr,
  getChannelData: (c: number) => Float32Array.from({ length: n }, (_, i) => (c + 1) * i),
});

describe('R24 · voix par l’IA locale (logique)', () => {
  it('site sans pont : commandes visibles mais grisées, avec la raison', () => {
    expect(voiceAvailability({ status: 'idle', voice: false }, false)).toBe('web');
    expect(voiceAvailability({ status: 'idle', voice: false }, true)).toBe('connect');
    expect(voiceAvailability({ status: 'connected', voice: false }, true)).toBe('update');
    expect(voiceAvailability({ status: 'connected', voice: true }, true)).toBe('ok');
    const web = voiceMenuState('web', 'Retire la réverbe.');
    expect(web.disabled).toBe(true);
    expect(web.title.startsWith(VOICE_WEB_TOOLTIP)).toBe(true);
    expect(voiceMenuState('ok', 'X')).toEqual({ disabled: false, title: 'X' });
    expect(voiceMenuState('connect', 'X').disabled).toBe(false);
  });

  it('tailles annoncées en français', () => {
    expect(formatBytes(1_620_000_000)).toBe('1,6 Go');
    expect(formatBytes(26_912_256)).toBe('27 Mo');
    expect(formatBytes(null)).toBe('');
    expect(installButtonLabel('transcribe', 1_850_000_000)).toBe('Installer la transcription (~1,9 Go, une fois)');
    expect(installButtonLabel('deverb', null)).toBe('Installer le retrait de réverbe (une fois)');
  });

  it('erreurs lisibles', () => {
    expect(describeVoiceError({ code: 'cancelled', message: 'x' })).toBe('Calcul annulé.');
    expect(describeVoiceError({ code: 'not_installed', message: 'x' })).toMatch(/pas encore installée/);
    expect(describeVoiceError(new Error('Pont VST déconnecté'))).toMatch(/relance Nova Studio/);
    expect(describeVoiceError(new Error('Pas assez de mémoire'))).toBe('Pas assez de mémoire');
  });

  it('dosage : 0 % = original, 100 % = sans réverbe, entre les deux = mélange', () => {
    const o = [Float32Array.from([1, 1, 1])];
    const w = [Float32Array.from([0, 0.5, 1])];
    expect(Array.from(blendDeverb(o, w, 0)[0])).toEqual([1, 1, 1]);
    expect(Array.from(blendDeverb(o, w, 1)[0])).toEqual([0, 0.5, 1]);
    expect(Array.from(blendDeverb(o, w, 0.8)[0]).map(v => Math.round(v * 100) / 100)).toEqual([0.2, 0.6, 1]);
    // Voix stéréo, traitement renvoyé en mono : le canal unique sert aux deux.
    expect(blendDeverb([o[0], o[0]], w, 1).length).toBe(2);
  });

  it('partie envoyée : clip + 0,5 s de poignées, bornée au son', () => {
    expect(deverbRegion({ offset: 2, duration: 3 }, 10)).toEqual({ from: 1.5, to: 5.5, lead: 0.5 });
    expect(deverbRegion({ offset: 0, duration: 3 }, 3.2)).toEqual({ from: 0, to: 3.2, lead: 0 });
    expect(transcribeRegion({ offset: 1, duration: 2 }, 10)).toEqual({ from: 0.75, to: 3.25 });
    const ch = sliceChannels(fakeBuffer(48000 * 2, 48000, 2), 0.5, 1);
    expect(ch.length).toBe(2);
    expect(ch[0].length).toBe(24000);
    expect(ch[0][0]).toBe(24000);
    expect(ch[1][0]).toBe(48000);
  });

  it('clips refusés avec la raison', () => {
    expect(deverbBlock(makeClip({ type: TrackType.MIDI }))).toMatch(/MIDI/);
    expect(deverbBlock(makeClip({ bufferId: 'b', isReversed: true }))).toMatch(/inversé/);
    expect(deverbBlock(makeClip({ bufferId: 'b', duration: 0.2 }))).toMatch(/trop court/);
    expect(deverbBlock(makeClip({ bufferId: 'b' }))).toBeNull();
    expect(transcribeBlock(makeClip({ bufferId: 'b' }), false)).toMatch(/pas encore chargé/);
    expect(transcribeBlock(makeClip({ bufferId: 'b', warp: { mode: 'BEATS' } as any }), true)).toMatch(/warp/);
    expect(transcribeBlock(makeClip({ bufferId: 'b' }), true)).toBeNull();
  });

  it('appliquer la déréverbération : non destructif (AudioSuite), la transcription suit, retour à l’original', () => {
    const clip = makeClip({ id: 'v', name: 'Lead', start: 4, offset: 2, duration: 3, bufferId: 'orig',
      transcript: { version: 1, language: 'fr', model: 'm', words: [{ w: 'Salut', s: 2.5, e: 2.9 }], bufferId: 'orig', at: 1 } });
    const patch = deverbPatch(clip, { newBufferId: 'dv', from: 1.5, amount: 0.8, now: 9 });
    const after = patchClip(clip, patch);
    expect(after.bufferId).toBe('dv');
    expect(after.offset).toBeCloseTo(0.5, 9);
    expect(after.name).toBe('Lead (AudioSuite : Réverbe retirée 80 %)');
    expect(after.audioSuite?.steps[0]).toEqual({ type: 'AI_DEVERB', name: 'Réverbe retirée 80 %', at: 9 });
    expect(after.transcript?.bufferId).toBe('dv');
    expect(after.transcript?.words[0].s).toBeCloseTo(1, 9);
    // Même place dans le morceau avant / après.
    const t = (c: typeof clip) => projectTimedWords([makeTrack({ clips: [c] })])[0].t;
    expect(t(after)).toBeCloseTo(t(clip), 9);
    const back = patchClip(after, audioSuiteRevertPatch(after, id => id === 'orig')!);
    expect(back.bufferId).toBe('orig');
    expect(back.offset).toBe(2);
    expect(back.name).toBe('Lead');
  });

  it('transcription posée : clip + paroles (remplir, garder, ajouter) en un seul changement', () => {
    const c1 = makeClip({ id: 'c1', start: 0, duration: 10, bufferId: 'b1' });
    const c2 = makeClip({ id: 'c2', start: 20, duration: 10, bufferId: 'b2' });
    const s0 = makeState([makeTrack({ id: 'lead', clips: [c1, c2] })], {
      markers: [{ id: 'm1', name: 'Couplet', time: 0, type: 'MARKER', color: '#fff' }, { id: 'm2', name: 'Refrain', time: 18, type: 'MARKER', color: '#fff' }],
    });
    const r1 = { trackId: 'lead', clipId: 'c1', from: 0, bufferId: 'b1', language: 'fr', model: 'large-v3-turbo',
      words: [{ w: 'Je', s: 1, e: 1.2, b: true }, { w: 'marche', s: 1.3, e: 1.7 }, { w: 'seul', s: 1.8, e: 2.2 }] };
    const r2 = { trackId: 'lead', clipId: 'c2', from: 0, bufferId: 'b2', language: 'fr', model: 'large-v3-turbo',
      words: [{ w: 'Silence', s: 1, e: 1.4, b: true }, { w: 'blanc', s: 1.5, e: 1.9 }] };
    let s = applyTranscriptions(s0, [r1, r2], { mode: 'replace', show: true, now: 5 });
    expect(s.lyrics).toBe('[Couplet]\nJe marche seul\n\n[Refrain]\nSilence blanc');
    const c = s.tracks[0].clips[0];
    expect(c.transcript).toMatchObject({ language: 'fr', model: 'large-v3-turbo', bufferId: 'b1', show: true, at: 5 });
    expect(lyricLineTimes(s.lyrics!, projectTimedWords(s.tracks))).toEqual([null, 1, null, null, 21]);
    // Paroles déjà écrites : gardées, seulement calées.
    s = applyTranscriptions({ ...s0, lyrics: 'Je marche tout seul\nSilence blanc' }, [r1, r2], { mode: 'keep', show: false });
    expect(s.lyrics).toBe('Je marche tout seul\nSilence blanc');
    expect(s.tracks[0].clips[0].transcript?.show).toBeUndefined();
    expect(lyricLineTimes(s.lyrics!, projectTimedWords(s.tracks))).toEqual([1, 21]);
    // Ajouter à la fin : seulement le texte des clips transcrits maintenant.
    s = applyTranscriptions({ ...s0, lyrics: 'Intro' }, [r2], { mode: 'append', show: false });
    expect(s.lyrics).toBe('Intro\n\n[Refrain]\nSilence blanc');
  });

  it('texte au-dessus du clip : allumer / éteindre', () => {
    const c = makeClip({ transcript: { version: 1, language: 'fr', model: 'm', words: [], at: 1, show: true } });
    expect(setTranscriptShown(c, false)?.transcript).not.toHaveProperty('show');
    expect(setTranscriptShown({ ...c, transcript: { ...c.transcript!, show: undefined } }, true)?.transcript?.show).toBe(true);
    expect(setTranscriptShown(makeClip(), true)).toBeNull();
  });

  it('résumé après la transcription', () => {
    expect(transcriptionSummary([{ trackId: 't', clipId: 'c', from: 0, language: 'fr', model: 'm', words: [{ w: 'a', s: 0, e: 1 }, { w: 'b', s: 1, e: 2 }] }], 3.2, 'cuda'))
      .toBe('📝 2 mots transcrits sur 1 clip (3 s, carte graphique). Corrige le texte dans le prompteur : les temps suivent.');
  });
});
