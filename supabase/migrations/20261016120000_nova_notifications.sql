-- =====================================================================================
-- NOVA 1.5.1 · Lot 7 · Notifications (Web Push) : commentaire, version, invitation, prise reçue.
-- Projet Supabase des comptes Make Music (MAKE MUSIC BOOKING, mxdrxpzxbgybchzzvpkf).
--
-- À COLLER À LA MAIN : Supabase > SQL Editor > New query > Run. Rien ne l'exécute tout seul.
-- Rejouable sans risque (if not exists / create or replace). Ne supprime rien et ne modifie
-- AUCUNE table existante : il ajoute des tables neuves et des triggers « après écriture » qui
-- ne peuvent jamais faire échouer l'écriture d'origine (toute erreur est avalée en avertissement).
--
-- Ce que ce script crée :
--   1. nova_push_subscriptions : les navigateurs abonnés (un par appareil). RLS : chacun ne voit
--      et ne supprime que ses lignes ; l'écriture passe par nova_push_subscribe() (vérifie l'adresse :
--      seulement les services d'envoi des navigateurs) ;
--   2. nova_notify_prefs : interrupteur général + un réglage par type. RLS : chacun ses lignes.
--      Pas de ligne = notifications jamais activées = rien n'est envoyé ;
--   3. nova_notifications : la boîte de réception de chacun (sert aussi à l'appli Windows, qui n'a
--      pas de service worker : elle écoute cette table en temps réel). RLS : lecture de ses lignes,
--      seule la colonne read_at est modifiable ;
--   4. nova_notify_events (file d'attente) et nova_notify_config : réservées au serveur (RLS sans policy) ;
--   5. triggers sur daw_session_ops (« comments », « mixver », « take_end »), daw_session_members
--      (quelqu'un rejoint) et daw_sessions (séance attribuée par le studio) : ils posent l'événement
--      dans la file puis réveillent la fonction nova-push (pg_net, asynchrone, après la transaction).
--
-- Retour arrière (désactive tout, garde les données) :
--   drop trigger if exists nova_notify_ops on public.daw_session_ops;
--   drop trigger if exists nova_notify_members on public.daw_session_members;
--   drop trigger if exists nova_notify_assign on public.daw_sessions;
-- =====================================================================================

-- pg_net : appel HTTP asynchrone depuis la base (fourni par Supabase, gratuit). Ses fonctions vivent
-- dans le schéma « net » ; s'il est déjà activé, rien ne change.
do $$ begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    begin
      create extension pg_net with schema extensions;
    exception when others then
      create extension pg_net;
    end;
  end if;
end $$;

-- ---------------------------------------------------------------- 1. abonnements
create table if not exists public.nova_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  -- « PC Windows », « iPhone »… (affiché dans les réglages) et début de la clé publique utilisée
  -- (si la clé VAPID change, l'appareil se réabonne tout seul).
  device_label text not null default '',
  app_key text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_ok_at timestamptz,
  fail_count integer not null default 0,
  constraint nova_push_subscriptions_endpoint check (
    char_length(endpoint) <= 1000
    and endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com)/'
  ),
  constraint nova_push_subscriptions_keys check (p256dh ~ '^[A-Za-z0-9_-]{86,88}$' and auth ~ '^[A-Za-z0-9_-]{16,24}$'),
  constraint nova_push_subscriptions_label check (char_length(device_label) <= 80 and char_length(app_key) <= 32)
);
create index if not exists nova_push_subscriptions_user on public.nova_push_subscriptions (user_id);
alter table public.nova_push_subscriptions enable row level security;
revoke all on public.nova_push_subscriptions from anon, authenticated;
grant select, delete on public.nova_push_subscriptions to authenticated;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'nova_push_subscriptions' and policyname = 'nova_push_subscriptions_select_own') then
    create policy nova_push_subscriptions_select_own on public.nova_push_subscriptions for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'nova_push_subscriptions' and policyname = 'nova_push_subscriptions_delete_own') then
    create policy nova_push_subscriptions_delete_own on public.nova_push_subscriptions for delete to authenticated using (user_id = auth.uid());
  end if;
end $$;

-- Abonner CET appareil au compte connecté. L'adresse d'envoi appartient au navigateur : si un
-- autre compte s'était abonné sur le même navigateur, c'est le dernier connecté qui la garde.
-- 10 appareils au plus par compte (les plus anciens partent).
create or replace function public.nova_push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_label text default '', p_app_key text default '')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  sid uuid;
begin
  if uid is null then raise exception 'Connecte-toi pour activer les notifications' using errcode = '28000'; end if;
  delete from public.nova_push_subscriptions where endpoint = p_endpoint and user_id <> uid;
  insert into public.nova_push_subscriptions (user_id, endpoint, p256dh, auth, device_label, app_key)
  values (uid, p_endpoint, p_p256dh, p_auth, left(coalesce(p_label, ''), 80), left(coalesce(p_app_key, ''), 32))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, device_label = excluded.device_label,
    app_key = excluded.app_key, updated_at = now(), fail_count = 0
  returning id into sid;
  delete from public.nova_push_subscriptions where user_id = uid and id in (
    select id from public.nova_push_subscriptions where user_id = uid order by updated_at desc offset 10);
  return sid;
end;
$$;
revoke all on function public.nova_push_subscribe(text, text, text, text, text) from public, anon;
grant execute on function public.nova_push_subscribe(text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------- 2. réglages
create table if not exists public.nova_notify_prefs (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  comments boolean not null default true,
  versions boolean not null default true,
  invites boolean not null default true,
  takes boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.nova_notify_prefs enable row level security;
revoke all on public.nova_notify_prefs from anon, authenticated;
grant select, insert, update, delete on public.nova_notify_prefs to authenticated;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'nova_notify_prefs' and policyname = 'nova_notify_prefs_own') then
    create policy nova_notify_prefs_own on public.nova_notify_prefs for all to authenticated
      using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end $$;

-- ---------------------------------------------------------------- 3. boîte de réception
create table if not exists public.nova_notifications (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('comment', 'version', 'invite', 'take')),
  -- Une seule notification par chose et par personne (commentaire, réponse, version, prise…).
  dedup_key text not null check (char_length(dedup_key) <= 200),
  session_id text,
  title text not null check (char_length(title) <= 120),
  body text not null default '' check (char_length(body) <= 300),
  -- Chemin dans NOVA (ouvre la séance, à l'instant du commentaire) ; contient le lien de la séance,
  -- que la personne a déjà (propriétaire ou membre) : lisible par elle seule (RLS).
  url text not null default '/' check (char_length(url) <= 600),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz,
  pushed_at timestamptz,
  unique (user_id, dedup_key)
);
create index if not exists nova_notifications_user on public.nova_notifications (user_id, created_at desc);
alter table public.nova_notifications enable row level security;
revoke all on public.nova_notifications from anon, authenticated;
grant select, delete on public.nova_notifications to authenticated;
grant update (read_at) on public.nova_notifications to authenticated;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'nova_notifications' and policyname = 'nova_notifications_select_own') then
    create policy nova_notifications_select_own on public.nova_notifications for select to authenticated using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'nova_notifications' and policyname = 'nova_notifications_update_own') then
    create policy nova_notifications_update_own on public.nova_notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'nova_notifications' and policyname = 'nova_notifications_delete_own') then
    create policy nova_notifications_delete_own on public.nova_notifications for delete to authenticated using (user_id = auth.uid());
  end if;
end $$;

-- Temps réel (appli Windows, onglet ouvert) : la table est diffusée, filtrée par la RLS.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'nova_notifications') then
    alter publication supabase_realtime add table public.nova_notifications;
  end if;
end $$;

-- ---------------------------------------------------------------- 4. file d'attente + réglage serveur
create table if not exists public.nova_notify_events (
  id bigserial primary key,
  source text not null check (source in ('op', 'member', 'assign')),
  session_id text not null,
  actor_key text not null default '',
  actor_name text not null default '',
  kind text not null default '',
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  error text
);
create index if not exists nova_notify_events_pending on public.nova_notify_events (id) where processed_at is null;
alter table public.nova_notify_events enable row level security;
revoke all on public.nova_notify_events from anon, authenticated;
revoke all on sequence public.nova_notify_events_id_seq from anon, authenticated;

create table if not exists public.nova_notify_config (
  key text primary key,
  value text not null default ''
);
alter table public.nova_notify_config enable row level security;
revoke all on public.nova_notify_config from anon, authenticated;
-- Adresse de la fonction nova-push (publique). Vider la valeur coupe les envois sans rien supprimer.
insert into public.nova_notify_config (key, value)
values ('push_url', 'https://mxdrxpzxbgybchzzvpkf.supabase.co/functions/v1/nova-push')
on conflict (key) do nothing;

-- La fonction nova-push prend les événements en attente (jamais deux fois le même).
create or replace function public.nova_notify_claim(p_limit integer default 50)
returns setof public.nova_notify_events
language sql
security definer
set search_path = public
as $$
  with picked as (
    select id from public.nova_notify_events
    where processed_at is null and attempts < 5
    order by id
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update skip locked
  )
  update public.nova_notify_events e set processed_at = now(), attempts = e.attempts + 1
  from picked
  where e.id = picked.id
  returning e.*;
$$;
revoke all on function public.nova_notify_claim(integer) from public, anon, authenticated;
grant execute on function public.nova_notify_claim(integer) to service_role;

-- Réveil de nova-push (asynchrone : pg_net envoie après la fin de la transaction).
create or replace function public.nova_notify_kick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target text;
begin
  select value into target from public.nova_notify_config where key = 'push_url';
  if coalesce(target, '') = '' then return; end if;
  perform net.http_post(
    url := target,
    body := '{"action":"drain"}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 8000
  );
exception when others then
  raise warning 'nova_notify_kick : %', sqlerrm;
end;
$$;
revoke all on function public.nova_notify_kick() from public, anon, authenticated;

-- ---------------------------------------------------------------- 5. triggers
-- Fonctions « returns trigger » : elles ne s'appellent pas directement, leurs droits ne sont pas touchés
-- (rien ne doit jamais pouvoir bloquer l'écriture d'origine dans les tables de la collaboration).
-- Opérations de collaboration : commentaires, versions, fin de prise envoyée en direct.
create or replace function public.nova_notify_on_op()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if new.kind = 'take_end' and coalesce(new.op ->> 'cancel', '') in ('true', '1') then return new; end if;
    insert into public.nova_notify_events (source, session_id, actor_key, actor_name, kind, payload)
    values ('op', new.session_id, coalesce(new.member_key, ''), coalesce(new.author_name, ''), new.kind,
      jsonb_build_object('seq', new.seq, 'role', new.role,
        'op', case when octet_length(new.op::text) <= 300000 then new.op else '{}'::jsonb end));
    perform public.nova_notify_kick();
  exception when others then
    raise warning 'nova_notify_on_op : %', sqlerrm;
  end;
  return new;
end;
$$;

create or replace trigger nova_notify_ops
  after insert on public.daw_session_ops
  for each row
  when (new.kind in ('comments', 'mixver', 'take_end'))
  execute function public.nova_notify_on_op();

-- Quelqu'un rejoint une séance (1re connexion de cet appareil) : prévenir l'hôte et les autres.
create or replace function public.nova_notify_on_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    insert into public.nova_notify_events (source, session_id, actor_key, actor_name, kind, payload)
    values ('member', new.session_id, coalesce(new.member_key, ''), coalesce(new.display_name, ''), 'join',
      jsonb_build_object('role', new.role, 'user_id', new.user_id));
    perform public.nova_notify_kick();
  exception when others then
    raise warning 'nova_notify_on_member : %', sqlerrm;
  end;
  return new;
end;
$$;

create or replace trigger nova_notify_members
  after insert on public.daw_session_members
  for each row
  when (new.user_id is not null)
  execute function public.nova_notify_on_member();

-- Le studio attribue une séance à un compte (« assign », colonne studio_gift) : « Une séance t'attend ».
-- Un client qui rattache lui-même une séance (« claim ») n'est pas prévenu de sa propre action.
create or replace function public.nova_notify_on_assign()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if coalesce((to_jsonb(new) ->> 'studio_gift'), 'false') <> 'true' then return new; end if;
    insert into public.nova_notify_events (source, session_id, kind, payload)
    values ('assign', new.id, 'assign', jsonb_build_object('recipient', new.owner_id));
    perform public.nova_notify_kick();
  exception when others then
    raise warning 'nova_notify_on_assign : %', sqlerrm;
  end;
  return new;
end;
$$;

create or replace trigger nova_notify_assign
  after update of owner_id on public.daw_sessions
  for each row
  when (new.owner_id is not null and new.owner_id is distinct from old.owner_id)
  execute function public.nova_notify_on_assign();
