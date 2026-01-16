
import { createClient } from '@supabase/supabase-js';

// =================================================================
// 🔑 ZONE DE CONFIGURATION SUPABASE - DEUX PROJETS
// =================================================================

// =============================================
// PROJET 1: PRINCIPAL (Auth, Projets, Users)
// =============================================
const SUPABASE_URL = 'https://sqduhfckgvyezdiubeei.supabase.co'; 
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxZHVoZmNrZ3Z5ZXpkaXViZWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY2MDMyMTYsImV4cCI6MjA4MjE3OTIxNn0.SuqM_Z2rtonydb4cyFyaPmxF7ItKtFMY5whPsF3YoKk';

// =============================================
// PROJET 2: CATALOGUE INSTRUMENTS (Google Drive)
// Project ID: mxdrxpzxbgybchzzvpkf
// =============================================
const CATALOG_SUPABASE_URL = 'https://mxdrxpzxbgybchzzvpkf.supabase.co'; 
const CATALOG_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZHJ4cHp4Ymd5YmNoenp2cGtmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1MTcwOTUsImV4cCI6MjA4NDA5MzA5NX0.pbO4Cd_7TWE6M_eP0vWeeJio8ZYdqSkqxEuTShKkG40';

// =================================================================

export const isSupabaseConfigured = () => {
    return SUPABASE_URL.startsWith('https://') && SUPABASE_ANON_KEY.length > 20 && !SUPABASE_ANON_KEY.includes('COLLE_TA_CLE');
};

export const isCatalogSupabaseConfigured = () => {
    return CATALOG_SUPABASE_URL.startsWith('https://') && CATALOG_SUPABASE_ANON_KEY.length > 20;
};

// Client principal (Auth, Projets, Users)
export const supabase = isSupabaseConfigured() 
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) 
    : null;

// Client catalogue (Instruments depuis Google Drive)
export const catalogSupabase = isCatalogSupabaseConfigured()
    ? createClient(CATALOG_SUPABASE_URL, CATALOG_SUPABASE_ANON_KEY)
    : null;
