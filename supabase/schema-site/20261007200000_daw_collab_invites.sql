-- « Feat à distance » : inviter par un code à 6 caractères (en plus du lien).
-- Le code mène au lien de la session (id + secret) ; valable 24 h. Accès
-- uniquement par la fonction daw-session (service role) : RLS activée, aucune policy.

create table if not exists public.daw_session_invites (
  code text primary key check (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'),
  session_id text not null references public.daw_sessions(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists daw_session_invites_session on public.daw_session_invites (session_id, expires_at desc);
alter table public.daw_session_invites enable row level security;
revoke all on public.daw_session_invites from anon, authenticated;
