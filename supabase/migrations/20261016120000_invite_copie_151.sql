-- NOVA 1.5.1 · Lot 3 (invité gratuit) et lot 9 (« Faire sa version », page publique d'un morceau).
--
-- NON APPLIQUÉE : attend Romain (copie à coller : D:\1 WORK\CONTENU\nova-151\serveur\invite_copie_151.sql).
-- À coller dans le SQL Editor AVANT de déployer daw-session, daw-fork et daw-listen 1.5.1.
-- Sans ces tables, daw-session marche comme avant (limite des codes faux désactivée, rien de plus
-- à garder au ménage) ; daw-fork et les pages publiques répondent une erreur claire.
--
-- Rien n'est supprimé, aucune table existante n'est modifiée : uniquement des tables NEUVES
-- (« if not exists »), relançable sans risque.
--
-- Accès : par les fonctions serveur seulement (clé service). RLS activée, AUCUNE policy, droits
-- retirés à anon et authenticated : la clé publique ne lit ni n'écrit rien dans ces tables.
--
-- Retour arrière :
--   drop table if exists public.nova_public_tracks;
--   drop table if exists public.daw_session_fork_copies;
--   drop table if exists public.daw_session_forks;
--   drop table if exists public.daw_invite_attempts;

-- 1. Lot 3 · codes d'invitation faux (au plus 20 par heure et par compte, ménage après 1 jour).
create table if not exists public.daw_invite_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists daw_invite_attempts_user on public.daw_invite_attempts (user_id, at);
alter table public.daw_invite_attempts enable row level security;
revoke all on public.daw_invite_attempts from anon, authenticated;

-- 2. Lot 9a · liens « Faire sa version » : l'instantané de la séance figé à la création du lien
--    (sans l'audio des instrus du catalogue), révocable, avec son compteur de copies.
create table if not exists public.daw_session_forks (
  id text primary key check (id ~ '^[a-z0-9]{16}$'),
  session_id text not null references public.daw_sessions(id) on delete cascade,
  token text not null check (token ~ '^[A-Za-z0-9]{32}$'),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  label text not null default '' check (char_length(label) <= 60),
  name text not null default '' check (char_length(name) <= 80),
  manifest jsonb not null,
  version integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  copies integer not null default 0,
  last_copy_at timestamptz
);
create index if not exists daw_session_forks_session on public.daw_session_forks (session_id, created_at);
alter table public.daw_session_forks enable row level security;
revoke all on public.daw_session_forks from anon, authenticated;

-- Une ligne par compte qui a récupéré sa copie (le compteur ne compte pas deux fois le même compte).
create table if not exists public.daw_session_fork_copies (
  fork_id text not null references public.daw_session_forks(id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (fork_id, user_id)
);
alter table public.daw_session_fork_copies enable row level security;
revoke all on public.daw_session_fork_copies from anon, authenticated;

-- 3. Lot 9b · page publique d'un morceau : une par séance, publiée par choix explicite du
--    propriétaire, désactivable (published = false → la page répond « n'est plus publié »).
--    Seulement l'extrait ou le mix (audio.parts), jamais les pistes séparées.
create table if not exists public.nova_public_tracks (
  id text primary key check (id ~ '^[a-z0-9]{10}$'),
  session_id text not null unique references public.daw_sessions(id) on delete cascade,
  owner_id uuid not null,
  title text not null check (char_length(title) between 1 and 80),
  artist text not null default '' check (char_length(artist) <= 60),
  credits text not null default '' check (char_length(credits) <= 500),
  lyrics text not null default '' check (char_length(lyrics) <= 5000),
  show_lyrics boolean not null default false,
  kind text not null check (kind in ('mix', 'extrait')),
  audio jsonb not null,
  cover_part text check (cover_part is null or cover_part ~ '^[a-f0-9]{40}$'),
  published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unpublished_at timestamptz,
  plays integer not null default 0
);
create index if not exists nova_public_tracks_owner on public.nova_public_tracks (owner_id);
alter table public.nova_public_tracks enable row level security;
revoke all on public.nova_public_tracks from anon, authenticated;
