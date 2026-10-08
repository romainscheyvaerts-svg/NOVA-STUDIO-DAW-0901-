import { describe, expect, it } from 'vitest';
import { baseName, compareVersions, diffLines, nextVersionNumber, versionInName, versionName } from '../utils/projectVersions';
import { memoryBackend, RecoveryStore, KEEP_RECENT } from '../utils/recoveryStore';
import { makeClip, makeTrack } from './helpers/fixtures';

describe('R21 · versions nommées', () => {
  it('noms : « Titre v2 », « Titre v3 »…', () => {
    expect(versionName('Mon son', 2)).toBe('Mon son v2');
    expect(versionName('Mon son v2', 3)).toBe('Mon son v3');
    expect(baseName('Mon son_v12')).toBe('Mon son');
    expect(versionInName('Mon son v7')).toBe(7);
    expect(versionInName('Vivre')).toBeNull();
  });

  it('numéro suivant : nom, état et historique du projet', () => {
    expect(nextVersionNumber({ id: 'p', name: 'Son', sessionVersion: undefined })).toBe(2);
    expect(nextVersionNumber({ id: 'p', name: 'Son v4', sessionVersion: 2 })).toBe(5);
    expect(nextVersionNumber({ id: 'p', name: 'Son', sessionVersion: 3 }, [{ projectId: 'p', versionNumber: 6 }, { projectId: 'autre', versionNumber: 9 }])).toBe(7);
  });

  it('comparer : pistes ajoutées, retirées, renommées, clips et effets changés', () => {
    const before = { bpm: 120, tracks: [makeTrack({ id: 'a', name: 'LEAD', clips: [makeClip({ id: 'c1' })] }), makeTrack({ id: 'b', name: 'BACK' }), makeTrack({ id: 'master', name: 'M' })] };
    const after = { bpm: 128, tracks: [makeTrack({ id: 'a', name: 'LEAD 1', clips: [makeClip({ id: 'c1' }), makeClip({ id: 'c2' })] }), makeTrack({ id: 'c', name: 'ADLIB' }), makeTrack({ id: 'master', name: 'M' })] };
    const d = compareVersions(before, after);
    expect(d.added.map(x => x.name)).toEqual(['ADLIB']);
    expect(d.removed.map(x => x.name)).toEqual(['BACK']);
    expect(d.renamed).toEqual([{ id: 'a', from: 'LEAD', to: 'LEAD 1' }]);
    expect(d.clipsChanged[0]).toMatchObject({ before: 1, after: 2 });
    expect(d.tempo).toEqual({ before: 120, after: 128 });
    expect(diffLines(d).join('\n')).toMatch(/1 piste ajoutée depuis : « ADLIB »/);
    expect(compareVersions(before, before).same).toBe(true);
  });

  it('historique : une version nommée n’est jamais effacée par le ménage', async () => {
    let now = 1_000_000_000_000;
    const store = new RecoveryStore(memoryBackend(), () => now);
    const save = (extra = {}) => store.saveVersion({ projectId: 'p', name: 'Son', json: '{}', audioIds: [], getAudio: () => null, tracks: 1, takes: 0, beatTitle: null, hasLyrics: false, needsCatalogBeat: false, reason: 'auto', ...extra });
    await save({ reason: 'named', versionNumber: 2, comment: 'mix validé par l’artiste' });
    // 40 sauvegardes automatiques dans la même heure, 8 jours plus tard.
    now += 8 * 86_400_000;
    for (let i = 0; i < KEEP_RECENT + 20; i++) { now += 1000; await save(); }
    const list = await store.listVersions('p');
    const named = list.filter(v => v.versionNumber);
    expect(named).toHaveLength(1);
    expect(named[0].comment).toBe('mix validé par l’artiste');
    expect(list.length).toBeLessThanOrEqual(KEEP_RECENT + 2);
    expect(await store.annotate(named[0].id, { comment: 'autre' })).toBe(true);
    expect((await store.listVersions('p')).find(v => v.versionNumber)!.comment).toBe('autre');
  });
});
