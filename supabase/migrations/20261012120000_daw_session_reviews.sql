-- Chantier 11 · Commentaires horodatés + versions validées (« Frame.io de la musique »).
--
-- NON DÉPLOYÉE, et pas nécessaire : la fonction marche sans elle. Les commentaires
-- et les versions voyagent par le journal de la collaboration (daw_session_ops,
-- opérations « comments » et « mixver ») et sont enregistrés dans le projet
-- (DAWState.timelineComments / mixVersions, donc dans l'instantané en ligne).
--
-- À quoi servirait cette table, plus tard : lire les retours d'une séance SANS
-- charger le projet (page web « Retours » pour un client, mail « Nina a validé la
-- version 3 », tableau de bord de l'ingé sur toutes ses séances), et garder les
-- retours quand le journal est purgé. Un état par commentaire / version : l'état
-- fusionné (utils/timelineComments, utils/mixVersions), écrit par daw-session
-- (service role) à chaque opération reçue. RLS activée, aucune policy : accès par
-- la fonction seulement, comme daw_session_ops.

create table if not exists public.daw_session_comments (
  session_id text not null references public.daw_sessions(id) on delete cascade,
  comment_id text not null check (char_length(comment_id) between 1 and 80),
  -- État fusionné complet (registres horodatés, réponses).
  state jsonb not null,
  -- Colonnes lues sans ouvrir l'état : instant (s), fin de plage, statut, archivé, auteur.
  at_seconds double precision not null check (at_seconds >= 0),
  end_seconds double precision,
  status text not null default 'open' check (status in ('open', 'resolved')),
  archived boolean not null default false,
  author_name text not null default '',
  last_seq bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (session_id, comment_id)
);
create index if not exists daw_session_comments_open on public.daw_session_comments (session_id, archived, status, at_seconds);
alter table public.daw_session_comments enable row level security;
revoke all on public.daw_session_comments from anon, authenticated;

create table if not exists public.daw_session_mix_versions (
  session_id text not null references public.daw_sessions(id) on delete cascade,
  version_id text not null check (char_length(version_id) between 1 and 80),
  n integer not null check (n between 1 and 9999),
  name text not null default '',
  sent_by text not null default '',
  sent_at timestamptz not null,
  -- Décision de l'artiste : null (en attente), 'approved', 'changes'.
  decision text check (decision in ('approved', 'changes')),
  decided_by text,
  decided_at timestamptz,
  state jsonb not null,
  last_seq bigint not null default 0,
  primary key (session_id, version_id)
);
create index if not exists daw_session_mix_versions_by_n on public.daw_session_mix_versions (session_id, n);
alter table public.daw_session_mix_versions enable row level security;
revoke all on public.daw_session_mix_versions from anon, authenticated;
