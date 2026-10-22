/**
 * Écrivain de prises (Worker) : les échantillons de la prise arrivent DIRECTEMENT du fil audio
 * (anneau SharedArrayBuffer, ou port de messages ouvert entre l'AudioWorklet et ce Worker), sans
 * passer par le fil de l'interface, et sont écrits au fil de l'eau dans la base de récupération
 * (IndexedDB « nova-recovery », morceaux TAKE_CHUNKS [prise, n°], durabilité « strict ») toutes
 * les 0,25 s. Comme le fil d'écriture du moteur natif (Engine::writerLoop) : une interface qui
 * rame, se fige ou plante ne fait perdre aucun échantillon déjà capté ; au rechargement, la
 * récupération (utils/recoveryStore.takesToRecover) relit ces morceaux.
 *
 * Le Worker renvoie aussi les échantillons à la page (morceaux d'environ 0,1 s) : assemblage de la
 * prise à l'arrêt, direct de la collaboration. À l'arrêt de la prise il vide l'anneau, écrit le
 * reste et rend le compte (images reçues, écrites, perdues).
 *
 * Rien ne tourne quand il n'y a pas de prise (le minuteur de lecture de l'anneau s'arrête).
 */
import { ringRead, RING_LOST, RING_STATE } from './takeRing';
import { DB_NAME, DB_VERSION, STORES, TAKE_CHUNKS } from '../utils/recoveryDb';

interface Target { takeId: string; first: number; width: 1 | 2 }
interface Begin {
  type: 'begin'; id: string; k: number; sr: number;
  ring?: { header: SharedArrayBuffer; data: SharedArrayBuffer; capacity: number };
  targets: Target[]; flushSec?: number; forwardSec?: number;
}

interface Session {
  id: string; k: number; sr: number;
  ring: { h: Int32Array; d: Float32Array; cap: number } | null;
  port: MessagePort | null;
  targets: Target[];
  flushFrames: number; forwardFrames: number;
  pend: Float32Array[][]; pendLen: number;
  fwd: Float32Array[][]; fwdLen: number;
  first: number; frames: number; durable: number; failed: string | null;
  seq: Map<string, number>;
  writes: Promise<void>;
  eos: boolean; eosWait: (() => void) | null; allocs: number; portLost: number;
  drains: number; lastErr: string | null;
}

const sessions = new Map<string, Session>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
const post = (m: unknown, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);

// ---------------------------------------------------------------- base IndexedDB
let dbp: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
      req.onsuccess = () => { const db = req.result; db.onversionchange = () => { try { db.close(); } catch { /* */ } dbp = null; }; resolve(db); };
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

function concat(parts: Float32Array[], len: number, copy = false): Float32Array {
  if (!copy && parts.length === 1 && parts[0].length === len) return parts[0];
  const x = new Float32Array(len);
  let o = 0;
  for (const p of parts) { x.set(p, o); o += p.length; }
  return x;
}

/** Morceaux en attente → un enregistrement par prise (mono, ou stéréo entrelacé comme le journal). */
function flushDurable(s: Session) {
  if (!s.pendLen) return;
  const len = s.pendLen;
  const chans = s.pend.map(p => concat(p, len));
  s.pend = s.pend.map(() => []);
  s.pendLen = 0;
  const recs: { key: [string, number]; value: Float32Array }[] = [];
  for (const t of s.targets) {
    const a = chans[t.first];
    if (!a) continue;
    let v: Float32Array;
    if (t.width === 1) v = a.slice();
    else {
      const b = chans[t.first + 1];
      v = new Float32Array(len * 2);
      for (let i = 0; i < len; i++) { v[2 * i] = a[i]; v[2 * i + 1] = b ? b[i] : 0; }
    }
    const n = s.seq.get(t.takeId) || 0;
    s.seq.set(t.takeId, n + 1);
    recs.push({ key: [t.takeId, n], value: v });
  }
  if (!recs.length) { s.durable += len; return; }
  s.writes = s.writes.then(async () => {
    if (s.failed) return;
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = (db as any).transaction(TAKE_CHUNKS, 'readwrite', { durability: 'strict' }) as IDBTransaction;
        const st = tx.objectStore(TAKE_CHUNKS);
        for (const r of recs) st.put(r.value, r.key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('écriture annulée'));
      });
      s.durable += len;
    } catch (e) {
      s.failed = String((e as Error)?.message || e);
      post({ type: 'warn', id: s.id, message: s.failed });
    }
  });
}

function forward(s: Session) {
  if (!s.fwdLen) return;
  // Copie : les mêmes tableaux attendent peut-être encore leur écriture durable (pend).
  const ch = s.fwd.map(p => concat(p, s.fwdLen, true));
  s.fwd = s.fwd.map(() => []);
  s.fwdLen = 0;
  post({ type: 'chunk', id: s.id, first: s.first, ch }, ch.map(c => c.buffer));
}

/** Échantillons reçus (un tableau par canal). */
function take(s: Session, ch: Float32Array[]) {
  const n = ch[0]?.length || 0;
  if (!n) return;
  s.frames += n;
  for (let c = 0; c < s.k; c++) {
    const x = ch[c] || new Float32Array(n);
    s.pend[c].push(x);
    s.fwd[c].push(x);
  }
  s.pendLen += n;
  s.fwdLen += n;
  if (s.fwdLen >= s.forwardFrames) forward(s);
  if (s.pendLen >= s.flushFrames) flushDurable(s);
}

function drainRing(s: Session) {
  const r = s.ring;
  if (!r) return;
  if (s.first < 0 && Atomics.load(r.h, RING_STATE) > 0) s.first = new Float64Array(r.h.buffer, 32, 1)[0];
  for (;;) {
    const ch = ringRead(r.h, r.d, r.cap, s.k, r.cap);
    if (!ch) break;
    if (s.first < 0) s.first = new Float64Array(r.h.buffer, 32, 1)[0];
    take(s, ch);
  }
}

function safeDrain(s: Session) {
  try { drainRing(s); s.drains++; }
  catch (e) {
    // Jamais silencieux : la page le saura (santé de la prise) et l'anneau compte ce qui manque.
    const msg = String((e as Error)?.message || e);
    if (msg !== s.lastErr) { s.lastErr = msg; post({ type: 'warn', id: s.id, message: `lecture de l'anneau : ${msg}` }); }
  }
}

function poll() {
  for (const s of sessions.values()) if (s.ring) safeDrain(s);
  if (![...sessions.values()].some(s => s.ring) && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/**
 * Réveil par le fil audio (comme le SetEvent du moteur natif) : le worklet fait Atomics.notify sur
 * l'index d'écriture à chaque morceau publié ; on attend dessus (Atomics.waitAsync, 100 ms au plus),
 * sans dépendre d'un minuteur. Le minuteur de 25 ms reste en secours.
 */
async function wakeLoop(s: Session) {
  const r = s.ring!;
  const wa = (Atomics as any).waitAsync as ((a: Int32Array, i: number, v: number, t: number) => { async: boolean; value: Promise<string> | string }) | undefined;
  if (typeof wa !== 'function') return;
  while (sessions.get(s.id) === s) {
    try {
      const res = wa(r.h, 0, Atomics.load(r.h, 0), 100);
      if (res.async) await res.value;
    } catch { await new Promise(t => setTimeout(t, 25)); }
    safeDrain(s);
  }
}

function begin(m: Begin, port: MessagePort | null) {
  const k = Math.max(1, m.k | 0);
  const s: Session = {
    id: m.id, k, sr: m.sr,
    ring: m.ring ? { h: new Int32Array(m.ring.header), d: new Float32Array(m.ring.data), cap: m.ring.capacity } : null,
    port,
    targets: m.targets || [],
    flushFrames: Math.max(256, Math.round(m.sr * (m.flushSec ?? 0.25))),
    forwardFrames: Math.max(256, Math.round(m.sr * (m.forwardSec ?? 0.1))),
    pend: Array.from({ length: k }, () => []), pendLen: 0,
    fwd: Array.from({ length: k }, () => []), fwdLen: 0,
    first: -1, frames: 0, durable: 0, failed: null,
    seq: new Map(), writes: Promise.resolve(), eos: false, eosWait: null, allocs: 0, portLost: 0,
    drains: 0, lastErr: null,
  };
  sessions.set(s.id, s);
  if (s.targets.length) void openDb().catch(() => { /* signalé à la 1re écriture */ });
  if (port) {
    port.onmessage = (ev: MessageEvent) => {
      const d = ev.data;
      if (!d) return;
      if (d.eos) { s.eos = true; s.allocs = d.allocs || 0; s.portLost = d.lost || 0; s.eosWait?.(); return; }
      const b: Float32Array = d.b;
      const n = d.n | 0;
      if (s.first < 0 && typeof d.f === 'number' && d.f >= 0) s.first = d.f;
      const size = (b.length / s.k) | 0;
      const ch: Float32Array[] = [];
      for (let c = 0; c < s.k; c++) ch.push(b.slice(c * size, c * size + n));
      // Le tampon repart vers le fil audio (réserve préallouée : il n'alloue pas).
      try { port.postMessage({ b }, [b.buffer]); } catch { /* port fermé */ }
      take(s, ch);
    };
  }
  if (s.ring && !pollTimer) pollTimer = setInterval(poll, 25);
  if (s.ring) void wakeLoop(s);
}

async function end(id: string) {
  const s = sessions.get(id);
  if (!s) { post({ type: 'ended', id, frames: 0, durable: 0, lost: 0, error: 'prise inconnue' }); return; }
  if (s.ring) safeDrain(s);
  if (s.port && !s.eos) await new Promise<void>(r => { s.eosWait = r; setTimeout(r, 3000); });
  forward(s);
  flushDurable(s);
  await s.writes;
  const lost = (s.ring ? Atomics.load(s.ring.h, RING_LOST) : 0) + s.portLost;
  sessions.delete(id);
  try { s.port?.close(); } catch { /* */ }
  poll();
  post({ type: 'ended', id, first: s.first, frames: s.frames, durable: s.durable, lost, allocs: s.allocs, error: s.failed });
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'begin') begin(m as Begin, e.ports?.[0] || null);
  else if (m.type === 'end') void end(m.id);
  else if (m.type === 'ping') post({ type: 'pong', sessions: sessions.size, polling: !!pollTimer });
  else if (m.type === 'status') {
    const s = sessions.get(m.id);
    post({ type: 'status', id: m.id, frames: s?.frames ?? null, durable: s?.durable ?? null, drains: s?.drains ?? null, err: s?.lastErr ?? s?.failed ?? null, polling: !!pollTimer });
  }
};
