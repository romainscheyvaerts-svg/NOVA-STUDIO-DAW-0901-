import type { CollabRole } from '../types';
import { cmpStamp, HybridClock, mergeReg, Reg, Stamp, cleanText, newCommentId } from './timelineComments';

/**
 * Chantier 11 · Versions envoyées / validées.
 *
 * L'ingé « envoie la version N » à l'artiste : un instantané NOMMÉ et daté du
 * mix. Pas de nouveau stockage : la version est
 *  - une référence au projet (numéro de version de session R21, empreinte de
 *    ce qui est partagé, durée) — la version nommée est aussi posée dans
 *    l'historique de l'appareil de l'ingé (utils/projectVersions) ;
 *  - et, quand le rendu a pu se faire, le bounce du mix (WAV) envoyé par le
 *    canal audio de la collaboration (morceaux SHA-1, jamais deux fois).
 * L'artiste écoute, puis « Valider » ou « Demander des retouches » (avec un
 * commentaire). L'historique dit « Version 3 validée par Nina le 12/10/2026 à 14:32 ».
 *
 * Même principe de convergence que les commentaires (utils/timelineComments) :
 * la version est fixe une fois envoyée (seul l'ingé la crée), la décision est
 * un registre « le plus récent gagne » (seul un artiste la pose). Voyage dans
 * l'opération « mixver » et dans le projet (DAWState.mixVersions).
 *
 * Module pur : tests/mixVersions.test.ts.
 */

export const MIX_VERSIONS_KIND = 'mixver';
export const MAX_VERSIONS = 100;

export type DecisionKind = 'approved' | 'changes';

export interface VersionDecision { kind: DecisionKind; by: string; byKey: string; at: number; comment?: string }

export interface MixAudioRef { bufferId: string; parts: string[]; size: number; duration: number }

export interface MixVersion {
  id: string;
  /** Numéro montré (« Version 3 »). */
  n: number;
  name: string;
  note?: string;
  sentAt: number;
  sentBy: string;
  sentByKey: string;
  /** Référence au projet au moment de l'envoi. */
  ref: { sessionVersion?: number | null; print?: string | null; duration?: number | null; tracks?: number | null };
  /** Bounce du mix (absent : version de référence, à écouter dans la séance). */
  audio?: MixAudioRef | null;
  /** Décision de l'artiste (null : pas encore écoutée / décidée). */
  decision: Reg<VersionDecision | null>;
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const ZERO: Stamp = { t: 0, c: 0, by: '' };

/** Prochain numéro : après le plus grand déjà envoyé. */
export const nextVersionN = (list: MixVersion[] | undefined): number => (list || []).reduce((m, v) => Math.max(m, v.n), 0) + 1;

export function createVersion(input: { id?: string; n: number; name?: string; note?: string; ref?: MixVersion['ref']; audio?: MixAudioRef | null }, who: { key: string; name: string }, clock: HybridClock): MixVersion {
  const s = clock.tick();
  const name = cleanText(input.name || '').slice(0, 80) || `Version ${input.n}`;
  const note = cleanText(input.note || '').slice(0, 400);
  return {
    id: input.id || newCommentId('mv'), n: input.n, name, ...(note ? { note } : {}),
    sentAt: s.t, sentBy: who.name.slice(0, 60), sentByKey: who.key,
    ref: input.ref || {}, audio: input.audio ?? null,
    decision: { v: null, s: ZERO },
  };
}

export function decide(v: MixVersion, kind: DecisionKind, who: { key: string; name: string }, clock: HybridClock, comment?: string): MixVersion {
  const s = clock.tick();
  const c = cleanText(comment || '');
  return { ...v, decision: { v: { kind, by: who.name.slice(0, 60), byKey: who.key, at: s.t, ...(c ? { comment: c } : {}) }, s } };
}

/** Fusion de deux états de la même version (commutative, associative, idempotente). */
export function mergeVersion(a: MixVersion, b: MixVersion): MixVersion {
  // Champs fixes : la plus ancienne copie (identiques en pratique) ; départage déterministe.
  const fa = JSON.stringify([a.sentAt, a.sentByKey, a.n, a.name, a.note ?? '', a.ref, a.audio ?? null]);
  const fb = JSON.stringify([b.sentAt, b.sentByKey, b.n, b.name, b.note ?? '', b.ref, b.audio ?? null]);
  const base = fa <= fb ? a : b;
  return { ...base, decision: mergeReg(a.decision, b.decision)! };
}

export const versionSig = (v: MixVersion) => JSON.stringify([v.id, v.n, v.name, v.note ?? '', v.sentAt, v.sentBy, v.sentByKey, v.ref, v.audio ?? null, v.decision]);

export const sortVersions = (l: MixVersion[]) => [...l].sort((a, b) => a.n - b.n || a.sentAt - b.sentAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export interface VersionMergeResult { list: MixVersion[]; added: MixVersion[]; decided: MixVersion[]; orphans: MixVersion[] }

/**
 * Fusionne des versions reçues. `fromEngineer` : l'auteur de l'opération est
 * ingé (seul l'ingé crée une version). D'un artiste, seule la décision compte :
 * une décision sur une version encore inconnue ici (ordre d'arrivée) est
 * rendue dans `orphans`, à refusionner quand la version arrive.
 */
export function mergeVersions(local: MixVersion[] | undefined, incoming: MixVersion[], opts: { fromEngineer: boolean; fromArtist: boolean }): VersionMergeResult {
  const map = new Map((local || []).map(v => [v.id, v] as const));
  const added: MixVersion[] = [], decided: MixVersion[] = [], orphans: MixVersion[] = [];
  for (let inc of incoming) {
    // Une décision compte seulement si elle est horodatée par celui qui l'a prise (règle identique
    // chez tous, et dans la page d'écoute client) ; un ingé ne fait que la transmettre.
    if (inc.decision.v && inc.decision.s.by !== inc.decision.v.byKey) inc = { ...inc, decision: { v: null, s: ZERO } };
    const cur = map.get(inc.id);
    if (!cur) {
      if (!opts.fromEngineer) { orphans.push(inc); continue; }
      map.set(inc.id, inc); added.push(inc);
      continue;
    }
    const m = mergeVersion(cur, opts.fromEngineer ? inc : { ...cur, decision: inc.decision });
    if (versionSig(m) !== versionSig(cur)) {
      map.set(inc.id, m);
      if (cmpStamp(m.decision.s, cur.decision.s) !== 0) decided.push(m);
    }
  }
  let list = sortVersions([...map.values()]);
  if (list.length > MAX_VERSIONS) list = list.slice(-MAX_VERSIONS);
  return { list, added, decided, orphans };
}

// ─── Réception : vérification ──────────────────────────────────────────────────

function readStamp(raw: unknown): Stamp | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  return finite(s.t) && finite(s.c) && typeof s.by === 'string' ? { t: s.t, c: s.c, by: s.by.slice(0, 120) } : null;
}

function readDecision(raw: unknown): Reg<VersionDecision | null> {
  if (!raw || typeof raw !== 'object') return { v: null, s: ZERO };
  const r = raw as Record<string, unknown>;
  const s = readStamp(r.s);
  if (!s) return { v: null, s: ZERO };
  const v = r.v as Record<string, unknown> | null;
  if (v === null) return { v: null, s };
  if (!v || typeof v !== 'object' || (v.kind !== 'approved' && v.kind !== 'changes') || typeof v.byKey !== 'string' || !finite(v.at)) return { v: null, s: ZERO };
  const c = typeof v.comment === 'string' ? cleanText(v.comment) : '';
  return { v: { kind: v.kind, by: String(v.by || '?').slice(0, 60), byKey: v.byKey.slice(0, 120), at: v.at, ...(c ? { comment: c } : {}) }, s };
}

export function sanitizeVersion(raw: unknown): MixVersion | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id || v.id.length > 80 || !finite(v.n) || v.n < 1 || v.n > 9999 || !finite(v.sentAt) || typeof v.sentByKey !== 'string') return null;
  const ref = v.ref && typeof v.ref === 'object' ? v.ref as Record<string, unknown> : {};
  const a = v.audio && typeof v.audio === 'object' ? v.audio as Record<string, unknown> : null;
  const audio: MixAudioRef | null = a && typeof a.bufferId === 'string' && Array.isArray(a.parts) && a.parts.every(p => typeof p === 'string') && finite(a.size) && finite(a.duration)
    ? { bufferId: a.bufferId.slice(0, 120), parts: (a.parts as string[]).slice(0, 2000), size: a.size, duration: a.duration } : null;
  const note = typeof v.note === 'string' ? cleanText(v.note).slice(0, 400) : '';
  return {
    id: v.id, n: Math.round(v.n), name: cleanText(v.name || '').slice(0, 80) || `Version ${Math.round(v.n)}`, ...(note ? { note } : {}),
    sentAt: v.sentAt, sentBy: String(v.sentBy || '?').slice(0, 60), sentByKey: v.sentByKey.slice(0, 120),
    ref: {
      sessionVersion: finite(ref.sessionVersion) ? ref.sessionVersion : null, print: typeof ref.print === 'string' ? ref.print.slice(0, 80) : null,
      duration: finite(ref.duration) ? ref.duration : null, tracks: finite(ref.tracks) ? ref.tracks : null,
    },
    audio, decision: readDecision(v.decision),
  };
}

export function readVersionsOp(op: unknown): MixVersion[] {
  const p = op && typeof op === 'object' ? op as Record<string, unknown> : {};
  return (Array.isArray(p.upsert) ? p.upsert.slice(0, 50) : []).map(sanitizeVersion).filter(Boolean) as MixVersion[];
}

// ─── Affichage ─────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
/** « 12/10/2026 à 14:32 » (heure locale). */
export function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} à ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type VersionState = 'waiting' | 'approved' | 'changes';
export const versionState = (v: MixVersion): VersionState => v.decision.v?.kind ?? 'waiting';

/** Ligne de l'historique : « Version 3 validée par Nina le 12/10/2026 à 14:32 ». */
export function versionStatusLine(v: MixVersion): string {
  const d = v.decision.v;
  if (!d) return `Version ${v.n} envoyée par ${v.sentBy} le ${fmtDate(v.sentAt)} · en attente de l'avis de l'artiste`;
  return d.kind === 'approved'
    ? `Version ${v.n} validée par ${d.by} le ${fmtDate(d.at)}`
    : `Version ${v.n} : retouches demandées par ${d.by} le ${fmtDate(d.at)}${d.comment ? ` (« ${d.comment.slice(0, 120)} »)` : ''}`;
}

/** Qui peut quoi (l'interface ne propose que ça ; la réception le vérifie aussi). */
export const canSendVersion = (role: CollabRole | null | undefined) => role === 'engineer' || role === null || role === undefined;
export const canDecide = (role: CollabRole | null | undefined) => role === 'artist';
