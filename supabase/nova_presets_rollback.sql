-- Retour arrière de supabase/migrations/20261012200000_nova_presets.sql
-- (presets synchronisés entre postes). Les presets restent sur chaque appareil :
-- le client repasse en « synchronisation bientôt disponible ».
drop trigger if exists nova_presets_cap on public.nova_presets;
drop trigger if exists nova_presets_touch on public.nova_presets;
drop table if exists public.nova_presets;
drop function if exists public.nova_presets_cap();
drop function if exists public.nova_presets_touch();
