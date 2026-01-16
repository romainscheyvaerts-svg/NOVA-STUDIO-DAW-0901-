import { createClient } from '@supabase/supabase-js';

// Projet 1: Principal (ancien)
const MAIN_URL = 'https://sqduhfckgvyezdiubeei.supabase.co';
const MAIN_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxZHVoZmNrZ3Z5ZXpkaXViZWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY2MDMyMTYsImV4cCI6MjA4MjE3OTIxNn0.SuqM_Z2rtonydb4cyFyaPmxF7ItKtFMY5whPsF3YoKk';

// Projet 2: Catalogue (nouveau)
const CATALOG_URL = 'https://mxdrxpzxbgybchzzvpkf.supabase.co';
const CATALOG_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZHJ4cHp4Ymd5YmNoenp2cGtmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1MTcwOTUsImV4cCI6MjA4NDA5MzA5NX0.pbO4Cd_7TWE6M_eP0vWeeJio8ZYdqSkqxEuTShKkG40';

async function checkInstruments(name, url, key) {
    console.log(`\n========== ${name} ==========`);
    const supabase = createClient(url, key);
    
    // Check instruments table
    const { data, error, count } = await supabase
        .from('instruments')
        .select('id, name, category, bpm, preview_url, is_visible', { count: 'exact' });
    
    if (error) {
        console.log(`❌ Erreur: ${error.message}`);
        return;
    }
    
    console.log(`✅ ${data.length} instruments trouvés\n`);
    
    if (data.length > 0) {
        data.forEach((inst, i) => {
            console.log(`${i+1}. ${inst.name} (${inst.category}, ${inst.bpm} BPM)`);
            console.log(`   Visible: ${inst.is_visible ? 'Oui' : 'Non'}`);
            console.log(`   Preview: ${inst.preview_url?.substring(0, 60)}...`);
        });
    }
    
    // Check pending_uploads
    const { data: pending, error: pendErr } = await supabase
        .from('pending_uploads')
        .select('*')
        .eq('is_processed', false);
    
    if (!pendErr && pending) {
        console.log(`\n📥 Pending uploads: ${pending.length}`);
        pending.forEach(p => console.log(`   - ${p.filename}`));
    }
}

console.log('🔍 RECHERCHE DES INSTRUMENTS DANS LES DEUX PROJETS SUPABASE\n');

await checkInstruments('PROJET PRINCIPAL (ancien)', MAIN_URL, MAIN_KEY);
await checkInstruments('PROJET CATALOGUE (nouveau)', CATALOG_URL, CATALOG_KEY);
