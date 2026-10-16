// Lot 9a (1.5.1) · Lien « Faire sa version » : chacun reçoit SA PROPRE copie privée d'une séance.
//
// Cas d'usage : le beatmaker envoie sa séance (pistes séparées, tempo, accords) à 10 rappeurs ;
// chacun ouvre le lien, se connecte (compte gratuit) et obtient sa copie, sur son appareil,
// sans aucun accès à l'original : il ne reçoit jamais le secret de la séance, ne peut ni la
// rejoindre ni y écrire. Une modification dans la copie ne touche pas l'original.
//
// Deux familles d'actions, jamais mélangées :
//  - côté HÔTE (compte connecté, propriétaire de la séance, + lien de la séance <id>.<secret>) :
//    fork_create, fork_list, fork_revoke ;
//  - côté DESTINATAIRE (le jeton du lien + un compte connecté) : fork_open. Toute autre action
//    portant un jeton → 403.
//
// Ce que le lien donne : l'instantané de la séance AU MOMENT où le lien est créé (figé dans la
// ligne du lien : les envois suivants de l'hôte ne changent pas les copies). L'audio des pistes
// du CATALOGUE n'est jamais copié (_shared/forkCopy.ts) : chacun le retrouve depuis le catalogue
// et son export reste soumis aux règles habituelles. La copie a sa propre clé d'export : elle
// n'hérite pas d'un export payé par l'hôte.
//
// Sécurité du jeton : 32 caractères tirés sans biais (≈ 2^186), cherché par son empreinte
// SHA-256 ; lien révocable (410 ensuite). Compteur de copies (un compte = une copie comptée).
//
// Tables : daw_session_forks, daw_session_fork_copies (D:\1 WORK\CONTENU\nova-151\serveur\
// invite_copie_151.sql, RLS sans policy : accès par cette fonction seulement, clé service).
// L'audio reste dans le dossier de la séance : daw-session ne l'efface pas tant que le lien
// est actif ; la séance supprimée (ménage, propriétaire) emporte ses liens (on delete cascade).

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { isAdmin as estAdmin } from "../_shared/novaTarifs.ts";
import { freezeForFork, partsOfFrozen, type FrozenManifest } from "../_shared/forkCopy.ts";

const BUCKET = "daw-sessions";
const MAX_ACTIVE_LINKS = 5;
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const TOKEN_LEN = 32;
const TOKEN_RE = /^[A-Za-z0-9]{32}$/;
const LINK_ID_RE = /^[a-z0-9]{16}$/;
const ID_RE = /^[a-z0-9]{12}$/;
const SIGNED_TTL_S = 7200;

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

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
/** Tirage sans biais (rejet des octets au-delà du dernier multiple de la taille de l'alphabet). */
const randomToken = (len: number, alphabet: string) => {
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

class HttpError extends Error { constructor(public status: number, msg: string, public extra?: Record<string, unknown>) { super(msg); } }

async function callerOf(req: Request): Promise<{ id: string; email?: string } | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token.split(".").length !== 3) return null;
  const { data } = await supabase.auth.getUser(token);
  return data?.user ? { id: data.user.id, email: data.user.email || undefined } : null;
}

type SessionRow = { id: string; secret_hash: string; owner_id: string | null; name: string; version: number; manifest: any };
type ForkRow = {
  id: string; session_id: string; token: string; token_hash: string; label: string; name: string;
  manifest: FrozenManifest; version: number; created_by: string | null; created_at: string;
  revoked_at: string | null; copies: number | null; last_copy_at: string | null;
};

/** Séance de l'hôte : le propriétaire connecté (avec ou sans la clé du lien), ou le studio (admin) avec la clé. */
async function authorizeOwner(id: unknown, secret: unknown, user: { id: string }): Promise<SessionRow> {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(400, "Lien de session invalide");
  const { data, error } = await supabase.from("daw_sessions").select("id, secret_hash, owner_id, name, version, manifest").eq("id", id).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "Session introuvable");
  const row = data as SessionRow;
  if (row.owner_id === user.id) return row;
  const keyOk = typeof secret === "string" && secret.length >= 24 && secret.length <= 64 && safeEqual(row.secret_hash, await sha256(secret));
  if (!keyOk) throw new HttpError(404, "Session introuvable");
  if (await estAdmin(supabase, user.id)) return row;
  throw new HttpError(403, "Seul le propriétaire de la séance peut créer ou gérer ses liens « Faire sa version ».", { code: "not_owner" });
}

const linkView = (r: ForkRow) => ({
  id: r.id, token: r.token, label: r.label || "", name: r.name, version: r.version,
  created_at: r.created_at, copies: r.copies || 0, last_copy_at: r.last_copy_at || null,
  files: Object.keys(r.manifest?.files || {}).length,
});

async function activeLinks(sessionId: string): Promise<ForkRow[]> {
  const { data, error } = await supabase.from("daw_session_forks").select("*").eq("session_id", sessionId).order("created_at", { ascending: false }).limit(100);
  if (error) throw new HttpError(500, error.message);
  return ((data || []) as ForkRow[]).filter(r => !r.revoked_at);
}

const READ_ONLY = "Lien « Faire sa version » : il ne sert qu'à récupérer ta copie. Il ne permet aucune modification de la séance d'origine.";

async function handle(body: any, user: { id: string; email?: string } | null) {
  const action = String(body?.action || "");

  // ─── Côté destinataire : le jeton ne sert QU'À récupérer sa copie ─────────────────────
  if (body?.token !== undefined && action !== "fork_open") throw new HttpError(403, READ_ONLY, { code: "read_only" });

  if (action === "fork_open") {
    const token = String(body?.token || "");
    const unknown = async () => {
      await sleep(300);
      throw new HttpError(404, "Lien introuvable : vérifie qu'il est complet (copie-le en entier), ou demande un nouveau lien à la personne qui te l'a envoyé.", { code: "unknown" });
    };
    if (!TOKEN_RE.test(token)) return await unknown();
    const { data, error } = await supabase.from("daw_session_forks").select("*").eq("token_hash", await sha256(token)).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    const row = data as ForkRow | null;
    if (!row || !safeEqual(row.token, token)) return await unknown();
    if (row.revoked_at) throw new HttpError(410, "Ce lien a été désactivé par la personne qui l'a créé : demande-lui un nouveau lien.", { code: "revoked", revoked_at: row.revoked_at });
    if (!user) throw new HttpError(401, "Connecte-toi (compte gratuit) pour récupérer ta version : elle sera rien qu'à toi.", { code: "login" });
    const { data: s } = await supabase.from("daw_sessions").select("id").eq("id", row.session_id).maybeSingle();
    if (!s) throw new HttpError(410, "La séance d'origine n'existe plus : demande un nouveau lien.", { code: "gone" });
    const parts = partsOfFrozen(row.manifest);
    const urls: Record<string, string> = {};
    for (let i = 0; i < parts.length; i += 100) {
      const slice = parts.slice(i, i + 100);
      const { data: signed, error: e2 } = await supabase.storage.from(BUCKET).createSignedUrls(slice.map(p => `${row.session_id}/${p}`), SIGNED_TTL_S);
      if (e2) throw new HttpError(500, e2.message);
      ((signed || []) as { signedUrl?: string }[]).forEach((d, k) => { if (d?.signedUrl) urls[slice[k]] = d.signedUrl; });
    }
    if (Object.keys(urls).length < parts.length) throw new HttpError(410, "Une partie de l'audio de cette séance n'est plus en ligne : demande un nouveau lien.", { code: "gone" });
    // Compteur : un compte = une copie (rouvrir le lien ne compte pas deux fois) ; l'hôte ne se compte pas.
    let copies = row.copies || 0;
    if (user.id !== row.created_by) {
      const { error: e3 } = await supabase.from("daw_session_fork_copies").insert({ fork_id: row.id, user_id: user.id });
      if (!e3) {
        copies += 1;
        await supabase.from("daw_session_forks").update({ copies, last_copy_at: new Date().toISOString() }).eq("id", row.id);
      } else if (!/duplicate|unique/i.test(e3.message)) console.warn("[daw-fork] compteur", e3.message);
    }
    return { name: row.name, label: row.label || "", version: row.version, created_at: row.created_at, manifest: row.manifest, urls, copies };
  }

  // ─── Côté hôte : compte connecté, propriétaire de la séance ────────────────────────────
  if (action === "fork_create" || action === "fork_list" || action === "fork_revoke") {
    if (!user) throw new HttpError(401, "Connecte-toi à ton compte Make Music pour partager ta séance");
    const session = await authorizeOwner(body?.id, body?.secret, user);

    if (action === "fork_list") {
      const all = await activeLinks(session.id);
      return { links: all.map(linkView), max: MAX_ACTIVE_LINKS };
    }

    if (action === "fork_revoke") {
      const linkId = String(body?.link_id || "");
      if (!LINK_ID_RE.test(linkId)) throw new HttpError(400, "Lien invalide");
      const { data: r } = await supabase.from("daw_session_forks").select("id, session_id, revoked_at").eq("id", linkId).maybeSingle();
      if (!r || (r as any).session_id !== session.id) throw new HttpError(404, "Lien introuvable");
      if (!(r as any).revoked_at) {
        const { error } = await supabase.from("daw_session_forks").update({ revoked_at: new Date().toISOString() }).eq("id", linkId);
        if (error) throw new HttpError(500, error.message);
      }
      return { ok: true };
    }

    // fork_create : l'instantané en ligne de la séance, tel qu'il est maintenant.
    if (!session.manifest?.project) throw new HttpError(409, "Ta séance n'est pas encore en ligne : mets-la en ligne (Sauvegarder › Emporter), puis crée le lien.", { code: "empty" });
    const active = await activeLinks(session.id);
    if (active.length >= MAX_ACTIVE_LINKS) throw new HttpError(409, `Déjà ${MAX_ACTIVE_LINKS} liens actifs sur cette séance : désactives-en un avant d'en créer un autre.`, { code: "too_many" });
    let frozen: ReturnType<typeof freezeForFork>;
    try { frozen = freezeForFork(session.manifest); } catch { throw new HttpError(409, "Ta séance en ligne est vide : mets-la en ligne à nouveau.", { code: "empty" }); }
    const now = new Date().toISOString();
    for (let i = 0; i < 4; i++) {
      const token = randomToken(TOKEN_LEN, TOKEN_ALPHABET);
      const row: ForkRow = {
        id: randomToken(16, "abcdefghijklmnopqrstuvwxyz0123456789"), session_id: session.id, token, token_hash: await sha256(token),
        label: String(body?.label || "").replace(/\s+/g, " ").trim().slice(0, 60),
        name: String(body?.name || session.name || "Séance").replace(/\s+/g, " ").trim().slice(0, 80) || "Séance",
        manifest: frozen.manifest, version: session.version, created_by: user.id, created_at: now,
        revoked_at: null, copies: 0, last_copy_at: null,
      };
      const { error } = await supabase.from("daw_session_forks").insert(row);
      if (!error) return { link: linkView(row), catalog_tracks: frozen.catalogTracks, removed_files: frozen.removedFiles.length };
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
