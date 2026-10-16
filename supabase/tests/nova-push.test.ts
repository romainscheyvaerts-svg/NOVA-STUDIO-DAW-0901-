/**
 * Lot 7 · fonction serveur nova-push chargée TELLE QUELLE (code Deno) avec le faux Supabase
 * (supabase/tests/fakes) et un faux service d'envoi (fetch). Rien ne part sur le réseau.
 *
 * Ce qui est prouvé :
 *  - « config » : la clé publique, ou null sans clé (NOVA cache alors la fonction) ;
 *  - « drain » : un commentaire posé par Nina → boîte de réception + Web Push chez Max (propriétaire),
 *    PAS chez Nina (sa propre action), chiffré pour l'abonnement de Max ;
 *  - l'opération rejouée (file, reconnexion) ne renotifie pas ; un type coupé ou tout coupé : rien ;
 *  - abonnement mort (410) retiré ; sans clé VAPID : boîte remplie (appli Windows), aucun envoi push ;
 *  - « test » : compte exigé, 1 essai / 30 s.
 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, setCurrentDb, type FakeDb } from './fakes/supabase';
import { lastHandler } from './fakes/denoServe';
import { b64urlEncode } from '../functions/nova-push/webPush';
import { HybridClock, createComment } from '../../utils/timelineComments';

const ENV: Record<string, string> = { SUPABASE_URL: 'http://fake.local', SUPABASE_SERVICE_ROLE_KEY: 'service' };
(globalThis as any).Deno = { env: { get: (k: string) => ENV[k] } };

type Handler = (req: Request) => Promise<Response> | Response;
let fn: Handler;
beforeAll(async () => {
  await import('../functions/nova-push/index.ts');
  fn = lastHandler();
});

const NINA = '11111111-1111-4111-8111-111111111111';
const MAX = '22222222-2222-4222-8222-222222222222';
const SID = 'abcdefgh1234';
const ninaKey = `u:${NINA}:tel`;

let db: FakeDb;
let pushes: { url: string; headers: Record<string, string> }[];
let pushStatus: number;
let seq = 0;

async function testVapid() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  ENV.VAPID_PUBLIC_KEY = b64urlEncode(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey)));
  ENV.VAPID_PRIVATE_KEY = (await webcrypto.subtle.exportKey('jwk', kp.privateKey)).d as string;
}
async function browserSub(endpoint: string) {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  return { endpoint, p256dh: b64urlEncode(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey))), auth: b64urlEncode(webcrypto.getRandomValues(new Uint8Array(16))) };
}

beforeEach(async () => {
  db = createFakeDb();
  db.users['jwt.max.ok'] = { id: MAX, email: 'max@example.com' };
  db.tables.daw_sessions = [{ id: SID, name: 'Freestyle Nina', secret: 'S3cr3tS3cr3tS3cr3tS3cr3tS3', owner_id: MAX }];
  db.tables.daw_session_members = [
    { session_id: SID, member_key: ninaKey, user_id: NINA, role: 'artist' },
    { session_id: SID, member_key: `u:${MAX}:pc`, user_id: MAX, role: 'engineer' },
  ];
  db.tables.nova_notify_events = [];
  db.tables.nova_notifications = [];
  db.tables.nova_notify_prefs = [
    { user_id: MAX, enabled: true, comments: true, versions: true, invites: true, takes: true },
    { user_id: NINA, enabled: true, comments: true, versions: true, invites: true, takes: true },
  ];
  db.tables.nova_push_subscriptions = [
    { id: 's-max', user_id: MAX, ...(await browserSub('https://fcm.googleapis.com/fcm/send/max-pc')), fail_count: 0 },
    { id: 's-nina', user_id: NINA, ...(await browserSub('https://web.push.apple.com/nina-iphone')), fail_count: 0 },
  ];
  // Comme nova_notify_claim (SQL) : prend les événements en attente, une seule fois.
  db.rpc.nova_notify_claim = () => {
    const pending = db.tables.nova_notify_events.filter(e => !e.processed_at);
    pending.forEach(e => { e.processed_at = new Date().toISOString(); e.attempts = (e.attempts || 0) + 1; });
    return structuredClone(pending);
  };
  setCurrentDb(db);
  await testVapid();
  pushes = [];
  pushStatus = 201;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    pushes.push({ url: String(url), headers: init.headers as Record<string, string> });
    return new Response(null, { status: pushStatus });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function call(body: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: 'https://nova-studio-daw-0901.vercel.app' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fn(new Request('http://fn.local/', { method: 'POST', headers, body: JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

/** Ce que pose le trigger SQL nova_notify_on_op pour une opération « comments ». */
function commentEvent(text = 'le "s" siffle', at = 72) {
  const c = createComment({ time: at, text }, { key: ninaKey, name: 'Nina' }, new HybridClock(ninaKey));
  db.tables.nova_notify_events.push({
    id: ++seq, source: 'op', session_id: SID, actor_key: ninaKey, actor_name: 'Nina', kind: 'comments',
    payload: { seq: seq, role: 'artist', op: { upsert: [c] } }, created_at: new Date().toISOString(), processed_at: null, attempts: 0,
  });
  return c;
}

describe('nova-push : config', () => {
  it('clé publique quand elle est posée ; null sinon (fonction cachée dans NOVA)', async () => {
    const r = await call({ action: 'config' });
    expect(r.status).toBe(200);
    expect(r.json.public_key).toBe(ENV.VAPID_PUBLIC_KEY);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://nova-studio-daw-0901.vercel.app');
    delete ENV.VAPID_PUBLIC_KEY;
    expect((await call({ action: 'config' })).json).toEqual({ public_key: null });
  });

  it('action inconnue : 400 ; GET : 405', async () => {
    expect((await call({ action: 'xxx' })).status).toBe(400);
    const res = await fn(new Request('http://fn.local/', { method: 'GET' }));
    expect(res.status).toBe(405);
  });
});

describe('nova-push : drain', () => {
  it('commentaire de Nina → Max prévenu (boîte + push chiffré), Nina jamais pour sa propre action', async () => {
    const c = commentEvent();
    const r = await call({ action: 'drain' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ events: 1, notifications: 1, pushed: 1 });
    const rows = db.tables.nova_notifications;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: MAX, type: 'comment', dedup_key: `c:${SID}:${c.id}`, session_id: SID, title: '💬 Nina a commenté à 1:12' });
    expect(rows[0].url).toContain(`nova_c=${c.id}`);
    expect(rows[0].pushed_at).toBeTruthy();
    expect(pushes.map(p => p.url)).toEqual(['https://fcm.googleapis.com/fcm/send/max-pc']);
    expect(pushes[0].headers['Content-Encoding']).toBe('aes128gcm');
    expect(pushes[0].headers.Authorization).toMatch(/^vapid t=/);
    expect(pushes[0].headers.Urgency).toBe('high');
  });

  it('opération rejouée (même commentaire) : aucune 2e notification', async () => {
    const c = commentEvent();
    await call({ action: 'drain' });
    db.tables.nova_notify_events.push({ ...structuredClone(db.tables.nova_notify_events[0]), id: ++seq, processed_at: null });
    expect(db.tables.nova_notify_events[1].payload.op.upsert[0].id).toBe(c.id);
    const r = await call({ action: 'drain' });
    expect(r.json).toMatchObject({ events: 1, notifications: 0, pushed: 0 });
    expect(db.tables.nova_notifications).toHaveLength(1);
    expect(pushes).toHaveLength(1);
  });

  it('type coupé, tout coupé, ou jamais activé : rien', async () => {
    db.tables.nova_notify_prefs[0].comments = false;
    commentEvent();
    expect((await call({ action: 'drain' })).json.notifications).toBe(0);
    db.tables.nova_notify_prefs[0] = { user_id: MAX, enabled: false, comments: true, versions: true, invites: true, takes: true };
    commentEvent('deux');
    expect((await call({ action: 'drain' })).json.notifications).toBe(0);
    db.tables.nova_notify_prefs = [];
    commentEvent('trois');
    expect((await call({ action: 'drain' })).json.notifications).toBe(0);
    expect(pushes).toHaveLength(0);
  });

  it('abonnement mort (410) retiré ; échecs répétés comptés', async () => {
    pushStatus = 410;
    commentEvent();
    await call({ action: 'drain' });
    expect(db.tables.nova_push_subscriptions.map((s: any) => s.id)).toEqual(['s-nina']);
    pushStatus = 500;
    db.tables.nova_push_subscriptions.push({ id: 's-max2', user_id: MAX, ...(await browserSub('https://fcm.googleapis.com/fcm/send/max-2')), fail_count: 0 });
    commentEvent('encore');
    await call({ action: 'drain' });
    expect(db.tables.nova_push_subscriptions.find((s: any) => s.id === 's-max2').fail_count).toBe(1);
  });

  it('sans clé VAPID : la boîte est remplie (appli Windows), aucun envoi push', async () => {
    delete ENV.VAPID_PRIVATE_KEY;
    commentEvent();
    const r = await call({ action: 'drain' });
    expect(r.json).toMatchObject({ notifications: 1, pushed: 0 });
    expect(pushes).toHaveLength(0);
  });

  it('séance supprimée ou rien de neuf : ignoré sans erreur ; file vide : rien', async () => {
    db.tables.nova_notify_events.push({ id: ++seq, source: 'op', session_id: 'inconnue0000', actor_key: ninaKey, actor_name: 'Nina', kind: 'comments', payload: { op: { upsert: [] } }, processed_at: null });
    expect((await call({ action: 'drain' })).json).toMatchObject({ events: 1, skipped: 1, notifications: 0 });
    expect((await call({ action: 'drain' })).json).toMatchObject({ events: 0 });
  });

  it('quelqu’un rejoint : l’hôte prévenu ; la séance donnée par le studio : seul le destinataire', async () => {
    db.tables.nova_notify_events.push({ id: ++seq, source: 'member', session_id: SID, actor_key: ninaKey, actor_name: 'Nina', kind: 'join', payload: { role: 'artist', user_id: NINA }, processed_at: null });
    db.tables.nova_notify_events.push({ id: ++seq, source: 'assign', session_id: SID, actor_key: '', actor_name: '', kind: 'assign', payload: { recipient: NINA }, processed_at: null });
    await call({ action: 'drain' });
    const rows = db.tables.nova_notifications.map((r: any) => [r.user_id, r.type, r.title]);
    expect(rows).toEqual([[MAX, 'invite', '👥 Nina a rejoint « Freestyle Nina »'], [NINA, 'invite', '🎁 Une séance t’attend']]);
  });
});

describe('nova-push : essai', () => {
  it('compte exigé ; envoie sur ses appareils ; 1 essai / 30 s', async () => {
    expect((await call({ action: 'test' })).status).toBe(401);
    const r = await call({ action: 'test' }, 'jwt.max.ok');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ sent: 1 });
    expect(pushes.map(p => p.url)).toEqual(['https://fcm.googleapis.com/fcm/send/max-pc']);
    const again = await call({ action: 'test' }, 'jwt.max.ok');
    expect(again.status).toBe(429);
    expect(again.json.error).toMatch(/30 secondes/);
  });
});
