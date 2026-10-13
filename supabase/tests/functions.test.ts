/**
 * Tests des fonctions serveur versionnées dans NOVA (supabase/functions) :
 * daw-session et nova-billing, chargées TELLES QUELLES (code Deno) avec un faux
 * Supabase, un faux Stripe et un faux serve() (alias de vitest.config.ts).
 * Rien ne part sur le réseau, aucune base réelle n'est touchée.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDb, setCurrentDb, type FakeDb } from './fakes/supabase';
import { lastHandler } from './fakes/denoServe';
import { resetStripe, stripeState } from './fakes/stripe';

(globalThis as any).Deno = { env: { get: (k: string) => ({ SUPABASE_URL: 'http://fake.local', SUPABASE_SERVICE_ROLE_KEY: 'service', STRIPE_SECRET_KEY: 'sk_test', NOVA_PURGE_KEY: 'cle-menage' } as Record<string, string>)[k] } };

type Handler = (req: Request) => Promise<Response> | Response;
let dawSession: Handler;
let novaBilling: Handler;

beforeAll(async () => {
  await import('../functions/daw-session/index.ts');
  dawSession = lastHandler();
  await import('../functions/nova-billing/index.ts');
  novaBilling = lastHandler();
});

let db: FakeDb;
beforeEach(() => {
  db = createFakeDb();
  db.users['jwt.artiste.ok'] = { id: 'u-artiste', email: 'artiste@example.com' };
  db.users['jwt.inge.ok'] = { id: 'u-inge', email: 'inge@example.com' };
  db.users['jwt.admin.ok'] = { id: 'u-admin', email: 'studio@example.com' };
  db.tables.user_roles = [{ user_id: 'u-admin', role: 'admin' }];
  setCurrentDb(db);
  resetStripe();
});

const NOVA = 'https://nova-studio-daw-0901.vercel.app';
async function call(h: Handler, body: unknown, opts: { token?: string; origin?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: opts.origin ?? NOVA };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await h(new Request('http://fn.local/', { method: opts.method || 'POST', headers, body: opts.method && opts.method !== 'POST' ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}
const subscribe = (userId: string) => {
  (db.tables.nova_subscriptions ||= []).push({ stripe_subscription_id: `sub_${userId}`, user_id: userId, plan: 'collab', status: 'active', current_period_end: new Date(Date.now() + 20 * 86400_000).toISOString(), updated_at: new Date().toISOString() });
};

describe('daw-session', () => {
  it('CORS : origine NOVA acceptée, origine inconnue renvoyée vers NOVA ; POST uniquement', async () => {
    const ok = await call(dawSession, null, { method: 'OPTIONS' });
    expect(ok.headers.get('access-control-allow-origin')).toBe(NOVA);
    const evil = await call(dawSession, null, { method: 'OPTIONS', origin: 'https://evil.example' });
    expect(evil.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
    expect((await call(dawSession, null, { method: 'GET' })).status).toBe(405);
  });

  it('créer puis relire : seul le hachage du secret est gardé, un mauvais secret donne 404', async () => {
    const c = await call(dawSession, { action: 'create', name: 'Séance test', device: 'PC' });
    expect(c.status).toBe(200);
    expect(c.json.id).toMatch(/^[a-z0-9]{12}$/);
    const row = db.tables.daw_sessions[0];
    expect(row.secret_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.secret_hash).not.toContain(c.json.secret);
    expect((await call(dawSession, { action: 'get', id: c.json.id, secret: 'x'.repeat(32) })).status).toBe(404);
    expect((await call(dawSession, { action: 'get', id: 'PAS-UN-ID', secret: c.json.secret })).status).toBe(400);
    const g = await call(dawSession, { action: 'get', id: c.json.id, secret: c.json.secret });
    expect(g.status).toBe(200);
    expect(g.json.name).toBe('Séance test');
  });

  it('commit : 409 si la séance a changé ailleurs, 400 si un son manque, sinon version + 1', async () => {
    const { json: s } = await call(dawSession, { action: 'create', name: 'S' });
    const part = 'a'.repeat(40);
    const manifest = { project: { name: 'S' }, files: { 'voix.wav': { parts: [part] } } };
    const missing = await call(dawSession, { action: 'commit', id: s.id, secret: s.secret, baseVersion: 0, manifest });
    expect(missing.status).toBe(400);
    (db.storage['daw-sessions'] ||= new Map()).set(`${s.id}/${part}`, { size: 1234, created_at: new Date().toISOString() });
    const ok = await call(dawSession, { action: 'commit', id: s.id, secret: s.secret, baseVersion: 0, manifest });
    expect(ok.status).toBe(200);
    expect(ok.json.version).toBe(1);
    const stale = await call(dawSession, { action: 'commit', id: s.id, secret: s.secret, baseVersion: 0, manifest });
    expect(stale.status).toBe(409);
    expect(stale.json.version).toBe(1);
  });

  it("sign_upload : quelques morceaux signés sans lister la séance ; un gros envoi saute ce qui y est déjà", async () => {
    const { json: s } = await call(dawSession, { action: 'create', name: 'S' });
    const store = (db.storage['daw-sessions'] ||= new Map());
    const deja = 'b'.repeat(40);
    store.set(`${s.id}/${deja}`, { size: 10, created_at: new Date().toISOString() });
    // Un morceau de prise (1 par seconde) : signé directement, la séance n'est pas listée.
    let listes = 0;
    const spy = new Proxy(store, { get(t, k) { if (k === 'entries') listes++; const v = (t as any)[k]; return typeof v === 'function' ? v.bind(t) : v; } });
    db.storage['daw-sessions'] = spy as any;
    const petit = await call(dawSession, { action: 'sign_upload', id: s.id, secret: s.secret, parts: ['c'.repeat(40)] });
    expect(petit.status).toBe(200);
    expect(Object.keys(petit.json.uploads)).toEqual(['c'.repeat(40)]);
    expect(listes).toBe(0);
    // Gros envoi (séance entière) : ce qui est déjà stocké n'est pas renvoyé.
    const parts = [deja, ...'01234'.split('').map(ch => ch.repeat(40))];
    const gros = await call(dawSession, { action: 'sign_upload', id: s.id, secret: s.secret, parts });
    expect(gros.status).toBe(200);
    expect(Object.keys(gros.json.uploads)).not.toContain(deja);
    expect(Object.keys(gros.json.uploads)).toHaveLength(5);
    expect(listes).toBeGreaterThan(0);
    db.storage['daw-sessions'] = store;
  });

  it('collaboration (séance sans hôte) : compte connecté ET Nova Pro exigés ; une clé par appareil ; op seulement après join', async () => {
    const { json: s } = await call(dawSession, { action: 'create', name: 'Feat' });
    const join = { action: 'join', id: s.id, secret: s.secret, role: 'artist', device_id: 'tel-1' };
    expect((await call(dawSession, join)).status).toBe(401);
    expect((await call(dawSession, join, { token: 'jwt.artiste.ok' })).status).toBe(402);
    const op = { action: 'op', id: s.id, secret: s.secret, kind: 'clip_add', op: { a: 1 }, device_id: 'tel-1' };
    subscribe('u-artiste');
    expect((await call(dawSession, op, { token: 'jwt.artiste.ok' })).status).toBe(403);
    const j1 = await call(dawSession, join, { token: 'jwt.artiste.ok' });
    expect(j1.status).toBe(200);
    expect(j1.json.member_key).toBe('u:u-artiste:tel-1');
    // Même compte, autre appareil, autre rôle : ne remplace pas le 1er.
    const j2 = await call(dawSession, { ...join, role: 'engineer', device_id: 'pc-2' }, { token: 'jwt.artiste.ok' });
    expect(j2.json.member_key).toBe('u:u-artiste:pc-2');
    expect(db.tables.daw_session_members.map(m => m.role).sort()).toEqual(['artist', 'engineer']);
    const o = await call(dawSession, op, { token: 'jwt.artiste.ok' });
    expect(o.status).toBe(200);
    expect(o.json.seq).toBe(1);
    expect(o.json.role).toBe('artist');
    expect((await call(dawSession, { ...op, kind: 'DROP TABLE' }, { token: 'jwt.artiste.ok' })).status).toBe(400);
  });

  it("le studio (admin) collabore sans abonnement ; l'admin seul attribue une séance", async () => {
    const { json: s } = await call(dawSession, { action: 'create', name: 'Studio' });
    expect((await call(dawSession, { action: 'join', id: s.id, secret: s.secret, role: 'engineer', device_id: 'regie' }, { token: 'jwt.admin.ok' })).status).toBe(200);
    db.rpc.mm_user_id_by_email = () => 'u-artiste';
    expect((await call(dawSession, { action: 'assign', id: s.id, secret: s.secret, email: 'artiste@example.com' }, { token: 'jwt.inge.ok' })).status).toBe(403);
    expect((await call(dawSession, { action: 'assign', id: s.id, secret: s.secret, email: 'artiste@example.com' }, { token: 'jwt.admin.ok' })).status).toBe(200);
    expect(db.tables.daw_sessions[0].owner_id).toBe('u-artiste');
  });

  it("collaboration en hôte : l'hôte Nova Pro invite, l'invité n'a rien à payer ; hôte sans Pro → 402 clair", async () => {
    const { json: s } = await call(dawSession, { action: 'create', name: 'Hôte', purpose: 'collab' }, { token: 'jwt.inge.ok' });
    const guest = { action: 'join', id: s.id, secret: s.secret, role: 'artist', device_id: 'tel' };
    const host = { action: 'join', id: s.id, secret: s.secret, role: 'engineer', device_id: 'pc' };
    const h0 = await call(dawSession, host, { token: 'jwt.inge.ok' });
    expect(h0.status).toBe(402);
    expect(h0.json.reason).toBe('host_pro');
    expect(h0.json.error).toMatch(/invités n'ont rien à payer/);
    const g0 = await call(dawSession, guest, { token: 'jwt.artiste.ok' });
    expect(g0.status).toBe(402);
    expect(g0.json.reason).toBe('host_not_pro');
    subscribe('u-inge');
    expect((await call(dawSession, host, { token: 'jwt.inge.ok' })).status).toBe(200);
    expect((await call(dawSession, guest, { token: 'jwt.artiste.ok' })).status).toBe(200); // invité gratuit
  });

  it("code d'invitation : 6 caractères, le même pendant 24 h, résolu si l'hôte (ou l'invité) a Nova Pro", async () => {
    const { json: s } = await call(dawSession, { action: 'create', name: 'Code' }, { token: 'jwt.inge.ok' });
    const c1 = await call(dawSession, { action: 'invite_code', id: s.id, secret: s.secret }, { token: 'jwt.inge.ok' });
    expect(c1.status).toBe(200);
    expect(c1.json.code).toMatch(/^[A-Z2-9]{6}$/);
    const c2 = await call(dawSession, { action: 'invite_code', id: s.id, secret: s.secret }, { token: 'jwt.inge.ok' });
    expect(c2.json.code).toBe(c1.json.code);
    expect((await call(dawSession, { action: 'resolve_code', code: c1.json.code }, { token: 'jwt.artiste.ok' })).status).toBe(402);
    subscribe('u-artiste');
    const r = await call(dawSession, { action: 'resolve_code', code: c1.json.code.toLowerCase().replace(/(...)/, '$1 ') }, { token: 'jwt.artiste.ok' });
    expect(r.status).toBe(200);
    expect(r.json.link).toBe(`${s.id}.${s.secret}`);
    // Hôte Pro : un invité gratuit résout le code.
    db.users['jwt.invite.ok'] = { id: 'u-invite', email: 'invite@example.com' };
    subscribe('u-inge');
    expect((await call(dawSession, { action: 'resolve_code', code: c1.json.code }, { token: 'jwt.invite.ok' })).status).toBe(200);
  });
});

describe('nova-billing', () => {
  const ret = `${NOVA}/`;

  it("refuse une adresse de retour étrangère (pas de redirection ouverte) et l'abonnement sans compte", async () => {
    const evil = await call(novaBilling, { action: 'checkout', product: 'export_voices', project_key: 'projet-123', return_url: 'https://evil.example/' });
    expect(evil.status).toBe(400);
    expect(evil.json.error).toMatch(/retour refusée/);
    expect((await call(novaBilling, { action: 'checkout', product: 'collab', return_url: ret })).status).toBe(401);
    expect((await call(novaBilling, { action: 'checkout', product: 'inconnu', return_url: ret })).status).toBe(400);
    expect(stripeState.created).toHaveLength(0);
  });

  it("ancien produit « export_voices » : payé 1,99 € (grille du 14/10), vérifié, puis projet débloqué pour ce compte", async () => {
    const c = await call(novaBilling, { action: 'checkout', product: 'export_voices', project_key: 'projet-123', return_url: ret }, { token: 'jwt.artiste.ok' });
    expect(c.status).toBe(200);
    expect(stripeState.created[0].line_items[0].price_data.unit_amount).toBe(199);
    expect(stripeState.created[0].success_url).toBe(`${ret}?nova_paid={CHECKOUT_SESSION_ID}`);
    expect((await call(novaBilling, { action: 'verify', session_id: 'pas-un-id' })).status).toBe(400);
    expect((await call(novaBilling, { action: 'verify', session_id: c.json.session_id })).json.paid).toBe(false);
    expect((await call(novaBilling, { action: 'export_unlocked', project_key: 'projet-123' }, { token: 'jwt.artiste.ok' })).json.unlocked).toBe(false);
    Object.assign(stripeState.sessions[c.json.session_id], { payment_status: 'paid', amount_total: 199, customer_details: { email: 'artiste@example.com' } });
    const v = await call(novaBilling, { action: 'verify', session_id: c.json.session_id });
    expect(v.json).toMatchObject({ paid: true, kind: 'export_project', project_key: 'projet-123' });
    expect((await call(novaBilling, { action: 'export_unlocked', project_key: 'projet-123' }, { token: 'jwt.artiste.ok' })).json.unlocked).toBe(true);
    // Le déblocage appartient à celui qui a payé : ni un autre compte, ni un appel sans compte.
    expect((await call(novaBilling, { action: 'export_unlocked', project_key: 'projet-123' }, { token: 'jwt.inge.ok' })).json.unlocked).toBe(false);
    expect((await call(novaBilling, { action: 'export_unlocked', project_key: 'projet-123' })).json.unlocked).toBe(false);
    expect((await call(novaBilling, { action: 'export_access', project_key: 'projet-123' }, { token: 'jwt.artiste.ok' })).json).toMatchObject({ unlocked: true, via: 'achat' });
    expect((await call(novaBilling, { action: 'export_access', project_key: 'projet-123' }, { token: 'jwt.inge.ok' })).json).toMatchObject({ unlocked: false, reason: 'paiement' });
  });

  it('export : l’id local commun « proj-1 » n’est jamais débloqué (même payé) ni payable', async () => {
    db.tables.nova_purchases = [{ checkout_session_id: 'cs_test_x', kind: 'export_voices', project_key: 'proj-1', user_id: 'u-artiste' }];
    expect((await call(novaBilling, { action: 'export_unlocked', project_key: 'proj-1' }, { token: 'jwt.artiste.ok' })).json.unlocked).toBe(false);
    expect((await call(novaBilling, { action: 'export_unlocked', project_key: 'proj-1' })).json.unlocked).toBe(false);
    expect((await call(novaBilling, { action: 'export_access', project_key: 'proj-1' }, { token: 'jwt.artiste.ok' })).status).toBe(400);
    expect((await call(novaBilling, { action: 'checkout', product: 'export_project', project_key: 'proj-1', return_url: ret }, { token: 'jwt.artiste.ok' })).status).toBe(400);
  });

  it('export : achat sans compte (invité) débloque seulement les appels sans compte', async () => {
    db.tables.nova_purchases = [{ checkout_session_id: 'cs_test_y', kind: 'export_voices', project_key: 'exp-invite-1', user_id: null }];
    expect((await call(novaBilling, { action: 'export_unlocked', project_key: 'exp-invite-1' })).json.unlocked).toBe(true);
    expect((await call(novaBilling, { action: 'export_unlocked', project_key: 'exp-invite-1' }, { token: 'jwt.inge.ok' })).json.unlocked).toBe(false);
    expect((await call(novaBilling, { action: 'export_access', project_key: 'exp-invite-1' })).json).toMatchObject({ unlocked: true, via: 'achat' });
  });

  it('abonnement : anciens noms (collab, beatmaker) → Nova Pro 9,99 €/mois ; abonnés existants inchangés (prix chez Stripe)', async () => {
    await call(novaBilling, { action: 'checkout', product: 'collab', return_url: ret }, { token: 'jwt.artiste.ok' });
    await call(novaBilling, { action: 'checkout', product: 'beatmaker', return_url: ret }, { token: 'jwt.artiste.ok' });
    expect(stripeState.created.map(p => p.line_items[0].price_data.unit_amount)).toEqual([999, 999]);
    expect(stripeState.created.every(p => p.mode === 'subscription' && p.line_items[0].price_data.recurring.interval === 'month' && p.metadata.nova_plan === 'collab')).toBe(true);
  });

  it("ancien « crédit d'export » Nova Pro : refus sans abonnement, illimité avec, admin sans écriture", async () => {
    expect((await call(novaBilling, { action: 'use_export_credit', project_key: 'projet-1' })).json.reason).toBe('login');
    expect((await call(novaBilling, { action: 'use_export_credit', project_key: 'projet-1' }, { token: 'jwt.artiste.ok' })).json.reason).toBe('not_pro');
    subscribe('u-artiste');
    for (let i = 0; i < 12; i++) {
      const r = await call(novaBilling, { action: 'use_export_credit', project_key: `projet-${i}x` }, { token: 'jwt.artiste.ok' });
      expect(r.json.unlocked).toBe(true); // Nova Pro : exports illimités (plus de quota de 10)
    }
    const before = db.writes.length;
    const admin = await call(novaBilling, { action: 'use_export_credit', project_key: 'projet-adm' }, { token: 'jwt.admin.ok' });
    expect(admin.json).toMatchObject({ unlocked: true, admin: true });
    expect(db.writes.length).toBe(before);
  });

  it('statut sans compte : aucun abonnement, rien écrit', async () => {
    const r = await call(novaBilling, { action: 'status' });
    expect(r.json).toMatchObject({ plans: [], admin: false, pro: null });
    expect(db.writes).toHaveLength(0);
  });
});
