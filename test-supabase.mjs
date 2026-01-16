import { createClient } from '@supabase/supabase-js';

// Projet 1: Principal (Auth)
const MAIN_URL = 'https://sqduhfckgvyezdiubeei.supabase.co';
const MAIN_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxZHVoZmNrZ3Z5ZXpkaXViZWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY2MDMyMTYsImV4cCI6MjA4MjE3OTIxNn0.SuqM_Z2rtonydb4cyFyaPmxF7ItKtFMY5whPsF3YoKk';

// Projet 2: Catalogue
const CATALOG_URL = 'https://mxdrxpzxbgybchzzvpkf.supabase.co';
const CATALOG_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZHJ4cHp4Ymd5YmNoenp2cGtmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1MTcwOTUsImV4cCI6MjA4NDA5MzA5NX0.pbO4Cd_7TWE6M_eP0vWeeJio8ZYdqSkqxEuTShKkG40';

async function testConnection(name, url, key) {
    console.log(`\n========== TEST: ${name} ==========`);
    console.log(`URL: ${url}`);
    
    try {
        const supabase = createClient(url, key);
        
        // Test 1: Ping le serveur
        console.log('\n1. Test connexion de base...');
        const { data: healthData, error: healthError } = await supabase.from('_test_connection').select('*').limit(1);
        // Cette erreur est normale si la table n'existe pas
        if (healthError && !healthError.message.includes('does not exist') && !healthError.message.includes('permission denied')) {
            console.log('   ❌ Erreur inattendue:', healthError.message);
        } else {
            console.log('   ✅ Connexion au serveur OK');
        }
        
        // Test 2: Vérifier les tables existantes
        console.log('\n2. Vérification des tables...');
        
        // Test table projects
        const { data: projects, error: projErr } = await supabase.from('projects').select('count').limit(1);
        if (projErr) {
            console.log(`   ⚠️  Table 'projects': ${projErr.message}`);
        } else {
            console.log(`   ✅ Table 'projects' accessible`);
        }
        
        // Test table instruments
        const { data: instruments, error: instErr } = await supabase.from('instruments').select('count').limit(1);
        if (instErr) {
            console.log(`   ⚠️  Table 'instruments': ${instErr.message}`);
        } else {
            console.log(`   ✅ Table 'instruments' accessible`);
        }
        
        // Test table pending_uploads
        const { data: pending, error: pendErr } = await supabase.from('pending_uploads').select('count').limit(1);
        if (pendErr) {
            console.log(`   ⚠️  Table 'pending_uploads': ${pendErr.message}`);
        } else {
            console.log(`   ✅ Table 'pending_uploads' accessible`);
        }
        
        // Test 3: Test Auth
        console.log('\n3. Test système Auth...');
        const { data: session, error: authErr } = await supabase.auth.getSession();
        if (authErr) {
            console.log(`   ❌ Auth Error: ${authErr.message}`);
        } else {
            console.log('   ✅ Système Auth fonctionnel');
            console.log(`   Session actuelle: ${session?.session ? 'Connecté' : 'Non connecté'}`);
        }
        
        // Test 4: Vérifier les settings Auth
        console.log('\n4. Test settings Auth (signup)...');
        // On ne peut pas vraiment tester sans créer un compte, mais on peut vérifier l'endpoint
        const response = await fetch(`${url}/auth/v1/settings`, {
            headers: {
                'apikey': key
            }
        });
        if (response.ok) {
            const settings = await response.json();
            console.log('   ✅ Auth settings accessibles');
            console.log(`   - External email enabled: ${settings.external?.email ?? 'N/A'}`);
            console.log(`   - Disable signup: ${settings.disable_signup ?? 'N/A'}`);
        } else {
            console.log(`   ⚠️  Impossible de récupérer les settings Auth: ${response.status}`);
        }
        
        console.log('\n✅ TEST TERMINÉ POUR', name);
        
    } catch (e) {
        console.log(`\n❌ ERREUR CRITIQUE: ${e.message}`);
    }
}

// Exécuter les tests
console.log('🔍 DIAGNOSTIC SUPABASE - NOVA STUDIO DAW\n');
console.log('Date:', new Date().toISOString());

await testConnection('PROJET PRINCIPAL (Auth/Projects)', MAIN_URL, MAIN_KEY);
await testConnection('PROJET CATALOGUE (Instruments)', CATALOG_URL, CATALOG_KEY);

console.log('\n\n========== RÉSUMÉ ==========');
console.log('Si vous voyez des erreurs "permission denied" ou "does not exist",');
console.log('cela signifie que les tables doivent être créées ou que RLS bloque.');
