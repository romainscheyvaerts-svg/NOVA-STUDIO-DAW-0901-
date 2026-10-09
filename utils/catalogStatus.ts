/**
 * État du service du catalogue (Supabase « catalogue » : beats, mélodies, pochettes).
 *
 * Quand le projet Supabase est restreint (quota gratuit d'egress dépassé : réponses
 * 402, « exceed_egress_quota »), ou simplement injoignable, NOVA ne doit ni planter
 * ni réessayer en boucle (chaque essai consommerait encore du quota). Ici :
 *  - on reconnaît l'erreur de quota (402 / « restricted » / « exceed_…_quota ») ;
 *  - chaque échec repousse le prochain essai (délai croissant, plafonné) ;
 *  - tant que le délai court, aucune requête ne part : on sert la dernière copie
 *    du catalogue s'il y en a une, sinon un message clair ;
 *  - l'état survit au rechargement de la page (localStorage) : recharger ne
 *    relance pas une rafale de requêtes.
 */

export type CatalogOutageKind = 'quota' | 'offline' | 'error';

export interface CatalogOutage {
  kind: CatalogOutageKind;
  /** Premier échec de la série (ms). */
  since: number;
  /** Échecs consécutifs. */
  attempts: number;
  /** Pas de nouvel essai réseau avant cet instant (ms). */
  retryAt: number;
  /** Détail technique (journal), jamais affiché tel quel. */
  detail: string;
}

const KEY = 'nova_catalog_outage';
// Délais entre deux essais. Quota : la restriction dure (heures, jours) → on espace vite.
const DELAYS: Record<CatalogOutageKind, number[]> = {
  quota: [60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000],
  offline: [5_000, 15_000, 30_000, 60_000, 120_000, 300_000],
  error: [10_000, 30_000, 60_000, 120_000, 300_000, 600_000],
};

export const retryDelay = (kind: CatalogOutageKind, attempts: number): number => {
  const d = DELAYS[kind];
  return d[Math.min(Math.max(attempts, 1), d.length) - 1];
};

/** Une erreur qui porte le code HTTP (fetch, Supabase). */
export class CatalogHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'CatalogHttpError';
  }
}

/** Erreur de quota Supabase (projet restreint) ? */
export const isQuotaError = (status?: number | null, message?: string | null): boolean =>
  status === 402 || /exceed_\w*quota|restricted|quota|payment required/i.test(String(message || ''));

const read = (): CatalogOutage | null => {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || 'null');
    return o && typeof o.retryAt === 'number' ? o : null;
  } catch { return null; }
};

let outage: CatalogOutage | null = typeof localStorage !== 'undefined' ? read() : null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => { try { l(); } catch { /* */ } });
const save = () => {
  try {
    if (outage) localStorage.setItem(KEY, JSON.stringify(outage));
    else localStorage.removeItem(KEY);
  } catch { /* stockage indisponible */ }
};

export const classifyError = (e: unknown, status?: number | null): CatalogOutageKind => {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  const st = status ?? (e as any)?.status;
  if (isQuotaError(st, msg)) return 'quota';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  if (/failed to fetch|networkerror|network request failed|load failed|internet/i.test(msg)) return 'offline';
  return 'error';
};

// Retour du réseau : un catalogue « hors ligne » peut être réessayé tout de suite
// (pas pour le quota : ce n'est pas la connexion de l'utilisateur qui bloque).
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (outage?.kind === 'offline') { outage = { ...outage, retryAt: Date.now() }; save(); emit(); }
  });
}

export const catalogStatus = {
  get: (): CatalogOutage | null => outage,
  subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },

  /** Un échec : on note le type et on repousse le prochain essai. */
  fail(e: unknown, status?: number | null): CatalogOutage {
    const kind = classifyError(e, status);
    const attempts = (outage && outage.kind === kind ? outage.attempts : 0) + 1;
    const now = Date.now();
    outage = {
      kind,
      since: outage?.since ?? now,
      attempts,
      retryAt: now + retryDelay(kind, attempts),
      detail: (e instanceof Error ? e.message : String(e ?? '')).slice(0, 300),
    };
    save(); emit();
    return outage;
  },

  /** Le catalogue répond de nouveau. */
  ok() {
    if (!outage) return;
    outage = null;
    save(); emit();
  },

  /** Peut-on tenter une requête maintenant ? (faux pendant le délai d'attente) */
  canTry(now = Date.now()): boolean {
    if (!outage) return true;
    return now >= outage.retryAt;
  },

  /** Millisecondes avant le prochain essai autorisé (0 si maintenant). */
  msUntilRetry(now = Date.now()): number {
    return outage ? Math.max(0, outage.retryAt - now) : 0;
  },

  /** Tests : repart de zéro. */
  reset() { outage = null; save(); emit(); },
};

/** Textes pour l'utilisateur (aucun code d'erreur technique). */
export const outageMessage = (o: CatalogOutage | null): { title: string; hint: string } => {
  if (o?.kind === 'offline') {
    return { title: 'Pas de connexion au catalogue pour le moment.', hint: 'Tu peux travailler avec tes propres fichiers : le catalogue revient dès que la connexion est là.' };
  }
  return { title: 'Le catalogue est momentanément indisponible.', hint: 'Tu peux travailler avec tes propres fichiers.' };
};

/** « dans 1 min 30 », « dans 12 s ». */
export const formatWait = (ms: number): string => {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} min ${String(r).padStart(2, '0')}` : `${m} min`;
};
