// « Envoyer au studio » (chantier 17 · B6 de la feuille de route) : NOVA
// regroupe le projet, les stems, les notes horodatées et une demande de
// réservation, et les dépose au studio Make Music.
//
// PAS DÉPLOYÉE : attend le GO de Romain (voir supabase/functions/README.md).
//
// Parcours (compte connecté obligatoire : le studio sait qui envoie) :
//  1. package_init   : NOVA annonce ses fichiers (type, nom, taille). La fonction
//                      vérifie les limites, crée le paquet (statut « envoi ») et
//                      rend une adresse d'envoi signée par fichier, dans le
//                      stockage privé « studio-packages » (<compte>/<paquet>/<nom>) ;
//  2. NOVA envoie chaque fichier directement au stockage (rien ne transite ici) ;
//     package_resign redonne des adresses (envoi interrompu, réseau coupé) ;
//  3. package_submit : la fonction vérifie que CHAQUE fichier est arrivé, à la
//                      bonne taille (sinon 409 + la liste des manquants : NOVA
//                      renvoie seulement ceux-là), crée la demande de réservation
//                      (statut « demande » : le studio confirme ensuite) et passe
//                      le paquet en « reçu ». Deux envois du même paquet (double
//                      clic, réponse perdue) rendent la MÊME réservation.
//  - package_status : où en est mon paquet ;
//  - studio_list    : la boîte du studio (comptes listés dans STUDIO_ADMIN_EMAILS),
//                     avec des liens de téléchargement signés (2 h).
//
// Aucun message n'est envoyé d'ici (ni mail, ni SMS, ni WhatsApp) : le studio
// voit les paquets dans sa boîte. Brancher une notification = décision à part.
//
// Tables : supabase/migrations/20261013120000_studio_packages.sql (RLS sans
// policy : accès par cette fonction seulement, clé service).

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { STUDIO_BUCKET, bookingReference, checkBooking, checkFiles, type FileDecl } from "./rules.ts";

const ID_RE = /^[a-z0-9]{12}$/;
const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";
/** Paquets en cours d'envoi en même temps, et par 24 h, pour un compte. */
const MAX_OPEN = 3;
const MAX_PER_DAY = 10;
/** Paquet jamais terminé : effacé (fichiers compris) après 48 h. */
const ABANDON_MS = 48 * 3600_000;
const DOWNLOAD_TTL_S = 7200;

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

class HttpError extends Error { constructor(public status: number, msg: string, public extra?: Record<string, unknown>) { super(msg); } }

export const randomId = (len = 12): string => {
  const limit = 256 - (256 % ID_ALPHABET.length);
  let out = "";
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b >= limit) continue;
      out += ID_ALPHABET[b % ID_ALPHABET.length];
      if (out.length === len) break;
    }
  }
  return out;
};

interface Caller { id: string; email?: string }

async function callerOf(req: Request): Promise<Caller | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token.split(".").length !== 3) return null;
  const { data } = await supabase.auth.getUser(token);
  return data?.user ? { id: data.user.id, email: data.user.email || undefined } : null;
}

const needUser = (u: Caller | null): Caller => {
  if (!u) throw new HttpError(401, "Connecte-toi à ton compte Make Music pour envoyer au studio.", { code: "login" });
  return u;
};

const studioAdmins = (): string[] => String(Deno.env.get("STUDIO_ADMIN_EMAILS") || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

interface PackageRow {
  id: string; user_id: string; email: string | null; status: "envoi" | "recu";
  title: string; files: (FileDecl & { path: string })[]; total_bytes: number;
  booking_id: string | null; created_at: string; received_at: string | null;
}

async function ownPackage(user: Caller, id: unknown): Promise<PackageRow> {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(400, "Paquet inconnu.");
  const { data } = await supabase.from("studio_packages").select("*").eq("id", id).maybeSingle();
  if (!data || data.user_id !== user.id) throw new HttpError(404, "Paquet introuvable (déjà effacé, ou envoyé depuis un autre compte).");
  return data as PackageRow;
}

async function signUploads(pkg: PackageRow, names?: string[]) {
  const want = names ? pkg.files.filter(f => names.includes(f.name)) : pkg.files;
  const uploads: { name: string; kind: string; path: string; token: string }[] = [];
  for (const f of want) {
    const { data, error } = await supabase.storage.from(STUDIO_BUCKET).createSignedUploadUrl(f.path, { upsert: true });
    if (error || !data) throw new HttpError(503, "Le stockage du studio ne répond pas : réessaie dans un instant.");
    uploads.push({ name: f.name, kind: f.kind, path: data.path || f.path, token: data.token });
  }
  return uploads;
}

/** Effacement des paquets abandonnés de ce compte (jamais terminés depuis 48 h). */
async function purgeAbandoned(user: Caller) {
  const { data } = await supabase.from("studio_packages").select("id,files,created_at,status").eq("user_id", user.id).eq("status", "envoi");
  const old = (data || []).filter((p: any) => Date.now() - Date.parse(p.created_at) > ABANDON_MS);
  for (const p of old) {
    const paths = (p.files || []).map((f: any) => f.path).filter(Boolean);
    if (paths.length) await supabase.storage.from(STUDIO_BUCKET).remove(paths);
    await supabase.from("studio_packages").delete().eq("id", p.id);
  }
}

const publicBooking = (b: any) => b && ({
  id: b.id, reference: b.reference, status: b.status, service: b.service, date: b.wished_date, slot: b.slot,
  hours: b.hours, name: b.artist_name, created_at: b.created_at,
});

async function handle(body: any, userOrNull: Caller | null) {
  const action = body?.action;

  if (action === "package_init") {
    const user = needUser(userOrNull);
    const files = checkFiles(body.files);
    if (!files.ok) throw new HttpError(400, files.error, { code: "files" });
    await purgeAbandoned(user);
    const { data: mine } = await supabase.from("studio_packages").select("id,status,created_at").eq("user_id", user.id);
    const list = mine || [];
    if (list.filter((p: any) => p.status === "envoi").length >= MAX_OPEN) {
      throw new HttpError(429, "Tu as déjà des envois en cours : termine-les (ou attends 48 h qu'ils s'effacent).", { code: "too_many_open" });
    }
    if (list.filter((p: any) => Date.now() - Date.parse(p.created_at) < 86400_000).length >= MAX_PER_DAY) {
      throw new HttpError(429, `${MAX_PER_DAY} envois par jour au plus : appelle le studio si c'est urgent.`, { code: "daily_limit" });
    }
    const id = randomId();
    const title = String(body.title || "").trim().slice(0, 80) || "Projet";
    const row = {
      id, user_id: user.id, email: user.email || null, status: "envoi", title,
      bpm: Number.isFinite(Number(body.bpm)) ? Math.round(Number(body.bpm)) : null,
      song_key: typeof body.key === "string" ? body.key.slice(0, 20) : null,
      notes_count: Number.isInteger(body.notes_count) ? Math.max(0, Math.min(10000, body.notes_count)) : 0,
      files: files.files.map(f => ({ ...f, path: `${user.id}/${id}/${f.name}` })),
      total_bytes: files.total, booking_id: null,
    };
    const { error } = await supabase.from("studio_packages").insert(row);
    if (error) throw new HttpError(503, "Le studio ne peut pas recevoir de paquet pour l'instant : réessaie.");
    const pkg = { ...row, created_at: new Date().toISOString(), received_at: null } as PackageRow;
    return { package_id: id, uploads: await signUploads(pkg), bucket: STUDIO_BUCKET };
  }

  if (action === "package_resign") {
    const user = needUser(userOrNull);
    const pkg = await ownPackage(user, body.package_id);
    if (pkg.status !== "envoi") throw new HttpError(409, "Ce paquet est déjà arrivé au studio.", { code: "already_received" });
    const names = Array.isArray(body.names) ? body.names.filter((n: unknown) => typeof n === "string") : undefined;
    return { package_id: pkg.id, uploads: await signUploads(pkg, names) };
  }

  if (action === "package_submit") {
    const user = needUser(userOrNull);
    const pkg = await ownPackage(user, body.package_id);
    if (pkg.status === "recu" && pkg.booking_id) {
      const { data: b } = await supabase.from("studio_booking_requests").select("*").eq("id", pkg.booking_id).maybeSingle();
      return { package_id: pkg.id, booking: publicBooking(b), already: true };
    }
    const booking = checkBooking(body.booking);
    if (!booking.ok) throw new HttpError(400, "La demande de réservation est incomplète.", { code: "booking", errors: booking.errors });
    // Chaque fichier annoncé doit être arrivé, à la bonne taille.
    const { data: stored, error: listErr } = await supabase.storage.from(STUDIO_BUCKET).list(`${user.id}/${pkg.id}`, { limit: 1000 });
    if (listErr) throw new HttpError(503, "Le stockage du studio ne répond pas : réessaie dans un instant.");
    const sizes = new Map((stored || []).map((o: any) => [o.name, Number(o.metadata?.size ?? o.metadata?.contentLength ?? -1)]));
    const missing = pkg.files.filter(f => sizes.get(f.name) !== f.size).map(f => f.name);
    if (missing.length) {
      throw new HttpError(409, `${missing.length} fichier(s) ne sont pas arrivés en entier au studio : NOVA les renvoie.`, { code: "missing", missing });
    }
    const bid = randomId();
    const v = booking.value;
    const row = {
      id: bid, package_id: pkg.id, user_id: user.id, email: user.email || null, reference: bookingReference(bid),
      service: v.service, wished_date: v.date, slot: v.slot, hours: v.hours, artist_name: v.name,
      phone: v.phone || null, message: v.message || null, status: "demande",
    };
    const { error } = await supabase.from("studio_booking_requests").insert(row);
    if (error) {
      // Deux envois en même temps du même paquet : la réservation existe déjà, on la rend.
      const { data: b } = await supabase.from("studio_booking_requests").select("*").eq("package_id", pkg.id).maybeSingle();
      if (b) return { package_id: pkg.id, booking: publicBooking(b), already: true };
      throw new HttpError(503, "Réservation impossible à enregistrer pour l'instant : réessaie (tes fichiers sont déjà au studio).");
    }
    await supabase.from("studio_packages").update({ status: "recu", booking_id: bid, received_at: new Date().toISOString() }).eq("id", pkg.id);
    const { data: saved } = await supabase.from("studio_booking_requests").select("*").eq("id", bid).maybeSingle();
    return { package_id: pkg.id, booking: publicBooking(saved || { ...row, created_at: new Date().toISOString() }) };
  }

  if (action === "package_status") {
    const user = needUser(userOrNull);
    const pkg = await ownPackage(user, body.package_id);
    let booking = null;
    if (pkg.booking_id) {
      const { data: b } = await supabase.from("studio_booking_requests").select("*").eq("id", pkg.booking_id).maybeSingle();
      booking = publicBooking(b);
    }
    return { package_id: pkg.id, status: pkg.status, title: pkg.title, files: pkg.files.map(f => ({ kind: f.kind, name: f.name, size: f.size })), booking };
  }

  if (action === "studio_list") {
    const user = needUser(userOrNull);
    if (!user.email || !studioAdmins().includes(user.email.toLowerCase())) throw new HttpError(403, "Réservé au studio.");
    const { data: pkgs } = await supabase.from("studio_packages").select("*").eq("status", "recu").order("received_at", { ascending: false }).limit(50);
    const out = [];
    for (const p of (pkgs || []) as PackageRow[]) {
      const { data: b } = p.booking_id ? await supabase.from("studio_booking_requests").select("*").eq("id", p.booking_id).maybeSingle() : { data: null };
      const { data: urls } = await supabase.storage.from(STUDIO_BUCKET).createSignedUrls(p.files.map(f => f.path), DOWNLOAD_TTL_S);
      out.push({
        package_id: p.id, title: p.title, from: p.email, received_at: p.received_at, total_bytes: p.total_bytes,
        files: p.files.map((f, i) => ({ kind: f.kind, name: f.name, size: f.size, url: urls?.[i]?.signedUrl || null })),
        booking: b ? { ...publicBooking(b), phone: (b as any).phone, message: (b as any).message } : null,
      });
    }
    return { packages: out };
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
    return new Response(JSON.stringify({ error: e instanceof HttpError ? e.message : "Erreur du serveur du studio : réessaie.", ...(extra || {}) }), { status, headers });
  }
});
