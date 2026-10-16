// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HybridClock, createComment } from '../utils/timelineComments';
import { createVersion, decide, mergeVersions, nextVersionN, readVersionsOp, versionSig, versionState, versionStatusLine, MixVersion, fmtDate, versionSnapshotComment } from '../utils/mixVersions';
import { guestOpVerdict, DEFAULT_GUEST_RIGHTS } from '../utils/guestRights';
import { ProjectIO } from '../services/ProjectIO';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { snapshotOf } from '../utils/recoverySnapshot';
import { projectSignature, sameSignature } from '../utils/autosavePolicy';
import { makeState, makeTrack } from './helpers/fixtures';

vi.mock('../engine/AudioEngine', async () => {
  const { FakeAudioContext } = await import('./helpers/audio');
  return { audioEngine: { init: async () => {}, ctx: new FakeAudioContext(44100) } };
});
vi.mock('../engine/VSTPluginNode', () => ({ liveVstNodes: new Map() }));
vi.mock('../services/NovaBridge', () => ({ novaBridge: { isConnected: () => false, subscribe: () => () => {} } }));

beforeEach(() => audioBufferRegistry.clear());

const MAX = { key: 'u:max', name: 'Max' };
const NINA = { key: 'u:nina', name: 'Nina' };
const clk = (by: string, t: number) => { let x = t; return { c: new HybridClock(by, () => x), set: (v: number) => { x = v; } }; };
const sig = (l: MixVersion[]) => JSON.stringify(l.map(versionSig));
const ENG = { fromEngineer: true, fromArtist: false };
const ART = { fromEngineer: false, fromArtist: true };

describe('chantier 11 · versions envoyées / validées', () => {
  it('numéros : 1, 2, 3… ; nom par défaut « Version N »', () => {
    const k = clk(MAX.key, 1000).c;
    const v1 = createVersion({ n: nextVersionN([]), ref: {} }, MAX, k);
    const v2 = createVersion({ n: nextVersionN([v1]), name: 'Mix voix devant' }, MAX, k);
    expect([v1.n, v1.name, v2.n, v2.name]).toEqual([1, 'Version 1', 2, 'Mix voix devant']);
    expect(versionState(v1)).toBe('waiting');
  });

  it('« Version 3 validée par Nina le … » daté', () => {
    const k = clk(MAX.key, Date.UTC(2026, 9, 12, 12, 0)).c;
    const v = decide(createVersion({ n: 3 }, MAX, k), 'approved', NINA, clk(NINA.key, Date.UTC(2026, 9, 12, 12, 32)).c);
    expect(versionStatusLine(v)).toBe(`Version 3 validée par Nina le ${fmtDate(v.decision.v!.at)}`);
    expect(versionStatusLine(v)).toMatch(/^Version 3 validée par Nina le 12\/10\/2026 à \d\d:32$/);
    const c = decide(v, 'changes', NINA, clk(NINA.key, Date.UTC(2026, 9, 12, 13, 0)).c, 'voix trop basse au refrain');
    expect(versionStatusLine(c)).toMatch(/^Version 3 : retouches demandées par Nina le .* \(« voix trop basse au refrain »\)$/);
  });

  it('seul l’ingé crée une version ; un artiste ne fait que décider', () => {
    const v = createVersion({ id: 'v1', n: 1 }, MAX, clk(MAX.key, 1000).c);
    const forged = createVersion({ id: 'v9', n: 9 }, NINA, clk(NINA.key, 1000).c);
    const r = mergeVersions([], [v, forged], ART);
    expect(r.list).toHaveLength(0);
    expect(r.orphans.map(x => x.id)).toEqual(['v1', 'v9']);
    const r2 = mergeVersions([v], [{ ...decide(v, 'approved', NINA, clk(NINA.key, 2000).c), name: 'renommée par l’artiste', n: 42 }], ART);
    expect(r2.list[0]).toMatchObject({ name: 'Version 1', n: 1 });
    expect(r2.list[0].decision.v?.kind).toBe('approved');
    expect(r2.decided).toHaveLength(1);
  });

  it('un ingé ne peut pas « valider » à la place de l’artiste', () => {
    const v = createVersion({ id: 'v1', n: 1 }, MAX, clk(MAX.key, 1000).c);
    const fake = decide(v, 'approved', MAX, clk(MAX.key, 2000).c);
    // L'ingé transmet une décision horodatée par lui mais attribuée à… lui-même : refusée.
    const r = mergeVersions([v], [{ ...fake, decision: { v: { ...fake.decision.v!, byKey: 'u:nina' }, s: fake.decision.s } }], ENG);
    expect(r.list[0].decision.v).toBeNull();
  });

  it('décision arrivée AVANT la version (ordre d’arrivée) : même état final partout', () => {
    const v = createVersion({ id: 'v1', n: 1 }, MAX, clk(MAX.key, 1000).c);
    const d = decide(v, 'changes', NINA, clk(NINA.key, 2000).c, 'plus de basse');
    // Chez A : version puis décision ; chez B : décision (orpheline) puis version.
    const a = mergeVersions(mergeVersions([], [v], ENG).list, [d], ART).list;
    const b1 = mergeVersions([], [d], ART);
    const b2 = mergeVersions(b1.list, [v], ENG);
    const b = mergeVersions(b2.list, b1.orphans, ART).list;
    expect(sig(a)).toBe(sig(b));
    expect(a[0].decision.v?.comment).toBe('plus de basse');
  });

  it('décisions simultanées de deux artistes : la plus récente gagne partout', () => {
    const v = createVersion({ id: 'v1', n: 1 }, MAX, clk(MAX.key, 1000).c);
    const x = decide(v, 'approved', NINA, clk(NINA.key, 3000).c);
    const y = decide(v, 'changes', { key: 'u:leo', name: 'Léo' }, clk('u:leo', 3000).c, 'non');
    const p = mergeVersions(mergeVersions([v], [x], ART).list, [y], ART).list;
    const q = mergeVersions(mergeVersions([v], [y], ART).list, [x], ART).list;
    expect(sig(p)).toBe(sig(q));
  });

  it('opération reçue vérifiée (champs illisibles ignorés)', () => {
    expect(readVersionsOp({ upsert: [{ id: 'v', n: -1 }, null, 3] })).toEqual([]);
    const v = createVersion({ n: 2, audio: { bufferId: 'mixv-1', parts: ['ab'], size: 10, duration: 16 } }, MAX, clk(MAX.key, 1000).c);
    expect(readVersionsOp({ upsert: [JSON.parse(JSON.stringify(v))] })[0]).toMatchObject({ n: 2, audio: { bufferId: 'mixv-1', duration: 16 } });
  });

  it('artiste invité (mode simple) : il peut commenter et décider', () => {
    const ctx = { rights: DEFAULT_GUEST_RIGHTS, authorKey: 'u:nina:abc' };
    expect(guestOpVerdict('comments', { upsert: [] }, ctx).ok).toBe(true);
    expect(guestOpVerdict('mixver', { upsert: [{ id: 'v1' }] }, ctx).ok).toBe(true);
  });
});

describe('chantier 11 · enregistré dans le projet', () => {
  const state = () => {
    const k = new HybridClock('u:max', () => 1_700_000_000_000);
    const c = createComment({ id: 'c1', time: 72, text: 'le s siffle' }, { key: 'u:nina', name: 'Nina', role: 'artist' }, new HybridClock('u:nina', () => 1_700_000_000_000));
    const v = decide(createVersion({ id: 'v1', n: 3 }, MAX, k), 'approved', NINA, new HybridClock('u:nina', () => 1_700_000_100_000));
    return makeState([makeTrack({ id: 'lead', name: 'LEAD' })], { timelineComments: [c], mixVersions: [v] });
  };
  it('le .zip du projet garde commentaires et versions', async () => {
    const blob = await ProjectIO.saveProject(state(), []);
    const s = await ProjectIO.loadProject(new File([blob], 'p.zip'));
    expect(s.timelineComments?.[0]).toMatchObject({ id: 'c1', pos: { v: { t: 72, end: null } }, text: { v: 'le s siffle' } });
    expect(versionStatusLine(s.mixVersions![0])).toMatch(/^Version 3 validée par Nina le /);
  });
  it('la sauvegarde automatique (historique) les garde, et un commentaire suffit à écrire une version', () => {
    const s = state();
    const back = JSON.parse(snapshotOf(s).json);
    expect(back.timelineComments).toHaveLength(1);
    expect(back.mixVersions).toHaveLength(1);
    expect(sameSignature(projectSignature(s), projectSignature({ ...s, timelineComments: [...s.timelineComments!] }))).toBe(false);
  });
});

describe('versions de collaboration : auteur et date toujours portés (décision du 16/10/2026)', () => {
  it('la version et son instantané de séance disent qui l’a envoyée et quand', () => {
    const at = new Date(2026, 9, 16, 11, 32).getTime();
    expect(versionSnapshotComment(2, { name: 'Max' }, at, 'voix plus devant')).toBe(`Version 2 envoyée à l'artiste par Max le ${fmtDate(at)} : voix plus devant`);
    expect(fmtDate(at)).toBe('16/10/2026 à 11:32');
    expect(versionSnapshotComment(3, { name: '  ' }, at)).toBe(`Version 3 envoyée à l'artiste par un membre le ${fmtDate(at)}`);
    const v = createVersion({ n: 1 }, { key: 'k-max', name: 'Max' }, new HybridClock('k-max'));
    expect(v.sentBy).toBe('Max');
    expect(Number.isFinite(v.sentAt) && v.sentAt > 0).toBe(true);
    expect(versionStatusLine(v)).toMatch(/^Version 1 envoyée par Max le \d\d\/\d\d\/\d{4} à \d\d:\d\d/);
  });
});
