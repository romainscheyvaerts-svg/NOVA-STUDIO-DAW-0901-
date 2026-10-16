/**
 * Lot 3 (1.5.1) · Invité gratuit : que dire quand le serveur refuse d'ouvrir une collaboration ?
 *
 * Règle : seul l'HÔTE a besoin de Nova Pro (payé, ou offert par un achat d'instru / une séance
 * au studio). Les invités rejoignent gratuitement, avec un compte gratuit, par le lien ou le code.
 * Un invité ne voit donc JAMAIS « abonne-toi pour rejoindre » : seulement ce qu'il peut faire.
 *
 * Marche avec les deux serveurs :
 *  - 1.4.9 / 1.5.1 : refus 402 avec `reason` (« host_pro », « host_not_pro »), 429 « session_full »,
 *    « code_attempts » ;
 *  - ancien serveur (avant la 1.4.9) : 402 « Abonnement collaboration requis (5 €/mois) » pour
 *    CHAQUE participant. Côté invité, on n'affiche pas l'ancien prix : on explique que la mise à
 *    jour arrive.
 *
 * Module pur : tests/collabAccess.test.ts.
 */

export interface RefusalInput { message?: string | null; status?: number | null; reason?: string | null }

/** gate : fenêtre à ouvrir dans le panneau (connexion, Nova Pro pour l'hôte) ; message : texte à montrer. */
export interface CollabRefusal { gate: 'login' | 'subscribe' | null; message: string | null }

export const MSG_HOST_NOT_PRO = 'L’hôte de cette séance n’a plus Nova Pro : demande-lui de le réactiver, puis rejoins à nouveau. En invité, tu n’as rien à payer.';
export const MSG_OLD_SERVER_GUEST = 'Le serveur de collaboration n’accepte pas encore les invités gratuits (mise à jour en attente). Réessaie un peu plus tard : en invité, tu n’auras rien à payer.';
export const MSG_SESSION_FULL = 'Cette séance est complète : demande à l’hôte de libérer une place, puis réessaie.';
export const MSG_CODE_ATTEMPTS = 'Trop de codes faux d’affilée : attends une heure, ou demande plutôt le lien d’invitation.';

/**
 * host : je démarre (j'héberge) la séance ; sinon je rejoins celle de quelqu'un.
 * null : refus non reconnu (l'appelant affiche son message habituel).
 */
export function collabRefusal(err: RefusalInput | null | undefined, host: boolean): CollabRefusal | null {
  const msg = String(err?.message || '');
  const status = typeof err?.status === 'number' ? err.status : undefined;
  const reason = String(err?.reason || '');
  if (status === 401 || /Connecte-toi/i.test(msg)) return { gate: 'login', message: null };
  if (reason === 'session_full' || /séance est complète/i.test(msg)) return { gate: null, message: MSG_SESSION_FULL };
  if (reason === 'code_attempts') return { gate: null, message: MSG_CODE_ATTEMPTS };
  if (reason === 'host_not_pro') return { gate: null, message: MSG_HOST_NOT_PRO };
  const payWall = status === 402 || /Abonnement|Nova Pro/i.test(msg);
  if (reason === 'host_pro' || (payWall && host)) return { gate: 'subscribe', message: null };
  if (payWall) return { gate: null, message: /Abonnement collaboration requis/i.test(msg) ? MSG_OLD_SERVER_GUEST : MSG_HOST_NOT_PRO };
  return null;
}

/**
 * « Ingé à distance » : faut-il Nova Pro pour démarrer ? Seulement pour CRÉER un lien (l'artiste
 * qui héberge). L'ingé invité, ou un artiste qui ouvre un lien reçu, n'a rien à payer : le serveur
 * vérifie l'hôte.
 */
export const remoteNeedsPro = (role: 'artist' | 'engineer' | undefined, hosting: boolean): boolean => role === 'artist' && hosting;
