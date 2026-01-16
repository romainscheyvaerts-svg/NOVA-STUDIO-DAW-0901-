-- ===========================================================================
-- NOVA STUDIO DAW - SUPABASE DATABASE SCHEMA
-- Project ID: mxdrxpzxbgybchzzvpkf
-- ===========================================================================

-- 1. TABLE: instruments (Catalogue de beats/instrumentaux)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS instruments (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Trap',
    bpm INTEGER NOT NULL DEFAULT 140,
    musical_key TEXT NOT NULL DEFAULT 'C Minor',
    image_url TEXT,
    preview_url TEXT NOT NULL,
    stems_url TEXT,
    price_basic DECIMAL(10,2) NOT NULL DEFAULT 29.99,
    price_premium DECIMAL(10,2) NOT NULL DEFAULT 79.99,
    price_exclusive DECIMAL(10,2) NOT NULL DEFAULT 299.99,
    stripe_link_basic TEXT,
    stripe_link_premium TEXT,
    stripe_link_exclusive TEXT,
    is_visible BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index pour ameliorer les requetes
CREATE INDEX IF NOT EXISTS idx_instruments_visible ON instruments(is_visible);
CREATE INDEX IF NOT EXISTS idx_instruments_category ON instruments(category);

-- 2. TABLE: pending_uploads (Fichiers en attente depuis Google Drive)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS pending_uploads (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL,
    download_url TEXT NOT NULL,
    is_processed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_unprocessed ON pending_uploads(is_processed) WHERE is_processed = false;

-- 3. TABLE: user_licenses (Licences achetees par les utilisateurs)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS user_licenses (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    instrument_id INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
    license_type TEXT NOT NULL DEFAULT 'basic',
    purchased_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, instrument_id, license_type)
);

CREATE INDEX IF NOT EXISTS idx_licenses_user ON user_licenses(user_id);

-- 4. TABLE: projects (Projets sauvegardes)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Untitled Project',
    data JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);

-- 5. TABLE: project_backups (Auto-sauvegardes)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS project_backups (
    id SERIAL PRIMARY KEY,
    project_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    project_data JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backups_user ON project_backups(user_id);
CREATE INDEX IF NOT EXISTS idx_backups_project ON project_backups(project_id);

-- ===========================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ===========================================================================

-- Enable RLS on all tables
ALTER TABLE instruments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_backups ENABLE ROW LEVEL SECURITY;

-- INSTRUMENTS: Public read for visible instruments, admin write
CREATE POLICY "Anyone can view visible instruments" ON instruments
    FOR SELECT USING (is_visible = true);

CREATE POLICY "Admin can manage all instruments" ON instruments
    FOR ALL USING (
        auth.jwt() ->> 'email' = 'romain.scheyvaerts@gmail.com'
    );

-- PENDING_UPLOADS: Admin only
CREATE POLICY "Admin can manage pending uploads" ON pending_uploads
    FOR ALL USING (
        auth.jwt() ->> 'email' = 'romain.scheyvaerts@gmail.com'
    );

-- USER_LICENSES: Users can view their own licenses
CREATE POLICY "Users can view own licenses" ON user_licenses
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "System can insert licenses" ON user_licenses
    FOR INSERT WITH CHECK (true);

-- PROJECTS: Users can only access their own projects
CREATE POLICY "Users can view own projects" ON projects
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own projects" ON projects
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own projects" ON projects
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own projects" ON projects
    FOR DELETE USING (auth.uid() = user_id);

-- PROJECT_BACKUPS: Users can only access their own backups
CREATE POLICY "Users can view own backups" ON project_backups
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own backups" ON project_backups
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ===========================================================================
-- STORAGE BUCKETS (A creer dans l'interface Supabase)
-- ===========================================================================
-- Creer les buckets suivants dans Storage:
-- 1. "instruments" - Public, pour covers/previews/stems du catalogue
-- 2. "project-assets" - Private, pour les fichiers audio des projets
-- 3. "audio-files" - Private, pour les fichiers audio uploades

-- Policies de storage (a configurer dans l'interface Supabase):
-- instruments: Public read
-- project-assets: Authenticated users can read/write their own folder
-- audio-files: Authenticated users can read/write their own folder
