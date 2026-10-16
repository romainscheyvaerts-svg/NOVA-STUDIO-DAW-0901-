import type { BillingStatus } from '../services/Billing';

/**
 * « Gérer mon abonnement » (portail client Stripe, action « portal » de nova-billing).
 *
 * Seulement pour un abonné Stripe : Nova Pro payé (mensuel / annuel) ou ancien abonnement
 * encore en cours (actif, à l'essai ou paiement en retard : c'est justement là qu'il faut
 * pouvoir changer de carte ou résilier). Pas pour un Nova Pro offert (cadeau) ni un admin :
 * ils n'ont rien à gérer chez Stripe.
 */
const STRIPE_LIVE = ['active', 'trialing', 'past_due'];

export function canManageSubscription(st: Pick<BillingStatus, 'plans' | 'pro'> | null | undefined): boolean {
  if (!st) return false;
  if (st.pro?.paid && st.pro.source === 'abonnement') return true;
  return (st.plans || []).some(p => STRIPE_LIVE.includes(p.status));
}

/** « Nova Pro mensuel » / « Nova Pro annuel » / « Nova Pro » (texte de la ligne du compte). */
export function subscriptionLabel(st: Pick<BillingStatus, 'plans' | 'pro'> | null | undefined): string {
  const interval = st?.pro?.paid ? st.pro.interval : (st?.plans || []).find(p => STRIPE_LIVE.includes(p.status))?.interval;
  return interval === 'year' ? 'Nova Pro annuel' : interval === 'month' ? 'Nova Pro mensuel' : 'Nova Pro';
}

/** Message clair (et actionnable) quand le portail ne s'ouvre pas. */
export function portalErrorMessage(e: unknown): string {
  const msg = String((e as any)?.message || e || '');
  if (/configuration|portal settings|customer portal/i.test(msg)) {
    return "La gestion de l'abonnement n'est pas encore ouverte chez notre prestataire de paiement. Ton abonnement continue normalement ; pour le modifier ou le résilier tout de suite, contacte le studio Make Music (studiomakemusic.com).";
  }
  if (/connecte-toi|401|jwt|not authenticated/i.test(msg)) return 'Connecte-toi à ton compte Make Music pour gérer ton abonnement.';
  if (/action inconnue/i.test(msg)) return "La gestion de l'abonnement n'est pas encore disponible sur le serveur. Réessaie un peu plus tard.";
  if (/adresse de retour/i.test(msg)) return "La gestion de l'abonnement ne s'ouvre pas depuis cette adresse. Ouvre NOVA depuis studiomakemusic.com, puis réessaie.";
  if (/failed to fetch|networkerror|network|load failed|fetch/i.test(msg)) return 'Pas de connexion au serveur de paiement. Vérifie ta connexion internet, puis réessaie.';
  return `La gestion de l'abonnement ne s'est pas ouverte${msg ? ` (${msg})` : ''}. Réessaie dans un instant.`;
}

// Statut du compte gardé quelques minutes : le menu du compte ne redemande pas le serveur
// à chaque ouverture (l'action « status » interroge Stripe).
const TTL_MS = 5 * 60_000;
let cache: { key: string; at: number; st: Promise<BillingStatus> } | null = null;

export function cachedBillingStatus(userKey: string, load: () => Promise<BillingStatus>, now = Date.now()): Promise<BillingStatus> {
  if (cache && cache.key === userKey && now - cache.at < TTL_MS) return cache.st;
  const st = load();
  cache = { key: userKey, at: now, st };
  return st;
}

/** Dernier statut connu (synchrone, pour la palette Ctrl+K) ; null si pas encore lu. */
let lastKnown: { key: string; st: BillingStatus } | null = null;
export const rememberBillingStatus = (userKey: string, st: BillingStatus) => { lastKnown = { key: userKey, st }; };
export const knownSubscriber = () => !!lastKnown && canManageSubscription(lastKnown.st);
export const resetBillingStatusCache = () => { cache = null; lastKnown = null; };
