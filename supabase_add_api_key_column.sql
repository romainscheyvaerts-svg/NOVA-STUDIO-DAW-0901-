-- =====================================================================
-- CRÉATION DE LA TABLE PUBLIC.USERS POUR NOVA STUDIO
-- =====================================================================
-- Cette table stocke les données utilisateur étendues (profils)
-- Elle est synchronisée avec auth.users via un trigger

-- Créer la table public.users si elle n'existe pas
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  username TEXT,
  plan TEXT DEFAULT 'FREE' CHECK (plan IN ('FREE', 'PRO', 'STUDIO')),
  is_verified BOOLEAN DEFAULT FALSE,
  avatar TEXT,
  owned_instruments INTEGER[] DEFAULT '{}',
  google_ai_api_key TEXT DEFAULT 'AIzaSyCIRfnObPFke1qTGJTHeGS0GCXMfM41RH8',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Activer Row Level Security
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Policy : Les utilisateurs peuvent voir leur propre profil
CREATE POLICY "Users can view own profile"
  ON public.users
  FOR SELECT
  USING (auth.uid() = id);

-- Policy : Les utilisateurs peuvent modifier leur propre profil
CREATE POLICY "Users can update own profile"
  ON public.users
  FOR UPDATE
  USING (auth.uid() = id);

-- =====================================================================
-- TRIGGER : CRÉATION AUTOMATIQUE DU PROFIL LORS DE L'INSCRIPTION
-- =====================================================================
-- Ce trigger crée automatiquement un enregistrement dans public.users
-- quand un nouvel utilisateur s'inscrit via auth.users

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, email, username, google_ai_api_key)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'username', SPLIT_PART(NEW.email, '@', 1)),
    'AIzaSyCIRfnObPFke1qTGJTHeGS0GCXMfM41RH8'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Créer le trigger sur auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- =====================================================================
-- MIGRATION DES UTILISATEURS EXISTANTS
-- =====================================================================
-- Insère les utilisateurs de auth.users qui n'existent pas encore dans public.users

INSERT INTO public.users (id, email, username, google_ai_api_key)
SELECT
  id,
  email,
  COALESCE(raw_user_meta_data->>'username', SPLIT_PART(email, '@', 1)),
  'AIzaSyCIRfnObPFke1qTGJTHeGS0GCXMfM41RH8'
FROM auth.users
WHERE id NOT IN (SELECT id FROM public.users);

-- =====================================================================
-- VÉRIFICATION
-- =====================================================================
-- Afficher tous les utilisateurs avec leur statut de clé API

SELECT
  id,
  email,
  username,
  plan,
  CASE
    WHEN google_ai_api_key IS NOT NULL THEN 'Clé API configurée ✅'
    ELSE 'Pas de clé ❌'
  END as api_status,
  created_at
FROM public.users
ORDER BY created_at DESC;
