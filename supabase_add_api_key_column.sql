-- Ajout de la colonne google_ai_api_key à la table users
-- Cette colonne permet de sauvegarder la clé API Google AI de chaque utilisateur
-- dans Supabase, rendant la clé accessible depuis n'importe quel appareil

-- Ajouter la colonne si elle n'existe pas déjà
ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS google_ai_api_key TEXT;

-- Commentaire pour documenter la colonne
COMMENT ON COLUMN public.users.google_ai_api_key IS 'Clé API Google Gemini AI pour le chatbot Studio Master AI';

-- Mettre la clé API par défaut pour tous les utilisateurs existants et futurs
UPDATE public.users
SET google_ai_api_key = 'AIzaSyCIRfnObPFke1qTGJTHeGS0GCXMfM41RH8'
WHERE google_ai_api_key IS NULL OR google_ai_api_key = '';

-- Afficher le résultat
SELECT
  id,
  email,
  CASE
    WHEN google_ai_api_key IS NOT NULL THEN 'Clé API configurée ✅'
    ELSE 'Pas de clé'
  END as status
FROM public.users;
