/**
 * Un même projet ouvert dans deux onglets : un seul sauvegarde.
 *
 * Avant : les deux onglets écrivaient chacun leurs versions toutes les 15 s ; « Reprendre
 * ma session » rouvrait la plus récente, parfois celle de l'onglet oublié, et le travail de
 * l'autre semblait perdu (« un onglet écrase l'autre »).
 *
 * Maintenant (BroadcastChannel, même navigateur) : le premier onglet ouvert sur un projet en
 * est le « propriétaire » et sauvegarde ; un 2e onglet sur le même projet est prévenu et ne
 * sauvegarde pas tant qu'on ne clique pas « Travailler ici » (il devient propriétaire, l'autre
 * onglet est prévenu à son tour et arrête de sauvegarder). Sans BroadcastChannel : pas de
 * verrou (comportement d'avant).
 */

export interface LockChannel {
  postMessage(m: unknown): void;
  onmessage: ((ev: { data: any }) => void) | null;
  close(): void;
}

export type TabRole = 'owner' | 'guest';
export interface TabLockInfo {
  role: TabRole;
  projectId: string | null;
  /** Pourquoi cet onglet ne sauvegarde pas : un autre l'avait ouvert avant, ou l'a repris. */
  reason: 'opened-elsewhere' | 'taken-over' | null;
  /** L'onglet propriétaire s'est fermé (le bouton « Travailler ici » suffit alors). */
  ownerGone: boolean;
}

type Msg =
  | { t: 'who'; p: string; id: string; since: number }
  | { t: 'owner'; p: string; id: string; since: number }
  | { t: 'take'; p: string; id: string }
  | { t: 'bye'; p: string; id: string }
  | { t: 'ping'; p: string; id: string; q: string }
  | { t: 'pong'; p: string; id: string; q: string };

const CHANNEL = 'nova-project-lock';

export class ProjectTabLock {
  readonly tabId: string;
  private ch: LockChannel | null;
  private since = 0;
  private info: TabLockInfo = { role: 'owner', projectId: null, reason: null, ownerGone: false };
  private listeners = new Set<(i: TabLockInfo) => void>();
  private pings = new Map<string, () => void>();

  constructor(opts: { channel?: LockChannel | null; tabId?: string; now?: () => number } = {}) {
    this.tabId = opts.tabId || Math.random().toString(36).slice(2, 10);
    this.now = opts.now || Date.now;
    this.ch = opts.channel !== undefined ? opts.channel : makeChannel();
    if (this.ch) this.ch.onmessage = ev => this.onMessage(ev.data as Msg);
  }
  private now: () => number;

  get state(): TabLockInfo { return this.info; }
  /** Cet onglet peut sauvegarder (propriétaire, ou pas de verrou possible). */
  canSave(): boolean { return this.info.role === 'owner'; }

  onChange(cb: (i: TabLockInfo) => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  private set(patch: Partial<TabLockInfo>) {
    const next = { ...this.info, ...patch };
    if (next.role === this.info.role && next.projectId === this.info.projectId && next.reason === this.info.reason && next.ownerGone === this.info.ownerGone) return;
    this.info = next;
    this.listeners.forEach(cb => { try { cb(this.info); } catch { /* écouteur fautif */ } });
  }
  private post(m: Msg) { try { this.ch?.postMessage(m); } catch { /* canal fermé */ } }

  /** Ce projet est ouvert dans cet onglet (nouveau projet, projet rouvert). */
  open(projectId: string) {
    if (this.info.projectId === projectId) return;
    if (this.info.projectId && this.info.role === 'owner') this.post({ t: 'bye', p: this.info.projectId, id: this.tabId });
    this.since = this.now();
    this.set({ projectId, role: 'owner', reason: null, ownerGone: false });
    this.post({ t: 'who', p: projectId, id: this.tabId, since: this.since });
  }

  /** « Travailler ici » : cet onglet sauvegarde, l'autre s'arrête. */
  takeOver() {
    const p = this.info.projectId;
    if (!p) return;
    this.since = this.now();
    this.set({ role: 'owner', reason: null, ownerGone: false });
    this.post({ t: 'take', p, id: this.tabId });
  }

  /** Onglet fermé / projet quitté. */
  close() {
    if (this.info.projectId && this.info.role === 'owner') this.post({ t: 'bye', p: this.info.projectId, id: this.tabId });
    this.set({ projectId: null, role: 'owner', reason: null, ownerGone: false });
  }

  /**
   * Ce projet est-il ouvert dans un AUTRE onglet en ce moment ? Sert au démarrage : le drapeau
   * « séance ouverte » posé par un onglet vivant n'est pas un plantage (avant, un 2e onglet
   * proposait « Récupérer la session » par-dessus l'accueil).
   */
  isOpenElsewhere(projectId: string, timeoutMs = 400): Promise<boolean> {
    if (!this.ch) return Promise.resolve(false);
    const q = Math.random().toString(36).slice(2, 10);
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pings.delete(q); resolve(false); }, timeoutMs);
      this.pings.set(q, () => { clearTimeout(timer); this.pings.delete(q); resolve(true); });
      this.post({ t: 'ping', p: projectId, id: this.tabId, q });
    });
  }

  dispose() { this.close(); try { this.ch?.close(); } catch { /* */ } this.ch = null; this.listeners.clear(); }

  private older(since: number, id: string) {
    // Le plus ancien garde la main ; égalité : le plus petit identifiant.
    return since < this.since || (since === this.since && id < this.tabId);
  }

  private onMessage(m: Msg) {
    if (!m || typeof m !== 'object' || m.id === this.tabId) return;
    const mine = this.info.projectId;
    if (m.t === 'pong') { this.pings.get(m.q)?.(); return; }
    if (m.t === 'ping') { if (mine && m.p === mine) this.post({ t: 'pong', p: mine, id: this.tabId, q: m.q }); return; }
    if (!mine || m.p !== mine) return;
    switch (m.t) {
      case 'who':
        if (this.info.role !== 'owner') return;
        if (this.older(m.since, m.id)) { this.set({ role: 'guest', reason: 'opened-elsewhere', ownerGone: false }); return; }
        this.post({ t: 'owner', p: mine, id: this.tabId, since: this.since });
        return;
      case 'owner':
        if (this.info.role === 'owner' && this.older(m.since, m.id)) this.set({ role: 'guest', reason: 'opened-elsewhere', ownerGone: false });
        else if (this.info.role === 'owner') this.post({ t: 'owner', p: mine, id: this.tabId, since: this.since });
        return;
      case 'take':
        this.set({ role: 'guest', reason: 'taken-over', ownerGone: false });
        return;
      case 'bye':
        if (this.info.role === 'guest') this.set({ ownerGone: true });
        return;
    }
  }
}

function makeChannel(): LockChannel | null {
  try {
    if (typeof BroadcastChannel === 'undefined') return null;
    return new BroadcastChannel(CHANNEL) as unknown as LockChannel;
  } catch { return null; }
}

let shared: ProjectTabLock | null = null;
export function projectTabLock(): ProjectTabLock {
  if (!shared) shared = new ProjectTabLock();
  return shared;
}
