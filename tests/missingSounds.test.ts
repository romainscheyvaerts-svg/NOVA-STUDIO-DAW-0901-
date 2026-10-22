import { describe, expect, it } from 'vitest';
import { matchFiles, missingClips, relinkedClip, soundKey } from '../utils/missingSounds';
import { makeClip, makeTrack } from './helpers/fixtures';

describe('Sons manquants (Relier)', () => {
  const voix = makeTrack({ id: 'v', name: 'Voix', clips: [
    makeClip({ id: 'a', name: 'Prise 3', isOffline: true, bufferId: undefined, start: 4, duration: 10, offset: 2 }),
    makeClip({ id: 'b', name: 'Prise 3', isOffline: true, bufferId: undefined, start: 20, duration: 5 }),
    makeClip({ id: 'c', name: 'Back', bufferId: 'ok' }),
    makeClip({ id: 'd', name: 'Beat', isOffline: true, isUnlicensed: true, bufferId: undefined }),
  ] });

  it('liste les clips muets (pas le beat sous licence, pas les clips qui ont leur son)', () => {
    expect(missingClips([voix]).map(m => m.clipId)).toEqual(['a', 'b']);
  });

  it('noms comparés sans extension, accents, casse ni séparateurs', () => {
    expect(soundKey('Prise_03.WAV')).toBe('prise 03');
    expect(soundKey('Été (copie)')).toBe('ete');
  });

  it('fichiers reliés par le nom ; un fichier relie toutes les parties d\'une prise découpée', () => {
    const m = matchFiles([{ name: 'autre.wav' }, { name: 'prise-3.wav' }], missingClips([voix]));
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(1);
  });

  it('un seul clip manquant et un seul fichier : relié quel que soit le nom', () => {
    const one = [missingClips([voix])[0]];
    expect(matchFiles([{ name: 'take_final.wav' }], one).get('a')).toBe(0);
  });

  it('clip relié : son à la place, plus muet ; son trop court → clip raccourci, jamais de silence ajouté', () => {
    const c = relinkedClip(voix.clips[0], 'buf1', 8);
    expect(c).toMatchObject({ bufferId: 'buf1', start: 4, offset: 2, duration: 6 });
    expect(c.isOffline).toBeUndefined();
    expect(relinkedClip(voix.clips[0], 'buf2', 1)).toMatchObject({ offset: 0, duration: 1 });
  });
});
