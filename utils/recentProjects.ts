/**
 * Projets récents (« Ouvrir un projet › Récents ») : un projet par ligne, sa dernière version
 * gardée sur l'appareil (utils/recoveryStore) ou, dans Nova Studio, sur le disque
 * (Documents › Nova Studio › Projets).
 *
 * Pourquoi : avant, seule la DERNIÈRE séance se rouvrait d'un clic (« Reprendre ma
 * session ») ; les projets de la veille étaient noyés dans « Versions de la session »
 * (20 lignes par projet, tous projets mêlés). L'ingé qui enchaîne les clients rouvre
 * maintenant n'importe quel projet par son nom, comme « Ouvrir récent ».
 *
 * Index léger dans localStorage (une entrée par projet, écrite à chaque version) : la liste
 * s'affiche sans relire les JSON de toutes les versions. Elle est recoupée avec les
 * versions réellement présentes (clés seules) : un projet effacé n'apparaît jamais.
 */
export interface RecentProject {
  projectId: string;
  name: string;
  savedAt: number;
  /** Version à rouvrir (la plus récente). */
  versionId: number;
  tracks: number;
  takes: number;
  beatTitle: string | null;
  /** Où est la version : l'appareil (immédiat) ou le disque (relue par le pont). */
  source: 'appareil' | 'disque';
}

type Entry = Omit<RecentProject, 'source'>;

const KEY = 'nova_recent_projects';
const MAX = 200;

function read(): Entry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(e => e && typeof e.projectId === 'string' && Number.isFinite(e.versionId)) : [];
  } catch { return []; }
}

function write(list: Entry[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* stockage plein : la liste se refait depuis les versions */ }
}

/** Une version vient d'être écrite : le projet passe en tête des récents. */
export function rememberRecent(e: Entry) {
  if (!e.projectId) return;
  const rest = read().filter(x => x.projectId !== e.projectId);
  write([{ projectId: e.projectId, name: e.name || 'Session', savedAt: e.savedAt, versionId: e.versionId, tracks: e.tracks || 0, takes: e.takes || 0, beatTitle: e.beatTitle ?? null }, ...rest]);
}

export interface VersionLike {
  id: number; projectId: string; name: string; savedAt: number; tracks: number; takes: number; beatTitle: string | null;
}

/**
 * Liste des récents : l'index, recoupé avec les versions présentes sur l'appareil
 * (`deviceIds` : clés seules), complété par `fallback` (versions complètes, lues seulement
 * quand l'index manque un projet : 1re ouverture après la mise à jour, autre onglet) et
 * par les projets du disque (Nova Studio). Du plus récent au plus ancien.
 */
export function mergeRecents(opts: {
  index: Entry[];
  deviceIds: Set<number>;
  fallback?: VersionLike[];
  disk?: { projectId: string; name: string; latest: { id: number; savedAt: number; tracks: number; takes: number; beatTitle: string | null } }[];
  excludeProjectId?: string | null;
}): RecentProject[] {
  const by = new Map<string, RecentProject>();
  const put = (p: RecentProject) => {
    const cur = by.get(p.projectId);
    // Même projet sur l'appareil et le disque : la plus récente ; à égalité, l'appareil (rien à relire).
    if (!cur || p.savedAt > cur.savedAt || (p.savedAt === cur.savedAt && p.source === 'appareil' && cur.source !== 'appareil')) by.set(p.projectId, p);
  };
  for (const e of opts.index) if (opts.deviceIds.has(e.versionId)) put({ ...e, source: 'appareil' });
  for (const v of opts.fallback || []) {
    if (!opts.deviceIds.has(v.id)) continue;
    put({ projectId: v.projectId, name: v.name || 'Session', savedAt: v.savedAt, versionId: v.id, tracks: v.tracks || 0, takes: v.takes || 0, beatTitle: v.beatTitle ?? null, source: 'appareil' });
  }
  for (const d of opts.disk || []) {
    put({ projectId: d.projectId, name: d.name || 'Session', savedAt: d.latest.savedAt, versionId: d.latest.id, tracks: d.latest.tracks || 0, takes: d.latest.takes || 0, beatTitle: d.latest.beatTitle ?? null, source: 'disque' });
  }
  if (opts.excludeProjectId) by.delete(opts.excludeProjectId);
  return [...by.values()].sort((a, b) => b.savedAt - a.savedAt);
}

/** L'index manque-t-il des versions présentes (il faut alors relire les versions) ? */
export function indexIsIncomplete(index: Entry[], deviceIds: Set<number>): boolean {
  if (!deviceIds.size) return false;
  const known = new Set(index.map(e => e.versionId));
  // La version la plus récente de l'appareil doit être celle d'un projet de l'index.
  const newest = Math.max(...deviceIds);
  return !known.has(newest);
}

export const readRecentIndex = read;

/** Recherche sans accents ni casse (« seance » trouve « Séance »). */
export function matchesQuery(p: Pick<RecentProject, 'name' | 'beatTitle'>, q: string): boolean {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const n = norm(q.trim());
  if (!n) return true;
  return norm(`${p.name} ${p.beatTitle || ''}`).includes(n);
}
