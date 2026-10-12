// Lien d'écoute client SANS COMPTE (chantier 12 · B5 de la feuille de route).
// Remplace Audiomovers : l'ingé crée un lien, le client (artiste, label,
// manager) l'ouvre sur son téléphone, en navigation privée, sans compte, et
// entend le mix en direct quand l'ingé diffuse, plus les dernières versions
// envoyées ; il peut voir les commentaires. AUCUNE écriture possible.
//
// Deux familles d'actions, jamais mélangées :
//  - côté INGÉ (compte connecté + lien de la séance <id>.<secret>, comme
//    daw-session) : listen_create, listen_list, listen_revoke ;
//  - côté CLIENT (le jeton du lien d'écoute, rien d'autre) : listen_open, en
//    lecture seule. Toute autre action portant un jeton d'écoute → 403.
//
// Sécurité du jeton :
//  - 32 caractères tirés au hasard (crypto.getRandomValues, sans biais) dans un
//    alphabet de 57 : ≈ 2^186 possibilités, non devinable ; recherché par son
//    empreinte SHA-256 ;
//  - expire (24 h, 7 j ou 30 j, choisi par l'ingé) et se révoque en un clic ;
//  - mot de passe facultatif, gardé en PBKDF2-SHA256 (100 000 tours, sel
//    aléatoire), 8 essais faux → lien bloqué 15 min ;
//  - n'ouvre QUE la lecture : il n'est pas le secret de la séance (daw-session
//    le refuse), et cette fonction n'a aucune action d'écriture pour lui.
//
// Le direct (WebRTC, Opus stéréo 510 kb/s) ne passe pas par ici : la page du
// client rejoint le canal Supabase Realtime propre au lien (nom non devinable,
// renvoyé seulement à qui présente un jeton valide). L'ingé ne diffuse que sur
// les canaux des liens actifs : un lien révoqué ou expiré n'est plus servi.
//
// Table : supabase/migrations/20261012180000_daw_listen_links.sql (RLS sans
// policy : accès par cette fonction seulement, clé service).

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { collectReview, publicComments, publicVersions } from "./review.ts";

/** Durées proposées à l'ingé (heures) : 24 h, 7 jours, 30 jours. */
export const TTL_HOURS = [24, 168, 720];
const MAX_ACTIVE_LINKS = 20;
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const TOKEN_LEN = 32;
const TOKEN_RE = /^[A-Za-z0-9]{32}$/;
const LINK_ID_RE = /^[a-z0-9]{16}$/;
const ID_RE = /^[a-z0-9]{12}$/;
const PBKDF2_ITER = 100_000;
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60_000;
/** Versions dont on signe l'audio (les plus récentes), validité des liens signés. */
const SIGNED_VERSIONS = 10;
const SIGNED_TTL_S = 7200;
const BUCKET = "daw-sessions";
/** Liens expirés ou révoqués gardés 30 jours (message clair), puis supprimés. */
const PURGE_AFTER_MS = 30 * 86400_000;

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

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer | Uint8Array) => Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array((s.match(/../g) || []).map(h => parseInt(h, 16)));
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
/** Tirage sans biais (rejet des octets au-delà du dernier multiple de la taille de l'alphabet). */
export const randomToken = (len: number, alphabet: string) => {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b >= limit) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === len) break;
    }
  }
  return out;
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${hex(salt)}$${await pbkdf2(password, salt, PBKDF2_ITER)}`;
}
async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [kind, iter, salt, hash] = String(stored || "").split("$");
  const n = Number(iter);
  if (kind !== "pbkdf2" || !Number.isInteger(n) || n < 1000 || n > 1_000_000 || !salt || !hash) return false;
  return safeEqual(await pbkdf2(password, unhex(salt), n), hash);
}

class HttpError extends Error { constructor(public status: number, msg: string, public extra?: Record<string, unknown>) { super(msg); } }

async function callerOf(req: Request): Promise<{ id: string; email?: string } | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token.split(".").length !== 3) return null;
  const { data } = await supabase.auth.getUser(token);
  return data?.user ? { id: data.user.id, email: data.user.email || undefined } : null;
}

type SessionRow = { id: string; secret_hash: string; owner_id: string | null; name: string };

/** Séance : la clé du lien de séance, ou en être le propriétaire connecté (comme daw-session). */
async function authorizeSession(id: unknown, secret: unknown, user: { id: string } | null): Promise<SessionRow> {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(400, "Lien de session invalide");
  const { data, error } = await supabase.from("daw_sessions").select("id, secret_hash, owner_id, name").eq("id", id).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "Session introuvable");
  const row = data as SessionRow;
  if (user && row.owner_id === user.id) return row;
  if (typeof secret !== "string" || secret.length < 24 || secret.length > 64 || !safeEqual(row.secret_hash, await sha256(secret))) {
    throw new HttpError(404, "Session introuvable");
  }
  return row;
}

type LinkRow = {
  id: string; session_id: string; token: string; token_hash: string; label: string;
  allow_live: boolean; allow_versions: boolean; allow_comments: boolean; password_hash: string | null;
  created_by: string | null; created_at: string; expires_at: string; revoked_at: string | null;
  open_count: number | null; last_opened_at: string | null; failed_attempts: number | null; locked_until: string | null;
};

/** Canal Realtime du lien (diffusion du mix) : connu seulement de l'ingé et des porteurs d'un jeton valide. */
export const channelOf = (linkId: string) => `nova-listen-${linkId}`;

const linkView = (r: LinkRow) => ({
  id: r.id, token: r.token, label: r.label, live: !!r.allow_live, versions: !!r.allow_versions, comments: !!r.allow_comments,
  has_password: !!r.password_hash, created_at: r.created_at, expires_at: r.expires_at, channel: channelOf(r.id),
  opens: r.open_count || 0, last_opened_at: r.last_opened_at || null,
});

const isActive = (r: LinkRow, now = Date.now()) => !r.revoked_at && Date.parse(r.expires_at) > now;

async function activeLinks(sessionId: string): Promise<LinkRow[]> {
  const { data, error } = await supabase.from("daw_listen_links").select("*").eq("session_id", sessionId)
    .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(200);
  if (error) throw new HttpError(500, error.message);
  return ((data || []) as LinkRow[]).filter(r => isActive(r));
}

const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleString("fr-BE", { timeZone: "Europe/Brussels", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
};

const READ_ONLY = "Lien d'écoute : lecture seule. Il ne permet aucune modification de la séance.";

async function handle(body: any, user: { id: string; email?: string } | null) {
  const action = String(body?.action || "");

  // ─── Côté client : le jeton d'écoute ne sert QU'À lire ────────────────────────────────
  if (body?.token !== undefined && action !== "listen_open") throw new HttpError(403, READ_ONLY, { code: "read_only" });

  if (action === "listen_open") {
    const token = String(body?.token || "");
    const unknown = async () => {
      await sleep(300);
      throw new HttpError(404, "Lien d'écoute introuvable : vérifie qu'il est complet (copie-le en entier), ou demande un nouveau lien à ton ingé son.", { code: "unknown" });
    };
    if (!TOKEN_RE.test(token)) return await unknown();
    const { data, error } = await supabase.from("daw_listen_links").select("*").eq("token_hash", await sha256(token)).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    const row = data as LinkRow | null;
    if (!row || !safeEqual(row.token, token)) return await unknown();
    if (row.revoked_at) {
      throw new HttpError(410, "Ce lien d'écoute a été désactivé par l'ingé son. Demande-lui un nouveau lien.", { code: "revoked", revoked_at: row.revoked_at });
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      throw new HttpError(410, `Ce lien d'écoute a expiré le ${fmtDate(row.expires_at)}. Demande un nouveau lien à ton ingé son.`, { code: "expired", expired_at: row.expires_at });
    }
    if (row.password_hash) {
      if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
        throw new HttpError(429, "Trop d'essais de mot de passe : réessaie dans quelques minutes.", { code: "locked", locked_until: row.locked_until });
      }
      const pw = typeof body?.password === "string" ? body.password : "";
      if (!pw) throw new HttpError(401, "Ce lien est protégé par un mot de passe : demande-le à ton ingé son.", { code: "password_required" });
      if (pw.length > 64 || !(await checkPassword(pw, row.password_hash))) {
        const fails = (row.failed_attempts || 0) + 1;
        await supabase.from("daw_listen_links").update({
          failed_attempts: fails >= MAX_FAILS ? 0 : fails,
          ...(fails >= MAX_FAILS ? { locked_until: new Date(Date.now() + LOCK_MS).toISOString() } : {}),
        }).eq("id", row.id);
        await sleep(400);
        throw new HttpError(403, "Mot de passe incorrect.", { code: "password_wrong" });
      }
    }
    const wantsReview = row.allow_versions || row.allow_comments;
    const { data: s } = await supabase.from("daw_sessions").select(wantsReview ? "id, name, manifest" : "id, name").eq("id", row.session_id).maybeSingle();
    if (!s) throw new HttpError(410, "Cette séance n'existe plus : demande un nouveau lien à ton ingé son.", { code: "gone" });
    // Compteur d'ouvertures (pas les rafraîchissements de la page ouverte), essais remis à zéro.
    if (!body?.refresh || row.failed_attempts) {
      await supabase.from("daw_listen_links").update({
        ...(body?.refresh ? {} : { open_count: (row.open_count || 0) + 1, last_opened_at: new Date().toISOString() }),
        ...(row.failed_attempts ? { failed_attempts: 0 } : {}),
      }).eq("id", row.id);
    }
    let comments = null, versions = null;
    if (wantsReview) {
      const { data: ops } = await supabase.from("daw_session_ops").select("seq, kind, op").eq("session_id", row.session_id)
        .in("kind", ["comments", "mixver"]).order("seq", { ascending: true }).limit(5000);
      const review = collectReview({ project: (s as any).manifest?.project, ops: (ops || []) as { kind: string; op: unknown }[] });
      if (row.allow_comments) comments = publicComments(review.comments.values());
      if (row.allow_versions) {
        versions = publicVersions(review.versions.values()).map(v => ({ ...v, urls: null as Record<string, string> | null }));
        for (const v of versions.slice(0, SIGNED_VERSIONS)) {
          if (!v.audio) continue;
          const { data: signed, error: e2 } = await supabase.storage.from(BUCKET).createSignedUrls(v.audio.parts.map(p => `${row.session_id}/${p}`), SIGNED_TTL_S);
          if (e2 || !signed) continue;
          const urls: Record<string, string> = {};
          (signed as { signedUrl?: string }[]).forEach((d, k) => { if (d?.signedUrl) urls[v.audio!.parts[k]] = d.signedUrl; });
          if (Object.keys(urls).length === v.audio.parts.length) v.urls = urls;
        }
      }
    }
    return {
      link: { label: row.label, expires_at: row.expires_at, live: !!row.allow_live, versions: !!row.allow_versions, comments: !!row.allow_comments },
      session: { name: (s as any).name || "Séance" },
      channel: row.allow_live ? channelOf(row.id) : null,
      comments, versions,
      server_time: new Date().toISOString(),
    };
  }

  // ─── Côté ingé : compte connecté + lien de la séance ─────────────────────────────────
  if (action === "listen_create" || action === "listen_list" || action === "listen_revoke") {
    if (!user) throw new HttpError(401, "Connecte-toi à ton compte Make Music pour gérer les liens d'écoute");
    const session = await authorizeSession(body?.id, body?.secret, user);

    if (action === "listen_list") {
      return { links: (await activeLinks(session.id)).map(linkView) };
    }

    if (action === "listen_revoke") {
      const linkId = String(body?.link_id || "");
      if (!LINK_ID_RE.test(linkId)) throw new HttpError(400, "Lien d'écoute invalide");
      const { data: r } = await supabase.from("daw_listen_links").select("id, session_id, revoked_at").eq("id", linkId).maybeSingle();
      if (!r || (r as any).session_id !== session.id) throw new HttpError(404, "Lien d'écoute introuvable");
      if (!(r as any).revoked_at) {
        const { error } = await supabase.from("daw_listen_links").update({ revoked_at: new Date().toISOString() }).eq("id", linkId);
        if (error) throw new HttpError(500, error.message);
      }
      return { ok: true };
    }

    // listen_create
    const ttl = Number(body?.ttl_hours);
    if (!TTL_HOURS.includes(ttl)) throw new HttpError(400, "Durée invalide : 24 h, 7 jours ou 30 jours");
    const live = body?.live !== false, versions = body?.versions !== false, comments = !!body?.comments;
    if (!live && !versions && !comments) throw new HttpError(400, "Choisis au moins une chose à partager : le mix en direct, les versions ou les commentaires");
    const password = typeof body?.password === "string" ? body.password : "";
    if (password && (password.length < 4 || password.length > 64)) throw new HttpError(400, "Mot de passe : de 4 à 64 caractères");
    const active = await activeLinks(session.id);
    if (active.length >= MAX_ACTIVE_LINKS) throw new HttpError(409, `Déjà ${MAX_ACTIVE_LINKS} liens actifs sur cette séance : révoques-en un avant d'en créer un autre`);
    // Ménage : liens expirés ou révoqués depuis plus de 30 jours.
    const cutoff = new Date(Date.now() - PURGE_AFTER_MS).toISOString();
    await supabase.from("daw_listen_links").delete().lt("expires_at", cutoff);
    await supabase.from("daw_listen_links").delete().lt("revoked_at", cutoff);
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      const token = randomToken(TOKEN_LEN, TOKEN_ALPHABET);
      const row = {
        id: randomToken(16, "abcdefghijklmnopqrstuvwxyz0123456789"), session_id: session.id, token, token_hash: await sha256(token),
        label: String(body?.label || "").replace(/\s+/g, " ").trim().slice(0, 60),
        allow_live: live, allow_versions: versions, allow_comments: comments,
        password_hash: password ? await hashPassword(password) : null,
        created_by: user.id, expires_at: new Date(now + ttl * 3600_000).toISOString(),
        revoked_at: null, open_count: 0, last_opened_at: null, failed_attempts: 0, locked_until: null,
      };
      const { error } = await supabase.from("daw_listen_links").insert(row);
      if (!error) return { link: linkView({ ...row, created_at: new Date(now).toISOString() } as LinkRow) };
      if (!/duplicate|unique/i.test(error.message)) throw new HttpError(500, error.message);
    }
    throw new HttpError(503, "Création du lien impossible pour l'instant : réessaie");
  }

  throw new HttpError(400, "Action inconnue");
}

serve(async (req) => {
  const headers = { ...cors(req.headers.get("origin")), "Content-Type": "application/json", "Cache-Control": "no-store" };
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
