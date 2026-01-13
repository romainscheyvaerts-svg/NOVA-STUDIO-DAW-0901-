-- Ajout de la colonne google_ai_api_key à la table users
-- Cette colonne permet de sauvegarder la clé API Google AI de chaque utilisateur
-- dans Supabase, rendant la clé accessible depuis n'importe quel appareil

-- Ajouter la colonne si elle n'existe pas déjà
ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS google_ai_api_key TEXT;

-- Commentaire pour documenter la colonne
COMMENT ON COLUMN public.users.google_ai_api_key IS 'Clé API Google Gemini AI pour le chatbot Studio Master AI';

-- Note: La clé n'est PAS chiffrée dans la base de données
-- Pour un environnement de production, il serait recommandé d'utiliser
-- une solution de chiffrement comme pgcrypto ou un vault externe
