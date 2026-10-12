/**
 * Prise envoyée pendant l'enregistrement (B3) : branchement dans le navigateur.
 *
 *  - ltIdbStore : la file d'envoi gardée sur l'appareil (IndexedDB) — un onglet fermé
 *    avant la fin de l'envoi reprend à la réouverture ;
 *  - LiveTakeReceiver : chez les autres, téléchargement des morceaux au fil de l'eau
 *    (SHA-1 vérifié, puis somme du morceau), forme d'onde qui avance, recollage et
 *    vérification de la prise entière, enregistrement du son (registre des buffers) ;
 *  - ltRefsStore : bufferId → référence de la prise (survit à un rechargement).
 * Voir utils/liveTake pour le format et les règles.
 */

import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { audioEngine } from '../engine/AudioEngine';
import { LiveRef, LiveTakeAssembly, LtItem, LtStore, ReceptionView, SegMeta, sanitizeLiveRef } from '../utils/liveTake';
import type { CloudLink } from './SessionCloud';
import { downloadParts } from './Collab';

// --- File gardée sur l'appareil ---------------------------------------------------------

const DB = 'nova_live_takes';
const STORE = 'items';

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  try {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  } catch (e) { reject(e); }
});

let dbP: Promise<IDBDatabase> | null = null;
const db = () => (dbP ||= openDb().catch(e => { dbP = null; throw e; }));

const tx = async <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
  const d = await db();
  return new Promise<T | undefined>((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r ? (r as IDBRequest<T>).result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
};

export const ltIdbStore = (): LtStore => ({
  all: async () => ((await tx<LtItem[]>('readonly', s => s.getAll())) || []) as LtItem[],
  put: async (it) => { await tx('readwrite', s => { s.put(it); }); },
  del: async (k) => { await tx('readwrite', s => { s.delete(k); }); },
});

// --- Références des prises (bufferId → prise en direct) ------------------------------------

const REFS_KEY = (session: string) => `nova_lt_refs_${session}`;
export type LiveRefB = LiveRef & { b: string };

export const ltRefsStore = {
  load(session: string): Map<string, LiveRef> {
    try {
      const raw = JSON.parse(localStorage.getItem(REFS_KEY(session)) || '{}');
      const m = new Map<string, LiveRef>();
      for (const [b, r] of Object.entries(raw)) { const ok = sanitizeLiveRef(r); if (ok) m.set(b, ok); }
      return m;
    } catch { return new Map(); }
  },
  save(session: string, refs: Map<string, LiveRef>) {
    try {
      const last = [...refs.entries()].slice(-300);
      localStorage.setItem(REFS_KEY(session), JSON.stringify(Object.fromEntries(last)));
    } catch { /* stockage plein : la prise repartira par l'envoi classique */ }
  },
};

/**
 * Prises posées ici dont le contenu n'est pas encore parti (onglet fermé, réseau coupé) :
 * les clips de la prise, pour les remettre dans la piste à la réouverture (la séance peut
 * revenir du serveur sans eux) ; le contenu repart alors normalement.
 */
export interface LtPlacement { trackId: string; take: string; b: string; clips: unknown[]; at: number }
const PLACE_KEY = (session: string) => `nova_lt_place_${session}`;
export const ltPlacements = {
  list(session: string): LtPlacement[] {
    try { const v = JSON.parse(localStorage.getItem(PLACE_KEY(session)) || '[]'); return Array.isArray(v) ? v.filter(x => x && typeof x.trackId === 'string' && typeof x.b === 'string') : []; } catch { return []; }
  },
  save(session: string, list: LtPlacement[]) {
    // Une semaine au plus (la prise est partie depuis longtemps sinon).
    const keep = list.filter(x => Date.now() - (x.at || 0) < 7 * 86400000).slice(-50);
    try { localStorage.setItem(PLACE_KEY(session), JSON.stringify(keep)); } catch { /* */ }
  },
  add(session: string, p: LtPlacement) { this.save(session, [...this.list(session).filter(x => x.b !== p.b), p]); },
  /** Contenu parti : les prises dont tous les clips y étaient sont retirées (renvoie leurs prises). */
  sent(session: string, trackId: string, clipIds: Set<string>): string[] {
    const all = this.list(session);
    const done = all.filter(x => x.trackId === trackId && x.clips.every((c: any) => clipIds.has(c?.id)));
    if (done.length) this.save(session, all.filter(x => !done.includes(x)));
    return done.map(x => x.take);
  },
};

// --- Réception ------------------------------------------------------------------------------

/** Erreur « prise encore en route » : l'opération qui la pose est réessayée sans compter d'échec. */
export class LiveTakePendingError extends Error {
  readonly liveTakePending = true;
  constructor(public take: string) { super('Prise encore en cours de réception'); }
}

interface RecvTake {
  asm: LiveTakeAssembly;
  state: ReceptionView['state'];
  error?: string;
  b?: string;
  sr: number;
  updatedAt: number;
  /** Téléchargements échoués d'affilée (attente croissante). */
  fails: number;
  placedAt?: number;
}

export interface ReceiverDeps {
  link: () => CloudLink | null;
  /** Prise complète et vérifiée : son enregistré sous `bufferId`. */
  onReady: (take: string, bufferId: string, ref: LiveRef) => void;
  /** Somme fausse (morceau perdu ou abîmé) : on demande la prise entière à l'envoi classique. */
  onBroken: (take: string, bufferId: string | undefined, why: string) => void;
}

export class LiveTakeReceiver {
  private takes = new Map<string, RecvTake>();
  private listeners = new Set<() => void>();
  private loop: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private deps: ReceiverDeps) {}

  subscribe(cb: () => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  private changed(now = false) {
    // Forme d'onde : au plus ~4 rafraîchissements par seconde.
    if (now) { if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; } this.listeners.forEach(cb => { try { cb(); } catch { /* */ } }); return; }
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => { this.notifyTimer = null; this.listeners.forEach(cb => { try { cb(); } catch { /* */ } }); }, 250);
  }

  private get(take: string, trackId: string, from: string): RecvTake {
    let r = this.takes.get(take);
    if (!r) {
      r = { asm: new LiveTakeAssembly(take, trackId, from), state: 'reception', sr: 48000, updatedAt: Date.now(), fails: 0 };
      this.takes.set(take, r);
    }
    return r;
  }

  has(take: string) { return this.takes.has(take); }
  ready(take: string) { const r = this.takes.get(take); return !!r && (r.state === 'prete' || r.state === 'posee') && !!r.b && audioBufferRegistry.has(r.b); }
  /** État d'une prise (null : inconnue ici). */
  stateOf(take: string): ReceptionView['state'] | null { return this.takes.get(take)?.state ?? null; }

  /** Opération « take_seg » reçue : morceaux annoncés, téléchargés au fil de l'eau. */
  addSegs(op: any, from: string) {
    const take = typeof op?.t === 'string' ? op.t.slice(0, 80) : '';
    if (!take || !Array.isArray(op.segs)) return;
    const r = this.get(take, String(op.trackId || ''), from);
    if (r.state !== 'reception') return;
    for (const s of op.segs.slice(0, 64)) {
      const m: SegMeta = { i: Number(s?.i), h: String(s?.h || ''), n: Number(s?.n), sz: Number(s?.sz) || undefined, ch: Number(s?.ch) || undefined, sr: Number(s?.sr) || undefined };
      if (!Number.isInteger(m.i) || m.i < 0 || !/^[0-9a-f]{40}$/.test(m.h) || !Number.isInteger(m.n) || m.n < 1) continue;
      if (m.sr) r.sr = m.sr;
      r.asm.addMeta(m);
    }
    r.updatedAt = Date.now();
    this.changed(true);
    this.kick();
  }

  /** Fin de la prise (take_end, ou la référence portée par l'opération de contenu). */
  setEnd(take: string, ref: LiveRef & { b?: string }, from: string, trackId: string) {
    const r = this.get(take, trackId, from);
    if (r.state === 'posee') return;
    if (!r.asm.end) r.asm.setEnd(ref);
    if (ref.b && !r.b) r.b = ref.b;
    r.sr = ref.sr || r.sr;
    r.updatedAt = Date.now();
    this.changed(true);
    this.kick();
  }

  cancel(take: string) {
    const r = this.takes.get(take);
    if (!r) return;
    r.asm.cancelled = true;
    r.state = 'annulee';
    r.asm.segs.clear();
    r.updatedAt = Date.now();
    this.changed(true);
  }

  /** L'opération de contenu qui utilise la prise est appliquée : « posée ». */
  markPlaced(take: string) {
    const r = this.takes.get(take);
    if (!r || r.state === 'posee') return;
    r.state = 'posee';
    r.placedAt = Date.now();
    r.updatedAt = Date.now();
    this.changed(true);
  }

  views(): ReceptionView[] {
    return [...this.takes.values()].map(r => ({
      take: r.asm.take, trackId: r.asm.trackId, from: r.asm.from, state: r.state,
      seconds: r.asm.framesContiguous() / (r.sr || 48000), peaks: r.asm.peaks, sr: r.sr, error: r.error, updatedAt: r.updatedAt,
    }));
  }

  kick() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.loop) this.loop = this.run().finally(() => { this.loop = null; });
  }

  private async run() {
    for (;;) {
      const link = this.deps.link();
      if (!link) return;
      let progressed = false;
      let waiting = false;
      for (const r of this.takes.values()) {
        if (r.state !== 'reception') continue;
        const missing = r.asm.missingSegs();
        if (missing.length) {
          try {
            // Quelques morceaux à la fois, dans l'ordre (la forme d'onde avance du début).
            const batch = missing.slice(0, 4);
            const got = await downloadParts(link, batch.map(m => m.h));
            for (const m of batch) {
              const b = got.get(m.h);
              if (!b) { waiting = true; continue; }
              try { r.asm.addBytes(m.i, b); progressed = true; } catch (e: any) { r.error = e?.message || 'morceau abîmé'; waiting = true; }
            }
            r.fails = 0;
          } catch (e: any) {
            r.fails++;
            waiting = true;
          }
          r.updatedAt = Date.now();
          this.changed();
        }
        if (r.asm.complete() && r.state === 'reception') await this.finish(r);
      }
      if (!progressed) {
        if (waiting) {
          const fails = Math.max(0, ...[...this.takes.values()].map(x => x.fails));
          this.timer = setTimeout(() => { this.timer = null; this.kick(); }, Math.min(5000, 400 * 2 ** Math.min(4, fails)));
        }
        return;
      }
    }
  }

  private async finish(r: RecvTake) {
    r.state = 'verification';
    this.changed(true);
    const out = r.asm.assemble();
    const b = r.b || r.asm.end?.b;
    if (!out || !b) {
      r.state = 'erreur';
      r.error = !out ? 'somme de contrôle de la prise fausse' : 'prise sans identifiant';
      this.changed(true);
      this.deps.onBroken(r.asm.take, b, r.error);
      return;
    }
    await audioEngine.init();
    const e = r.asm.end!;
    const buf = audioEngine.ctx!.createBuffer(out.channels.length, e.frames, e.sr);
    out.channels.forEach((c, i) => buf.copyToChannel(c, i));
    audioBufferRegistry.register(buf, b);
    r.asm.segs.clear(); // la prise est dans le registre : les morceaux ne servent plus
    r.state = 'prete';
    r.b = b;
    r.updatedAt = Date.now();
    this.changed(true);
    const { b: _b, ...ref } = e;
    this.deps.onReady(r.asm.take, b, ref);
  }

  /** Oublie les prises posées depuis longtemps (indicateur). */
  prune(maxAgeMs = 8000) {
    const now = Date.now();
    let any = false;
    for (const [k, r] of this.takes) {
      if ((r.state === 'posee' || r.state === 'annulee') && now - r.updatedAt > maxAgeMs) { this.takes.delete(k); any = true; }
    }
    if (any) this.changed(true);
  }

  clear() { this.takes.clear(); if (this.timer) clearTimeout(this.timer); this.timer = null; this.changed(true); }
}
