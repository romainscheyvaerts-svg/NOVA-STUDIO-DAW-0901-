-- Tarifs Nova, grille du 14/10/2026 (prix : supabase/functions/_shared/novaTarifs.ts).
--
-- NON APPLIQUÉE : attend le GO de Romain. À appliquer AVANT de déployer nova-billing,
-- daw-session et daw-session-purge (sinon « column interval does not exist »,
-- « relation nova_pro_gifts does not exist »).
--
-- Ce que la migration change (rien n'est effacé, aucune ligne existante n'est modifiée) :
--  1. nova_subscriptions : colonne « interval » (month | year) pour Nova Pro annuel ;
--  2. nova_purchases : nouvel achat « export_project » (1,99 € par projet) ;
--  3. nova_pro_gifts : Nova Pro offert enregistré (séance au studio, geste du studio).
--     Les cadeaux liés aux achats (instru 1 mois, mélodie 7 jours) ne sont PAS écrits ici :
--     nova-billing les déduit de instrumental_purchases ;
--  4. daw_sessions : expires_at (projet gratuit gardé 7 jours), studio_gift, expiry_warned_at.
--     Les projets déjà en ligne gardent expires_at = null (aucune expiration rétroactive) ;
--  5. index pour lire vite les achats d'un compte.
--
-- Le ménage (daw-session-purge) n'est PAS programmé ici : voir DEPLOIEMENT.md.
--
-- Retour arrière (dans cet ordre) :
--   drop table if exists public.nova_pro_gifts;
--   alter table public.daw_sessions drop column if exists expiry_warned_at;
--   alter table public.daw_sessions drop column if exists studio_gift;
--   alter table public.daw_sessions drop column if exists expires_at;
--   alter table public.nova_purchases drop constraint if exists nova_purchases_kind_check;
--   alter table public.nova_purchases add constraint nova_purchases_kind_check check (kind in ('export_voices'));
--     (échoue s'il existe déjà des achats « export_project » : les garder, c'est sans risque)
--   alter table public.nova_subscriptions drop column if exists interval;

-- 1. Abonnement mensuel / annuel.
alter table public.nova_subscriptions add column if not exists interval text not null default 'month';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'nova_subscriptions_interval_check') then
    alter table public.nova_subscriptions add constraint nova_subscriptions_interval_check check (interval in ('month', 'year'));
  end if;
end $$;

-- 2. Export à l'unité (1,99 € par projet). « export_voices » : achats de l'ancienne grille (2 €).
alter table public.nova_purchases drop constraint if exists nova_purchases_kind_check;
alter table public.nova_purchases add constraint nova_purchases_kind_check
  check (kind in ('export_voices', 'export_project'));
create index if not exists nova_purchases_user on public.nova_purchases (user_id);

-- 3. Nova Pro offert enregistré (séance au studio, geste manuel du studio).
create table if not exists public.nova_pro_gifts (
  id text primary key check (char_length(id) between 3 and 200),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('studio', 'manuel', 'instru', 'melodie', 'melodie_exclusive')),
  days integer not null check (days between 1 and 366),
  starts_at timestamptz not null default now(),
  note text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now()
);
create index if not exists nova_pro_gifts_user on public.nova_pro_gifts (user_id);
alter table public.nova_pro_gifts enable row level security;
revoke all on public.nova_pro_gifts from anon, authenticated;
-- Le compte peut lire ses propres cadeaux (affichage), jamais les écrire.
drop policy if exists nova_pro_gifts_own_read on public.nova_pro_gifts;
create policy nova_pro_gifts_own_read on public.nova_pro_gifts for select to authenticated using (user_id = auth.uid());
grant select on public.nova_pro_gifts to authenticated;

-- 4. Projets en ligne : durée de conservation (null = sans limite : Nova Pro, admin, anciens projets).
alter table public.daw_sessions add column if not exists expires_at timestamptz;
alter table public.daw_sessions add column if not exists studio_gift boolean not null default false;
alter table public.daw_sessions add column if not exists expiry_warned_at timestamptz;
create index if not exists daw_sessions_expires on public.daw_sessions (expires_at) where expires_at is not null;
create index if not exists daw_sessions_owner_expires on public.daw_sessions (owner_id, expires_at);

-- 5. Achats d'un compte (cadeaux, déblocage des exports) et mélodie offerte du mois.
create index if not exists instrumental_purchases_user on public.instrumental_purchases (user_id, created_at);
create index if not exists instrumental_purchases_user_method on public.instrumental_purchases (user_id, payment_method, created_at);
