import { describe, expect, it } from 'vitest';
import { addReply, createComment, editText, HybridClock, mergeComments, setArchived, setStatus } from '../utils/timelineComments';
import { createVersion, decide, mergeVersions } from '../utils/mixVersions';
import { collectReview, publicComments, publicVersions } from '../supabase/functions/daw-listen/review';

/**
 * Chantier 11 ↔ chantier 12 : la page d'écoute client (daw-listen, components/ListenPage)
 * lit EXACTEMENT les commentaires et versions écrits par NOVA (utils/timelineComments,
 * utils/mixVersions), dans le projet et dans le journal, et applique les mêmes règles.
 */
const NINA = { key: 'u:nina', name: 'Nina', role: 'artist' as const };
const MAX = { key: 'u:max', name: 'Max', role: 'engineer' as const };
const clk = (by: string, t: number) => new HybridClock(by, () => t);
const wire = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe('lien d’écoute : lecture des retours écrits par NOVA', () => {
  it('commentaires : même état que NOVA (projet + journal), archivés et clés internes exclus', () => {
    const c1 = createComment({ id: 'c1', time: 72, text: 'le « s » siffle' }, NINA, clk(NINA.key, 1000));
    const c1r = setStatus(addReply(c1, 'De-esser posé', MAX, clk(MAX.key, 2000)), 'resolved', MAX, clk(MAX.key, 2001));
    const c2 = createComment({ id: 'c2', time: 30, end: 34, text: 'clic' }, MAX, clk(MAX.key, 1500));
    const c3 = setArchived(createComment({ id: 'c3', time: 5, text: 'vieux' }, NINA, clk(NINA.key, 900)), true, clk(NINA.key, 950));
    const project = { timelineComments: wire([c1, c3]) };
    const ops = [{ kind: 'comments', op: { upsert: wire([c2]) } }, { kind: 'comments', op: { upsert: wire([c1r]) } }];
    const pub = publicComments(collectReview({ project, ops }).comments.values());
    const nova = mergeComments([c1, c3], [c2, c1r]).list.filter(c => !c.archived.v);
    expect(pub.map(c => [c.id, c.t, c.end, c.text, c.status, c.replies.map(r => r.text)])).toEqual(
      nova.map(c => [c.id, c.pos.v.t, c.pos.v.end, c.text.v, c.status.v.s, c.replies.map(r => r.text.v)]));
    expect(pub[1]).toMatchObject({ author: 'Nina', role: 'artist', replies: [{ author: 'Max', text: 'De-esser posé' }] });
    expect(JSON.stringify(pub)).not.toMatch(/u:nina|u:max|authorKey/);
  });

  it('mêmes droits que NOVA : un texte réécrit par un autre que l’auteur ne s’affiche pas', () => {
    const c = createComment({ id: 'c1', time: 72, text: 'le s siffle' }, NINA, clk(NINA.key, 1000));
    const forged = editText(c, 'tout va bien', clk(MAX.key, 9e9));
    const pub = publicComments(collectReview({ ops: [{ kind: 'comments', op: { upsert: wire([c]) } }, { kind: 'comments', op: { upsert: wire([forged]) } }] }).comments.values());
    expect(pub[0].text).toBe('le s siffle');
  });

  it('versions : décision de l’artiste, bounce, ordre ; décision non signée par son auteur ignorée', () => {
    const part = 'a'.repeat(40);
    const v1 = createVersion({ id: 'v1', n: 1, audio: { bufferId: 'mixv-1', parts: [part], size: 10, duration: 80 } }, MAX, clk(MAX.key, 1000));
    const v2 = createVersion({ id: 'v2', n: 2, name: 'Mix final', note: 'refrain −2 dB' }, MAX, clk(MAX.key, 3000));
    const d1 = decide(v1, 'changes', NINA, clk(NINA.key, 2000), 'refrain trop fort');
    const d2 = decide(v2, 'approved', NINA, clk(NINA.key, 4000));
    const fake = { ...decide(v2, 'changes', NINA, clk(MAX.key, 5000)) }; // horodatée par Max au nom de Nina
    const ops = [v1, v2, d1, d2, fake].map(x => ({ kind: 'mixver', op: { upsert: wire([x]) } }));
    const pub = publicVersions(collectReview({ ops }).versions.values());
    const nova = mergeVersions(mergeVersions([], [v1, v2], { fromEngineer: true, fromArtist: false }).list, [d1, d2, fake], { fromEngineer: false, fromArtist: true }).list;
    expect(pub.map(v => [v.n, v.name, v.decision?.kind ?? null])).toEqual([[2, 'Mix final', 'approved'], [1, 'Version 1', 'changes']]);
    expect(nova.map(v => v.decision.v?.kind)).toEqual(['changes', 'approved']); // la fausse décision est écartée des deux côtés
    expect(pub[1]).toMatchObject({ decision: { by: 'Nina', comment: 'refrain trop fort' }, audio: { parts: [part], duration: 80 } });
  });
});
