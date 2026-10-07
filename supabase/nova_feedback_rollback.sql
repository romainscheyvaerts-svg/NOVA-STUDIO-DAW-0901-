-- =====================================================================================
-- Retour arrière de supabase/nova_feedback.sql
--
-- ATTENTION : supprime TOUS les signalements. Pour les garder, exporte-les d'abord
-- (Table Editor > nova_feedback > Export to CSV, ou `python scripts/feedback_pull.py`).
--
-- Les captures : Supabase interdit de supprimer des fichiers en SQL. Vide d'abord le
-- bucket « nova-feedback » (Storage > nova-feedback > tout sélectionner > Supprimer),
-- puis lance ce script : il retire le bucket s'il est vide, sinon il le laisse et
-- l'indique (relance-le après l'avoir vidé).
-- =====================================================================================

begin;

drop policy if exists nova_feedback_upload on storage.objects;
drop function if exists public.nova_feedback_upload_allowed(text);
drop function if exists public.nova_feedback_statuts(text, text[]);

-- Supprime aussi ses triggers, policies et index.
drop table if exists public.nova_feedback;
drop table if exists public.nova_feedback_rate;

drop function if exists public.nova_feedback_before_insert();
drop function if exists public.nova_feedback_touch();

do $$
begin
  if exists (select 1 from storage.objects where bucket_id = 'nova-feedback') then
    raise notice 'Bucket nova-feedback pas vide : vide-le dans Storage puis relance ce script pour le retirer.';
  else
    delete from storage.buckets where id = 'nova-feedback';
  end if;
end;
$$;

commit;
