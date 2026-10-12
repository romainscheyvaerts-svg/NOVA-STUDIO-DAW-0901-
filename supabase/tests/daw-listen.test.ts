/**
 * Tests de la fonction serveur daw-listen (lien d'écoute client sans compte),
 * chargée TELLE QUELLE (code Deno) avec le faux Supabase de supabase/tests/fakes.
 * Rien ne part sur le réseau, aucune base réelle n'est touchée.
 *
 * Ce qui est prouvé :
 *  - jeton aléatoire (32 caractères, ≈ 2^186), seul son hachage sert à la recherche ;
 *  - expiration (410 « expiré »), révocation (410 « désactivé »), message clair ;
 *  - mot de passe facultatif (PBKDF2), blocage après 8 essais ;
 *  - LECTURE SEULE : toute action d'écriture avec le jeton est refusée (403),
 *    et daw-session refuse le jeton comme secret de séance (404), sans rien écrire ;
 *  - contenu choisi par l'ingé (direct / versions / commentaires) respecté ;
 *  - commentaires et versions : vue publique fusionnée, sans données internes.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDb, setCurrentDb, type FakeDb } from './fakes/supabase';
import { lastHandler } from './fakes/denoServe';
import { collectReview, publicComments, publicVersions } from '../functions/daw-listen/review';

(globalThis as any).Deno = { env: { get: (k: string) => ({ SUPABASE_URL: 'http://fake.local', SUPABASE_SERVICE_ROLE_KEY: 'service' } as Record<string, string>)[k] } };

type Handler = (req: Request) => Promise<Response> | Response;
let dawSession: Handler;
let dawListen: Handler;

beforeAll(async () => {
  await import('../functions/daw-session/index.ts');
  dawSession = lastHandler();
  await import('../functions/daw-listen/index.ts');
  dawListen = lastHandler();
});

let db: FakeDb;
beforeEach(() => {
  db = createFakeDb();
  db.users['jwt.inge.ok'] = { id: 'u-inge', email: 'inge@example.com' };
  db.users['jwt.autre.ok'] = { id: 'u-autre', email: 'autre@example.com' };
  setCurrentDb(db);
});

const NOVA = 'https://nova-studio-daw-0901.vercel.app';
async function call(h: Handler, body: unknown, opts: { token?: string; origin?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: opts.origin ?? NOVA };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await h(new Request('http://fn.local/', { method: opts.method || 'POST', headers, body: opts.method && opts.method !== 'POST' ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}
const INGE = { token: 'jwt.inge.ok' };

async function newSession(name = 'Séance de Nina') {
  const c = await call(dawSession, { action: 'create', name }, { token: 'jwt.autre.ok' }); // séance de l'artiste (propriétaire), l'ingé a le lien
  expect(c.status).toBe(200);
  return c.json as { id: string; secret: string };
}
async function newLink(s: { id: string; secret: string }, extra: Record<string, unknown> = {}) {
  const r = await call(dawListen, { action: 'listen_create', id: s.id, secret: s.secret, ttl_hours: 24, live: true, versions: true, comments: true, label: 'Label Nina', ...extra }, INGE);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.link as { id: string; token: string; channel: string; expires_at: string; has_password: boolean };
}
const open = (token: string, extra: Record<string, unknown> = {}) => call(dawListen, { action: 'listen_open', token, ...extra });

describe('daw-listen · création (côté ingé)', () => {
  it('CORS : origine NOVA acceptée, origine inconnue renvoyée vers NOVA ; POST uniquement ; pas de cache', async () => {
    const ok = await call(dawListen, null, { method: 'OPTIONS' });
    expect(ok.headers.get('access-control-allow-origin')).toBe(NOVA);
    const evil = await call(dawListen, null, { method: 'OPTIONS', origin: 'https://evil.example' });
    expect(evil.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
    expect((await call(dawListen, null, { method: 'GET' })).status).toBe(405);
    expect((await open('x'.repeat(32))).headers.get('cache-control')).toBe('no-store');
  });

  it('compte exigé (401) et lien de séance exigé (404) pour créer, lister, révoquer', async () => {
    const s = await newSession();
    for (const action of ['listen_create', 'listen_list', 'listen_revoke']) {
      expect((await call(dawListen, { action, id: s.id, secret: s.secret, ttl_hours: 24 })).status).toBe(401);
      expect((await call(dawListen, { action, id: s.id, secret: 'y'.repeat(32), ttl_hours: 24 }, INGE)).status).toBe(404);
    }
    expect(db.tables.daw_listen_links || []).toHaveLength(0);
  });

  it('réglages validés : durée 24 h / 7 j / 30 j, au moins un contenu, mot de passe de 4 à 64 caractères', async () => {
    const s = await newSession();
    const base = { action: 'listen_create', id: s.id, secret: s.secret };
    expect((await call(dawListen, { ...base, ttl_hours: 48 }, INGE)).status).toBe(400);
    expect((await call(dawListen, { ...base, ttl_hours: 24, live: false, versions: false, comments: false }, INGE)).json.error).toMatch(/au moins une chose/);
    expect((await call(dawListen, { ...base, ttl_hours: 24, password: 'abc' }, INGE)).json.error).toMatch(/4 à 64/);
    for (const [ttl, h] of [[24, 24], [168, 168], [720, 720]]) {
      const t0 = Date.now();
      const l = await newLink(s, { ttl_hours: ttl });
      const ms = Date.parse(l.expires_at) - t0;
      expect(ms).toBeGreaterThan(h * 3600_000 - 5000);
      expect(ms).toBeLessThan(h * 3600_000 + 5000);
    }
  });

  it('jeton aléatoire de 32 caractères, tous différents ; recherche par empreinte SHA-256 ; mot de passe en PBKDF2', async () => {
    const s = await newSession();
    const tokens = new Set<string>();
    for (let i = 0; i < 15; i++) tokens.add((await newLink(s)).token);
    expect(tokens.size).toBe(15);
    for (const t of tokens) expect(t).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{32}$/);
    const row = db.tables.daw_listen_links[0];
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.token_hash).not.toContain(row.token);
    expect(row.id).toMatch(/^[a-z0-9]{16}$/);
    const withPw = await newLink(s, { password: 'nina2026' });
    expect(withPw.has_password).toBe(true);
    const pwRow = db.tables.daw_listen_links.find((r: any) => r.id === withPw.id);
    expect(pwRow.password_hash).toMatch(/^pbkdf2\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
    expect(pwRow.password_hash).not.toContain('nina2026');
  });

  it('20 liens actifs au plus par séance (409), un lien révoqué libère une place', async () => {
    const s = await newSession();
    const links = [];
    for (let i = 0; i < 20; i++) links.push(await newLink(s, { live: false, versions: true, comments: false }));
    const over = await call(dawListen, { action: 'listen_create', id: s.id, secret: s.secret, ttl_hours: 24 }, INGE);
    expect(over.status).toBe(409);
    await call(dawListen, { action: 'listen_revoke', id: s.id, secret: s.secret, link_id: links[0].id }, INGE);
    await newLink(s);
  });
});

describe('daw-listen · liste et révocation', () => {
  it('la liste ne montre que les liens actifs (ni révoqués, ni expirés), avec de quoi recopier le lien', async () => {
    const s = await newSession();
    const a = await newLink(s, { label: 'Manager' });
    const b = await newLink(s);
    const c = await newLink(s);
    await call(dawListen, { action: 'listen_revoke', id: s.id, secret: s.secret, link_id: b.id }, INGE);
    db.tables.daw_listen_links.find((r: any) => r.id === c.id).expires_at = new Date(Date.now() - 1000).toISOString();
    const l = await call(dawListen, { action: 'listen_list', id: s.id, secret: s.secret }, INGE);
    expect(l.status).toBe(200);
    expect(l.json.links.map((x: any) => x.id)).toEqual([a.id]);
    expect(l.json.links[0]).toMatchObject({ label: 'Manager', token: a.token, channel: `nova-listen-${a.id}`, live: true, versions: true, comments: true });
  });

  it('révoquer : en un appel, idempotent ; impossible depuis une autre séance', async () => {
    const s1 = await newSession('S1');
    const s2 = await newSession('S2');
    const l = await newLink(s1);
    expect((await call(dawListen, { action: 'listen_revoke', id: s2.id, secret: s2.secret, link_id: l.id }, INGE)).status).toBe(404);
    expect((await open(l.token)).status).toBe(200);
    expect((await call(dawListen, { action: 'listen_revoke', id: s1.id, secret: s1.secret, link_id: l.id }, INGE)).json).toEqual({ ok: true });
    expect((await call(dawListen, { action: 'listen_revoke', id: s1.id, secret: s1.secret, link_id: l.id }, INGE)).json).toEqual({ ok: true });
    const r = await open(l.token);
    expect(r.status).toBe(410);
    expect(r.json.code).toBe('revoked');
    expect(r.json.error).toMatch(/désactivé par l'ingé son/);
  });
});

describe('daw-listen · ouverture par le client (sans compte)', () => {
  it('jeton valide : nom de la séance, réglages, canal du direct ; aucun secret de séance renvoyé', async () => {
    const s = await newSession();
    const l = await newLink(s);
    const r = await open(l.token);
    expect(r.status).toBe(200);
    expect(r.json.session).toEqual({ name: 'Séance de Nina' });
    expect(r.json.link).toMatchObject({ label: 'Label Nina', live: true, versions: true, comments: true });
    expect(r.json.channel).toBe(`nova-listen-${l.id}`);
    expect(JSON.stringify(r.json)).not.toContain(s.secret);
    expect(JSON.stringify(r.json)).not.toContain(db.tables.daw_sessions[0].secret_hash);
    expect(db.tables.daw_listen_links[0].open_count).toBe(1);
    await open(l.token, { refresh: true });
    expect(db.tables.daw_listen_links[0].open_count).toBe(1);
  });

  it('jeton inconnu, tronqué ou mal formé : 404 avec un message qui dit quoi faire', async () => {
    const s = await newSession();
    const l = await newLink(s);
    for (const t of ['x'.repeat(32), l.token.slice(0, 31), `${l.token}A`, '', '../../etc']) {
      const r = await open(t);
      expect(r.status).toBe(404);
      expect(r.json.code).toBe('unknown');
      expect(r.json.error).toMatch(/demande un nouveau lien/);
    }
  });

  it('lien expiré : 410 « expiré le … », même avec le bon mot de passe', async () => {
    const s = await newSession();
    const l = await newLink(s, { password: 'nina2026' });
    db.tables.daw_listen_links[0].expires_at = new Date(Date.now() - 60_000).toISOString();
    const r = await open(l.token, { password: 'nina2026' });
    expect(r.status).toBe(410);
    expect(r.json.code).toBe('expired');
    expect(r.json.error).toMatch(/a expiré le \d\d\/\d\d\/\d{4}/);
  });

  it('mot de passe : demandé (401), faux (403), bon (200) ; 8 essais faux bloquent 15 min (429)', async () => {
    const s = await newSession();
    const l = await newLink(s, { password: 'nina2026' });
    expect((await open(l.token)).json.code).toBe('password_required');
    expect((await open(l.token, { password: 'faux' })).status).toBe(403);
    expect((await open(l.token, { password: 'nina2026' })).status).toBe(200);
    expect(db.tables.daw_listen_links[0].failed_attempts).toBe(0);
    for (let i = 0; i < 8; i++) expect((await open(l.token, { password: `faux${i}` })).status).toBe(403);
    const locked = await open(l.token, { password: 'nina2026' });
    expect(locked.status).toBe(429);
    expect(locked.json.code).toBe('locked');
  }, 60_000);

  it('contenu choisi par l\'ingé : sans direct → pas de canal ; sans commentaires / versions → rien', async () => {
    const s = await newSession();
    const l = await newLink(s, { live: false, versions: true, comments: false });
    const r = await open(l.token);
    expect(r.json.channel).toBeNull();
    expect(r.json.comments).toBeNull();
    expect(Array.isArray(r.json.versions)).toBe(true);
    const l2 = await newLink(s, { live: true, versions: false, comments: false });
    const r2 = await open(l2.token);
    expect(r2.json.versions).toBeNull();
    expect(r2.json.comments).toBeNull();
  });
});

describe('daw-listen · LECTURE SEULE (vérifiée côté serveur)', () => {
  it('le jeton d\'écoute ne permet aucune action d\'écriture (403), ni dans daw-session (404), et rien n\'est écrit', async () => {
    const s = await newSession();
    const l = await newLink(s);
    const before = JSON.stringify({ sessions: db.tables.daw_sessions, ops: db.tables.daw_session_ops || [], links: db.tables.daw_listen_links.map((r: any) => ({ ...r, open_count: 0, last_opened_at: null })) });
    const writesBefore = db.writes.length;
    // 1. Fonction daw-listen : toute action autre que l'ouverture, avec le jeton.
    for (const action of ['listen_create', 'listen_revoke', 'listen_list', 'op', 'commit', 'delete', 'claim', 'join', 'comment', 'decide']) {
      const r = await call(dawListen, { action, token: l.token, id: s.id, secret: l.token, link_id: l.id, ttl_hours: 24, kind: 'comments', op: { upsert: [] } });
      expect(r.status, action).toBe(403);
      expect(r.json.code).toBe('read_only');
      expect(r.json.error).toMatch(/lecture seule/);
    }
    // 2. Fonction daw-session : le jeton n'est pas le secret de la séance.
    for (const action of ['op', 'commit', 'join', 'sign_upload', 'delete', 'claim', 'invite_code', 'get', 'ops_since']) {
      const r = await call(dawSession, { action, id: s.id, secret: l.token, kind: 'comments', op: { upsert: [] }, role: 'artist', device_id: 'tel',
        baseVersion: 0, manifest: { project: {} }, parts: ['a'.repeat(40)] });
      expect(r.status, action).toBe(404);
    }
    // 3. Créer / révoquer exige le lien de la SÉANCE (le jeton d'écoute n'y suffit pas), même connecté.
    expect((await call(dawListen, { action: 'listen_revoke', id: s.id, secret: l.token, link_id: l.id }, INGE)).status).toBe(404);
    expect((await call(dawListen, { action: 'listen_create', id: s.id, secret: l.token, ttl_hours: 720 }, INGE)).status).toBe(404);
    expect(db.writes.length).toBe(writesBefore);
    const after = JSON.stringify({ sessions: db.tables.daw_sessions, ops: db.tables.daw_session_ops || [], links: db.tables.daw_listen_links.map((r: any) => ({ ...r, open_count: 0, last_opened_at: null })) });
    expect(after).toBe(before);
    expect((await open(l.token)).status).toBe(200);
  });
});

// ─── Commentaires et versions : vue publique ─────────────────────────────────────────────
const st = (t: number, c = 0, by = 'u:x') => ({ t, c, by });
const reg = <T,>(v: T, t: number, c = 0) => ({ v, s: st(t, c) });
const comment = (id: string, t: number, text: string, ts: number, extra: Record<string, unknown> = {}) => ({
  id, authorKey: 'u:secret-key', authorName: 'Nina', role: 'artist', createdAt: ts, trackId: 'voix',
  pos: reg({ t, end: null }, ts), text: reg(text, ts), status: reg({ s: 'open' }, ts), archived: reg(false, ts), replies: [], ...extra,
});
const version = (id: string, n: number, ts: number, extra: Record<string, unknown> = {}) => ({
  id, n, name: `Version ${n}`, sentAt: ts, sentBy: 'Max', sentByKey: 'u:max-key', ref: { sessionVersion: 3 }, audio: null,
  decision: { v: null, s: st(0) }, ...extra,
});

describe('daw-listen · commentaires et versions (lecture seule, fusionnés)', () => {
  it('fusion « le plus récent gagne », archivés et réponses effacées exclus, aucune clé interne exposée', () => {
    const c1 = comment('cm-1', 72, 'le « s » siffle', 1000);
    const c1edit = { ...c1, text: reg('le « s » siffle trop', 2000), replies: [{ id: 'rp-1', authorKey: 'u:max', authorName: 'Max', createdAt: 2100, text: reg('corrigé', 2100) },
      { id: 'rp-2', authorKey: 'u:max', authorName: 'Max', createdAt: 2200, text: reg('oups', 2200), deleted: reg(true, 2300) }] };
    const c1old = { ...c1, text: reg('ancienne version', 1500) };
    const c2 = comment('cm-2', 10, 'intro trop longue', 1100, { archived: reg(true, 1200) });
    const c3 = comment('cm-3', 30, 'refrain : plus de basse', 1300, { status: reg({ s: 'resolved' }, 1400) });
    const review = collectReview({ project: { timelineComments: [c1, c2] }, ops: [{ kind: 'comments', op: { upsert: [c1edit, c3] } }, { kind: 'comments', op: { upsert: [c1old] } }, { kind: 'comments', op: 'illisible' }] });
    const out = publicComments(review.comments.values());
    expect(out.map(c => c.id)).toEqual(['cm-3', 'cm-1']);
    expect(out[1]).toMatchObject({ t: 72, text: 'le « s » siffle trop', status: 'open', author: 'Nina' });
    expect(out[1].replies).toEqual([{ author: 'Max', text: 'corrigé', at: 2100 }]);
    expect(out[0].status).toBe('resolved');
    const json = JSON.stringify(out);
    expect(json).not.toContain('secret-key');
    expect(json).not.toContain('trackId');
  });

  it('versions : les plus récentes d\'abord, décision la plus récente, audio seulement si les morceaux sont valides', () => {
    const a = 'a'.repeat(40), b = 'b'.repeat(40);
    const v1 = version('mv-1', 1, 1000, { decision: reg({ kind: 'changes', by: 'Nina', at: 1500, comment: 'plus de voix' }, 1500) });
    const v2 = version('mv-2', 2, 2000, { audio: { bufferId: 'x', parts: [a, b], size: 1234, duration: 12.5 } });
    const v2ok = { ...v2, decision: reg({ kind: 'approved', by: 'Nina', at: 2500 }, 2500) };
    const v3 = version('mv-3', 3, 3000, { audio: { parts: ['pas-un-sha1'], size: 1, duration: 1 } });
    const review = collectReview({ ops: [{ kind: 'mixver', op: { upsert: [v1, v2] } }, { kind: 'mixver', op: { upsert: [v2ok, v3] } }, { kind: 'mixver', op: { upsert: [v2] } }] });
    const out = publicVersions(review.versions.values());
    expect(out.map(v => v.n)).toEqual([3, 2, 1]);
    expect(out[1].decision).toMatchObject({ kind: 'approved', by: 'Nina' });
    expect(out[1].audio).toEqual({ parts: [a, b], size: 1234, duration: 12.5 });
    expect(out[0].audio).toBeNull();
    expect(out[2].decision).toMatchObject({ kind: 'changes', comment: 'plus de voix' });
    expect(JSON.stringify(out)).not.toContain('max-key');
  });

  it('listen_open renvoie la vue publique depuis le journal et le projet, avec l\'audio des versions signé', async () => {
    const s = await newSession();
    const l = await newLink(s);
    const part = 'c'.repeat(40);
    db.tables.daw_sessions[0].manifest = { project: { timelineComments: [comment('cm-9', 5, 'au début', 900)] } };
    (db.tables.daw_session_ops ||= []).push(
      { session_id: s.id, seq: 1, kind: 'mixver', op: { upsert: [version('mv-1', 1, 1000, { audio: { parts: [part], size: 10, duration: 3 } })] } },
      { session_id: s.id, seq: 2, kind: 'comments', op: { upsert: [comment('cm-1', 42, 'la reverb est trop forte', 1200)] } },
      { session_id: s.id, seq: 3, kind: 'volume', op: { trackId: 'voix', volume: 0.5 } },
      { session_id: 'autre-seance', seq: 4, kind: 'comments', op: { upsert: [comment('cm-x', 1, 'pas à moi', 1)] } },
    );
    const r = await open(l.token);
    expect(r.status).toBe(200);
    expect(r.json.comments.map((c: any) => c.text)).toEqual(['au début', 'la reverb est trop forte']);
    expect(r.json.versions).toHaveLength(1);
    expect(r.json.versions[0].urls).toEqual({ [part]: `https://signed.test/${s.id}/${part}` });
  });
});
