// NOVA · Lot 7 · Notifications (Web Push) : commentaire, version, invitation, prise reçue.
//
// Réveillée par les triggers SQL (pg_net, voir supabase/migrations/20261016120000_nova_notifications.sql
// et D:\1 WORK\CONTENU\nova-151\serveur\notifications_151.sql) à chaque événement de collaboration.
// Elle ne touche pas à daw-session : elle lit les tables existantes (daw_sessions, daw_session_members)
// et la file nova_notify_events.
//
// Actions (POST JSON) :
//   - « config » (sans compte) : la clé PUBLIQUE VAPID, ou null si elle n'est pas posée : NOVA cache
//     alors la fonction, sans erreur ;
//   - « drain » (sans compte) : traite les événements en attente. Sans danger : il n'envoie que ce
//     qui est déjà dans la file, une seule fois (file réclamée par nova_notify_claim + dédoublonnage) ;
//   - « test » (compte connecté) : une notification d'essai sur ses propres appareils (1 / 30 s).
// L'abonnement (nova_push_subscribe) et les réglages (nova_notify_prefs) passent par la base, avec RLS.
//
// Secrets (posés par Romain, voir le LISEZMOI du dossier serveur) : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// VAPID_SUBJECT (facultatif). Jamais dans le code.
// Déploiement : npx supabase functions deploy nova-push --project-ref mxdrxpzxbgybchzzvpkf --no-verify-jwt

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { messagesForEvent, prefAllows, pushPayload, recipientsFor, testMessage, type NotifyEvent, type PushMessage, type SessionInfo } from "./messages.ts";
import { importVapidKey, isPushEndpoint, sendPush, type VapidKeys } from "./webPush.ts";

const ALLOWED_ORIGINS = [
  "https://nova-studio-daw-0901-9kzo.vercel.app",
  "https://nova-studio-daw-0901.vercel.app",
  "https://studiomakemusic.com",
  "https://www.studiomakemusic.com",
];

const cors = (origin: string | null): Record<string, string> => {
  const ok = origin && (ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const env = (k: string) => (Deno.env.get(k) || "").trim();
const publicKey = () => (/^[A-Za-z0-9_-]{86,88}$/.test(env("VAPID_PUBLIC_KEY")) ? env("VAPID_PUBLIC_KEY") : null);

let vapidMemo: { pub: string; keys: VapidKeys } | null = null;
/** Clés VAPID lues dans les secrets ; null si absentes ou illisibles (les envois push sont alors sautés). */
async function loadVapid(): Promise<VapidKeys | null> {
  const pub = publicKey();
  const priv = env("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return null;
  if (vapidMemo && vapidMemo.pub === pub) return vapidMemo.keys;
  try {
    const signKey = await importVapidKey(pub, priv);
    const subject = /^(mailto:|https:\/\/)/.test(env("VAPID_SUBJECT")) ? env("VAPID_SUBJECT") : "https://www.studiomakemusic.com";
    vapidMemo = { pub, keys: { publicKey: pub, signKey, subject } };
    return vapidMemo.keys;
  } catch (e) {
    console.warn("[nova-push] clés VAPID illisibles :", (e as Error).message);
    return null;
  }
}

async function callerOf(req: Request): Promise<{ id: string } | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token.split(".").length !== 3) return null;
  const { data } = await supabase.auth.getUser(token);
  return data?.user ? { id: data.user.id } : null;
}

const URGENCY: Record<string, "normal" | "high"> = { comment: "high", version: "high", invite: "high", take: "normal" };

/** Envoie un message à tous les appareils d'un compte. Abonnements morts (404 / 410) retirés. */
async function pushToUser(userId: string, msg: PushMessage & { id?: number }, vapid: VapidKeys): Promise<number> {
  const { data: subs } = await supabase.from("nova_push_subscriptions").select("id, endpoint, p256dh, auth, fail_count").eq("user_id", userId);
  let sent = 0;
  for (const s of (subs || []) as any[]) {
    if (!isPushEndpoint(s.endpoint)) continue;
    let status = 0;
    try {
      status = await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, pushPayload(msg), vapid, { urgency: URGENCY[msg.type] || "normal", ttl: msg.type === "take" ? 6 * 3600 : 86400 });
    } catch (e) {
      console.warn("[nova-push] envoi", (e as Error).message);
    }
    if (status >= 200 && status < 300) {
      sent++;
      await supabase.from("nova_push_subscriptions").update({ last_ok_at: new Date().toISOString(), fail_count: 0 }).eq("id", s.id);
    } else if (status === 404 || status === 410) {
      // Le navigateur s'est désabonné (ou les données du site ont été effacées) : abonnement mort.
      await supabase.from("nova_push_subscriptions").delete().eq("id", s.id);
    } else {
      const fails = (Number(s.fail_count) || 0) + 1;
      if (fails >= 10) await supabase.from("nova_push_subscriptions").delete().eq("id", s.id);
      else await supabase.from("nova_push_subscriptions").update({ fail_count: fails }).eq("id", s.id);
    }
  }
  return sent;
}

interface DrainStats { events: number; notifications: number; pushed: number; skipped: number }

async function handleEvent(ev: NotifyEvent, vapid: VapidKeys | null, stats: DrainStats) {
  const { data: s } = await supabase.from("daw_sessions").select("id, name, secret, owner_id").eq("id", ev.session_id).maybeSingle();
  if (!s) { stats.skipped++; return; }
  const session: SessionInfo = { id: s.id, name: s.name || "Session", secret: s.secret || null, owner_id: s.owner_id || null };
  const msgs = messagesForEvent(ev, session);
  if (!msgs.length) { stats.skipped++; return; }
  const { data: members } = await supabase.from("daw_session_members").select("user_id").eq("session_id", session.id);
  const recipients = recipientsFor(ev, session, ((members || []) as any[]).map(m => m.user_id));
  if (!recipients.length) { stats.skipped++; return; }
  const { data: prefRows } = await supabase.from("nova_notify_prefs").select("*").in("user_id", recipients);
  const prefs = new Map(((prefRows || []) as any[]).map(p => [String(p.user_id).toLowerCase(), p]));
  for (const msg of msgs) {
    for (const uid of recipients) {
      if (!prefAllows(prefs.get(uid), msg.type)) continue;
      // Boîte de réception (et dédoublonnage : une seule notification par chose et par personne).
      const { data: row, error } = await supabase.from("nova_notifications").insert({
        user_id: uid, type: msg.type, dedup_key: msg.dedup, session_id: session.id,
        title: msg.title, body: msg.body, url: msg.path,
        payload: { tag: msg.tag, c: msg.commentId ?? null, ver: msg.versionId ?? null, at: msg.at ?? null },
      }).select("id").single();
      if (error) {
        if (!/duplicate|unique|23505/i.test(error.message || "")) console.warn("[nova-push] boîte", error.message);
        continue;
      }
      stats.notifications++;
      if (!vapid) continue;
      const n = await pushToUser(uid, { ...msg, id: row?.id }, vapid);
      stats.pushed += n;
      if (n) await supabase.from("nova_notifications").update({ pushed_at: new Date().toISOString() }).eq("id", row.id);
    }
  }
}

let lastCleanup = 0;
async function drain(): Promise<DrainStats> {
  const vapid = await loadVapid();
  const stats: DrainStats = { events: 0, notifications: 0, pushed: 0, skipped: 0 };
  // Quelques tours : un événement arrivé pendant le traitement est pris dans la foulée.
  for (let round = 0; round < 5; round++) {
    const { data, error } = await supabase.rpc("nova_notify_claim", { p_limit: 50 });
    if (error) throw new HttpError(500, error.message);
    const evs = (Array.isArray(data) ? data : []) as NotifyEvent[];
    if (!evs.length) break;
    for (const ev of evs) {
      stats.events++;
      try {
        await handleEvent(ev, vapid, stats);
      } catch (e) {
        await supabase.from("nova_notify_events").update({ error: String((e as Error).message || e).slice(0, 300) }).eq("id", ev.id);
      }
    }
  }
  // Ménage (au plus une fois par heure et par instance) : file traitée > 7 jours, boîte > 60 jours.
  if (Date.now() - lastCleanup > 3600_000) {
    lastCleanup = Date.now();
    await supabase.from("nova_notify_events").delete().lt("created_at", new Date(Date.now() - 7 * 86400_000).toISOString());
    await supabase.from("nova_notifications").delete().lt("created_at", new Date(Date.now() - 60 * 86400_000).toISOString());
  }
  return stats;
}

const lastTest = new Map<string, number>();

async function handle(body: any, req: Request): Promise<unknown> {
  const action = String(body?.action || "");
  if (action === "config") {
    return { public_key: publicKey() };
  }
  if (action === "drain") {
    return await drain();
  }
  if (action === "test") {
    const user = await callerOf(req);
    if (!user) throw new HttpError(401, "Connecte-toi à ton compte Make Music pour tester les notifications");
    const vapid = await loadVapid();
    if (!vapid) throw new HttpError(503, "Les notifications ne sont pas encore activées sur le serveur");
    const last = lastTest.get(user.id) || 0;
    if (Date.now() - last < 30_000) throw new HttpError(429, "Une notification d’essai vient de partir : attends 30 secondes");
    lastTest.set(user.id, Date.now());
    const sent = await pushToUser(user.id, testMessage(), vapid);
    if (!sent) throw new HttpError(404, "Aucun appareil n’a reçu l’essai : réactive les notifications sur cet appareil");
    return { sent };
  }
  throw new HttpError(400, "Action inconnue");
}

serve(async (req) => {
  const headers = { ...cors(req.headers.get("origin")), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST uniquement" }), { status: 405, headers });
  try {
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    return new Response(JSON.stringify(await handle(body, req)), { headers });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return new Response(JSON.stringify({ error: (e as Error).message }), { status, headers });
  }
});
