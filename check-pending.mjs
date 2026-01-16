import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://sqduhfckgvyezdiubeei.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxZHVoZmNrZ3Z5ZXpkaXViZWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY2MDMyMTYsImV4cCI6MjA4MjE3OTIxNn0.SuqM_Z2rtonydb4cyFyaPmxF7ItKtFMY5whPsF3YoKk';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('🔍 Vérification de la table pending_uploads...\n');

// Tous les pending uploads (processed ou non)
const { data: all, error: allErr } = await supabase
    .from('pending_uploads')
    .select('*')
    .order('created_at', { ascending: false });

if (allErr) {
    console.log('❌ Erreur:', allErr.message);
} else {
    console.log(`📋 Total pending_uploads: ${all.length}\n`);
    
    if (all.length > 0) {
        all.forEach((item, i) => {
            console.log(`${i+1}. ${item.filename}`);
            console.log(`   ID: ${item.id}`);
            console.log(`   Processed: ${item.is_processed}`);
            console.log(`   URL: ${item.download_url?.substring(0, 60)}...`);
            console.log('');
        });
    } else {
        console.log('⚠️  La table pending_uploads est VIDE!');
        console.log('');
        console.log('Pour que les fichiers Google Drive apparaissent ici,');
        console.log('vous devez les ajouter manuellement à cette table');
        console.log('ou configurer une synchronisation automatique.');
    }
}

// Non processed uniquement
const { data: pending, error } = await supabase
    .from('pending_uploads')
    .select('*')
    .eq('is_processed', false);

if (!error) {
    console.log(`\n📥 Non traités (is_processed=false): ${pending?.length || 0}`);
}
