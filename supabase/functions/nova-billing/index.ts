// Facturation Nova (Stripe) :
//  - abonnement « collaboration » 5 €/mois (chaque compte qui collabore),
//  - abonnement « beatmaker » 10 €/mois (mettre ses instrus dans la bibliothèque),
//  - export des voix seules d'un projet : 2 € (paiement unique, par projet).
// Le paiement se fait sur Stripe Checkout (nouvel onglet) ; le studio vérifie
// ensuite la session Checkout ici (aucun webhook nécessaire) et enregistre
// l'achat / l'abonnement. L'export avec l'instru passe par l'achat de la
// licence de l'instru ou de la mélodie (boutique du site).

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const PLANS = {
  collab: { amount: 500, name: "Nova Pro · tes instrus + collaboration + 10 exports / mois" },
  beatmaker: { amount: 1000, name: "Nova Studio · Beatmaker (tes instrus dans la bibliothèque)" },
} as const;
const EXPORT_VOICES_CENTS = 200;
const PRO_FREE_EXPORTS = 10; // par période d'abonnement

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

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function callerOf(req: Request): Promise<{ id: string; email?: string } | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token.split(".").length !== 3) return null;
  const { data } = await supabase.auth.getUser(token);
  return data?.user ? { id: data.user.id, email: data.user.email || undefined } : null;
}

async function isAdmin(userId: string): Promise<boolean> {
  const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  return (data || []).some((r: any) => ["admin", "superadmin"].includes(String(r.role)));
}

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
  const end = (sub as any).current_period_end ?? (sub.items?.data?.[0] as any)?.current_period_end;
  await supabase.from("nova_subscriptions").upsert({
    stripe_subscription_id: sub.id, user_id: userId, plan, stripe_customer_id: String(sub.customer),
    status: sub.status, current_period_end: end ? new Date(end * 1000).toISOString() : null, updated_at: new Date().toISOString(),
  });
}

async function activePlans(userId: string): Promise<{ plan: string; status: string; current_period_end: string | null }[]> {
  const { data } = await supabase.from("nova_subscriptions").select("*").eq("user_id", userId);
  const out: { plan: string; status: string; current_period_end: string | null }[] = [];
  for (const row of data || []) {
    // Rafraîchi chez Stripe si l'info a plus d'une heure (renouvellement, résiliation).
    let r = row;
    if (Date.now() - Date.parse(row.updated_at) > 3600_000) {
      try { const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id); await saveSubscription(sub, userId, row.plan); r = { ...row, status: sub.status }; } catch { /* garde l'état connu */ }
    }
    if (["active", "trialing", "past_due"].includes(r.status)) out.push({ plan: r.plan, status: r.status, current_period_end: r.current_period_end });
  }
  return out;
}

/** Exports gratuits restants sur la période d'abonnement en cours. */
async function creditsOf(userId: string): Promise<{ pro: boolean; remaining: number }> {
  const plans = await activePlans(userId);
  const pro = plans.find(p => p.plan === "collab");
  if (!pro && !(await isAdmin(userId))) return { pro: false, remaining: 0 };
  // Début de période : fin de période - 1 mois (sinon le 1er du mois).
  const end = pro?.current_period_end ? new Date(pro.current_period_end) : null;
  const start = end ? new Date(end.getTime()) : new Date();
  if (end) start.setMonth(start.getMonth() - 1); else start.setDate(1);
  if (!end) start.setHours(0, 0, 0, 0);
  const { count } = await supabase.from("nova_export_uses").select("id", { count: "exact", head: true })
    .eq("user_id", userId).gte("created_at", start.toISOString());
  return { pro: true, remaining: Math.max(0, PRO_FREE_EXPORTS - (count || 0)) };
}

async function handle(body: any, user: { id: string; email?: string } | null) {
  const action = body?.action;

  if (action === "checkout") {
    const product = String(body?.product || "");
    const returnUrl = okReturn(body?.return_url);
    const sep = returnUrl.includes("?") ? "&" : "?";
    const success_url = `${returnUrl}${sep}nova_paid={CHECKOUT_SESSION_ID}`;
    if (product === "collab" || product === "beatmaker") {
      if (!user?.email) throw new HttpError(401, "Connecte-toi à ton compte Make Music pour t'abonner");
      const plan = PLANS[product];
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: await customerFor(user.email),
        line_items: [{ quantity: 1, price_data: { currency: "eur", unit_amount: plan.amount, recurring: { interval: "month" }, product_data: { name: plan.name } } }],
        metadata: { nova_plan: product, user_id: user.id },
        subscription_data: { metadata: { nova_plan: product, user_id: user.id } },
        success_url, cancel_url: returnUrl,
        allow_promotion_codes: true,
      });
      return { url: session.url, session_id: session.id };
    }
    if (product === "export_voices") {
      const projectKey = String(body?.project_key || "").slice(0, 80);
      if (!/^[A-Za-z0-9_.:-]{6,80}$/.test(projectKey)) throw new HttpError(400, "Projet inconnu");
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        ...(user?.email ? { customer: await customerFor(user.email) } : {}),
        line_items: [{ quantity: 1, price_data: { currency: "eur", unit_amount: EXPORT_VOICES_CENTS, product_data: { name: "Nova Studio · Export de mes pistes (voix, batterie)" } } }],
        metadata: { nova_purchase: "export_voices", project_key: projectKey, user_id: user?.id || "" },
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
      return { paid: ["active", "trialing"].includes(sub.status), kind: md.nova_plan };
    }
    if (s.payment_status !== "paid") return { paid: false };
    if (md.nova_purchase === "export_voices") {
      await supabase.from("nova_purchases").upsert({
        checkout_session_id: s.id, kind: "export_voices", project_key: md.project_key, user_id: md.user_id || null,
        email: s.customer_details?.email || null, amount_cents: s.amount_total || EXPORT_VOICES_CENTS,
      });
      return { paid: true, kind: "export_voices", project_key: md.project_key };
    }
    return { paid: false };
  }

  if (action === "status") {
    if (!user) return { plans: [], admin: false };
    // Pas de webhook : si l'abonné a fermé l'attente avant le retour de Stripe,
    // l'abonnement n'était jamais enregistré. On le retrouve chez Stripe.
    if (user.email) {
      const { data: known } = await supabase.from("nova_subscriptions").select("stripe_subscription_id").eq("user_id", user.id).limit(1);
      if (!known?.length) {
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
    }
    const admin = await isAdmin(user.id);
    const credit = await creditsOf(user.id);
    return { plans: await activePlans(user.id), admin, free_exports_left: admin ? 999 : credit.remaining, free_exports_total: PRO_FREE_EXPORTS };
  }

  if (action === "export_unlocked") {
    // Le studio (admins) teste tout gratuitement.
    if (user && await isAdmin(user.id)) return { unlocked: true, admin: true };
    const projectKey = String(body?.project_key || "");
    const { data } = await supabase.from("nova_purchases").select("checkout_session_id").eq("project_key", projectKey).limit(1);
    if (data?.length) return { unlocked: true };
    const { data: uses } = await supabase.from("nova_export_uses").select("id").eq("project_key", projectKey).limit(1);
    return { unlocked: !!uses?.length };
  }

  if (action === "use_export_credit") {
    // Nova Pro : un des 10 exports gratuits de la période débloque ce projet.
    if (!user) return { unlocked: false, remaining: 0, reason: "login" };
    if (await isAdmin(user.id)) return { unlocked: true, remaining: 999, admin: true }; // admins : sans limite, rien n'est décompté
    const projectKey = String(body?.project_key || "");
    if (!/^[A-Za-z0-9_.:-]{6,80}$/.test(projectKey)) throw new HttpError(400, "Projet inconnu");
    const { data: already } = await supabase.from("nova_export_uses").select("id").eq("user_id", user.id).eq("project_key", projectKey).limit(1);
    const credit = await creditsOf(user.id);
    if (already?.length) return { unlocked: true, remaining: credit.remaining };
    if (!credit.pro) return { unlocked: false, remaining: 0, reason: "not_pro" };
    if (credit.remaining <= 0) return { unlocked: false, remaining: 0, reason: "quota" };
    const { error } = await supabase.from("nova_export_uses").insert({ user_id: user.id, project_key: projectKey });
    if (error && !/duplicate/i.test(error.message)) throw new HttpError(500, error.message);
    return { unlocked: true, remaining: credit.remaining - 1 };
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

serve(async (req) => {
  const headers = { ...cors(req.headers.get("origin")), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { headers });
  try {
    const body = await req.json();
    const user = await callerOf(req);
    return new Response(JSON.stringify(await handle(body, user)), { headers });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error("[nova-billing]", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message }), { status, headers });
  }
});
