-- Sessions Nova « à emporter » : enregistrée au studio, continuée chez soi
-- (iPad, ordinateur) puis rouverte au studio. Accès uniquement par la fonction
-- daw-session (service role) avec la clé secrète du lien : pas de policy.

create table if not exists public.daw_sessions (
  id text primary key,
  secret_hash text not null,
  name text not null default 'Session',
  version integer not null default 0,
  manifest jsonb,
  total_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_from text
);

alter table public.daw_sessions enable row level security;
revoke all on public.daw_sessions from anon, authenticated;

create index if not exists daw_sessions_updated_at_idx on public.daw_sessions (updated_at);

-- Audio des sessions (morceaux de 40 Mo max, nommés par empreinte SHA-1)
insert into storage.buckets (id, name, public, file_size_limit)
values ('daw-sessions', 'daw-sessions', false, 52428800)
on conflict (id) do nothing;

-- Sessions rattachées au compte client : le client les retrouve dans son
-- espace (liste + lien d'ouverture), le studio peut les lui attribuer par e-mail.
alter table public.daw_sessions add column if not exists owner_id uuid references auth.users(id) on delete set null;
-- Clé du lien, lisible uniquement par le service (table sans policy) : permet
-- au propriétaire de rouvrir sa session depuis son compte sans la perdre.
alter table public.daw_sessions add column if not exists secret text;
create index if not exists daw_sessions_owner_idx on public.daw_sessions (owner_id);

create or replace function public.mm_user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select id from auth.users where lower(email) = lower(trim(p_email)) limit 1;
$$;
revoke all on function public.mm_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.mm_user_id_by_email(text) to service_role;
