/**
 * Grille Nova du 14/10/2026 : la source unique (supabase/functions/_shared/novaTarifs.ts)
 * et ce que nova-billing, daw-session et daw-session-purge en font, chargés TELS QUELS
 * avec un faux Supabase et un faux Stripe (alias de vitest.config.ts). Aucun réseau.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDb, setCurrentDb, type FakeDb } from './fakes/supabase';
import { lastHandler } from './fakes/denoServe';
import { resetStripe, stripeState } from './fakes/stripe';
import {
  TARIFS, economieAnnuelle, grillePublique, cadeauPourAchat, friseCadeaux, decisionExport, droitMelodieOfferte, JOUR_MS,
} from '../functions/_shared/novaTarifs';

(globalThis as any).Deno = { env: { get: (k: string) => ({ SUPABASE_URL: 'http://fake.local', SUPABASE_SERVICE_ROLE_KEY: 'service', STRIPE_SECRET_KEY: 'sk_test', NOVA_PURGE_KEY: 'cle-menage' } as Record<string, string>)[k] } };

type Handler = (req: Request) => Promise<Response> | Response;
let dawSession: Handler;
let novaBilling: Handler;
let purge: Handler;

beforeAll(async () => {
  await import('../functions/daw-session/index.ts');
  dawSession = lastHandler();
  await import('../functions/nova-billing/index.ts');
  novaBilling = lastHandler();
  await import('../functions/daw-session-purge/index.ts');
  purge = lastHandler();
});

const NOVA = 'https://nova-studio-daw-0901.vercel.app';
const ret = `${NOVA}/`;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
let db: FakeDb;

beforeEach(() => {
  db = createFakeDb();
  db.users['jwt.artiste.ok'] = { id: 'u-artiste', email: 'artiste@example.com' };
  db.users['jwt.pro.ok'] = { id: 'u-pro', email: 'pro@example.com' };
  db.users['jwt.admin.ok'] = { id: 'u-admin', email: 'studio@example.com' };
  db.tables.user_roles = [{ user_id: 'u-admin', role: 'admin' }];
  db.tables.nova_subscriptions = [{ stripe_subscription_id: 'sub_pro', user_id: 'u-pro', plan: 'collab', status: 'active', interval: 'month', current_period_end: new Date(Date.now() + 20 * JOUR_MS).toISOString(), updated_at: new Date().toISOString() }];
  db.tables.instrumentals = [
    { id: 'beat-1', kind: 'beat', title: 'Nuit blanche' },
    { id: 'beat-2', kind: 'beat', title: 'Soleil' },
    { id: 'melo-1', kind: 'melody', title: 'Guitare douce' },
    { id: 'melo-ex', kind: 'melody', title: 'Piano rare' },
  ];
  db.tables.instrumental_licenses = [
    { id: 'lic-basic', name: 'Basic', price_tier: 'base' },
    { id: 'lic-melody', name: 'Melody', price_tier: 'base' },
    { id: 'lic-melo-ex', name: 'Melody Exclusive', price_tier: 'exclusive' },
  ];
  db.tables.instrumental_purchases = [];
  setCurrentDb(db);
  resetStripe();
});

async function call(h: Handler, body: unknown, opts: { token?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: NOVA, ...(opts.headers || {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await h(new Request('http://fn.local/', { method: 'POST', headers, body: JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const buy = (user: string, inst: string, lic: string, amount: number, ago = 0, method = 'stripe') =>
  db.tables.instrumental_purchases.push({ id: `p-${db.tables.instrumental_purchases.length + 1}`, user_id: user, instrumental_id: inst, license_id: lic, amount_paid: amount, payment_method: method, created_at: iso(ago) });
const access = (body: Record<string, unknown>, token?: string) =>
  call(novaBilling, { action: 'export_access', project_key: 'projet-abc', ...body }, { token });

describe('source unique des prix (_shared/novaTarifs.ts)', () => {
  it('grille : 1,99 € l’export, 9,99 €/mois, 89 €/an (30,88 € économisés), cadeaux 30 j / 7 j / 30 j / 30 j', () => {
    expect([TARIFS.export_cents, TARIFS.pro_mois_cents, TARIFS.pro_an_cents]).toEqual([199, 999, 8900]);
    expect(economieAnnuelle()).toEqual({ cents: 3088, pourcent: 26, mois_offerts: 3 });
    const g = grillePublique();
    expect(g.version).toBe('2026-10-14');
    expect(g.gratuit).toMatchObject({ export: false, projets_en_ligne: 1, projet_jours: 7, extrait_secondes: 30 });
    expect(g.cadeaux).toEqual({ instru_jours: 30, melodie_jours: 7, melodie_exclusive_jours: 30, studio_jours: 30 });
    expect(JSON.stringify(g)).not.toMatch(/0,5|garder|50\b/); // plus de « 0,50 € / 5 jours »
  });

  it('cadeau par achat : instru 1 mois, mélodie 7 jours, Melody Exclusive 1 mois ; rien pour un téléchargement offert', () => {
    const base = { id: 'x', created_at: new Date().toISOString(), payment_method: 'stripe' };
    expect(cadeauPourAchat({ ...base, amount_paid: 29, kind: 'beat' })).toMatchObject({ source: 'instru', days: 30 });
    expect(cadeauPourAchat({ ...base, amount_paid: 3, kind: 'melody', price_tier: 'base', license_name: 'Melody' })).toMatchObject({ source: 'melodie', days: 7 });
    expect(cadeauPourAchat({ ...base, amount_paid: 5, kind: 'melody', license_name: 'Melody + MIDI' })).toMatchObject({ source: 'melodie', days: 7 });
    expect(cadeauPourAchat({ ...base, amount_paid: 149, kind: 'melody', price_tier: 'exclusive', license_name: 'Melody Exclusive' })).toMatchObject({ source: 'melodie_exclusive', days: 30 });
    expect(cadeauPourAchat({ ...base, amount_paid: 0, kind: 'beat', payment_method: 'trusted_user_free' })).toBeNull();
    expect(cadeauPourAchat({ ...base, amount_paid: 3, kind: 'melody', payment_method: 'nova_pro_monthly' })).toBeNull();
  });

  it('les cadeaux se cumulent bout à bout ; un trou recommence une nouvelle chaîne', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    const day = (d: number) => new Date(now + d * JOUR_MS).toISOString();
    const deux = friseCadeaux([
      { ref: 'a', source: 'instru', days: 30, starts_at: day(-1) },
      { ref: 'b', source: 'instru', days: 30, starts_at: day(-1) },
    ], now);
    expect(deux).toMatchObject({ active: true, days_left: 59, total_days: 60 });
    const trou = friseCadeaux([
      { ref: 'vieux', source: 'instru', days: 30, starts_at: day(-100) },
      { ref: 'neuf', source: 'melodie', days: 7, starts_at: day(-2) },
    ], now);
    expect(trou).toMatchObject({ active: true, days_left: 5, total_days: 7 });
    expect(trou.en_cours.map(c => c.ref)).toEqual(['neuf']);
    expect(friseCadeaux([{ ref: 'fini', source: 'melodie', days: 7, starts_at: day(-8) }], now).active).toBe(false);
  });

  it("décision d'export : admin > instru non achetée (refus, même Pro) > Pro > projet payé > licence (sauf kits) > 1,99 €", () => {
    const off = { admin: false, pro: false, projetPaye: false, kits: false, portee: 'mix' as const };
    expect(decisionExport({ ...off, catalogue: [] })).toMatchObject({ unlocked: false, reason: 'paiement' }); // gratuit : pas d'export
    expect(decisionExport({ ...off, pro: true, catalogue: [{ id: 'b', owned: false }] })).toMatchObject({ unlocked: false, reason: 'catalogue_non_achete' });
    expect(decisionExport({ ...off, projetPaye: true, catalogue: [{ id: 'b', owned: false }] }).reason).toBe('catalogue_non_achete');
    expect(decisionExport({ ...off, admin: true, catalogue: [{ id: 'b', owned: false }] })).toMatchObject({ unlocked: true, via: 'admin' });
    expect(decisionExport({ ...off, pro: true, catalogue: [] })).toMatchObject({ unlocked: true, via: 'pro' });
    expect(decisionExport({ ...off, projetPaye: true, catalogue: [] })).toMatchObject({ unlocked: true, via: 'achat' });
    expect(decisionExport({ ...off, catalogue: [{ id: 'b', owned: true }] })).toMatchObject({ unlocked: true, via: 'licence' });
    expect(decisionExport({ ...off, kits: true, catalogue: [{ id: 'b', owned: true }] })).toMatchObject({ unlocked: false, reason: 'paiement' });
    // Mes pistes seules (sans l'instru) : possible en payant même si l'instru n'est pas achetée.
    expect(decisionExport({ ...off, portee: 'voix', catalogue: [{ id: 'b', owned: false }] }).reason).toBe('paiement');
    expect(decisionExport({ ...off, portee: 'voix', pro: true, catalogue: [{ id: 'b', owned: false }] })).toMatchObject({ unlocked: true, via: 'pro' });
  });
});

describe('nova-billing · grille du 14/10', () => {
  it('« pricing » est public et vient de la source unique', async () => {
    const r = await call(novaBilling, { action: 'pricing' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual(grillePublique());
    expect(db.writes).toHaveLength(0);
  });

  it('Nova Pro mensuel 9,99 € et annuel 89 € (price_data, intervalle « year ») ; export 1,99 €', async () => {
    await call(novaBilling, { action: 'checkout', product: 'pro_month', return_url: ret }, { token: 'jwt.artiste.ok' });
    await call(novaBilling, { action: 'checkout', product: 'pro_year', return_url: ret }, { token: 'jwt.artiste.ok' });
    await call(novaBilling, { action: 'checkout', product: 'export_project', project_key: 'projet-abc', return_url: ret }, { token: 'jwt.artiste.ok' });
    const [m, y, e] = stripeState.created;
    expect(m.line_items[0].price_data).toMatchObject({ unit_amount: 999, recurring: { interval: 'month' } });
    expect(y.line_items[0].price_data).toMatchObject({ unit_amount: 8900, recurring: { interval: 'year' } });
    expect(y.subscription_data.metadata).toMatchObject({ nova_plan: 'collab', nova_interval: 'year' });
    expect(e).toMatchObject({ mode: 'payment', metadata: { nova_purchase: 'export_project', project_key: 'projet-abc' } });
    expect(e.line_items[0].price_data.unit_amount).toBe(199);
  });

  it("l'export à 1,99 € est refusé (409) si une instru du catalogue du projet n'est pas achetée", async () => {
    const r = await call(novaBilling, { action: 'checkout', product: 'export_project', project_key: 'projet-abc', catalog_ids: ['beat-1'], return_url: ret }, { token: 'jwt.artiste.ok' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ reason: 'catalogue_non_achete', missing: ['beat-1'] });
    expect(stripeState.created).toHaveLength(0);
    // Mes pistes seules : accepté.
    expect((await call(novaBilling, { action: 'checkout', product: 'export_project', project_key: 'projet-abc', catalog_ids: ['beat-1'], scope: 'voix', return_url: ret }, { token: 'jwt.artiste.ok' })).status).toBe(200);
  });

  it('gratuit : pas d’export ; offre 1,99 € ou Nova Pro 9,99 € ; sans compte : connexion demandée', async () => {
    const r = await access({}, 'jwt.artiste.ok');
    expect(r.json).toMatchObject({ unlocked: false, reason: 'paiement', offers: { export_cents: 199, pro_mois_cents: 999, pro_an_cents: 8900 } });
    const anon = await access({ catalog_ids: ['beat-1'] });
    expect(anon.json).toMatchObject({ unlocked: false, reason: 'catalogue_non_achete', login_required: true });
    expect(anon.json.missing).toEqual([{ id: 'beat-1', title: 'Nuit blanche', kind: 'beat' }]);
  });

  it('export payé 1,99 € → exports illimités de CE projet seulement', async () => {
    const c = await call(novaBilling, { action: 'checkout', product: 'export_project', project_key: 'projet-abc', return_url: ret }, { token: 'jwt.artiste.ok' });
    Object.assign(stripeState.sessions[c.json.session_id], { payment_status: 'paid', amount_total: 199 });
    expect((await call(novaBilling, { action: 'verify', session_id: c.json.session_id })).json).toMatchObject({ paid: true, kind: 'export_project' });
    expect(db.tables.nova_purchases[0]).toMatchObject({ kind: 'export_project', amount_cents: 199, user_id: 'u-artiste' });
    expect((await access({}, 'jwt.artiste.ok')).json).toMatchObject({ unlocked: true, via: 'achat' });
    expect((await access({}, 'jwt.artiste.ok')).json.unlocked).toBe(true); // re-export gratuit
    expect((await call(novaBilling, { action: 'export_access', project_key: 'autre-projet' }, { token: 'jwt.artiste.ok' })).json.unlocked).toBe(false);
  });

  it('Nova Pro : exports illimités ; mais jamais une instru du catalogue non achetée dans le mix', async () => {
    expect((await access({}, 'jwt.pro.ok')).json).toMatchObject({ unlocked: true, via: 'pro' });
    expect((await access({ catalog_ids: ['beat-1'] }, 'jwt.pro.ok')).json).toMatchObject({ unlocked: false, reason: 'catalogue_non_achete' });
    expect((await access({ catalog_ids: ['beat-1'], scope: 'voix' }, 'jwt.pro.ok')).json).toMatchObject({ unlocked: true, via: 'pro' });
  });

  it('instru achetée : export du projet offert + 1 mois de Nova Pro (les mois se cumulent)', async () => {
    buy('u-artiste', 'beat-1', 'lic-basic', 29, 3600_000);
    const r = await access({ catalog_ids: ['beat-1'] }, 'jwt.artiste.ok');
    // Le mois offert rend aussi Pro : la voie « pro » prime, l'export est offert dans tous les cas.
    expect(r.json.unlocked).toBe(true);
    let st = (await call(novaBilling, { action: 'status' }, { token: 'jwt.artiste.ok' })).json;
    expect(st.pro).toMatchObject({ active: true, source: 'cadeau', paid: false });
    expect(st.pro.cadeau).toMatchObject({ active: true, days_left: 30, total_days: 30 });
    expect(st.pro.cadeau.sources).toEqual([{ source: 'instru', days: 30, label: 'Nuit blanche' }]);
    buy('u-artiste', 'beat-2', 'lic-basic', 29, 1800_000);
    st = (await call(novaBilling, { action: 'status' }, { token: 'jwt.artiste.ok' })).json;
    expect(st.pro.cadeau).toMatchObject({ days_left: 60, total_days: 60 });
    expect(st.melodie_offerte).toMatchObject({ droit: true, restantes: 1 });
  });

  it('licence achetée mais Pro offert fini : export du projet toujours offert (voie « licence »)', async () => {
    buy('u-artiste', 'beat-1', 'lic-basic', 29, 40 * JOUR_MS);
    expect((await call(novaBilling, { action: 'status' }, { token: 'jwt.artiste.ok' })).json.pro.active).toBe(false);
    expect((await access({ catalog_ids: ['beat-1'] }, 'jwt.artiste.ok')).json).toMatchObject({ unlocked: true, via: 'licence' });
    // Avec les kits de batterie NOVA : jamais d'export gratuit.
    expect((await access({ catalog_ids: ['beat-1'], kits: true }, 'jwt.artiste.ok')).json).toMatchObject({ unlocked: false, reason: 'paiement', kits: true });
    // Une autre instru du catalogue, non achetée, dans le même projet : refus.
    expect((await access({ catalog_ids: ['beat-1', 'beat-2'] }, 'jwt.artiste.ok')).json).toMatchObject({ unlocked: false, reason: 'catalogue_non_achete', missing: [{ id: 'beat-2', title: 'Soleil', kind: 'beat' }] });
  });

  it('mélodie à 3 € : 7 jours (pas de mélodie du mois) ; Melody Exclusive : 1 mois', async () => {
    buy('u-artiste', 'melo-1', 'lic-melody', 3);
    let st = (await call(novaBilling, { action: 'status' }, { token: 'jwt.artiste.ok' })).json;
    expect(st.pro.cadeau).toMatchObject({ active: true, days_left: 7 });
    expect(st.melodie_offerte).toMatchObject({ droit: false, restantes: 0 });
    expect((await call(novaBilling, { action: 'melody_perk' }, { token: 'jwt.artiste.ok' })).json.allowed).toBe(false);
    buy('u-artiste', 'melo-ex', 'lic-melo-ex', 149);
    st = (await call(novaBilling, { action: 'status' }, { token: 'jwt.artiste.ok' })).json;
    expect(st.pro.cadeau).toMatchObject({ days_left: 37 });
    expect(st.melodie_offerte.droit).toBe(true);
  });

  it('Nova Pro payant : 1 mélodie offerte par mois (décomptée sur les achats « nova_pro_monthly » du mois)', async () => {
    let p = (await call(novaBilling, { action: 'melody_perk' }, { token: 'jwt.pro.ok' })).json;
    expect(p).toMatchObject({ allowed: true, restantes: 1, method: 'nova_pro_monthly' });
    buy('u-pro', 'melo-1', 'lic-melody', 0, 0, 'nova_pro_monthly');
    p = (await call(novaBilling, { action: 'melody_perk' }, { token: 'jwt.pro.ok' })).json;
    expect(p).toMatchObject({ allowed: false, restantes: 0 });
    expect((await call(novaBilling, { action: 'melody_perk' })).status).toBe(401);
    // La mélodie offerte ne donne pas 7 jours de plus.
    const st = (await call(novaBilling, { action: 'status' }, { token: 'jwt.pro.ok' })).json;
    expect(st.pro).toMatchObject({ source: 'abonnement', paid: true, interval: 'month' });
    expect(st.pro.cadeau.active).toBe(false);
  });

  it('séance au studio payée (même e-mail) : 30 jours de Nova Pro', async () => {
    db.tables.bookings = [{ id: 'bk1', status: 'confirmed', amount_paid: 50, session_date: '2026-10-10', created_at: iso(2 * JOUR_MS), client_email: 'artiste@example.com' }];
    const st = (await call(novaBilling, { action: 'status' }, { token: 'jwt.artiste.ok' })).json;
    expect(st.pro).toMatchObject({ active: true, source: 'cadeau' });
    expect(st.pro.cadeau).toMatchObject({ days_left: 28 });
    db.tables.bookings[0].status = 'cancelled';
    expect((await call(novaBilling, { action: 'status' }, { token: 'jwt.artiste.ok' })).json.pro.active).toBe(false);
  });

  it('admin : tout débloqué, rien écrit', async () => {
    const r = await access({ catalog_ids: ['beat-1'], kits: true }, 'jwt.admin.ok');
    expect(r.json).toMatchObject({ unlocked: true, via: 'admin' });
    expect(db.writes).toHaveLength(0);
  });
});

describe('daw-session · projet en ligne gratuit 7 jours', () => {
  it('gratuit : 1 projet gardé 7 jours ; le 2e est refusé avec un message clair ; Pro : sans limite', async () => {
    const a = await call(dawSession, { action: 'create', name: 'Mon son' }, { token: 'jwt.artiste.ok' });
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ unlimited: false, days_left: 7 });
    expect(Date.parse(a.json.expires_at) - Date.now()).toBeGreaterThan(6.9 * JOUR_MS);
    const b = await call(dawSession, { action: 'create', name: 'Deuxième' }, { token: 'jwt.artiste.ok' });
    expect(b.status).toBe(402);
    expect(b.json.reason).toBe('free_project_limit');
    expect(b.json.error).toMatch(/1 projet en ligne.*« Mon son ».*Nova Pro/);
    // Séance de collaboration : hors limite (l'hôte doit de toute façon avoir Nova Pro).
    expect((await call(dawSession, { action: 'create', name: 'Feat', purpose: 'collab' }, { token: 'jwt.artiste.ok' })).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      const p = await call(dawSession, { action: 'create', name: `Pro ${i}` }, { token: 'jwt.pro.ok' });
      expect(p.json).toMatchObject({ unlimited: true, expires_at: null });
    }
  });

  it("avertissement 2 jours avant, envoi refusé (410) après l'expiration ; Pro : jamais d'expiration", async () => {
    const a = await call(dawSession, { action: 'create', name: 'Bientôt' }, { token: 'jwt.artiste.ok' });
    const row = db.tables.daw_sessions.find(r => r.id === a.json.id);
    row.expires_at = new Date(Date.now() + 1.5 * JOUR_MS).toISOString();
    const info = await call(dawSession, { action: 'info', id: a.json.id, secret: a.json.secret }, { token: 'jwt.artiste.ok' });
    expect(info.json).toMatchObject({ days_left: 2, expiry_warning: true, expired: false, unlimited: false });
    const list = await call(dawSession, { action: 'list_mine' }, { token: 'jwt.artiste.ok' });
    expect(list.json.sessions[0]).toMatchObject({ expiry_warning: true });
    row.expires_at = iso(1000);
    const c = await call(dawSession, { action: 'commit', id: a.json.id, secret: a.json.secret, baseVersion: 0, manifest: { project: {}, files: {} } }, { token: 'jwt.artiste.ok' });
    expect(c.status).toBe(410);
    expect(c.json).toMatchObject({ reason: 'expired' });
    expect(c.json.error).toMatch(/reste enregistré sur cet appareil/);
    // Le propriétaire prend Nova Pro : plus d'expiration, l'envoi repasse.
    db.tables.nova_subscriptions.push({ stripe_subscription_id: 'sub_a', user_id: 'u-artiste', plan: 'collab', status: 'active', current_period_end: null, updated_at: new Date().toISOString() });
    expect((await call(dawSession, { action: 'info', id: a.json.id, secret: a.json.secret }, { token: 'jwt.artiste.ok' })).json).toMatchObject({ unlimited: true, expires_at: null });
    expect((await call(dawSession, { action: 'commit', id: a.json.id, secret: a.json.secret, baseVersion: 0, manifest: { project: {}, files: {} } }, { token: 'jwt.artiste.ok' })).status).toBe(200);
  });

  it('séance donnée par le studio : gardée 30 jours + 30 jours de Nova Pro pour le client', async () => {
    const s = await call(dawSession, { action: 'create', name: 'Séance studio' }, { token: 'jwt.admin.ok' });
    db.rpc.mm_user_id_by_email = () => 'u-artiste';
    const r = await call(dawSession, { action: 'assign', id: s.json.id, secret: s.json.secret, email: 'artiste@example.com' }, { token: 'jwt.admin.ok' });
    expect(r.json).toMatchObject({ ok: true, studio_gift: true, pro_days: 30 });
    expect(db.tables.nova_pro_gifts[0]).toMatchObject({ user_id: 'u-artiste', source: 'studio', days: 30 });
    const st = (await call(novaBilling, { action: 'status' }, { token: 'jwt.artiste.ok' })).json;
    expect(st.pro).toMatchObject({ active: true, source: 'cadeau' });
    expect(st.pro.cadeau.days_left).toBe(30);
    // Même jour, 2e séance attribuée : pas de 2e cadeau.
    await call(dawSession, { action: 'assign', id: s.json.id, secret: s.json.secret, email: 'artiste@example.com' }, { token: 'jwt.admin.ok' });
    expect(db.tables.nova_pro_gifts).toHaveLength(1);
  });
});

describe('daw-session-purge (prévu, pas programmé)', () => {
  const seed = () => {
    db.tables.daw_sessions = [
      { id: 'expiregratuit', owner_id: 'u-artiste', name: 'Vieux', expires_at: iso(JOUR_MS) },
      { id: 'expirepro0000', owner_id: 'u-pro', name: 'Pro', expires_at: iso(JOUR_MS) },
      { id: 'sansfinlibre0', owner_id: 'u-artiste', name: 'Ancien', expires_at: null },
      { id: 'bientot000000', owner_id: 'u-artiste', name: 'Bientôt', expires_at: new Date(Date.now() + JOUR_MS).toISOString() },
    ];
    db.storage['daw-sessions'] = new Map([['expiregratuit/' + 'a'.repeat(40), { size: 10, created_at: iso(0) }]]);
  };

  it('sans la clé : 401 ; par défaut SIMULATION (rien effacé)', async () => {
    seed();
    expect((await call(purge, {})).status).toBe(401);
    expect((await call(purge, {}, { headers: { 'x-purge-key': 'mauvaise' } })).status).toBe(401);
    const r = await call(purge, {}, { headers: { 'x-purge-key': 'cle-menage' } });
    expect(r.json).toMatchObject({ simulation: true, supprimes: 1, gardes_pro: 1, grace_fin_pro: 1, avertis: 1 });
    expect(db.tables.daw_sessions).toHaveLength(4);
    expect(db.writes).toHaveLength(0);
  });

  it('confirm « purge » : efface le projet gratuit expiré, garde celui du Pro, donne 7 jours de grâce, marque l’avertissement', async () => {
    seed();
    const r = await call(purge, { confirm: 'purge' }, { headers: { 'x-purge-key': 'cle-menage' } });
    expect(r.json).toMatchObject({ simulation: false, supprimes: 1 });
    const ids = db.tables.daw_sessions.map(s => s.id);
    expect(ids).not.toContain('expiregratuit');
    expect(db.storage['daw-sessions'].size).toBe(0);
    expect(db.tables.daw_sessions.find(s => s.id === 'expirepro0000').expires_at).toBeNull();
    const grace = Date.parse(db.tables.daw_sessions.find(s => s.id === 'sansfinlibre0').expires_at);
    expect(grace - Date.now()).toBeGreaterThan(6.9 * JOUR_MS);
    expect(db.tables.daw_sessions.find(s => s.id === 'bientot000000').expiry_warned_at).toBeTruthy();
  });
});

describe('droit à la mélodie du mois', () => {
  it('payant ou admin : oui ; Pro offert par une mélodie à 3 € seulement : non', () => {
    const base = { active: true, source: 'cadeau' as const, paid: false, admin: false, interval: null, until: null, beatmaker: false };
    const cad = (src: any) => ({ active: true, until: null, days_left: 5, total_days: 7, en_cours: [{ ref: 'x', source: src, days: 7, starts_at: '' }] });
    expect(droitMelodieOfferte({ ...base, cadeau: cad('melodie') })).toBe(false);
    expect(droitMelodieOfferte({ ...base, cadeau: cad('instru') })).toBe(true);
    expect(droitMelodieOfferte({ ...base, paid: true, cadeau: cad('melodie') })).toBe(true);
  });
});
