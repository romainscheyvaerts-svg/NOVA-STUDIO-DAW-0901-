/**
 * Sauvegarde automatique incrémentale, historique des versions et récupération
 * après plantage (onglet tué, appli fermée de force, coupure de courant).
 *
 * Avant (utils/sessionStore) : toutes les 4 s d'inactivité, le projet ENTIER
 * était réencodé en .zip (un WAV par son) : sur une grosse session l'interface
 * gelait, rien n'était gardé pendant la lecture ni pendant une prise, et seules
 * deux sauvegardes existaient. Une prise en cours au moment d'un plantage était
 * perdue en entier.
 *
 * Maintenant, dans IndexedDB (rien ne quitte l'appareil) :
 *  - `audio`     : chaque son une seule fois (échantillons bruts, pas d'encodage),
 *                  écrit quand il apparaît ; une version ne réécrit que le JSON ;
 *  - `versions`  : le projet (JSON, sons référencés par leur identifiant) :
 *                  les 20 dernières + une par heure (7 jours) ;
 *  - `takes` / `takeChunks` : la prise EN COURS, écrite par morceaux d'une demi-
 *                  seconde pendant l'enregistrement (durabilité « strict ») :
 *                  après un plantage on la retrouve jusqu'à la dernière seconde ;
 *  - un drapeau « session ouverte » (localStorage, écriture synchrone) : présent
 *                  au démarrage = la séance précédente ne s'est pas fermée normalement.
 *
 * Le stockage est injectable (`RecoveryBackend`) : la logique est testée avec un
 * stockage en mémoire, le navigateur utilise IndexedDB.
 */

export const AUDIO = 'audio';
export const VERSIONS = 'versions';
export const TAKES = 'takes';
export const TAKE_CHUNKS = 'takeChunks';
const STORES = [AUDIO, VERSIONS, TAKES, TAKE_CHUNKS] as const;
export type StoreName = typeof STORES[number];

export interface RecoveryBackend {
  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined>;
  put(store: StoreName, key: IDBValidKey, value: unknown, opts?: { durable?: boolean }): Promise<void>;
  delete(store: StoreName, key: IDBValidKey | IDBKeyRange): Promise<void>;
  keys(store: StoreName): Promise<IDBValidKey[]>;
  /** Valeurs dont la clé commence par `prefix` (tableau [prefix, …]) : morceaux d'une prise. */
  range<T>(store: StoreName, lower: IDBValidKey, upper: IDBValidKey): Promise<T[]>;
}

export interface StoredAudio { id: string; sampleRate: number; length: number; channels: Float32Array[]; savedAt: number }

export interface VersionMeta {
  id: number;            // horodatage (ms) = clé
  projectId: string;
  name: string;
  savedAt: number;
  reason: VersionReason;
  tracks: number;
  takes: number;
  beatTitle: string | null;
  hasLyrics: boolean;
  /** Le beat du catalogue n'est pas gardé (licence) : il est rechargé depuis le catalogue. */
  needsCatalogBeat: boolean;
}
export interface VersionRecord extends VersionMeta { json: string; audioIds: string[] }
export type VersionReason = 'auto' | 'take' | 'close' | 'manual' | 'restore' | 'recovered';

export interface TakeMetaRecord {
  takeId: string;
  projectId: string;
  trackId: string;
  trackName: string;
  sampleRate: number;
  /** Position de la tête de lecture au début de la prise (s). */
  recordedAt: number;
  /** Latence mesurée (s), retirée de la position à la récupération. */
  latency: number;
  startedAt: number;
  endedAt: number | null;
  samples: number;
  chunks: number;
  /** R14 · Groupe de prises (passage multipiste) : les pistes récupérées vont ensemble. */
  group?: string;
  /** R14 · Canaux (2 = entrée stéréo, échantillons entrelacés G/D). Absent : mono. */
  channels?: number;
  /**
   * Avance du son sur le départ de la lecture (s, décompte / pré-roll), notée pendant la
   * prise : retirée à la récupération (la prise revient à sa place exacte).
   */
  lead?: number;
}

export interface RecoveredTake { meta: TakeMetaRecord; samples: Float32Array; seconds: number }

// --------------------------------------------------------------------------- politique de conservation

export const KEEP_RECENT = 20;
export const KEEP_HOURLY_DAYS = 7;

/**
 * Versions à garder : les 20 plus récentes, puis la plus récente de chaque heure
 * (sur 7 jours). Retourne les identifiants à SUPPRIMER.
 */
export function versionsToPrune(list: Pick<VersionMeta, 'id' | 'savedAt'>[], now = Date.now()): number[] {
  const sorted = [...list].sort((a, b) => b.savedAt - a.savedAt);
  const keep = new Set<number>(sorted.slice(0, KEEP_RECENT).map(v => v.id));
  const hours = new Set<number>();
  for (const v of sorted) {
    const h = Math.floor(v.savedAt / 3_600_000);
    if (hours.has(h)) continue;
    hours.add(h);
    if (now - v.savedAt <= KEEP_HOURLY_DAYS * 86_400_000) keep.add(v.id);
  }
  return sorted.filter(v => !keep.has(v.id)).map(v => v.id);
}

// --------------------------------------------------------------------------- session ouverte / fermée

const OPEN_KEY = 'nova_session_open';

export interface OpenSessionFlag { projectId: string; since: number; recording?: boolean }

export function markSessionOpen(projectId: string, recording = false) {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify({ projectId, since: Date.now(), recording } as OpenSessionFlag)); } catch { /* stockage indisponible */ }
}
export function markSessionClosed() {
  try { localStorage.removeItem(OPEN_KEY); } catch { /* */ }
}
/** Drapeau resté posé = la séance précédente a été coupée (plantage, fermeture forcée, courant). */
export function previousSessionCrashed(): OpenSessionFlag | null {
  try { const v = localStorage.getItem(OPEN_KEY); return v ? JSON.parse(v) as OpenSessionFlag : null; } catch { return null; }
}

// --------------------------------------------------------------------------- stockage IndexedDB

const DB_NAME = 'nova-recovery';
const DB_VERSION = 1;

export function idbBackend(): RecoveryBackend {
  let dbp: Promise<IDBDatabase> | null = null;
  const open = () => {
    if (!dbp) {
      dbp = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB indisponible')); return; }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
        req.onsuccess = () => {
          const db = req.result;
          // Une autre version de l'appli veut mettre la base à jour : on la laisse faire.
          db.onversionchange = () => { try { db.close(); } catch { /* */ } dbp = null; };
          resolve(db);
        };
        req.onerror = () => reject(req.error);
      });
      dbp.catch(() => { dbp = null; });
    }
    return dbp;
  };
  const tx = async <T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void, durable = false): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const t = (db as any).transaction(store, mode, durable ? { durability: 'strict' } : undefined) as IDBTransaction;
      let result: any;
      const req = fn(t.objectStore(store));
      if (req) req.onsuccess = () => { result = req.result; };
      t.oncomplete = () => resolve(result as T);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaction annulée'));
    });
  };
  return {
    get: (store, key) => tx(store, 'readonly', s => s.get(key)),
    put: (store, key, value, opts) => tx(store, 'readwrite', s => { s.put(value, key); }, !!opts?.durable),
    delete: (store, key) => tx(store, 'readwrite', s => { s.delete(key as any); }),
    keys: (store) => tx(store, 'readonly', s => s.getAllKeys()),
    range: (store, lower, upper) => tx(store, 'readonly', s => s.getAll(IDBKeyRange.bound(lower, upper))),
  };
}

/** Stockage en mémoire (tests, et repli si IndexedDB manque). */
export function memoryBackend(): RecoveryBackend & { dump(): Record<string, Map<string, unknown>> } {
  const data: Record<string, Map<string, { key: IDBValidKey; value: unknown }>> = {};
  const m = (s: string) => (data[s] ||= new Map());
  const k = (key: IDBValidKey) => JSON.stringify(key);
  const cmp = (a: IDBValidKey, b: IDBValidKey): number => {
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i] as IDBValidKey, b[i] as IDBValidKey); if (c) return c; }
      return a.length - b.length;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  };
  return {
    async get(store, key) { return m(store).get(k(key))?.value as any; },
    async put(store, key, value) { m(store).set(k(key), { key, value: structuredClone(value) }); },
    async delete(store, key) {
      if (key instanceof Object && 'lower' in (key as any)) {
        const r = key as IDBKeyRange;
        for (const [kk, v] of m(store)) if (cmp(v.key, r.lower) >= 0 && cmp(v.key, r.upper) <= 0) m(store).delete(kk);
      } else m(store).delete(k(key as IDBValidKey));
    },
    async keys(store) { return [...m(store).values()].map(v => v.key).sort(cmp); },
    async range(store, lower, upper) { return [...m(store).values()].filter(v => cmp(v.key, lower) >= 0 && cmp(v.key, upper) <= 0).sort((a, b) => cmp(a.key, b.key)).map(v => v.value) as any; },
    dump() { const out: Record<string, Map<string, unknown>> = {}; for (const s in data) out[s] = new Map([...data[s]].map(([kk, v]) => [kk, v.value])); return out; },
  };
}

// --------------------------------------------------------------------------- magasin

export interface SnapshotInput {
  projectId: string;
  name: string;
  /** JSON du projet (sons référencés par identifiant, sans AudioBuffer). */
  json: string;
  /** Sons référencés par le projet ; `get` les fournit s'ils ne sont pas encore stockés. */
  audioIds: string[];
  getAudio: (id: string) => { sampleRate: number; length: number; channels: Float32Array[] } | null;
  tracks: number;
  takes: number;
  beatTitle: string | null;
  hasLyrics: boolean;
  needsCatalogBeat: boolean;
  reason: VersionReason;
}

export interface SaveResult { versionId: number; audioWritten: number; audioBytes: number; pruned: number; ms: number }

/** Fin d'une ligne de clés de morceaux : [takeId, MAX]. */
const CHUNK_MAX = Number.MAX_SAFE_INTEGER;

export class RecoveryStore {
  private knownAudio: Set<string> | null = null;
  private saving: Promise<SaveResult | null> | null = null;

  constructor(private db: RecoveryBackend, private now: () => number = Date.now) {}

  private async audioKeys(): Promise<Set<string>> {
    if (!this.knownAudio) this.knownAudio = new Set((await this.db.keys(AUDIO)).map(String));
    return this.knownAudio;
  }

  /**
   * Nouvelle version : seuls les sons pas encore stockés sont écrits (une fois),
   * puis le JSON. Un appel pendant une écriture attend la fin de celle-ci.
   */
  async saveVersion(input: SnapshotInput): Promise<SaveResult | null> {
    while (this.saving) { try { await this.saving; } catch { /* la précédente a échoué */ } }
    const p = this.doSave(input);
    this.saving = p;
    try { return await p; } finally { if (this.saving === p) this.saving = null; }
  }

  private async doSave(input: SnapshotInput): Promise<SaveResult | null> {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const known = await this.audioKeys();
    let audioWritten = 0, audioBytes = 0;
    const stored: string[] = [];
    for (const id of new Set(input.audioIds)) {
      if (known.has(id)) { stored.push(id); continue; }
      const a = input.getAudio(id);
      if (!a) continue;
      // Copie des échantillons : le son peut être modifié en mémoire ensuite.
      const rec: StoredAudio = { id, sampleRate: a.sampleRate, length: a.length, channels: a.channels.map(c => c.slice()), savedAt: this.now() };
      await this.db.put(AUDIO, id, rec);
      known.add(id);
      stored.push(id);
      audioWritten++;
      audioBytes += rec.channels.reduce((s, c) => s + c.byteLength, 0);
    }
    let id = this.now();
    // Deux versions dans la même milliseconde : clé suivante.
    while (await this.db.get(VERSIONS, id)) id++;
    const rec: VersionRecord = {
      id, projectId: input.projectId, name: input.name, savedAt: id, reason: input.reason, tracks: input.tracks, takes: input.takes,
      beatTitle: input.beatTitle, hasLyrics: input.hasLyrics, needsCatalogBeat: input.needsCatalogBeat, json: input.json, audioIds: stored,
    };
    await this.db.put(VERSIONS, id, rec, { durable: true });
    // Les prises terminées AVANT cette version y sont : leurs morceaux ne servent plus.
    await this.purgeTakes(t => t.endedAt !== null && t.endedAt <= id && t.projectId === input.projectId);
    const pruned = await this.prune();
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return { versionId: id, audioWritten, audioBytes, pruned, ms: Math.round(t1 - t0) };
  }

  /** Versions, de la plus récente à la plus ancienne (sans le JSON). */
  async listVersions(projectId?: string): Promise<VersionMeta[]> {
    const keys = (await this.db.keys(VERSIONS)) as number[];
    const out: VersionMeta[] = [];
    for (const k of keys) {
      const v = await this.db.get<VersionRecord>(VERSIONS, k);
      if (!v || (projectId && v.projectId !== projectId)) continue;
      const { json: _j, audioIds: _a, ...meta } = v;
      out.push(meta);
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  async latest(projectId?: string): Promise<VersionMeta | null> {
    return (await this.listVersions(projectId))[0] || null;
  }

  /** Version complète + sons (ceux qui manquent sont listés, jamais d'exception pour un son absent). */
  async loadVersion(id: number): Promise<{ record: VersionRecord; audio: Map<string, StoredAudio>; missing: string[] } | null> {
    const record = await this.db.get<VersionRecord>(VERSIONS, id);
    if (!record) return null;
    const audio = new Map<string, StoredAudio>();
    const missing: string[] = [];
    for (const a of record.audioIds) {
      const s = await this.db.get<StoredAudio>(AUDIO, a);
      if (s) audio.set(a, s); else missing.push(a);
    }
    return { record, audio, missing };
  }

  /** Versions en trop supprimées, puis sons que plus rien ne référence. */
  async prune(): Promise<number> {
    const keys = (await this.db.keys(VERSIONS)) as number[];
    const metas = keys.map(k => ({ id: k, savedAt: k }));
    const drop = versionsToPrune(metas, this.now());
    for (const id of drop) await this.db.delete(VERSIONS, id);
    if (drop.length) await this.collectAudio();
    return drop.length;
  }

  private async collectAudio() {
    const used = new Set<string>();
    for (const k of await this.db.keys(VERSIONS)) {
      const v = await this.db.get<VersionRecord>(VERSIONS, k);
      v?.audioIds.forEach(a => used.add(a));
    }
    const known = await this.audioKeys();
    for (const a of [...known]) {
      if (used.has(a)) continue;
      await this.db.delete(AUDIO, a);
      known.delete(a);
    }
  }

  // ------------------------------------------------------------------------- prises en cours

  /** Journal d'une prise : morceaux écrits au fil de l'eau (≈ 0,5 s), durablement. */
  beginTake(meta: Omit<TakeMetaRecord, 'startedAt' | 'endedAt' | 'samples' | 'chunks'>, flushSamples?: number): TakeJournal {
    return new TakeJournal(this.db, { ...meta, startedAt: this.now(), endedAt: null, samples: 0, chunks: 0 }, flushSamples ?? Math.round(meta.sampleRate / 2), this.now);
  }

  /** Prises dont les morceaux sont encore là (pas encore incluses dans une version). */
  async pendingTakes(): Promise<TakeMetaRecord[]> {
    const out: TakeMetaRecord[] = [];
    for (const k of await this.db.keys(TAKES)) {
      const m = await this.db.get<TakeMetaRecord>(TAKES, k);
      if (m) out.push(m);
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Échantillons d'une prise, morceaux remis bout à bout dans l'ordre. */
  async readTake(takeId: string): Promise<RecoveredTake | null> {
    const meta = await this.db.get<TakeMetaRecord>(TAKES, takeId);
    if (!meta) return null;
    const chunks = await this.db.range<Float32Array>(TAKE_CHUNKS, [takeId, 0], [takeId, CHUNK_MAX]);
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const samples = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { samples.set(c, o); o += c.length; }
    return { meta: { ...meta, samples: total, chunks: chunks.length }, samples, seconds: total / (meta.sampleRate || 44100) / Math.max(1, meta.channels || 1) };
  }

  /**
   * Prises à récupérer après un plantage : celles qui ne sont dans aucune version
   * (pas terminées, ou terminées après la dernière version de leur projet).
   */
  async takesToRecover(): Promise<RecoveredTake[]> {
    const out: RecoveredTake[] = [];
    const lastByProject = new Map<string, number>();
    for (const v of await this.listVersions()) if (!lastByProject.has(v.projectId)) lastByProject.set(v.projectId, v.savedAt);
    for (const m of await this.pendingTakes()) {
      const last = lastByProject.get(m.projectId) ?? 0;
      if (m.endedAt !== null && m.endedAt <= last) continue;
      const t = await this.readTake(m.takeId);
      if (t && t.samples.length) out.push(t);
    }
    return out;
  }

  async purgeTakes(pred: (m: TakeMetaRecord) => boolean = () => true): Promise<number> {
    let n = 0;
    for (const m of await this.pendingTakes()) {
      if (!pred(m)) continue;
      await this.db.delete(TAKE_CHUNKS, IDBKeyRangeBound([m.takeId, 0], [m.takeId, CHUNK_MAX]));
      await this.db.delete(TAKES, m.takeId);
      n++;
    }
    return n;
  }
}

/** IDBKeyRange quand il existe (navigateur), sinon une forme équivalente (tests). */
function IDBKeyRangeBound(lower: IDBValidKey, upper: IDBValidKey): IDBKeyRange {
  if (typeof IDBKeyRange !== 'undefined') return IDBKeyRange.bound(lower, upper);
  return { lower, upper } as unknown as IDBKeyRange;
}

export class TakeJournal {
  private pending: Float32Array[] = [];
  private pendingLen = 0;
  private seq = 0;
  private writing: Promise<void> = Promise.resolve();
  private failed = false;
  private closed = false;

  constructor(private db: RecoveryBackend, readonly meta: TakeMetaRecord, private flushSamples: number, private now: () => number) {
    this.writing = this.db.put(TAKES, meta.takeId, { ...meta }, { durable: true }).catch(() => { this.failed = true; });
  }

  get takeId() { return this.meta.takeId; }

  /** Complète la description de la prise (écrite avec le prochain morceau). */
  annotate(patch: Partial<Pick<TakeMetaRecord, 'lead'>>) {
    if (this.closed) return;
    Object.assign(this.meta, patch);
    this.metaDirty = true;
  }

  /** Description à réécrire (avance notée) ; le nombre d'échantillons, lui, se relit dans les morceaux. */
  private metaDirty = false;

  /** Morceau capté (mono). Écrit dès qu'une demi-seconde s'est accumulée. */
  push(chunk: Float32Array) {
    if (this.closed || this.failed || !chunk.length) return;
    this.pending.push(chunk);
    this.pendingLen += chunk.length;
    if (this.pendingLen >= this.flushSamples) this.flush();
  }

  /** Écrit ce qui attend (appelé aussi à l'arrêt de la prise). */
  flush(): Promise<void> {
    if (!this.pendingLen || this.failed) return this.writing;
    const block = new Float32Array(this.pendingLen);
    let o = 0;
    for (const c of this.pending) { block.set(c, o); o += c.length; }
    this.pending = [];
    this.pendingLen = 0;
    const seq = this.seq++;
    this.meta.samples += block.length;
    this.meta.chunks = this.seq;
    const meta = { ...this.meta };
    // Une seule écriture durable par morceau (avant : morceau + description à chaque fois) : avec
    // 4 pistes armées, la file d'IndexedDB prenait du retard et un plantage en perdait la fin.
    // La description n'est réécrite que si elle a changé (avance notée) ; la récupération relit
    // la longueur dans les morceaux eux-mêmes.
    const withMeta = this.metaDirty || seq === 0;
    this.metaDirty = false;
    this.writing = this.writing
      .then(() => this.db.put(TAKE_CHUNKS, [this.meta.takeId, seq], block, { durable: true }))
      .then(() => (withMeta ? this.db.put(TAKES, this.meta.takeId, meta, { durable: true }) : undefined))
      .catch(() => { this.failed = true; });
    return this.writing;
  }

  /** Fin normale de la prise : le reste est écrit, la prise est marquée terminée. */
  async finish(): Promise<void> {
    if (this.closed) return this.writing;
    await this.flush();
    this.closed = true;
    this.meta.endedAt = this.now();
    const meta = { ...this.meta };
    this.writing = this.writing.then(() => this.db.put(TAKES, this.meta.takeId, meta, { durable: true })).catch(() => { this.failed = true; });
    return this.writing;
  }

  /** Prise abandonnée (rien enregistré) : morceaux effacés. */
  async discard(): Promise<void> {
    this.closed = true;
    await this.writing;
    try {
      await this.db.delete(TAKE_CHUNKS, IDBKeyRangeBound([this.meta.takeId, 0], [this.meta.takeId, CHUNK_MAX]));
      await this.db.delete(TAKES, this.meta.takeId);
    } catch { /* */ }
  }

  get ok() { return !this.failed; }
}

let shared: RecoveryStore | null = null;
/** Magasin de l'appli (IndexedDB ; en mémoire si IndexedDB manque). */
export function recoveryStore(): RecoveryStore {
  if (!shared) shared = new RecoveryStore(typeof indexedDB !== 'undefined' ? idbBackend() : memoryBackend());
  return shared;
}
export function setRecoveryStoreForTests(s: RecoveryStore | null) { shared = s; }
