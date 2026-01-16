import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://sqduhfckgvyezdiubeei.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxZHVoZmNrZ3Z5ZXpkaXViZWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY2MDMyMTYsImV4cCI6MjA4MjE3OTIxNn0.SuqM_Z2rtonydb4cyFyaPmxF7ItKtFMY5whPsF3YoKk';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('🔍 Vérification de la table "instrumentals"...\n');

const { data, error } = await supabase
    .from('instrumentals')
    .select('*')
    .order('created_at', { ascending: false });

if (error) {
    console.log('❌ Erreur:', error.message);
    console.log('Code:', error.code);
} else {
    console.log(`✅ ${data.length} instrumentaux trouvés dans la table "instrumentals":\n`);
    
    data.forEach((inst, i) => {
        console.log(`${i+1}. ${inst.title}`);
        console.log(`   ID: ${inst.id}`);
        console.log(`   Genre: ${inst.genre || 'N/A'}`);
        console.log(`   BPM: ${inst.bpm || 'N/A'}`);
        console.log(`   Key: ${inst.key || 'N/A'}`);
        console.log(`   Active: ${inst.is_active}`);
        console.log(`   Drive ID: ${inst.drive_file_id || 'N/A'}`);
        console.log(`   Preview URL: ${inst.preview_url?.substring(0, 50) || 'N/A'}...`);
        console.log(`   Prix Base: ${inst.price_base}€`);
        console.log('');
    });
}
