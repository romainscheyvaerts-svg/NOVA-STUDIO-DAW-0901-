import { catalogSupabase } from './supabase';
import { call, sha1, CHUNK, CloudLink } from './SessionCloud';
import { wavOf } from './AudioUtils';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { padSampleKey } from '../utils/drumSamples';
import { samplerBufferKey } from '../utils/melodicSampler';
import { audioEngine } from '../engine/AudioEngine';
import { Clip, CollabRole, Track } from '../types';
import { CollabOutbox, CollabOutboxOptions, CollabOutboxStore } from '../utils/collabOutbox';
import { CollabStatus, initialCollabStatus } from '../utils/collabStatus';
import { mergeQueuedOps, structureOf } from '../utils/collabMerge';
import { isVocalTrack as isVocalTrackPure, ownsContent as ownsContentPure } from '../utils/collabPeers';

/**
 * Collaboration à distance (artiste, ingé son, beatmaker) sur une session en
 * ligne. Chaque modification est une opération journalisée par la fonction
 * daw-session (rattrapage à la connexion) et diffusée en direct par Supabase
 * Realtime (canal propre à la session). Qui envoie quoi :
 *  - artiste : ses prises et éditions (pistes voix), toutes les 10 s ; les verrous de volume ;
 *  - ingé son : volume, pan, effets Nova, envois (en direct) ; pistes gelées avec ses VST ;
 *  - beatmaker : ses pistes (batterie, basse…).
 * L'audio voyage en morceaux nommés par leur SHA-1 (jamais deux fois).
 */

export const ROLE_LABEL: Record<CollabRole, string> = { artist: 'Artiste', engineer: 'Ingé son', beatmaker: 'Beatmaker' };

export interface CollabOp {
  seq: number;
  kind: string;
  op: any;
  role: CollabRole;
  author_name: string;
  member_key: string;
  created_at?: string;
  /**
   * Opération d'avant notre arrivée (rattrapage du journal à la connexion) :
   * un historique, pas une demande à traiter maintenant (réglage de VST…).
   */
  replay?: boolean;
}
export interface CollabMember {
  member_key: string; role: CollabRole; display_name: string; online?: boolean;
  /** Présence en direct (« Feat à distance ») : couleur, piste en cours d'enregistrement, lecture, état de sa connexion, hôte. */
  color?: string; rec?: string | null; playing?: boolean; st?: 'ok' | 'late'; host?: boolean;
  /** Piste qu'il modifie en ce moment, piste sélectionnée chez lui. */
  edit?: string | null; sel?: string | null;
  /** Audio en direct proposé : talkback ouvert, mix diffusé (services/CollabRtc). */
  talk?: boolean; mixOut?: boolean;
  last_seen?: string;
}

/** Ce que chacun annonce dans la présence en direct (en plus de son nom et de son rôle). */
export interface PresenceMeta {
  color?: string; rec?: string | null; playing?: boolean; st?: 'ok' | 'late'; host?: boolean;
  edit?: string | null; sel?: string | null; talk?: boolean; mixOut?: boolean;
}

/** Messages éphémères (direct seulement, jamais dans le journal). */
export type EphemeralEvent = 'tp' | 'ping' | 'pong' | 'fp' | 'rtc';
const EPHEMERAL_EVENTS: EphemeralEvent[] = ['tp', 'ping', 'pong', 'fp', 'rtc'];
export type AudioRefs = Record<string, { parts: string[]; size: number }>;

export const collabDeviceId = (): string => {
  try {
    let id = localStorage.getItem('nova_device_id');
    if (!id) { id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem('nova_device_id', id); }
    return id;
  } catch { return `tmp${Math.random().toString(36).slice(2, 10)}`; }
};

/**
 * Chargement de page en cours : l'état en mémoire vient d'UN instantané (plus
 * ce qui a été fait depuis, sur cette page). Nos opérations envoyées par une
 * page précédente (avant un rechargement) n'y sont pas : elles doivent être
 * rejouées, comme celles des autres (avant : ignorées, l'ingé qui rechargeait
 * perdait ses derniers changements, ex. un accord posé, pendant que les autres
 * les gardaient).
 */
export const collabPageId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const newOpId = (): string => {
  try { if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return (crypto as Crypto).randomUUID(); } catch { /* */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

/** Mémoire bornée (les plus anciens sortent) : numéros et identifiants déjà vus. */
const remember = <T,>(set: Set<T>, v: T, max = 5000) => {
  set.add(v);
  if (set.size > max) { const first = set.values().next().value as T; set.delete(first); }
};

const POLL_MS = 10000;
const SUBSCRIBE_GRACE_MS = 6000;

export interface CollabClientOptions {
  /** File d'envoi gardée dans le navigateur (survit à un rechargement). */
  outboxStore?: CollabOutboxStore;
  /** Fusion de deux modifications en file de la même clé (mix champ par champ). */
  merge?: CollabOutboxOptions['merge'];
}

/**
 * Client d'une collaboration (les deux modes passent par lui).
 *
 * Robustesse :
 *  - direct (Supabase Realtime) ET journal (fonction daw-session) : le direct
 *    peut tomber, le rattrapage toutes les 10 s (et à chaque reconnexion, au
 *    retour du réseau) récupère tout, sans trou ni doublon ;
 *  - doublons : même numéro (seq) ou même identifiant d'opération (`_id`,
 *    renvoi après une réponse perdue) → appliquée une seule fois ;
 *  - nos propres opérations reconnues à l'appareil (`_d`) : un autre appareil
 *    du MÊME compte (iPad + PC) reçoit bien les modifications de l'autre ;
 *  - file d'envoi : rien ne se perd hors ligne, tout repart dans l'ordre ;
 *  - état exposé (onStatus) : en direct, rattrapage, hors ligne, envoi…
 */
export class CollabClient {
  memberKey = '';
  lastSeq = 0;
  /** Plus grand numéro du journal vu (reçu en direct, rattrapé, ou envoyé) : « horizon » de synchronisation. */
  horizon = 0;
  readonly deviceId = collabDeviceId();
  /** Page (chargement) qui a envoyé l'opération : voir collabPageId. */
  readonly pageId = collabPageId;
  readonly outbox: CollabOutbox;
  private channel: ReturnType<typeof catalogSupabase.channel> | null = null;
  /** Rattrapage en cours : un second appel attend la fin de celui-ci. */
  private catchUpRun: Promise<void> | null = null;
  /** Opérations reçues pas encore appliquées (téléchargement en cours…). */
  pendingApply(): number { return this.pending.size; }
  /** Opérations en file ou en cours d'application (pas de second essai en parallèle). */
  private pending = new Set<number>();
  private closed = false;
  /** Dernier numéro du journal au moment de rejoindre : ce qui est avant est de l'historique. */
  private joinSeq = 0;
  private status: CollabStatus = initialCollabStatus();
  private statusListeners = new Set<(s: CollabStatus) => void>();
  private unlisten: (() => void)[] = [];

  constructor(
    public link: CloudLink,
    public role: CollabRole,
    public name: string,
    private onOp: (op: CollabOp) => Promise<void> | void,
    private onPresence: (members: CollabMember[]) => void,
    opts: CollabClientOptions = {},
  ) {
    this.outbox = new CollabOutbox((kind, op) => this.send(kind, op), {
      store: opts.outboxStore, merge: opts.merge || mergeQueuedOps, onChange: () => this.setStatus({ pending: this.outbox?.size() ?? 0 }),
      onDrop: (entry, error) => {
        this.setStatus({ droppedOps: this.status.droppedOps + 1, lastError: error });
        this.onDropped?.(entry.kind, entry.op, error);
      },
    });
    this.status.pending = this.outbox.size();
  }

  private body(extra: Record<string, unknown> = {}) {
    return { id: this.link.id, secret: this.link.secret, device_id: this.deviceId, ...extra };
  }

  // --- État -------------------------------------------------------------------------------

  getStatus(): CollabStatus { return this.status; }

  /** Aller-retour avec le serveur (envoi d'une opération), moyenne glissante. */
  private rtts: number[] = [];
  private noteRtt(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.rtts = [...this.rtts.slice(-9), ms];
    const sorted = [...this.rtts].sort((a, b) => a - b);
    this.setStatus({ rttMs: Math.round(sorted[Math.floor(sorted.length / 2)]) });
  }
  onStatus(cb: (s: CollabStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => { this.statusListeners.delete(cb); };
  }
  private setStatus(patch: Partial<CollabStatus>) {
    const next = { ...this.status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.statusListeners.forEach(cb => { try { cb(next); } catch { /* */ } });
  }
  /** Progression d'un envoi d'audio (null : terminé). */
  reportUpload(sent: number, total: number) {
    this.setStatus({ upload: total > 0 && sent < total ? { sent, total } : null });
  }

  // --- Connexion ----------------------------------------------------------------------------

  /** Rejoint la session (rôle), se branche au canal en direct, rattrape les opérations depuis `fromSeq`. */
  async join(fromSeq: number): Promise<CollabMember[]> {
    this.closed = false;
    this.setStatus({ realtime: 'connecting', lastError: null });
    let r: { member_key: string; last_seq: number; members: CollabMember[]; channel: string };
    try {
      r = await call('join', this.body({ role: this.role, name: this.name }));
    } catch (e: any) {
      this.setStatus({ reachable: false, lastError: e?.message || 'Connexion impossible' });
      throw e;
    }
    this.memberKey = r.member_key;
    this.joinSeq = Number(r.last_seq) || 0;
    this.lastSeq = Math.max(0, fromSeq);
    this.floorSeq = this.lastSeq;
    this.horizon = Math.max(this.horizon, this.floorSeq);
    this.setStatus({ joined: true, reachable: true });
    const ch = catalogSupabase.channel(r.channel, { config: { broadcast: { self: false }, presence: { key: this.memberKey } } });
    this.channelRef = ch;
    ch.on('broadcast', { event: 'op' }, ({ payload }) => { void this.receive(payload as CollabOp); });
    // Messages éphémères (lecture de l'hôte, mesure de latence, empreintes, audio en direct) : pas de journal.
    EPHEMERAL_EVENTS.forEach(ev => ch.on('broadcast', { event: ev }, ({ payload }) => { try { this.onEphemeral?.(ev, payload); } catch { /* */ } }));
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState() as Record<string, ({ name: string; role: CollabRole } & PresenceMeta)[]>;
      // Une clé = un membre ; plusieurs appareils du même compte (ancienne fonction) : le plus récent.
      const online = Object.entries(state).map(([key, metas]) => {
        const m = metas[metas.length - 1] || ({} as any);
        const extra: PresenceMeta = {};
        if (m.color) extra.color = m.color;
        if (m.rec) extra.rec = m.rec;
        if (m.playing) extra.playing = true;
        if (m.st) extra.st = m.st;
        if (m.host) extra.host = true;
        if (m.edit) extra.edit = m.edit;
        if (m.sel) extra.sel = m.sel;
        if (m.talk) extra.talk = true;
        if (m.mixOut) extra.mixOut = true;
        return { member_key: key, role: m.role, display_name: m.name, online: true, ...extra };
      });
      this.onPresence(online as CollabMember[]);
    });
    let subscribedOnce = false;
    await new Promise<void>((resolve) => {
      ch.subscribe(async (status: string) => {
        if (this.closed) return;
        if (status === 'SUBSCRIBED') {
          this.setStatus({ realtime: 'live' });
          this.subscribed = true;
          try { await ch.track({ name: this.name, role: this.role, ...this.presenceMeta }); } catch { /* présence : réessayée à la reconnexion */ }
          // Reconnexion du direct : on rattrape ce qui a été manqué et on vide la file.
          if (subscribedOnce) { void this.catchUp(); void this.flush(); }
          subscribedOnce = true;
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          // Le client Supabase se reconnecte tout seul ; en attendant, le rattrapage (10 s) prend le relais.
          this.subscribed = false;
          this.setStatus({ realtime: 'down' });
          this.onPresence([]);
        }
      });
      setTimeout(() => { if (!subscribedOnce && !this.closed) this.setStatus({ realtime: 'down' }); resolve(); }, SUBSCRIBE_GRACE_MS);
    });
    if (this.closed) return r.members;
    this.channel = ch;
    this.listenNetwork();
    if (!this.timer) this.timer = setInterval(() => { void this.catchUp(); void this.flush(); }, POLL_MS);
    await this.catchUp();
    void this.flush();
    return r.members;
  }

  private listenNetwork() {
    if (this.unlisten.length || typeof window === 'undefined' || !window.addEventListener) return;
    const w = window;
    const online = () => { this.setStatus({ browserOffline: false }); void this.catchUp(); void this.flush(); };
    const offline = () => this.setStatus({ browserOffline: true });
    w.addEventListener('online', online);
    w.addEventListener('offline', offline);
    this.unlisten.push(() => w.removeEventListener('online', online), () => w.removeEventListener('offline', offline));
    try { if (typeof navigator !== 'undefined' && navigator.onLine === false) this.setStatus({ browserOffline: true }); } catch { /* */ }
  }

  // --- Présence et messages éphémères -------------------------------------------------------

  private presenceMeta: PresenceMeta = {};
  private subscribed = false;
  private channelRef: ReturnType<typeof catalogSupabase.channel> | null = null;

  /** Met à jour ce qu'on annonce aux autres (enregistre, écoute, couleur…). */
  setPresence(patch: PresenceMeta) {
    const next = { ...this.presenceMeta, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.presenceMeta)) return;
    this.presenceMeta = next;
    const ch = this.channel || this.channelRef;
    if (ch && this.subscribed && !this.closed) {
      try { void Promise.resolve(ch.track({ name: this.name, role: this.role, ...next })).catch(() => { /* réessayé à la reconnexion */ }); } catch { /* */ }
    }
  }
  getPresence(): PresenceMeta { return this.presenceMeta; }

  /**
   * Message éphémère par le direct seulement (pas de journal) : la lecture de
   * l'hôte. Renvoie false si le direct est coupé (l'appelant passe alors par le journal).
   */
  broadcast(event: EphemeralEvent, payload: Record<string, unknown>): boolean {
    const ch = this.channel || this.channelRef;
    if (!ch || !this.subscribed || this.closed) return false;
    try { void Promise.resolve(ch.send({ type: 'broadcast', event, payload })).catch(() => { /* */ }); return true; } catch { return false; }
  }

  /** Message éphémère reçu (voir broadcast). */
  onEphemeral?: (event: EphemeralEvent, payload: any) => void;

  /** « Réessayer » : rattrapage et envoi tout de suite (sans attendre les 10 s). */
  async retryNow(): Promise<void> {
    this.setStatus({ lastError: null });
    await this.catchUp();
    await this.flush();
  }

  // --- Envoi ----------------------------------------------------------------------------------

  /**
   * Publie une opération (journal + direct). Lève une erreur si le serveur ne
   * répond pas : préférer `queue` (file d'envoi) pour ce qui ne doit pas se perdre.
   */
  async send(kind: string, op: unknown): Promise<number> {
    const body = { ...(op as Record<string, unknown>), _id: (op as any)?._id || newOpId(), _d: this.deviceId, _p: this.pageId };
    remember(this.seenIds, body._id as string); // notre écho n'est jamais rejoué
    let r: { seq: number; role: CollabRole; author_name: string; member_key: string; created_at: string };
    const t0 = Date.now();
    try {
      r = await call('op', this.body({ kind, op: body }));
    } catch (e: any) {
      const status = Number(e?.status) || 0;
      // Plus membre (serveur mis à jour en pleine session, ménage…) : on rejoint, puis un essai.
      if (status === 403 && /Rejoins/i.test(String(e?.message || '')) && !(op as any)?._rejoined) {
        try {
          await call('join', this.body({ role: this.role, name: this.name }));
          return await this.send(kind, { ...(op as Record<string, unknown>), _id: body._id, _rejoined: true });
        } catch { /* l'erreur d'origine est remontée */ }
      }
      // Refus définitif (opération invalide ou trop grosse) : la réessayer ne sert à rien.
      if (status === 400 || status === 413 || status === 422) {
        const err = new Error(status === 413
          ? "Une modification trop lourde n'a pas pu partir (plus de 1,5 Mo de réglages ou de notes d'un coup)."
          : `Une modification a été refusée par le serveur (${e?.message || 'invalide'}).`) as Error & { permanent?: boolean; status?: number };
        err.permanent = true; err.status = status;
        this.setStatus({ reachable: true });
        throw err;
      }
      this.setStatus({ reachable: status ? true : false, lastError: e?.message || 'Erreur réseau' });
      throw e;
    }
    this.noteRtt(Date.now() - t0);
    this.setStatus({ reachable: true });
    const full: CollabOp = { seq: r.seq, kind, op: body, role: r.role, author_name: r.author_name, member_key: r.member_key, created_at: r.created_at };
    remember(this.applied, r.seq); // nos propres opérations ne sont jamais rejouées
    if (r.seq > this.horizon) this.horizon = r.seq;
    try { void Promise.resolve(this.channel?.send({ type: 'broadcast', event: 'op', payload: full })).catch(() => { /* le rattrapage la livrera */ }); } catch { /* */ }
    this.onSent?.(kind, body, r.seq);
    return r.seq;
  }

  /** Modification refusée pour de bon par le serveur (retirée de la file d'envoi). */
  onDropped?: (kind: string, op: Record<string, unknown>, error: string) => void;

  /** Notre opération est enregistrée (numéro du journal) : pour la règle « dernière écriture gagne ». */
  onSent?: (kind: string, op: Record<string, unknown>, seq: number) => void;

  /** Met une modification dans la file d'envoi (une par clé) et l'envoie dès que possible. */
  queue(key: string, kind: string, op: Record<string, unknown>) {
    this.outbox.put(key, kind, op);
    void this.flush();
  }

  flush() {
    if (this.closed || !this.memberKey) return Promise.resolve({ sent: 0, failed: false });
    return this.outbox.flush();
  }

  // --- Réception ------------------------------------------------------------------------------

  // Les numéros sont communs à toutes les sessions : on ne compte pas sur une
  // suite continue. Chaque opération est appliquée une seule fois ; le
  // rattrapage (connexion, puis toutes les 10 s) récupère ce qui a été manqué.
  private applied = new Set<number>();
  private seenIds = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  /** Opérations antérieures à l'instantané chargé : déjà dedans. */
  private floorSeq = 0;
  /** Opérations dont l'application a échoué (audio non téléchargé…) : réessayées. */
  private failed = new Map<number, { o: CollabOp; tries: number }>();

  /**
   * Opération envoyée par cette page (ou, pour les anciennes, par cet appareil,
   * ou encore avant par notre clé de membre). Une opération de cet appareil
   * envoyée avant un rechargement n'est PAS dans l'état chargé : elle est rejouée.
   */
  private isMine(o: CollabOp): boolean {
    const d = o.op && typeof o.op === 'object' ? o.op._d : undefined;
    const pg = o.op && typeof o.op === 'object' ? o.op._p : undefined;
    if (typeof d === 'string') return d === this.deviceId && (typeof pg !== 'string' || pg === this.pageId);
    return o.member_key === this.memberKey;
  }

  private apply(o: CollabOp) {
    if (!o || typeof o.seq !== 'number' || !Number.isFinite(o.seq) || typeof o.kind !== 'string') return;
    if (o.seq > this.horizon) this.horizon = o.seq;
    if (this.applied.has(o.seq) || o.seq <= this.floorSeq) return;
    remember(this.applied, o.seq);
    const id = o.op && typeof o.op === 'object' && typeof o.op._id === 'string' ? o.op._id : null;
    // Même opération renvoyée (réponse perdue puis nouvel essai) : un autre numéro, le même identifiant.
    if (id) { if (this.seenIds.has(id)) return; remember(this.seenIds, id); }
    if (this.isMine(o)) return;
    this.enqueue(o.seq <= this.joinSeq ? { ...o, replay: true } : o);
  }

  private enqueue(o: CollabOp) {
    this.pending.add(o.seq);
    // Application en série : une opération lente (téléchargement) ne double pas la suivante.
    this.chain = this.chain.then(async () => {
      if (this.closed) return;
      try {
        await this.onOp(o);
        this.failed.delete(o.seq);
      } catch (e) {
        // Avant : marquée appliquée quand même, le clip restait muet sans retour.
        const tries = (this.failed.get(o.seq)?.tries || 0) + 1;
        if (tries < 6) this.failed.set(o.seq, { o, tries });
        else { this.failed.delete(o.seq); this.setStatus({ failedOps: this.status.failedOps + 1 }); this.onFailure?.(o); }
        console.warn('[Collab] opération', o.kind, e);
      } finally {
        this.pending.delete(o.seq);
      }
    });
  }

  /** Appelé quand une opération reste impossible à appliquer après plusieurs essais. */
  onFailure?: (o: CollabOp) => void;

  private async receive(o: CollabOp) { this.apply(o); }

  private timer: ReturnType<typeof setInterval> | null = null;
  // Un appel pendant un rattrapage attend celui-ci (avant : il rendait la main
  // aussitôt, et join() se terminait avant d'avoir lu les opérations manquées).
  catchUp(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.catchUpRun) this.catchUpRun = this.runCatchUp().finally(() => { this.catchUpRun = null; });
    return this.catchUpRun;
  }

  private async runCatchUp() {
    this.setStatus({ catchingUp: true });
    try {
      // Réessai des opérations en échec (sauf celles déjà en file : sinon appliquées deux fois).
      for (const { o } of this.failed.values()) {
        if (this.pending.has(o.seq)) continue;
        this.enqueue(o);
      }
      // Numéros communs à toutes les sessions : une opération validée un instant
      // après une autre peut porter un numéro plus petit. On relit donc une petite
      // marge en arrière (les doublons sont écartés par « applied »).
      let after = Math.max(this.floorSeq, this.lastSeq - 50);
      for (let round = 0; round < 20; round++) {
        const r = await call<{ ops: CollabOp[] }>('ops_since', this.body({ after }));
        if (this.closed) return;
        const ops = Array.isArray(r?.ops) ? r.ops : [];
        ops.forEach(o => this.apply(o));
        if (ops.length) { this.lastSeq = Math.max(this.lastSeq, ...ops.map(o => o.seq)); after = Math.max(after, ...ops.map(o => o.seq)); }
        if (ops.length < 500) break;
      }
      this.setStatus({ reachable: true, catchingUp: false, lastSyncAt: Date.now(), lastError: null });
    } catch (e: any) {
      console.warn('[Collab] rattrapage', e);
      if (!this.closed) this.setStatus({ reachable: false, catchingUp: false, lastError: e?.message || 'Erreur réseau' });
    }
  }

  async leave() {
    this.closed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.unlisten.forEach(u => u());
    this.unlisten = [];
    try { if (this.channel || this.channelRef) await catalogSupabase.removeChannel((this.channel || this.channelRef)!); } catch { /* */ }
    this.channel = null;
    this.channelRef = null;
    this.subscribed = false;
    this.statusListeners.clear();
  }
}

// --- Audio des prises ----------------------------------------------------------------

const uploaded = new Map<string, { parts: string[]; size: number }>();

/**
 * Envoie l'audio des buffers donnés (si pas déjà en ligne) ; renvoie leurs morceaux.
 * Reprise : le serveur ne redemande que les morceaux absents (SHA-1) ; un envoi
 * coupé reprend donc là où il s'était arrêté, sans renvoyer ce qui est parti.
 * onProgress : octets envoyés / à envoyer (pour la barre de progression).
 */
export async function uploadBuffers(link: CloudLink, bufferIds: string[], onProgress?: (sent: number, total: number) => void): Promise<AudioRefs> {
  const out: AudioRefs = {};
  const chunks = new Map<string, Uint8Array>();
  for (const id of bufferIds) {
    const done = uploaded.get(id);
    if (done) { out[id] = done; continue; }
    const buf = audioBufferRegistry.get(id);
    if (!buf) continue;
    const bytes = new Uint8Array(await wavOf(buf).arrayBuffer());
    const parts: string[] = [];
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const part = bytes.subarray(off, Math.min(bytes.length, off + CHUNK));
      const h = await sha1(part);
      parts.push(h);
      chunks.set(h, part);
    }
    out[id] = { parts, size: bytes.length };
  }
  const hashes = Array.from(chunks.keys());
  const missing: { hash: string; path: string; token: string }[] = [];
  for (let i = 0; i < hashes.length; i += 150) {
    const r = await call<{ uploads: Record<string, { path: string; token: string }> }>('sign_upload', { id: link.id, secret: link.secret, parts: hashes.slice(i, i + 150) });
    for (const [hash, u] of Object.entries(r.uploads || {})) if (chunks.has(hash)) missing.push({ hash, ...u });
  }
  const total = missing.reduce((s, m) => s + chunks.get(m.hash)!.length, 0);
  let sent = 0;
  if (total > 0) onProgress?.(0, total);
  try {
    for (const m of missing) {
      const data = chunks.get(m.hash)!;
      const { error } = await catalogSupabase.storage.from('daw-sessions')
        .uploadToSignedUrl(m.path.replace(/^daw-sessions\//, ''), m.token, new Blob([data], { type: 'application/octet-stream' }));
      if (error) throw new Error(`Envoi de l'audio impossible : ${error.message}`);
      sent += data.length;
      onProgress?.(sent, total);
    }
  } finally {
    if (total > 0 && sent < total) onProgress?.(total, total); // fin (réussie ou non) : plus de barre
  }
  Object.entries(out).forEach(([id, ref]) => uploaded.set(id, ref));
  return out;
}

/** Télécharge et enregistre les buffers manquants d'une opération reçue. */
export async function ensureBuffers(link: CloudLink, audio: AudioRefs | undefined): Promise<void> {
  const missing = Object.entries(audio || {}).filter(([id]) => !audioBufferRegistry.has(id));
  if (!missing.length) return;
  await audioEngine.init();
  const parts = Array.from(new Set(missing.flatMap(([, r]) => r.parts)));
  const urls: Record<string, string> = {};
  for (let i = 0; i < parts.length; i += 150) {
    const r = await call<{ urls: Record<string, string> }>('urls', { id: link.id, secret: link.secret, parts: parts.slice(i, i + 150) });
    Object.assign(urls, r.urls);
  }
  for (const [id, ref] of missing) {
    const buf = new Uint8Array(ref.size);
    let off = 0;
    for (const p of ref.parts) {
      // Morceau pas encore en ligne (l'autre est encore en train de l'envoyer) : réessayé au rattrapage.
      if (!urls[p]) throw new Error("Audio pas encore en ligne : il arrive dans un instant.");
      const res = await fetch(urls[p]);
      if (!res.ok) throw new Error(`Audio introuvable (${res.status})`);
      const b = new Uint8Array(await res.arrayBuffer());
      buf.set(b.subarray(0, Math.max(0, ref.size - off)), off);
      off += b.length;
    }
    const decoded = await audioEngine.ctx!.decodeAudioData(buf.buffer.slice(0));
    audioBufferRegistry.register(decoded, id);
    uploaded.set(id, ref); // déjà en ligne : jamais renvoyé
  }
}

// --- Domaines : qui possède quoi --------------------------------------------------------

/** Piste dont l'artiste possède les prises (voix). */
export const isVocalTrack = isVocalTrackPure;

/**
 * Pistes dont le contenu (clips, motifs) appartient au rôle donné — et à
 * cette personne si on la donne (« Feat à distance » : voir utils/collabPeers).
 */
export const ownsContent: (t: Track, role: CollabRole, participant?: string | null) => boolean = ownsContentPure;

const clipForWire = (c: Clip): Clip => {
  const { buffer: _b, audioRef: _a, isFreezeSlice: _f, ...rest } = c as Clip & { buffer?: AudioBuffer };
  return rest as Clip;
};

/** Contenu d'une piste à envoyer (sans les réglages de mix, qui sont à l'ingé). */
export const contentOf = (t: Track) => ({
  name: t.name, type: t.type, color: t.color, outputTrackId: t.outputTrackId,
  collabOwner: t.collabOwner,
  // Propriétaire nommé (« Feat à distance ») : ignoré par les anciennes versions de NOVA.
  ...(t.collabOwnerKey ? { collabOwnerKey: t.collabOwnerKey, collabOwnerName: t.collabOwnerName, collabOwnerColor: t.collabOwnerColor } : {}),
  drumMachine: t.drumMachine, bass808: t.bass808,
  // Piste guide (R3) : null = pas un guide (absent : ancienne version). Couper le guide reste un choix d'écoute local.
  guide: t.isGuide ? { level: t.guideLevel ?? null } : null,
  // Synthé NOVA : null = ancien synthé (les versions précédentes ignorent ce champ).
  ...(t.type === 'MIDI' ? { novaSynth: t.novaSynth ?? null } : {}),
  // Sampler mélodique / instrument (R18, R20) : null = synthé. Champ absent d'une ancienne version.
  ...(t.type === 'MIDI' && t.melodicSampler ? { melodicSampler: t.melodicSampler } : t.type === 'MIDI' ? { melodicSampler: null } : {}),
  drumPads: t.drumPads?.map(p => { const { buffer: _b, ...r } = p as any; return r; }),
  clips: (t.clips || []).map(clipForWire),
  // Couloirs de prises (noms, heures, tours de boucle) : champ ajouté. L'audio
  // des prises et le comp sont déjà dans les clips ; une ancienne version
  // ignore ce champ et joue le comp. Absent (piste sans prise) : rien
  // d'envoyé, le contenu reste identique à celui d'une ancienne version.
  takeMeta: t.takeMeta && t.takeMeta.length ? t.takeMeta : undefined,
  // Respirations (rôle de la piste pour le traitement auto) : champ ajouté, ignoré des anciennes versions.
  ...(t.breathKind ? { breathKind: t.breathKind } : {}),
  // Instrument VST du PC : le rendu des notes voyage avec la piste (sans
  // l'état du plugin, lourd et inutile à qui n'a pas le VST).
  vstInstrument: t.vstInstrument ? { ...t.vstInstrument, stateB64: undefined } : undefined,
  instrumentRender: t.vstInstrument && t.isFrozen && t.frozenClip
    ? { frozenClip: clipForWire(t.frozenClip), frozenClipIds: t.frozenClipIds, frozenSourceSig: t.frozenSourceSig }
    : undefined,
});

/** Audio à envoyer avec le contenu d'une piste (prises, rendu d'instrument VST, samples perso des pads). */
export const contentBufferIds = (t: Track): string[] => Array.from(new Set([
  // Jamais le son d'un beat non acheté.
  ...(t.clips || []).filter(c => !c.isUnlicensed).map(c => c.bufferId),
  // Son d'origine des clips retouchés (justesse, Melodyne / VocAlign, AudioSuite,
  // transposition) : l'autre peut revenir à la prise d'origine ou retoucher à
  // nouveau. Déjà en ligne la plupart du temps (c'était la prise) : rien de plus à envoyer.
  ...(t.clips || []).filter(c => !c.isUnlicensed).flatMap(c => [c.pitchEdit?.sourceBufferId, c.araEdit?.sourceBufferId, c.audioSuite?.sourceBufferId, c.elastic?.sourceBufferId]),
  t.vstInstrument && t.isFrozen ? t.frozenClip?.bufferId : undefined,
  // Batterie : sans eux, les pads perso (samples glissés, tranches d'une découpe)
  // restaient muets chez l'autre (motifs et réglages arrivaient, pas le son).
  ...Object.keys((t as any).drumMachine?.samples || {}).map(padSampleKey),
  // Sampler mélodique (R18) : son perso (les instruments R20 sont sur le site, rien à envoyer).
  t.melodicSampler?.sampleId ? samplerBufferKey(t.melodicSampler.sampleId) : undefined,
].filter(Boolean) as string[]));
export const mixOf = (t: Track) => ({
  volume: t.volumeLock ? undefined : t.volume, pan: t.pan, isMuted: t.isMuted,
  sends: t.sends, plugins: t.plugins, outputTrackId: t.outputTrackId,
  // Structure Pro Tools (masquée, inactive, dossier, VCA, bus) : ignorée par les anciennes versions.
  structure: structureOf(t),
});

export const sigOf = (v: unknown): string => {
  const s = JSON.stringify(v) || '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length}:${h.toString(16)}`;
};
