
import { createClient } from '@supabase/supabase-js';

// =================================================================
// 🔑 ZONE DE CONFIGURATION SUPABASE
// =================================================================

// 1. URL DU PROJET (Project ID: mxdrxpzxbgybchzzvpkf)
const SUPABASE_URL = 'https://mxdrxpzxbgybchzzvpkf.supabase.co'; 

// 2. CLÉ API "ANON" (PUBLIC)
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZHJ4cHp4Ymd5YmNoenp2cGtmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1MTcwOTUsImV4cCI6MjA4NDA5MzA5NX0.pbO4Cd_7TWE6M_eP0vWeeJio8ZYdqSkqxEuTShKkG40';

// =================================================================

export const isSupabaseConfigured = () => {
    return SUPABASE_URL.startsWith('https://') && SUPABASE_ANON_KEY.length > 20 && !SUPABASE_ANON_KEY.includes('COLLE_TA_CLE');
};

// Création du client unique
export const supabase = isSupabaseConfigured() 
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) 
    : null;
