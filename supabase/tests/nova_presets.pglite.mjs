/**
 * Test local de supabase/migrations/20261012200000_nova_presets.sql (et du retour
 * arrière supabase/nova_presets_rollback.sql) dans un vrai Postgres en WebAssembly
 * (PGlite), avec une imitation minimale de Supabase : rôles anon / authenticated /
 * service_role, auth.uid(), droits par défaut de Supabase sur public. Aucune base
 * distante n'est touchée.
 *
 * PGlite n'est pas une dépendance du projet : installe-le à part, puis
 *   PGLITE=<dossier>/node_modules/@electric-sql/pglite/dist/index.js node supabase/tests/nova_presets.pglite.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = process.env.PGLITE ? pathToFileURL(process.env.PGLITE).href : '@electric-sql/pglite';
const { PGlite } = await import(mod);
const db = new PGlite();

const migration = readFileSync(path.join(here, '..', 'migrations', '20261012200000_nova_presets.sql'), 'utf8');
const rollback = readFileSync(path.join(here, '..', 'nova_presets_rollback.sql'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`OK   ${label}`); } else { fail++; console.log(`KO   ${label} ${extra}`); }
};

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
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
`);

await db.exec(migration);
await db.exec(migration);
ok(true, 'migration appliquée deux fois sans erreur (idempotente)');

const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
const as = async (role, sql, params = [], sub = null) => {
  const claims = JSON.stringify({ role, ...(sub ? { sub } : {}) });
  try {
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
    await db.exec(`set role ${role}`);
    const res = await db.query(sql, params);
    return { rows: res.rows, affected: res.affectedRows };
  } catch (e) {
    return { error: e };
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
};
const code = r => r.error?.code || '';
// Même requête que le client (supabase-js upsert : on_conflict user_id,preset_id).
const upsert = (sub, row) => as('authenticated', `
  insert into public.nova_presets (user_id, preset_id, kind, name, body, deleted, client_updated_at, device_id)
  values ($1, $2, $3, $4, $5, $6, $7, $8)
  on conflict (user_id, preset_id) do update set kind = excluded.kind, name = excluded.name, body = excluded.body,
    deleted = excluded.deleted, client_updated_at = excluded.client_updated_at, device_id = excluded.device_id`,
  [row.user_id ?? sub, row.preset_id, row.kind ?? 'plugin', row.name ?? 'Voix', JSON.stringify(row.body ?? { format: 'novapreset', name: row.name ?? 'Voix' }), !!row.deleted, row.at ?? 1000, row.device ?? 'poste-a'], sub);
const mine = sub => as('authenticated', 'select preset_id, name, deleted, body, client_updated_at, device_id, updated_at from public.nova_presets order by preset_id', [], sub);

// --- Écriture et lecture : chacun ses lignes -----------------------------------------------
let r = await upsert(A, { preset_id: 'pre-1', name: 'Voix rap 2:1', at: 1000 });
ok(!r.error, 'un compte enregistre son preset', r.error?.message);
r = await upsert(A, { preset_id: 'chain-1', kind: 'chain', name: 'Lead LENNON', body: { format: 'novachain', name: 'Lead LENNON' }, at: 1001 });
ok(!r.error, 'et son modèle de piste (chaîne)', r.error?.message);
r = await mine(A);
ok(r.rows?.length === 2, 'il relit ses 2 lignes', JSON.stringify(r.rows));
r = await mine(B);
ok(r.rows?.length === 0, 'un autre compte ne les voit pas (RLS)', JSON.stringify(r.rows));
r = await upsert(B, { user_id: A, preset_id: 'intrus', at: 5 });
ok(code(r) === '42501', 'un autre compte ne peut pas écrire chez lui', code(r));
r = await as('authenticated', `update public.nova_presets set name = 'piraté'`, [], B);
ok(!r.error && r.affected === 0, 'ni modifier ses lignes', r.error?.message || r.affected);
r = await as('authenticated', `delete from public.nova_presets`, [], B);
ok(!r.error && r.affected === 0, 'ni les supprimer', r.error?.message || r.affected);
r = await as('anon', 'select * from public.nova_presets');
ok(code(r) === '42501', 'sans compte : aucun accès', code(r));
r = await as('anon', `insert into public.nova_presets (user_id, preset_id, kind) values ('${A}', 'x', 'plugin')`);
ok(code(r) === '42501', 'sans compte : aucune écriture', code(r));

// --- La plus récente gagne ; heure du serveur ----------------------------------------------
const before = (await mine(A)).rows.find(x => x.preset_id === 'pre-1');
r = await upsert(A, { preset_id: 'pre-1', name: 'Vieille version', at: 900, device: 'poste-b' });
ok(!r.error, 'une version plus ancienne est acceptée sans erreur…', r.error?.message);
let now = (await mine(A)).rows.find(x => x.preset_id === 'pre-1');
ok(now.name === 'Voix rap 2:1' && Number(now.client_updated_at) === 1000, '… mais n’écrase pas la plus récente', JSON.stringify(now));
await new Promise(res => setTimeout(res, 5));
r = await upsert(A, { preset_id: 'pre-1', name: 'Voix lead', at: 2000, device: 'poste-b' });
now = (await mine(A)).rows.find(x => x.preset_id === 'pre-1');
ok(now.name === 'Voix lead' && now.device_id === 'poste-b', 'une version plus récente la remplace (poste noté)', JSON.stringify(now));
ok(new Date(now.updated_at) > new Date(before.updated_at), 'updated_at = heure du serveur, qui avance (curseur des autres postes)');
r = await as('authenticated', `update public.nova_presets set updated_at = '2000-01-01' where preset_id = 'pre-1'`, [], A);
now = (await mine(A)).rows.find(x => x.preset_id === 'pre-1');
ok(new Date(now.updated_at).getFullYear() > 2020, 'le client ne peut pas reculer updated_at', now.updated_at);

// --- Suppression : ligne « supprimée », sans contenu ----------------------------------------
r = await upsert(A, { preset_id: 'chain-1', kind: 'chain', name: '', deleted: true, at: 3000, body: { format: 'novachain', gros: 'x'.repeat(100) } });
now = (await mine(A)).rows.find(x => x.preset_id === 'chain-1');
ok(now.deleted === true && JSON.stringify(now.body) === '{}', 'suppression : la ligne reste, vidée', JSON.stringify(now));

// --- Lecture incrémentale du client : updated_at > curseur, device_id <> le sien -------------
r = await as('authenticated', `select preset_id from public.nova_presets where updated_at > $1 and device_id <> $2 order by updated_at limit 200`, [before.updated_at, 'poste-b'], A);
ok(!r.error && r.rows.map(x => x.preset_id).join() === 'chain-1', 'le poste B ne relit que ce qu’un autre poste a écrit', JSON.stringify(r.rows || r.error?.message));

// --- Garde-fous -------------------------------------------------------------------------------
r = await upsert(A, { preset_id: 'gros', body: { format: 'novapreset', blob: 'x'.repeat(300000) }, at: 10 });
ok(code(r) === '23514', 'un preset de plus de 256 Ko est refusé', code(r));
r = await upsert(A, { preset_id: 'x'.repeat(121), at: 10 });
ok(code(r) === '23514', 'identifiant trop long refusé', code(r));
r = await upsert(A, { preset_id: 'k', kind: 'autre', at: 10 });
ok(code(r) === '23514', 'genre inconnu refusé', code(r));
// Plafond de 2000 presets par compte (les mises à jour restent possibles).
await db.exec(`insert into public.nova_presets (user_id, preset_id, kind) select '${B}', 'p' || g, 'plugin' from generate_series(1, 2000) g`);
r = await upsert(B, { preset_id: 'p2001', at: 10 });
ok(code(r) === 'P0001', 'le 2001e preset d’un compte est refusé', code(r) || r.error?.message);
r = await upsert(B, { preset_id: 'p5', name: 'mis à jour', at: 10 });
ok(!r.error, 'au plafond, un preset existant se met encore à jour', r.error?.message);

// --- Retour arrière ---------------------------------------------------------------------------
await db.exec(rollback);
r = await db.query(`select to_regclass('public.nova_presets') as t`);
ok(r.rows[0].t === null, 'retour arrière : table retirée');
await db.exec(migration);
ok(true, 'la migration se rejoue après le retour arrière');

console.log(`\n${pass} OK, ${fail} KO`);
process.exit(fail ? 1 : 0);
