/**
 * Journaux joints aux signalements (« Signaler un bug / proposer une idée ») :
 *  - les 30 dernières erreurs ou avertissements de la console (tampon circulaire
 *    installé au démarrage, voir index.tsx) ;
 *  - les 20 dernières actions de l'utilisateur, ANONYMISÉES : des noms de
 *    commandes (« edit:split », « raccourci:pt.zoomIn », « clic:fa-save »),
 *    jamais de contenu (noms de pistes, paroles, texte saisi, audio).
 *
 * Tout ce qui sort d'ici passe par `redact` : jetons, clés, mots de passe et
 * adresses e-mail sont remplacés avant d'être gardés.
 */

export class RingBuffer<T> {
  private items: T[] = [];
  constructor(readonly capacity: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }
  /** Du plus ancien au plus récent. */
  toArray(): T[] { return this.items.slice(); }
  clear(): void { this.items = []; }
  get size(): number { return this.items.length; }
}

/**
 * Retire tout ce qui ressemble à un secret ou à une donnée personnelle :
 * jetons JWT, « Bearer … », clés Supabase / Stripe / API, paramètres
 * token=… / password=…, adresses e-mail, longues chaînes aléatoires.
 */
export const redact = (input: string): string => {
  let s = String(input ?? '');
  s = s.replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?/g, '[jeton masqué]');
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [masqué]');
  s = s.replace(/\b(sb_(?:secret|publishable)_|sk_(?:live|test)_|pk_(?:live|test)_|rk_(?:live|test)_|AIza|AQ\.|ghp_|gho_|xox[abp]-)[A-Za-z0-9._-]{6,}/g, '[clé masquée]');
  s = s.replace(/((?:access|refresh|id)?_?token|apikey|api_key|key|secret|password|passwd|mot_?de_?passe|pwd|signature)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]{3,}/gi, '$1$2[masqué]');
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[e-mail]');
  // Longues suites aléatoires (clés, identifiants de session) : 40 caractères ou plus.
  s = s.replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[masqué]');
  return s;
};

// --- Console ----------------------------------------------------------------------

export interface ConsoleEntry { level: 'error' | 'warn'; message: string; at: string }

export const CONSOLE_CAPACITY = 30;
export const consoleRing = new RingBuffer<ConsoleEntry>(CONSOLE_CAPACITY);

const stringifyArg = (a: unknown): string => {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === 'string') return a;
  if (a === null || a === undefined || typeof a === 'number' || typeof a === 'boolean') return String(a);
  // Objets : seulement leur forme (clés), jamais leur contenu (projet, session, réponses serveur…).
  try {
    if (Array.isArray(a)) return `[tableau de ${a.length}]`;
    const name = (a as object).constructor?.name || 'Objet';
    const keys = Object.keys(a as object).slice(0, 6).join(', ');
    return `{${name}${keys ? ` : ${keys}` : ''}}`;
  } catch { return '{objet}'; }
};

export const recordConsole = (level: 'error' | 'warn', args: unknown[]): void => {
  try {
    const message = redact(args.map(stringifyArg).join(' ')).slice(0, 300);
    if (!message.trim()) return;
    consoleRing.push({ level, message, at: new Date().toISOString() });
  } catch { /* le journal ne doit jamais gêner le studio */ }
};

let consoleInstalled = false;
/** Tampon des erreurs : à appeler une fois, au démarrage (index.tsx). */
export const installConsoleRing = (): void => {
  if (consoleInstalled || typeof console === 'undefined') return;
  consoleInstalled = true;
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      recordConsole(level, args);
      original(...args);
    };
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (ev) => recordConsole('error', [ev.error || ev.message || 'Erreur']));
    window.addEventListener('unhandledrejection', (ev) => recordConsole('error', ['Promesse rejetée :', (ev as PromiseRejectionEvent).reason]));
  }
};

// --- Actions -----------------------------------------------------------------------

export interface ActionEntry { action: string; at: string }

export const ACTION_CAPACITY = 20;
export const actionRing = new RingBuffer<ActionEntry>(ACTION_CAPACITY);

/** Un nom de commande : lettres, chiffres, « . _ : - », 2 à 48 caractères. */
const ACTION_NAME = /^[a-z][a-z0-9._:-]{1,47}$/i;

/** Note une action (nom de commande seulement). Tout autre texte est refusé. */
export const recordAction = (name: string): void => {
  try {
    const n = String(name || '').trim();
    if (!ACTION_NAME.test(n)) return;
    const last = actionRing.toArray().pop();
    // Une touche maintenue ou un double-clic ne remplissent pas tout le journal.
    if (last && last.action === n && Date.now() - Date.parse(last.at) < 400) return;
    actionRing.push({ action: n, at: new Date().toISOString() });
  } catch { /* idem */ }
};

/**
 * Nom anonyme d'un clic : l'attribut data-nova-target / data-nova-action du
 * bouton, sinon son icône (« fa-save »). Jamais son texte ni son aria-label
 * (ils peuvent contenir un nom de piste ou de projet).
 */
export const actionNameForElement = (el: Element | null): string | null => {
  const btn = el?.closest?.('button, a, [role="button"], [role="tab"], input[type="checkbox"], select') as HTMLElement | null;
  if (!btn) return null;
  const target = btn.getAttribute('data-nova-action') || btn.getAttribute('data-nova-target');
  if (target && /^[a-z0-9._:-]{2,40}$/i.test(target)) return `clic:${target}`;
  const icon = btn.querySelector('i[class*="fa-"]');
  const cls = icon ? Array.from(icon.classList).find(c => /^fa-[a-z0-9-]+$/.test(c) && !['fa-solid', 'fa-regular', 'fa-fw', 'fa-lg', 'fa-xs', 'fa-sm', 'fa-spin'].includes(c)) : null;
  if (cls) return `clic:${cls}`;
  const tag = btn.tagName.toLowerCase();
  return tag === 'select' ? 'clic:liste' : tag === 'input' ? 'clic:case' : null;
};

let actionsInstalled = false;
/** Journal des clics (anonymes) : à appeler une fois, au démarrage. */
export const installActionLog = (): void => {
  if (actionsInstalled || typeof document === 'undefined') return;
  actionsInstalled = true;
  document.addEventListener('click', (ev) => {
    const name = actionNameForElement(ev.target as Element);
    if (name) recordAction(name);
  }, { capture: true, passive: true });
};

/** Pour les tests. */
export const resetFeedbackLogs = (): void => { consoleRing.clear(); actionRing.clear(); };
