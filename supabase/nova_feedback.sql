-- =====================================================================================
-- NOVA : signalements des utilisateurs (« Signaler un bug / proposer une idée »)
-- Projet Supabase des comptes Make Music (mxdrxpzxbgybchzzvpkf).
--
-- À APPLIQUER À LA MAIN (SQL Editor du tableau de bord, ou `supabase db push` si le
-- projet est lié) : ce fichier n'est exécuté par rien automatiquement.
-- Retour arrière : supabase/nova_feedback_rollback.sql
--
-- Ce que ce script crée :
--   1. table public.nova_feedback (un signalement par ligne) ;
--   2. table public.nova_feedback_rate (compteurs anti-spam par adresse IP hachée,
--      purgés après 24 h ; jamais lisible par les utilisateurs) ;
--   3. trigger avant insertion : impose user_id = auth.uid(), statut « recu »,
--      pas de note admin, et l'anti-spam (10 / h par appareil, 20 / h par compte,
--      20 / h par IP, 300 / h au total) ;
--   4. RLS : tout le monde (anonyme ou connecté) peut INSÉRER ; un connecté ne LIT
--      que les siens (et seulement les colonnes de suivi) ; aucun UPDATE / DELETE
--      pour anon / authenticated ; service_role lit et met à jour tout ;
--   5. fonction nova_feedback_statuts(appareil, refs) : statut des signalements
--      envoyés depuis CET appareil (pour les invités) ;
--   6. bucket privé « nova-feedback » (captures, 2 Mo, JPEG / PNG / WebP), envoi
--      seulement, sous <appareil>/<ref>.jpg, 10 / h par appareil ; lecture
--      réservée à service_role.
--
-- Idempotent : peut être relancé sans erreur.
-- =====================================================================================

begin;

-- 1. Table ------------------------------------------------------------------------------
create table if not exists public.nova_feedback (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Numéro de suivi montré à l'utilisateur (créé sur l'appareil, unique : anti-doublon).
  ref              text not null unique
                   check (ref ~ '^[2-9A-HJKMNP-Z]{8}$'),
  -- Identifiant aléatoire de l'appareil (localStorage) : anti-spam et suivi des invités.
  device_id        text not null
                   check (device_id ~ '^[a-f0-9]{32}$'),
  user_id          uuid null references auth.users (id) on delete set null,
  email            text null
                   check (email is null or (char_length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$')),
  category         text not null check (category in ('bug', 'amelioration', 'idee')),
  title            text not null check (char_length(btrim(title)) between 3 and 120),
  description      text not null default '' check (char_length(description) <= 5000),
  frequency        text null check (frequency is null or frequency in ('toujours', 'parfois')),
  context          jsonb not null default '{}'::jsonb
                   check (jsonb_typeof(context) = 'object' and octet_length(context::text) <= 65536),
  screenshot_path  text null
                   check (screenshot_path is null or screenshot_path ~ '^[a-f0-9]{32}/[2-9A-HJKMNP-Z]{8}\.(jpg|png|webp)$'),
  status           text not null default 'recu' check (status in ('recu', 'en_cours', 'corrige', 'ferme')),
  fixed_in_version text null check (fixed_in_version is null or char_length(fixed_in_version) <= 40),
  admin_note       text null check (admin_note is null or char_length(admin_note) <= 5000)
);

comment on table public.nova_feedback is
  'Signalements NOVA (bugs, améliorations, idées). Insertion publique limitée (trigger anti-spam), lecture : chacun les siens ; tout via service_role.';

create index if not exists nova_feedback_device_recent on public.nova_feedback (device_id, created_at desc);
create index if not exists nova_feedback_user_recent   on public.nova_feedback (user_id, created_at desc) where user_id is not null;
create index if not exists nova_feedback_recent        on public.nova_feedback (created_at desc);
create index if not exists nova_feedback_status        on public.nova_feedback (status, created_at);

-- 2. Compteurs anti-spam par IP (hachée, fenêtre d'une heure) ----------------------------
create table if not exists public.nova_feedback_rate (
  key          text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (key, window_start)
);
alter table public.nova_feedback_rate enable row level security;   -- aucune policy : personne d'autre que le propriétaire / service_role
revoke all on public.nova_feedback_rate from anon, authenticated;

-- 3. Trigger avant insertion ----------------------------------------------------------------
create or replace function public.nova_feedback_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role    text := coalesce(auth.role(), '');
  v_ip      text := '';
  v_hits    integer;
  v_count   integer;
begin
  -- Administration (service_role, SQL Editor) : rien n'est imposé.
  if v_role not in ('anon', 'authenticated') then
    return new;
  end if;

  -- Ce que l'utilisateur ne choisit jamais lui-même.
  new.id               := gen_random_uuid();
  new.created_at       := now();
  new.updated_at       := now();
  new.user_id          := auth.uid();
  new.status           := 'recu';
  new.fixed_in_version := null;
  new.admin_note       := null;

  -- Un appareil à la fois (évite que deux envois simultanés passent la limite).
  perform pg_advisory_xact_lock(hashtext('nova_feedback:' || new.device_id));

  select count(*) into v_count from public.nova_feedback
   where device_id = new.device_id and created_at > now() - interval '1 hour';
  if v_count >= 10 then
    raise exception 'nova_feedback_rate_limit: appareil' using errcode = 'P0001',
      hint = 'Trop de signalements depuis cet appareil cette heure-ci.';
  end if;

  if new.user_id is not null then
    select count(*) into v_count from public.nova_feedback
     where user_id = new.user_id and created_at > now() - interval '1 hour';
    if v_count >= 20 then
      raise exception 'nova_feedback_rate_limit: compte' using errcode = 'P0001';
    end if;
  end if;

  select count(*) into v_count from public.nova_feedback
   where created_at > now() - interval '1 hour';
  if v_count >= 300 then
    raise exception 'nova_feedback_rate_limit: global' using errcode = 'P0001';
  end if;

  -- Adresse IP (en-tête transmis par l'API) : seulement hachée, dans la table des compteurs.
  begin
    v_ip := btrim(split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''), ',', 1));
  exception when others then
    v_ip := '';
  end;
  if v_ip <> '' then
    insert into public.nova_feedback_rate as r (key, window_start, hits)
    values ('ip:' || md5('nova-feedback-rate:' || v_ip), date_trunc('hour', now()), 1)
    on conflict (key, window_start) do update set hits = r.hits + 1
    returning hits into v_hits;
    if v_hits > 20 then
      raise exception 'nova_feedback_rate_limit: ip' using errcode = 'P0001';
    end if;
    delete from public.nova_feedback_rate where window_start < now() - interval '1 day';
  end if;

  return new;
end;
$$;

revoke all on function public.nova_feedback_before_insert() from public, anon, authenticated;

drop trigger if exists nova_feedback_before_insert on public.nova_feedback;
create trigger nova_feedback_before_insert
  before insert on public.nova_feedback
  for each row execute function public.nova_feedback_before_insert();

create or replace function public.nova_feedback_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists nova_feedback_touch on public.nova_feedback;
create trigger nova_feedback_touch
  before update on public.nova_feedback
  for each row execute function public.nova_feedback_touch();

-- 4. Droits et RLS -------------------------------------------------------------------------
alter table public.nova_feedback enable row level security;

-- Supabase donne par défaut tous les droits à anon / authenticated sur les nouvelles
-- tables : on repart de zéro, puis on ouvre colonne par colonne.
revoke all on public.nova_feedback from anon, authenticated;
grant insert (ref, device_id, email, category, title, description, frequency, context, screenshot_path)
  on public.nova_feedback to anon, authenticated;
-- Suivi « Mes signalements » : ni la description, ni le contexte, ni la note admin.
grant select (id, ref, created_at, updated_at, category, title, status, fixed_in_version)
  on public.nova_feedback to authenticated;
grant all on public.nova_feedback to service_role;
grant all on public.nova_feedback_rate to service_role;

drop policy if exists nova_feedback_insert on public.nova_feedback;
create policy nova_feedback_insert on public.nova_feedback
  for insert to anon, authenticated
  with check (
    status = 'recu'
    and fixed_in_version is null
    and admin_note is null
    and user_id is not distinct from auth.uid()
  );

drop policy if exists nova_feedback_select_own on public.nova_feedback;
create policy nova_feedback_select_own on public.nova_feedback
  for select to authenticated
  using (user_id is not null and user_id = auth.uid());

-- Pas de policy UPDATE ni DELETE : refusés pour anon / authenticated (et pas de droit non plus).

-- 5. Statut des signalements d'un appareil (invités) --------------------------------------
create or replace function public.nova_feedback_statuts(p_device text, p_refs text[])
returns table (ref text, status text, fixed_in_version text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select f.ref, f.status, f.fixed_in_version
    from public.nova_feedback f
   where p_device ~ '^[a-f0-9]{32}$'
     and f.device_id = p_device
     and f.ref = any (coalesce(p_refs[1:50], '{}'::text[]));
$$;

revoke all on function public.nova_feedback_statuts(text, text[]) from public;
grant execute on function public.nova_feedback_statuts(text, text[]) to anon, authenticated, service_role;

-- 6. Captures : bucket privé ---------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('nova-feedback', 'nova-feedback', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.nova_feedback_upload_allowed(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_device text;
begin
  if p_name is null or p_name !~ '^[a-f0-9]{32}/[2-9A-HJKMNP-Z]{8}\.(jpg|png|webp)$' then
    return false;
  end if;
  v_device := split_part(p_name, '/', 1);
  if (select count(*) from storage.objects o
       where o.bucket_id = 'nova-feedback'
         and o.name like v_device || '/%'
         and o.created_at > now() - interval '1 hour') >= 10 then
    return false;
  end if;
  if (select count(*) from storage.objects o
       where o.bucket_id = 'nova-feedback'
         and o.created_at > now() - interval '1 hour') >= 300 then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.nova_feedback_upload_allowed(text) from public;
grant execute on function public.nova_feedback_upload_allowed(text) to anon, authenticated, service_role;

-- Envoi seulement (pas de lecture, liste, remplacement ni suppression par les utilisateurs).
drop policy if exists nova_feedback_upload on storage.objects;
create policy nova_feedback_upload on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'nova-feedback' and public.nova_feedback_upload_allowed(name));

commit;
