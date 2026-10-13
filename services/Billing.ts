import { catalogSupabase } from './supabase';
import { isNovaDesktop } from '../utils/desktopApp';
import { leavePage } from '../utils/saveBeforeLeave';

/**
 * Paiements Nova (Stripe Checkout, fonction serveur nova-billing).
 *
 * Grille du 14/10/2026 — les PRIX NE SONT JAMAIS ÉCRITS ICI : ils viennent du serveur
 * (action « pricing », source unique supabase/functions/_shared/novaTarifs.ts) :
 *  - gratuit : tout le studio, pas d'export (extrait de 30 s à partager) ;
 *  - export à l'unité par projet ; Nova Pro mensuel ou annuel ;
 *  - instru / mélodie achetée : export offert + Nova Pro offert (1 mois / 7 jours).
 * Le serveur est la seule autorité qui débloque un export (action « export_access »).
 *
 * Serveur pas encore à jour (ancienne grille : « Action inconnue ») : repli sur l'ancienne
 * grille, avec les anciens noms de produits — jamais d'erreur « Produit inconnu ».
 *
 * Le paiement s'ouvre dans un nouvel onglet : le studio reste ouvert (rien n'est perdu) et
 * vérifie le paiement tout seul.
 */

export type BillingProduct = 'collab' | 'beatmaker' | 'export_voices' | 'export_project' | 'pro_month' | 'pro_year';

async function billing<T = any>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await catalogSupabase.functions.invoke('nova-billing', { body: { action, ...body } });
  if (error) {
    let msg = error.message;
    let payload: any = null;
    try { payload = await (error as any).context?.json?.(); msg = payload?.error || msg; } catch { /* */ }
    const err = new Error(msg) as Error & { payload?: any };
    if (payload) err.payload = payload;
    throw err;
  }
  return data as T;
}

/** URL de retour : la page actuelle du studio (le nouvel onglet affiche « paiement validé »). */
const returnUrl = () => {
  const u = new URL(window.location.href);
  u.search = '';
  u.hash = '';
  return u.toString();
};

/**
 * Ouvre Stripe Checkout dans un nouvel onglet (à appeler pendant le clic, pour
 * ne pas être bloqué) et renvoie l'identifiant de la session de paiement.
 */
export async function openCheckout(product: BillingProduct, extra: Record<string, unknown> = {}): Promise<string> {
  // Application Windows : toute nouvelle fenêtre part dans le navigateur de l'ordinateur
  // (nova_desktop.py, NewWindowRequested). On ouvre donc directement la page Stripe,
  // sans onglet vide préalable ; l'appli reste ouverte et attend le paiement.
  if (isNovaDesktop()) {
    const r = await billing<{ url: string; session_id: string }>('checkout', { product, return_url: returnUrl(), ...extra });
    window.open(r.url, '_blank');
    return r.session_id;
  }
  const tab = window.open('', '_blank');
  try {
    const r = await billing<{ url: string; session_id: string }>('checkout', { product, return_url: returnUrl(), ...extra });
    if (tab) tab.location.href = r.url;
    else {
      // Nouvel onglet bloqué : l'onglet du studio part vers Stripe, APRÈS sauvegarde du projet
      // (sinon il reste ouvert et le message dit quoi faire).
      const left = await leavePage(r.url);
      if (left.error) throw new Error(left.error);
    }
    return r.session_id;
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/** Attend que le paiement soit validé (vérification toutes les 3 s, 20 min max). */
export async function waitPaid(sessionId: string, isCancelled: () => boolean = () => false): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < 20 * 60_000) {
    if (isCancelled()) return false;
    try {
      const r = await billing<{ paid: boolean }>('verify', { session_id: sessionId });
      if (r.paid) return true;
    } catch { /* réseau : on réessaie */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

export const verifyPayment = (sessionId: string) => billing<{ paid: boolean; kind?: string; project_key?: string }>('verify', { session_id: sessionId });

// --- Grille (lue sur le serveur) ----------------------------------------------------

export interface Grille {
  version: string;
  /** Le serveur n'a pas encore la grille du 14/10 : anciens prix et anciens produits. */
  legacy: boolean;
  /** Prix indisponibles (hors ligne) : rien n'est affiché en dur, on le dit. */
  unavailable?: boolean;
  export: { cents: number };
  pro: { mois_cents: number; an_cents: number | null; economie_an_cents: number; economie_an_pourcent: number; stockage_go: number | null; melodies_offertes_par_mois: number };
  cadeaux: { instru_jours: number; melodie_jours: number; melodie_exclusive_jours: number; studio_jours: number };
  gratuit: { projets_en_ligne: number | null; projet_jours: number | null; extrait_secondes: number; export: boolean };
}

/**
 * Ancienne grille (serveur pas encore mis à jour) : c'est ce que l'ancienne fonction
 * nova-billing facture vraiment (export des pistes 2 €, Pro 5 €/mois avec 10 exports).
 * Ce n'est PAS une copie de la nouvelle grille : la nouvelle ne vient que du serveur.
 */
export const ANCIENNE_GRILLE: Grille = {
  version: 'ancienne',
  legacy: true,
  export: { cents: 200 },
  pro: { mois_cents: 500, an_cents: null, economie_an_cents: 0, economie_an_pourcent: 0, stockage_go: null, melodies_offertes_par_mois: 0 },
  cadeaux: { instru_jours: 0, melodie_jours: 0, melodie_exclusive_jours: 0, studio_jours: 0 },
  gratuit: { projets_en_ligne: null, projet_jours: null, extrait_secondes: 30, export: false },
};

let grilleCache: Promise<Grille> | null = null;
const estActionInconnue = (e: unknown) => /action inconnue/i.test(String((e as Error)?.message || ''));

/** Grille de prix du serveur (en cache pour la session ; un échec réseau est retenté). */
export function loadPricing(force = false): Promise<Grille> {
  if (grilleCache && !force) return grilleCache;
  const p = billing<any>('pricing').then((g): Grille => ({
    version: String(g.version),
    legacy: false,
    export: { cents: Number(g.export?.cents) },
    pro: {
      mois_cents: Number(g.pro?.mois_cents), an_cents: g.pro?.an_cents ?? null,
      economie_an_cents: Number(g.pro?.economie_an_cents) || 0, economie_an_pourcent: Number(g.pro?.economie_an_pourcent) || 0,
      stockage_go: g.pro?.stockage_go ?? null, melodies_offertes_par_mois: Number(g.pro?.melodies_offertes_par_mois) || 0,
    },
    cadeaux: {
      instru_jours: Number(g.cadeaux?.instru_jours) || 0, melodie_jours: Number(g.cadeaux?.melodie_jours) || 0,
      melodie_exclusive_jours: Number(g.cadeaux?.melodie_exclusive_jours) || 0, studio_jours: Number(g.cadeaux?.studio_jours) || 0,
    },
    gratuit: {
      projets_en_ligne: g.gratuit?.projets_en_ligne ?? null, projet_jours: g.gratuit?.projet_jours ?? null,
      extrait_secondes: Number(g.gratuit?.extrait_secondes) || 30, export: !!g.gratuit?.export,
    },
  })).catch((e): Grille => {
    if (estActionInconnue(e)) return ANCIENNE_GRILLE;
    grilleCache = null; // hors ligne : on redemandera
    return { ...ANCIENNE_GRILLE, unavailable: true, legacy: false };
  });
  grilleCache = p;
  return p;
}
/** Tests uniquement. */
export const resetPricingCache = () => { grilleCache = null; };

/** Produits à vendre selon la grille du serveur (anciens noms si le serveur n'est pas à jour). */
export const productFor = (g: Grille, what: 'export' | 'pro_month' | 'pro_year'): BillingProduct | null => {
  if (what === 'export') return g.legacy ? 'export_voices' : 'export_project';
  if (what === 'pro_month') return g.legacy ? 'collab' : 'pro_month';
  return g.legacy || !g.pro.an_cents ? null : 'pro_year';
};

/** 199 → « 1,99 € » ; 8900 → « 89 € ». */
export const euros = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const v = cents / 100;
  return `${Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ',')} €`;
};

// --- Statut du compte ---------------------------------------------------------------

export interface ProStatus {
  active: boolean;
  source: 'abonnement' | 'cadeau' | 'admin' | null;
  paid: boolean;
  interval: 'month' | 'year' | null;
  until: string | null;
  cadeau: { active: boolean; until: string | null; days_left: number; total_days: number; sources: { source: string; days: number; label: string | null }[] };
}
export interface BillingStatus {
  plans: { plan: string; status: string; current_period_end: string | null; interval?: string | null }[];
  admin: boolean;
  free_exports_left?: number;
  free_exports_total?: number;
  grille?: string;
  pro?: ProStatus | null;
  features?: { exports_illimites: boolean; collab_hote: boolean; import_instrus: boolean };
  melodie_offerte?: { droit: boolean; restantes: number; par_mois: number };
}
export async function billingStatus(): Promise<BillingStatus> {
  try { return await billing('status'); } catch { return { plans: [], admin: false }; }
}

/** Nova Pro : utilise un des 10 exports gratuits du mois pour ce projet (ancien serveur ; le nouveau : illimité). */
export async function spendExportCredit(projectKey: string): Promise<{ unlocked: boolean; remaining: number; reason?: string }> {
  try { return await billing('use_export_credit', { project_key: projectKey }); } catch { return { unlocked: false, remaining: 0 }; }
}

/**
 * Le compte a-t-il ce droit ? « collab » = Nova Pro (payé, offert par un achat, une séance
 * au studio) ; « beatmaker » = import de ses instrus (Nova Pro, ou ancienne offre beatmaker).
 */
export const hasPlan = (st: Pick<BillingStatus, 'plans' | 'admin'> & Partial<Pick<BillingStatus, 'pro' | 'features'>>, plan: 'collab' | 'beatmaker') => {
  if (st.admin || st.plans.some(p => p.plan === plan)) return true;
  if (plan === 'collab') return !!st.pro?.active;
  return !!st.features?.import_instrus || !!st.pro?.active;
};

// --- Export : décision du serveur ---------------------------------------------------

export interface ExportAccess {
  unlocked: boolean;
  /** Pourquoi c'est débloqué : admin, Nova Pro, projet payé, licence achetée. */
  via: 'admin' | 'pro' | 'achat' | 'licence' | null;
  /** Pourquoi c'est bloqué : instru / mélodie du catalogue pas achetée, ou à payer. */
  reason: 'catalogue_non_achete' | 'paiement' | 'erreur' | null;
  missing: { id: string; title: string | null; kind: string }[];
  login_required: boolean;
  kits: boolean;
  pro: { active: boolean; source: string | null; days_left: number; until: string | null } | null;
  legacy: boolean;
  message?: string;
}

export interface ExportQuery {
  projectKey: string;
  /** Identifiants des instrus / mélodies du catalogue présentes dans le projet. */
  catalogIds: string[];
  /** Le projet joue des sons des kits de batterie NOVA (jamais d'export gratuit). */
  kits: boolean;
  /** « voix » : mes pistes seules, sans l'instru. */
  scope: 'mix' | 'voix';
  /** Ancien serveur seulement : instrus achetées connues du DAW (le nouveau serveur relit lui-même). */
  owned?: string[];
}

const unlockedCache = new Map<string, ExportAccess>();
const cacheKey = (q: ExportQuery) => `${q.projectKey}|${q.scope}|${q.kits ? 1 : 0}|${[...q.catalogIds].sort().join(',')}|${[...(q.owned || [])].sort().join(',')}`;

/** Le serveur dit si ce projet peut sortir en fichier audio. Débloqué : gardé en mémoire (jamais dans le navigateur). */
export async function exportAccess(q: ExportQuery): Promise<ExportAccess> {
  const k = cacheKey(q);
  const hit = unlockedCache.get(k);
  if (hit) return hit;
  let r: ExportAccess;
  try {
    const d = await billing<any>('export_access', { project_key: q.projectKey, catalog_ids: q.catalogIds, kits: q.kits, scope: q.scope });
    r = {
      unlocked: !!d.unlocked, via: d.via || null, reason: d.reason || null, missing: Array.isArray(d.missing) ? d.missing : [],
      login_required: !!d.login_required, kits: !!d.kits, pro: d.pro || null, legacy: false,
    };
  } catch (e) {
    if (!estActionInconnue(e)) {
      return { unlocked: false, via: null, reason: 'erreur', missing: [], login_required: false, kits: q.kits, pro: null, legacy: false,
        message: 'Vérification impossible (connexion ?). Réessaie dans un instant.' };
    }
    r = await legacyAccess(q);
  }
  if (r.unlocked) unlockedCache.set(k, r);
  return r;
}

/** Après un paiement vérifié par le serveur : on redemande sans le cache. */
export const forgetExportAccess = (projectKey: string) => {
  for (const k of [...unlockedCache.keys()]) if (k.startsWith(`${projectKey}|`)) unlockedCache.delete(k);
};

/**
 * Ancien serveur (grille d'avant le 14/10) : il ne sait pas décider à partir du projet.
 * On rejoue l'ancienne règle : licence achetée → export du mix ; sinon projet payé (2 €)
 * ou un des 10 exports Nova Pro. Aucune nouvelle règle n'est inventée ici.
 */
async function legacyAccess(q: ExportQuery): Promise<ExportAccess> {
  const owned = new Set((q.owned || []).map(String));
  const missing = q.catalogIds.filter(id => !owned.has(id)).map(id => ({ id, title: null, kind: 'beat' }));
  const base = { missing, login_required: false, kits: q.kits, pro: null, legacy: true } as const;
  const st = await billingStatus();
  if (st.admin) return { ...base, unlocked: true, via: 'admin', reason: null, missing: [] };
  if (q.scope === 'mix' && missing.length) return { ...base, unlocked: false, via: null, reason: 'catalogue_non_achete' };
  if (q.scope === 'mix' && q.catalogIds.length && !q.kits) return { ...base, unlocked: true, via: 'licence', reason: null };
  if (await isExportVoicesUnlocked(q.projectKey)) return { ...base, unlocked: true, via: 'achat', reason: null };
  return { ...base, unlocked: false, via: null, reason: 'paiement', pro: hasPlan(st, 'collab') ? { active: true, source: 'abonnement', days_left: 0, until: null } : null };
}

/**
 * Payer l'export de ce projet (ou, ancien serveur + Nova Pro : utiliser un export du mois).
 * Renvoie la session Stripe à attendre, ou « credit » si débloqué sans paiement.
 */
export async function startExportPayment(q: ExportQuery, g: Grille): Promise<{ sessionId?: string; credit?: boolean }> {
  if (g.legacy) {
    const c = await spendExportCredit(q.projectKey);
    if (c.unlocked) { markExportVoicesUnlocked(q.projectKey); forgetExportAccess(q.projectKey); return { credit: true }; }
  }
  const product = productFor(g, 'export')!;
  const sessionId = await openCheckout(product, { project_key: q.projectKey, catalog_ids: q.catalogIds, scope: q.scope });
  return { sessionId };
}

// --- Ancienne vérification « mes pistes seules » (gardée pour l'ancien serveur) -------

// Le déblocage est toujours confirmé par le serveur : une valeur dans le
// navigateur (localStorage) suffisait avant à exporter sans payer. Cache en
// mémoire seulement, le temps de la session.
const unlockedLegacy = new Set<string>();

export async function isExportVoicesUnlocked(projectKey: string): Promise<boolean> {
  if (unlockedLegacy.has(projectKey)) return true;
  try {
    const r = await billing<{ unlocked: boolean }>('export_unlocked', { project_key: projectKey });
    if (r.unlocked) unlockedLegacy.add(projectKey);
    return r.unlocked;
  } catch { return false; }
}

/** Après un paiement ou un crédit Nova Pro vérifié par le serveur. */
export const markExportVoicesUnlocked = (projectKey: string) => { unlockedLegacy.add(projectKey); };

export async function openBillingPortal(): Promise<void> {
  if (isNovaDesktop()) {
    const r = await billing<{ url: string }>('portal', { return_url: returnUrl() });
    window.open(r.url, '_blank');
    return;
  }
  const tab = window.open('', '_blank');
  const r = await billing<{ url: string }>('portal', { return_url: returnUrl() });
  if (tab) { tab.location.href = r.url; return; }
  const left = await leavePage(r.url);
  if (left.error) throw new Error(left.error);
}
