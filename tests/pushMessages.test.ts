/**
 * Lot 7 · Notifications : ce que dit chaque notification et à qui elle part
 * (supabase/functions/nova-push/messages.ts, module pur du serveur).
 */
import { describe, expect, it } from 'vitest';
import {
  FRESH_MS, fmtTime, messagesForEvent, prefAllows, pushPayload, recipientsFor, sessionPath, userOfMemberKey,
  type NotifyEvent, type SessionInfo,
} from '../supabase/functions/nova-push/messages';
import { HybridClock, addReply, createComment } from '../utils/timelineComments';
import { createVersion, decide } from '../utils/mixVersions';

const NINA = '11111111-1111-4111-8111-111111111111';
const MAX = '22222222-2222-4222-8222-222222222222';
const LEA = '33333333-3333-4333-8333-333333333333';
const NOW = 1_760_000_000_000;
const ninaKey = `u:${NINA}:tel`;
const maxKey = `u:${MAX}:pc`;

const S: SessionInfo = { id: 'abcdefgh1234', name: 'Freestyle Nina', secret: 'S3cr3tS3cr3tS3cr3tS3cr3tS3', owner_id: MAX };

const ev = (over: Partial<NotifyEvent>): NotifyEvent => ({
  id: 1, source: 'op', session_id: S.id, actor_key: ninaKey, actor_name: 'Nina', kind: 'comments', payload: {}, created_at: new Date(NOW).toISOString(), ...over,
});

const clockAt = (key: string, t = NOW) => new HybridClock(key, () => t);
const comment = (text: string, time: number, key = ninaKey, at = NOW) =>
  ({ ...createComment({ time, text }, { key, name: key === ninaKey ? 'Nina' : 'Max' }, clockAt(key, at)), createdAt: at });

describe('messages : commentaires', () => {
  it('nouveau commentaire → « Nina a commenté à 1:12 », texte, séance, ouverture à l’instant', () => {
    const c = comment('le "s" siffle', 72);
    const [m, ...rest] = messagesForEvent(ev({ payload: { op: { upsert: [c] } } }), S, NOW + 1000);
    expect(rest).toEqual([]);
    expect(m.type).toBe('comment');
    expect(m.title).toBe('💬 Nina a commenté à 1:12');
    expect(m.body).toBe('« le "s" siffle » · « Freestyle Nina »');
    expect(m.dedup).toBe(`c:${S.id}:${c.id}`);
    expect(m.commentId).toBe(c.id);
    expect(m.at).toBe(72);
    const q = new URLSearchParams(m.path.slice(2));
    expect(m.path.startsWith('/?')).toBe(true);
    expect(q.get('session')).toBe(`${S.id}.${S.secret}`);
    expect(q.get('nova_s')).toBe(S.id);
    expect(q.get('nova_c')).toBe(c.id);
    expect(q.get('nova_at')).toBe('72');
  });

  it('un commentaire ancien renvoyé (file rejouée, modification) ne renotifie pas', () => {
    const c = comment('vieux', 10, ninaKey, NOW - FRESH_MS - 1000);
    expect(messagesForEvent(ev({ payload: { op: { upsert: [c] } } }), S, NOW)).toEqual([]);
  });

  it('le commentaire d’un AUTRE relayé par Nina : pas au nom de Nina', () => {
    const c = comment('de Max', 5, maxKey);
    expect(messagesForEvent(ev({ payload: { op: { upsert: [c] } } }), S, NOW)).toEqual([]);
  });

  it('texte non horodaté par son auteur (falsifié) : ignoré', () => {
    const c = comment('vrai', 5);
    const forged = { ...c, text: { v: 'faux', s: { t: NOW, c: 0, by: maxKey } } };
    expect(messagesForEvent(ev({ payload: { op: { upsert: [forged] } } }), S, NOW)).toEqual([]);
  });

  it('commentaire archivé ou vide : rien', () => {
    const c = comment('x', 5);
    expect(messagesForEvent(ev({ payload: { op: { upsert: [{ ...c, archived: { v: true, s: c.archived.s } }] } } }), S, NOW)).toEqual([]);
    expect(messagesForEvent(ev({ payload: { op: { upsert: [{ ...c, text: { ...c.text, v: '   ' } }] } } }), S, NOW)).toEqual([]);
  });

  it('nouvelle réponse : une notification par réponse, au même commentaire', () => {
    const c = comment('trop de reverb', 95, maxKey, NOW - 3600_000);
    const withReply = addReply(c, 'ok je baisse', { key: ninaKey, name: 'Nina' }, clockAt(ninaKey))!;
    const replies = withReply.replies.map(r => ({ ...r, createdAt: NOW }));
    const msgs = messagesForEvent(ev({ payload: { op: { upsert: [{ ...withReply, replies }] } } }), S, NOW);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].title).toBe('↩️ Nina a répondu (1:35)');
    expect(msgs[0].body).toContain('« ok je baisse »');
    expect(msgs[0].dedup).toBe(`r:${S.id}:${replies[0].id}`);
    expect(msgs[0].commentId).toBe(c.id);
  });

  it('opération illisible : aucun plantage, rien', () => {
    for (const op of [null, 'texte', { upsert: 'x' }, { upsert: [null, 3, { id: 5 }] }]) {
      expect(messagesForEvent(ev({ payload: { op } }), S, NOW)).toEqual([]);
    }
  });

  it('textes coupés proprement (titre ≤ 80, corps ≤ 180)', () => {
    const c = comment('a'.repeat(900), 3);
    const [m] = messagesForEvent(ev({ actor_name: 'N'.repeat(200), payload: { op: { upsert: [c] } } }), S, NOW);
    expect(m.title.length).toBeLessThanOrEqual(80);
    expect(m.body.length).toBeLessThanOrEqual(180);
    expect(m.body).toContain('…');
  });
});

describe('messages : versions', () => {
  it('version envoyée par l’ingé → « Max t’envoie la version 3 »', () => {
    const v = createVersion({ n: 3, audio: { bufferId: 'b', parts: ['a'.repeat(40)], size: 10, duration: 60 } }, { key: maxKey, name: 'Max' }, clockAt(maxKey));
    const [m] = messagesForEvent(ev({ kind: 'mixver', actor_key: maxKey, actor_name: 'Max', payload: { op: { upsert: [v] } } }), S, NOW);
    expect(m.type).toBe('version');
    expect(m.title).toBe('📨 Max t’envoie la version 3');
    expect(m.body).toMatch(/^Écoute-la et dis si elle est validée/);
    expect(m.versionId).toBe(v.id);
    expect(m.dedup).toBe(`v:${S.id}:${v.id}`);
    expect(new URLSearchParams(m.path.slice(2)).get('nova_v')).toBe(v.id);
  });

  it('nom personnalisé affiché, nom par défaut non répété', () => {
    const v = createVersion({ n: 2, name: 'Radio edit' }, { key: maxKey, name: 'Max' }, clockAt(maxKey));
    const [m] = messagesForEvent(ev({ kind: 'mixver', actor_key: maxKey, payload: { op: { upsert: [v] } } }), S, NOW);
    expect(m.title).toContain('la version 2 (« Radio edit »)');
    expect(m.body).toMatch(/^Ouvre la séance/);
  });

  it('validée / retouches par l’artiste, avec son commentaire', () => {
    const v = createVersion({ n: 2 }, { key: maxKey, name: 'Max' }, clockAt(maxKey, NOW - 3600_000));
    const ok = decide(v, 'approved', { key: ninaKey, name: 'Nina' }, clockAt(ninaKey));
    const [a] = messagesForEvent(ev({ kind: 'mixver', payload: { op: { upsert: [ok] } } }), S, NOW);
    expect(a.title).toBe('✅ Nina a validé la version 2');
    const ch = decide(v, 'changes', { key: ninaKey, name: 'Nina' }, clockAt(ninaKey), 'la voix trop basse');
    const [b] = messagesForEvent(ev({ kind: 'mixver', payload: { op: { upsert: [ch] } } }), S, NOW);
    expect(b.title).toBe('✏️ Nina demande des retouches sur la version 2');
    expect(b.body).toContain('« la voix trop basse »');
    expect(a.dedup).not.toBe(`v:${S.id}:${v.id}`);
  });

  it('décision falsifiée (horodatée par un autre) : rien', () => {
    const v = createVersion({ n: 2 }, { key: maxKey, name: 'Max' }, clockAt(maxKey, NOW - 3600_000));
    const ok = decide(v, 'approved', { key: ninaKey, name: 'Nina' }, clockAt(ninaKey));
    const forged = { ...ok, decision: { ...ok.decision, s: { ...ok.decision.s, by: maxKey } } };
    expect(messagesForEvent(ev({ kind: 'mixver', payload: { op: { upsert: [forged] } } }), S, NOW)).toEqual([]);
  });
});

describe('messages : prises, invitations', () => {
  it('prise reçue (fin de prise) avec sa durée ; annulée : rien', () => {
    const op = { _id: 'lt:t1:end', t: 't1', trackId: 'tr', n: 4, from: 0, frames: 48000 * 42, ch: 1, sr: 48000, sum: 'x' };
    const [m] = messagesForEvent(ev({ kind: 'take_end', payload: { op } }), S, NOW);
    expect(m.type).toBe('take');
    expect(m.title).toBe('🎙️ Nina t’a envoyé une prise');
    expect(m.body).toBe('Prise de 0:42, déjà rangée dans « Freestyle Nina ». Touche pour l’écouter.');
    expect(m.dedup).toBe(`t:${S.id}:t1`);
    expect(messagesForEvent(ev({ kind: 'take_end', payload: { op: { ...op, cancel: true } } }), S, NOW)).toEqual([]);
  });

  it('quelqu’un rejoint la séance', () => {
    const [m] = messagesForEvent(ev({ source: 'member', kind: 'join', payload: { role: 'engineer', user_id: NINA } }), S, NOW);
    expect(m.type).toBe('invite');
    expect(m.title).toBe('👥 Nina a rejoint « Freestyle Nina »');
    expect(m.body).toBe('Rôle : ingé son. Touche pour ouvrir la séance.');
    expect(m.dedup).toBe(`j:${S.id}:${NINA}`);
  });

  it('séance donnée par le studio → « Une séance t’attend », au seul destinataire', () => {
    const e = ev({ source: 'assign', kind: 'assign', actor_key: '', actor_name: '', payload: { recipient: LEA } });
    const [m] = messagesForEvent(e, { ...S, owner_id: LEA }, NOW);
    expect(m.title).toBe('🎁 Une séance t’attend');
    expect(m.body).toContain('« Freestyle Nina »');
    expect(recipientsFor(e, { ...S, owner_id: LEA }, [NINA, MAX])).toEqual([LEA]);
  });

  it('séance sans nom : « ta séance »', () => {
    const [m] = messagesForEvent(ev({ source: 'member', kind: 'join', payload: { role: 'artist' } }), { ...S, name: 'Session' }, NOW);
    expect(m.title).toBe('👥 Nina a rejoint ta séance');
  });
});

describe('destinataires et réglages', () => {
  it('le propriétaire et les membres connectés, JAMAIS l’auteur, sans doublon', () => {
    expect(recipientsFor(ev({}), S, [NINA, LEA, LEA, null, 'pas-un-compte']).sort()).toEqual([LEA, MAX].sort());
    // L'auteur sur un AUTRE appareil (même compte) n'est pas prévenu non plus.
    expect(recipientsFor(ev({ actor_key: `u:${MAX}:tablette` }), S, [NINA, MAX])).toEqual([NINA]);
    // Membre qui rejoint : la clé de l'appareil ou user_id.
    expect(recipientsFor(ev({ source: 'member', actor_key: `u:${LEA}:tel`, payload: { user_id: LEA } }), S, [NINA, LEA])).toEqual([MAX, NINA]);
  });

  it('clé de participant → compte', () => {
    expect(userOfMemberKey(`u:${NINA}`)).toBe(NINA);
    expect(userOfMemberKey(`u:${NINA.toUpperCase()}:pc`)).toBe(NINA);
    expect(userOfMemberKey('d:appareil')).toBeNull();
    expect(userOfMemberKey(42)).toBeNull();
  });

  it('pas de réglages = jamais activées ; interrupteur général ; par type', () => {
    expect(prefAllows(null, 'comment')).toBe(false);
    expect(prefAllows({ enabled: false, comments: true }, 'comment')).toBe(false);
    const p = { enabled: true, comments: true, versions: false, invites: true, takes: false };
    expect(prefAllows(p, 'comment')).toBe(true);
    expect(prefAllows(p, 'version')).toBe(false);
    expect(prefAllows(p, 'invite')).toBe(true);
    expect(prefAllows(p, 'take')).toBe(false);
  });
});

describe('format', () => {
  it('instant lisible', () => {
    expect(fmtTime(72)).toBe('1:12');
    expect(fmtTime(3723.9)).toBe('1:02:03');
    expect(fmtTime(-3)).toBe('0:00');
    expect(fmtTime(NaN)).toBe('0:00');
  });

  it('chemin sans secret si la séance n’en a pas ; instant arrondi', () => {
    const p = sessionPath({ ...S, secret: null }, { c: 'cm-1', at: 12.34567 });
    const q = new URLSearchParams(p.slice(2));
    expect(q.has('session')).toBe(false);
    expect(q.get('nova_at')).toBe('12.346');
  });

  it('contenu envoyé au navigateur : petit, chemin relatif, champs utiles', () => {
    const c = comment('x'.repeat(500), 72);
    const [m] = messagesForEvent(ev({ payload: { op: { upsert: [c] } } }), S, NOW);
    const raw = pushPayload({ ...m, id: 9 });
    expect(raw.length).toBeLessThan(1500);
    const d = JSON.parse(raw);
    expect(d).toMatchObject({ v: 1, type: 'comment', s: S.id, c: c.id, at: 72, id: 9 });
    expect(d.url.startsWith('/?')).toBe(true);
  });
});
