/**
 * Rangement des modèles de session :
 *  - modèles de l'utilisateur sur l'appareil (IndexedDB « nova-templates », repli
 *    localStorage si IndexedDB est indisponible) ;
 *  - modèles livrés avec l'appli (dossier templates/*.novatemplate, chargés à la
 *    demande, en lecture seule : on les duplique pour les modifier).
 * Toutes les listes passent par le filtre d'accès (modèles « privé : romain »,
 * config/templateAccess.ts) : un modèle privé n'est ni listé, ni chargé, ni
 * importé pour un autre compte ou un invité. Pas de table Supabase pour l'instant.
 */
import {
  canAccessTemplate, newTemplateId, parseTemplate, serializeTemplate, SessionTemplate, TEMPLATE_EXT, templateSlug,
} from '../utils/sessionTemplate';
import { privateLabel } from '../config/templateAccess';

// ─── Stockage ──────────────────────────────────────────────────────────────────

export interface TemplateBackend {
  all(): Promise<SessionTemplate[]>;
  put(t: SessionTemplate): Promise<void>;
  remove(id: string): Promise<void>;
}

const DB_NAME = 'nova-templates';
const STORE = 'templates';
const LS_KEY = 'nova_session_templates_v1';

const idbBackend = (): TemplateBackend => {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  };
  return {
    all: () => run<SessionTemplate[]>('readonly', s => s.getAll() as IDBRequest<SessionTemplate[]>),
    put: async t => { await run('readwrite', s => s.put(t)); },
    remove: async id => { await run('readwrite', s => s.delete(id)); },
  };
};

const lsBackend = (): TemplateBackend => {
  const read = (): SessionTemplate[] => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } };
  const write = (list: SessionTemplate[]) => { localStorage.setItem(LS_KEY, JSON.stringify(list)); };
  return {
    all: async () => read(),
    put: async t => { write([...read().filter(x => x.id !== t.id), t]); },
    remove: async id => { write(read().filter(x => x.id !== id)); },
  };
};

export const memoryBackend = (): TemplateBackend => {
  const m = new Map<string, SessionTemplate>();
  return { all: async () => [...m.values()].map(x => JSON.parse(JSON.stringify(x))), put: async t => { m.set(t.id, JSON.parse(JSON.stringify(t))); }, remove: async id => { m.delete(id); } };
};

let backend: TemplateBackend | null = null;
const getBackend = (): TemplateBackend => {
  if (backend) return backend;
  if (typeof indexedDB !== 'undefined') backend = idbBackend();
  else if (typeof localStorage !== 'undefined') backend = lsBackend();
  else backend = memoryBackend();
  return backend;
};
/** Tests : stockage à utiliser. */
export const setTemplateBackend = (b: TemplateBackend | null) => { backend = b; };

const userTemplates = async (): Promise<SessionTemplate[]> => {
  try { return await getBackend().all(); } catch (e) {
    // IndexedDB refusé (navigation privée…) : repli localStorage.
    if (typeof localStorage !== 'undefined') { backend = lsBackend(); return backend.all(); }
    throw e;
  }
};

// ─── Modèles livrés avec l'appli ───────────────────────────────────────────────

type BundledLoader = () => Promise<SessionTemplate[]>;

const defaultBundled: BundledLoader = async () => {
  const files = import.meta.glob('../templates/*.novatemplate', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
  const out: SessionTemplate[] = [];
  for (const [path, load] of Object.entries(files)) {
    try { out.push({ ...parseTemplate(await load()), bundled: true }); } catch (e) { console.warn('[Modèles] Modèle livré illisible :', path, e); }
  }
  return out;
};

let bundledLoader: BundledLoader = defaultBundled;
let bundledCache: Promise<SessionTemplate[]> | null = null;
/** Tests : modèles livrés à utiliser. */
export const setBundledLoader = (l: BundledLoader | null) => { bundledLoader = l || defaultBundled; bundledCache = null; };
const bundledTemplates = () => { if (!bundledCache) bundledCache = bundledLoader().catch(() => []); return bundledCache; };

// ─── API ───────────────────────────────────────────────────────────────────────

/** Modèles visibles par ce compte (e-mail ; null = invité) : livrés d'abord, puis les plus récents. */
export const listTemplates = async (email: string | null): Promise<SessionTemplate[]> => {
  const [b, u] = await Promise.all([bundledTemplates(), userTemplates()]);
  const user = u.filter(t => !b.some(x => x.id === t.id)).sort((x, y) => y.updatedAt - x.updatedAt);
  return [...b, ...user].filter(t => canAccessTemplate(t, email));
};

const refused = (t: SessionTemplate) => new Error(`Ce modèle est ${privateLabel(t.privateTo || '?')} : connecte-toi avec le bon compte pour l'utiliser.`);

/** Un modèle, s'il est visible par ce compte. */
export const getTemplate = async (id: string, email: string | null): Promise<SessionTemplate> => {
  const [b, u] = await Promise.all([bundledTemplates(), userTemplates()]);
  const t = b.find(x => x.id === id) || u.find(x => x.id === id);
  if (!t) throw new Error('Ce modèle n’existe plus sur cet appareil.');
  if (!canAccessTemplate(t, email)) throw refused(t);
  return t;
};

/** Enregistre un modèle de l'utilisateur (un modèle livré n'est jamais écrasé : copie). */
export const saveTemplate = async (t: SessionTemplate): Promise<SessionTemplate> => {
  const b = await bundledTemplates();
  const copy: SessionTemplate = { ...t, bundled: undefined, id: b.some(x => x.id === t.id) ? newTemplateId() : t.id, updatedAt: Date.now() };
  delete copy.bundled;
  await getBackend().put(copy);
  return copy;
};

export const renameTemplate = async (id: string, name: string, email: string | null): Promise<SessionTemplate> => {
  const t = await getTemplate(id, email);
  if (t.bundled) throw new Error('Les modèles livrés avec NOVA ne se renomment pas : duplique-le, puis renomme la copie.');
  const clean = name.trim();
  if (!clean) throw new Error('Donne un nom au modèle.');
  const next = { ...t, name: clean.slice(0, 80), updatedAt: Date.now() };
  await getBackend().put(next);
  return next;
};

export const duplicateTemplate = async (id: string, email: string | null): Promise<SessionTemplate> => {
  const t = await getTemplate(id, email);
  const now = Date.now();
  const copy: SessionTemplate = { ...JSON.parse(JSON.stringify(t)), id: newTemplateId(), name: `${t.name} (copie)`.slice(0, 80), createdAt: now, updatedAt: now };
  delete copy.bundled;
  await getBackend().put(copy);
  return copy;
};

export const deleteTemplate = async (id: string, email: string | null): Promise<void> => {
  const t = await getTemplate(id, email);
  if (t.bundled) throw new Error('Les modèles livrés avec NOVA ne se suppriment pas.');
  await getBackend().remove(id);
};

/** Fichier .novatemplate à télécharger. */
export const exportTemplateFile = (t: SessionTemplate): { blob: Blob; filename: string } => ({
  blob: new Blob([serializeTemplate(t)], { type: 'application/json' }),
  filename: `${templateSlug(t.name)}${TEMPLATE_EXT}`,
});

/** Importe un fichier .novatemplate (refusé si le modèle est réservé à un autre compte). */
export const importTemplateText = async (text: string, email: string | null): Promise<SessionTemplate> => {
  const t = parseTemplate(text);
  if (!canAccessTemplate(t, email)) throw refused(t);
  const [b, u] = await Promise.all([bundledTemplates(), userTemplates()]);
  const clash = b.some(x => x.id === t.id) || u.some(x => x.id === t.id);
  const now = Date.now();
  const saved: SessionTemplate = { ...t, id: clash ? newTemplateId() : t.id, updatedAt: now, source: { kind: 'import', from: t.source?.from || t.name } };
  delete saved.bundled;
  await getBackend().put(saved);
  return saved;
};
