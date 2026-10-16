/**
 * 1.5.1 · Lot 3 (invité gratuit) et lot 9 (copie de séance, page publique) : fonctions serveur
 * daw-session, daw-fork et daw-listen chargées TELLES QUELLES (code Deno) avec le faux Supabase
 * de supabase/tests/fakes. Rien ne part sur le réseau, aucune base réelle n'est touchée.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDb, setCurrentDb, type FakeDb } from './fakes/supabase';
import { lastHandler } from './fakes/denoServe';
import { freezeForFork, partsOfFrozen } from '../functions/_shared/forkCopy';
import { validatePublish, EXTRAIT_MAX_BYTES } from '../functions/daw-listen/publicTrack';

(globalThis as any).Deno = { env: { get: (k: string) => ({ SUPABASE_URL: 'http://fake.local', SUPABASE_SERVICE_ROLE_KEY: 'service' } as Record<string, string>)[k] } };

type Handler = (req: Request) => Promise<Response> | Response;
let dawSession: Handler;
let dawFork: Handler;
let dawListen: Handler;

beforeAll(async () => {
  await import('../functions/daw-session/index.ts');
  dawSession = lastHandler();
  await import('../functions/daw-fork/index.ts');
  dawFork = lastHandler();
  await import('../functions/daw-listen/index.ts');
  dawListen = lastHandler();
});

let db: FakeDb;
beforeEach(() => {
  db = createFakeDb();
  db.users['jwt.hote.ok'] = { id: 'u-hote', email: 'hote@example.com' };
  db.users['jwt.invite.ok'] = { id: 'u-invite', email: 'invite@example.com' };
  db.users['jwt.rappeur.ok'] = { id: 'u-rappeur', email: 'rappeur@example.com' };
  db.users['jwt.admin.ok'] = { id: 'u-admin', email: 'studio@example.com' };
  db.tables.user_roles = [{ user_id: 'u-admin', role: 'admin' }];
  setCurrentDb(db);
});

const NOVA = 'https://nova-studio-daw-0901.vercel.app';
async function call(h: Handler, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: NOVA };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await h(new Request('http://fn.local/', { method: 'POST', headers, body: JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const HOTE = 'jwt.hote.ok', INVITE = 'jwt.invite.ok', RAPPEUR = 'jwt.rappeur.ok';
const pro = (userId: string) => (db.tables.nova_subscriptions ||= []).push({ stripe_subscription_id: `sub_${userId}`, user_id: userId, plan: 'collab', status: 'active', current_period_end: null, updated_at: new Date().toISOString() });
const store = () => (db.storage['daw-sessions'] ||= new Map());
const put = (sid: string, part: string, size = 1000) => store().set(`${sid}/${part}`, { size, created_at: new Date(Date.now() - 3600_000).toISOString() });
const h = (c: string) => c.repeat(40);

/** Séance en ligne de l'hôte (Nova Pro), avec une voix, une batterie et l'instru du catalogue. */
async function hostSession(opts: { catalog?: boolean } = {}) {
  pro('u-hote');
  const c = await call(dawSession, { action: 'create', name: 'Beat de Max' }, HOTE);
  expect(c.status).toBe(200);
  const s = c.json as { id: string; secret: string };
  const tracks: any[] = [
    { id: 'voix', clips: [{ id: 'c1', audioRef: 'audio/voix.wav' }] },
    { id: 'drums', clips: [{ id: 'c2', audioRef: 'audio/drums.wav' }] },
  ];
  const files: Record<string, { parts: string[]; size: number }> = { 'audio/voix.wav': { parts: [h('1')], size: 1000 }, 'audio/drums.wav': { parts: [h('2'), h('3')], size: 2000 } };
  if (opts.catalog) {
    tracks.push({ id: 'instrumental', instrumentId: 'beat-42', clips: [{ id: 'c3', audioRef: 'audio/beat.wav' }] });
    files['audio/beat.wav'] = { parts: [h('9')], size: 5000 };
  }
  for (const f of Object.values(files)) for (const p of f.parts) put(s.id, p);
  const manifest = { format: 1, project: { name: 'Beat de Max', bpm: 140, chords: [{ t: 0, name: 'Am' }], tracks }, files };
  const cm = await call(dawSession, { action: 'commit', id: s.id, secret: s.secret, baseVersion: 0, manifest }, HOTE);
  expect(cm.status, JSON.stringify(cm.json)).toBe(200);
  return { ...s, manifest };
}

// ───────────────────────────────────────────────────────────────────────────── Lot 3
describe('Lot 3 · invité gratuit (daw-session)', () => {
  it("l'invité sans Nova Pro rejoint (lien et code) la séance d'un hôte Pro ; sa propre séance de collaboration est refusée (402)", async () => {
    const s = await hostSession();
    expect((await call(dawSession, { action: 'join', id: s.id, secret: s.secret, role: 'engineer', device_id: 'pc' }, HOTE)).status).toBe(200);
    const j = await call(dawSession, { action: 'join', id: s.id, secret: s.secret, role: 'artist', device_id: 'tel' }, INVITE);
    expect(j.status).toBe(200);
    expect(j.json.member_key).toBe('u:u-invite:tel');
    // Il enregistre : ses opérations passent.
    expect((await call(dawSession, { action: 'op', id: s.id, secret: s.secret, kind: 'clip_add', op: { a: 1 }, device_id: 'tel' }, INVITE)).status).toBe(200);
    // Par le code (6 caractères) aussi.
    const code = (await call(dawSession, { action: 'invite_code', id: s.id, secret: s.secret }, HOTE)).json.code;
    const r = await call(dawSession, { action: 'resolve_code', code }, RAPPEUR);
    expect(r.status).toBe(200);
    expect(r.json.link).toBe(`${s.id}.${s.secret}`);
    // Héberger : refusé dès la création (Nova Pro), avec la raison que l'appli reconnaît.
    const own = await call(dawSession, { action: 'create', name: 'Ma collab', purpose: 'collab' }, INVITE);
    expect(own.status).toBe(402);
    expect(own.json.reason).toBe('host_pro');
    expect(own.json.error).toMatch(/invités n'ont rien à payer/);
    expect((await call(dawSession, { action: 'create', name: 'Anonyme', purpose: 'collab' })).status).toBe(401);
    // Un compte reste exigé pour rejoindre (gratuit).
    expect((await call(dawSession, { action: 'join', id: s.id, secret: s.secret, role: 'artist', device_id: 'x' })).status).toBe(401);
  });

  it("compatibilité : une séance d'hôte non Pro reste refusée aux invités (402 « host_not_pro ») ; projets gratuits inchangés", async () => {
    const c = await call(dawSession, { action: 'create', name: 'Projet gratuit' }, INVITE);
    expect(c.status).toBe(200); // l'ancienne appli crée sans « purpose » : inchangé
    expect(c.json.days_left).toBe(7);
    const g = await call(dawSession, { action: 'join', id: c.json.id, secret: c.json.secret, role: 'artist', device_id: 't' }, RAPPEUR);
    expect(g.status).toBe(402);
    expect(g.json.reason).toBe('host_not_pro');
    expect((await call(dawSession, { action: 'create', name: 'Deuxième' }, INVITE)).status).toBe(402); // 1 projet en ligne en gratuit
  });

  it('séance sans propriétaire (ancienne version) : un membre Pro déjà présent suffit, sinon 402', async () => {
    const c = await call(dawSession, { action: 'create', name: 'Ancienne' });
    const join = (tok: string, dev: string) => call(dawSession, { action: 'join', id: c.json.id, secret: c.json.secret, role: 'artist', device_id: dev }, tok);
    expect((await join(INVITE, 'a')).status).toBe(402);
    pro('u-hote');
    expect((await join(HOTE, 'b')).status).toBe(200);
    expect((await join(INVITE, 'a')).status).toBe(200);
  });

  it('anti-abus : 8 comptes actifs au plus par séance (un membre revient toujours) ; 20 codes faux par heure', async () => {
    const s = await hostSession();
    for (let i = 0; i < 8; i++) {
      db.users[`jwt.m${i}.ok`] = { id: `u-m${i}` };
      expect((await call(dawSession, { action: 'join', id: s.id, secret: s.secret, role: 'artist', device_id: `d${i}` }, `jwt.m${i}.ok`)).status).toBe(200);
    }
    const full = await call(dawSession, { action: 'join', id: s.id, secret: s.secret, role: 'artist', device_id: 'z' }, INVITE);
    expect(full.status).toBe(429);
    expect(full.json.reason).toBe('session_full');
    expect((await call(dawSession, { action: 'join', id: s.id, secret: s.secret, role: 'artist', device_id: 'd0bis' }, 'jwt.m0.ok')).status).toBe(200);
    // Codes devinés : bloqué après 20 échecs dans l'heure.
    for (let i = 0; i < 20; i++) expect((await call(dawSession, { action: 'resolve_code', code: 'ZZZZZZ' }, RAPPEUR)).status).toBe(404);
    const stop = await call(dawSession, { action: 'resolve_code', code: 'ZZZZZZ' }, RAPPEUR);
    expect(stop.status).toBe(429);
    expect(stop.json.reason).toBe('code_attempts');
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────── Lot 9a
describe('Lot 9a · « Faire sa version » (daw-fork)', () => {
  it('fige la séance sans les fichiers du catalogue ; morceaux listés dans l’ordre', () => {
    const { manifest, removedFiles, catalogTracks } = freezeForFork({
      project: { tracks: [{ id: 'b', instrumentId: 12, clips: [{ audioRef: 'audio/b.wav' }] }, { id: 'v', clips: [{ audioRef: 'audio/v.wav' }] }] },
      files: { 'audio/b.wav': { parts: [h('a')], size: 1 }, 'audio/v.wav': { parts: [h('b'), 'pas-un-hash'], size: 2 } },
    });
    expect(catalogTracks).toBe(1);
    expect(removedFiles).toEqual(['audio/b.wav']);
    expect(Object.keys(manifest.files)).toEqual(['audio/v.wav']);
    expect(partsOfFrozen(manifest)).toEqual([h('b')]);
    expect(() => freezeForFork({})).toThrow();
  });

  it('chacun reçoit SA copie : identique (sans le beat du catalogue), compteur par compte, original intouché, lien révoqué → 410', async () => {
    const s = await hostSession({ catalog: true });
    expect((await call(dawFork, { action: 'fork_create', id: s.id, secret: s.secret })).status).toBe(401);
    expect((await call(dawFork, { action: 'fork_create', id: s.id, secret: s.secret }, INVITE)).status).toBe(403); // a la clé, pas propriétaire
    const c = await call(dawFork, { action: 'fork_create', id: s.id, secret: s.secret, label: 'Rappeurs' }, HOTE);
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.catalog_tracks).toBe(1);
    const token = c.json.link.token as string;
    expect(token).toMatch(/^[A-Za-z0-9]{32}$/);
    // Sans compte : connexion demandée.
    const anon = await call(dawFork, { action: 'fork_open', token });
    expect(anon.status).toBe(401);
    expect(anon.json.code).toBe('login');
    const o = await call(dawFork, { action: 'fork_open', token }, RAPPEUR);
    expect(o.status).toBe(200);
    expect(o.json.manifest.project.bpm).toBe(140);
    expect(o.json.manifest.project.chords).toEqual([{ t: 0, name: 'Am' }]);
    expect(Object.keys(o.json.manifest.files).sort()).toEqual(['audio/drums.wav', 'audio/voix.wav']);
    expect(Object.keys(o.json.urls).sort()).toEqual([h('1'), h('2'), h('3')]);
    expect(JSON.stringify(o.json)).not.toContain(s.secret);
    expect(o.json.copies).toBe(1);
    // Rouvrir ne compte pas deux fois ; un autre compte, si ; l'hôte, jamais.
    expect((await call(dawFork, { action: 'fork_open', token }, RAPPEUR)).json.copies).toBe(1);
    expect((await call(dawFork, { action: 'fork_open', token }, INVITE)).json.copies).toBe(2);
    expect((await call(dawFork, { action: 'fork_open', token }, HOTE)).json.copies).toBe(2);
    // Le jeton n'ouvre rien d'autre : ni la séance (daw-session), ni une écriture.
    expect((await call(dawSession, { action: 'get', id: s.id, secret: token })).status).toBe(404);
    expect((await call(dawFork, { action: 'fork_revoke', token, link_id: c.json.link.id }, RAPPEUR)).status).toBe(403);
    // L'hôte continue : sa nouvelle version ne change pas les copies déjà liées au lien ; l'audio figé reste en ligne.
    put(s.id, h('7'));
    const m2 = { ...s.manifest, project: { ...s.manifest.project, bpm: 90 }, files: { 'audio/voix.wav': { parts: [h('7')], size: 1000 } } };
    expect((await call(dawSession, { action: 'commit', id: s.id, secret: s.secret, baseVersion: 1, manifest: m2 }, HOTE)).status).toBe(200);
    expect(store().has(`${s.id}/${h('2')}`)).toBe(true);
    expect(store().has(`${s.id}/${h('9')}`)).toBe(false); // beat du catalogue : plus référencé, effacé
    const again = await call(dawFork, { action: 'fork_open', token }, RAPPEUR);
    expect(again.json.manifest.project.bpm).toBe(140);
    // Liste et révocation.
    const l = await call(dawFork, { action: 'fork_list', id: s.id, secret: s.secret }, HOTE);
    expect(l.json.links[0]).toMatchObject({ copies: 2, label: 'Rappeurs' });
    expect((await call(dawFork, { action: 'fork_revoke', id: s.id, secret: s.secret, link_id: c.json.link.id }, HOTE)).status).toBe(200);
    const gone = await call(dawFork, { action: 'fork_open', token }, RAPPEUR);
    expect(gone.status).toBe(410);
    expect(gone.json.code).toBe('revoked');
    expect((await call(dawFork, { action: 'fork_open', token: 'x'.repeat(32) }, RAPPEUR)).status).toBe(404);
  });

  it('séance vide → 409 ; 5 liens actifs au plus', async () => {
    pro('u-hote');
    const e = await call(dawSession, { action: 'create', name: 'Vide' }, HOTE);
    expect((await call(dawFork, { action: 'fork_create', id: e.json.id, secret: e.json.secret }, HOTE)).json.code).toBe('empty');
    const s = await hostSession();
    for (let i = 0; i < 5; i++) expect((await call(dawFork, { action: 'fork_create', id: s.id, secret: s.secret }, HOTE)).status).toBe(200);
    const six = await call(dawFork, { action: 'fork_create', id: s.id, secret: s.secret }, HOTE);
    expect(six.status).toBe(409);
    expect(six.json.code).toBe('too_many');
  });
});

// ───────────────────────────────────────────────────────────────────────────── Lot 9b
describe('Lot 9b · page publique (daw-listen)', () => {
  const extrait = (extra: Record<string, unknown> = {}) => ({ title: 'Nuit blanche', artist: 'Nina', credits: 'Prod. Max', lyrics: 'La nuit tombe', show_lyrics: true, kind: 'extrait', audio: { parts: [h('e')], size: 480_000, duration: 30, mime: 'audio/mpeg' }, consent: true, ...extra });

  it('validation : titre, extrait ≤ 30 s, taille bornée', () => {
    expect(() => validatePublish({ ...extrait(), title: '  ' })).toThrow(/titre/);
    expect(() => validatePublish(extrait({ audio: { parts: [h('e')], size: 1000, duration: 45 } }))).toThrow(/30 secondes/);
    expect(() => validatePublish(extrait({ audio: { parts: [h('e')], size: EXTRAIT_MAX_BYTES + 1, duration: 30 } }))).toThrow(/lourd/);
    expect(validatePublish(extrait({ show_lyrics: true, lyrics: '' })).show_lyrics).toBe(false);
  });

  it('publication explicite par le propriétaire, page sans compte, sans pistes ni téléchargement ; désactivable (410)', async () => {
    const s = await hostSession();
    put(s.id, h('e'), 480_000);
    const pub = (tok: string | undefined, b: Record<string, unknown>) => call(dawListen, { action: 'public_publish', id: s.id, secret: s.secret, ...b }, tok);
    expect((await pub(undefined, extrait())).status).toBe(401);
    expect((await pub(INVITE, extrait())).json.code).toBe('not_owner');
    expect((await pub(HOTE, extrait({ consent: false }))).json.code).toBe('consent');
    const ok = await pub(HOTE, extrait());
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const id = ok.json.page.id as string;
    expect(id).toMatch(/^[a-z0-9]{10}$/);
    const page = await call(dawListen, { action: 'public_open', page: id });
    expect(page.status).toBe(200);
    expect(page.json).toMatchObject({ title: 'Nuit blanche', artist: 'Nina', kind: 'extrait', lyrics: 'La nuit tombe', plays: 1 });
    expect(page.json.booking_url).toMatch(/^https:\/\/www\.studiomakemusic\.com\/reservation/);
    expect(page.json.urls).toHaveLength(1);
    const txt = JSON.stringify(page.json);
    // Ni la séance (sa clé), ni le compte, ni les champs internes ; l'id de séance n'apparaît que
    // dans l'adresse signée du stockage (il n'ouvre rien sans la clé de la séance).
    expect(Object.keys(page.json).sort()).toEqual(['artist', 'booking_url', 'cover_url', 'credits', 'duration', 'id', 'kind', 'lyrics', 'mime', 'plays', 'title', 'updated_at', 'urls']);
    expect(txt).not.toContain(s.secret);
    expect(txt).not.toContain('u-hote');
    expect(txt).not.toContain('voix.wav'); // ni les pistes séparées
    expect((await call(dawListen, { action: 'public_open', page: id, refresh: true })).json.plays).toBe(1);
    // L'audio publié reste en ligne quand l'hôte renvoie sa séance.
    expect((await call(dawSession, { action: 'commit', id: s.id, secret: s.secret, baseVersion: 1, manifest: s.manifest }, HOTE)).status).toBe(200);
    expect(store().has(`${s.id}/${h('e')}`)).toBe(true);
    // Désactiver puis réactiver.
    expect((await call(dawListen, { action: 'public_set', id: s.id, secret: s.secret, published: false }, HOTE)).json.page.published).toBe(false);
    const off = await call(dawListen, { action: 'public_open', page: id });
    expect(off.status).toBe(410);
    expect(off.json.code).toBe('unpublished');
    expect((await call(dawListen, { action: 'public_set', id: s.id, secret: s.secret, published: true }, HOTE)).status).toBe(200);
    expect((await call(dawListen, { action: 'public_open', page: id })).status).toBe(200);
    expect((await call(dawListen, { action: 'public_open', page: 'zzzzzzzzzz' })).status).toBe(404);
  });

  it('morceau entier : seulement si l’export est débloqué ; instru du catalogue non achetée → refusé même en Pro', async () => {
    const s = await hostSession({ catalog: true });
    put(s.id, h('f'), 5_000_000);
    const mix = { title: 'Nuit blanche', kind: 'mix', audio: { parts: [h('f')], size: 5_000_000, duration: 180, mime: 'audio/mpeg' }, consent: true };
    const r1 = await call(dawListen, { action: 'public_publish', id: s.id, secret: s.secret, ...mix }, HOTE);
    expect(r1.status).toBe(403);
    expect(r1.json).toMatchObject({ code: 'mix_locked', reason: 'catalogue_non_achete' });
    (db.tables.instrumental_purchases ||= []).push({ id: 'p1', user_id: 'u-hote', instrumental_id: 'beat-42' });
    const r2 = await call(dawListen, { action: 'public_publish', id: s.id, secret: s.secret, ...mix }, HOTE);
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
    expect(r2.json.page.kind).toBe('mix');
  });

  it('morceau entier d’un compte gratuit : refusé sans export payé, accepté avec le projet payé', async () => {
    const c = await call(dawSession, { action: 'create', name: 'Gratuit' }, INVITE);
    const s = c.json as { id: string; secret: string };
    put(s.id, h('1'));
    expect((await call(dawSession, { action: 'commit', id: s.id, secret: s.secret, baseVersion: 0, manifest: { project: { tracks: [] }, files: { 'audio/v.wav': { parts: [h('1')], size: 1000 } } } }, INVITE)).status).toBe(200);
    put(s.id, h('f'), 3_000_000);
    const mix = { action: 'public_publish', id: s.id, secret: s.secret, title: 'Démo', kind: 'mix', audio: { parts: [h('f')], size: 3_000_000, duration: 120 }, consent: true, export_key: 'exp-abc123' };
    const r1 = await call(dawListen, mix, INVITE);
    expect(r1.status).toBe(403);
    expect(r1.json.reason).toBe('paiement');
    (db.tables.nova_purchases ||= []).push({ checkout_session_id: 'cs_1', user_id: 'u-invite', project_key: 'exp-abc123' });
    expect((await call(dawListen, mix, INVITE)).status).toBe(200);
  });
});
