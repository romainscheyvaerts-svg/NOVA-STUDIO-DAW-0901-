/**
 * Test local de supabase/nova_feedback.sql (et du retour arrière) dans un vrai
 * Postgres en WebAssembly (PGlite), avec une imitation minimale de Supabase :
 * rôles anon / authenticated / service_role, auth.uid(), auth.role(), en-têtes
 * de requête, schéma storage. Aucune base distante n'est touchée.
 *
 * PGlite n'est pas une dépendance du projet : installe-le à part, puis
 *   PGLITE=<dossier>/node_modules/@electric-sql/pglite/dist/index.js node supabase/tests/nova_feedback.pglite.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = process.env.PGLITE ? pathToFileURL(process.env.PGLITE).href : '@electric-sql/pglite';
const { PGlite } = await import(mod);
const db = new PGlite();

const migration = readFileSync(path.join(here, '..', 'nova_feedback.sql'), 'utf8');
const rollback = readFileSync(path.join(here, '..', 'nova_feedback_rollback.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`OK   ${label}`); } else { fail++; console.log(`KO   ${label} ${extra}`); }
};

// --- Imitation de Supabase ------------------------------------------------------------
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
  create function auth.role() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  -- Comme Supabase : tous les droits par défaut sur les nouvelles tables de public.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, created_at timestamptz default now());
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated, service_role;
  grant all on storage.objects to anon, authenticated, service_role;
  grant select on storage.buckets to anon, authenticated, service_role;
  insert into storage.buckets values ('autre', 'autre', true, null, null);
  insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
`);

// --- Migration (deux fois : idempotente) ---------------------------------------------------
await db.exec(migration);
await db.exec(migration);
ok(true, 'migration appliquée deux fois sans erreur');

const DEV_A = 'a'.repeat(32), DEV_B = 'b'.repeat(32);
const USER_A = '11111111-1111-1111-1111-111111111111', USER_B = '22222222-2222-2222-2222-222222222222';
const ALPH = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
let refN = 0;
const ref = () => { let n = refN++, s = ''; for (let i = 0; i < 8; i++) { s = ALPH[n % ALPH.length] + s; n = Math.floor(n / ALPH.length); } return s; };

/** Exécute en tant que `role` (jeton imité), renvoie { rows } ou { error }. */
const as = async (role, sql, params = [], { sub = null, ip = '203.0.113.7' } = {}) => {
  const claims = JSON.stringify({ role, ...(sub ? { sub } : {}) });
  const headers = JSON.stringify(ip ? { 'x-forwarded-for': `${ip}, 10.0.0.1` } : {});
  try {
    await db.query(`select set_config('request.jwt.claims', $1, false), set_config('request.headers', $2, false)`, [claims, headers]);
    await db.exec(`set role ${role}`);
    const res = await db.query(sql, params);
    return { rows: res.rows };
  } catch (e) {
    return { error: e };
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '', false), set_config('request.headers', '', false)`);
  }
};
const insert = (role, cols, opts) => {
  const row = { ref: ref(), device_id: DEV_A, category: 'bug', title: 'Le son coupe', description: '', context: '{}', ...cols };
  const keys = Object.keys(row);
  return as(role, `insert into public.nova_feedback (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map(k => row[k]), opts);
};
const code = r => r.error?.code || '';

// --- Insertion -----------------------------------------------------------------------------
let r = await insert('anon', { title: 'Le son coupe quand j’enregistre', email: 'artiste@exemple.com', frequency: 'parfois', context: JSON.stringify({ nova: { version: '2026.10.07' } }) });
ok(!r.error, 'anon peut insérer un signalement', r.error?.message);

r = await insert('anon', { status: 'corrige' });
ok(code(r) === '42501', 'anon ne peut pas choisir le statut (droit de colonne)', code(r));
r = await insert('anon', { admin_note: 'x' });
ok(code(r) === '42501', 'anon ne peut pas écrire la note admin', code(r));
r = await insert('anon', { user_id: USER_B });
ok(code(r) === '42501', 'anon ne peut pas se faire passer pour un compte (user_id)', code(r));

const all = async () => (await db.query('select * from public.nova_feedback order by created_at, ref')).rows;
let rows = await all();
ok(rows.length === 1 && rows[0].status === 'recu' && rows[0].user_id === null, 'ligne anonyme : statut « recu », sans compte');

// --- Lecture / modification / suppression ----------------------------------------------------
r = await as('anon', 'select * from public.nova_feedback');
ok(code(r) === '42501', 'anon ne peut rien lire', code(r));
r = await as('anon', 'select ref from public.nova_feedback');
ok(code(r) === '42501', 'anon ne peut pas lire même une colonne', code(r));
r = await as('anon', `update public.nova_feedback set status = 'corrige'`);
ok(code(r) === '42501', 'anon ne peut pas modifier', code(r));
r = await as('anon', 'delete from public.nova_feedback');
ok(code(r) === '42501', 'anon ne peut pas supprimer', code(r));

// --- Comptes -----------------------------------------------------------------------------
r = await insert('authenticated', { device_id: DEV_B, title: 'Idée de A', category: 'idee' }, { sub: USER_A });
ok(!r.error, 'un compte peut insérer', r.error?.message);
rows = await all();
const rowA = rows.find(x => x.title === 'Idée de A');
ok(rowA?.user_id === USER_A, 'user_id rempli automatiquement avec auth.uid()');

r = await as('authenticated', 'select ref, title, status, fixed_in_version from public.nova_feedback', [], { sub: USER_A });
ok(!r.error && r.rows.length === 1 && r.rows[0].title === 'Idée de A', 'A ne lit que ses signalements', r.error?.message || JSON.stringify(r.rows));
r = await as('authenticated', 'select ref from public.nova_feedback', [], { sub: USER_B });
ok(!r.error && r.rows.length === 0, 'B ne voit pas ceux de A ni les anonymes');
r = await as('authenticated', 'select admin_note from public.nova_feedback', [], { sub: USER_A });
ok(code(r) === '42501', 'la note admin reste cachée même au propriétaire', code(r));
r = await as('authenticated', 'select description, context, email from public.nova_feedback', [], { sub: USER_A });
ok(code(r) === '42501', 'description / contexte / e-mail non relisibles depuis l’appli', code(r));
r = await as('authenticated', `update public.nova_feedback set status = 'corrige'`, [], { sub: USER_A });
ok(code(r) === '42501', 'un compte ne peut pas modifier', code(r));
r = await as('authenticated', 'delete from public.nova_feedback', [], { sub: USER_A });
ok(code(r) === '42501', 'un compte ne peut pas supprimer', code(r));

// --- Contraintes ---------------------------------------------------------------------------
r = await insert('anon', { title: 'x'.repeat(121) });
ok(code(r) === '23514', 'titre de plus de 120 caractères refusé', code(r));
r = await insert('anon', { title: 'ab' });
ok(code(r) === '23514', 'titre trop court refusé', code(r));
r = await insert('anon', { description: 'x'.repeat(5001) });
ok(code(r) === '23514', 'description de plus de 5000 caractères refusée', code(r));
r = await insert('anon', { context: JSON.stringify({ gros: 'x'.repeat(70000) }) });
ok(code(r) === '23514', 'contexte de plus de 64 Ko refusé', code(r));
r = await insert('anon', { context: '[1,2]' });
ok(code(r) === '23514', 'contexte qui n’est pas un objet refusé', code(r));
r = await insert('anon', { email: 'pas-un-email' });
ok(code(r) === '23514', 'e-mail invalide refusé', code(r));
r = await insert('anon', { category: 'spam' });
ok(code(r) === '23514', 'catégorie inconnue refusée', code(r));
r = await insert('anon', { ref: 'abc' });
ok(code(r) === '23514', 'numéro de suivi mal formé refusé', code(r));
r = await insert('anon', { device_id: 'nimporte quoi' });
ok(code(r) === '23514', 'identifiant d’appareil mal formé refusé', code(r));
r = await insert('anon', { screenshot_path: '../../etc/passwd' });
ok(code(r) === '23514', 'chemin de capture hors format refusé', code(r));
const dupRef = rows[0].ref;
r = await insert('anon', { ref: dupRef });
ok(code(r) === '23505', 'même numéro renvoyé = doublon refusé (23505)', code(r));

// --- Anti-spam -----------------------------------------------------------------------------
await db.exec('delete from public.nova_feedback; delete from public.nova_feedback_rate;');
const DEV_C = 'c'.repeat(32);
let okCount = 0, lastErr = null;
for (let i = 0; i < 11; i++) {
  const x = await insert('anon', { device_id: DEV_C }, { ip: `198.51.100.${i}` });
  if (!x.error) okCount++; else lastErr = x.error;
}
ok(okCount === 10 && /nova_feedback_rate_limit: appareil/.test(lastErr?.message || ''), '10 par heure et par appareil, le 11e est refusé', `${okCount} ${lastErr?.message}`);

await db.exec('delete from public.nova_feedback; delete from public.nova_feedback_rate;');
okCount = 0; lastErr = null;
for (let i = 0; i < 21; i++) {
  const dev = (i.toString(16).padStart(2, '0')).repeat(16);
  const x = await insert('anon', { device_id: dev }, { ip: '192.0.2.50' });
  if (!x.error) okCount++; else lastErr = x.error;
}
ok(okCount === 20 && /nova_feedback_rate_limit: ip/.test(lastErr?.message || ''), '20 par heure et par adresse IP, même en changeant d’appareil', `${okCount} ${lastErr?.message}`);
const rate = (await db.query('select key from public.nova_feedback_rate')).rows;
ok(rate.length > 0 && rate.every(x => /^ip:[a-f0-9]{32}$/.test(x.key)) && !rate.some(x => x.key.includes('192.0.2.50')), 'adresse IP gardée seulement hachée');
r = await as('anon', 'select * from public.nova_feedback_rate');
ok(code(r) === '42501', 'compteurs anti-spam illisibles pour anon', code(r));

await db.exec('delete from public.nova_feedback; delete from public.nova_feedback_rate;');
okCount = 0; lastErr = null;
for (let i = 0; i < 21; i++) {
  const dev = (i.toString(16).padStart(2, '0')).repeat(16);
  const x = await insert('authenticated', { device_id: dev }, { sub: USER_A, ip: `198.51.100.${i}` });
  if (!x.error) okCount++; else lastErr = x.error;
}
ok(okCount === 20 && /nova_feedback_rate_limit: compte/.test(lastErr?.message || ''), '20 par heure et par compte', `${okCount} ${lastErr?.message}`);

// Une heure plus tard, ça repasse.
await db.exec(`update public.nova_feedback set created_at = now() - interval '2 hours'; delete from public.nova_feedback_rate;`);
r = await insert('authenticated', { device_id: DEV_C }, { sub: USER_A });
ok(!r.error, 'une heure plus tard, la limite est levée', r.error?.message);

// Limite globale (300 / h) : on simule 300 lignes récentes.
await db.exec(`delete from public.nova_feedback;
  insert into public.nova_feedback (ref, device_id, category, title)
  select upper(translate(substr(md5(g::text), 1, 8), '01abcdef', '23abcdef')), md5(g::text), 'idee', 'charge ' || g from generate_series(1, 300) g;`);
r = await insert('anon', { device_id: DEV_B }, { ip: '203.0.113.99' });
ok(/nova_feedback_rate_limit: global/.test(r.error?.message || ''), 'limite globale de 300 par heure', r.error?.message);
await db.exec('delete from public.nova_feedback; delete from public.nova_feedback_rate;');

// --- Statut pour les invités (fonction) --------------------------------------------------------
const r1 = ref(), r2 = ref();
await insert('anon', { ref: r1, device_id: DEV_A });
await insert('anon', { ref: r2, device_id: DEV_B });
await db.exec(`update public.nova_feedback set status = 'corrige', fixed_in_version = '2026.10.08' where ref = '${r1}'`);
r = await as('anon', 'select * from public.nova_feedback_statuts($1, $2)', [DEV_A, [r1, r2]]);
ok(!r.error && r.rows.length === 1 && r.rows[0].ref === r1 && r.rows[0].status === 'corrige' && r.rows[0].fixed_in_version === '2026.10.08',
  'invité : statut de ses signalements (cet appareil seulement)', r.error?.message || JSON.stringify(r.rows));
r = await as('anon', 'select * from public.nova_feedback_statuts($1, $2)', ['nimporte', [r1, r2]]);
ok(!r.error && r.rows.length === 0, 'identifiant d’appareil invalide : rien');

// --- service_role ------------------------------------------------------------------------------
r = await as('service_role', 'select ref, description, admin_note, context from public.nova_feedback');
ok(!r.error && r.rows.length === 2, 'service_role lit tout', r.error?.message);
r = await as('service_role', `update public.nova_feedback set status = 'en_cours', admin_note = 'vu' where ref = $1`, [r2]);
ok(!r.error, 'service_role peut changer le statut', r.error?.message);
r = await as('service_role', `insert into public.nova_feedback (ref, device_id, category, title, status) values ($1, $2, 'bug', 'test admin', 'en_cours')`, [ref(), DEV_A]);
ok(!r.error, 'service_role insère sans contrainte de statut', r.error?.message);

// --- Captures (storage) ----------------------------------------------------------------------
const bucket = (await db.query(`select * from storage.buckets where id = 'nova-feedback'`)).rows[0];
ok(bucket && bucket.public === false && Number(bucket.file_size_limit) === 2097152 && bucket.allowed_mime_types.join() === 'image/jpeg,image/png,image/webp', 'bucket privé, 2 Mo, images seulement');
const up = (name, b = 'nova-feedback', opts) => as('anon', 'insert into storage.objects (bucket_id, name) values ($1, $2)', [b, name], opts);
r = await up(`${DEV_A}/${ref()}.jpg`);
ok(!r.error, 'anon peut envoyer une capture au bon format', r.error?.message);
r = await up(`${DEV_A}/../../secret.jpg`);
ok(code(r) === '42501', 'nom de fichier hors format refusé', code(r));
r = await up(`${DEV_A}/${ref()}.svg`);
ok(code(r) === '42501', 'extension non image refusée', code(r));
r = await up(`${DEV_A}/${ref()}.jpg`, 'autre');
ok(code(r) === '42501', 'la policy ne s’applique qu’au bucket nova-feedback', code(r));
okCount = 1;
for (let i = 0; i < 10; i++) { const x = await up(`${DEV_A}/${ref()}.jpg`); if (!x.error) okCount++; }
ok(okCount === 10, '10 captures par heure et par appareil', String(okCount));
r = await as('anon', `select name from storage.objects where bucket_id = 'nova-feedback'`);
ok(!r.error && r.rows.length === 0, 'anon ne peut pas lister / lire les captures');
r = await as('anon', `delete from storage.objects where bucket_id = 'nova-feedback'`);
ok(!r.error && (await db.query(`select count(*)::int n from storage.objects where bucket_id = 'nova-feedback'`)).rows[0].n === 10, 'anon ne peut pas supprimer les captures');

// --- Retour arrière ----------------------------------------------------------------------------
await db.exec(rollback);
let left = (await db.query(`select
  (select count(*) from pg_tables where schemaname = 'public' and tablename like 'nova_feedback%')::int t,
  (select count(*) from pg_proc where proname like 'nova_feedback%')::int f,
  (select count(*) from pg_policies where policyname like 'nova_feedback%')::int p,
  (select count(*) from storage.buckets where id = 'nova-feedback')::int b`)).rows[0];
ok(left.t === 0 && left.f === 0 && left.p === 0 && left.b === 1, 'retour arrière : tables, fonctions, policies retirées ; bucket non vide gardé', JSON.stringify(left));
await db.exec(`delete from storage.objects where bucket_id = 'nova-feedback'`);
await db.exec(rollback);
left = (await db.query(`select count(*)::int b from storage.buckets where id = 'nova-feedback'`)).rows[0];
ok(left.b === 0, 'retour arrière relancé : bucket vide retiré');
await db.exec(migration);
ok(true, 'la migration se réapplique après le retour arrière');

console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
