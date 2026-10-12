import { describe, expect, it } from 'vitest';
import {
  addReply, commentCounts, commentSig, createComment, editText, enforceAuthorship, filterComments, fmtTime, HybridClock, mergeComment,
  mergeComments, posLabel, readCommentsOp, sanitizeComment, setArchived, setStatus, TimelineComment, cmpStamp,
} from '../utils/timelineComments';

const NINA = { key: 'u:nina', name: 'Nina', role: 'artist' as const };
const MAX = { key: 'u:max', name: 'Max', role: 'engineer' as const };

/** Horloge pilotée (heure figée possible : deux personnes à la même milliseconde). */
const clockAt = (by: string, t0 = 1_000_000) => { let t = t0; const c = new HybridClock(by, () => t); return { c, set: (x: number) => { t = x; } }; };

const sig = (l: TimelineComment[]) => JSON.stringify(l.map(commentSig));

/** Petit générateur pseudo-aléatoire reproductible. */
function rng(seed: number) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
function shuffle<T>(a: T[], r: () => number): T[] { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }

describe('chantier 11 · horloge hybride', () => {
  it('toujours croissante, même si l’heure de l’appareil recule ou reste figée', () => {
    const { c, set } = clockAt('u:a');
    const a = c.tick(); const b = c.tick();
    set(500); const d = c.tick();
    expect(cmpStamp(b, a)).toBe(1);
    expect(cmpStamp(d, b)).toBe(1);
  });
  it('une modification faite après en avoir vu une autre gagne, même avec une horloge en retard', () => {
    const fast = clockAt('u:a', 9_000_000).c, slow = clockAt('u:b', 1_000).c;
    const seen = fast.tick();
    slow.observe(seen);
    expect(cmpStamp(slow.tick(), seen)).toBe(1);
  });
});

describe('chantier 11 · gestes', () => {
  it('« 1:12 le s siffle » : instant exact, ouvert, sans réponse', () => {
    const c = createComment({ time: 72, text: '  le "s" siffle  ' }, NINA, clockAt(NINA.key).c);
    expect(c.pos.v).toEqual({ t: 72, end: null });
    expect(c.text.v).toBe('le "s" siffle');
    expect(c.status.v.s).toBe('open');
    expect(posLabel(c)).toBe('1:12');
  });
  it('plage : 1:12 → 1:20 ; une fin avant le début est ignorée', () => {
    const k = clockAt(MAX.key).c;
    expect(posLabel(createComment({ time: 72, end: 80, text: 'x' }, MAX, k))).toBe('1:12 → 1:20');
    expect(createComment({ time: 72, end: 70, text: 'x' }, MAX, k).pos.v.end).toBeNull();
  });
  it('répondre, résoudre, archiver : compteurs et filtres', () => {
    const k = clockAt(MAX.key).c;
    let c = createComment({ time: 72, text: 'siffle' }, NINA, clockAt(NINA.key).c);
    c = addReply(c, 'De-esser posé', MAX, k);
    c = setStatus(c, 'resolved', MAX, k);
    expect(c.replies).toHaveLength(1);
    expect(c.status.v).toMatchObject({ s: 'resolved', by: 'Max' });
    expect(commentCounts([c])).toEqual({ open: 0, resolved: 1, archived: 0 });
    c = setArchived(c, true, k);
    expect(filterComments([c], 'archived')).toHaveLength(1);
    expect(filterComments([c], 'resolved')).toHaveLength(0);
  });
  it('fmtTime : minutes:secondes, dixième si besoin', () => {
    expect(fmtTime(72)).toBe('1:12');
    expect(fmtTime(72.5)).toBe('1:12,5');
    expect(fmtTime(5)).toBe('0:05');
  });
});

describe('chantier 11 · fusion (convergence)', () => {
  it('commutative, associative, idempotente', () => {
    const kn = clockAt(NINA.key).c, km = clockAt(MAX.key).c;
    const base = createComment({ id: 'c1', time: 72, text: 'siffle' }, NINA, kn);
    const a = addReply(base, 'je regarde', MAX, km);
    const b = setStatus(base, 'resolved', NINA, kn);
    const c = setArchived(base, true, km);
    const s = (x: TimelineComment) => commentSig(x);
    expect(s(mergeComment(a, b))).toBe(s(mergeComment(b, a)));
    expect(s(mergeComment(mergeComment(a, b), c))).toBe(s(mergeComment(a, mergeComment(b, c))));
    expect(s(mergeComment(a, a))).toBe(s(a));
    const all = mergeComment(mergeComment(a, b), c);
    expect(all.replies).toHaveLength(1);
    expect(all.status.v.s).toBe('resolved');
    expect(all.archived.v).toBe(true);
  });

  it('saisie simultanée (même milliseconde) : les deux finissent avec le même état', () => {
    const n = clockAt(NINA.key, 5000), m = clockAt(MAX.key, 5000);
    const shared = createComment({ id: 'c1', time: 10, text: 'trop fort' }, NINA, n.c);
    // Les deux répondent ET changent le statut au même instant, sans s'être vus.
    const atNina = setStatus(addReply(shared, 'ok pour moi', NINA, n.c), 'resolved', NINA, n.c);
    const atMax = setStatus(addReply(shared, 'je baisse de 2 dB', MAX, m.c), 'open', MAX, m.c);
    const newNina = createComment({ id: 'n2', time: 20, text: 'souffle' }, NINA, n.c);
    const newMax = createComment({ id: 'm2', time: 20, text: 'clic' }, MAX, m.c);
    const nina = mergeComments(mergeComments([shared], [atNina, newNina]).list, [atMax, newMax]).list;
    const max = mergeComments(mergeComments([shared], [atMax, newMax]).list, [atNina, newNina]).list;
    expect(sig(nina)).toBe(sig(max));
    expect(nina).toHaveLength(3);
    expect(nina.find(c => c.id === 'c1')!.replies).toHaveLength(2);
  });

  it('3 personnes, 300 gestes au hasard, livraison dans le désordre avec doublons et coupure réseau : même état partout', () => {
    for (const seed of [1, 7, 42, 2026, 31337]) {
      const r = rng(seed);
      const who = [NINA, MAX, { key: 'u:leo', name: 'Léo', role: 'beatmaker' as const }];
      const clocks = who.map((w, i) => clockAt(w.key, 1000 + i));
      const replicas: TimelineComment[][] = who.map(() => []);
      const sent: TimelineComment[] = [];
      for (let step = 0; step < 300; step++) {
        const i = Math.floor(r() * 3);
        clocks[i].set(1000 + Math.floor(step / 3)); // heures très proches : beaucoup d'égalités
        const mine = replicas[i];
        let next: TimelineComment;
        if (!mine.length || r() < 0.25) next = createComment({ id: `c${seed}-${step}`, time: Math.floor(r() * 180), text: `note ${step}` }, who[i], clocks[i].c);
        else {
          const c = mine[Math.floor(r() * mine.length)];
          const x = r();
          next = x < 0.35 ? addReply(c, `réponse ${step}`, who[i], clocks[i].c, `r${seed}-${step}`)
            : x < 0.6 ? setStatus(c, r() < 0.5 ? 'resolved' : 'open', who[i], clocks[i].c)
              : x < 0.8 ? setArchived(c, r() < 0.5, clocks[i].c)
                : c.authorKey === who[i].key ? editText(c, `modifié ${step}`, clocks[i].c) : setStatus(c, 'resolved', who[i], clocks[i].c);
        }
        replicas[i] = mergeComments(mine, [next]).list;
        // Une partie arrive tout de suite chez les autres (le direct), le reste plus tard (rattrapage).
        sent.push(next);
        for (let j = 0; j < 3; j++) if (j !== i && r() < 0.5) { const inc = readCommentsOp({ upsert: [JSON.parse(JSON.stringify(next))] }); replicas[j] = mergeComments(replicas[j], inc).list; clocks[j].c.observe(next.text.s); }
      }
      // Retour du réseau : tout le journal, dans le désordre, avec des doublons.
      for (let j = 0; j < 3; j++) {
        const journal = shuffle([...sent, ...sent.filter(() => r() < 0.3)], r);
        for (let k = 0; k < journal.length; k += 7) replicas[j] = mergeComments(replicas[j], readCommentsOp({ upsert: journal.slice(k, k + 7) })).list;
      }
      expect(sig(replicas[0])).toBe(sig(replicas[1]));
      expect(sig(replicas[1])).toBe(sig(replicas[2]));
    }
  });

  it('hors ligne : les gestes faits pendant la coupure arrivent ensuite et convergent', () => {
    const n = clockAt(NINA.key, 1000), m = clockAt(MAX.key, 1000);
    const c = createComment({ id: 'c1', time: 72, text: 'siffle' }, NINA, n.c);
    let nina = [c], max = [c];
    // Nina hors ligne : elle répond puis archive ; Max, lui, résout (en ligne).
    n.set(2000); const n1 = addReply(c, 'toujours là', NINA, n.c);
    const n2 = setArchived(n1, true, n.c);
    nina = mergeComments(nina, [n1, n2]).list;
    m.set(1500); const m1 = setStatus(c, 'resolved', MAX, m.c);
    max = mergeComments(max, [m1]).list;
    // Retour : chacun reçoit l'autre (Nina ne reçoit que maintenant la résolution de Max).
    nina = mergeComments(nina, [m1]).list;
    max = mergeComments(max, [n2, n1]).list;
    expect(sig(nina)).toBe(sig(max));
    expect(max[0]).toMatchObject({ archived: { v: true } });
    expect(max[0].status.v.s).toBe('resolved');
    expect(max[0].replies.map(r => r.text.v)).toEqual(['toujours là']);
  });
});

describe('chantier 11 · réception (vérification, droits)', () => {
  it('opération illisible ou incomplète : ignorée', () => {
    expect(readCommentsOp(null)).toEqual([]);
    expect(readCommentsOp({ upsert: [{ id: 'x' }, 5, null] })).toEqual([]);
    expect(sanitizeComment({ id: 'x', authorKey: 'u:a', createdAt: 1, pos: { v: { t: -3, end: null }, s: { t: 1, c: 0, by: 'u:a' } } })).toBeNull();
  });
  it('texte trop long coupé ; position plafonnée', () => {
    const c = createComment({ time: 1, text: 'a' }, NINA, clockAt(NINA.key).c);
    const raw = JSON.parse(JSON.stringify(c));
    raw.text.v = 'b'.repeat(5000);
    expect(readCommentsOp({ upsert: [raw] })[0].text.v).toHaveLength(1000);
  });
  it('les mots d’un commentaire ne changent que par son auteur (règle identique chez tous)', () => {
    const n = clockAt(NINA.key).c;
    const c = createComment({ id: 'c1', time: 72, text: 'siffle' }, NINA, n);
    const forged = editText(c, 'tout va bien', clockAt(MAX.key, 9_999_999).c); // horodaté par Max
    const [got] = readCommentsOp({ upsert: [forged] });
    expect(mergeComment(c, got).text.v).toBe('siffle');
    expect(commentSig(enforceAuthorship(got))).toBe(commentSig(got));
    // L'auteur, lui, peut corriger.
    const fixed = editText(c, 'le s siffle à 1:12', n);
    expect(mergeComment(c, readCommentsOp({ upsert: [fixed] })[0]).text.v).toBe('le s siffle à 1:12');
  });
  it('n’importe quel participant (invité compris) résout et répond', () => {
    const c = createComment({ id: 'c1', time: 72, text: 'siffle' }, MAX, clockAt(MAX.key).c);
    const byGuest = setStatus(addReply(c, 'vu', NINA, clockAt(NINA.key, 2e6).c), 'resolved', NINA, clockAt(NINA.key, 2e6 + 5).c);
    const m = mergeComment(c, readCommentsOp({ upsert: [byGuest] })[0]);
    expect(m.status.v.s).toBe('resolved');
    expect(m.replies[0].text.v).toBe('vu');
  });
});
