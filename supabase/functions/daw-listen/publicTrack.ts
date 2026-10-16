// Lot 9b (1.5.1) · Page PUBLIQUE d'un morceau : lecteur, pochette, crédits, paroles en option,
// lecteur intégrable (<iframe>) et bouton « Réserver une session au studio Make Music ».
//
// Part du lien d'écoute (même fonction daw-listen), avec trois différences :
//  - la page est PUBLIQUE (pas de jeton secret : un identifiant court dans l'adresse) ;
//  - la publication est un CHOIX EXPLICITE du propriétaire de la séance, désactivable à tout
//    moment (la page répond alors 410 « n'est plus publié ») ;
//  - elle ne donne QUE le son publié : l'extrait (30 s) ou le mix, jamais les pistes séparées,
//    et aucun bouton de téléchargement (liens d'écoute signés, valables 1 h).
//
// Droits : le morceau ENTIER (« mix ») ne se publie que si son export est débloqué (mêmes
// règles que l'export : admin, licence de toutes les instrus du catalogue sans kits NOVA,
// Nova Pro, ou projet payé) ; sinon seul l'extrait de 30 s (la sortie audio du gratuit) passe,
// et le serveur borne sa taille. Une instru du catalogue non achetée bloque le mix entier.
//
// Table : nova_public_tracks (D:\1 WORK\CONTENU\nova-151\serveur\invite_copie_151.sql ; RLS
// sans policy : accès par cette fonction seulement, clé service). Une page par séance ; la
// séance supprimée emporte sa page (on delete cascade).

import { decisionExport, statutPro, isAdmin, type ElementCatalogue } from "../_shared/novaTarifs.ts";

export const PUBLIC_ID_RE = /^[a-z0-9]{10}$/;
const PART_RE = /^[a-f0-9]{40}$/;
const BUCKET = "daw-sessions";
const SIGNED_TTL_S = 3600;
/** Extrait : 30 s (grille), marge d'une seconde ; en MP3 ≤ 320 kb/s, 1,5 Mo au plus. */
export const EXTRAIT_MAX_S = 31;
export const EXTRAIT_MAX_BYTES = 1_500_000;
export const MIX_MAX_S = 15 * 60;
export const MIX_MAX_BYTES = 60_000_000;
export const BOOKING_URL = "https://www.studiomakemusic.com/reservation?utm_source=nova&utm_medium=page_publique";
const MIMES = ["audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/webm", "audio/wav"];
const PROJECT_RE = /^[A-Za-z0-9_.:-]{6,80}$/;
const CATALOG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type PublicKind = "mix" | "extrait";
export interface PublicRow {
  id: string; session_id: string; owner_id: string; title: string; artist: string; credits: string;
  lyrics: string; show_lyrics: boolean; kind: PublicKind;
  audio: { parts: string[]; size: number; duration: number; mime: string };
  cover_part: string | null; published: boolean; created_at: string; updated_at: string;
  unpublished_at: string | null; plays: number | null;
}

export class PublicError extends Error { constructor(public status: number, msg: string, public extra?: Record<string, unknown>) { super(msg); } }

const clean = (v: unknown, max: number) => String(v ?? "").replace(/\r\n/g, "\n").replace(/[^\S\n]+/g, " ").trim().slice(0, max);

/** Validation PURE de ce que le propriétaire publie (testée sans base). */
export function validatePublish(body: any): {
  title: string; artist: string; credits: string; lyrics: string; show_lyrics: boolean; kind: PublicKind;
  audio: PublicRow["audio"]; cover_part: string | null;
} {
  const title = clean(body?.title, 80);
  if (!title) throw new PublicError(400, "Donne un titre au morceau.", { code: "title" });
  const kind: PublicKind = body?.kind === "mix" ? "mix" : body?.kind === "extrait" ? "extrait" : (() => { throw new PublicError(400, "Choisis l'extrait ou le morceau entier.", { code: "kind" }); })();
  const a = body?.audio || {};
  const parts = Array.isArray(a.parts) ? a.parts.filter((p: unknown) => typeof p === "string" && PART_RE.test(p as string)) : [];
  if (!parts.length || parts.length !== (a.parts || []).length || parts.length > 10) throw new PublicError(400, "Son du morceau manquant ou abîmé : réessaie.", { code: "audio" });
  const duration = Number(a.duration);
  const size = Number(a.size);
  const max = kind === "extrait" ? EXTRAIT_MAX_S : MIX_MAX_S;
  if (!Number.isFinite(duration) || duration <= 0 || duration > max) {
    throw new PublicError(400, kind === "extrait" ? "L'extrait dure 30 secondes au plus." : "Le morceau dure 15 minutes au plus.", { code: "duration" });
  }
  if (!Number.isFinite(size) || size <= 0 || size > (kind === "extrait" ? EXTRAIT_MAX_BYTES : MIX_MAX_BYTES)) throw new PublicError(400, "Fichier trop lourd pour la page publique.", { code: "size" });
  const mime = MIMES.includes(String(a.mime)) ? String(a.mime) : "audio/mpeg";
  const cover = typeof body?.cover_part === "string" && PART_RE.test(body.cover_part) ? body.cover_part : null;
  return {
    title, artist: clean(body?.artist, 60), credits: clean(body?.credits, 500), lyrics: clean(body?.lyrics, 5000),
    show_lyrics: body?.show_lyrics === true && !!clean(body?.lyrics, 5000), kind, audio: { parts, size: Math.round(size), duration: Math.round(duration * 100) / 100, mime }, cover_part: cover,
  };
}

/** Ce que voit le visiteur (jamais l'identifiant de la séance, du compte, ni les pistes). */
export function publicView(r: PublicRow, urls: string[], coverUrl: string | null) {
  return {
    id: r.id, title: r.title, artist: r.artist || "", credits: r.credits || "",
    lyrics: r.show_lyrics ? r.lyrics || "" : "", kind: r.kind,
    duration: r.audio.duration, mime: r.audio.mime, urls, cover_url: coverUrl,
    booking_url: BOOKING_URL, plays: r.plays || 0, updated_at: r.updated_at,
  };
}

/** Ce que voit le propriétaire dans NOVA. */
export const ownerView = (r: PublicRow) => ({
  id: r.id, title: r.title, artist: r.artist || "", credits: r.credits || "", lyrics: r.lyrics || "", show_lyrics: !!r.show_lyrics,
  kind: r.kind, duration: r.audio?.duration || 0, published: !!r.published, plays: r.plays || 0,
  created_at: r.created_at, updated_at: r.updated_at, unpublished_at: r.unpublished_at || null,
});

// deno-lint-ignore no-explicit-any
type Sb = any;
type User = { id: string; email?: string };
type Session = { id: string; owner_id: string | null; name: string };

/** Ids du catalogue présents dans le projet en ligne de la séance (pistes avec instrumentId). */
function catalogIdsOf(project: any): string[] {
  const ids = new Set<string>();
  for (const t of Array.isArray(project?.tracks) ? project.tracks : []) {
    const id = t?.instrumentId;
    if (id !== undefined && id !== null && id !== "" && CATALOG_ID_RE.test(String(id))) ids.add(String(id));
  }
  return [...ids];
}

/** Le morceau entier peut-il être publié ? Mêmes règles que l'export (nova-billing). */
async function mixAllowed(sb: Sb, user: User, sessionId: string, body: any): Promise<{ ok: boolean; reason?: string }> {
  const { data: s } = await sb.from("daw_sessions").select("manifest").eq("id", sessionId).maybeSingle();
  const ids = catalogIdsOf(s?.manifest?.project);
  const admin = await isAdmin(sb, user.id);
  let owned = new Set<string>();
  if (ids.length) {
    const { data } = await sb.from("instrumental_purchases").select("instrumental_id").eq("user_id", user.id);
    owned = new Set(((data || []) as any[]).map(r => String(r.instrumental_id)));
  }
  const catalogue: ElementCatalogue[] = ids.map(id => ({ id, owned: owned.has(id) }));
  const pro = admin ? true : (await statutPro(sb, user.id, user.email)).active;
  const key = String(body?.export_key || "");
  let paye = false;
  if (PROJECT_RE.test(key) && key !== "proj-1") {
    const { data } = await sb.from("nova_purchases").select("checkout_session_id").eq("project_key", key).eq("user_id", user.id).limit(1);
    paye = !!data?.length;
  }
  const d = decisionExport({ admin, pro, projetPaye: paye, catalogue, kits: body?.kits === true, portee: "mix" });
  return d.unlocked ? { ok: true } : { ok: false, reason: d.reason };
}

const randomId = () => {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const limit = 256 - (256 % a.length);
  let out = "";
  while (out.length < 10) for (const b of crypto.getRandomValues(new Uint8Array(20))) { if (b < limit && out.length < 10) out += a[b % a.length]; }
  return out;
};

/** Toutes les actions de la page publique. null : pas une action d'ici. */
export async function handlePublic(
  action: string, body: any, user: User | null, sb: Sb,
  authorizeSession: (id: unknown, secret: unknown, user: User | null) => Promise<Session>,
): Promise<unknown | null> {
  if (action === "public_open") {
    const id = String(body?.page || "");
    const unknown = () => new PublicError(404, "Ce morceau n'existe pas (ou plus) : vérifie le lien.", { code: "unknown" });
    if (!PUBLIC_ID_RE.test(id)) throw unknown();
    const { data, error } = await sb.from("nova_public_tracks").select("*").eq("id", id).maybeSingle();
    if (error) throw new PublicError(500, error.message);
    const r = data as PublicRow | null;
    if (!r) throw unknown();
    if (!r.published) throw new PublicError(410, "Ce morceau n'est plus publié par son auteur.", { code: "unpublished" });
    const { data: signed, error: e2 } = await sb.storage.from(BUCKET).createSignedUrls(r.audio.parts.map(p => `${r.session_id}/${p}`), SIGNED_TTL_S);
    if (e2) throw new PublicError(500, e2.message);
    const urls = ((signed || []) as { signedUrl?: string }[]).map(d => d?.signedUrl || "");
    if (urls.some(u => !u)) throw new PublicError(410, "Le son de ce morceau n'est plus en ligne.", { code: "gone" });
    let coverUrl: string | null = null;
    if (r.cover_part) {
      const { data: c } = await sb.storage.from(BUCKET).createSignedUrls([`${r.session_id}/${r.cover_part}`], SIGNED_TTL_S);
      coverUrl = c?.[0]?.signedUrl || null;
    }
    if (!body?.refresh) await sb.from("nova_public_tracks").update({ plays: (r.plays || 0) + 1 }).eq("id", r.id);
    return publicView({ ...r, plays: (r.plays || 0) + (body?.refresh ? 0 : 1) }, urls, coverUrl);
  }

  if (action !== "public_get" && action !== "public_publish" && action !== "public_set") return null;
  if (!user) throw new PublicError(401, "Connecte-toi à ton compte Make Music pour publier ton morceau");
  const session = await authorizeSession(body?.id, body?.secret, user);
  if (session.owner_id !== user.id) throw new PublicError(403, "Seul le propriétaire de la séance peut publier ce morceau.", { code: "not_owner" });
  const { data: cur } = await sb.from("nova_public_tracks").select("*").eq("session_id", session.id).maybeSingle();
  const existing = cur as PublicRow | null;

  if (action === "public_get") return { page: existing ? ownerView(existing) : null };

  if (action === "public_set") {
    if (!existing) throw new PublicError(404, "Ce morceau n'est pas encore publié.", { code: "none" });
    const on = body?.published === true;
    const patch = { published: on, unpublished_at: on ? null : new Date().toISOString(), updated_at: new Date().toISOString() };
    const { error } = await sb.from("nova_public_tracks").update(patch).eq("id", existing.id);
    if (error) throw new PublicError(500, error.message);
    return { page: ownerView({ ...existing, ...patch }) };
  }

  // public_publish : choix explicite (case cochée par le propriétaire).
  if (body?.consent !== true) throw new PublicError(400, "Coche « Je publie ce morceau » : la page sera visible par tous ceux qui ont le lien.", { code: "consent" });
  const v = validatePublish(body);
  // Le son est déjà dans le dossier de la séance (envoyé par sign_upload de daw-session).
  const { data: listed, error: le } = await sb.storage.from(BUCKET).list(session.id, { limit: 1000 });
  if (le) throw new PublicError(500, le.message);
  const have = new Map(((listed || []) as any[]).map(o => [o.name, Number(o?.metadata?.size || 0)]));
  if (v.audio.parts.some(p => !have.has(p)) || (v.cover_part && !have.has(v.cover_part))) throw new PublicError(400, "Le son n'est pas encore arrivé sur le serveur : réessaie.", { code: "audio_missing" });
  const stored = v.audio.parts.reduce((s, p) => s + (have.get(p) || 0), 0);
  if (stored > (v.kind === "extrait" ? EXTRAIT_MAX_BYTES : MIX_MAX_BYTES)) throw new PublicError(400, v.kind === "extrait" ? "Un extrait fait 30 secondes au plus." : "Fichier trop lourd pour la page publique.", { code: "size" });
  if (v.kind === "mix") {
    const m = await mixAllowed(sb, user, session.id, body);
    if (!m.ok) {
      throw new PublicError(403, m.reason === "catalogue_non_achete"
        ? "L'instru du catalogue n'est pas achetée : le morceau entier ne peut pas être publié. Publie l'extrait de 30 s, ou achète la licence."
        : "Le morceau entier se publie quand son export est débloqué (Nova Pro ou export du projet). En attendant, publie l'extrait de 30 s.", { code: "mix_locked", reason: m.reason || null });
    }
  }
  const now = new Date().toISOString();
  const row: PublicRow = {
    id: existing?.id || randomId(), session_id: session.id, owner_id: user.id, ...v,
    published: true, created_at: existing?.created_at || now, updated_at: now, unpublished_at: null, plays: existing?.plays || 0,
  };
  const q = existing ? sb.from("nova_public_tracks").update(row).eq("id", existing.id) : sb.from("nova_public_tracks").insert(row);
  const { error } = await q;
  if (error) throw new PublicError(500, error.message);
  return { page: ownerView(row) };
}
