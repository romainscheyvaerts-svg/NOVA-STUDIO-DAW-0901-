-- Collaboration à distance dans Nova (artiste, ingé son, beatmaker).
-- Une session en ligne (daw_sessions) devient collaborative : membres avec un
-- rôle et journal d'opérations (prises de l'artiste, réglages de l'ingé,
-- pistes du beatmaker, verrous, chat). Accès uniquement par la fonction
-- daw-session (service role) : RLS activée, aucune policy.

create table if not exists public.daw_session_members (
  session_id text not null references public.daw_sessions(id) on delete cascade,
  member_key text not null,               -- id du compte, ou identifiant d'appareil
  user_id uuid references auth.users(id) on delete set null,
  role text not null check (role in ('artist', 'engineer', 'beatmaker')),
  display_name text not null default 'Invité',
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (session_id, member_key)
);
alter table public.daw_session_members enable row level security;
revoke all on public.daw_session_members from anon, authenticated;

create table if not exists public.daw_session_ops (
  seq bigserial primary key,
  session_id text not null references public.daw_sessions(id) on delete cascade,
  member_key text not null,
  role text not null,
  author_name text not null default '',
  kind text not null,
  op jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists daw_session_ops_session_seq on public.daw_session_ops (session_id, seq);
alter table public.daw_session_ops enable row level security;
revoke all on public.daw_session_ops from anon, authenticated;
revoke all on sequence public.daw_session_ops_seq_seq from anon, authenticated;
