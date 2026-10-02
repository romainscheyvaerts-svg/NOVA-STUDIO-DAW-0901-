import { catalogSupabase } from './supabase';
import { call, sha1, CHUNK, CloudLink } from './SessionCloud';
import { wavOf } from './AudioUtils';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { audioEngine } from '../engine/AudioEngine';
import { Clip, CollabRole, Track } from '../types';

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
}
export interface CollabMember { member_key: string; role: CollabRole; display_name: string; online?: boolean }
export type AudioRefs = Record<string, { parts: string[]; size: number }>;

export const collabDeviceId = (): string => {
  try {
    let id = localStorage.getItem('nova_device_id');
    if (!id) { id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem('nova_device_id', id); }
    return id;
  } catch { return `tmp${Math.random().toString(36).slice(2, 10)}`; }
};

export class CollabClient {
  memberKey = '';
  lastSeq = 0;
  private channel: ReturnType<typeof catalogSupabase.channel> | null = null;
  private catchingUp = false;

  constructor(
    public link: CloudLink,
    public role: CollabRole,
    public name: string,
    private onOp: (op: CollabOp) => Promise<void> | void,
    private onPresence: (members: CollabMember[]) => void,
  ) {}

  private body(extra: Record<string, unknown> = {}) {
    return { id: this.link.id, secret: this.link.secret, device_id: collabDeviceId(), ...extra };
  }

  /** Rejoint la session (rôle), se branche au canal en direct, rattrape les opérations depuis `fromSeq`. */
  async join(fromSeq: number): Promise<CollabMember[]> {
    const r = await call<{ member_key: string; last_seq: number; members: CollabMember[]; channel: string }>('join', this.body({ role: this.role, name: this.name }));
    this.memberKey = r.member_key;
    this.lastSeq = Math.max(0, fromSeq);
    this.floorSeq = this.lastSeq;
    const ch = catalogSupabase.channel(r.channel, { config: { broadcast: { self: false }, presence: { key: this.memberKey } } });
    ch.on('broadcast', { event: 'op' }, ({ payload }) => { void this.receive(payload as CollabOp); });
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState() as Record<string, { name: string; role: CollabRole }[]>;
      const online = Object.entries(state).map(([key, metas]) => ({ member_key: key, role: metas[0]?.role, display_name: metas[0]?.name, online: true }));
      this.onPresence(online as CollabMember[]);
    });
    await new Promise<void>((resolve) => {
      ch.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await ch.track({ name: this.name, role: this.role });
          resolve();
        }
        // Reconnexion : on rattrape ce qui a été manqué.
        if (status === 'SUBSCRIBED' && this.lastSeq > 0) void this.catchUp();
      });
      setTimeout(resolve, 6000);
    });
    this.channel = ch;
    await this.catchUp();
    return r.members;
  }

  /** Publie une opération (journal + direct). */
  async send(kind: string, op: unknown): Promise<number> {
    const r = await call<{ seq: number; role: CollabRole; author_name: string; member_key: string; created_at: string }>('op', this.body({ kind, op }));
    const full: CollabOp = { seq: r.seq, kind, op, role: r.role, author_name: r.author_name, member_key: r.member_key, created_at: r.created_at };
    this.applied.add(r.seq); // nos propres opérations ne sont jamais rejouées
    void this.channel?.send({ type: 'broadcast', event: 'op', payload: full });
    return r.seq;
  }

  // Les numéros sont communs à toutes les sessions : on ne compte pas sur une
  // suite continue. Chaque opération est appliquée une seule fois ; le
  // rattrapage (connexion, puis toutes les 10 s) récupère ce qui a été manqué.
  private applied = new Set<number>();
  private chain: Promise<void> = Promise.resolve();
  /** Opérations antérieures à l'instantané chargé : déjà dedans. */
  private floorSeq = 0;
  /** Opérations dont l'application a échoué (audio non téléchargé…) : réessayées. */
  private failed = new Map<number, { o: CollabOp; tries: number }>();

  private apply(o: CollabOp) {
    if (!o || typeof o.seq !== 'number' || this.applied.has(o.seq) || o.seq <= this.floorSeq) return;
    this.applied.add(o.seq);
    if (o.member_key === this.memberKey) return;
    // Application en série : une opération lente (téléchargement) ne double pas la suivante.
    this.chain = this.chain.then(async () => {
      try {
        await this.onOp(o);
        this.failed.delete(o.seq);
      } catch (e) {
        // Avant : marquée appliquée quand même, le clip restait muet sans retour.
        const tries = (this.failed.get(o.seq)?.tries || 0) + 1;
        if (tries < 6) this.failed.set(o.seq, { o, tries });
        else { this.failed.delete(o.seq); this.onFailure?.(o); }
        console.warn('[Collab] opération', o.kind, e);
      }
    });
  }

  /** Appelé quand une opération reste impossible à appliquer après plusieurs essais. */
  onFailure?: (o: CollabOp) => void;

  private async receive(o: CollabOp) { this.apply(o); }

  private timer: ReturnType<typeof setInterval> | null = null;
  async catchUp() {
    if (this.catchingUp) return;
    this.catchingUp = true;
    try {
      // Réessai des opérations en échec.
      for (const { o } of this.failed.values()) { this.applied.delete(o.seq); this.apply(o); }
      // Numéros communs à toutes les sessions : une opération validée un instant
      // après une autre peut porter un numéro plus petit. On relit donc une petite
      // marge en arrière (les doublons sont écartés par « applied »).
      let after = Math.max(this.floorSeq, this.lastSeq - 50);
      for (let round = 0; round < 20; round++) {
        const r = await call<{ ops: CollabOp[] }>('ops_since', this.body({ after }));
        r.ops.forEach(o => this.apply(o));
        if (r.ops.length) { this.lastSeq = Math.max(this.lastSeq, ...r.ops.map(o => o.seq)); after = Math.max(after, ...r.ops.map(o => o.seq)); }
        if (r.ops.length < 500) break;
      }
      // Hors de la marge relue, plus besoin de mémoriser.
      this.applied.forEach(seq => { if (seq < this.lastSeq - 200) this.applied.delete(seq); });
      if (!this.timer) this.timer = setInterval(() => { void this.catchUp(); }, 10000);
    } catch (e) {
      console.warn('[Collab] rattrapage', e);
    } finally {
      this.catchingUp = false;
    }
  }

  async leave() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { if (this.channel) await catalogSupabase.removeChannel(this.channel); } catch { /* */ }
    this.channel = null;
  }
}

// --- Audio des prises ----------------------------------------------------------------

const uploaded = new Map<string, { parts: string[]; size: number }>();

/** Envoie l'audio des buffers donnés (si pas déjà en ligne) ; renvoie leurs morceaux. */
export async function uploadBuffers(link: CloudLink, bufferIds: string[]): Promise<AudioRefs> {
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
  for (let i = 0; i < hashes.length; i += 150) {
    const r = await call<{ uploads: Record<string, { path: string; token: string }> }>('sign_upload', { id: link.id, secret: link.secret, parts: hashes.slice(i, i + 150) });
    for (const [hash, u] of Object.entries(r.uploads || {})) {
      const { error } = await catalogSupabase.storage.from('daw-sessions')
        .uploadToSignedUrl(u.path.replace(/^daw-sessions\//, ''), u.token, new Blob([chunks.get(hash)!], { type: 'application/octet-stream' }));
      if (error) throw new Error(`Envoi de l'audio impossible : ${error.message}`);
    }
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
export const isVocalTrack = (t: Track): boolean =>
  t.type === 'AUDIO' && t.id !== 'instrumental' && !t.instrumentId && (t.collabOwner ?? 'artist') === 'artist';

/** Pistes dont le contenu (clips, motifs) appartient au rôle donné. */
export const ownsContent = (t: Track, role: CollabRole): boolean => {
  if (t.id === 'instrumental' || t.id === 'master' || t.type === 'BUS' || t.type === 'SEND') return false;
  const owner = t.collabOwner ?? (isVocalTrack(t) ? 'artist' : t.type === 'DRUM_RACK' || t.type === 'MIDI' || t.type === 'SAMPLER' ? 'beatmaker' : null);
  return owner === role;
};

const clipForWire = (c: Clip): Clip => {
  const { buffer: _b, audioRef: _a, isFreezeSlice: _f, ...rest } = c as Clip & { buffer?: AudioBuffer };
  return rest as Clip;
};

/** Contenu d'une piste à envoyer (sans les réglages de mix, qui sont à l'ingé). */
export const contentOf = (t: Track) => ({
  name: t.name, type: t.type, color: t.color, outputTrackId: t.outputTrackId,
  collabOwner: t.collabOwner, drumMachine: t.drumMachine, drumPads: t.drumPads?.map(p => { const { buffer: _b, ...r } = p as any; return r; }),
  clips: (t.clips || []).map(clipForWire),
  // Instrument VST du PC : le rendu des notes voyage avec la piste (sans
  // l'état du plugin, lourd et inutile à qui n'a pas le VST).
  vstInstrument: t.vstInstrument ? { ...t.vstInstrument, stateB64: undefined } : undefined,
  instrumentRender: t.vstInstrument && t.isFrozen && t.frozenClip
    ? { frozenClip: clipForWire(t.frozenClip), frozenClipIds: t.frozenClipIds, frozenSourceSig: t.frozenSourceSig }
    : undefined,
});

/** Audio à envoyer avec le contenu d'une piste (prises + rendu d'instrument VST). */
export const contentBufferIds = (t: Track): string[] => Array.from(new Set([
  ...(t.clips || []).map(c => c.bufferId),
  t.vstInstrument && t.isFrozen ? t.frozenClip?.bufferId : undefined,
].filter(Boolean) as string[]));
export const mixOf = (t: Track) => ({
  volume: t.volumeLock ? undefined : t.volume, pan: t.pan, isMuted: t.isMuted,
  sends: t.sends, plugins: t.plugins, outputTrackId: t.outputTrackId,
});

export const sigOf = (v: unknown): string => {
  const s = JSON.stringify(v) || '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length}:${h.toString(16)}`;
};
