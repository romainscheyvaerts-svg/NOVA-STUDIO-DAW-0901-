/**
 * Test local de supabase/migrations/20261014120000_nova_tarifs.sql dans un vrai Postgres en
 * WebAssembly (PGlite), sur une copie minimale des tables du site (supabase/schema-site +
 * instrumental_purchases), avec une imitation de Supabase (rôles, auth.uid()). Aucune base
 * distante n'est touchée.
 *
 * PGlite n'est pas une dépendance du projet : installe-le à part, puis
 *   PGLITE=<dossier>/node_modules/@electric-sql/pglite/dist/index.js node supabase/tests/nova_tarifs.pglite.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = process.env.PGLITE ? pathToFileURL(process.env.PGLITE).href : '@electric-sql/pglite';
const { PGlite } = await import(mod);
const db = new PGlite();

const migration = readFileSync(path.join(here, '..', 'migrations', '20261014120000_nova_tarifs.sql'), 'utf8');
const billing = readFileSync(path.join(here, '..', 'schema-site', '20261003100000_nova_billing.sql'), 'utf8');


let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`OK   ${label}`); } else { fail++; console.log(`KO   ${label} ${extra}`); }
};
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  insert into auth.users values ('${A}'), ('${B}');
  create table public.instrumental_purchases (
    id uuid primary key default gen_random_uuid(), user_id uuid not null, instrumental_id uuid not null,
    license_id uuid not null, amount_paid numeric not null default 0, payment_method text, created_at timestamptz not null default now());
`);
// Tables existantes du site (copie de référence), comme en production avant la migration.
// daw_sessions (forme de schema-site/20261002180000 sans le stockage, absent de PGlite).
await db.exec(`create table public.daw_sessions (id text primary key, secret_hash text not null, secret text, name text not null default 'Session',
  owner_id uuid references auth.users(id) on delete set null, version integer not null default 0, manifest jsonb, total_bytes bigint not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_from text);`);
await db.exec(billing);
await db.exec(`insert into public.nova_subscriptions (stripe_subscription_id, user_id, plan, status) values ('sub_old', '${A}', 'collab', 'active');
               insert into public.nova_purchases (checkout_session_id, kind, project_key, amount_cents) values ('cs_old', 'export_voices', 'projet-1', 200);`);
const avant = (await db.query(`select count(*)::int n from public.daw_sessions`)).rows[0].n;
await db.exec(`insert into public.daw_sessions (id, secret_hash, name) values ('abcdefabcdef', repeat('a', 64), 'Ancien')`);

await db.exec(migration);
await db.exec(migration);
ok(true, 'migration appliquée deux fois sans erreur (idempotente)');

const sub = (await db.query(`select interval from public.nova_subscriptions where stripe_subscription_id = 'sub_old'`)).rows[0];
ok(sub.interval === 'month', 'abonnement existant : intervalle « month » par défaut (prix Stripe inchangé)');
let refuse = false;
try { await db.exec(`update public.nova_subscriptions set interval = 'week'`); } catch { refuse = true; }
ok(refuse, 'intervalle limité à month / year');

await db.exec(`insert into public.nova_purchases (checkout_session_id, kind, project_key, amount_cents) values ('cs_new', 'export_project', 'projet-2', 199)`);
ok(true, 'achat « export_project » accepté');
refuse = false;
try { await db.exec(`insert into public.nova_purchases (checkout_session_id, kind, project_key, amount_cents) values ('cs_bad', 'session_keep', 'projet-3', 50)`); } catch { refuse = true; }
ok(refuse, "ancienne idée « 0,50 € / 5 jours » (session_keep) refusée");

const cols = (await db.query(`select column_name from information_schema.columns where table_name = 'daw_sessions' and column_name in ('expires_at','studio_gift','expiry_warned_at') order by 1`)).rows.map(r => r.column_name);
ok(cols.join(',') === 'expires_at,expiry_warned_at,studio_gift', 'daw_sessions : expires_at, studio_gift, expiry_warned_at', cols.join(','));
const anciens = (await db.query(`select count(*)::int n from public.daw_sessions where expires_at is not null`)).rows[0].n;
ok(anciens === 0, 'projets déjà en ligne : aucune expiration rétroactive', String(anciens));

await db.exec(`insert into public.nova_pro_gifts (id, user_id, source, days) values ('studio-a-2026-10-14', '${A}', 'studio', 30), ('manuel-b', '${B}', 'manuel', 7)`);
refuse = false;
try { await db.exec(`insert into public.nova_pro_gifts (id, user_id, source, days) values ('x-1', '${A}', 'studio', 0)`); } catch { refuse = true; }
ok(refuse, 'cadeau de 0 jour refusé');

const as = async (role, sql, sub = null) => {
  const claims = JSON.stringify({ role, ...(sub ? { sub } : {}) });
  await db.exec(`set role ${role}; select set_config('request.jwt.claims', '${claims}', false);`);
  try { return await db.query(sql); } finally { await db.exec(`reset role;`); }
};
const mine = await as('authenticated', `select id from public.nova_pro_gifts`, A);
ok(mine.rows.length === 1 && mine.rows[0].id === 'studio-a-2026-10-14', 'un compte lit SES cadeaux seulement', JSON.stringify(mine.rows));
let ecrit = false;
try { await as('authenticated', `insert into public.nova_pro_gifts (id, user_id, source, days) values ('triche', '${A}', 'manuel', 300)`, A); ecrit = true; } catch { /* refusé */ }
ok(!ecrit, 'un compte ne peut pas s’offrir de cadeau');
let anon = null;
try { anon = await as('anon', `select id from public.nova_pro_gifts`); } catch { anon = { rows: [] }; }
ok(anon.rows.length === 0, 'anonyme : rien');

// Retour arrière (bloc en tête de la migration).
await db.exec(`
  drop table if exists public.nova_pro_gifts;
  alter table public.daw_sessions drop column if exists expiry_warned_at;
  alter table public.daw_sessions drop column if exists studio_gift;
  alter table public.daw_sessions drop column if exists expires_at;
  delete from public.nova_purchases where kind = 'export_project';
  alter table public.nova_purchases drop constraint if exists nova_purchases_kind_check;
  alter table public.nova_purchases add constraint nova_purchases_kind_check check (kind in ('export_voices'));
  alter table public.nova_subscriptions drop column if exists interval;
`);
const reste = (await db.query(`select count(*)::int n from public.nova_purchases`)).rows[0].n;
ok(reste === 1, 'retour arrière appliqué, achats de l’ancienne grille intacts', String(reste));
void avant;

console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
