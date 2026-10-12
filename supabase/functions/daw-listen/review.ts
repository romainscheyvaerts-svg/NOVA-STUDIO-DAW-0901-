// Lien d'écoute client : vue PUBLIQUE, en lecture seule, des commentaires
// horodatés et des versions envoyées / validées d'une séance.
//
// Les commentaires et les versions voyagent dans le journal de la collaboration
// (daw_session_ops, opérations « comments » et « mixver », chacune porte l'état
// complet de ce qu'elle touche : { upsert: [...] }) et dans le projet
// (manifest.project.timelineComments / mixVersions). Chaque champ modifiable est
// un registre « le plus récent gagne » horodaté { v, s: { t, c, by } } (voir
// utils/timelineComments.ts et utils/mixVersions.ts dans NOVA).
//
// Ici on fusionne ces états de façon tolérante (une donnée mal formée est
// ignorée, jamais d'exception) et on ne garde que ce qu'un client a le droit de
// voir : ni clé de participant, ni piste, ni commentaire archivé ou réponse effacée.
//
// Module pur (aucun import) : testé par supabase/tests/daw-listen.test.ts.

export interface PublicReply { author: string; text: string; at: number }
export interface PublicComment {
  id: string;
  /** Instant (s) et fin de la plage (null : un instant). */
  t: number;
  end: number | null;
  text: string;
  author: string;
  role: string | null;
  status: "open" | "resolved";
  created_at: number;
  replies: PublicReply[];
}
export interface PublicVersion {
  id: string;
  n: number;
  name: string;
  note: string | null;
  sent_at: number;
  sent_by: string;
  decision: { kind: "approved" | "changes"; by: string; at: number; comment: string | null } | null;
  /** Bounce du mix (morceaux SHA-1 dans le stockage de la séance) ; null : pas de rendu. */
  audio: { parts: string[]; size: number; duration: number } | null;
}

export const MAX_PUBLIC_COMMENTS = 300;
export const MAX_PUBLIC_REPLIES = 50;
export const MAX_PUBLIC_VERSIONS = 20;

type Stamp = { t: number; c: number; by: string };
type Reg<T = unknown> = { v: T; s: Stamp };

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const str = (x: unknown, max: number): string => (typeof x === "string" ? x.replace(/\r\n?/g, "\n").trim().slice(0, max) : "");
const PART_RE = /^[a-f0-9]{40}$/;

const stampOf = (r: unknown): Stamp | null => {
  const s = (r as any)?.s;
  if (!s || !finite(s.t)) return null;
  return { t: s.t, c: finite(s.c) ? s.c : 0, by: typeof s.by === "string" ? s.by : "" };
};
const cmpStamp = (a: Stamp, b: Stamp) => (a.t !== b.t ? (a.t < b.t ? -1 : 1) : a.c !== b.c ? (a.c < b.c ? -1 : 1) : a.by < b.by ? -1 : a.by > b.by ? 1 : 0);

/** Registre le plus récent (un registre sans horodatage lisible perd toujours). */
function pickReg(a: unknown, b: unknown): Reg | undefined {
  const sa = stampOf(a), sb = stampOf(b);
  if (!sa) return sb ? (b as Reg) : undefined;
  if (!sb) return a as Reg;
  const c = cmpStamp(sa, sb);
  if (c) return (c > 0 ? a : b) as Reg;
  return (JSON.stringify((a as Reg).v) >= JSON.stringify((b as Reg).v) ? a : b) as Reg;
}

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

function mergeComment(a: Record<string, any> | undefined, b: Record<string, any>): Record<string, any> {
  if (!a) return b;
  const out: Record<string, any> = { ...a };
  for (const k of ["pos", "text", "status", "archived"]) out[k] = pickReg(a[k], b[k]);
  const replies = new Map<string, Record<string, any>>();
  for (const r of [...(Array.isArray(a.replies) ? a.replies : []), ...(Array.isArray(b.replies) ? b.replies : [])]) {
    if (!isObj(r) || typeof r.id !== "string") continue;
    const cur = replies.get(r.id);
    replies.set(r.id, cur ? { ...cur, text: pickReg(cur.text, r.text), deleted: pickReg(cur.deleted, r.deleted) } : r);
  }
  out.replies = [...replies.values()];
  return out;
}

function mergeVersion(a: Record<string, any> | undefined, b: Record<string, any>): Record<string, any> {
  if (!a) return b;
  return { ...a, decision: pickReg(a.decision, b.decision) };
}

/** Éléments d'une opération ({ upsert: [...] }) ou d'une liste du projet. */
const itemsOf = (x: unknown): Record<string, any>[] => {
  const list = Array.isArray(x) ? x : isObj(x) && Array.isArray(x.upsert) ? x.upsert : [];
  return list.filter((i: unknown) => isObj(i) && typeof (i as any).id === "string" && (i as any).id.length <= 80) as Record<string, any>[];
};

export interface ReviewSources {
  /** Projet de l'instantané en ligne (manifest.project) : peut être absent. */
  project?: unknown;
  /** Opérations du journal, dans l'ordre (seq croissant). */
  ops?: { kind: string; op: unknown }[];
}

/** États fusionnés (projet puis journal). */
export function collectReview(src: ReviewSources): { comments: Map<string, Record<string, any>>; versions: Map<string, Record<string, any>> } {
  const comments = new Map<string, Record<string, any>>();
  const versions = new Map<string, Record<string, any>>();
  const addC = (i: Record<string, any>) => { try { comments.set(i.id, mergeComment(comments.get(i.id), i)); } catch { /* ignoré */ } };
  const addV = (i: Record<string, any>) => { try { versions.set(i.id, mergeVersion(versions.get(i.id), i)); } catch { /* ignoré */ } };
  const project = isObj(src.project) ? src.project : {};
  itemsOf(project.timelineComments).forEach(addC);
  itemsOf(project.mixVersions).forEach(addV);
  for (const o of src.ops || []) {
    if (o?.kind === "comments") itemsOf(o.op).forEach(addC);
    else if (o?.kind === "mixver") itemsOf(o.op).forEach(addV);
  }
  return { comments, versions };
}

export function publicComments(states: Iterable<Record<string, any>>): PublicComment[] {
  const out: PublicComment[] = [];
  for (const c of states) {
    try {
      if ((c.archived as Reg | undefined)?.v === true) continue;
      const pos = (c.pos as Reg<any> | undefined)?.v;
      if (!isObj(pos) || !finite(pos.t) || pos.t < 0) continue;
      const text = str((c.text as Reg | undefined)?.v, 1000);
      if (!text) continue;
      const st = (c.status as Reg<any> | undefined)?.v;
      const replies: PublicReply[] = (Array.isArray(c.replies) ? c.replies : [])
        .filter((r: any) => isObj(r) && r.deleted?.v !== true && str(r.text?.v, 1000))
        .sort((x: any, y: any) => (Number(x.createdAt) || 0) - (Number(y.createdAt) || 0))
        .slice(0, MAX_PUBLIC_REPLIES)
        .map((r: any) => ({ author: str(r.authorName, 60) || "?", text: str(r.text.v, 1000), at: finite(r.createdAt) ? r.createdAt : 0 }));
      out.push({
        id: c.id, t: pos.t, end: finite(pos.end) && pos.end > pos.t ? pos.end : null, text,
        author: str(c.authorName, 60) || "?", role: typeof c.role === "string" ? c.role.slice(0, 20) : null,
        status: st?.s === "resolved" ? "resolved" : "open", created_at: finite(c.createdAt) ? c.createdAt : 0, replies,
      });
    } catch { /* commentaire illisible : ignoré */ }
  }
  out.sort((a, b) => a.t - b.t || a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  return out.slice(0, MAX_PUBLIC_COMMENTS);
}

export function publicVersions(states: Iterable<Record<string, any>>): PublicVersion[] {
  const out: PublicVersion[] = [];
  for (const v of states) {
    try {
      if (!finite(v.n) || v.n < 1) continue;
      const d = (v.decision as Reg<any> | undefined)?.v;
      const decision = isObj(d) && (d.kind === "approved" || d.kind === "changes")
        ? { kind: d.kind as "approved" | "changes", by: str(d.by, 60) || "?", at: finite(d.at) ? d.at : 0, comment: str(d.comment, 400) || null }
        : null;
      const a = v.audio;
      const parts = isObj(a) && Array.isArray(a.parts) ? a.parts.filter((p: unknown) => typeof p === "string" && PART_RE.test(p)) : [];
      out.push({
        id: v.id, n: Math.floor(v.n), name: str(v.name, 80) || `Version ${Math.floor(v.n)}`, note: str(v.note, 400) || null,
        sent_at: finite(v.sentAt) ? v.sentAt : 0, sent_by: str(v.sentBy, 60) || "?", decision,
        audio: parts.length && parts.length === (a.parts as unknown[]).length
          ? { parts, size: finite(a.size) ? a.size : 0, duration: finite(a.duration) ? a.duration : 0 } : null,
      });
    } catch { /* version illisible : ignorée */ }
  }
  // Les plus récentes d'abord.
  out.sort((a, b) => b.n - a.n || b.sent_at - a.sent_at);
  return out.slice(0, MAX_PUBLIC_VERSIONS);
}
