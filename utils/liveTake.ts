/**
 * Prise envoyée pendant l'enregistrement (B3) : découpage, file d'envoi (reprise après
 * coupure ou fermeture de l'onglet), réception et recollage au bit près.
 *
 * Avant : la prise partait APRÈS le STOP, d'un bloc (WAV 16 bits) ; une prise de 3 min
 * en stéréo = 35 Mo, soit près de 5 min d'envoi sur 1 Mb/s montant.
 * Ici, chez celui qui enregistre :
 *  - SegmentCutter : les échantillons captés (journal de prise) sont coupés en morceaux
 *    de ~1 s, codés sans perte (utils/liveTakeCodec) ;
 *  - LiveTakeSender : chaque morceau est gardé (IndexedDB) puis envoyé dans l'ordre :
 *    audio en ligne (morceau nommé par son SHA-1, comme les autres fichiers de la session),
 *    puis opération « take_seg » dans le journal de la session. Au STOP, une opération
 *    « take_end » dit quel passage forme la prise et sa somme de contrôle. Rien n'est
 *    effacé de l'appareil avant d'être confirmé par le serveur ; coupure ou onglet fermé :
 *    tout repart au retour, dans l'ordre, sans doublon (identifiants fixes).
 * Chez les autres :
 *  - LiveTakeAssembly : les morceaux reçus (somme vérifiée) sont recollés ; la prise n'est
 *    posée qu'une fois COMPLÈTE et sa somme (CRC-32 du PCM 24 bits) vérifiée.
 * Le serveur ne change pas (mêmes actions daw-session : sign_upload, op, urls).
 */

import { decodeSegment, encodeSegment, fromInt24, Pcm24Crc, toInt24 } from './liveTakeCodec';

/** Durée d’un morceau envoyé pendant la prise (s) : au STOP, il reste ~1 s de son à envoyer. */
export const LT_SEGMENT_SEC = 1;
/** Morceaux annoncés par opération au plus (rattrapage après une coupure). */
export const LT_BATCH = 12;

export interface LiveRef {
  /** Prise (identifiant de l'envoi en direct). */
  t: string;
  /** Morceaux (0 … n−1). */
  n: number;
  /** Premières images du flux qui ne font pas partie de la prise (décompte, latence). */
  from: number;
  /** Images de la prise. */
  frames: number;
  ch: number;
  sr: number;
  /** Somme de contrôle de la prise entière (« images:crc32 » du PCM 24 bits). */
  sum: string;
}

// --- Découpage --------------------------------------------------------------------------

/**
 * Reçoit les échantillons captés (mono, ou stéréo entrelacé comme le journal de prise)
 * et rend des morceaux de `segFrames` images, quantifiés en 24 bits.
 */
export class SegmentCutter {
  private bufs: Int32Array[];
  private fill = 0;
  /** Images reçues en tout. */
  total = 0;
  index = 0;
  constructor(public readonly channels: number, public readonly segFrames: number, private onSegment: (i: number, ints: Int32Array[]) => void) {
    this.bufs = Array.from({ length: channels }, () => new Int32Array(segFrames));
  }
  push(chunk: Float32Array) {
    const nc = this.channels;
    const frames = Math.floor(chunk.length / nc);
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < nc; c++) this.bufs[c][this.fill] = toInt24(chunk[f * nc + c]);
      if (++this.fill === this.segFrames) this.emit();
    }
    this.total += frames;
  }
  private emit() {
    if (!this.fill) return;
    const out = this.bufs.map(b => b.slice(0, this.fill));
    this.fill = 0;
    this.onSegment(this.index++, out);
  }
  /** Fin de la prise : le reste part comme dernier morceau. Renvoie le nombre de morceaux. */
  flush(): number { this.emit(); return this.index; }
}

// --- File d'envoi -----------------------------------------------------------------------

export interface LtItem {
  /** `${take}:${i}` (morceau) ou `${take}:end` / `${take}:cancel`. */
  key: string;
  /** Session en ligne (id du lien). */
  session: string;
  take: string;
  trackId: string;
  kind: 'seg' | 'end' | 'cancel';
  /** Ordre d'envoi (survit à un rechargement). */
  order: number;
  i?: number;
  bytes?: Uint8Array;
  frames?: number;
  ch?: number;
  sr?: number;
  /** take_end : la référence complète de la prise (bufferId compris). */
  ref?: LiveRef & { b: string };
  /**
   * Morceau déjà confirmé par le serveur, gardé sur l'appareil jusqu'à ce que la prise soit
   * posée chez les autres (onglet fermé puis rouvert : la prise se recolle sans réseau).
   */
  sent?: boolean;
}

export interface LtStore {
  all(): Promise<LtItem[]>;
  put(item: LtItem): Promise<void>;
  del(key: string): Promise<void>;
}

export const memoryLtStore = (): LtStore & { items: Map<string, LtItem> } => {
  const items = new Map<string, LtItem>();
  return {
    items,
    all: async () => [...items.values()],
    put: async (it) => { items.set(it.key, { ...it }); },
    del: async (k) => { items.delete(k); },
  };
};

export interface LtTransport {
  /** Session à laquelle on est relié (null : pas de collaboration en cours). */
  session(): string | null;
  hash(bytes: Uint8Array): Promise<string>;
  /** Met en ligne les morceaux pas encore présents (même stockage que l'audio des prises). */
  upload(parts: { hash: string; bytes: Uint8Array }[]): Promise<void>;
  /**
   * En deux temps (facultatif) : adresse d'envoi (null : déjà en ligne), puis envoi. Permet de
   * demander l'adresse du morceau suivant pendant que celui-ci part (pas de temps mort).
   */
  sign?(hash: string): Promise<unknown | null>;
  put?(hash: string, bytes: Uint8Array, ticket: unknown): Promise<void>;
  /** Opération dans le journal de la session (lève une erreur si le serveur ne répond pas). */
  send(kind: string, op: Record<string, unknown>): Promise<void>;
}

export interface TakeProgress {
  take: string;
  trackId: string;
  /** Octets confirmés / à envoyer (morceaux connus). */
  sent: number;
  total: number;
  /** Prise arrêtée (STOP) : plus de morceau à venir. */
  ended: boolean;
  /** Tout est confirmé par le serveur (morceaux + fin). */
  done: boolean;
  cancelled?: boolean;
  /** Reçue et vérifiée par… (noms). */
  receivedBy: string[];
  /** Envoi en attente du réseau. */
  waiting: boolean;
  /** Images envoyées (pendant la prise). */
  framesSent: number;
  sr: number;
  /** Instant où tout a été confirmé / où la 1re réception a été annoncée. */
  doneAt?: number;
  receivedAt?: number;
}

let orderSeq = 0;
export const nextOrder = () => Date.now() * 1000 + (orderSeq = (orderSeq + 1) % 1000);

/**
 * Envoi dans l'ordre de ce qui est gardé sur l'appareil, en deux étages qui travaillent en
 * même temps : l'audio des morceaux part au fil de l'eau (l'adresse du suivant est demandée
 * pendant l'envoi du précédent), et les annonces (« take_seg », « take_end ») suivent dans
 * l'ordre, groupées si plusieurs morceaux attendent. Un élément n'est retiré de l'appareil
 * qu'après la réponse du serveur ; une réponse perdue fait renvoyer le même identifiant
 * d'opération (_id fixe) : les autres l'appliquent une seule fois.
 */
export class LiveTakeSender {
  private queue: LtItem[] = [];
  private loaded = false;
  private uploading: Promise<void> | null = null;
  private announcing: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 500;
  private progress = new Map<string, TakeProgress>();
  private listeners = new Set<() => void>();
  /** Morceaux déjà en ligne (en mémoire : après un rechargement, le serveur le redit). */
  private up = new WeakSet<LtItem>();
  private hashes = new WeakMap<LtItem, string>();
  waiting = false;
  /** Morceaux mis dans la file, en attente d'écriture sur l'appareil. */
  private writes: Promise<void> = Promise.resolve();

  /** keepSent : les morceaux confirmés restent sur l'appareil jusqu'à purge(prise). */
  constructor(private store: LtStore, private transport: LtTransport, private opts: { batch?: number; maxBackoff?: number; keepSent?: boolean } = {}) {}

  onChange(cb: () => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  private changed() { this.listeners.forEach(cb => { try { cb(); } catch { /* */ } }); }

  /** Reprise : ce qui était gardé sur l'appareil (onglet fermé avant la fin de l'envoi). */
  async load(): Promise<LtItem[]> {
    if (this.loaded) return this.queue;
    this.loaded = true;
    let saved: LtItem[] = [];
    try { saved = await this.store.all(); } catch { saved = []; }
    const known = new Set(this.queue.map(x => x.key));
    for (const it of saved) if (!known.has(it.key) && !it.sent) { this.queue.push(it); this.track(it); }
    this.queue.sort((a, b) => a.order - b.order);
    this.changed();
    return this.queue;
  }

  private track(it: LtItem) {
    const p = this.progress.get(it.take) || { take: it.take, trackId: it.trackId, sent: 0, total: 0, ended: false, done: false, receivedBy: [], waiting: false, framesSent: 0, sr: it.sr || 48000 };
    if (it.kind === 'seg') p.total += it.bytes?.length || 0;
    if (it.kind === 'end' || it.kind === 'cancel') { p.ended = true; if (it.kind === 'cancel') p.cancelled = true; }
    if (it.sr) p.sr = it.sr;
    p.done = false;
    this.progress.set(it.take, p);
  }

  /** Ajoute un élément (gardé sur l'appareil d'abord) et lance l'envoi. */
  enqueue(it: LtItem) {
    this.queue.push(it);
    this.queue.sort((a, b) => a.order - b.order);
    this.track(it);
    this.writes = this.writes.then(() => this.store.put(it)).catch(() => { /* stockage plein : l'envoi continue depuis la mémoire */ });
    this.changed();
    this.pump();
  }

  pending(session?: string | null): LtItem[] { return this.queue.filter(x => !session || x.session === session); }

  /** Tous les morceaux d'une prise gardés sur l'appareil (confirmés ou non), pour la recoller ici. */
  async storedSegments(take: string): Promise<LtItem[]> {
    await this.writes;
    let all: LtItem[] = [];
    try { all = await this.store.all(); } catch { all = []; }
    const mem = this.queue.filter(x => x.take === take && x.kind === 'seg');
    const byKey = new Map([...all.filter(x => x.take === take && x.kind === 'seg'), ...mem].map(x => [x.key, x]));
    return [...byKey.values()].sort((a, b) => (a.i ?? 0) - (b.i ?? 0));
  }

  /** Prise abandonnée (jetée, son venu du pont) : ses morceaux pas encore partis ne partent plus. */
  dropUnsent(take: string) {
    const gone = this.queue.filter(x => x.take === take && x.kind === 'seg' && !this.up.has(x));
    if (!gone.length) return;
    this.queue = this.queue.filter(x => !gone.includes(x));
    const p = this.progress.get(take);
    if (p) p.total -= gone.reduce((n, x) => n + (x.bytes?.length || 0), 0);
    this.writes = this.writes.then(async () => { for (const x of gone) await this.store.del(x.key); }).catch(() => { /* */ });
    this.changed();
  }

  /** La prise est posée chez les autres : ses morceaux gardés sur l'appareil sont effacés. */
  purge(take: string) {
    this.writes = this.writes.then(async () => {
      const all = await this.store.all();
      const queued = new Set(this.queue.map(x => x.key));
      for (const it of all) if (it.take === take && !queued.has(it.key)) await this.store.del(it.key);
    }).catch(() => { /* */ });
  }
  takeProgress(take: string): TakeProgress | null { return this.progress.get(take) || null; }
  allProgress(): TakeProgress[] { return [...this.progress.values()]; }

  /** L'autre a reçu et vérifié la prise. */
  markReceived(take: string, by: string) {
    const p = this.progress.get(take);
    if (!p || p.receivedBy.includes(by)) return;
    p.receivedBy = [...p.receivedBy, by];
    p.receivedAt = p.receivedAt || Date.now();
    this.changed();
  }

  /** Essaie tout de suite (retour du réseau, collaboration reprise). */
  kick() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.backoff = 500;
    this.pump();
  }

  pump() {
    if (!this.uploading) this.uploading = this.uploadLoop().finally(() => { this.uploading = null; });
    this.announce();
  }

  private announce() {
    if (!this.announcing) this.announcing = this.announceLoop().finally(() => { this.announcing = null; });
  }

  /** Tout ce qui est en file est parti (pour les tests). */
  async idle(): Promise<void> {
    while (this.uploading || this.announcing) { await this.uploading; await this.announcing; }
    await this.writes;
  }

  private nextToUpload(session: string, after?: LtItem): LtItem | undefined {
    let past = !after;
    for (const x of this.queue) {
      if (!past) { if (x === after) past = true; continue; }
      if (x.session === session && x.kind === 'seg' && !this.up.has(x)) return x;
    }
    return undefined;
  }

  private async hashOf(it: LtItem): Promise<string> {
    let h = this.hashes.get(it);
    if (!h) { h = await this.transport.hash(it.bytes!); this.hashes.set(it, h); }
    return h;
  }

  private async uploadLoop() {
    await this.writes;
    const t = this.transport;
    let pre: { it: LtItem; p: Promise<unknown | null> } | null = null;
    for (;;) {
      const session = t.session();
      const it = session ? this.nextToUpload(session) : undefined;
      if (!session || !it) return;
      try {
        const hash = await this.hashOf(it);
        if (t.sign && t.put) {
          const ticket = pre && pre.it === it ? await pre.p : await t.sign(hash);
          pre = null;
          // Adresse du morceau suivant demandée pendant que celui-ci part.
          const next = this.nextToUpload(session, it);
          if (next) { const nh = await this.hashOf(next); pre = { it: next, p: t.sign(nh) }; pre.p.catch(() => { /* redemandée */ }); }
          if (ticket) await t.put(hash, it.bytes!, ticket);
        } else {
          await t.upload([{ hash, bytes: it.bytes! }]);
        }
      } catch {
        pre = null;
        this.fail();
        return;
      }
      this.up.add(it);
      this.announce();
    }
  }

  private async announceLoop() {
    await this.writes;
    for (;;) {
      const session = this.transport.session();
      const head = session ? this.queue.find(x => x.session === session) : undefined;
      if (!session || !head) { this.setWaiting(false); return; }
      // Audio du morceau pas encore en ligne : l'étage d'envoi relance l'annonce quand il l'est.
      if (head.kind === 'seg' && !this.up.has(head)) return;
      const batch: LtItem[] = [head];
      if (head.kind === 'seg') {
        for (const it of this.queue) {
          if (batch.length >= (this.opts.batch || LT_BATCH)) break;
          if (it === head || it.session !== session) continue;
          if (it.take !== head.take || it.kind !== 'seg' || !this.up.has(it)) break;
          batch.push(it);
        }
      }
      try {
        if (head.kind === 'seg') {
          const first = batch[0].i!, last = batch[batch.length - 1].i!;
          const segs = await Promise.all(batch.map(async it => ({ i: it.i, h: await this.hashOf(it), n: it.frames, sz: it.bytes!.length, ch: it.ch, sr: it.sr })));
          await this.transport.send('take_seg', { _id: `lt:${head.take}:${first}-${last}`, t: head.take, trackId: head.trackId, segs });
        } else if (head.kind === 'end') {
          await this.transport.send('take_end', { _id: `lt:${head.take}:end`, trackId: head.trackId, ...head.ref! });
        } else {
          await this.transport.send('take_end', { _id: `lt:${head.take}:cancel`, t: head.take, trackId: head.trackId, cancel: true });
        }
      } catch (e: any) {
        // Refus définitif (opération invalide) : on n'insiste pas, sinon la file serait bloquée.
        if (e?.permanent) { batch.forEach(it => this.drop(it)); continue; }
        this.fail();
        return;
      }
      this.backoff = 500;
      this.setWaiting(false);
      for (const it of batch) this.drop(it, true);
    }
  }

  private fail() {
    this.setWaiting(true);
    if (this.retryTimer) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.opts.maxBackoff || 4000, this.backoff * 2);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.pump(); }, wait);
  }

  private drop(it: LtItem, sent = false) {
    this.queue = this.queue.filter(x => x !== it);
    const keep = sent && it.kind === 'seg' && this.opts.keepSent;
    this.writes = this.writes.then(() => (keep ? this.store.put({ ...it, sent: true }) : this.store.del(it.key))).catch(() => { /* */ });
    const p = this.progress.get(it.take);
    if (p) {
      if (sent && it.kind === 'seg') { p.sent += it.bytes?.length || 0; p.framesSent += it.frames || 0; }
      if (it.kind === 'end' || it.kind === 'cancel') p.ended = true;
      p.done = p.ended && !this.queue.some(x => x.take === it.take);
      if (p.done && !p.doneAt) p.doneAt = Date.now();
    }
    this.changed();
  }

  private setWaiting(w: boolean) {
    if (this.waiting === w) return;
    this.waiting = w;
    this.progress.forEach(p => { p.waiting = w && !p.done; });
    this.changed();
  }

  dispose() { if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = null; this.listeners.clear(); }
}

// --- Réception --------------------------------------------------------------------------

export interface SegMeta { i: number; h: string; n: number; sz?: number; ch?: number; sr?: number }

/** Résumé d'une prise reçue en direct (pour l'indicateur « en cours de réception »). */
export interface ReceptionView {
  take: string;
  trackId: string;
  from: string;
  /** reception → verification → prete (son complet et vérifié) → posee (dans la piste). */
  state: 'reception' | 'verification' | 'prete' | 'posee' | 'erreur' | 'annulee';
  /** Secondes reçues (morceaux décodés à la suite). */
  seconds: number;
  /** Crêtes (0..1) pour la forme d'onde, une par bloc de PEAK_FRAMES images. */
  peaks: number[];
  sr: number;
  error?: string;
  updatedAt: number;
}

export const PEAK_FRAMES = 2048;

/** Crêtes d'un morceau (forme d'onde qui avance pendant la prise). */
export const peaksOf = (ints: Int32Array[], block = PEAK_FRAMES): number[] => {
  const n = ints[0]?.length || 0;
  const out: number[] = [];
  for (let a = 0; a < n; a += block) {
    let m = 0;
    const b = Math.min(n, a + block);
    for (const c of ints) for (let i = a; i < b; i++) { const v = Math.abs(c[i]); if (v > m) m = v; }
    out.push(Math.min(1, m / 0x800000));
  }
  return out;
};

/**
 * Une prise en cours de réception : morceaux décodés (somme vérifiée), fin annoncée,
 * recollage au bit près et vérification de la somme de la prise entière.
 */
export class LiveTakeAssembly {
  segs = new Map<number, Int32Array[]>();
  meta = new Map<number, SegMeta>();
  end: (LiveRef & { b?: string }) | null = null;
  cancelled = false;
  peaks: number[] = [];
  private peaksUpTo = 0;
  constructor(public readonly take: string, public trackId: string, public from: string) {}

  addMeta(m: SegMeta) { if (!this.meta.has(m.i)) this.meta.set(m.i, m); }
  missingSegs(): SegMeta[] { return [...this.meta.values()].filter(m => !this.segs.has(m.i)).sort((a, b) => a.i - b.i); }

  /** Morceau téléchargé : décodé et vérifié (erreur si abîmé). */
  addBytes(i: number, bytes: Uint8Array) {
    if (this.segs.has(i)) return;
    const d = decodeSegment(bytes);
    const m = this.meta.get(i);
    if (m && m.n !== d.frames) throw new Error('Morceau de prise incomplet');
    this.segs.set(i, d.ints);
    while (this.segs.has(this.peaksUpTo)) { this.peaks.push(...peaksOf(this.segs.get(this.peaksUpTo)!)); this.peaksUpTo++; }
  }

  /** Images reçues à la suite depuis le début. */
  framesContiguous(): number {
    let f = 0;
    for (let i = 0; this.segs.has(i); i++) f += this.segs.get(i)![0].length;
    return f;
  }

  setEnd(ref: LiveRef & { b?: string }) { this.end = ref; }

  complete(): boolean {
    if (!this.end || this.cancelled) return false;
    for (let i = 0; i < this.end.n; i++) if (!this.segs.has(i)) return false;
    return true;
  }

  /**
   * Recolle la prise (images from … from+frames) dans des tableaux flottants et vérifie la
   * somme de la prise entière. Renvoie null si la somme ne correspond pas.
   */
  assemble(): { channels: Float32Array[]; sum: string } | null {
    if (!this.complete()) return null;
    const e = this.end!;
    const nc = Math.max(1, e.ch);
    const out = Array.from({ length: nc }, () => new Float32Array(e.frames));
    const crc = new Pcm24Crc();
    let pos = 0;   // position dans le flux
    let w = 0;     // images écrites
    for (let i = 0; i < e.n && w < e.frames; i++) {
      const s = this.segs.get(i)!;
      if (s.length !== nc) return null;
      const len = s[0].length;
      const a = Math.max(0, e.from - pos);
      const b = Math.min(len, a + (e.frames - w));
      if (b > a) {
        for (let c = 0; c < nc; c++) {
          const src = s[c], dst = out[c];
          for (let k = a; k < b; k++) dst[w + k - a] = fromInt24(src[k]);
        }
        crc.update(s, a, b);
        w += b - a;
      }
      pos += len;
    }
    if (w !== e.frames) return null;
    const sum = `${crc.frames}:${crc.value().toString(16).padStart(8, '0')}`;
    return sum === e.sum ? { channels: out, sum } : null;
  }
}

/** Retire de l'audio d'une opération les prises qui voyagent en direct (reçues autrement). */
export const withoutLive = <T,>(audio: Record<string, T> | undefined, live: Record<string, unknown> | undefined): Record<string, T> | undefined => {
  if (!audio || !live) return audio;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(audio)) if (!(k in live)) out[k] = v;
  return out;
};

/** Référence valide reçue dans une opération (champs bornés). */
export const sanitizeLiveRef = (x: any): LiveRef | null => {
  if (!x || typeof x !== 'object') return null;
  const t = typeof x.t === 'string' ? x.t.slice(0, 80) : '';
  const n = Number(x.n), from = Number(x.from), frames = Number(x.frames), ch = Number(x.ch), sr = Number(x.sr);
  if (!t || !Number.isInteger(n) || n < 1 || n > 20000 || !Number.isInteger(from) || from < 0 || !Number.isInteger(frames) || frames < 1
    || !Number.isInteger(ch) || ch < 1 || ch > 8 || !Number.isFinite(sr) || sr < 8000 || sr > 384000 || typeof x.sum !== 'string') return null;
  return { t, n, from, frames, ch, sr, sum: x.sum.slice(0, 40) };
};

export { encodeSegment, decodeSegment };
