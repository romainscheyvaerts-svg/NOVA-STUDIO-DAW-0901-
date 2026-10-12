-- Chantier 19 · Presets synchronisés entre postes (compte Make Music).
--
-- NON APPLIQUÉE : attend le GO de Romain. Projet mxdrxpzxbgybchzzvpkf (le compte
-- de l'appli Windows, des sessions en ligne et du feedback : catalogSupabase).
--
-- Un preset d'effet (.novapreset), une chaîne d'effets ou un modèle de piste
-- (Track Preset, .novachain) enregistré sur un poste se retrouve sur un autre
-- poste connecté au même compte. Le client (services/PresetCloud.ts) garde tout
-- sur l'appareil (IndexedDB) et marche hors ligne ; il se synchronise quand le
-- serveur répond. Tant que cette table n'existe pas, il affiche « synchronisation
-- bientôt disponible » et ne la redemande pas avant 6 h.
--
-- Pas de fonction serveur : PostgREST + RLS suffisent (chacun ne voit et n'écrit
-- que ses lignes). Egress : le client ne relit que les lignes changées depuis
-- son dernier passage (updated_at > curseur, 200 par page au plus), au démarrage,
-- après un enregistrement (regroupé sur 2 s), au retour du réseau, et au plus
-- une fois toutes les 5 minutes quand la fenêtre revient au premier plan.
-- Aucune boucle.
--
-- Retour arrière : supabase/nova_presets_rollback.sql (hors du dossier lu par
-- `supabase db push`). Test local (Postgres en WebAssembly, rôles imités) :
-- supabase/tests/nova_presets.pglite.mjs.

create table if not exists public.nova_presets (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  preset_id text not null check (char_length(preset_id) between 1 and 120),
  -- 'plugin' : preset d'un effet ; 'chain' : chaîne d'effets / modèle de piste.
  kind text not null check (kind in ('plugin', 'chain')),
  name text not null default '' check (char_length(name) <= 120),
  -- Le preset tel que le client le range (format .novapreset / .novachain).
  body jsonb not null default '{}'::jsonb,
  -- Suppression : la ligne reste (sans contenu) pour que les autres postes l'appliquent.
  deleted boolean not null default false,
  -- Heure de la modification sur le poste (ms) : la plus récente gagne.
  client_updated_at bigint not null default 0 check (client_updated_at >= 0),
  -- Poste qui a écrit la ligne (aléatoire) : chaque poste lit « device_id <> le sien »,
  -- il ne retélécharge donc jamais ce qu'il vient d'envoyer.
  device_id text not null default '' check (char_length(device_id) <= 64),
  -- Heure du serveur : curseur de lecture incrémentale des autres postes.
  updated_at timestamptz not null default now(),
  primary key (user_id, preset_id),
  -- Garde-fou egress / abus : 256 Ko par preset (un VST avec son état reste bien en dessous).
  constraint nova_presets_body_size check (pg_column_size(body) <= 262144)
);

create index if not exists nova_presets_by_user_updated on public.nova_presets (user_id, updated_at);

-- La modification la plus récente (heure du poste) gagne : un poste resté hors
-- ligne qui renvoie une vieille version n'écrase pas la nouvelle. updated_at
-- prend toujours l'heure du serveur (le client ne peut pas la falsifier).
create or replace function public.nova_presets_touch() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.client_updated_at < old.client_updated_at then
    return null; -- plus ancien : ignoré, la ligne reste telle quelle
  end if;
  new.updated_at := now();
  if new.deleted then new.body := '{}'::jsonb; end if;
  return new;
end $$;

drop trigger if exists nova_presets_touch on public.nova_presets;
create trigger nova_presets_touch before insert or update on public.nova_presets
  for each row execute function public.nova_presets_touch();

-- Plafond par compte (2 000 presets) : une boucle cliente ou un abus ne remplit pas la base.
create or replace function public.nova_presets_cap() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  -- Une mise à jour par upsert passe aussi par ici (avant la détection du conflit) : seules
  -- les VRAIES nouvelles lignes comptent.
  if not exists (select 1 from public.nova_presets where user_id = new.user_id and preset_id = new.preset_id)
     and (select count(*) from public.nova_presets where user_id = new.user_id) >= 2000 then
    raise exception 'nova_presets : 2000 presets au plus par compte' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists nova_presets_cap on public.nova_presets;
create trigger nova_presets_cap before insert on public.nova_presets
  for each row execute function public.nova_presets_cap();

alter table public.nova_presets enable row level security;
revoke all on public.nova_presets from anon;
grant select, insert, update, delete on public.nova_presets to authenticated;

drop policy if exists nova_presets_select_own on public.nova_presets;
create policy nova_presets_select_own on public.nova_presets
  for select to authenticated using (user_id = auth.uid());

drop policy if exists nova_presets_insert_own on public.nova_presets;
create policy nova_presets_insert_own on public.nova_presets
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists nova_presets_update_own on public.nova_presets;
create policy nova_presets_update_own on public.nova_presets
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists nova_presets_delete_own on public.nova_presets;
create policy nova_presets_delete_own on public.nova_presets
  for delete to authenticated using (user_id = auth.uid());
