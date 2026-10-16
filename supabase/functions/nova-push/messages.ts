// NOVA · Lot 7 · Notifications : ce que dit chaque notification, et à qui elle part.
//
// Les événements viennent des triggers SQL (D:\1 WORK\CONTENU\nova-151\serveur\notifications_151.sql)
// posés sur les tables EXISTANTES de la collaboration, sans toucher à daw-session :
//   - daw_session_ops (opérations « comments », « mixver », « take_end ») ;
//   - daw_session_members (quelqu'un rejoint la séance) ;
//   - daw_sessions (le studio attribue une séance à un compte : « Une séance t'attend »).
// Chaque opération porte l'état COMPLET de ce qu'elle touche ({ upsert: [...] }) : on ne
// notifie que ce qui est NEUF (créé il y a moins de 15 min, par l'auteur de l'opération), et
// une clé de dédoublonnage par chose (commentaire, réponse, version, décision, prise) garantit
// une seule notification même si l'opération est rejouée (file d'envoi, reconnexion).
//
// Règles :
//   - jamais de notification pour sa propre action (l'auteur est retiré des destinataires) ;
//   - seulement les comptes qui ont activé les notifications (ligne nova_notify_prefs, interrupteur
//     général et type par type) ;
//   - les mots d'un commentaire ne comptent que s'ils sont horodatés par leur auteur (mêmes droits
//     que NOVA et la page d'écoute : utils/timelineComments.enforceAuthorship, daw-listen/review.ts).
//
// Module pur (aucun import) : testé par tests/pushMessages.test.ts.

export type NotifType = "comment" | "version" | "invite" | "take";
export const NOTIF_TYPES: NotifType[] = ["comment", "version", "invite", "take"];

export interface NotifPrefs {
  enabled: boolean;
  comments: boolean;
  versions: boolean;
  invites: boolean;
  takes: boolean;
}

export const PREF_OF: Record<NotifType, Exclude<keyof NotifPrefs, "enabled">> = {
  comment: "comments",
  version: "versions",
  invite: "invites",
  take: "takes",
};

/** Pas de ligne de réglages = notifications jamais activées : rien ne part. */
export function prefAllows(prefs: Partial<NotifPrefs> | null | undefined, type: NotifType): boolean {
  if (!prefs || prefs.enabled !== true) return false;
  return prefs[PREF_OF[type]] !== false;
}

export interface NotifyEvent {
  id: number;
  source: "op" | "member" | "assign";
  session_id: string;
  actor_key: string;
  actor_name: string;
  kind: string;
  payload: Record<string, any>;
  created_at: string;
}

export interface SessionInfo {
  id: string;
  name: string;
  secret: string | null;
  owner_id: string | null;
}

export interface PushMessage {
  type: NotifType;
  /** Une seule notification par chose (par destinataire). */
  dedup: string;
  title: string;
  body: string;
  /** Chemin dans NOVA (relatif à l'adresse de l'appli) : ouvre la séance, à l'instant du commentaire. */
  path: string;
  /** Regroupe les notifications d'une même chose (le navigateur remplace l'ancienne). */
  tag: string;
  sessionId: string;
  commentId?: string;
  versionId?: string;
  /** Instant (s) dans le morceau. */
  at?: number;
}

/** Un commentaire, une version ou une prise compte comme « neuf » pendant 15 min. */
export const FRESH_MS = 15 * 60_000;
export const MAX_TITLE = 80;
export const MAX_BODY = 180;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const oneLine = (s: unknown, max: number): string => {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};

/** Compte d'une clé de participant (« u:<compte> » ou « u:<compte>:<appareil> »). */
export function userOfMemberKey(key: unknown): string | null {
  const m = /^u:([0-9a-f-]{36})(?::|$)/i.exec(typeof key === "string" ? key : "");
  return m && UUID_RE.test(m[1]) ? m[1].toLowerCase() : null;
}

/** « 1:12 », « 1:02:03 ». */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(finite(sec) ? sec : 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

const ROLE_FR: Record<string, string> = { artist: "artiste", engineer: "ingé son", beatmaker: "beatmaker" };

function sessionLabel(s: SessionInfo): string {
  const n = oneLine(s.name, 60);
  return n && n !== "Session" ? `« ${n} »` : "ta séance";
}

/** Ouvre la séance (lien complet : la personne y a déjà accès), à l'instant voulu. */
export function sessionPath(s: SessionInfo, extra: { c?: string; v?: string; at?: number } = {}): string {
  const q = new URLSearchParams();
  if (s.secret) q.set("session", `${s.id}.${s.secret}`);
  q.set("nova_s", s.id);
  if (extra.c) q.set("nova_c", extra.c);
  if (extra.v) q.set("nova_v", extra.v);
  if (finite(extra.at)) q.set("nova_at", String(Math.round(Math.max(0, extra.at) * 1000) / 1000));
  return `/?${q.toString()}`;
}

/** Destinataires : le propriétaire de la séance et les membres connectés, sauf l'auteur. */
export function recipientsFor(ev: NotifyEvent, session: SessionInfo, memberUserIds: (string | null | undefined)[]): string[] {
  if (ev.source === "assign") {
    const r = typeof ev.payload?.recipient === "string" ? ev.payload.recipient.toLowerCase() : "";
    return UUID_RE.test(r) ? [r] : [];
  }
  const actor = ev.source === "member" ? (typeof ev.payload?.user_id === "string" ? ev.payload.user_id.toLowerCase() : userOfMemberKey(ev.actor_key)) : userOfMemberKey(ev.actor_key);
  const out = new Set<string>();
  for (const u of [session.owner_id, ...memberUserIds]) {
    const id = typeof u === "string" ? u.toLowerCase() : "";
    if (UUID_RE.test(id) && id !== actor) out.add(id);
  }
  return [...out];
}

const itemsOf = (op: unknown): Record<string, any>[] => {
  const list = isObj(op) && Array.isArray(op.upsert) ? op.upsert : [];
  return list.filter((i: unknown) => isObj(i) && typeof (i as any).id === "string" && (i as any).id.length <= 80) as Record<string, any>[];
};
const stampBy = (reg: unknown): string => (isObj(reg) && isObj(reg.s) && typeof reg.s.by === "string" ? reg.s.by : "");
const fresh = (t: unknown, now: number) => finite(t) && t <= now + 5 * 60_000 && now - t <= FRESH_MS;
const who = (ev: NotifyEvent, fallback?: unknown) => oneLine(ev.actor_name, 40) || oneLine(fallback, 40) || "Quelqu’un";

/** Ce que dit chaque événement (un événement peut porter plusieurs choses neuves). */
export function messagesForEvent(ev: NotifyEvent, session: SessionInfo, now: number = Date.now()): PushMessage[] {
  const sid = session.id;
  const label = sessionLabel(session);
  const out: PushMessage[] = [];

  if (ev.source === "assign") {
    out.push({
      type: "invite", dedup: `a:${sid}`, tag: `nova-invite-${sid}`, sessionId: sid,
      title: "🎁 Une séance t’attend",
      body: `Le studio Make Music t’a envoyé ${label}. Touche pour l’ouvrir dans NOVA.`,
      path: sessionPath(session),
    });
    return out.map(clip);
  }

  if (ev.source === "member") {
    const role = ROLE_FR[String(ev.payload?.role || "")] || "";
    out.push({
      type: "invite", dedup: `j:${sid}:${userOfMemberKey(ev.actor_key) || ev.payload?.user_id || ev.actor_key}`, tag: `nova-join-${sid}`, sessionId: sid,
      title: `👥 ${who(ev)} a rejoint ${label}`,
      body: role ? `Rôle : ${role}. Touche pour ouvrir la séance.` : "Touche pour ouvrir la séance.",
      path: sessionPath(session),
    });
    return out.map(clip);
  }

  const op = ev.payload?.op;
  if (ev.kind === "comments") {
    for (const c of itemsOf(op)) {
      const t = finite(c.pos?.v?.t) ? c.pos.v.t : 0;
      const archived = isObj(c.archived) && c.archived.v === true;
      // Nouveau commentaire : créé par l'auteur de l'opération, ses mots horodatés par lui.
      if (!archived && c.authorKey === ev.actor_key && fresh(c.createdAt, now) && stampBy(c.text) === c.authorKey) {
        const text = oneLine(c.text?.v, 120);
        if (text) {
          out.push({
            type: "comment", dedup: `c:${sid}:${c.id}`, tag: `nova-comment-${c.id}`, sessionId: sid, commentId: c.id, at: t,
            title: `💬 ${who(ev, c.authorName)} a commenté à ${fmtTime(t)}`,
            body: `« ${text} » · ${label}`,
            path: sessionPath(session, { c: c.id, at: t }),
          });
        }
      }
      // Nouvelles réponses (une notification par réponse).
      for (const r of Array.isArray(c.replies) ? c.replies : []) {
        if (!isObj(r) || typeof r.id !== "string" || r.id.length > 80) continue;
        if (r.authorKey !== ev.actor_key || !fresh(r.createdAt, now) || stampBy(r.text) !== r.authorKey) continue;
        if (isObj(r.deleted) && r.deleted.v === true) continue;
        const text = oneLine(r.text?.v, 120);
        if (!text) continue;
        out.push({
          type: "comment", dedup: `r:${sid}:${r.id}`, tag: `nova-comment-${c.id}`, sessionId: sid, commentId: c.id, at: t,
          title: `↩️ ${who(ev, r.authorName)} a répondu (${fmtTime(t)})`,
          body: `« ${text} » · ${label}`,
          path: sessionPath(session, { c: c.id, at: t }),
        });
      }
    }
  } else if (ev.kind === "mixver") {
    for (const v of itemsOf(op)) {
      const n = finite(v.n) ? Math.round(v.n) : null;
      const vname = n ? `la version ${n}` : "une version";
      // Nouvelle version envoyée (seul l'ingé en crée : l'auteur de l'opération).
      if (v.sentByKey === ev.actor_key && fresh(v.sentAt, now)) {
        const name = oneLine(v.name, 60);
        const custom = name && !/^version \d+$/i.test(name) ? ` (« ${name} »)` : "";
        out.push({
          type: "version", dedup: `v:${sid}:${v.id}`, tag: `nova-version-${v.id}`, sessionId: sid, versionId: v.id,
          title: `📨 ${who(ev, v.sentBy)} t’envoie ${vname}${custom}`,
          body: `${v.audio ? "Écoute-la et" : "Ouvre la séance et"} dis si elle est validée ou s’il faut des retouches · ${label}`,
          path: sessionPath(session, { v: v.id }),
        });
      }
      // Décision de l'artiste : valable seulement horodatée par celui qui l'a prise.
      const d = isObj(v.decision) ? v.decision : null;
      const dv = d && isObj(d.v) ? d.v : null;
      if (dv && dv.byKey === ev.actor_key && stampBy(d) === dv.byKey && fresh(dv.at, now) && (dv.kind === "approved" || dv.kind === "changes")) {
        const comment = oneLine(dv.comment, 100);
        out.push({
          type: "version", dedup: `d:${sid}:${v.id}:${finite(d!.s?.t) ? d!.s.t : dv.at}`, tag: `nova-version-${v.id}`, sessionId: sid, versionId: v.id,
          title: dv.kind === "approved"
            ? `✅ ${who(ev, dv.by)} a validé ${vname}`
            : `✏️ ${who(ev, dv.by)} demande des retouches sur ${vname}`,
          body: comment ? `« ${comment} » · ${label}` : label.charAt(0).toUpperCase() + label.slice(1),
          path: sessionPath(session, { v: v.id }),
        });
      }
    }
  } else if (ev.kind === "take_end") {
    if (!isObj(op) || op.cancel) return [];
    const take = typeof op.t === "string" && op.t ? op.t.slice(0, 80) : typeof op._id === "string" ? op._id.slice(0, 80) : String(ev.payload?.seq ?? "");
    if (!take) return [];
    const secs = finite(op.frames) && finite(op.sr) && op.sr > 0 ? op.frames / op.sr : null;
    out.push({
      type: "take", dedup: `t:${sid}:${take}`, tag: `nova-take-${sid}`, sessionId: sid,
      title: `🎙️ ${who(ev)} t’a envoyé une prise`,
      body: `${secs && secs >= 1 ? `Prise de ${fmtTime(secs)}, ` : ""}déjà rangée dans ${label}. Touche pour l’écouter.`,
      path: sessionPath(session),
    });
  }
  return out.map(clip);
}

function clip(m: PushMessage): PushMessage {
  return { ...m, title: oneLine(m.title, MAX_TITLE), body: oneLine(m.body, MAX_BODY) };
}

/** Contenu chiffré envoyé au navigateur (lu par public/sw.js). Moins de 1 Ko. */
export function pushPayload(m: PushMessage & { id?: number }): string {
  return JSON.stringify({
    v: 1, type: m.type, title: m.title, body: m.body, tag: m.tag, url: m.path, s: m.sessionId,
    ...(m.commentId ? { c: m.commentId } : {}), ...(m.versionId ? { ver: m.versionId } : {}),
    ...(finite(m.at) ? { at: m.at } : {}), ...(m.id ? { id: m.id } : {}),
  });
}

/** Notification d'essai (bouton « Tester » des réglages). */
export function testMessage(): PushMessage {
  return {
    type: "comment", dedup: `test:${Date.now()}`, tag: "nova-test", sessionId: "",
    title: "🔔 Les notifications NOVA marchent",
    body: "Tu seras prévenu ici des commentaires, versions, invitations et prises reçues.",
    path: "/",
  };
}
