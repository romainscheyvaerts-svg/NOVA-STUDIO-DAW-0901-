/**
 * Presets synchronisés entre postes (chantier 19) : un preset d'effet, une
 * chaîne d'effets ou un modèle de piste (Track Preset) enregistré sur un poste
 * se retrouve sur un 2e poste connecté au même compte Make Music.
 *
 * Principes :
 *  - l'appareil d'abord : tout est rangé localement (services/PresetStore,
 *    IndexedDB), donc tout marche hors ligne ; la synchronisation n'est qu'un
 *    échange en plus, jamais un passage obligé ;
 *  - table `nova_presets` (supabase/migrations/20261012200000_nova_presets.sql,
 *    RLS : chacun ses lignes). Tant qu'elle n'existe pas en ligne : état
 *    « bientôt disponible », redemandé au plus toutes les 6 h ; aucune erreur
 *    ne remonte à l'interface ;
 *  - egress léger : on ne relit que les lignes changées depuis le dernier
 *    passage (curseur updated_at, 200 par page, 10 pages au plus) ; pas de
 *    boucle : au démarrage, après un enregistrement (regroupé sur 2 s), au
 *    retour du réseau, au retour sur la fenêtre (au plus toutes les 5 min) ;
 *    après une erreur du serveur, pause de 15 min ;
 *  - la modification la plus récente gagne (heure du poste, `updatedAt`) ; une
 *    suppression voyage comme une ligne « supprimée » ;
 *  - deux comptes sur le même PC : un preset reçu d'un compte n'est jamais
 *    envoyé à l'autre.
 *
 * Le moteur (`createPresetSync`) est pur et testé avec un faux serveur et deux
 * postes (tests/presetCloud.test.ts) ; le branchement réel (Supabase,
 * PresetStore, localStorage) est en bas du fichier.
 */
import type { AnyPreset } from '../utils/presets';
import { CHAIN_FORMAT } from '../utils/presets';

export interface CloudRow {
  user_id?: string;
  preset_id: string;
  kind: 'plugin' | 'chain';
  name: string;
  body: any;
  deleted: boolean;
  client_updated_at: number;
  /** Poste qui a écrit la ligne : un poste ne relit jamais ce qu'il vient d'envoyer (egress). */
  device_id?: string;
  updated_at?: string;
}

export type CloudErrorKind = 'missing' | 'offline' | 'auth' | 'server';
export interface CloudError { kind: CloudErrorKind; message?: string }

export interface PresetCloudApi {
  /** Compte connecté (session gardée sur l'appareil, sans requête), ou null. */
  userId(): Promise<string | null>;
  /** Lignes changées depuis `since`, sauf celles écrites par `exceptDevice`. */
  pull(since: string | null, limit: number, exceptDevice?: string): Promise<{ rows: CloudRow[] } | { error: CloudError }>;
  push(rows: CloudRow[]): Promise<{ error?: CloudError }>;
}

export interface LocalPresets {
  /** Presets de l'utilisateur sur l'appareil (sans les livrés). */
  all(): Promise<AnyPreset[]>;
  /** Range un preset reçu (sans le renvoyer). */
  put(p: AnyPreset): Promise<void>;
  remove(id: string): Promise<void>;
  /** Les listes ouvertes se rafraîchissent. */
  changed?(): void;
}

export interface MetaStore { get(key: string): string | null; set(key: string, value: string): void }

export type SyncState = 'off' | 'soon' | 'idle' | 'syncing' | 'ok' | 'offline' | 'error';
export interface SyncStatus {
  state: SyncState;
  /** Dernière synchronisation réussie (ms). */
  at?: number;
  pulled?: number;
  pushed?: number;
  message: string;
}

export const PAGE = 200;
export const MAX_PAGES = 10;
export const PUSH_CHUNK = 50;
export const MISSING_RETRY_MS = 6 * 3600_000;
export const ERROR_PAUSE_MS = 15 * 60_000;
export const FOCUS_MIN_MS = 5 * 60_000;

const K_PENDING = 'nova_presets_cloud_pending_v1';   // { id: horodatage } changés sur ce poste, à envoyer
const K_DELETED = 'nova_presets_cloud_deleted_v1';   // { id: horodatage } supprimés sur ce poste
const K_OWNERS = 'nova_presets_cloud_owner_v1';      // { id: compte } preset déjà lié à un compte
const K_MISSING = 'nova_presets_cloud_missing_at';   // table absente constatée (ms)
const K_PAUSE = 'nova_presets_cloud_pause_until';    // pause après une erreur du serveur (ms)
const kUser = (uid: string) => `nova_presets_cloud_v1:${uid}`; // { cursor, seeded, at }

export const STATUS_TEXT: Record<SyncState, string> = {
  off: 'Presets gardés sur cet appareil. Connecte-toi à ton compte Make Music pour les retrouver sur tes autres postes.',
  soon: 'Synchronisation entre postes bientôt disponible : tes presets restent sur cet appareil, rien n’est perdu.',
  idle: 'Presets prêts à se synchroniser avec ton compte.',
  syncing: 'Synchronisation des presets…',
  ok: 'Presets synchronisés avec ton compte : tu les retrouves sur tes autres postes.',
  offline: 'Hors ligne : tes presets sont gardés ici et partiront au retour du réseau.',
  error: 'Synchronisation en pause (serveur indisponible) : tes presets restent sur cet appareil. Nouvel essai dans 15 min.',
};

const readJson = <T,>(m: MetaStore, k: string, d: T): T => { try { const v = m.get(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const writeJson = (m: MetaStore, k: string, v: unknown) => { try { m.set(k, JSON.stringify(v)); } catch { /* stockage plein ou refusé : on réessaiera */ } };

const kindOf = (p: AnyPreset): 'plugin' | 'chain' => (p.format === CHAIN_FORMAT ? 'chain' : 'plugin');
const stamp = (p: AnyPreset) => Number((p as any).updatedAt) || Number((p as any).createdAt) || 0;

/** Ligne envoyée au serveur pour un preset (sans les champs propres à l'appareil). */
export function rowOf(p: AnyPreset, uid: string, deviceId?: string): CloudRow {
  const body = JSON.parse(JSON.stringify(p));
  delete body.bundled;
  return { user_id: uid, preset_id: p.id, kind: kindOf(p), name: String(p.name || '').slice(0, 120), body, deleted: false, client_updated_at: stamp(p), ...(deviceId ? { device_id: deviceId } : {}) };
}

/** Preset reçu, vérifié : une ligne abîmée n'entre jamais dans le rangement. */
export function presetFromRow(r: CloudRow): AnyPreset | null {
  const b = r?.body;
  if (!b || typeof b !== 'object' || typeof r.preset_id !== 'string' || !r.preset_id) return null;
  if (b.format !== 'novapreset' && b.format !== 'novachain') return null;
  const out = { ...b, id: r.preset_id, name: typeof b.name === 'string' && b.name.trim() ? b.name : (r.name || 'Preset'), updatedAt: Number(r.client_updated_at) || 0 };
  delete (out as any).bundled;
  return out as AnyPreset;
}

export function createPresetSync(o: { api: PresetCloudApi; local: LocalPresets; meta: MetaStore; now?: () => number; deviceId?: string }) {
  const now = o.now || (() => Date.now());
  const device = o.deviceId || '';
  const m = o.meta;
  let status: SyncStatus = { state: 'idle', message: STATUS_TEXT.idle };
  const listeners = new Set<(s: SyncStatus) => void>();
  const setStatus = (s: Partial<SyncStatus> & { state: SyncState }) => {
    status = { ...status, ...s, message: s.message || STATUS_TEXT[s.state] };
    for (const fn of [...listeners]) { try { fn(status); } catch { /* */ } }
  };
  let running: Promise<SyncStatus> | null = null;
  let again = false;

  const markChanged = (id: string, at: number) => {
    const p = readJson<Record<string, number>>(m, K_PENDING, {});
    p[id] = Math.max(p[id] || 0, at || now());
    writeJson(m, K_PENDING, p);
    const d = readJson<Record<string, number>>(m, K_DELETED, {});
    if (d[id]) { delete d[id]; writeJson(m, K_DELETED, d); }
  };
  const markDeleted = (id: string, at: number) => {
    const d = readJson<Record<string, number>>(m, K_DELETED, {});
    d[id] = at || now();
    writeJson(m, K_DELETED, d);
    const p = readJson<Record<string, number>>(m, K_PENDING, {});
    p[id] = d[id];
    writeJson(m, K_PENDING, p);
  };

  const fail = (e: CloudError): SyncStatus => {
    if (e.kind === 'missing') { m.set(K_MISSING, String(now())); setStatus({ state: 'soon' }); }
    else if (e.kind === 'offline') setStatus({ state: 'offline' });
    else if (e.kind === 'auth') setStatus({ state: 'off', message: 'Ta connexion a expiré : reconnecte-toi pour synchroniser tes presets (ils restent sur cet appareil).' });
    else { m.set(K_PAUSE, String(now() + ERROR_PAUSE_MS)); setStatus({ state: 'error' }); }
    return status;
  };

  async function run(force: boolean): Promise<SyncStatus> {
    let uid: string | null = null;
    try { uid = await o.api.userId(); } catch { uid = null; }
    if (!uid) { setStatus({ state: 'off' }); return status; }
    const missingAt = Number(m.get(K_MISSING) || 0);
    if (!force && missingAt && now() - missingAt < MISSING_RETRY_MS) { setStatus({ state: 'soon' }); return status; }
    const pauseUntil = Number(m.get(K_PAUSE) || 0);
    if (!force && pauseUntil > now()) { setStatus({ state: 'error' }); return status; }
    setStatus({ state: 'syncing' });

    const user = readJson<{ cursor: string | null; seeded?: boolean; at?: number }>(m, kUser(uid), { cursor: null });
    const owners = readJson<Record<string, string>>(m, K_OWNERS, {});
    const pendingAtStart = readJson<Record<string, number>>(m, K_PENDING, {});
    let locals: AnyPreset[] = [];
    try { locals = await o.local.all(); } catch { locals = []; }
    const byId = new Map(locals.map(p => [p.id, p] as const));

    // 1) Ce qui a changé ailleurs depuis le dernier passage.
    let cursor = user.cursor;
    let pulled = 0;
    let changedHere = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      let r: { rows: CloudRow[] } | { error: CloudError };
      try { r = await o.api.pull(cursor, PAGE, device || undefined); } catch (e: any) { r = { error: { kind: 'offline', message: String(e?.message || e) } }; }
      if ('error' in r) return fail(r.error);
      m.set(K_MISSING, '');
      for (const row of r.rows) {
        if (row.updated_at && (!cursor || row.updated_at > cursor)) cursor = row.updated_at;
        const id = row.preset_id;
        const local = byId.get(id);
        const mine = pendingAtStart[id] || 0;
        const remoteAt = Number(row.client_updated_at) || 0;
        // Changé ici plus récemment : c'est notre version qui partira.
        if (mine > remoteAt) continue;
        if (row.deleted) {
          if (local && stamp(local) <= remoteAt) { await o.local.remove(id); byId.delete(id); pulled++; changedHere = true; }
          owners[id] = uid;
          continue;
        }
        if (local && stamp(local) >= remoteAt) { owners[id] = uid; continue; }
        const p = presetFromRow(row);
        if (!p) continue;
        await o.local.put(p);
        byId.set(id, p);
        owners[id] = uid;
        pulled++;
        changedHere = true;
      }
      if (r.rows.length < PAGE) break;
    }
    if (changedHere) o.local.changed?.();

    // 2) Ce qui a changé ici (et, la 1re fois pour ce compte, tout ce qui est sur le poste).
    const deleted = readJson<Record<string, number>>(m, K_DELETED, {});
    const todo = new Map<string, number>(Object.entries(pendingAtStart));
    // 1re fois pour ce compte : ce qui est sur le poste et pas encore dans le compte (pas ce qu'on vient d'en recevoir).
    if (!user.seeded) for (const p of byId.values()) if (!todo.has(p.id) && !owners[p.id]) todo.set(p.id, stamp(p));
    const rows: CloudRow[] = [];
    for (const [id, at] of todo) {
      if (owners[id] && owners[id] !== uid) continue; // preset d'un autre compte de ce PC
      const p = byId.get(id);
      if (p) rows.push(rowOf(p, uid, device || undefined));
      else if (deleted[id]) rows.push({ user_id: uid, preset_id: id, kind: 'plugin', name: '', body: {}, deleted: true, client_updated_at: Math.max(at, deleted[id]), ...(device ? { device_id: device } : {}) });
    }
    let pushed = 0;
    for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
      const chunk = rows.slice(i, i + PUSH_CHUNK);
      let r: { error?: CloudError };
      try { r = await o.api.push(chunk); } catch (e: any) { r = { error: { kind: 'offline', message: String(e?.message || e) } }; }
      if (r.error) { writeJson(m, K_OWNERS, owners); writeJson(m, kUser(uid), { ...user, cursor }); return fail(r.error); }
      pushed += chunk.length;
      for (const row of chunk) owners[row.preset_id] = uid;
    }
    // Envoyés : retirés de la file, sauf s'ils ont encore changé pendant l'envoi.
    const pendingNow = readJson<Record<string, number>>(m, K_PENDING, {});
    const deletedNow = readJson<Record<string, number>>(m, K_DELETED, {});
    for (const row of rows) {
      if ((pendingNow[row.preset_id] || 0) <= (todo.get(row.preset_id) || 0)) delete pendingNow[row.preset_id];
      if (row.deleted && (deletedNow[row.preset_id] || 0) <= row.client_updated_at) delete deletedNow[row.preset_id];
    }
    // Presets d'un autre compte restés dans la file : ils attendent leur compte.
    writeJson(m, K_PENDING, pendingNow);
    writeJson(m, K_DELETED, deletedNow);
    writeJson(m, K_OWNERS, owners);
    const at = now();
    writeJson(m, kUser(uid), { cursor, seeded: true, at });
    m.set(K_PAUSE, '');
    setStatus({ state: 'ok', at, pulled, pushed });
    return status;
  }

  /** Une synchronisation à la fois ; un appel pendant qu'elle tourne en relance une seule après. */
  function sync(opts: { force?: boolean } = {}): Promise<SyncStatus> {
    if (running) { again = true; return running; }
    running = run(!!opts.force).catch(() => fail({ kind: 'server' })).finally(() => {
      running = null;
      if (again) { again = false; void sync(); }
    });
    return running;
  }

  return {
    sync,
    markChanged,
    markDeleted,
    status: () => status,
    subscribe(fn: (s: SyncStatus) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    /** Dernière synchronisation réussie pour ce compte (ms). */
    lastSyncAt: async () => { const uid = await o.api.userId().catch(() => null); return uid ? readJson<{ at?: number }>(m, kUser(uid), {}).at || 0 : 0; },
  };
}

export type PresetSync = ReturnType<typeof createPresetSync>;

// ─── Branchement réel ─────────────────────────────────────────────────────────

/** Erreur Supabase → nature (table absente, hors ligne, session, serveur). */
export function classifySupabaseError(error: any, status: number): CloudError {
  const code = String(error?.code || '');
  const msg = String(error?.message || '');
  if (status === 404 || code === 'PGRST205' || code === '42P01' || /could not find the table|does not exist/i.test(msg)) return { kind: 'missing', message: msg };
  if (status === 401 || status === 403 || code === 'PGRST301' || code === '42501' || /jwt/i.test(msg)) return { kind: 'auth', message: msg };
  if (!status || /failed to fetch|networkerror|load failed|fetch/i.test(msg)) return { kind: 'offline', message: msg };
  return { kind: 'server', message: msg };
}

const COLS = 'preset_id,kind,name,body,deleted,client_updated_at,device_id,updated_at';

export const supabasePresetApi = (): PresetCloudApi => {
  const client = async () => (await import('./supabase')).catalogSupabase;
  return {
    async userId() {
      try { const { data } = await (await client()).auth.getSession(); return data?.session?.user?.id || null; } catch { return null; }
    },
    async pull(since, limit, exceptDevice) {
      try {
        let q = (await client()).from('nova_presets').select(COLS).order('updated_at', { ascending: true }).limit(limit);
        if (since) q = q.gt('updated_at', since);
        if (exceptDevice) q = q.neq('device_id', exceptDevice);
        const { data, error, status } = await q;
        if (error) return { error: classifySupabaseError(error, status) };
        return { rows: (data || []) as CloudRow[] };
      } catch (e: any) { return { error: { kind: 'offline', message: String(e?.message || e) } }; }
    },
    async push(rows) {
      try {
        const { error, status } = await (await client()).from('nova_presets').upsert(rows, { onConflict: 'user_id,preset_id' });
        return error ? { error: classifySupabaseError(error, status) } : {};
      } catch (e: any) { return { error: { kind: 'offline', message: String(e?.message || e) } }; }
    },
  };
};

const lsMeta: MetaStore = {
  get: k => { try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null; } catch { return null; } },
  set: (k, v) => { try { if (typeof localStorage !== 'undefined') { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } } catch { /* */ } },
};

/** Identifiant de ce poste pour la synchronisation (aléatoire, gardé sur l'appareil). */
const DEVICE_KEY = 'nova_presets_device_v1';
export const presetDeviceId = (): string => {
  let id = lsMeta.get(DEVICE_KEY) || '';
  if (!/^[a-z0-9]{16,40}$/.test(id)) {
    try { const b = new Uint8Array(12); crypto.getRandomValues(b); id = Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }
    catch { id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`; }
    lsMeta.set(DEVICE_KEY, id);
  }
  return id;
};

let instance: PresetSync | null = null;
let started = false;

/** Synchronisation de l'appli (créée à la demande). */
export function presetCloud(): PresetSync {
  if (!instance) {
    instance = createPresetSync({
      api: supabasePresetApi(),
      meta: lsMeta,
      deviceId: presetDeviceId(),
      local: {
        all: async () => (await import('./PresetStore')).listUserPresets(),
        put: async p => (await import('./PresetStore')).putFromCloud(p),
        remove: async id => (await import('./PresetStore')).removeFromCloud(id),
        changed: () => { void import('./PresetStore').then(s => s.notifyRemotePresets()); },
      },
    });
  }
  return instance;
}

/**
 * Démarrage (une fois, depuis App) : 1re synchronisation après 4 s, puis
 * seulement sur évènement (enregistrement, réseau, fenêtre, connexion).
 */
export function startPresetCloud(): () => void {
  if (started || typeof window === 'undefined') return () => {};
  started = true;
  const s = presetCloud();
  let debounce: number | null = null;
  const soon = (ms = 2000) => { if (debounce) window.clearTimeout(debounce); debounce = window.setTimeout(() => { debounce = null; void s.sync(); }, ms); };
  // 1re synchro au démarrage, sauf si une fenêtre de presets l'a déjà faite (pas de requête en double).
  const first = window.setTimeout(() => { if (s.status().state === 'idle') void s.sync(); }, 4000);
  let lastFocus = Date.now();
  const onOnline = () => soon(500);
  const onFocus = () => { if (document.visibilityState === 'hidden') return; if (Date.now() - lastFocus < FOCUS_MIN_MS) return; lastFocus = Date.now(); soon(300); };
  window.addEventListener('online', onOnline);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  let offStore: (() => void) | null = null;
  void import('./PresetStore').then(st => {
    offStore = st.onPresetsChanged(c => {
      if (c.type === 'save') { s.markChanged(c.id, c.updatedAt); soon(); }
      else if (c.type === 'delete') { s.markDeleted(c.id, c.at); soon(); }
    });
  });
  let offAuth: (() => void) | null = null;
  void import('./supabase').then(({ catalogSupabase }) => {
    try {
      const { data } = catalogSupabase.auth.onAuthStateChange((event: string) => {
        if (event === 'SIGNED_IN') soon(800);
        if (event === 'SIGNED_OUT') void s.sync();
      });
      offAuth = () => data?.subscription?.unsubscribe();
    } catch { /* pas de suivi de connexion : la synchro se fera au prochain évènement */ }
  }).catch(() => {});
  return () => {
    window.clearTimeout(first); if (debounce) window.clearTimeout(debounce);
    window.removeEventListener('online', onOnline); window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    offStore?.(); offAuth?.(); started = false;
  };
}
