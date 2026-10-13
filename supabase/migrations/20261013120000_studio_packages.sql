-- Chantier 17 · « Envoyer au studio » (studio Make Music connecté, B6).
--
-- NON APPLIQUÉE : attend le GO de Romain. À appliquer AVANT de déployer la
-- fonction studio-inbox (sinon « relation studio_packages does not exist »).
--
-- Un paquet = le projet NOVA (.zip), ses stems, les notes horodatées, envoyés
-- par un artiste connecté, + UNE demande de réservation (statut « demande » :
-- le studio confirme ensuite, rien n'est réservé automatiquement dans l'agenda).
--
-- Accès : la fonction studio-inbox (clé service) uniquement. RLS activée, AUCUNE
-- policy, droits retirés à anon et authenticated. Les fichiers sont dans le
-- stockage PRIVÉ « studio-packages » (<compte>/<paquet>/<fichier>), envoyés
-- par des adresses signées, lus par le studio avec des liens signés de 2 h.
--
-- Retour arrière :
--   drop table if exists public.studio_booking_requests;
--   drop table if exists public.studio_packages;
--   -- puis vider et supprimer le bucket « studio-packages » (Storage).

create table if not exists public.studio_packages (
  id text primary key check (id ~ '^[a-z0-9]{12}$'),
  user_id uuid not null,
  email text,
  status text not null default 'envoi' check (status in ('envoi', 'recu')),
  title text not null default '' check (char_length(title) <= 80),
  bpm integer,
  song_key text,
  notes_count integer not null default 0,
  -- [{ kind: projet|stem|notes, name, size, path }]
  files jsonb not null default '[]'::jsonb,
  total_bytes bigint not null default 0 check (total_bytes <= 2147483648),
  booking_id text,
  created_at timestamptz not null default now(),
  received_at timestamptz
);
create index if not exists studio_packages_user on public.studio_packages (user_id, status, created_at);
create index if not exists studio_packages_received on public.studio_packages (status, received_at desc);

create table if not exists public.studio_booking_requests (
  id text primary key check (id ~ '^[a-z0-9]{12}$'),
  -- Une seule demande par paquet (deux envois du même paquet rendent la même).
  package_id text not null unique references public.studio_packages(id) on delete cascade,
  user_id uuid not null,
  email text,
  reference text not null,
  service text not null check (service in ('enregistrement', 'mix', 'mix_master', 'mastering')),
  wished_date date not null,
  slot text not null check (slot in ('matin', 'apres-midi', 'soir', 'flexible')),
  hours integer not null check (hours between 1 and 12),
  artist_name text not null check (char_length(artist_name) between 1 and 60),
  phone text check (phone is null or char_length(phone) <= 24),
  message text check (message is null or char_length(message) <= 1000),
  -- demande → confirmee / refusee : changé par le studio (tableau de bord), pas par NOVA.
  status text not null default 'demande' check (status in ('demande', 'confirmee', 'refusee', 'annulee')),
  created_at timestamptz not null default now()
);
create index if not exists studio_booking_requests_date on public.studio_booking_requests (wished_date, status);

alter table public.studio_packages enable row level security;
alter table public.studio_booking_requests enable row level security;
revoke all on public.studio_packages from anon, authenticated;
revoke all on public.studio_booking_requests from anon, authenticated;

-- Stockage privé (500 Mo par fichier au plus).
insert into storage.buckets (id, name, public, file_size_limit)
values ('studio-packages', 'studio-packages', false, 524288000)
on conflict (id) do nothing;
