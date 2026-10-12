/**
 * Pont Pro Tools (chantier 9, B2) : l'ingé garde Pro Tools, NOVA est sa porte d'entrée
 * pour la collaboration à distance.
 *
 * 1. PRISES : chaque prise de l'artiste posée chez l'ingé (reçue par la collaboration)
 *    est aussi écrite en WAV BWF horodaté (utils/bwf : bext TimeReference = position de
 *    la prise dans le morceau + départ de la séance, en échantillons ; iXML). Pro Tools
 *    l'importe en mode Spot (« Original Time Stamp ») à l'échantillon près.
 *    Où : Nova Studio (appli Windows) → le pont écrit dans le dossier choisi (chemin
 *    complet, aucun accès à redemander) ; navigateur → dossier choisi par File System
 *    Access s'il existe, sinon téléchargement (dossier Téléchargements).
 * 2. MIX PRO TOOLS DIFFUSÉ : l'ingé choisit une entrée système (retour de la sortie de
 *    Pro Tools : câble virtuel, loopback de la carte) comme source du « mix en direct »
 *    (services/CollabRtc, Opus stéréo 510 kb/s) ; niveau G / D et message clair si
 *    l'entrée est mono, d'un seul côté ou muette. Côté artiste : rien ne change.
 */
import { encodeBwf } from '../utils/bwf';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { isNovaDesktop } from '../utils/desktopApp';
import {
  DEFAULT_PT_SETTINGS, IncomingTake, InputVerdict, InputWindow, inputVerdict, isTake, planTake, positionLabel,
  ProToolsSettings, PT_SETTINGS_KEY, sanitizePtSettings, takeSig,
} from '../utils/proToolsBridge';

export type PtTarget = 'bridge' | 'folder' | 'download';

export interface PtEntry {
  clipId: string;
  file: string;
  track: string;
  take: number;
  artist: string;
  /** Position de la prise dans le morceau (échantillons) et TimeReference écrit. */
  position: number;
  timeReference: number;
  sampleRate: number;
  target: PtTarget;
  status: 'envoi' | 'ok' | 'attente' | 'erreur';
  /** Chemin complet (pont) ou nom dans le dossier choisi. */
  path?: string;
  error?: string;
  /** Prise posée chez l'ingé → fichier écrit (ms). */
  ms?: number;
  /** Version mise à jour d'une prise déjà écrite (déplacée, recoupée). */
  updated?: boolean;
  /** Fichier ouvert dans Pro Tools : écrit à côté (« (2) »). */
  renamed?: boolean;
  at: number;
}

export interface TakesBatch {
  trackId: string;
  trackName: string;
  artist: string;
  project?: string;
  clips: IncomingTake[];
}

/** Ce qu'il faut pour écrire (injecté dans les tests). */
export interface PtDeps {
  getBuffer: (id: string) => { length: number; sampleRate: number; numberOfChannels: number; getChannelData(c: number): Float32Array } | undefined;
  /** Pont de Nova Studio disponible (et capable d'écrire les prises). */
  bridgeReady: () => Promise<boolean>;
  writeBridge: (folder: string, name: string, bytes: Uint8Array) => Promise<{ path: string; renamed: boolean }>;
  writeFolder: (dir: any, name: string, bytes: Uint8Array) => Promise<void>;
  /** Accès au dossier choisi : accordé, à redemander (geste de l'ingé), ou refusé. */
  folderPermission: (dir: any, ask: boolean) => Promise<'granted' | 'prompt' | 'denied'>;
  download: (name: string, bytes: Uint8Array) => void;
  now: () => number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

type Listener = () => void;

export class ProToolsSink {
  private settings: ProToolsSettings;
  private listeners = new Set<Listener>();
  private sigs = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private waiting: { batch: TakesBatch; take: IncomingTake; receivedAt: number }[] = [];
  /** Dossier choisi dans le navigateur (File System Access). */
  dir: any = null;
  entries: PtEntry[] = [];
  /** Dernier événement (pour le message en bas de l'écran). */
  onWritten?: (e: PtEntry) => void;

  constructor(private deps: PtDeps) {
    let raw: unknown = null;
    try { raw = JSON.parse(deps.storage?.getItem(PT_SETTINGS_KEY) || 'null'); } catch { /* */ }
    this.settings = sanitizePtSettings(raw || DEFAULT_PT_SETTINGS);
  }

  subscribe(cb: Listener): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  private emit() { this.listeners.forEach(cb => { try { cb(); } catch { /* */ } }); }

  getSettings(): ProToolsSettings { return this.settings; }
  setSettings(patch: Partial<ProToolsSettings>) {
    this.settings = sanitizePtSettings({ ...this.settings, ...patch });
    try { this.deps.storage?.setItem(PT_SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* */ }
    this.emit();
  }

  setDir(dir: any) { this.dir = dir; this.emit(); }

  /** Où iront les prises maintenant. */
  async target(): Promise<PtTarget> {
    if (await this.deps.bridgeReady().catch(() => false)) return 'bridge';
    return this.dir ? 'folder' : 'download';
  }

  pendingPermission(): number { return this.waiting.length; }

  /**
   * Prises reçues (opération « content » de l'artiste, appliquée chez l'ingé).
   * Nouvelles ou modifiées : écrites ; déjà à jour : rien. Ne bloque jamais l'appelant.
   */
  noteIncoming(batch: TakesBatch): number {
    if (!this.settings.enabled) return 0;
    const receivedAt = this.deps.now();
    let n = 0;
    for (const t of batch.clips) {
      if (!isTake(t)) continue;
      const sig = takeSig(t);
      const prev = this.sigs.get(t.clipId);
      if (prev === sig) continue;
      this.sigs.set(t.clipId, sig);
      n++;
      this.enqueue(batch, t, receivedAt, prev !== undefined);
    }
    return n;
  }

  /** Attendre que tout ce qui est en file soit écrit (tests, QA). */
  idle(): Promise<void> { return this.chain; }

  private enqueue(batch: TakesBatch, take: IncomingTake, receivedAt: number, updated: boolean) {
    this.chain = this.chain.then(() => this.writeOne(batch, take, receivedAt, updated)).catch(() => { /* chaque prise gère son erreur */ });
  }

  private upsert(e: PtEntry) {
    const i = this.entries.findIndex(x => x.clipId === e.clipId);
    if (i >= 0) this.entries[i] = e; else this.entries.unshift(e);
    this.entries = this.entries.slice(0, 30);
    this.emit();
  }

  private async writeOne(batch: TakesBatch, take: IncomingTake, receivedAt: number, updated: boolean) {
    const s = this.settings;
    const buf = take.bufferId ? this.deps.getBuffer(take.bufferId) : undefined;
    const base: PtEntry = { clipId: take.clipId, file: '', track: batch.trackName, take: take.takeNumber || 1, artist: batch.artist,
      position: 0, timeReference: 0, sampleRate: buf?.sampleRate || 0, target: 'download', status: 'envoi', at: this.deps.now(), ...(updated ? { updated } : {}) };
    if (!buf) { this.sigs.delete(take.clipId); this.upsert({ ...base, status: 'erreur', error: 'Son de la prise introuvable' }); return; }
    const plan = planTake(take, batch.trackName, batch.artist, buf.length, buf.sampleRate, s);
    if (!plan) { this.upsert({ ...base, status: 'erreur', error: 'Prise vide' }); return; }
    const channels = Array.from({ length: buf.numberOfChannels }, (_c, c) => buf.getChannelData(c).slice(plan.region.from, plan.region.from + plan.region.length));
    const bytes = encodeBwf({
      channels, sampleRate: buf.sampleRate, format: s.format, timeReference: plan.timeReference,
      info: { project: batch.project, track: batch.trackName, take: take.takeNumber || 1, artist: batch.artist, fps: s.fps },
    });
    const target = await this.target();
    const entry: PtEntry = { ...base, file: plan.name, position: plan.region.position, timeReference: plan.timeReference, sampleRate: buf.sampleRate, target };
    this.upsert(entry);
    try {
      if (target === 'bridge') {
        const r = await this.deps.writeBridge(s.folder, plan.name, bytes);
        entry.path = r.path;
        if (r.renamed) entry.renamed = true;
      } else if (target === 'folder') {
        const perm = await this.deps.folderPermission(this.dir, false);
        if (perm !== 'granted') {
          // Le navigateur redemande l'accès au dossier (après un rechargement) : la prise attend
          // le clic de l'ingé sur « Autoriser » (rien ne se perd).
          this.waiting.push({ batch, take, receivedAt });
          this.sigs.delete(take.clipId);
          this.upsert({ ...entry, status: 'attente', error: perm === 'denied' ? 'Accès au dossier refusé' : 'Accès au dossier à autoriser' });
          return;
        }
        await this.deps.writeFolder(this.dir, plan.name, bytes);
        entry.path = plan.name;
      } else {
        this.deps.download(plan.name, bytes);
        entry.path = plan.name;
      }
      const done: PtEntry = { ...entry, status: 'ok', ms: Math.round(this.deps.now() - receivedAt), at: this.deps.now() };
      this.upsert(done);
      this.onWritten?.(done);
    } catch (e: any) {
      this.sigs.delete(take.clipId); // réessayée à la prochaine réception (ou « Réessayer »)
      this.upsert({ ...entry, status: 'erreur', error: String(e?.message || e).slice(0, 300) });
    }
  }

  /** Geste de l'ingé : autoriser le dossier choisi, puis écrire les prises en attente. */
  async grantFolder(): Promise<boolean> {
    if (!this.dir) return false;
    const perm = await this.deps.folderPermission(this.dir, true).catch(() => 'denied' as const);
    if (perm !== 'granted') return false;
    const w = this.waiting.splice(0);
    w.forEach(x => { this.sigs.set(x.take.clipId, takeSig(x.take)); this.enqueue(x.batch, x.take, x.receivedAt, false); });
    this.emit();
    return true;
  }

  /** Écrire aussi les prises déjà dans la séance (arrivées avant l'activation). */
  sendExisting(batches: TakesBatch[]): number {
    return batches.reduce((n, b) => n + this.noteIncoming(b), 0);
  }

  /** Oublier ce qui a été écrit (changement de dossier ou de format : tout repart). */
  forget() { this.sigs.clear(); this.entries = []; this.waiting = []; this.emit(); }
}

/** Clips d'une piste (état de NOVA) → prises à écrire. */
export function takesBatchOf(trackId: string, trackName: string, artist: string,
  clips: { id: string; bufferId?: string; start: number; offset?: number; duration: number; takeNumber?: number; name?: string; isUnlicensed?: boolean }[],
  project?: string): TakesBatch {
  return {
    trackId, trackName, artist, project,
    clips: clips.map(c => ({ clipId: c.id, bufferId: c.bufferId, start: c.start, offset: c.offset, duration: c.duration, takeNumber: c.takeNumber, name: c.name, isUnlicensed: c.isUnlicensed })),
  };
}

/** Message en bas de l'écran quand une prise part vers Pro Tools. */
export function writtenMessage(e: PtEntry): string {
  const where = e.target === 'download' ? 'dans Téléchargements' : e.target === 'folder' ? 'dans le dossier Pro Tools' : 'dans le dossier Pro Tools';
  return `🎚️ Prise envoyée vers Pro Tools : « ${e.file} » ${where} (Spot à ${positionLabel(e.position, e.sampleRate)}${e.renamed ? ', l’original étant ouvert dans Pro Tools' : ''}).`;
}

// --- Écritures réelles (navigateur / Nova Studio) ------------------------------------------

export const browserDeps = (): PtDeps => ({
  getBuffer: (id) => audioBufferRegistry.get(id) as any,
  bridgeReady: async () => {
    const { novaBridge } = await import('./NovaBridge');
    if (novaBridge.proToolsFiles()) return true;
    // Nova Studio : le pont tourne toujours, on s'y relie au besoin.
    if (isNovaDesktop()) {
      const ok = await novaBridge.connect().catch(() => false);
      return ok && novaBridge.proToolsFiles();
    }
    return false;
  },
  writeBridge: async (folder, name, bytes) => (await import('./NovaBridge')).novaBridge.writeProToolsFile(folder, name, bytes),
  writeFolder: async (dir, name, bytes) => {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  },
  folderPermission: async (dir, ask) => {
    if (!dir) return 'denied';
    if (typeof dir.queryPermission !== 'function') return 'granted';
    let p = await dir.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted' && ask && typeof dir.requestPermission === 'function') p = await dir.requestPermission({ mode: 'readwrite' });
    return p;
  },
  download: (name, bytes) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  storage: typeof localStorage !== 'undefined' ? localStorage : null,
});

let sinkSingleton: ProToolsSink | null = null;
export function proToolsSink(): ProToolsSink {
  if (!sinkSingleton) {
    sinkSingleton = new ProToolsSink(browserDeps());
    void restoreDir(sinkSingleton);
  }
  return sinkSingleton;
}

// Dossier du navigateur gardé d'une visite à l'autre (IndexedDB : un handle ne va pas dans localStorage).
const IDB = 'nova-protools';
const idb = (): Promise<IDBDatabase | null> => new Promise(res => {
  try {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('h');
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
  } catch { res(null); }
});
async function restoreDir(sink: ProToolsSink) {
  const db = await idb();
  if (!db) return;
  try {
    const tx = db.transaction('h', 'readonly').objectStore('h').get('dir');
    tx.onsuccess = () => { if (tx.result && !sink.dir) sink.setDir(tx.result); };
  } catch { /* */ }
}
export async function saveDir(dir: any) {
  const db = await idb();
  if (!db) return;
  try { db.transaction('h', 'readwrite').objectStore('h').put(dir, 'dir'); } catch { /* handle non sérialisable : gardé pour cette visite */ }
}

/** Le navigateur sait-il choisir un dossier (File System Access) ? */
export const canPickFolder = (): boolean => typeof window !== 'undefined' && typeof (window as any).showDirectoryPicker === 'function';

/** Nova Studio sait-il ouvrir le sélecteur de dossier de Windows ? */
export const desktopFolderPicker = (): boolean => {
  if (typeof window === 'undefined') return false;
  const w = window as any;
  return Array.isArray(w.__novaDesktop?.features) && w.__novaDesktop.features.includes('pick-folder') && typeof w.chrome?.webview?.postMessage === 'function';
};

/** Sélecteur de dossier de Windows (Nova Studio) : chemin choisi, ou null (annulé). */
export function pickDesktopFolder(initial: string): Promise<string | null> {
  const wv = (window as any).chrome?.webview;
  return new Promise(resolve => {
    const done = (v: string | null) => { try { wv.removeEventListener('message', h); } catch { /* */ } clearTimeout(timer); resolve(v); };
    const h = (e: any) => {
      let m: any = e?.data;
      if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return; } }
      if (m && m.type === 'nova-desktop-folder') done(typeof m.path === 'string' && m.path ? m.path : null);
    };
    const timer = setTimeout(() => done(null), 10 * 60 * 1000);
    wv.addEventListener('message', h);
    wv.postMessage(`nova-desktop:pick-folder:${JSON.stringify({ initial: initial || '' })}`);
  });
}

// --- Entrée système diffusée comme mix -------------------------------------------------------

export type MixSourceKind = 'nova' | 'input';

export interface MixInputView {
  deviceId: string;
  label: string;
  channelCount: number | null;
  verdict: InputVerdict;
  /** Énergie moyenne G / D sur la dernière seconde. */
  msL: number;
  msR: number;
  error?: string;
}

const MIX_SRC_KEY = 'nova_mix_source';

/**
 * Source du « mix en direct » de l'ingé : le master de NOVA, ou une entrée système
 * (sortie de Pro Tools renvoyée en loopback). L'entrée passe par un contexte audio à
 * 48 kHz (celui d'Opus) et une destination STÉRÉO : le flux envoyé est toujours en deux
 * canaux, comme le mix de NOVA, et on mesure gauche / droite au passage.
 */
export class MixSourceController {
  kind: MixSourceKind = 'nova';
  deviceId = '';
  view: MixInputView | null = null;
  private listeners = new Set<Listener>();
  private changeListeners = new Set<Listener>();
  private ctx: AudioContext | null = null;
  private media: MediaStream | null = null;
  private out: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private opening: Promise<MediaStream | null> | null = null;

  constructor() {
    try {
      const v = JSON.parse(localStorage.getItem(MIX_SRC_KEY) || 'null');
      if (v && (v.kind === 'input' || v.kind === 'nova')) { this.kind = v.kind; this.deviceId = String(v.deviceId || ''); }
    } catch { /* */ }
  }

  subscribe(cb: Listener): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  /** Source changée pendant la diffusion : l'appli remplace le flux envoyé. */
  onChange(cb: Listener): () => void { this.changeListeners.add(cb); return () => { this.changeListeners.delete(cb); }; }
  private emit() { this.listeners.forEach(cb => { try { cb(); } catch { /* */ } }); }

  async listInputs(): Promise<{ deviceId: string; label: string }[]> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter(d => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Entrée ${i + 1}` }));
    } catch { return []; }
  }

  setSource(kind: MixSourceKind, deviceId?: string) {
    const changed = kind !== this.kind || (deviceId !== undefined && deviceId !== this.deviceId);
    this.kind = kind;
    if (deviceId !== undefined) this.deviceId = deviceId;
    try { localStorage.setItem(MIX_SRC_KEY, JSON.stringify({ kind: this.kind, deviceId: this.deviceId })); } catch { /* */ }
    if (changed) {
      this.closeInput();
      this.emit();
      this.changeListeners.forEach(cb => { try { cb(); } catch { /* */ } });
    }
  }

  /** Flux stéréo de l'entrée choisie (ouvert une fois), mesuré en continu. */
  openInput(): Promise<MediaStream | null> {
    if (this.out) return Promise.resolve(this.out);
    if (!this.opening) this.opening = this.doOpen().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async doOpen(): Promise<MediaStream | null> {
    const deviceId = this.deviceId;
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 },
        // Un mix : aucun traitement de voix (sinon mono, compressé, filtré).
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      } as MediaTrackConstraints });
      const track = media.getAudioTracks()[0];
      const st = (track?.getSettings?.() || {}) as MediaTrackSettings & { channelCount?: number };
      const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      try { await ctx.resume(); } catch { /* */ }
      const src = ctx.createMediaStreamSource(media);
      const dest = ctx.createMediaStreamDestination();
      dest.channelCount = 2;
      dest.channelCountMode = 'explicit';
      // Entrée mono : recopiée à gauche et à droite (« speakers »), le message le dit.
      dest.channelInterpretation = 'speakers';
      src.connect(dest);
      const split = ctx.createChannelSplitter(2);
      const anL = ctx.createAnalyser(), anR = ctx.createAnalyser();
      anL.fftSize = anR.fftSize = 2048;
      // Mesure : canaux tels quels (une entrée mono n'a qu'un canal, la droite reste vide → « mono » par le nombre de canaux).
      src.connect(split);
      split.connect(anL, 0); split.connect(anR, 1);
      const label = (track?.label || 'Entrée système').slice(0, 80);
      const declared = typeof st.channelCount === 'number' ? st.channelCount : (src.channelCount || null);
      this.ctx = ctx; this.media = media; this.out = dest.stream;
      try { const t = dest.stream.getAudioTracks()[0]; if (t && 'contentHint' in t) t.contentHint = 'music'; } catch { /* */ }
      const a = new Float32Array(2048), b = new Float32Array(2048);
      const hist: { l: number; r: number; d: number }[] = [];
      let silentSince: number | null = null;
      const t0 = performance.now();
      this.view = { deviceId, label, channelCount: declared, verdict: 'attente', msL: 0, msR: 0 };
      this.timer = setInterval(() => {
        anL.getFloatTimeDomainData(a); anR.getFloatTimeDomainData(b);
        let l = 0, r = 0, d = 0;
        for (let i = 0; i < a.length; i++) { l += a[i] * a[i]; r += b[i] * b[i]; d += (a[i] - b[i]) * (a[i] - b[i]); }
        hist.push({ l: l / a.length, r: r / a.length, d: d / a.length });
        if (hist.length > 10) hist.shift();
        const now = performance.now();
        const loud = Math.max(l, r) / a.length > 1e-7;
        if (loud) silentSince = null; else if (silentSince === null) silentSince = now;
        const win: InputWindow = {
          channelCount: declared,
          msL: hist.reduce((s, x) => s + x.l, 0) / hist.length,
          msR: hist.reduce((s, x) => s + x.r, 0) / hist.length,
          msDiff: hist.reduce((s, x) => s + x.d, 0) / hist.length,
          seconds: (now - t0) / 1000,
          silentFor: silentSince === null ? 0 : (now - silentSince) / 1000,
        };
        this.view = { deviceId, label, channelCount: declared, verdict: inputVerdict(win), msL: win.msL, msR: win.msR };
        this.emit();
      }, 100);
      this.emit();
      return this.out;
    } catch (e: any) {
      this.view = { deviceId, label: 'Entrée système', channelCount: null, verdict: 'muette', msL: 0, msR: 0,
        error: e?.name === 'NotAllowedError' ? "Accès à l'entrée refusé : autorise le micro / les entrées pour NOVA." : e?.name === 'OverconstrainedError' ? 'Cette entrée a disparu : choisis-en une autre.' : `Entrée impossible à ouvrir (${e?.message || e}).` };
      this.emit();
      return null;
    }
  }

  /** Flux du mix à envoyer selon la source choisie. */
  async stream(novaMix: () => MediaStream | null): Promise<MediaStream | null> {
    if (this.kind === 'input') return this.openInput();
    return novaMix();
  }

  closeInput() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.media?.getTracks().forEach(t => t.stop());
    try { void this.ctx?.close(); } catch { /* */ }
    this.ctx = null; this.media = null; this.out = null; this.view = null;
    this.emit();
  }
}

let mixSingleton: MixSourceController | null = null;
export function mixSource(): MixSourceController {
  if (!mixSingleton) mixSingleton = new MixSourceController();
  return mixSingleton;
}
