
import { createClient } from '@supabase/supabase-js';

// =================================================================
// 🔑 ZONE DE CONFIGURATION SUPABASE - DEUX PROJETS
// =================================================================

// PROJET 1: PRINCIPAL (Auth, Projets utilisateurs)
// Project ID: sqduhfckgvyezdiubeei
const SUPABASE_URL = 'https://sqduhfckgvyezdiubeei.supabase.co'; 
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxZHVoZmNrZ3Z5ZXpkaXViZWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY2MDMyMTYsImV4cCI6MjA4MjE3OTIxNn0.SuqM_Z2rtonydb4cyFyaPmxF7ItKtFMY5whPsF3YoKk';

// PROJET 2: CATALOGUE INSTRUMENTALS (table instrumentals avec Google Drive)
// Project ID: mxdrxpzxbgybchzzvpkf
const CATALOG_SUPABASE_URL = 'https://mxdrxpzxbgybchzzvpkf.supabase.co'; 
const CATALOG_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZHJ4cHp4Ymd5YmNoenp2cGtmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1MTcwOTUsImV4cCI6MjA4NDA5MzA5NX0.pbO4Cd_7TWE6M_eP0vWeeJio8ZYdqSkqxEuTShKkG40';

// =================================================================

export const isSupabaseConfigured = () => {
    return SUPABASE_URL.startsWith('https://') && SUPABASE_ANON_KEY.length > 20;
};

/** Retour de « Continuer avec Google » (site) : marque posée dans l'adresse de retour. */
export const GOOGLE_RETURN_PARAM = 'nova_google';
const isGoogleReturn = (() => {
    try { return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has(GOOGLE_RETURN_PARAM); } catch { return false; }
})();

// Client principal (Auth, Projets). Au retour de Google, les jetons (dans le #) sont ceux du
// compte Make Music : seul le client du catalogue doit les lire (sinon les deux se les disputent).
export const supabase = isSupabaseConfigured() 
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, isGoogleReturn ? { auth: { detectSessionInUrl: false } } : undefined) 
    : null;

// Client catalogue (table instrumentals) : aussi le compte Make Music (connexion, Google compris).
export const catalogSupabase = createClient(CATALOG_SUPABASE_URL, CATALOG_SUPABASE_KEY);

// Retour de Google : une fois la session lue, la marque est retirée de l'adresse.
if (isGoogleReturn) {
    catalogSupabase.auth.getSession().finally(() => {
        try {
            const u = new URL(window.location.href);
            u.searchParams.delete(GOOGLE_RETURN_PARAM);
            window.history.replaceState(window.history.state, '', u.toString());
        } catch { /* adresse déjà propre */ }
    });
}

// Log de débogage au chargement du module
console.log("[Supabase] Configuration chargée:");
console.log("  - Main Supabase:", !!supabase, "(", SUPABASE_URL, ")");
console.log("  - Catalog Supabase:", !!catalogSupabase, "(", CATALOG_SUPABASE_URL, ")");
