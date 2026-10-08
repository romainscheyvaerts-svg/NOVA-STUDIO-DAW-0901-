/**
 * File d'envoi de la collaboration « En direct » : aucune modification ne se
 * perd quand le réseau tombe (avant : un réglage de l'ingé envoyé hors ligne
 * était perdu, sans le moindre message).
 *
 * Une entrée par clé (« mix:voix », « lock:voix », « chat:<id> ») : une
 * nouvelle modification de la même clé remplace (ou complète, via `merge`)
 * celle qui attend ; une seule opération part. Envoi en série et dans l'ordre ;
 * au premier échec on s'arrête (réseau coupé) et tout repart au passage
 * suivant (reconnexion, minuteur, retour du réseau).
 *
 * Idempotence : chaque entrée porte un identifiant (`_id` dans l'opération),
 * gardé tel quel pour un nouvel essai. Si le serveur avait enregistré
 * l'opération mais que la réponse s'est perdue, l'autre côté reconnaît le
 * doublon à cet identifiant et ne l'applique qu'une fois.
 *
 * Module pur (aucun réseau) : l'envoi est injecté, testable tel quel.
 */

export interface OutboxEntry {
  key: string;
  kind: string;
  op: Record<string, any>;
  /** Identifiant de l'opération (doublons reconnus de l'autre côté). */
  opId: string;
  tries: number;
  firstAt: number;
}

/** Stockage des entrées (localStorage) : la file survit à un rechargement de la page. */
export interface CollabOutboxStore {
  load(): OutboxEntry[];
  save(entries: OutboxEntry[]): void;
}

export interface CollabOutboxOptions {
  /** Fusion de deux modifications de la même clé (sinon la nouvelle remplace l'ancienne). */
  merge?: (kind: string, older: Record<string, any>, newer: Record<string, any>) => Record<string, any>;
  onChange?: () => void;
  store?: CollabOutboxStore;
  /**
   * Modification refusée pour de bon par le serveur (opération invalide, trop
   * grosse) : retirée de la file, sinon elle bloquait TOUT ce qui suivait
   * (avant : la file s'arrêtait à elle pour toujours, « hors ligne » affiché).
   */
  onDrop?: (entry: OutboxEntry, error: string) => void;
  now?: () => number;
  newId?: () => string;
}

export interface FlushResult { sent: number; failed: boolean; error?: string }

const randomId = (): string => {
  try { if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return (crypto as Crypto).randomUUID(); } catch { /* */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

export class CollabOutbox {
  private entries = new Map<string, OutboxEntry>();
  /** Entrée en cours d'envoi (retirée de la file : une modification arrivée entre-temps ne s'y mélange pas). */
  private inflight: OutboxEntry | null = null;
  private running: Promise<FlushResult> | null = null;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private send: (kind: string, op: Record<string, any>) => Promise<unknown>, private opts: CollabOutboxOptions = {}) {
    this.now = opts.now || Date.now;
    this.newId = opts.newId || randomId;
    for (const e of opts.store?.load() || []) {
      if (e && typeof e.key === 'string' && typeof e.kind === 'string' && e.op && typeof e.opId === 'string') this.entries.set(e.key, { ...e, tries: e.tries || 0 });
    }
  }

  /** Met une modification en file (remplace / complète celle de la même clé). */
  put(key: string, kind: string, op: Record<string, any>): void {
    const prev = this.entries.get(key);
    if (prev) {
      const merged = this.opts.merge ? this.opts.merge(kind, prev.op, op) : op;
      // Contenu différent : nouvel identifiant (l'ancien a peut-être été enregistré).
      this.entries.set(key, { ...prev, kind, op: merged, opId: this.newId() });
    } else {
      this.entries.set(key, { key, kind, op, opId: this.newId(), tries: 0, firstAt: this.now() });
    }
    this.changed();
  }

  /** Modification en attente (ou en cours d'envoi) pour cette clé. */
  peek(key: string): Record<string, any> | null {
    const q = this.entries.get(key)?.op;
    const f = this.inflight?.key === key ? this.inflight.op : null;
    if (q && f && this.opts.merge) return this.opts.merge(this.entries.get(key)!.kind, f, q);
    return q || f || null;
  }

  /** Modification en attente pour cette clé, SANS celle en cours d'envoi. */
  peekQueued(key: string): Record<string, any> | null { return this.entries.get(key)?.op || null; }

  has(key: string): boolean { return this.entries.has(key) || this.inflight?.key === key; }
  /** Nombre de modifications pas encore parties (celle en cours d'envoi comprise). */
  size(): number { return this.entries.size + (this.inflight ? 1 : 0); }
  keys(): string[] { return [...(this.inflight ? [this.inflight.key] : []), ...this.entries.keys()]; }
  /** Plus ancienne modification en attente (ms), pour l'affichage. */
  oldest(): number | null {
    const all = [...this.entries.values(), ...(this.inflight ? [this.inflight] : [])];
    return all.length ? Math.min(...all.map(e => e.firstAt)) : null;
  }

  /** Envoie tout ce qui attend, dans l'ordre (un seul passage à la fois). */
  flush(): Promise<FlushResult> {
    if (!this.running) this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  clear(): void {
    this.entries.clear();
    this.changed();
  }

  private async run(): Promise<FlushResult> {
    let sent = 0;
    while (this.entries.size) {
      const [key, entry] = this.entries.entries().next().value as [string, OutboxEntry];
      this.entries.delete(key);
      this.inflight = entry;
      try {
        await this.send(entry.kind, { ...entry.op, _id: entry.opId });
        sent++;
        this.inflight = null;
        this.changed();
      } catch (e: any) {
        this.inflight = null;
        if (e && e.permanent) {
          this.changed();
          try { this.opts.onDrop?.(entry, String(e?.message || 'refusée')); } catch { /* */ }
          continue;
        }
        const failed = { ...entry, tries: entry.tries + 1 };
        const newer = this.entries.get(key);
        // Une modification plus récente de la même clé est arrivée pendant l'envoi : elle passe devant.
        const back = newer
          ? { ...newer, op: this.opts.merge ? this.opts.merge(newer.kind, failed.op, newer.op) : newer.op, firstAt: failed.firstAt, tries: failed.tries }
          : failed;
        // Remise en tête de file (l'ordre des modifications est gardé).
        const rest = [...this.entries.entries()].filter(([k]) => k !== key);
        this.entries = new Map([[key, back], ...rest]);
        this.changed();
        return { sent, failed: true, error: String(e?.message || e || 'Erreur réseau') };
      }
    }
    return { sent, failed: false };
  }

  private changed() {
    this.opts.store?.save([...(this.inflight ? [this.inflight] : []), ...this.entries.values()]);
    this.opts.onChange?.();
  }
}

/** File gardée dans le navigateur (par session et par rôle). Trop grosse : pas gardée. */
export const localCollabOutboxStore = (key: string, maxChars = 2_000_000): CollabOutboxStore => ({
  load: () => {
    try {
      const v = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  },
  save: (entries) => {
    try {
      if (!entries.length) { localStorage.removeItem(key); return; }
      const s = JSON.stringify(entries);
      if (s.length <= maxChars) localStorage.setItem(key, s);
    } catch { /* stockage indisponible ou plein */ }
  },
});
