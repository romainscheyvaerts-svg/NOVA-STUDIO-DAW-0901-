// Sessions Nova « à emporter » (studio → iPad / ordinateur → studio).
//
// Le studio crée une session et reçoit un lien <id>.<secret> ; seule
// l'empreinte SHA-256 du secret est stockée. Toute lecture / écriture exige le
// secret. L'audio est découpé en morceaux nommés par leur SHA-1 (le client
// n'envoie que ce qui manque), le projet (JSON) est dans le manifeste.
// Écriture optimiste : commit avec la version de base, 409 si quelqu'un a
// synchronisé entre-temps.
//
// Compte client (même compte que studiomakemusic.com) : une session peut avoir
// un propriétaire. Il la retrouve dans son espace (list_mine renvoie le lien),
// l'ouvre sans le lien, peut la supprimer. Le client rattache une session
// reçue (claim, avec le lien) ; le studio (admin) l'attribue par e-mail (assign).

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const BUCKET = "daw-sessions";
const MAX_SESSION_BYTES = 1500 * 1024 * 1024; // 1,5 Go par session
const MAX_MANIFEST_CHARS = 4_000_000;
const MAX_PARTS_PER_CALL = 200;
const SIGN_WITHOUT_LIST_MAX = 4; // au-delà, on liste la session pour ne pas renvoyer ce qui y est déjà
const STALE_DAYS = 180; // sessions oubliées : supprimées à la création d'une nouvelle
// Collaboration (journal d'opérations) : l'activité repousse le ménage des 180 jours.
// Au plus une écriture par heure et par session (pas une par opération).
const ACTIVITY_REFRESH_MS = 3600_000;
// Invitation par code (« Feat à distance ») : 6 caractères sans ambiguïté, valable 24 h.
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INVITE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const INVITE_TTL_MS = 24 * 3600_000;

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

const PART_RE = /^[a-f0-9]{40}$/;
const ID_RE = /^[a-z0-9]{12}$/;

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const randomToken = (len: number, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789") => {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
};
const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};

type Row = { id: string; secret_hash: string; secret: string | null; owner_id: string | null; name: string; version: number; manifest: any; total_bytes: number; updated_at: string; updated_from: string | null };

/** Utilisateur connecté (jeton du compte Make Music), ou null (clé anonyme). */
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

class HttpError extends Error { constructor(public status: number, msg: string, public extra?: Record<string, unknown>) { super(msg); } }

/** Accès : la clé du lien, ou être le propriétaire connecté. */
async function authorize(id: unknown, secret: unknown, user: { id: string } | null): Promise<Row> {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(400, "Lien de session invalide");
  const { data, error } = await supabase.from("daw_sessions").select("*").eq("id", id).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "Session introuvable");
  const row = data as Row;
  if (user && row.owner_id === user.id) return row;
  if (typeof secret !== "string" || secret.length < 24 || secret.length > 64 || !safeEqual(row.secret_hash, await sha256(secret))) {
    throw new HttpError(404, "Session introuvable");
  }
  return row;
}

const linkOf = (row: Pick<Row, "id" | "secret">) => (row.secret ? `${row.id}.${row.secret}` : null);

/**
 * Une session où l'on collabore (opérations, connexions) est active : avant,
 * seul un « commit » de l'instantané mettait updated_at à jour, et une session
 * de collaboration (ou un lien « Ingé à distance », qui n'a jamais
 * d'instantané) pouvait être supprimée au bout de 180 jours en pleine
 * utilisation. updated_at est rafraîchi au plus une fois par heure.
 */
async function touchActivity(row: Pick<Row, "id" | "updated_at">) {
  const last = Date.parse(row.updated_at || "") || 0;
  if (Date.now() - last < ACTIVITY_REFRESH_MS) return;
  const { error } = await supabase.from("daw_sessions").update({ updated_at: new Date().toISOString() }).eq("id", row.id);
  if (error) console.warn("[daw-session] activité", row.id, error.message);
}

/** Collaboration : abonnement 5 €/mois pour chaque compte qui collabore (le studio en est dispensé). */
async function requireCollabPlan(userId: string) {
  if (await isAdmin(userId)) return;
  const { data: subs } = await supabase.from("nova_subscriptions").select("status, current_period_end")
    .eq("user_id", userId).eq("plan", "collab").in("status", ["active", "trialing", "past_due"]);
  if (!subs?.length) throw new HttpError(402, "Abonnement collaboration requis (5 €/mois)");
}

/** Morceaux référencés par un manifeste : { files: { chemin: { parts: [sha1…] } } }. */
const partsOf = (manifest: any): string[] => {
  const out = new Set<string>();
  const files = manifest?.files && typeof manifest.files === "object" ? manifest.files : {};
  for (const f of Object.values(files) as any[]) for (const p of (f?.parts || [])) if (typeof p === "string" && PART_RE.test(p)) out.add(p);
  return [...out];
};

async function listParts(id: string): Promise<Map<string, { size: number; created: number }>> {
  const out = new Map<string, { size: number; created: number }>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(BUCKET).list(id, { limit: 1000, offset });
    if (error) throw new HttpError(500, error.message);
    for (const o of data || []) out.set(o.name, { size: Number((o.metadata as any)?.size || 0), created: Date.parse(o.created_at || "") || 0 });
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function removeSessionFiles(id: string) {
  const parts = await listParts(id);
  const paths = [...parts.keys()].map(p => `${id}/${p}`);
  for (let i = 0; i < paths.length; i += 100) await supabase.storage.from(BUCKET).remove(paths.slice(i, i + 100));
}

async function handle(body: any, user: { id: string; email?: string } | null) {
  const action = body?.action;

  if (action === "list_mine") {
    if (!user) throw new HttpError(401, "Connecte-toi à ton compte Make Music");
    const { data, error } = await supabase.from("daw_sessions")
      .select("id, secret, name, version, total_bytes, updated_at, updated_from, created_at")
      .eq("owner_id", user.id).order("updated_at", { ascending: false }).limit(100);
    if (error) throw new HttpError(500, error.message);
    return { sessions: (data || []).map((r: any) => ({ id: r.id, link: linkOf(r), name: r.name, version: r.version, total_bytes: r.total_bytes, updated_at: r.updated_at, updated_from: r.updated_from, created_at: r.created_at })) };
  }

  if (action === "resolve_code") {
    // Code d'invitation (6 caractères) → lien de la session. Compte connecté ET abonné
    // (comme pour rejoindre) : un code deviné ne suffit pas à ouvrir une session.
    if (!user) throw new HttpError(401, "Connecte-toi à ton compte Make Music pour collaborer");
    await requireCollabPlan(user.id);
    const code = String(body?.code || "").toUpperCase().replace(/[\s\-_.]/g, "");
    const fail = async () => { await new Promise(r => setTimeout(r, 400)); throw new HttpError(404, "Code introuvable ou expiré"); };
    if (!INVITE_RE.test(code)) return await fail();
    const { data: inv } = await supabase.from("daw_session_invites").select("session_id, expires_at").eq("code", code).maybeSingle();
    if (!inv || Date.parse(inv.expires_at) < Date.now()) return await fail();
    const { data: s } = await supabase.from("daw_sessions").select("id, secret, name").eq("id", inv.session_id).maybeSingle();
    const link = s ? linkOf(s as Pick<Row, "id" | "secret">) : null;
    if (!link) return await fail();
    return { link, name: (s as any).name };
  }

  if (action === "create") {
    // Ménage opportuniste : sessions sans activité depuis longtemps.
    const cutoff = new Date(Date.now() - STALE_DAYS * 86400_000).toISOString();
    const { data: stale } = await supabase.from("daw_sessions").select("id").lt("updated_at", cutoff).limit(5);
    for (const s of stale || []) { await removeSessionFiles(s.id); await supabase.from("daw_sessions").delete().eq("id", s.id); }

    const id = randomToken(12);
    const secret = randomToken(32, "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789");
    const name = String(body?.name || "Session").slice(0, 80);
    const { error } = await supabase.from("daw_sessions").insert({
      id, secret, secret_hash: await sha256(secret), name, owner_id: user?.id || null,
      updated_from: String(body?.device || "").slice(0, 60) || null,
    });
    if (error) throw new HttpError(500, error.message);
    return { id, secret, version: 0, owned: !!user };
  }

  const row = await authorize(body?.id, body?.secret, user);

  if (action === "claim") {
    // Le client rattache à son compte une session reçue par lien.
    if (!user) throw new HttpError(401, "Connecte-toi à ton compte Make Music");
    if (row.owner_id && row.owner_id !== user.id && !(await isAdmin(user.id))) throw new HttpError(403, "Cette session appartient déjà à un autre compte");
    const { error } = await supabase.from("daw_sessions").update({ owner_id: user.id }).eq("id", row.id);
    if (error) throw new HttpError(500, error.message);
    return { ok: true, link: linkOf(row) };
  }

  if (action === "assign") {
    // Le studio (admin connecté) attribue la session au compte d'un client.
    if (!user || !(await isAdmin(user.id))) throw new HttpError(403, "Réservé au studio (compte admin)");
    const email = String(body?.email || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "E-mail invalide");
    const { data: uid, error: e1 } = await supabase.rpc("mm_user_id_by_email", { p_email: email });
    if (e1) throw new HttpError(500, e1.message);
    if (!uid) throw new HttpError(404, "Aucun compte Make Music avec cet e-mail : le client doit d'abord créer son compte sur studiomakemusic.com");
    const { error } = await supabase.from("daw_sessions").update({ owner_id: uid }).eq("id", row.id);
    if (error) throw new HttpError(500, error.message);
    return { ok: true };
  }

  if (action === "delete") {
    if (!user || (row.owner_id !== user.id && !(await isAdmin(user.id)))) throw new HttpError(403, "Seul le propriétaire peut supprimer la session");
    await removeSessionFiles(row.id);
    await supabase.from("daw_sessions").delete().eq("id", row.id);
    return { ok: true };
  }

  if (action === "sign_upload") {
    const wanted: string[] = Array.isArray(body?.parts) ? body.parts.filter((p: unknown) => typeof p === "string" && PART_RE.test(p as string)) : [];
    if (wanted.length > MAX_PARTS_PER_CALL) throw new HttpError(400, "Trop de fichiers dans un seul envoi");
    // Peu de fichiers (morceaux de prise envoyés pendant l'enregistrement, 1 par seconde) : on signe
    // directement, sans lister toute la session à chaque appel (fichiers nommés par leur SHA-1, upsert sans risque).
    const have = wanted.length > SIGN_WITHOUT_LIST_MAX ? await listParts(row.id) : new Map();
    const uploads: Record<string, { path: string; token: string }> = {};
    for (const p of new Set(wanted)) {
      if (have.has(p)) continue;
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(`${row.id}/${p}`, { upsert: true });
      if (error || !data) throw new HttpError(500, error?.message || "upload");
      uploads[p] = { path: data.path, token: data.token };
    }
    return { uploads };
  }

  if (action === "commit") {
    const manifest = body?.manifest;
    if (!manifest || typeof manifest !== "object" || !manifest.project) throw new HttpError(400, "Manifeste manquant");
    if (JSON.stringify(manifest).length > MAX_MANIFEST_CHARS) throw new HttpError(413, "Projet trop gros");
    if (!body?.force && Number(body?.baseVersion) !== row.version) {
      throw new HttpError(409, "La session a été modifiée ailleurs", { version: row.version, updated_at: row.updated_at, updated_from: row.updated_from });
    }
    const have = await listParts(row.id);
    const needed = partsOf(manifest);
    const missing = needed.filter(p => !have.has(p));
    if (missing.length) throw new HttpError(400, `Audio manquant (${missing.length} fichier(s)) : renvoie la session`);
    const total = needed.reduce((s, p) => s + (have.get(p)?.size || 0), 0);
    if (total > MAX_SESSION_BYTES) throw new HttpError(413, "Session trop lourde (1,5 Go max)");
    const version = row.version + 1;
    const { error } = await supabase.from("daw_sessions").update({
      manifest, version, total_bytes: total, updated_at: new Date().toISOString(),
      updated_from: String(body?.device || "").slice(0, 60) || null,
      ...(body?.name ? { name: String(body.name).slice(0, 80) } : {}),
    }).eq("id", row.id).eq("version", row.version);
    if (error) throw new HttpError(500, error.message);
    // Morceaux qui ne servent plus (et pas tout juste envoyés par un autre appareil).
    const keep = new Set(needed);
    // Audio envoyé en direct par les collaborateurs (journal d'opérations) : gardé aussi.
    const { data: recentOps } = await supabase.from("daw_session_ops").select("op").eq("session_id", row.id).order("seq", { ascending: false }).limit(3000);
    for (const o of recentOps || []) for (const h of JSON.stringify(o.op).match(/[a-f0-9]{40}/g) || []) keep.add(h);
    const old = [...have.entries()].filter(([p, m]) => !keep.has(p) && Date.now() - m.created > 30 * 60_000).map(([p]) => `${row.id}/${p}`);
    for (let i = 0; i < old.length; i += 100) await supabase.storage.from(BUCKET).remove(old.slice(i, i + 100));
    return { version };
  }

  if (action === "get") {
    const parts = partsOf(row.manifest);
    const urls: Record<string, string> = {};
    for (let i = 0; i < parts.length; i += 100) {
      const slice = parts.slice(i, i + 100);
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(slice.map(p => `${row.id}/${p}`), 7200);
      if (error) throw new HttpError(500, error.message);
      (data || []).forEach((d, k) => { if (d.signedUrl) urls[slice[k]] = d.signedUrl; });
    }
    return { id: row.id, link: linkOf(row), owned: !!user && row.owner_id === user.id, has_owner: !!row.owner_id, name: row.name, version: row.version, updated_at: row.updated_at, updated_from: row.updated_from, manifest: row.manifest, urls };
  }

  // --- Collaboration (artiste / ingé son / beatmaker) -------------------------
  const ROLES = ["artist", "engineer", "beatmaker"];
  const deviceOf = () => String(body?.device_id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  // Une clé par APPAREIL : le même compte peut être artiste sur son PC et ingé sur sa
  // tablette (avant : « u:<compte> », la 2e connexion écrasait le rôle de la 1re).
  // Sans identifiant d'appareil (ancien client) : l'ancienne clé, comme avant.
  const memberKeyOf = () => {
    const dev = deviceOf();
    if (user) return dev ? `u:${user.id}:${dev}` : `u:${user.id}`;
    return `d:${dev}`;
  };

  if (action === "join") {
    const role = String(body?.role || "");
    if (!ROLES.includes(role)) throw new HttpError(400, "Rôle inconnu");
    // Collaboration = abonnement 5 €/mois pour chaque compte qui collabore (le studio en est dispensé).
    if (!user) throw new HttpError(401, "Connecte-toi à ton compte Make Music pour collaborer");
    await requireCollabPlan(user.id);
    const key = memberKeyOf();
    if (key === "d:") throw new HttpError(400, "Appareil inconnu");
    const name = String(body?.name || user?.email?.split("@")[0] || "Invité").slice(0, 40);
    const { error } = await supabase.from("daw_session_members").upsert({
      session_id: row.id, member_key: key, user_id: user?.id || null, role, display_name: name, last_seen: new Date().toISOString(),
    });
    if (error) throw new HttpError(500, error.message);
    await touchActivity(row);
    const { data: last } = await supabase.from("daw_session_ops").select("seq").eq("session_id", row.id).order("seq", { ascending: false }).limit(1);
    const { data: members } = await supabase.from("daw_session_members").select("member_key, role, display_name, last_seen").eq("session_id", row.id);
    return { member_key: key, last_seq: last?.[0]?.seq || 0, members: members || [], channel: `nova-collab-${row.id}-${(await sha256(row.secret_hash)).slice(0, 16)}` };
  }

  if (action === "op") {
    const kind = String(body?.kind || "");
    if (!/^[a-z_]{2,20}$/.test(kind)) throw new HttpError(400, "Opération invalide");
    const op = body?.op;
    if (!op || typeof op !== "object") throw new HttpError(400, "Opération vide");
    if (JSON.stringify(op).length > 1_500_000) throw new HttpError(413, "Opération trop grosse");
    let key = memberKeyOf();
    let { data: m } = await supabase.from("daw_session_members").select("role, display_name").eq("session_id", row.id).eq("member_key", key).maybeSingle();
    if (!m && user && key !== `u:${user.id}`) {
      // Rejoint avant la clé par appareil (fonction mise à jour en pleine session) : son ancienne clé.
      const legacy = `u:${user.id}`;
      const r2 = await supabase.from("daw_session_members").select("role, display_name").eq("session_id", row.id).eq("member_key", legacy).maybeSingle();
      if (r2.data) { m = r2.data; key = legacy; }
    }
    if (!m) throw new HttpError(403, "Rejoins d'abord la session");
    const { data, error } = await supabase.from("daw_session_ops").insert({
      session_id: row.id, member_key: key, role: m.role, author_name: m.display_name, kind, op,
    }).select("seq, created_at").single();
    if (error) throw new HttpError(500, error.message);
    await supabase.from("daw_session_members").update({ last_seen: new Date().toISOString() }).eq("session_id", row.id).eq("member_key", key);
    await touchActivity(row);
    return { seq: data.seq, created_at: data.created_at, role: m.role, author_name: m.display_name, member_key: key };
  }

  if (action === "invite_code") {
    // Code à 6 caractères pour inviter (dicté au téléphone, écrit sur un mur…) : le même
    // pendant 24 h pour une session, un nouveau ensuite.
    if (!user) throw new HttpError(401, "Connecte-toi à ton compte Make Music pour inviter");
    if (!linkOf(row)) throw new HttpError(409, "Cette session n'a pas de lien partageable");
    const now = Date.now();
    const { data: cur } = await supabase.from("daw_session_invites").select("code, expires_at").eq("session_id", row.id)
      .gt("expires_at", new Date(now + 3600_000).toISOString()).order("expires_at", { ascending: false }).limit(1);
    if (cur?.[0]) return { code: cur[0].code, expires_at: cur[0].expires_at };
    const expires_at = new Date(now + INVITE_TTL_MS).toISOString();
    for (let i = 0; i < 6; i++) {
      const code = randomToken(6, INVITE_ALPHABET);
      const { error } = await supabase.from("daw_session_invites").insert({ code, session_id: row.id, created_by: user.id, expires_at });
      if (!error) {
        // Ménage : codes expirés depuis plus d'un jour.
        await supabase.from("daw_session_invites").delete().lt("expires_at", new Date(now - 86400_000).toISOString());
        return { code, expires_at };
      }
      if (!/duplicate|unique/i.test(error.message)) throw new HttpError(500, error.message);
    }
    throw new HttpError(503, "Code indisponible pour l'instant : envoie le lien");
  }

  if (action === "ops_since") {
    const after = Math.max(0, Number(body?.after) || 0);
    const { data, error } = await supabase.from("daw_session_ops")
      .select("seq, member_key, role, author_name, kind, op, created_at")
      .eq("session_id", row.id).gt("seq", after).order("seq", { ascending: true }).limit(500);
    if (error) throw new HttpError(500, error.message);
    return { ops: data || [] };
  }

  if (action === "members") {
    const { data } = await supabase.from("daw_session_members").select("member_key, role, display_name, last_seen").eq("session_id", row.id);
    return { members: data || [] };
  }

  if (action === "urls") {
    // Liens de téléchargement de morceaux audio précis (prises reçues en direct).
    const parts: string[] = (Array.isArray(body?.parts) ? body.parts : []).filter((p: unknown) => typeof p === "string" && PART_RE.test(p as string)).slice(0, 200);
    const urls: Record<string, string> = {};
    if (parts.length) {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(parts.map(p => `${row.id}/${p}`), 7200);
      if (error) throw new HttpError(500, error.message);
      (data || []).forEach((d, k) => { if (d.signedUrl) urls[parts[k]] = d.signedUrl; });
    }
    return { urls };
  }

  if (action === "info") {
    return { id: row.id, link: linkOf(row), owned: !!user && row.owner_id === user.id, has_owner: !!row.owner_id, name: row.name, version: row.version, updated_at: row.updated_at, updated_from: row.updated_from, total_bytes: row.total_bytes };
  }

  throw new HttpError(400, "Action inconnue");
}

serve(async (req) => {
  const headers = { ...cors(req.headers.get("origin")), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST uniquement" }), { status: 405, headers });
  try {
    const body = await req.json();
    const user = await callerOf(req);
    return new Response(JSON.stringify(await handle(body, user)), { headers });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const extra = e instanceof HttpError ? e.extra : undefined;
    return new Response(JSON.stringify({ error: (e as Error).message, ...(extra || {}) }), { status, headers });
  }
});
