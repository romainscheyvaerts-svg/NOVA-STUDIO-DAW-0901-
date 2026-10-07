import type { CollabRole, Marker, Track } from '../types';

/**
 * « Feat à distance » : plusieurs artistes (et un ingé, un beatmaker) dans la
 * même session « En direct ». Logique pure, testable telle quelle :
 *
 *  - PROPRIÉTÉ DES PISTES : chaque piste créée pendant la collaboration
 *    appartient à son auteur (compte), pas seulement à son rôle. Le contenu
 *    (prises, éditions) d'une piste n'est accepté que de son propriétaire :
 *    la prise de Sam n'écrase jamais celle de Léo. Avant : toutes les pistes
 *    voix appartenaient « aux artistes » ; deux artistes sur la même piste,
 *    la dernière version effaçait la prise de l'autre.
 *  - VERROU D'ENREGISTREMENT : une piste sur laquelle son auteur enregistre est
 *    verrouillée chez les autres (pastille REC).
 *  - PRÉSENCE : connecté, enregistre, écoute, en retard, hors ligne.
 *  - « ÉCOUTER ENSEMBLE » : la lecture de l'hôte guide celle des invités.
 *  - CHAT : « à 0:42 » devient un lien qui place la tête de lecture.
 *  - REPÈRES partagés, CODE d'invitation (6 caractères), 4 participants au plus.
 */

export const MAX_PARTICIPANTS = 4;

/** Couleurs des participants (lisibles sur fond sombre, distinctes deux à deux). */
export const PEER_COLORS = ['#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#a78bfa', '#fb923c'] as const;

/**
 * Personne derrière une clé de membre. Le serveur donne « u:<compte> »
 * (ancienne fonction) ou « u:<compte>:<appareil> » (une clé par appareil) :
 * le même compte sur l'iPad et le PC reste la même personne.
 */
export const participantOf = (memberKey: string | null | undefined): string => {
  const k = String(memberKey || '');
  const m = /^u:([^:]+):/.exec(k);
  return m ? `u:${m[1]}` : k;
};

const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
};

/** Couleur d'un nouvel arrivant : la première libre (à partir d'un point qui dépend de lui). */
export function pickPeerColor(participant: string, taken: (string | null | undefined)[]): string {
  const used = new Set(taken.filter(Boolean).map(c => String(c).toLowerCase()));
  const start = hash(participant) % PEER_COLORS.length;
  for (let i = 0; i < PEER_COLORS.length; i++) {
    const c = PEER_COLORS[(start + i) % PEER_COLORS.length];
    if (!used.has(c)) return c;
  }
  return PEER_COLORS[start];
}

// --- Propriété des pistes ------------------------------------------------------------------

/** Piste dont l'artiste possède les prises (voix). */
export const isVocalTrack = (t: Track): boolean =>
  t.type === 'AUDIO' && t.id !== 'instrumental' && !t.instrumentId && (t.collabOwner ?? 'artist') === 'artist';

/** Rôle qui possède le contenu d'une piste (null : personne, comme le beat ou un bus). */
export const ownerRoleOf = (t: Track): CollabRole | null => {
  if (t.id === 'instrumental' || t.id === 'master' || t.type === 'BUS' || t.type === 'SEND') return null;
  return t.collabOwner ?? (isVocalTrack(t) ? 'artist' : t.type === 'DRUM_RACK' || t.type === 'MIDI' || t.type === 'SAMPLER' ? 'beatmaker' : null);
};

/**
 * Le contenu (clips, motifs) de cette piste est-il à ce rôle (et à cette
 * personne, si on la donne) ? Une piste sans propriétaire nommé (ancienne
 * session, ancienne version de NOVA) reste à tout le rôle, comme avant.
 */
export const ownsContent = (t: Track, role: CollabRole, participant?: string | null): boolean => {
  if (ownerRoleOf(t) !== role) return false;
  if (participant && t.collabOwnerKey) return t.collabOwnerKey === participant;
  return true;
};

export interface TrackOwner { key: string; name: string; color: string }

export const ownerOf = (t: Track): TrackOwner | null =>
  t.collabOwnerKey ? { key: t.collabOwnerKey, name: t.collabOwnerName || 'un autre', color: t.collabOwnerColor || '#94a3b8' } : null;

export interface ContentVerdict { ok: boolean; reason?: string }

/**
 * Une version reçue du contenu d'une piste est-elle acceptable ? Seulement de
 * son rôle et, si la piste a un propriétaire nommé, de lui seul.
 */
export function contentVerdict(existing: Track | undefined, author: { role: CollabRole; memberKey: string }): ContentVerdict {
  if (!existing) return { ok: true };
  if (ownerRoleOf(existing) !== author.role) return { ok: false, reason: 'piste d’un autre rôle' };
  if (existing.collabOwnerKey && existing.collabOwnerKey !== participantOf(author.memberKey)) {
    return { ok: false, reason: `piste de ${existing.collabOwnerName || 'quelqu’un d’autre'}` };
  }
  return { ok: true };
}

/** Propriétaire d'une piste reçue : celui que dit le contenu, sinon l'auteur de l'opération (ancienne version de NOVA). */
export function ownerFromContent(content: Record<string, any> | undefined, author: { role: CollabRole; memberKey: string; name: string }): TrackOwner | null {
  if (content && typeof content.collabOwnerKey === 'string' && content.collabOwnerKey) {
    return { key: content.collabOwnerKey, name: String(content.collabOwnerName || author.name).slice(0, 40), color: typeof content.collabOwnerColor === 'string' ? content.collabOwnerColor : '#94a3b8' };
  }
  if (!author.memberKey) return null;
  return { key: participantOf(author.memberKey), name: author.name.slice(0, 40), color: '#94a3b8' };
}

/**
 * Revendication d'une piste sans propriétaire (« own ») : la première du journal
 * gagne. `current` : numéro de la revendication retenue (Infinity : la nôtre,
 * pas encore enregistrée par le serveur).
 */
export const claimWins = (current: number | undefined, incoming: number): boolean => current === undefined || incoming < current;

// --- Verrou d'enregistrement -----------------------------------------------------------------

export interface PeerRec { key: string; name: string; trackId: string; at: number }

/** Un verrou d'enregistrement reçu par le journal (direct coupé) expire tout seul. */
export const REC_LOCK_TTL_MS = 10 * 60_000;

export interface CollabMe { role: CollabRole; key: string; name: string }

/** Qui enregistre sur cette piste (un autre que moi), s'il y en a un. */
export const recOn = (trackId: string, recs: PeerRec[], me: { key: string } | null, now = Date.now()): PeerRec | null =>
  recs.find(r => r.trackId === trackId && (!me || r.key !== me.key) && now - r.at < REC_LOCK_TTL_MS) || null;

/**
 * Puis-je enregistrer sur cette piste ? null : oui ; sinon la phrase qui dit
 * pourquoi et quoi faire. otherArtists : un autre artiste est dans la session
 * (une piste sans propriétaire n'est alors plus partagée : chacun la sienne).
 */
export function recordBlock(t: Track, me: CollabMe | null, recs: PeerRec[], now = Date.now(), otherArtists = false): string | null {
  if (!me) return null;
  const r = recOn(t.id, recs, me, now);
  if (r) return `${r.name} enregistre sur « ${t.name} » en ce moment : la piste est verrouillée. Attends la fin de sa prise, ou enregistre sur ta propre piste.`;
  if (ownsContent(t, me.role, me.key)) {
    if (otherArtists && me.role === 'artist' && !t.collabOwnerKey) {
      return `« ${t.name} » n'appartient à personne et vous êtes plusieurs artistes : pour que personne n'écrase la prise de l'autre, enregistre sur ta propre piste (« Créer ma piste » dans Collaboration).`;
    }
    return null;
  }
  const o = ownerOf(t);
  if (o) return `« ${t.name} » est la piste de ${o.name} : sa prise ne peut pas être écrasée. Enregistre sur ta propre piste (« Créer ma piste » dans Collaboration).`;
  return me.role === 'artist'
    ? `« ${t.name} » n'est pas une piste de voix : choisis une de tes pistes pour enregistrer.`
    : `« ${t.name} » appartient à l'artiste : crée ta propre piste pour enregistrer.`;
}

/** Une piste de voix où je peux enregistrer (la sélectionnée d'abord). */
export function myRecordTarget(tracks: Track[], me: CollabMe, recs: PeerRec[], preferId?: string | null, otherArtists = false, now = Date.now()): Track | null {
  const ok = (t: Track) => t.type === 'AUDIO' && t.id !== 'instrumental' && !t.instrumentId && recordBlock(t, me, recs, now, otherArtists) === null;
  const pref = preferId ? tracks.find(t => t.id === preferId) : undefined;
  if (pref && ok(pref)) return pref;
  // D'abord mes pistes à moi (nommées), puis une piste de voix libre.
  return tracks.find(t => ok(t) && t.collabOwnerKey === me.key) || tracks.find(ok) || null;
}

/** Nom de la piste créée pour un participant (« Voix de Sam », « Voix de Sam 2 »…). */
export function myTrackName(name: string, tracks: Track[], label = 'Voix'): string {
  const base = `${label} de ${name || 'moi'}`.slice(0, 36);
  const names = new Set(tracks.map(t => t.name));
  if (!names.has(base)) return base;
  for (let k = 2; ; k++) if (!names.has(`${base} ${k}`)) return `${base} ${k}`;
}

// --- Présence ------------------------------------------------------------------------------

export type PeerState = 'online' | 'recording' | 'listening' | 'late' | 'offline';

export interface PeerInfo {
  key: string;
  name: string;
  role: CollabRole;
  color?: string;
  /** Présent dans le canal en direct. */
  online: boolean;
  /** Piste en cours d'enregistrement. */
  rec?: string | null;
  /** Lecture en cours chez lui. */
  playing?: boolean;
  /** Sa connexion : « late » = sans direct ou modifications en attente. */
  st?: 'ok' | 'late';
  host?: boolean;
  /** Dernier signe de vie (opération reçue), ms. */
  seenAt?: number;
}

export interface PeerView extends PeerInfo { state: PeerState; label: string; me: boolean }

export const PEER_STATE_TONE: Record<PeerState, string> = {
  online: 'bg-emerald-400', recording: 'bg-red-500 animate-pulse', listening: 'bg-sky-400', late: 'bg-amber-400', offline: 'bg-slate-500',
};

/** Ce qu'on montre pour chaque participant (moi en premier). */
export function peerViews(peers: PeerInfo[], meKey: string | null, trackName: (id: string) => string | undefined, now = Date.now()): PeerView[] {
  const out = peers.map((p): PeerView => {
    const me = !!meKey && p.key === meKey;
    let state: PeerState;
    let label: string;
    if (p.online && p.rec) { state = 'recording'; label = `enregistre${trackName(p.rec) ? ` sur « ${trackName(p.rec)} »` : ''}`; }
    else if (p.online && p.st === 'late') { state = 'late'; label = 'en retard : connexion lente, ses modifications arrivent avec du retard'; }
    else if (p.online && p.playing) { state = 'listening'; label = 'écoute'; }
    else if (p.online) { state = 'online'; label = 'connecté'; }
    else if (p.seenAt && now - p.seenAt < 60_000) { state = 'late'; label = 'en retard : sans direct, ses modifications arrivent toutes les 10 s'; }
    else { state = 'offline'; label = 'hors ligne'; }
    return { ...p, state, label, me };
  });
  return out.sort((a, b) => (a.me === b.me ? Number(b.online) - Number(a.online) : a.me ? -1 : 1));
}

/** Personnes (autres que moi) déjà dans le canal en direct. */
export const othersPresent = (peers: PeerInfo[], meKey: string | null): number =>
  new Set(peers.filter(p => p.online && p.key !== meKey).map(p => p.key)).size;

/** Session pleine pour un nouvel arrivant (4 personnes au plus, moi compris). */
export const isSessionFull = (peers: PeerInfo[], meKey: string | null): boolean => othersPresent(peers, meKey) >= MAX_PARTICIPANTS;

// --- « Écouter ensemble » ---------------------------------------------------------------------

export interface TransportMsg {
  action: 'play' | 'pause' | 'seek' | 'sync';
  /** Position (s) à l'instant `at`. */
  pos: number;
  /** Horloge de l'hôte (ms, Date.now()) quand il était à `pos`. */
  at: number;
  playing: boolean;
}

/** Message trop vieux pour être suivi (arrivé par le rattrapage, bien après). */
export const TRANSPORT_MAX_AGE_MS = 30_000;

/**
 * Où doit être l'invité maintenant pour être avec l'hôte : si l'hôte joue, sa
 * position avance avec le temps écoulé depuis l'envoi (le message a mis du
 * temps à arriver). null : message trop vieux, ignoré.
 */
export function followTarget(m: TransportMsg, now = Date.now()): { playing: boolean; pos: number } | null {
  if (!m || !Number.isFinite(m.pos) || !Number.isFinite(m.at)) return null;
  const age = now - m.at;
  if (age > TRANSPORT_MAX_AGE_MS) return null;
  const pos = m.playing ? m.pos + Math.max(0, age) / 1000 : m.pos;
  return { playing: !!m.playing, pos: Math.max(0, pos) };
}

/** Écart toléré avant de recaler l'invité pendant la lecture (s). */
export const RESYNC_TOLERANCE_S = 0.08;

export const needsResync = (expected: number, actual: number, tolerance = RESYNC_TOLERANCE_S): boolean =>
  Math.abs(expected - actual) > tolerance;

// --- Chat : positions --------------------------------------------------------------------------

/** « 0:42 », « 1:05 », « 1:02:03 » (heures seulement si besoin). */
export function formatPosition(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export type ChatPart = { kind: 'text'; text: string } | { kind: 'time'; text: string; seconds: number };

const TIME_RE = /(?<![\d:])(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?![\d:])/g;

/** Découpe un message : les positions (« 0:42 ») deviennent des liens vers la tête de lecture. */
export function parseTimeMentions(text: string): ChatPart[] {
  const out: ChatPart[] = [];
  let last = 0;
  for (const m of text.matchAll(TIME_RE)) {
    const i = m.index ?? 0;
    const seconds = m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
    if (i > last) out.push({ kind: 'text', text: text.slice(last, i) });
    out.push({ kind: 'time', text: m[0], seconds });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** Ajoute « à 0:42 » au message en cours de saisie. */
export const withPosition = (text: string, sec: number): string => {
  const mention = `à ${formatPosition(sec)}`;
  const t = text.replace(/\s+$/, '');
  return t ? `${t} ${mention} ` : `${mention[0].toUpperCase()}${mention.slice(1)} : `;
};

// --- Repères partagés --------------------------------------------------------------------------

export const markerSig = (m: Marker): string => JSON.stringify([m.name, Math.round(m.time * 1000), m.type, m.endTime ?? null, m.color, m.number ?? null]);

/** Repères ajoutés / modifiés / supprimés ici depuis la dernière synchronisation. */
export function markerChanges(known: Map<string, string>, markers: Marker[]): { upsert: Marker[]; remove: string[] } {
  const upsert = markers.filter(m => known.get(m.id) !== markerSig(m));
  const ids = new Set(markers.map(m => m.id));
  const remove = [...known.keys()].filter(id => !ids.has(id));
  return { upsert, remove };
}

/** Applique des repères reçus (accept : règle « dernière écriture gagne » par repère). */
export function applyMarkerOps(markers: Marker[], upsert: unknown, remove: unknown, accept: (id: string) => boolean = () => true): Marker[] {
  const next = [...markers];
  for (const raw of Array.isArray(upsert) ? upsert : []) {
    const m = raw as Marker;
    if (!m || typeof m.id !== 'string' || typeof m.time !== 'number' || !Number.isFinite(m.time) || !accept(m.id)) continue;
    const clean: Marker = { ...m, name: String(m.name || 'Repère').slice(0, 80), color: typeof m.color === 'string' ? m.color : '#f59e0b' };
    const i = next.findIndex(x => x.id === m.id);
    if (i >= 0) next[i] = clean; else next.push(clean);
  }
  const gone = new Set((Array.isArray(remove) ? remove : []).filter((x): x is string => typeof x === 'string' && accept(x)));
  return next.filter(m => !gone.has(m.id)).sort((a, b) => a.time - b.time);
}

// --- Invitation -------------------------------------------------------------------------------

/** Lettres et chiffres sans ambiguïté (ni I, L, O, 0, 1). */
export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Code saisi (« abc 123 », « ABC-123 ») → « ABC123 », ou null s'il n'est pas valable. */
export function normalizeInviteCode(input: string): string | null {
  const s = String(input || '').toUpperCase().replace(/[\s\-_.]/g, '');
  if (s.length !== 6) return null;
  for (const ch of s) if (!INVITE_ALPHABET.includes(ch)) return null;
  return s;
}

/** « ABC123 » → « ABC 123 » (plus facile à dicter). */
export const formatInviteCode = (code: string): string => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

/** Une phrase claire par rôle, au moment de choisir en arrivant. */
export const ARRIVAL_ROLE_HELP: Record<CollabRole, string> = {
  artist: 'Tu enregistres tes propres pistes. Les autres les entendent avec ton nom, personne ne peut les écraser.',
  engineer: 'Tu règles le mix de tout le monde : volumes, effets, envois. Les prises restent aux artistes.',
  beatmaker: 'Tu ajoutes et modifies tes pistes : batterie, basse, mélodies. Les voix restent aux artistes.',
};
