-- Facturation Nova : abonnements (collaboration 5 €/mois, beatmaker 10 €/mois)
-- et achats à l'unité (export des voix seules 2 €). Écrits uniquement par la
-- fonction nova-billing (service role) après vérification chez Stripe.

create table if not exists public.nova_subscriptions (
  stripe_subscription_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('collab', 'beatmaker')),
  stripe_customer_id text,
  status text not null,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists nova_subscriptions_user on public.nova_subscriptions (user_id);
alter table public.nova_subscriptions enable row level security;
revoke all on public.nova_subscriptions from anon, authenticated;

create table if not exists public.nova_purchases (
  checkout_session_id text primary key,
  kind text not null check (kind in ('export_voices')),
  project_key text not null,
  user_id uuid references auth.users(id) on delete set null,
  email text,
  amount_cents integer not null,
  created_at timestamptz not null default now()
);
create index if not exists nova_purchases_project on public.nova_purchases (project_key);
alter table public.nova_purchases enable row level security;
revoke all on public.nova_purchases from anon, authenticated;

-- Nova Pro : 10 exports gratuits par période d'abonnement (un export débloque le projet).
create table if not exists public.nova_export_uses (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, project_key)
);
create index if not exists nova_export_uses_user on public.nova_export_uses (user_id, created_at);
alter table public.nova_export_uses enable row level security;
revoke all on public.nova_export_uses from anon, authenticated;
revoke all on sequence public.nova_export_uses_id_seq from anon, authenticated;
