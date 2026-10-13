// Règles communes de « Envoyer au studio » (chantier 17 · B6), partagées par
// la fonction serveur studio-inbox (Deno) et par NOVA (utils/studioPackage) :
// une seule définition de ce qui est accepté, testée des deux côtés.
// Module pur : aucune API Deno ni navigateur.

export const STUDIO_BUCKET = "studio-packages";

/** Prestations qu'on peut demander au studio Make Music. */
export const STUDIO_SERVICES = [
  { id: "enregistrement", label: "Enregistrement avec un ingé son" },
  { id: "mix", label: "Mixage" },
  { id: "mix_master", label: "Mixage + mastering" },
  { id: "mastering", label: "Mastering" },
] as const;
export type StudioService = typeof STUDIO_SERVICES[number]["id"];

/** Moment de la journée souhaité. */
export const STUDIO_SLOTS = [
  { id: "matin", label: "Matin" },
  { id: "apres-midi", label: "Après-midi" },
  { id: "soir", label: "Soir" },
  { id: "flexible", label: "Peu importe" },
] as const;
export type StudioSlot = typeof STUDIO_SLOTS[number]["id"];

export type FileKind = "projet" | "stem" | "notes";

/** Limites d'un paquet. */
export const MAX_FILES = 80;
export const MAX_FILE_BYTES = 500 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_BOOKING_DAYS = 180;
export const MAX_MESSAGE = 1000;

export interface BookingInput {
  service: StudioService;
  /** Jour souhaité, AAAA-MM-JJ. */
  date: string;
  slot: StudioSlot;
  /** Durée souhaitée (heures). */
  hours: number;
  /** Nom d'artiste (affiché au studio). */
  name: string;
  /** Téléphone pour confirmer (facultatif). */
  phone?: string;
  message?: string;
}

export interface FileDecl { kind: FileKind; name: string; size: number }

/** Nom de fichier sûr (lettres, chiffres, . _ -), sans chemin, 120 caractères au plus. */
export function safeFileName(name: string): string {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const ascii = base.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const clean = ascii.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^[._]+/, "").slice(-120);
  return clean || "fichier";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^[+0-9 ().-]{6,24}$/;

/** Jour (AAAA-MM-JJ) en UTC, pour comparer sans fuseau. */
export const dayIndex = (d: string): number => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86400000);
export const todayIso = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);

/** Demande de réservation vérifiée : erreurs par champ, en phrases simples. */
export function checkBooking(raw: unknown, now = Date.now()): { ok: true; value: BookingInput } | { ok: false; errors: Record<string, string> } {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const service = STUDIO_SERVICES.find(s => s.id === b.service)?.id;
  if (!service) errors.service = "Choisis ce que tu veux faire au studio.";
  const slot = STUDIO_SLOTS.find(s => s.id === b.slot)?.id;
  if (!slot) errors.slot = "Choisis un moment de la journée (ou « Peu importe »).";
  const date = typeof b.date === "string" ? b.date : "";
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) errors.date = "Choisis le jour souhaité.";
  else {
    const delta = dayIndex(date) - dayIndex(todayIso(now));
    if (delta < 0) errors.date = "Ce jour est déjà passé : choisis une date à venir.";
    else if (delta > MAX_BOOKING_DAYS) errors.date = `Le studio prend les demandes jusqu'à ${MAX_BOOKING_DAYS} jours à l'avance.`;
  }
  const hours = Number(b.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 12) errors.hours = "Durée : de 1 à 12 heures.";
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) errors.name = "Ton nom d'artiste, pour que le studio sache qui vient.";
  else if (name.length > 60) errors.name = "Nom trop long (60 caractères au plus).";
  const phone = typeof b.phone === "string" ? b.phone.trim() : "";
  if (phone && !PHONE_RE.test(phone)) errors.phone = "Numéro illisible : chiffres, espaces et + seulement (ou laisse vide).";
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (message.length > MAX_MESSAGE) errors.message = `Message trop long (${MAX_MESSAGE} caractères au plus).`;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { service: service!, date, slot: slot!, hours, name, ...(phone ? { phone } : {}), ...(message ? { message } : {}) } };
}

/** Liste des fichiers annoncés vérifiée (noms rendus sûrs et uniques). */
export function checkFiles(raw: unknown): { ok: true; files: FileDecl[]; total: number } | { ok: false; error: string } {
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: "Paquet vide : il faut au moins le projet." };
  if (raw.length > MAX_FILES) return { ok: false, error: `Trop de fichiers (${raw.length}) : ${MAX_FILES} au plus. Regroupe les stems par bus.` };
  const seen = new Set<string>();
  const files: FileDecl[] = [];
  let total = 0;
  for (const f of raw) {
    const o = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
    const kind = o.kind === "projet" || o.kind === "stem" || o.kind === "notes" ? o.kind : null;
    const size = Number(o.size);
    if (!kind) return { ok: false, error: "Type de fichier inconnu." };
    if (!Number.isInteger(size) || size <= 0) return { ok: false, error: `Fichier vide : ${String(o.name || "?")}.` };
    if (size > MAX_FILE_BYTES) return { ok: false, error: `« ${String(o.name)} » dépasse ${MAX_FILE_BYTES / 1048576} Mo.` };
    let name = safeFileName(String(o.name || ""));
    for (let k = 2; seen.has(name.toLowerCase()); k++) name = name.replace(/(\.[A-Za-z0-9]+)?$/, `_${k}$1`);
    seen.add(name.toLowerCase());
    total += size;
    files.push({ kind, name, size });
  }
  if (!files.some(f => f.kind === "projet")) return { ok: false, error: "Le projet manque dans le paquet." };
  if (total > MAX_TOTAL_BYTES) return { ok: false, error: `Paquet trop lourd (${Math.round(total / 1048576)} Mo) : ${MAX_TOTAL_BYTES / 1073741824} Go au plus. Envoie sans les stems (le projet contient déjà toutes les pistes).` };
  return { ok: true, files, total };
}

/** Référence lisible donnée à l'artiste et au studio (« MM-7K2F9Q »). */
export const bookingReference = (id: string): string => `MM-${id.slice(0, 6).toUpperCase()}`;

export const serviceLabel = (id: string): string => STUDIO_SERVICES.find(s => s.id === id)?.label || id;
export const slotLabel = (id: string): string => STUDIO_SLOTS.find(s => s.id === id)?.label || id;
