import { catalogSupabase } from './supabase';
import { friendlyAuthError } from '../utils/desktopAccess';
import { authServiceMessage } from '../utils/authStatus';

/**
 * « Créer un compte » dans NOVA = compte Make Music (projet mxdrx…), celui de studiomakemusic.com.
 *
 * Avant (16/10/2026) : la fenêtre « Se connecter » de la barre et de l'accueil créait un compte de
 * l'ANCIEN projet (sqduhf…), inconnu des paiements, de la collaboration, des séances en ligne, du
 * site et de l'appli Windows. Les autres fenêtres renvoyaient vers le site, ou créaient le compte
 * Make Music avec d'autres règles (6 caractères, sans nom, sans lien de retour).
 *
 * Ici, un seul parcours, le même que le site (src/pages/Auth.tsx de studiomakemusic.com) :
 *  - e-mail valide, nom (ou nom d'artiste) obligatoire, enregistré dans `full_name` comme sur le site ;
 *  - mot de passe : 12 caractères au moins, avec une majuscule, une minuscule et un chiffre ;
 *  - confirmation par e-mail : le lien ramène sur studiomakemusic.com (page /auth), qui ouvre
 *    ensuite le studio NOVA intégré (/daw) déjà connecté ; dans l'appli Windows, le lien ouvre le site
 *    et l'on revient se connecter dans l'appli ;
 *  - « déjà un compte », trop d'essais, service indisponible : messages clairs, en français.
 * Aucun compte n'est copié ni migré d'un projet à l'autre.
 */

export const SITE_URL = 'https://www.studiomakemusic.com';
export const PASSWORD_MIN = 12;

export interface PasswordRule { id: 'len' | 'upper' | 'lower' | 'digit'; label: string; ok: boolean }

/** Règles du mot de passe (celles du site), avec leur état pour l'aide en direct sous le champ. */
export function passwordRules(pw: string): PasswordRule[] {
  return [
    { id: 'len', label: `${PASSWORD_MIN} caractères`, ok: pw.length >= PASSWORD_MIN },
    { id: 'upper', label: 'une majuscule', ok: /[A-Z]/.test(pw) },
    { id: 'lower', label: 'une minuscule', ok: /[a-z]/.test(pw) },
    { id: 'digit', label: 'un chiffre', ok: /[0-9]/.test(pw) },
  ];
}
export const passwordOk = (pw: string) => passwordRules(pw).every(r => r.ok);
export const emailOk = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

export interface SignupInput { name: string; email: string; password: string; confirm?: string }

/** Premier problème du formulaire (phrase claire), ou null si tout est bon. */
export function signupProblem(i: SignupInput): string | null {
  if (!i.name.trim()) return 'Indique ton nom (ou ton nom d’artiste).';
  if (!emailOk(i.email)) return 'Cet e-mail n’est pas valide : vérifie-le (ex. : toi@exemple.com).';
  if (!passwordOk(i.password)) {
    const missing = passwordRules(i.password).filter(r => !r.ok).map(r => r.label);
    return `Mot de passe trop faible : il manque ${missing.join(', ')}.`;
  }
  if (i.confirm !== undefined && i.confirm !== i.password) return 'Les deux mots de passe ne sont pas identiques.';
  return null;
}

/**
 * Adresse du lien de confirmation. Web : la page /auth du site, qui renvoie au studio intégré
 * (/daw) une fois connecté (comme le site, qui ramène là où l'on était). Appli Windows : la page
 * /auth seule (on revient ensuite se connecter dans l'appli).
 */
export const confirmRedirectUrl = (desktop = false) =>
  desktop ? `${SITE_URL}/auth` : `${SITE_URL}/auth?redirect=${encodeURIComponent('/daw')}`;

export type SignupResult =
  | { status: 'confirm_email'; email: string }
  | { status: 'signed_in'; email: string; userId: string };

type AuthLike = {
  signUp(args: any): Promise<{ data: any; error: any }>;
  resend?(args: any): Promise<{ data?: any; error: any }>;
  resetPasswordForEmail?(email: string, opts?: any): Promise<{ data?: any; error: any }>;
};

const defaultAuth = (): AuthLike => catalogSupabase.auth as unknown as AuthLike;

/** Message clair pour un refus d'inscription (jamais l'anglais de Supabase). */
export function signupErrorMessage(err: unknown): string {
  const raw = typeof err === 'string' ? err : String((err as any)?.message || (err as any)?.msg || '');
  const code = String((err as any)?.code || (err as any)?.error_code || '');
  const m = raw.toLowerCase();
  if (code === 'user_already_exists' || m.includes('already registered') || m.includes('already been registered') || m.includes('already exists'))
    return 'Cet e-mail a déjà un compte Make Music : connecte-toi avec ton mot de passe (ou « Mot de passe oublié ? »).';
  if (code === 'weak_password' || m.includes('password should') || m.includes('weak password'))
    return `Mot de passe trop faible : ${PASSWORD_MIN} caractères au moins, avec une majuscule, une minuscule et un chiffre.`;
  if (code === 'email_address_invalid' || m.includes('invalid format') || (m.includes('email address') && m.includes('invalid')))
    return 'Cet e-mail n’est pas valide : vérifie-le (ex. : toi@exemple.com).';
  if (code === 'signup_disabled' || m.includes('signups not allowed'))
    return 'La création de compte est fermée pour le moment : réessaie plus tard ou écris au studio.';
  if (code.startsWith('over_') || m.includes('rate limit') || m.includes('too many') || (err as any)?.status === 429)
    return 'Trop d’essais en peu de temps : patiente quelques minutes, puis réessaie.';
  const service = authServiceMessage(err);
  if (service) return service;
  return friendlyAuthError(err);
}

/**
 * Crée le compte Make Music. Lève une Error au message clair si c'est refusé.
 * Confirmation d'e-mail activée (le cas en ligne) : { status: 'confirm_email' }.
 * Sans confirmation (serveur réglé autrement) : la session est ouverte, { status: 'signed_in' }.
 */
export async function signUpMakeMusic(input: SignupInput, opts: { desktop?: boolean; auth?: AuthLike } = {}): Promise<SignupResult> {
  const problem = signupProblem(input);
  if (problem) throw new Error(problem);
  const email = input.email.trim();
  const auth = opts.auth || defaultAuth();
  let data: any, error: any;
  try {
    ({ data, error } = await auth.signUp({
      email, password: input.password,
      options: { emailRedirectTo: confirmRedirectUrl(!!opts.desktop), data: { full_name: input.name.trim() } },
    }));
  } catch (e) {
    throw new Error(signupErrorMessage(e));
  }
  if (error) throw new Error(signupErrorMessage(error));
  // Protection contre l'énumération des e-mails (confirmation activée) : un e-mail déjà inscrit
  // reçoit une réponse « réussie » SANS identité. On le dit, au lieu d'attendre un mail qui ne viendra pas.
  const u = data?.user;
  if (u && Array.isArray(u.identities) && u.identities.length === 0) throw new Error(signupErrorMessage({ code: 'user_already_exists' }));
  if (data?.session && u?.id) return { status: 'signed_in', email: u.email || email, userId: u.id };
  return { status: 'confirm_email', email };
}

/** « Renvoyer l'e-mail de confirmation ». */
export async function resendConfirmation(email: string, opts: { desktop?: boolean; auth?: AuthLike } = {}): Promise<void> {
  const auth = opts.auth || defaultAuth();
  if (!emailOk(email)) throw new Error('Cet e-mail n’est pas valide : vérifie-le (ex. : toi@exemple.com).');
  if (!auth.resend) throw new Error('Renvoi impossible pour le moment : réessaie plus tard.');
  let error: any;
  try {
    ({ error } = await auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: confirmRedirectUrl(!!opts.desktop) } }));
  } catch (e) { throw new Error(signupErrorMessage(e)); }
  if (error) throw new Error(signupErrorMessage(error));
}

/** Lien « nouveau mot de passe » du compte Make Music (ouvre la page /auth du site, comme sur le site). */
export async function sendMakeMusicPasswordReset(email: string, opts: { auth?: AuthLike } = {}): Promise<void> {
  const auth = opts.auth || defaultAuth();
  if (!emailOk(email)) throw new Error('Cet e-mail n’est pas valide : vérifie-le (ex. : toi@exemple.com).');
  if (!auth.resetPasswordForEmail) throw new Error('Envoi impossible pour le moment : réessaie plus tard.');
  let error: any;
  try {
    ({ error } = await auth.resetPasswordForEmail(email.trim(), { redirectTo: `${SITE_URL}/auth` }));
  } catch (e) { throw new Error(signupErrorMessage(e)); }
  if (error) throw new Error(signupErrorMessage(error));
}
