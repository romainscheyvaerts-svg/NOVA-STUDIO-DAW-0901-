
import { createClient } from '@supabase/supabase-js';

// =================================================================
// 🔑 ZONE DE CONFIGURATION SUPABASE
// =================================================================

// 1. URL DU PROJET
const SUPABASE_URL = 'https://sqduhfckgvyezdiubeei.supabase.co'; 

// 2. CLÉ API "ANON" (PUBLIC)
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxZHVoZmNrZ3Z5ZXpkaXViZWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY2MDMyMTYsImV4cCI6MjA4MjE3OTIxNn0.SuqM_Z2rtonydb4cyFyaPmxF7ItKtFMY5whPsF3YoKk';

// =================================================================

export const isSupabaseConfigured = () => {
    return SUPABASE_URL.startsWith('https://') && SUPABASE_ANON_KEY.length > 20 && !SUPABASE_ANON_KEY.includes('COLLE_TA_CLE');
};

// Création du client unique
export const supabase = isSupabaseConfigured() 
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) 
    : null;
