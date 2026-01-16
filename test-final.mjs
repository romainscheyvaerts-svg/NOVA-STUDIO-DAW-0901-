import { createClient } from '@supabase/supabase-js';

// Configuration actuelle (un seul projet)
const SUPABASE_URL = 'https://sqduhfckgvyezdiubeei.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxZHVoZmNrZ3Z5ZXpkaXViZWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY2MDMyMTYsImV4cCI6MjA4MjE3OTIxNn0.SuqM_Z2rtonydb4cyFyaPmxF7ItKtFMY5whPsF3YoKk';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('🔍 Test de récupération des instruments...\n');

const { data, error } = await supabase
    .from('instruments')
    .select('*')
    .order('created_at', { ascending: false });

if (error) {
    console.log('❌ ERREUR:', error.message);
    console.log('Code:', error.code);
    console.log('Details:', error.details);
} else {
    console.log(`✅ ${data.length} instruments trouvés:\n`);
    data.forEach((inst, i) => {
        console.log(`${i+1}. ID: ${inst.id}`);
        console.log(`   Nom: ${inst.name}`);
        console.log(`   Catégorie: ${inst.category}`);
        console.log(`   BPM: ${inst.bpm}`);
        console.log(`   Visible: ${inst.is_visible}`);
        console.log(`   Preview URL: ${inst.preview_url}`);
        console.log('');
    });
}

// Test RLS policies
console.log('\n📋 Vérification des policies RLS...');
const { data: allData, error: allError } = await supabase
    .from('instruments')
    .select('id, name, is_visible');

if (allError) {
    console.log('❌ RLS bloque peut-être la lecture:', allError.message);
} else {
    console.log(`✅ RLS OK - ${allData.length} instruments accessibles`);
}
