import { describe, expect, it } from 'vitest';
import { hasWorthKeeping, keepSessionFlagOnClose, projectSignature, sameSignature } from '../utils/autosavePolicy';

const base = (over: any = {}) => ({
  id: 'p', name: 'Séance', bpm: 120, markers: [], timeSignature: { numerator: 4, denominator: 4 }, isRecording: false,
  tracks: [{ id: 'instrumental', clips: [{ id: 'b' }] }, { id: 'voix', clips: [{ id: 'c1' }] }],
  ...over,
}) as any;

describe('sauvegarde automatique : rien ne se perd (utils/autosavePolicy)', () => {
  it('signature : identique tant que le projet ne change pas, différente après une édition', () => {
    const s = base();
    expect(sameSignature(projectSignature(s), projectSignature({ ...s, isPlaying: true }))).toBe(true);
    expect(sameSignature(projectSignature(s), projectSignature({ ...s, tracks: [...s.tracks] }))).toBe(false);
    expect(sameSignature(projectSignature(s), null)).toBe(false);
  });

  it('projet vierge ou beat seul : rien à garder', () => {
    expect(hasWorthKeeping(base({ tracks: [{ id: 'instrumental', clips: [{ id: 'b' }] }] }))).toBe(false);
    expect(hasWorthKeeping(base())).toBe(true);
    expect(hasWorthKeeping(base({ tracks: [], lyrics: 'couplet' }))).toBe(true);
  });

  it('onglet fermé en pleine prise : le drapeau reste (la réouverture propose de récupérer)', () => {
    const s = base({ isRecording: true });
    expect(keepSessionFlagOnClose(s, projectSignature(s))).toBe(true);
  });

  it('onglet fermé avec des changements pas encore écrits : le drapeau reste ; tout écrit : il part', () => {
    const s = base();
    const saved = projectSignature(s);
    expect(keepSessionFlagOnClose(s, saved)).toBe(false);
    expect(keepSessionFlagOnClose({ ...s, bpm: 97 }, saved)).toBe(true);
    expect(keepSessionFlagOnClose(base({ tracks: [] }), null)).toBe(false);
  });
});
