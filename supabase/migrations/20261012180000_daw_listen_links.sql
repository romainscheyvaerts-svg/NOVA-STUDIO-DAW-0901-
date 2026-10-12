-- Chantier 12 · Lien d'écoute client SANS COMPTE (remplace Audiomovers).
--
-- NON APPLIQUÉE : attend le GO de Romain. À appliquer AVANT de déployer la
-- fonction daw-listen (sinon « relation daw_listen_links does not exist »).
--
-- Un lien = un jeton aléatoire de 32 caractères (≈ 2^186 possibilités) donné
-- par l'ingé à son client. La recherche se fait par l'empreinte SHA-256 du
-- jeton (token_hash) ; le jeton lui-même est gardé pour que l'ingé puisse
-- recopier le lien plus tard, comme le secret des séances (daw_sessions.secret) :
-- il ne donne QUE l'écoute, jamais l'écriture.
--
-- Accès : la fonction daw-listen (clé service) uniquement. RLS activée, AUCUNE
-- policy, droits retirés à anon et authenticated : la clé publique ne lit ni
-- n'écrit rien dans cette table.
--
-- Retour arrière :
--   drop table if exists public.daw_listen_links;

create table if not exists public.daw_listen_links (
  id text primary key check (id ~ '^[a-z0-9]{16}$'),
  session_id text not null references public.daw_sessions(id) on delete cascade,
  token text not null check (token ~ '^[A-Za-z0-9]{32}$'),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  -- « Pour qui » (Label Nina, manager…) : affiché à l'ingé et sur la page du client.
  label text not null default '' check (char_length(label) <= 60),
  -- Ce que le lien montre.
  allow_live boolean not null default true,
  allow_versions boolean not null default true,
  allow_comments boolean not null default false,
  -- Mot de passe facultatif : « pbkdf2$<tours>$<sel hex>$<empreinte hex> » (PBKDF2-SHA256).
  password_hash text,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  open_count integer not null default 0,
  last_opened_at timestamptz,
  -- 30 jours au plus (le choix de l'ingé : 24 h, 7 j ou 30 j ; marge d'une heure).
  constraint daw_listen_links_ttl check (expires_at <= created_at + interval '30 days 1 hour')
);

create index if not exists daw_listen_links_session on public.daw_listen_links (session_id, expires_at);
create index if not exists daw_listen_links_expiry on public.daw_listen_links (expires_at);

alter table public.daw_listen_links enable row level security;
revoke all on public.daw_listen_links from anon, authenticated;
