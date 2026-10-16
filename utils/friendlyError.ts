/**
 * Messages d'erreur montrés à l'artiste : en français simple, et qui disent quoi faire.
 *
 * Beaucoup d'écrans affichaient `e.message` tel quel : la phrase technique, souvent en anglais,
 * du navigateur ou du serveur (« Failed to fetch », « Invalid login credentials »,
 * « JWT expired », « QuotaExceededError »…). `messageClair(e, repli)` reconnaît les cas
 * courants et les traduit ; un message déjà écrit pour l'artiste (en français) passe tel quel ;
 * une phrase technique inconnue est remplacée par le repli, écrit par l'écran qui l'affiche.
 *
 * S'appuie sur utils/authStatus (service restreint ou injoignable, réseau coupé).
 */
import { NO_INTERNET_MESSAGE, isAuthServiceDown, isFetchFailure } from './authStatus';

export const MSG = {
  reseau: 'Pas de connexion au serveur : vérifie ta connexion internet, puis réessaie.',
  identifiants: 'E-mail ou mot de passe incorrect. Vérifie-les, ou crée ton compte gratuit.',
  emailNonConfirme: 'Confirme d’abord ton e-mail : ouvre le mail de confirmation, puis reconnecte-toi.',
  dejaInscrit: 'Ce mail a déjà un compte : connecte-toi avec ton mot de passe.',
  motDePasseCourt: 'Mot de passe trop court : 6 caractères au moins.',
  tropDEssais: 'Trop d’essais d’un coup : attends une minute, puis réessaie.',
  sessionExpiree: 'Ta connexion a expiré : reconnecte-toi, puis réessaie.',
  stockagePlein: 'La mémoire de ce navigateur est pleine : supprime d’anciens projets ou télécharge-les en .zip, puis réessaie.',
  microBloque: 'Micro bloqué par le navigateur : clique sur le cadenas 🔒 à gauche de l’adresse du site, mets « Micro » sur « Autoriser », puis réessaie.',
  microAbsent: 'Aucun micro détecté : branche un micro (ou des écouteurs avec micro), puis réessaie.',
  microOccupe: 'Le micro est déjà utilisé par une autre application : ferme-la, puis réessaie.',
  annule: 'Opération annulée.',
  reponseBizarre: 'Le serveur a répondu de travers : réessaie dans un instant.',
  serviceIndispo: 'Le service NOVA est momentanément indisponible : réessaie dans quelques minutes. Ton projet reste sur cet appareil.',
} as const;

const texteDe = (e: unknown): string =>
  typeof e === 'string' ? e : String((e as any)?.message || (e as any)?.error_description || (e as any)?.msg || '');

const statutDe = (e: unknown): number | undefined => {
  const s = (e as any)?.status ?? (e as any)?.statusCode;
  return typeof s === 'number' ? s : (typeof s === 'string' && /^\d{3}$/.test(s) ? Number(s) : undefined);
};

/** Phrase visiblement technique ou en anglais (pas écrite pour l'artiste). */
export function estTechnique(m: string): boolean {
  const t = m.trim();
  if (!t) return true;
  if (/^[[{]/.test(t)) return true; // JSON brut
  if (/\b(undefined|null|NaN|TypeError|ReferenceError|SyntaxError|Exception|stack|at \w+ \()/.test(t)) return true;
  const fr = /[àâçéèêëîïôûùüœ’«»]|\b(le|la|les|des|du|une?|ton|ta|tes|pas|est|dans|pour|avec|sur|impossible|réessaie|vérifie)\b/i.test(t);
  const en = /\b(the|is|are|was|not|failed|error|invalid|cannot|can't|unable|unexpected|denied|forbidden|unauthori[sz]ed|timeout|timed out|request|response|network|fetch|found|missing|already|exists?|exceeded|expired|should|must|please|violates|policy|row|column|relation|duplicate|constraint|permission|function|method)\b/i.test(t);
  return en && !fr;
}

/**
 * Message lisible par l'artiste pour une erreur quelconque.
 * @param repli phrase de l'écran (« Sauvegarde impossible : réessaie. ») si l'erreur est technique et inconnue.
 */
export function messageClair(e: unknown, repli = 'Ça n’a pas marché : réessaie dans un instant.'): string {
  if (e == null) return repli;
  const nom = String((e as any)?.name || '');
  const m = texteDe(e);
  const st = statutDe(e);
  // Micro (getUserMedia) et stockage du navigateur.
  if (nom === 'NotAllowedError' || nom === 'SecurityError') return MSG.microBloque;
  if (nom === 'NotFoundError' && /device|micro|audio|requested/i.test(m)) return MSG.microAbsent;
  if (nom === 'NotReadableError') return MSG.microOccupe;
  if (nom === 'QuotaExceededError' || /quota ?exceeded|QuotaExceeded/i.test(m)) return MSG.stockagePlein;
  if (nom === 'AbortError') return MSG.annule;
  // Compte (Supabase Auth).
  if (/invalid login credentials|invalid_credentials|invalid_grant/i.test(m)) return MSG.identifiants;
  if (/email not confirmed|email_not_confirmed/i.test(m)) return MSG.emailNonConfirme;
  if (/user already registered|already been registered|user_already_exists/i.test(m)) return MSG.dejaInscrit;
  if (/password should be at least|weak_password/i.test(m)) return MSG.motDePasseCourt;
  if (st === 429 || /rate limit|too many requests|over_request_rate_limit/i.test(m)) return MSG.tropDEssais;
  if (/jwt expired|invalid jwt|session.*(expired|missing)|refresh token/i.test(m)) return MSG.sessionExpiree;
  // Service en panne / réseau coupé (messages déjà clairs dans utils/authStatus).
  const enLigne = typeof navigator === 'undefined' || navigator.onLine !== false;
  if (isFetchFailure(e)) return enLigne ? MSG.reseau : NO_INTERNET_MESSAGE;
  if (isAuthServiceDown(e)) return MSG.serviceIndispo;
  if (/unexpected token|is not valid json|json\.parse/i.test(m)) return MSG.reponseBizarre;
  // Message déjà écrit pour l'artiste : gardé ; sinon le repli de l'écran.
  return estTechnique(m) ? repli : m;
}
