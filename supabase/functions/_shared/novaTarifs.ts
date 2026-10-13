// TARIFS NOVA — la SEULE source des prix, des durées et des règles d'accès (grille du 14/10/2026).
//
// Lue par :
//  - nova-billing (paiements Stripe, cadeaux, déblocage des exports) ;
//  - daw-session (projet en ligne gratuit 7 jours, collaboration en hôte) ;
//  - daw-session-purge (ménage des projets expirés) ;
//  - le DAW et le site, via l'action publique « pricing » de nova-billing (jamais de prix en dur).
//
// Changer un prix = changer CE fichier, puis redéployer nova-billing, daw-session et
// daw-session-purge (voir supabase/functions/README.md). Les abonnés existants gardent le
// prix de leur abonnement Stripe : un abonnement en cours n'est jamais modifié.
//
// Les fonctions « pures » (sans base) sont testées dans supabase/tests/novaTarifs.test.ts.

export const GRILLE_VERSION = "2026-10-14";

export const TARIFS = {
  /** Export à l'unité : débloque TOUS les exports d'un projet (refaire le mix ne coûte rien). TTC. */
  export_cents: 199,
  /** Nova Pro, TTC. */
  pro_mois_cents: 999,
  pro_an_cents: 8900,
  /** Ancienne offre « beatmaker » (vendre ses prods sur la boutique) : abonnés existants seulement. */
  beatmaker_mois_cents: 1000,
  /** Nova Pro offert. Les cadeaux se cumulent (bout à bout). */
  cadeau_instru_jours: 30,
  cadeau_melodie_jours: 7,
  cadeau_melodie_exclusive_jours: 30,
  cadeau_studio_jours: 30,
  /** Gratuit : 1 projet en ligne, gardé 7 jours ; avertissement 2 jours avant. */
  projets_gratuits_en_ligne: 1,
  projet_gratuit_jours: 7,
  avertir_avant_jours: 2,
  /** Extrait à partager (démo), seule sortie audio du gratuit. */
  extrait_secondes: 30,
  /** Nova Pro : usage raisonnable des projets en ligne. */
  pro_stockage_go: 20,
  /** Nova Pro : mélodies du catalogue offertes chaque mois (licence « Melody »). */
  melodies_offertes_par_mois: 1,
  /** Fin de période dépassée : Stripe a 2 jours pour renouveler avant qu'on coupe. */
  marge_renouvellement_jours: 2,
} as const;

/** Identifiant historique de Nova Pro dans nova_subscriptions.plan (abonnements en cours : ne pas renommer). */
export const PLAN_PRO = "collab";
export const PLAN_BEATMAKER = "beatmaker";
/** Achats d'instrus SANS paiement (jamais de cadeau pour eux). */
export const ACHATS_GRATUITS = ["trusted_user_free", "nova_pro_monthly"];
/** Mode de paiement des mélodies offertes aux abonnés Nova Pro. */
export const METHODE_MELODIE_OFFERTE = "nova_pro_monthly";

export const JOUR_MS = 86400_000;
export const jours = (n: number) => n * JOUR_MS;

/** Économie de l'abonnement annuel par rapport à 12 mois. */
export function economieAnnuelle(t: typeof TARIFS = TARIFS) {
  const douzeMois = t.pro_mois_cents * 12;
  const cents = douzeMois - t.pro_an_cents;
  return { cents, pourcent: Math.round((cents / douzeMois) * 100), mois_offerts: Math.floor(cents / t.pro_mois_cents) };
}

/** Grille publique (action « pricing » de nova-billing) : tout ce que le DAW et le site affichent. */
export function grillePublique() {
  const eco = economieAnnuelle();
  return {
    version: GRILLE_VERSION,
    currency: "eur",
    taxes: "TTC",
    export: { cents: TARIFS.export_cents, par: "projet" },
    pro: {
      mois_cents: TARIFS.pro_mois_cents,
      an_cents: TARIFS.pro_an_cents,
      economie_an_cents: eco.cents,
      economie_an_pourcent: eco.pourcent,
      mois_offerts_an: eco.mois_offerts,
      stockage_go: TARIFS.pro_stockage_go,
      melodies_offertes_par_mois: TARIFS.melodies_offertes_par_mois,
    },
    cadeaux: {
      instru_jours: TARIFS.cadeau_instru_jours,
      melodie_jours: TARIFS.cadeau_melodie_jours,
      melodie_exclusive_jours: TARIFS.cadeau_melodie_exclusive_jours,
      studio_jours: TARIFS.cadeau_studio_jours,
    },
    gratuit: {
      projets_en_ligne: TARIFS.projets_gratuits_en_ligne,
      projet_jours: TARIFS.projet_gratuit_jours,
      extrait_secondes: TARIFS.extrait_secondes,
      export: false,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Cadeaux (Nova Pro offert)
// ---------------------------------------------------------------------------------------

export type SourceCadeau = "instru" | "melodie" | "melodie_exclusive" | "studio" | "manuel";
export interface Cadeau { ref: string; source: SourceCadeau; days: number; starts_at: string; label?: string }

/** Achat d'une licence du catalogue → cadeau (null : pas de cadeau, ex. téléchargement offert). */
export function cadeauPourAchat(p: {
  id: string; created_at: string; amount_paid?: number | null; payment_method?: string | null;
  kind?: string | null; price_tier?: string | null; license_name?: string | null; title?: string | null;
}): Cadeau | null {
  if (!(Number(p.amount_paid) > 0)) return null;
  if (ACHATS_GRATUITS.includes(String(p.payment_method || ""))) return null;
  const melodie = String(p.kind || "beat") === "melody";
  const exclusive = String(p.price_tier || "") === "exclusive" || /exclusive/i.test(String(p.license_name || ""));
  const base = { ref: `achat-${p.id}`, starts_at: p.created_at, label: p.title || undefined };
  if (!melodie) return { ...base, source: "instru", days: TARIFS.cadeau_instru_jours };
  if (exclusive) return { ...base, source: "melodie_exclusive", days: TARIFS.cadeau_melodie_exclusive_jours };
  return { ...base, source: "melodie", days: TARIFS.cadeau_melodie_jours };
}

/**
 * Frise des cadeaux : chacun commence à sa date, ou à la fin du précédent s'il court encore
 * (les mois se CUMULENT). Une date dans le futur est ramenée à maintenant.
 */
export function friseCadeaux(cadeaux: Cadeau[], now = Date.now()): {
  active: boolean; until: string | null; days_left: number; total_days: number; en_cours: Cadeau[];
} {
  const tri = [...cadeaux]
    .filter(c => c.days > 0 && Number.isFinite(Date.parse(c.starts_at)))
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.ref.localeCompare(b.ref));
  let fin = 0;
  let chaine: Cadeau[] = [];
  for (const c of tri) {
    const debutVoulu = Math.min(Date.parse(c.starts_at), now);
    if (debutVoulu > fin) chaine = []; // trou : nouvelle chaîne
    const debut = Math.max(fin, debutVoulu);
    fin = debut + jours(c.days);
    chaine.push(c);
  }
  const active = fin > now;
  return {
    active,
    until: active ? new Date(fin).toISOString() : null,
    days_left: active ? Math.ceil((fin - now) / JOUR_MS) : 0,
    total_days: active ? chaine.reduce((s, c) => s + c.days, 0) : 0,
    en_cours: active ? chaine : [],
  };
}

// ---------------------------------------------------------------------------------------
// Export : la décision (le serveur est la seule autorité)
// ---------------------------------------------------------------------------------------

export interface ElementCatalogue { id: string; owned: boolean; title?: string; kind?: string }
export type VoieExport = "admin" | "pro" | "achat" | "licence";
export type RaisonRefus = "catalogue_non_achete" | "paiement";

/**
 * - admin : tout ;
 * - une instru / mélodie du catalogue NON achetée dans le mix → refusé, même pour un abonné
 *   (« mes pistes seules », sans l'instru, reste possible) ;
 * - toutes les instrus / mélodies du projet achetées → export offert (« licence »), SAUF si
 *   le projet utilise les kits de batterie NOVA (jamais d'export gratuit avec les kits).
 *   Passe avant Nova Pro : après un achat, le compte est aussi Pro (cadeau), mais la raison
 *   affichée reste « licence achetée : export offert » ;
 * - Nova Pro (payé ou offert) → exports illimités ;
 * - projet déjà payé (1,99 €) → exports illimités de ce projet ;
 * - sinon → 1,99 € ou Nova Pro.
 */
export function decisionExport(i: {
  admin: boolean; pro: boolean; projetPaye: boolean; catalogue: ElementCatalogue[]; kits: boolean; portee: "mix" | "voix";
}): { unlocked: boolean; via?: VoieExport; reason?: RaisonRefus; missing: ElementCatalogue[] } {
  const missing = i.catalogue.filter(c => !c.owned);
  if (i.admin) return { unlocked: true, via: "admin", missing: [] };
  if (i.portee === "mix" && missing.length) return { unlocked: false, reason: "catalogue_non_achete", missing };
  if (i.catalogue.length > 0 && missing.length === 0 && !i.kits) return { unlocked: true, via: "licence", missing };
  if (i.pro) return { unlocked: true, via: "pro", missing };
  if (i.projetPaye) return { unlocked: true, via: "achat", missing };
  return { unlocked: false, reason: "paiement", missing };
}

// ---------------------------------------------------------------------------------------
// Lecture en base (client service role) — partagée par nova-billing, daw-session, purge
// ---------------------------------------------------------------------------------------

// Client Supabase minimal (compatible avec toutes les versions de supabase-js et le faux des tests).
// deno-lint-ignore no-explicit-any
type Sb = { from: (table: string) => any };

export async function isAdmin(sb: Sb, userId: string): Promise<boolean> {
  const { data } = await sb.from("user_roles").select("role").eq("user_id", userId);
  return (data || []).some((r: any) => ["admin", "superadmin", "super_admin"].includes(String(r.role)));
}

const STATUTS_ACTIFS = ["active", "trialing", "past_due"];

/** Abonnements Stripe actifs (la fin de période laisse 2 jours de marge au renouvellement). */
export async function abonnementsActifs(sb: Sb, userId: string, now = Date.now()) {
  const { data } = await sb.from("nova_subscriptions").select("*").eq("user_id", userId).in("status", STATUTS_ACTIFS);
  const marge = now - jours(TARIFS.marge_renouvellement_jours);
  return (data || []).filter((s: any) => {
    const fin = s.current_period_end ? Date.parse(s.current_period_end) : null;
    return fin === null || fin > marge;
  }) as { plan: string; status: string; current_period_end: string | null; interval?: string | null; stripe_subscription_id: string }[];
}

/** Tous les cadeaux du compte : achats de licences + séances au studio + cadeaux manuels. */
export async function cadeauxDe(sb: Sb, userId: string, email?: string | null): Promise<Cadeau[]> {
  const out: Cadeau[] = [];
  // 1) Licences achetées sur la boutique (instru → 30 j, mélodie → 7 j, mélodie exclusive → 30 j).
  const { data: achats } = await sb.from("instrumental_purchases")
    .select("id, instrumental_id, license_id, amount_paid, payment_method, created_at").eq("user_id", userId);
  const rows = (achats || []) as any[];
  if (rows.length) {
    const ids = [...new Set(rows.map(r => String(r.instrumental_id)))];
    const lic = [...new Set(rows.map(r => String(r.license_id)).filter(Boolean))];
    const { data: insts } = await sb.from("instrumentals").select("id, kind, title").in("id", ids);
    const { data: lics } = lic.length ? await sb.from("instrumental_licenses").select("id, name, price_tier").in("id", lic) : { data: [] };
    const inst = new Map((insts || []).map((x: any) => [String(x.id), x]));
    const li = new Map((lics || []).map((x: any) => [String(x.id), x]));
    for (const r of rows) {
      const it: any = inst.get(String(r.instrumental_id)) || {};
      const l: any = li.get(String(r.license_id)) || {};
      const c = cadeauPourAchat({ ...r, kind: it.kind, title: it.title, price_tier: l.price_tier, license_name: l.name });
      if (c) out.push(c);
    }
  }
  // 2) Cadeaux enregistrés (séance au studio, geste du studio).
  const { data: dons } = await sb.from("nova_pro_gifts").select("id, source, days, starts_at, note").eq("user_id", userId);
  for (const d of (dons || []) as any[]) out.push({ ref: String(d.id), source: d.source, days: Number(d.days) || 0, starts_at: d.starts_at, label: d.note || undefined });
  // 3) Séances payées au studio (réservation au même e-mail) : 30 jours, une fois par jour de séance.
  if (email) {
    const { data: resas } = await sb.from("bookings").select("id, status, amount_paid, session_date, created_at, client_email")
      .in("client_email", [...new Set([email, email.toLowerCase()])]);
    const jourDeja = new Set(out.filter(c => c.source === "studio").map(c => c.starts_at.slice(0, 10)));
    for (const b of (resas || []) as any[]) {
      if (!["confirmed", "completed"].includes(String(b.status)) || !(Number(b.amount_paid) > 0)) continue;
      const jour = String(b.session_date || b.created_at || "").slice(0, 10);
      if (!jour || jourDeja.has(jour)) continue;
      jourDeja.add(jour);
      out.push({ ref: `seance-${b.id}`, source: "studio", days: TARIFS.cadeau_studio_jours, starts_at: String(b.created_at || b.session_date) });
    }
  }
  return out;
}

export interface StatutPro {
  active: boolean;
  /** abonnement : payé chez Stripe ; cadeau : jours offerts ; admin : le studio. */
  source: "abonnement" | "cadeau" | "admin" | null;
  paid: boolean;
  admin: boolean;
  interval: "month" | "year" | null;
  until: string | null;
  cadeau: { active: boolean; until: string | null; days_left: number; total_days: number; en_cours: Cadeau[] };
  /** Ancienne offre beatmaker (vendre ses prods) : donne aussi l'import de ses instrus. */
  beatmaker: boolean;
}

export async function statutPro(sb: Sb, userId: string, email?: string | null, now = Date.now()): Promise<StatutPro> {
  const [admin, subs, cadeaux] = await Promise.all([isAdmin(sb, userId), abonnementsActifs(sb, userId, now), cadeauxDe(sb, userId, email)]);
  const pro = subs.find(s => s.plan === PLAN_PRO);
  const frise = friseCadeaux(cadeaux, now);
  const paid = !!pro;
  return {
    active: admin || paid || frise.active,
    source: admin ? "admin" : paid ? "abonnement" : frise.active ? "cadeau" : null,
    paid,
    admin,
    interval: pro ? (pro.interval === "year" ? "year" : "month") : null,
    until: pro?.current_period_end || frise.until,
    cadeau: frise,
    beatmaker: subs.some(s => s.plan === PLAN_BEATMAKER),
  };
}

export async function isProOrAdmin(sb: Sb, userId: string | null | undefined, email?: string | null): Promise<boolean> {
  if (!userId) return false;
  return (await statutPro(sb, userId, email)).active;
}

/** Début du mois civil (UTC) : la mélodie offerte se renouvelle le 1er. */
export function debutDuMois(now = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/** Mélodie du mois : abonné payant, admin, ou Pro offert par autre chose qu'une mélodie à 3/5 €. */
export function droitMelodieOfferte(s: StatutPro): boolean {
  if (s.admin || s.paid) return true;
  return s.cadeau.active && s.cadeau.en_cours.some(c => c.source !== "melodie");
}
