import type { CollabRole } from '../types';

/**
 * Chantier 11 · Commentaires horodatés sur la timeline (« 1:12 le "s" siffle »).
 * Le « Frame.io de la musique » : l'artiste (au téléphone) ou l'ingé pose un
 * commentaire à un instant ou sur une plage ; on y répond, on le résout, on
 * l'archive. Tout passe par le canal de collaboration (opération « comments »)
 * et tout est enregistré dans le projet (DAWState.timelineComments).
 *
 * Convergence sans serveur d'arbitrage : chaque commentaire est un petit état
 * fusionnable (CRDT à base d'états). Chaque champ modifiable est un registre
 * « le plus récent gagne » horodaté par une horloge hybride (heure + compteur +
 * auteur) ; les réponses sont un ensemble qui ne fait que grandir (une réponse
 * effacée garde sa place, marquée effacée). La fusion est commutative,
 * associative et idempotente : deux personnes qui commentent en même temps,
 * hors ligne, dans n'importe quel ordre d'arrivée, avec des doublons, finissent
 * avec le MÊME état. Un envoi porte l'état complet du commentaire touché.
 *
 * Module pur : tests/timelineComments.test.ts.
 */

// ─── Horloge hybride ───────────────────────────────────────────────────────────

/** Horodatage d'une modification : heure (ms), compteur, auteur (clé de participant). */
export interface Stamp { t: number; c: number; by: string }
/** Registre « le plus récent gagne ». */
export interface Reg<T> { v: T; s: Stamp }

const ZERO: Stamp = { t: 0, c: 0, by: '' };

/** Ordre total des horodatages (heure, puis compteur, puis auteur). */
export function cmpStamp(a: Stamp, b: Stamp): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.c !== b.c) return a.c < b.c ? -1 : 1;
  return a.by < b.by ? -1 : a.by > b.by ? 1 : 0;
}

/** Ordre total des registres : horodatage, puis valeur (deux registres identiques sont égaux). */
function cmpReg<T>(a: Reg<T>, b: Reg<T>): number {
  const c = cmpStamp(a.s, b.s);
  if (c) return c;
  const ja = JSON.stringify(a.v), jb = JSON.stringify(b.v);
  return ja < jb ? -1 : ja > jb ? 1 : 0;
}

export function mergeReg<T>(a: Reg<T> | undefined, b: Reg<T> | undefined): Reg<T> | undefined {
  if (!a) return b;
  if (!b) return a;
  return cmpReg(a, b) >= 0 ? a : b;
}

/**
 * Horloge hybride (Lamport + heure) : une modification faite APRÈS en avoir vu
 * une autre porte toujours un horodatage plus grand, même si l'heure de
 * l'appareil retarde. `observe` à chaque réception.
 */
export class HybridClock {
  private last: Stamp = ZERO;
  constructor(public by: string, private now: () => number = () => Date.now()) {}
  tick(): Stamp {
    const wall = Math.floor(this.now());
    const t = Math.max(wall, this.last.t);
    const c = t === this.last.t ? this.last.c + 1 : 0;
    this.last = { t, c, by: this.by };
    return this.last;
  }
  observe(s: Stamp | undefined) {
    if (!s || !Number.isFinite(s.t)) return;
    if (s.t > this.last.t || (s.t === this.last.t && s.c > this.last.c)) this.last = { t: s.t, c: s.c, by: this.by };
  }
  peek(): Stamp { return this.last; }
}

// ─── Modèle ────────────────────────────────────────────────────────────────────

export type CommentStatus = 'open' | 'resolved';

export interface CommentReply {
  id: string;
  authorKey: string;
  authorName: string;
  role?: CollabRole | null;
  createdAt: number;
  text: Reg<string>;
  deleted?: Reg<boolean>;
}

export interface TimelineComment {
  id: string;
  /** Auteur (clé de participant « u:<compte> », « local » hors collaboration). */
  authorKey: string;
  authorName: string;
  role?: CollabRole | null;
  createdAt: number;
  /** Instant (s) et fin de la plage (null : un instant). */
  pos: Reg<{ t: number; end: number | null }>;
  /** Piste visée (facultatif). */
  trackId?: string | null;
  text: Reg<string>;
  status: Reg<{ s: CommentStatus; by?: string; at?: number }>;
  archived: Reg<boolean>;
  /** Réponses, dans l'ordre (date, puis identifiant). */
  replies: CommentReply[];
}

export const COMMENTS_KIND = 'comments';
export const MAX_COMMENT_TEXT = 1000;
export const MAX_REPLIES = 200;
export const MAX_COMMENTS = 500;

export const cleanText = (s: unknown): string => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, MAX_COMMENT_TEXT);

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export const newCommentId = (prefix = 'cm'): string => {
  try { if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}-${(crypto as Crypto).randomUUID()}`; } catch { /* */ }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

// ─── Gestes ────────────────────────────────────────────────────────────────────

export interface Author { key: string; name: string; role?: CollabRole | null }

export function createComment(input: { id?: string; time: number; end?: number | null; text: string; trackId?: string | null }, who: Author, clock: HybridClock): TimelineComment {
  const s = clock.tick();
  const t = r6(Math.max(0, input.time));
  const end = finite(input.end) && input.end > t + 1e-3 ? r6(input.end) : null;
  return {
    id: input.id || newCommentId(),
    authorKey: who.key, authorName: who.name.slice(0, 60), role: who.role ?? null, createdAt: s.t,
    pos: { v: { t, end }, s },
    ...(input.trackId ? { trackId: input.trackId } : {}),
    text: { v: cleanText(input.text), s },
    status: { v: { s: 'open' }, s },
    archived: { v: false, s },
    replies: [],
  };
}

export function addReply(c: TimelineComment, text: string, who: Author, clock: HybridClock, id = newCommentId('rp')): TimelineComment {
  const s = clock.tick();
  const r: CommentReply = { id, authorKey: who.key, authorName: who.name.slice(0, 60), role: who.role ?? null, createdAt: s.t, text: { v: cleanText(text), s } };
  return { ...c, replies: sortReplies([...c.replies, r]).slice(-MAX_REPLIES) };
}

export function setStatus(c: TimelineComment, status: CommentStatus, who: Author, clock: HybridClock): TimelineComment {
  const s = clock.tick();
  return { ...c, status: { v: status === 'resolved' ? { s: 'resolved', by: who.name.slice(0, 60), at: s.t } : { s: 'open', by: who.name.slice(0, 60), at: s.t }, s } };
}

export function setArchived(c: TimelineComment, archived: boolean, clock: HybridClock): TimelineComment {
  return { ...c, archived: { v: archived, s: clock.tick() } };
}

export function editText(c: TimelineComment, text: string, clock: HybridClock): TimelineComment {
  return { ...c, text: { v: cleanText(text), s: clock.tick() } };
}

export function movePos(c: TimelineComment, time: number, end: number | null, clock: HybridClock): TimelineComment {
  const t = r6(Math.max(0, time));
  return { ...c, pos: { v: { t, end: finite(end) && end > t + 1e-3 ? r6(end) : null }, s: clock.tick() } };
}

// ─── Fusion ────────────────────────────────────────────────────────────────────

const replyKey = (r: CommentReply) => `${String(r.createdAt).padStart(15, '0')}|${r.id}`;
const sortReplies = (l: CommentReply[]) => [...l].sort((a, b) => (replyKey(a) < replyKey(b) ? -1 : replyKey(a) > replyKey(b) ? 1 : 0));

/** Champs fixes (auteur, date) : identiques partout ; en cas de désaccord, choix déterministe. */
function pickFixed<T extends { authorKey: string; authorName: string; createdAt: number }>(a: T, b: T): T {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? a : b;
  if (a.authorKey !== b.authorKey) return a.authorKey < b.authorKey ? a : b;
  return a.authorName <= b.authorName ? a : b;
}

function mergeReply(a: CommentReply, b: CommentReply): CommentReply {
  const f = pickFixed(a, b);
  const out: CommentReply = { id: a.id, authorKey: f.authorKey, authorName: f.authorName, role: f.role ?? null, createdAt: f.createdAt, text: mergeReg(a.text, b.text)! };
  const del = mergeReg(a.deleted, b.deleted);
  if (del) out.deleted = del;
  return out;
}

/** Fusion de deux états du même commentaire (commutative, associative, idempotente). */
export function mergeComment(a: TimelineComment, b: TimelineComment): TimelineComment {
  const f = pickFixed(a, b);
  const replies = new Map<string, CommentReply>();
  for (const r of [...a.replies, ...b.replies]) {
    const cur = replies.get(r.id);
    replies.set(r.id, cur ? mergeReply(cur, r) : r);
  }
  const trackId = a.trackId ?? b.trackId ?? null;
  return {
    id: a.id, authorKey: f.authorKey, authorName: f.authorName, role: f.role ?? null, createdAt: f.createdAt,
    pos: mergeReg(a.pos, b.pos)!,
    ...(trackId ? { trackId: a.trackId && b.trackId ? (a.trackId <= b.trackId ? a.trackId : b.trackId) : trackId } : {}),
    text: mergeReg(a.text, b.text)!,
    status: mergeReg(a.status, b.status)!,
    archived: mergeReg(a.archived, b.archived)!,
    replies: sortReplies([...replies.values()]).slice(-MAX_REPLIES),
  };
}

/** Empreinte stable d'un commentaire (deux états identiques → même empreinte). */
export const commentSig = (c: TimelineComment): string => JSON.stringify(canonical(c));

function canonical(c: TimelineComment) {
  return {
    id: c.id, a: c.authorKey, n: c.authorName, r: c.role ?? null, at: c.createdAt, p: c.pos, tr: c.trackId ?? null,
    x: c.text, st: c.status, ar: c.archived,
    rp: sortReplies(c.replies).map(r => ({ id: r.id, a: r.authorKey, n: r.authorName, r: r.role ?? null, at: r.createdAt, x: r.text, d: r.deleted ?? null })),
  };
}

/** Ordre d'affichage : position sur la timeline, puis date, puis identifiant. */
export function sortComments(list: TimelineComment[]): TimelineComment[] {
  return [...list].sort((a, b) => a.pos.v.t - b.pos.v.t || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface MergeResult {
  list: TimelineComment[];
  /** Commentaires nouveaux ici (jamais vus). */
  added: TimelineComment[];
  /** Commentaires déjà connus dont l'état a changé. */
  changed: TimelineComment[];
}

/** Fusionne des états reçus dans la liste locale. */
export function mergeComments(local: TimelineComment[] | undefined, incoming: TimelineComment[]): MergeResult {
  const map = new Map<string, TimelineComment>();
  for (const c of local || []) map.set(c.id, map.has(c.id) ? mergeComment(map.get(c.id)!, c) : c);
  const added: TimelineComment[] = [];
  const changed: TimelineComment[] = [];
  for (const inc of incoming) {
    const cur = map.get(inc.id);
    if (!cur) { map.set(inc.id, inc); added.push(inc); continue; }
    const m = mergeComment(cur, inc);
    if (commentSig(m) !== commentSig(cur)) { map.set(inc.id, m); changed.push(m); }
  }
  let list = sortComments([...map.values()]);
  // Borne : on garde les plus récents (les archivés partent d'abord).
  if (list.length > MAX_COMMENTS) {
    const keep = new Set([...list].sort((a, b) => (Number(a.archived.v) - Number(b.archived.v)) || b.createdAt - a.createdAt).slice(0, MAX_COMMENTS).map(c => c.id));
    list = list.filter(c => keep.has(c.id));
  }
  return { list, added, changed };
}

// ─── Réception : vérification ──────────────────────────────────────────────────

function stamp(raw: unknown): Stamp | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!finite(s.t) || !finite(s.c) || typeof s.by !== 'string') return null;
  return { t: s.t, c: s.c, by: s.by.slice(0, 120) };
}
function reg<T>(raw: unknown, val: (v: unknown) => T | undefined): Reg<T> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const s = stamp(r.s);
  const v = val(r.v);
  return s && v !== undefined ? { v, s } : null;
}
const asText = (v: unknown) => (typeof v === 'string' ? cleanText(v) : undefined);
const asBool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const asRole = (v: unknown): CollabRole | null => (v === 'artist' || v === 'engineer' || v === 'beatmaker' ? v : null);
const asPos = (v: unknown) => {
  if (!v || typeof v !== 'object') return undefined;
  const p = v as Record<string, unknown>;
  if (!finite(p.t) || p.t < 0 || p.t > 24 * 3600) return undefined;
  const end = finite(p.end) && p.end > p.t ? Math.min(p.end, 24 * 3600) : null;
  return { t: p.t, end };
};
const asStatus = (v: unknown) => {
  if (!v || typeof v !== 'object') return undefined;
  const s = v as Record<string, unknown>;
  if (s.s !== 'open' && s.s !== 'resolved') return undefined;
  const out: { s: CommentStatus; by?: string; at?: number } = { s: s.s };
  if (typeof s.by === 'string') out.by = s.by.slice(0, 60);
  if (finite(s.at)) out.at = s.at;
  return out;
};
const idOk = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 80;

function sanitizeReply(raw: unknown): CommentReply | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = reg(r.text, asText);
  if (!idOk(r.id) || typeof r.authorKey !== 'string' || !finite(r.createdAt) || !text) return null;
  const out: CommentReply = { id: r.id, authorKey: r.authorKey.slice(0, 120), authorName: String(r.authorName || '?').slice(0, 60), role: asRole(r.role), createdAt: r.createdAt, text };
  const del = reg(r.deleted, asBool);
  if (del) out.deleted = del;
  return out;
}

/** Commentaire reçu vérifié (null : illisible, ignoré). */
export function sanitizeComment(raw: unknown): TimelineComment | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (!idOk(c.id) || typeof c.authorKey !== 'string' || !finite(c.createdAt)) return null;
  const pos = reg(c.pos, asPos), text = reg(c.text, asText), status = reg(c.status, asStatus), archived = reg(c.archived, asBool);
  if (!pos || !text || !status || !archived) return null;
  const replies = (Array.isArray(c.replies) ? c.replies : []).slice(0, MAX_REPLIES).map(sanitizeReply).filter(Boolean) as CommentReply[];
  return {
    id: c.id, authorKey: c.authorKey.slice(0, 120), authorName: String(c.authorName || '?').slice(0, 60), role: asRole(c.role), createdAt: c.createdAt,
    pos, ...(typeof c.trackId === 'string' && c.trackId ? { trackId: c.trackId.slice(0, 80) } : {}),
    text, status, archived, replies: sortReplies(replies),
  };
}

/**
 * Droits, à la réception (chez tout le monde) : tout participant commente,
 * répond, résout et archive (l'artiste invité aussi). Les mots d'un
 * commentaire ou d'une réponse ne peuvent être changés que par leur auteur :
 * un registre de texte horodaté par quelqu'un d'autre est neutralisé (valeur
 * vide, horodatage zéro : la version de l'auteur l'emporte toujours). La règle
 * ne dépend pas de ce qu'on a déjà : tout le monde fait la même chose (convergence).
 */
export function enforceAuthorship(c: TimelineComment): TimelineComment {
  const out = { ...c };
  if (c.text.s.by !== c.authorKey) out.text = { v: '', s: ZERO };
  out.replies = c.replies.map(r => (r.text.s.by === r.authorKey ? r : { ...r, text: { v: '', s: ZERO } }));
  return out;
}

/** Lit l'opération « comments » reçue : { upsert: TimelineComment[] }. */
export function readCommentsOp(op: unknown): TimelineComment[] {
  const p = op && typeof op === 'object' ? op as Record<string, unknown> : {};
  const list = Array.isArray(p.upsert) ? p.upsert.slice(0, 100) : [];
  return list.map(sanitizeComment).filter(Boolean).map(c => enforceAuthorship(c!));
}

/** Plus grand horodatage d'un commentaire (pour garder l'horloge en avance). */
export function maxStamp(c: TimelineComment): Stamp {
  let m = c.pos.s;
  for (const s of [c.text.s, c.status.s, c.archived.s, ...c.replies.flatMap(r => [r.text.s, ...(r.deleted ? [r.deleted.s] : [])])]) if (cmpStamp(s, m) > 0) m = s;
  return m;
}

// ─── Affichage ─────────────────────────────────────────────────────────────────

/** « 1:12 », « 1:12,5 » (au dixième quand ce n'est pas une seconde ronde). */
export function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const whole = Math.floor(r + 1e-6);
  const tenth = Math.round((r - whole) * 10);
  return `${m}:${String(whole).padStart(2, '0')}${tenth > 0 && tenth < 10 ? `,${tenth}` : ''}`;
}

export const posLabel = (c: Pick<TimelineComment, 'pos'>) => (c.pos.v.end !== null ? `${fmtTime(c.pos.v.t)} → ${fmtTime(c.pos.v.end)}` : fmtTime(c.pos.v.t));

export type CommentFilter = 'open' | 'resolved' | 'archived';

export function filterComments(list: TimelineComment[], f: CommentFilter): TimelineComment[] {
  return list.filter(c => (f === 'archived' ? c.archived.v : !c.archived.v && c.status.v.s === f));
}

export function commentCounts(list: TimelineComment[] | undefined): Record<CommentFilter, number> {
  const out = { open: 0, resolved: 0, archived: 0 };
  for (const c of list || []) {
    if (c.archived.v) out.archived++;
    else if (c.status.v.s === 'resolved') out.resolved++;
    else out.open++;
  }
  return out;
}

export const visibleReplies = (c: TimelineComment) => c.replies.filter(r => !r.deleted?.v);
