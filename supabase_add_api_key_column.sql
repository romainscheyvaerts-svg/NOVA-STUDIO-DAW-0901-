-- =====================================================================
-- ÉTAPE 1 : SUPPRIMER LES DÉPENDANCES EXISTANTES
-- =====================================================================

-- Supprimer le trigger s'il existe
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- Supprimer la fonction s'il existe
DROP FUNCTION IF EXISTS public.handle_new_user();

-- Supprimer les policies si elles existent
DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
DROP POLICY IF EXISTS "Users can update own profile" ON public.users;

-- =====================================================================
-- ÉTAPE 2 : CRÉER LA TABLE
-- =====================================================================

-- Supprimer la table si elle existe (pour repartir de zéro)
DROP TABLE IF EXISTS public.users CASCADE;

-- Créer la table public.users
CREATE TABLE public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  username TEXT,
  plan TEXT DEFAULT 'FREE',
  is_verified BOOLEAN DEFAULT FALSE,
  avatar TEXT,
  owned_instruments INTEGER[] DEFAULT ARRAY[]::INTEGER[],
  google_ai_api_key TEXT DEFAULT 'AIzaSyCIRfnObPFke1qTGJTHeGS0GCXMfM41RH8',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================================
-- ÉTAPE 3 : CONFIGURER LA SÉCURITÉ
-- =====================================================================

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
-- ÉTAPE 4 : CRÉER LE TRIGGER POUR LES NOUVEAUX UTILISATEURS
-- =====================================================================

-- Fonction qui crée automatiquement le profil lors de l'inscription
CREATE FUNCTION public.handle_new_user()
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

-- Trigger qui exécute la fonction
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- =====================================================================
-- ÉTAPE 5 : MIGRER LES UTILISATEURS EXISTANTS
-- =====================================================================

-- Insérer tous les utilisateurs de auth.users dans public.users
INSERT INTO public.users (id, email, username, google_ai_api_key)
SELECT
  id,
  email,
  COALESCE(raw_user_meta_data->>'username', SPLIT_PART(email, '@', 1)),
  'AIzaSyCIRfnObPFke1qTGJTHeGS0GCXMfM41RH8'
FROM auth.users;

-- =====================================================================
-- ÉTAPE 6 : VÉRIFICATION
-- =====================================================================

-- Afficher tous les utilisateurs
SELECT
  id,
  email,
  username,
  plan,
  CASE
    WHEN google_ai_api_key IS NOT NULL THEN '✅ Clé API OK'
    ELSE '❌ Pas de clé'
  END as api_status,
  created_at
FROM public.users
ORDER BY created_at DESC;
