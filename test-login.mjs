import { createClient } from '@supabase/supabase-js';

const MAIN_URL = 'https://sqduhfckgvyezdiubeei.supabase.co';
const MAIN_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxZHVoZmNrZ3Z5ZXpkaXViZWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY2MDMyMTYsImV4cCI6MjA4MjE3OTIxNn0.SuqM_Z2rtonydb4cyFyaPmxF7ItKtFMY5whPsF3YoKk';

const supabase = createClient(MAIN_URL, MAIN_KEY);

// Test 1: Vérifier si l'utilisateur existe en essayant de récupérer un magic link
console.log('🔍 Test de connexion pour: romain.scheyvaerts@gmail.com\n');

// Test avec OTP (magic link)
console.log('1. Test envoi Magic Link (OTP)...');
const { data: otpData, error: otpError } = await supabase.auth.signInWithOtp({
    email: 'romain.scheyvaerts@gmail.com',
    options: {
        shouldCreateUser: false // Ne pas créer si n'existe pas
    }
});

if (otpError) {
    console.log(`   Résultat: ${otpError.message}`);
    if (otpError.message.includes('User not found') || otpError.message.includes('Signups not allowed')) {
        console.log('   ⚠️  L\'utilisateur n\'existe PAS dans la base!');
    }
} else {
    console.log('   ✅ Magic link envoyé (vérifiez vos spams)');
}

// Test 2: Vérifier la configuration email SMTP
console.log('\n2. Vérification configuration SMTP...');
const response = await fetch(`${MAIN_URL}/auth/v1/settings`, {
    headers: { 'apikey': MAIN_KEY }
});
const settings = await response.json();
console.log('   - SMTP configured:', settings.smtp_admin_email ? 'Oui' : 'Non (utilise Supabase par défaut)');
console.log('   - Mailer autoconfirm:', settings.mailer_autoconfirm ?? 'N/A');

// Test 3: Essayer de créer un compte test
console.log('\n3. Test création de compte...');
const testEmail = `test-${Date.now()}@example.com`;
const { data: signupData, error: signupError } = await supabase.auth.signUp({
    email: testEmail,
    password: 'TestPassword123!'
});

if (signupError) {
    console.log(`   Erreur signup: ${signupError.message}`);
} else {
    console.log(`   ✅ Signup fonctionne (compte test créé: ${testEmail})`);
    console.log(`   - User ID: ${signupData.user?.id || 'N/A'}`);
    console.log(`   - Email confirmé: ${signupData.user?.email_confirmed_at ? 'Oui' : 'Non (email requis)'}`);
}

console.log('\n========== DIAGNOSTIC ==========');
console.log('Si vous ne recevez pas d\'email, vérifiez:');
console.log('1. Votre dossier SPAM');
console.log('2. Dans Supabase Dashboard > Auth > Email Templates');
console.log('3. Dans Supabase Dashboard > Project Settings > Auth');
