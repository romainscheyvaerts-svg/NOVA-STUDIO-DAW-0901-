// Facturation Nova (Stripe) — grille du 14/10/2026, prix dans ../_shared/novaTarifs.ts :
//  - Gratuit : tout le studio, PAS d'export (seulement l'extrait de 30 s à partager) ;
//  - export à l'unité : 1,99 € par projet (exports illimités de ce projet ensuite) ;
//  - Nova Pro : 9,99 €/mois ou 89 €/an (exports illimités, projets en ligne, collaboration
//    en hôte, import de ses instrus, 1 mélodie offerte par mois) ;
//  - instru achetée sur la boutique : export du projet offert + 1 mois de Nova Pro ;
//    mélodie : 7 jours (Melody Exclusive : 1 mois) ; séance au studio : 30 jours.
//    Les cadeaux se cumulent ; ils sont DÉDUITS des achats (aucune écriture à l'achat).
//
// Le serveur est la SEULE autorité qui débloque un export (action « export_access ») :
// le DAW lui envoie le projet (identifiants du catalogue utilisés, kits ou non) et le serveur
// relit lui-même les achats du compte.
//
// Le paiement se fait sur Stripe Checkout (nouvel onglet) ; le studio vérifie ensuite la
// session Checkout ici (aucun webhook nécessaire) et enregistre l'achat / l'abonnement.
// Les prix sont créés à la volée (price_data) : rien à créer dans le tableau de bord Stripe.
// Les abonnés existants gardent le prix de leur abonnement (Stripe ne le change jamais).
//
// Compatibilité : les anciens noms de produits (« collab », « export_voices ») et les
// anciennes actions (« export_unlocked », « use_export_credit ») marchent toujours.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  TARIFS, PLAN_PRO, METHODE_MELODIE_OFFERTE, GRILLE_VERSION,
  grillePublique, decisionExport, statutPro, isAdmin as estAdmin, debutDuMois, droitMelodieOfferte,
  type ElementCatalogue,
} from "../_shared/novaTarifs.ts";

/** Produits vendus (et anciens noms toujours acceptés). */
const PRODUITS_ABO: Record<string, { plan: string; interval: "month" | "year"; cents: number; name: string }> = {
  pro_month: { plan: PLAN_PRO, interval: "month", cents: TARIFS.pro_mois_cents, name: "Nova Pro · mensuel" },
  pro_year: { plan: PLAN_PRO, interval: "year", cents: TARIFS.pro_an_cents, name: "Nova Pro · annuel" },
  // Anciens noms : Nova Pro mensuel au prix de la grille actuelle.
  collab: { plan: PLAN_PRO, interval: "month", cents: TARIFS.pro_mois_cents, name: "Nova Pro · mensuel" },
  // L'offre beatmaker est remplacée par Nova Pro pour les nouveaux clients.
  beatmaker: { plan: PLAN_PRO, interval: "month", cents: TARIFS.pro_mois_cents, name: "Nova Pro · mensuel (beatmaker)" },
};
const PRODUITS_EXPORT = ["export_project", "export_voices"];
const PROJECT_RE = /^[A-Za-z0-9_.:-]{6,80}$/;
const CATALOG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const ALLOWED_RETURN = [
  /^https:\/\/nova-studio-daw-0901-9kzo\.vercel\.app\//,
  /^https:\/\/nova-studio-daw-0901\.vercel\.app\//,
  /^https:\/\/(www\.)?studiomakemusic\.com\//,
  /^http:\/\/(localhost|127\.0\.0\.1):\d+\//,
];

const cors = (origin: string | null): Record<string, string> => ({
  "Access-Control-Allow-Origin": origin && ALLOWED_RETURN.some(r => r.test(origin + "/")) ? origin : "https://www.studiomakemusic.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", { apiVersion: "2025-08-27.basil" });

class HttpError extends Error { constructor(public status: number, msg: string, public extra?: Record<string, unknown>) { super(msg); } }

type User = { id: string; email?: string };

async function callerOf(req: Request): Promise<User | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token.split(".").length !== 3) return null;
  const { data } = await supabase.auth.getUser(token);
  return data?.user ? { id: data.user.id, email: data.user.email || undefined } : null;
}

const isAdmin = (userId: string) => estAdmin(supabase, userId);

async function customerFor(email: string): Promise<string> {
  const list = await stripe.customers.list({ email, limit: 1 });
  if (list.data[0]) return list.data[0].id;
  return (await stripe.customers.create({ email })).id;
}

const okReturn = (u: unknown): string => {
  const s = String(u || "");
  if (!ALLOWED_RETURN.some(r => r.test(s))) throw new HttpError(400, "Adresse de retour refusée");
  return s;
};

async function saveSubscription(sub: Stripe.Subscription, userId: string, plan: string) {
  const item = sub.items?.data?.[0] as any;
  const end = (sub as any).current_period_end ?? item?.current_period_end;
  const interval = item?.price?.recurring?.interval || item?.plan?.interval || (sub.metadata as any)?.nova_interval || null;
  await supabase.from("nova_subscriptions").upsert({
    stripe_subscription_id: sub.id, user_id: userId, plan, stripe_customer_id: String(sub.customer),
    status: sub.status, current_period_end: end ? new Date(end * 1000).toISOString() : null,
    interval: interval === "year" ? "year" : "month", updated_at: new Date().toISOString(),
  });
}

/** Abonnements (rafraîchis chez Stripe si l'info a plus d'une heure : renouvellement, résiliation). */
async function activePlans(userId: string): Promise<{ plan: string; status: string; current_period_end: string | null; interval: string | null }[]> {
  const { data } = await supabase.from("nova_subscriptions").select("*").eq("user_id", userId);
  const out: { plan: string; status: string; current_period_end: string | null; interval: string | null }[] = [];
  for (const row of data || []) {
    let r = row;
    if (Date.now() - Date.parse(row.updated_at) > 3600_000) {
      try { const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id); await saveSubscription(sub, userId, row.plan); r = { ...row, status: sub.status }; } catch { /* garde l'état connu */ }
    }
    if (["active", "trialing", "past_due"].includes(r.status)) out.push({ plan: r.plan, status: r.status, current_period_end: r.current_period_end, interval: r.interval || "month" });
  }
  return out;
}

/** Instrus / mélodies du catalogue achetées par le compte (licence, offerte ou payée). */
async function ownedCatalog(userId: string): Promise<Set<string>> {
  const { data } = await supabase.from("instrumental_purchases").select("instrumental_id").eq("user_id", userId);
  return new Set((data || []).map((r: any) => String(r.instrumental_id)));
}

async function projectPaid(projectKey: string, userId: string | null): Promise<boolean> {
  const { data } = await supabase.from("nova_purchases").select("checkout_session_id, user_id").eq("project_key", projectKey).limit(5);
  // Achat rattaché au compte, ou achat sans compte (paiement invité de l'ancienne version).
  if ((data || []).some((r: any) => !r.user_id || r.user_id === userId)) return true;
  // Ancien crédit Nova Pro (10 exports / mois) déjà utilisé sur ce projet.
  if (userId) {
    const { data: uses } = await supabase.from("nova_export_uses").select("id").eq("project_key", projectKey).eq("user_id", userId).limit(1);
    if (uses?.length) return true;
  }
  return false;
}

async function melodiesOffertesUtilisees(userId: string): Promise<number> {
  const { count } = await supabase.from("instrumental_purchases").select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("payment_method", METHODE_MELODIE_OFFERTE).gte("created_at", debutDuMois());
  return count || 0;
}

/** Retrouve chez Stripe un abonnement payé dont le retour n'a jamais été vérifié (pas de webhook). */
async function recoverSubscriptions(user: User) {
  if (!user.email) return;
  const { data: known } = await supabase.from("nova_subscriptions").select("stripe_subscription_id").eq("user_id", user.id).limit(1);
  if (known?.length) return;
  try {
    const customers = await stripe.customers.list({ email: user.email, limit: 3 });
    for (const c of customers.data) {
      const subs = await stripe.subscriptions.list({ customer: c.id, status: "all", limit: 10 });
      for (const sub of subs.data) {
        const md = (sub.metadata || {}) as Record<string, string>;
        if (md.nova_plan && md.user_id === user.id) await saveSubscription(sub, user.id, md.nova_plan);
      }
    }
  } catch { /* Stripe indisponible : état connu */ }
}

async function handle(body: any, user: User | null) {
  const action = body?.action;

  if (action === "pricing") {
    // Public : la grille affichée par le DAW et le site (aucun prix en dur chez eux).
    return grillePublique();
  }

  if (action === "checkout") {
    const product = String(body?.product || "");
    const returnUrl = okReturn(body?.return_url);
    const sep = returnUrl.includes("?") ? "&" : "?";
    const success_url = `${returnUrl}${sep}nova_paid={CHECKOUT_SESSION_ID}`;
    const abo = PRODUITS_ABO[product];
    if (abo) {
      if (!user?.email) throw new HttpError(401, "Connecte-toi à ton compte Make Music pour t'abonner");
      const md = { nova_plan: abo.plan, nova_interval: abo.interval, nova_grille: GRILLE_VERSION, user_id: user.id };
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: await customerFor(user.email),
        line_items: [{ quantity: 1, price_data: { currency: "eur", unit_amount: abo.cents, recurring: { interval: abo.interval }, product_data: { name: abo.name } } }],
        metadata: md,
        subscription_data: { metadata: md },
        success_url, cancel_url: returnUrl,
        allow_promotion_codes: true,
      });
      return { url: session.url, session_id: session.id };
    }
    if (PRODUITS_EXPORT.includes(product)) {
      const projectKey = String(body?.project_key || "").slice(0, 80);
      if (!PROJECT_RE.test(projectKey)) throw new HttpError(400, "Projet inconnu");
      // Interdit si le projet contient une instru / mélodie du catalogue non achetée (mix complet).
      const catalog = cleanCatalog(body?.catalog_ids);
      if (catalog.length && body?.scope !== "voix") {
        const owned = user ? await ownedCatalog(user.id) : new Set<string>();
        const missing = catalog.filter(id => !owned.has(id));
        if (missing.length) throw new HttpError(409, "Achète d'abord la licence de l'instru ou de la mélodie : l'export à l'unité ne la remplace pas", { reason: "catalogue_non_achete", missing });
      }
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        ...(user?.email ? { customer: await customerFor(user.email) } : {}),
        line_items: [{ quantity: 1, price_data: { currency: "eur", unit_amount: TARIFS.export_cents, product_data: { name: "Nova · Export d'un projet (exports illimités de ce projet)" } } }],
        metadata: { nova_purchase: "export_project", project_key: projectKey, user_id: user?.id || "", nova_grille: GRILLE_VERSION },
        success_url, cancel_url: returnUrl,
      });
      return { url: session.url, session_id: session.id };
    }
    throw new HttpError(400, "Produit inconnu");
  }

  if (action === "verify") {
    const id = String(body?.session_id || "");
    if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) throw new HttpError(400, "Paiement inconnu");
    const s = await stripe.checkout.sessions.retrieve(id);
    const md = (s.metadata || {}) as Record<string, string>;
    if (s.mode === "subscription") {
      if (s.status !== "complete" || !s.subscription) return { paid: false };
      const sub = await stripe.subscriptions.retrieve(String(s.subscription));
      if (md.user_id) await saveSubscription(sub, md.user_id, md.nova_plan);
      return { paid: ["active", "trialing"].includes(sub.status), kind: md.nova_plan, interval: md.nova_interval || "month" };
    }
    if (s.payment_status !== "paid") return { paid: false };
    if (md.nova_purchase === "export_project" || md.nova_purchase === "export_voices") {
      await supabase.from("nova_purchases").upsert({
        checkout_session_id: s.id, kind: md.nova_purchase, project_key: md.project_key, user_id: md.user_id || null,
        email: s.customer_details?.email || null, amount_cents: s.amount_total || TARIFS.export_cents,
      });
      return { paid: true, kind: md.nova_purchase, project_key: md.project_key };
    }
    return { paid: false };
  }

  if (action === "status") {
    if (!user) return { plans: [], admin: false, grille: GRILLE_VERSION, pro: null };
    await recoverSubscriptions(user);
    const plans = await activePlans(user.id);
    const st = await statutPro(supabase, user.id, user.email);
    const melodiesPrises = await melodiesOffertesUtilisees(user.id);
    const droitMelodie = droitMelodieOfferte(st);
    return {
      grille: GRILLE_VERSION,
      plans,
      admin: st.admin,
      pro: {
        active: st.active, source: st.source, paid: st.paid, interval: st.interval, until: st.until,
        cadeau: { active: st.cadeau.active, until: st.cadeau.until, days_left: st.cadeau.days_left, total_days: st.cadeau.total_days,
          sources: st.cadeau.en_cours.map(c => ({ source: c.source, days: c.days, label: c.label || null })) },
      },
      features: {
        exports_illimites: st.active,
        collab_hote: st.active,
        import_instrus: st.active || st.beatmaker,
      },
      melodie_offerte: {
        droit: droitMelodie,
        restantes: droitMelodie ? Math.max(0, TARIFS.melodies_offertes_par_mois - melodiesPrises) : 0,
        par_mois: TARIFS.melodies_offertes_par_mois,
      },
      // Ancien DAW : il lisait le nombre d'exports gratuits Nova Pro (désormais illimités).
      free_exports_left: st.active ? 999 : 0,
      free_exports_total: st.active ? 999 : 0,
    };
  }

  if (action === "export_access") {
    // LA décision d'export. Le DAW envoie : project_key, catalog_ids (instrus / mélodies du
    // catalogue présentes dans le projet), kits (sons des kits NOVA), scope (mix | voix).
    const projectKey = String(body?.project_key || "");
    if (!PROJECT_RE.test(projectKey)) throw new HttpError(400, "Projet inconnu");
    const ids = cleanCatalog(body?.catalog_ids);
    const portee = body?.scope === "voix" ? "voix" : "mix";
    const kits = body?.kits === true;
    const admin = !!user && await isAdmin(user.id);
    const st = user && !admin ? await statutPro(supabase, user.id, user.email) : null;
    const owned = user ? await ownedCatalog(user.id) : new Set<string>();
    let titles = new Map<string, { title?: string; kind?: string }>();
    if (ids.length) {
      const { data } = await supabase.from("instrumentals").select("id, title, kind").in("id", ids);
      titles = new Map((data || []).map((x: any) => [String(x.id), { title: x.title, kind: x.kind }]));
    }
    const catalogue: ElementCatalogue[] = ids.map(id => ({ id, owned: owned.has(id), ...(titles.get(id) || {}) }));
    const paye = await projectPaid(projectKey, user?.id || null);
    const d = decisionExport({ admin, pro: !!st?.active, projetPaye: paye, catalogue, kits, portee });
    return {
      grille: GRILLE_VERSION,
      unlocked: d.unlocked,
      via: d.via || null,
      reason: d.reason || null,
      login_required: !user && !d.unlocked,
      missing: d.missing.map(m => ({ id: m.id, title: m.title || null, kind: m.kind || "beat" })),
      kits,
      offers: d.unlocked ? null : {
        export_cents: d.reason === "paiement" ? TARIFS.export_cents : null,
        pro_mois_cents: d.reason === "paiement" ? TARIFS.pro_mois_cents : null,
        pro_an_cents: d.reason === "paiement" ? TARIFS.pro_an_cents : null,
      },
      pro: st ? { active: st.active, source: st.source, days_left: st.cadeau.days_left, until: st.until } : null,
    };
  }

  if (action === "melody_perk") {
    // Appelée par deliver-instrumental (site), avec le jeton du client : peut-il prendre sa
    // mélodie offerte du mois ? (Le décompte = les achats « nova_pro_monthly » du mois.)
    if (!user) throw new HttpError(401, "Connecte-toi à ton compte Make Music");
    const st = await statutPro(supabase, user.id, user.email);
    const droit = droitMelodieOfferte(st);
    const left = droit ? Math.max(0, TARIFS.melodies_offertes_par_mois - await melodiesOffertesUtilisees(user.id)) : 0;
    return { allowed: droit && left > 0, droit, restantes: left, method: METHODE_MELODIE_OFFERTE };
  }

  // --- Anciennes actions (DAW pas encore mis à jour) -----------------------------------
  if (action === "export_unlocked") {
    if (user && await isAdmin(user.id)) return { unlocked: true, admin: true };
    const projectKey = String(body?.project_key || "");
    if (!PROJECT_RE.test(projectKey)) return { unlocked: false };
    if (await projectPaid(projectKey, user?.id || null)) return { unlocked: true };
    if (user && (await statutPro(supabase, user.id, user.email)).active) return { unlocked: true };
    return { unlocked: false };
  }

  if (action === "use_export_credit") {
    // Nova Pro : exports illimités (l'ancien DAW demandait un crédit par projet).
    if (!user) return { unlocked: false, remaining: 0, reason: "login" };
    const projectKey = String(body?.project_key || "");
    if (!PROJECT_RE.test(projectKey)) throw new HttpError(400, "Projet inconnu");
    const st = await statutPro(supabase, user.id, user.email);
    if (!st.active) return { unlocked: false, remaining: 0, reason: "not_pro" };
    return { unlocked: true, remaining: 999, ...(st.admin ? { admin: true } : {}) };
  }

  if (action === "portal") {
    // Gérer / résilier son abonnement (portail client Stripe).
    if (!user?.email) throw new HttpError(401, "Connecte-toi d'abord");
    const returnUrl = okReturn(body?.return_url);
    const p = await stripe.billingPortal.sessions.create({ customer: await customerFor(user.email), return_url: returnUrl });
    return { url: p.url };
  }

  throw new HttpError(400, "Action inconnue");
}

function cleanCatalog(v: unknown): string[] {
  const list = Array.isArray(v) ? v : [];
  return [...new Set(list.map(x => String(x ?? "").trim()).filter(x => CATALOG_ID_RE.test(x)))].slice(0, 50);
}

serve(async (req) => {
  const headers = { ...cors(req.headers.get("origin")), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { headers });
  try {
    const body = await req.json();
    const user = await callerOf(req);
    return new Response(JSON.stringify(await handle(body, user)), { headers });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const extra = e instanceof HttpError ? e.extra : undefined;
    console.error("[nova-billing]", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message, ...(extra || {}) }), { status, headers });
  }
});
