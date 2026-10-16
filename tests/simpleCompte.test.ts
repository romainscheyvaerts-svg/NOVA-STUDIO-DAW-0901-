// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { starterTracks, ADVANCED_ONLY_VOICE_IDS } from '../utils/starterTracks';
import { cloudRoute, onlineSessionInfo } from '../utils/cloudAccount';

/**
 * 16/10/2026 (décisions de Romain) :
 *  1. mode simple : un nouveau projet = BEAT + UNE piste REC (le mode avancé garde le gabarit complet) ;
 *  2. « Créer un compte » dans NOVA crée le compte MAKE MUSIC (projet mxdrx…), avec le parcours du site.
 */

const TEMPLATE = ['instrumental', 'track-rec-main', 'lead-couplet', 'lead-refrain', 'back-1', 'back-2', 'bus-vox', 'bus-fx', 'send-verb-short', 'master']
  .map(id => ({ id }));

describe('nouveau projet : pistes selon le mode', () => {
  it('mode simple : BEAT et une seule piste REC (plus LEAD COUPLET, LEAD REFRAIN, BACK 1, BACK 2)', () => {
    const ids = starterTracks(TEMPLATE, true).map(t => t.id);
    expect(ids).toEqual(['instrumental', 'track-rec-main', 'bus-vox', 'bus-fx', 'send-verb-short', 'master']);
    for (const id of ADVANCED_ONLY_VOICE_IDS) expect(ids).not.toContain(id);
  });
  it('mode avancé : le gabarit de séance voix reste complet', () => {
    expect(starterTracks(TEMPLATE, false)).toBe(TEMPLATE);
  });
  it('App.tsx : le projet neuf passe par starterTracks avec le mode simple, et c\'est le seul gabarit', () => {
    const app = readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf-8');
    expect(app).toMatch(/tracks: starterTracks\(\[/);
    expect(app).toMatch(/\], simpleModeStore\.get\(\)\.simple\),/);
    // Un projet ouvert garde ses pistes : aucune autre création des 4 pistes du gabarit.
    expect(app.match(/id: 'lead-couplet'/g)?.length).toBe(1);
  });
});

describe('« Sauvegarder dans le cloud » selon le compte', () => {
  const mm = { id: 'mm1', email: 'a@b.be' };
  it('compte de l\'ancien projet : l\'ancien système, inchangé', () => {
    expect(cloudRoute({ id: 'u-main' }, mm)).toBe('legacy');
    expect(cloudRoute({ id: 'u-main' }, null)).toBe('legacy');
  });
  it('compte Make Music seulement (invité ou rien) : séance en ligne Make Music', () => {
    expect(cloudRoute(null, mm)).toBe('makemusic');
    expect(cloudRoute({ id: 'guest' }, mm)).toBe('makemusic');
  });
  it('aucun compte : se connecter', () => {
    expect(cloudRoute(null, null)).toBe('login');
    expect(cloudRoute({ id: 'guest' }, null)).toBe('login');
  });
  it('ligne d\'info d\'une séance en ligne : modifiée le…, gardée jusqu\'au… / sans limite / plus gardée', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    expect(onlineSessionInfo({ id: '1', link: 'x', name: 'S', updated_at: '2026-10-15T10:00:00Z', updated_from: 'iPad', expires_at: '2026-10-21T10:00:00Z' }, now))
      .toMatch(/^modifiée le 15 oct.* sur iPad · gardée jusqu'au 21 octobre$/);
    expect(onlineSessionInfo({ id: '1', link: 'x', name: 'S', unlimited: true }, now)).toBe('gardée sans limite');
    expect(onlineSessionInfo({ id: '1', link: 'x', name: 'S', expires_at: '2026-10-01T00:00:00Z' }, now)).toBe('plus gardée en ligne');
  });
});

describe('inscription Make Music : règles du site', async () => {
  const { passwordRules, passwordOk, emailOk, signupProblem, confirmRedirectUrl, signupErrorMessage } = await import('../services/makeMusicSignup');
  it('mot de passe : 12 caractères, une majuscule, une minuscule, un chiffre (comme studiomakemusic.com)', () => {
    expect(passwordOk('Motdepasse12')).toBe(true);
    expect(passwordOk('motdepasse12')).toBe(false); // pas de majuscule
    expect(passwordOk('MOTDEPASSE12')).toBe(false); // pas de minuscule
    expect(passwordOk('Motdepassexx')).toBe(false); // pas de chiffre
    expect(passwordOk('Motdepa12')).toBe(false); // trop court
    expect(passwordRules('a').map(r => r.ok)).toEqual([false, false, true, false]);
  });
  it('formulaire : nom obligatoire, e-mail valide, phrase claire pour ce qui manque', () => {
    expect(signupProblem({ name: '', email: 'a@b.be', password: 'Motdepasse12' })).toMatch(/nom/);
    expect(signupProblem({ name: 'Lina', email: 'pas-un-mail', password: 'Motdepasse12' })).toMatch(/e-mail n’est pas valide/);
    expect(signupProblem({ name: 'Lina', email: 'a@b.be', password: 'court' })).toBe('Mot de passe trop faible : il manque 12 caractères, une majuscule, un chiffre.');
    expect(signupProblem({ name: 'Lina', email: 'a@b.be', password: 'Motdepasse12', confirm: 'autre' })).toMatch(/pas identiques/);
    expect(signupProblem({ name: 'Lina', email: ' a@b.be ', password: 'Motdepasse12' })).toBeNull();
    expect(emailOk('x@y')).toBe(false);
  });
  it('lien de confirmation : la page /auth du site, qui rouvre le studio intégré (/daw) ; appli Windows : /auth', () => {
    expect(confirmRedirectUrl()).toBe('https://www.studiomakemusic.com/auth?redirect=%2Fdaw');
    expect(confirmRedirectUrl(true)).toBe('https://www.studiomakemusic.com/auth');
  });
  it('refus du serveur : jamais l\'anglais de Supabase', () => {
    expect(signupErrorMessage({ message: 'User already registered', status: 422 })).toMatch(/déjà un compte Make Music/);
    expect(signupErrorMessage({ code: 'weak_password', message: 'Password should be at least 6 characters' })).toMatch(/trop faible/);
    expect(signupErrorMessage({ code: 'over_email_send_rate_limit', message: 'email rate limit exceeded', status: 429 })).toMatch(/Trop d’essais/);
    expect(signupErrorMessage({ message: 'Service for this project is restricted', status: 402 })).toMatch(/momentanément indisponible/);
    expect(signupErrorMessage({ code: 'signup_disabled', message: 'Signups not allowed for this instance' })).toMatch(/fermée/);
  });
});

describe('signUpMakeMusic : appel au projet Make Music', async () => {
  const { signUpMakeMusic, resendConfirmation, sendMakeMusicPasswordReset } = await import('../services/makeMusicSignup');
  const fakeAuth = (reply: { data?: any; error?: any }) => {
    const calls: any[] = [];
    return { calls, auth: {
      signUp: async (a: any) => { calls.push(['signUp', a]); return { data: reply.data ?? null, error: reply.error ?? null }; },
      resend: async (a: any) => { calls.push(['resend', a]); return { error: null }; },
      resetPasswordForEmail: async (e: string, o: any) => { calls.push(['reset', e, o]); return { error: null }; },
    } };
  };
  const input = { name: '  Lina K ', email: ' lina@exemple.be ', password: 'Motdepasse12' };

  it('envoie e-mail, mot de passe, full_name (comme le site) et le lien de retour ; confirmation attendue', async () => {
    const f = fakeAuth({ data: { user: { id: 'u1', email: 'lina@exemple.be', identities: [{ id: 'i' }] }, session: null } });
    const r = await signUpMakeMusic(input, { auth: f.auth });
    expect(r).toEqual({ status: 'confirm_email', email: 'lina@exemple.be' });
    expect(f.calls[0]).toEqual(['signUp', {
      email: 'lina@exemple.be', password: 'Motdepasse12',
      options: { emailRedirectTo: 'https://www.studiomakemusic.com/auth?redirect=%2Fdaw', data: { full_name: 'Lina K' } },
    }]);
  });
  it('serveur sans confirmation : compte ouvert tout de suite', async () => {
    const f = fakeAuth({ data: { user: { id: 'u1', email: 'lina@exemple.be', identities: [{}] }, session: { access_token: 't' } } });
    expect(await signUpMakeMusic(input, { auth: f.auth, desktop: true })).toEqual({ status: 'signed_in', email: 'lina@exemple.be', userId: 'u1' });
    expect(f.calls[0][1].options.emailRedirectTo).toBe('https://www.studiomakemusic.com/auth');
  });
  it('e-mail déjà inscrit (réponse « réussie » sans identité) : on le dit, pas d\'attente d\'un mail fantôme', async () => {
    const f = fakeAuth({ data: { user: { id: 'u1', identities: [] }, session: null } });
    await expect(signUpMakeMusic(input, { auth: f.auth })).rejects.toThrow(/déjà un compte Make Music/);
  });
  it('formulaire incomplet : rien n\'est envoyé au serveur', async () => {
    const f = fakeAuth({});
    await expect(signUpMakeMusic({ ...input, password: 'faible' }, { auth: f.auth })).rejects.toThrow(/trop faible/);
    expect(f.calls).toHaveLength(0);
  });
  it('réseau coupé : message clair', async () => {
    const auth = { signUp: async () => { throw Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError' }); } };
    await expect(signUpMakeMusic(input, { auth })).rejects.toThrow(/indisponible|connexion Internet/);
  });
  it('« Renvoyer l\'e-mail » et « Mot de passe oublié » passent par le projet Make Music', async () => {
    const f = fakeAuth({});
    await resendConfirmation('lina@exemple.be', { auth: f.auth });
    await sendMakeMusicPasswordReset('lina@exemple.be', { auth: f.auth });
    expect(f.calls[0]).toEqual(['resend', { type: 'signup', email: 'lina@exemple.be', options: { emailRedirectTo: 'https://www.studiomakemusic.com/auth?redirect=%2Fdaw' } }]);
    expect(f.calls[1]).toEqual(['reset', 'lina@exemple.be', { redirectTo: 'https://www.studiomakemusic.com/auth' }]);
  });
});

describe('AuthService : « Créer un compte » de la barre et de l\'accueil = compte Make Music', () => {
  afterEach(() => { vi.doUnmock('../services/supabase'); vi.doUnmock('../services/SupabaseManager'); vi.resetModules(); });
  const load = async (mmReply: { data?: any; error?: any }, mmLogin?: { error: any }) => {
    vi.resetModules();
    const calls = { mainSignUp: 0, mmSignUp: [] as any[] };
    vi.doMock('../services/supabase', () => ({
      isSupabaseConfigured: () => true,
      supabase: { auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signUp: async () => { calls.mainSignUp++; return { data: {}, error: null }; },
        signInWithPassword: async () => ({ data: { user: null }, error: Object.assign(new Error('Invalid login credentials'), { status: 400 }) }),
      } },
      catalogSupabase: { auth: {
        signUp: async (a: any) => { calls.mmSignUp.push(a); return { data: mmReply.data ?? null, error: mmReply.error ?? null }; },
        signInWithPassword: async () => ({ data: { user: null }, error: mmLogin?.error ?? Object.assign(new Error('Invalid login credentials'), { status: 400 }) }),
      } },
    }));
    vi.doMock('../services/SupabaseManager', () => ({ supabaseManager: {} }));
    const { authService } = await import('../services/AuthService');
    return { authService, calls };
  };

  it('inscription : compte créé dans le projet Make Music, jamais dans l\'ancien', async () => {
    const { authService, calls } = await load({ data: { user: { id: 'u1', identities: [{}] }, session: null } });
    const r = await authService.register('lina@exemple.be', 'Motdepasse12', 'Lina');
    expect(r).toMatchObject({ success: true, needsConfirm: true });
    expect(calls.mainSignUp).toBe(0);
    expect(calls.mmSignUp).toHaveLength(1);
    expect(calls.mmSignUp[0].options.data).toEqual({ full_name: 'Lina' });
  });
  it('inscription refusée : message clair, en français', async () => {
    const { authService } = await load({ error: { message: 'User already registered', status: 422 } });
    const r = await authService.register('lina@exemple.be', 'Motdepasse12', 'Lina');
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/déjà un compte Make Music/);
  });
  it('connexion avant d\'avoir cliqué le lien : « confirme ton e-mail » (avant : anglais)', async () => {
    const { authService } = await load({}, { error: Object.assign(new Error('Email not confirmed'), { status: 400, code: 'email_not_confirmed' }) });
    const r = await authService.login('lina@exemple.be', 'Motdepasse12');
    expect(r).toMatchObject({ success: false, needsConfirm: true });
    expect(r.message).toMatch(/pas encore confirmé/);
  });
  it('mauvais identifiants : message en français', async () => {
    const { authService } = await load({});
    const r = await authService.login('lina@exemple.be', 'faux');
    expect(r.success).toBe(false);
    expect(r.message).toBe('E-mail ou mot de passe incorrect.');
  });
});
