import { createClient } from '@supabase/supabase-js';

// NOUVEAU PROJET SUPABASE
const SUPABASE_URL = 'https://mxdrxpzxbgybchzzvpkf.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZHJ4cHp4Ymd5YmNoenp2cGtmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1MTcwOTUsImV4cCI6MjA4NDA5MzA5NX0.pbO4Cd_7TWE6M_eP0vWeeJio8ZYdqSkqxEuTShKkG40';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('🔍 Vérification de la table "instrumentals" dans le NOUVEAU projet...\n');

const { data, error } = await supabase
    .from('instrumentals')
    .select('*')
    .order('created_at', { ascending: false });

if (error) {
    console.log('❌ Erreur:', error.message);
} else {
    console.log(`✅ ${data.length} instrumentaux trouvés:\n`);
    
    data.slice(0, 10).forEach((inst, i) => {
        console.log(`${i+1}. ${inst.title}`);
        console.log(`   ID: ${inst.id}`);
        console.log(`   Genre: ${inst.genre || 'N/A'}`);
        console.log(`   BPM: ${inst.bpm || 'N/A'}`);
        console.log(`   Key: ${inst.key || 'N/A'}`);
        console.log(`   Active: ${inst.is_active}`);
        console.log(`   Drive File ID: ${inst.drive_file_id || 'N/A'}`);
        console.log(`   Prix Base: ${inst.price_base}€`);
        console.log('');
    });
    
    if (data.length > 10) {
        console.log(`... et ${data.length - 10} autres`);
    }
}
