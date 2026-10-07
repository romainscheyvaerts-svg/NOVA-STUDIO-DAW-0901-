/**
 * Signalements des utilisateurs (bugs, améliorations, idées) vers le Supabase
 * des comptes Make Music (table nova_feedback, captures dans le bucket privé
 * nova-feedback ; migration supabase/nova_feedback.sql).
 *
 * - Chaque signalement reçoit tout de suite un numéro de suivi (ref) créé sur
 *   l'appareil : la confirmation s'affiche même hors ligne.
 * - File locale : hors ligne ou en cas d'erreur, il reste sur l'appareil et
 *   repart tout seul (retour du réseau, minuterie, prochain démarrage).
 * - Anti-doublon : la ref est unique côté base (un renvoi après une réponse
 *   perdue ne crée pas de deuxième ligne) et le même texte n'est pas accepté
 *   deux fois en 10 minutes.
 * - « Mes signalements » : historique local + statut lu dans la table
 *   (connecté : RLS, les siens seulement ; invité : fonction limitée à cet appareil).
 */
import { catalogSupabase } from './supabase';

export type FeedbackCategory = 'bug' | 'amelioration' | 'idee';
export type FeedbackFrequency = 'toujours' | 'parfois';
export type FeedbackStatus = 'en_attente' | 'recu' | 'en_cours' | 'corrige' | 'ferme' | 'refuse';

export const FEEDBACK_BUCKET = 'nova-feedback';
export const FEEDBACK_LIMITS = { titleMin: 3, title: 120, description: 5000, email: 254, screenshotBytes: 2 * 1024 * 1024 } as const;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
const RATE_LIMIT_DELAY_MS = 60 * 60_000;
const SERVER_NOT_READY_DELAY_MS = 6 * 60 * 60_000;

const QUEUE_KEY = 'nova_feedback_queue';
const HISTORY_KEY = 'nova_feedback_history';
const DEVICE_KEY = 'nova_feedback_device';

export interface FeedbackDraft {
  category: FeedbackCategory;
  title: string;
  description: string;
  frequency?: FeedbackFrequency | null;
  email?: string | null;
  /** Capture déjà masquée et compressée (data:image/jpeg;base64,…). */
  screenshot?: string | null;
  context: Record<string, unknown>;
}

export interface QueueItem {
  ref: string;
  deviceId: string;
  createdAt: string;
  category: FeedbackCategory;
  title: string;
  description: string;
  frequency: FeedbackFrequency | null;
  email: string | null;
  context: Record<string, unknown>;
  screenshot: string | null;
  screenshotPath: string | null;
  attempts: number;
  nextTryAt: number;
  lastError?: string;
}

export interface HistoryItem {
  ref: string;
  title: string;
  category: FeedbackCategory;
  createdAt: string;
  status: FeedbackStatus;
  fixedIn?: string | null;
  fingerprint?: string;
  note?: string;
}

export class FeedbackError extends Error {
  constructor(readonly code: 'titre' | 'description' | 'categorie' | 'email' | 'doublon', message: string, readonly ref?: string) { super(message); }
}

// --- Stockage local (jamais bloquant) ----------------------------------------------------

const readJson = <T,>(key: string, fallback: T): T => {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
};
const writeJson = (key: string, value: unknown): boolean => {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
};

const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; listeners.forEach(l => { try { l(); } catch { /* */ } }); };
export const feedbackStore = {
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  getVersion: () => version,
};

export const getQueue = (): QueueItem[] => readJson<QueueItem[]>(QUEUE_KEY, []);
export const getHistory = (): HistoryItem[] => readJson<HistoryItem[]>(HISTORY_KEY, []);

const saveQueue = (q: QueueItem[]): void => {
  if (writeJson(QUEUE_KEY, q)) return;
  // Stockage plein : on garde les signalements, sans leurs captures.
  writeJson(QUEUE_KEY, q.map(i => (i.screenshot ? { ...i, screenshot: null, lastError: 'capture non gardée (stockage plein)' } : i)));
};
const saveHistory = (h: HistoryItem[]): void => { writeJson(HISTORY_KEY, h.slice(0, 100)); };

const updateHistory = (ref: string, patch: Partial<HistoryItem>): void => {
  saveHistory(getHistory().map(h => (h.ref === ref ? { ...h, ...patch } : h)));
};

const randomBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  try { crypto.getRandomValues(out); } catch { for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256); }
  return out;
};

export const getDeviceId = (): string => {
  let id = '';
  try { id = localStorage.getItem(DEVICE_KEY) || ''; } catch { /* */ }
  if (!/^[a-f0-9]{32}$/.test(id)) {
    id = Array.from(randomBytes(16), b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(DEVICE_KEY, id); } catch { /* */ }
  }
  return id;
};

/** Numéro de suivi lisible : 8 caractères sans 0/O ni 1/I/L (« K7P2QX4A »). */
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const newRef = (): string => Array.from(randomBytes(8), b => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
export const formatRef = (ref: string): string => (ref.length === 8 ? `${ref.slice(0, 4)}-${ref.slice(4)}` : ref);

const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
export const fingerprintOf = (d: Pick<FeedbackDraft, 'category' | 'title' | 'description'>): string => {
  const s = `${d.category}|${normalize(d.title)}|${normalize(d.description)}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
};

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export const validateDraft = (d: FeedbackDraft): void => {
  if (!['bug', 'amelioration', 'idee'].includes(d.category)) throw new FeedbackError('categorie', 'Choisis : bug, amélioration ou idée.');
  const title = (d.title || '').trim();
  if (title.length < FEEDBACK_LIMITS.titleMin) throw new FeedbackError('titre', 'Donne un titre court (au moins 3 caractères).');
  if (title.length > FEEDBACK_LIMITS.title) throw new FeedbackError('titre', `Titre trop long (${FEEDBACK_LIMITS.title} caractères au maximum).`);
  if ((d.description || '').length > FEEDBACK_LIMITS.description) throw new FeedbackError('description', `Description trop longue (${FEEDBACK_LIMITS.description} caractères au maximum).`);
  const email = (d.email || '').trim();
  if (email && (email.length > FEEDBACK_LIMITS.email || !EMAIL_RE.test(email))) throw new FeedbackError('email', 'Cette adresse e-mail ne semble pas valide (ou laisse le champ vide).');
};

// --- Envoi ---------------------------------------------------------------------------

type SendOutcome = 'envoye' | 'reessayer' | 'refuse';

const dataUrlToBlob = (dataUrl: string): Blob | null => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
};

const isNetworkError = (err: { code?: string; message?: string } | null | undefined): boolean => {
  if (!err) return false;
  const code = String(err.code || '');
  if (/^[0-9A-Z]{5}$/.test(code) || code.startsWith('PGRST')) return false;
  return /fetch|network|load failed|timeout|abort|offline/i.test(String(err.message || '')) || !code;
};

const nextDelay = (attempts: number) => RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1] ?? RETRY_DELAYS_MS[0];

const uploadScreenshot = async (item: QueueItem): Promise<'ok' | 'reessayer' | 'abandon'> => {
  if (!item.screenshot || item.screenshotPath) return 'ok';
  const blob = dataUrlToBlob(item.screenshot);
  if (!blob || blob.size > FEEDBACK_LIMITS.screenshotBytes) return 'abandon';
  const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${item.deviceId}/${item.ref}.${ext}`;
  try {
    const { error } = await catalogSupabase.storage.from(FEEDBACK_BUCKET).upload(path, blob, { contentType: blob.type, upsert: false, cacheControl: '3600' });
    // Déjà là (renvoi après une réponse perdue) : c'est bon.
    if (!error || /exist|duplicate|409/i.test(`${(error as any).statusCode || ''} ${error.message}`)) { item.screenshotPath = path; return 'ok'; }
    if (isNetworkError(error as any)) return 'reessayer';
    return 'abandon';
  } catch {
    return 'reessayer';
  }
};

const sendItem = async (item: QueueItem): Promise<SendOutcome> => {
  const up = await uploadScreenshot(item);
  if (up === 'reessayer') { item.lastError = 'réseau (capture)'; return 'reessayer'; }
  if (up === 'abandon' && item.screenshot) {
    item.context = { ...item.context, capture: 'refusée par le serveur, envoyée sans' };
    item.screenshot = null;
  }
  const row = {
    ref: item.ref,
    device_id: item.deviceId,
    category: item.category,
    title: item.title,
    description: item.description,
    frequency: item.frequency,
    email: item.email,
    context: item.context,
    screenshot_path: item.screenshotPath,
  };
  let error: { code?: string; message?: string } | null = null;
  try {
    ({ error } = await catalogSupabase.from('nova_feedback').insert(row));
  } catch (e) {
    error = { message: String((e as Error)?.message || e) };
  }
  if (!error) return 'envoye';
  const code = String(error.code || '');
  const msg = String(error.message || '');
  // Même numéro déjà reçu : la première tentative était passée.
  if (code === '23505') return 'envoye';
  if (/nova_feedback_rate_limit/.test(msg)) { item.lastError = 'limite'; item.nextTryAt = Date.now() + RATE_LIMIT_DELAY_MS; return 'reessayer'; }
  if (code === '23514' || code === '22001' || code === '22P02') { item.lastError = `refusé (${code})`; return 'refuse'; }
  if (isNetworkError(error)) { item.lastError = 'réseau'; return 'reessayer'; }
  // Table absente, droits pas encore posés, serveur en panne : on garde et on réessaie plus tard.
  item.lastError = `serveur (${code || 'inconnu'})`;
  item.nextTryAt = Date.now() + SERVER_NOT_READY_DELAY_MS;
  return 'reessayer';
};

let flushing: Promise<void> | null = null;

/** Envoie les signalements en attente dont l'heure est venue (un seul envoi à la fois). */
export const flushFeedbackQueue = (opts: { force?: boolean } = {}): Promise<void> => {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      const due = getQueue().filter(i => opts.force || i.nextTryAt <= Date.now());
      for (const item of due) {
        item.attempts++;
        const before = item.nextTryAt;
        const outcome = await sendItem(item);
        const q = getQueue();
        const idx = q.findIndex(i => i.ref === item.ref);
        if (outcome === 'envoye') {
          if (idx >= 0) q.splice(idx, 1);
          saveQueue(q);
          updateHistory(item.ref, { status: 'recu', note: undefined });
        } else if (outcome === 'refuse') {
          if (idx >= 0) q.splice(idx, 1);
          saveQueue(q);
          updateHistory(item.ref, { status: 'refuse', note: 'Le serveur l’a refusé (texte trop long ou invalide).' });
        } else {
          if (item.nextTryAt === before) item.nextTryAt = Date.now() + nextDelay(item.attempts);
          if (idx >= 0) q[idx] = item; else q.push(item);
          saveQueue(q);
          updateHistory(item.ref, { status: 'en_attente', note: item.lastError === 'limite' ? 'Beaucoup d’envois cette heure-ci : il repartira tout seul plus tard.' : undefined });
        }
        emit();
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
};

export interface SubmitResult { ref: string; status: 'envoye' | 'en_attente'; note?: string }

export const submitFeedback = async (draft: FeedbackDraft): Promise<SubmitResult> => {
  validateDraft(draft);
  const fingerprint = fingerprintOf(draft);
  const dup = getHistory().find(h => h.fingerprint === fingerprint && Date.now() - Date.parse(h.createdAt) < DUPLICATE_WINDOW_MS);
  if (dup) throw new FeedbackError('doublon', `Tu viens déjà d’envoyer ce signalement (n° ${formatRef(dup.ref)}). Merci, il est bien noté !`, dup.ref);

  const item: QueueItem = {
    ref: newRef(),
    deviceId: getDeviceId(),
    createdAt: new Date().toISOString(),
    category: draft.category,
    title: draft.title.trim().slice(0, FEEDBACK_LIMITS.title),
    description: (draft.description || '').trim().slice(0, FEEDBACK_LIMITS.description),
    frequency: draft.category === 'bug' && (draft.frequency === 'toujours' || draft.frequency === 'parfois') ? draft.frequency : null,
    email: (draft.email || '').trim() || null,
    context: draft.context,
    screenshot: draft.screenshot || null,
    screenshotPath: null,
    attempts: 0,
    nextTryAt: Date.now(),
  };
  // Un même numéro n'entre jamais deux fois dans la file.
  saveQueue([...getQueue().filter(i => i.ref !== item.ref), item]);
  saveHistory([{ ref: item.ref, title: item.title, category: item.category, createdAt: item.createdAt, status: 'en_attente', fingerprint }, ...getHistory()]);
  emit();

  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  if (online) await flushFeedbackQueue();
  const h = getHistory().find(x => x.ref === item.ref);
  return { ref: item.ref, status: h?.status === 'recu' ? 'envoye' : 'en_attente', note: h?.note };
};

// --- Statuts (« Mes signalements ») ------------------------------------------------------

const KNOWN: FeedbackStatus[] = ['recu', 'en_cours', 'corrige', 'ferme'];

interface StatusRow { ref: string; status: string; fixed_in_version?: string | null; created_at?: string; title?: string; category?: string }

const mergeStatuses = (rows: StatusRow[]): void => {
  if (!rows.length) return;
  const hist = getHistory();
  const byRef = new Map(hist.map(h => [h.ref, h]));
  for (const r of rows) {
    if (!r?.ref || !KNOWN.includes(r.status as FeedbackStatus)) continue;
    const h = byRef.get(r.ref);
    if (h) {
      h.status = r.status as FeedbackStatus;
      h.fixedIn = r.fixed_in_version ?? null;
    } else if (r.title && r.created_at) {
      // Envoyé depuis un autre appareil avec le même compte.
      const cat = (['bug', 'amelioration', 'idee'].includes(String(r.category)) ? r.category : 'idee') as FeedbackCategory;
      const item: HistoryItem = { ref: r.ref, title: r.title, category: cat, createdAt: r.created_at, status: r.status as FeedbackStatus, fixedIn: r.fixed_in_version ?? null };
      hist.push(item); byRef.set(r.ref, item);
    }
  }
  hist.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  saveHistory(hist);
  emit();
};

/** Met à jour les statuts depuis la table (rien en cas d'échec : on garde l'historique local). */
export const refreshFeedbackStatuses = async (): Promise<void> => {
  try {
    const { data: sess } = await catalogSupabase.auth.getSession();
    if (sess?.session?.user) {
      const { data, error } = await catalogSupabase.from('nova_feedback')
        .select('ref,status,fixed_in_version,created_at,title,category')
        .order('created_at', { ascending: false }).limit(50);
      if (!error && Array.isArray(data)) mergeStatuses(data as StatusRow[]);
    }
    const refs = getHistory().filter(h => h.status !== 'en_attente' && h.status !== 'refuse').map(h => h.ref).slice(0, 50);
    if (refs.length) {
      const { data, error } = await catalogSupabase.rpc('nova_feedback_statuts', { p_device: getDeviceId(), p_refs: refs });
      if (!error && Array.isArray(data)) mergeStatuses(data as StatusRow[]);
    }
  } catch { /* hors ligne : l'historique local suffit */ }
};

// --- Démarrage -------------------------------------------------------------------------

let started = false;
/** File d'envoi : retour du réseau, minuterie, et un essai peu après le démarrage. */
export const startFeedbackQueue = (): void => {
  if (started || typeof window === 'undefined') return;
  started = true;
  const tick = () => { if (navigator.onLine !== false && getQueue().length) void flushFeedbackQueue(); };
  window.addEventListener('online', () => { if (getQueue().length) void flushFeedbackQueue({ force: true }); });
  setTimeout(tick, 5000);
  setInterval(tick, 60_000);
};

// --- E-mail du compte (préremplissage seulement, jamais dans le contexte) ------------------

let userEmail: string | null = null;
export const setFeedbackUserEmail = (email: string | null | undefined): void => { userEmail = email && EMAIL_RE.test(email) ? email : null; };
export const getFeedbackUserEmail = (): string | null => userEmail;

// --- Ouverture de la fenêtre --------------------------------------------------------

export interface OpenFeedbackOptions { category?: FeedbackCategory; tab?: 'nouveau' | 'historique'; title?: string }
export const OPEN_FEEDBACK_EVENT = 'nova:feedback-open';
export const openFeedback = (opts: OpenFeedbackOptions = {}): void => {
  try { window.dispatchEvent(new CustomEvent(OPEN_FEEDBACK_EVENT, { detail: opts })); } catch { /* */ }
};

/** Pour les tests. */
export const __resetFeedbackForTests = (): void => { flushing = null; };
