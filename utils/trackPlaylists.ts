import type { Clip, TakeMeta, Track, TrackPlaylist } from '../types';
import { sanitizeIncomingClips } from './collabMerge';

/**
 * Playlists de piste, comme Pro Tools (module pur : tests/trackPlaylists.test.ts).
 *
 * Une playlist = une version COMPLÈTE de l'édition d'une piste. L'ingé en crée
 * une avant un nettoyage risqué (« LEAD A.01 » = copie de travail), garde une
 * version « clean » et une version explicite, compare deux comps… puis bascule
 * de l'une à l'autre en un geste. C'est différent des couloirs de prises
 * (utils/playlists) : ceux-là vivent DANS une playlist.
 *
 * Stockage : la playlist active joue depuis `track.clips` / `track.takeMeta`
 * (rien ne change pour le moteur, le gel, l'export, la collaboration clip par
 * clip). Les autres gardent leurs clips dans `track.playlists[i].clips`.
 * L'entrée de la playlist active n'a jamais de clips.
 *
 *  - Nouvelle playlist (Pro Tools : Ctrl+Démarrer+\ … ici Ctrl+\) : vide ;
 *  - Dupliquer (Ctrl+Alt+\) : copie de la playlist active (nouveaux clips, même son) ;
 *  - Basculer : Maj+↑ / Maj+↓ (précédente / suivante), Maj+← (les deux dernières) ;
 *  - Renommer, supprimer (jamais l'active).
 * Noms : « <piste> », puis « <piste>.01 », « <piste>.02 »… (Pro Tools).
 */

export const MAIN_PLAYLIST_ID = 'pl-main';

let seq = 0;
const newId = (stamp?: string) => `pl-${stamp ?? Date.now().toString(36)}${(seq++).toString(36)}`;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** La piste a-t-elle d'autres versions que celle qu'on entend ? */
export const hasPlaylists = (t: Pick<Track, 'playlists'>): boolean => (t.playlists?.length || 0) > 1;

/** Piste qui peut avoir des playlists : une piste audio, MIDI ou d'instrument (pas un bus, un VCA, le master). */
export const canHavePlaylists = (t: Track | undefined): boolean =>
  !!t && t.id !== 'master' && t.type !== 'BUS' && t.type !== 'SEND' && !t.isVca && !t.folder;

/** Liste des playlists (avec l'entrée de l'active), créée à la volée pour une piste qui n'en a jamais eu. */
export function playlistsOf(t: Pick<Track, 'name' | 'playlists' | 'activePlaylistId'>): { list: TrackPlaylist[]; activeId: string } {
  const list = t.playlists && t.playlists.length ? t.playlists : [{ id: MAIN_PLAYLIST_ID, name: t.name, clips: [] }];
  const activeId = t.activePlaylistId && list.some(p => p.id === t.activePlaylistId) ? t.activePlaylistId : list[0].id;
  return { list, activeId };
}

/** Nom de la playlist active (affiché dans l'en-tête). */
export const activePlaylistName = (t: Pick<Track, 'name' | 'playlists' | 'activePlaylistId'>): string => {
  const { list, activeId } = playlistsOf(t);
  return list.find(p => p.id === activeId)?.name || t.name;
};

/** Prochain nom libre : « LEAD A.01 », « LEAD A.02 »… */
export function nextPlaylistName(trackName: string, existing: string[]): string {
  const base = trackName.trim() || 'Piste';
  const rx = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)$`);
  let max = 0;
  for (const n of existing) { const m = rx.exec(n); if (m) max = Math.max(max, Number(m[1])); }
  return `${base}.${String(max + 1).padStart(2, '0')}`;
}

/** Résumé d'une playlist pour le menu : nombre de clips et fin du contenu. */
export function playlistSummary(t: Track, id: string): { clips: number; end: number } {
  const { activeId } = playlistsOf(t);
  const clips = id === activeId ? (t.clips || []) : (t.playlists?.find(p => p.id === id)?.clips || []);
  return { clips: clips.length, end: clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) };
}

/** La piste avec la playlist active rangée (clips et couloirs gardés dans son entrée). */
function stored(t: Track): { list: TrackPlaylist[]; activeId: string } {
  const { list, activeId } = playlistsOf(t);
  return {
    activeId,
    list: list.map(p => (p.id === activeId
      ? { ...p, clips: (t.clips || []).map(c => ({ ...c })), ...(t.takeMeta?.length ? { takeMeta: clone(t.takeMeta) } : {}) }
      : p)),
  };
}

/** Nouveaux identifiants pour les clips copiés (le son reste le même : bufferId gardé). */
function copyClips(clips: Clip[], stamp: string): Clip[] {
  return clips.map((c, i) => ({ ...clone({ ...c, buffer: undefined }), ...((c as any).buffer ? { buffer: (c as any).buffer } : {}), id: `${c.id}-p${stamp}${i.toString(36)}` }));
}

export interface PlaylistOpts { duplicate?: boolean; name?: string; stamp?: string; now?: number }

/**
 * Nouvelle playlist (vide) ou copie de l'active (`duplicate`) ; elle devient l'active.
 * L'ancienne reste dans la liste, intacte.
 */
export function createPlaylist(t: Track, opts: PlaylistOpts = {}): { track: Track; id: string; name: string } {
  const stamp = opts.stamp ?? Date.now().toString(36);
  const { list, activeId } = stored(t);
  const name = (opts.name || '').trim() || nextPlaylistName(t.name, list.map(p => p.name));
  const id = newId(stamp);
  const entry: TrackPlaylist = { id, name, clips: [], createdAt: opts.now ?? Date.now() };
  // Les clips de l'active quittent `clips` : ils sont gardés dans son entrée.
  const nextList = [...list, entry];
  const activeEntry = list.find(p => p.id === activeId)!;
  const clips = opts.duplicate ? copyClips(activeEntry.clips, stamp) : [];
  const takeMeta = opts.duplicate && activeEntry.takeMeta?.length ? clone(activeEntry.takeMeta) : undefined;
  const track: Track = {
    ...t,
    clips,
    playlists: nextList,
    activePlaylistId: id,
    recentPlaylistId: activeId,
  };
  if (takeMeta) track.takeMeta = takeMeta; else delete track.takeMeta;
  return { track, id, name };
}

/** Bascule sur une autre playlist (la précédente garde son contenu). */
export function switchPlaylist(t: Track, id: string): Track {
  const { list, activeId } = stored(t);
  if (id === activeId) return t;
  const target = list.find(p => p.id === id);
  if (!target) return t;
  const track: Track = {
    ...t,
    clips: target.clips.map(c => ({ ...c })),
    playlists: list.map(p => (p.id === id ? { id: p.id, name: p.name, clips: [], ...(p.createdAt ? { createdAt: p.createdAt } : {}) } : p)),
    activePlaylistId: id,
    recentPlaylistId: activeId,
  };
  if (target.takeMeta?.length) track.takeMeta = clone(target.takeMeta); else delete track.takeMeta;
  return track;
}

/** Playlist précédente / suivante dans la liste (Pro Tools : Maj+↑ / Maj+↓), sans boucler. */
export function stepPlaylist(t: Track, dir: 1 | -1): Track {
  const { list, activeId } = playlistsOf(t);
  const i = list.findIndex(p => p.id === activeId);
  const j = i + dir;
  if (j < 0 || j >= list.length) return t;
  return switchPlaylist(t, list[j].id);
}

/** Les deux dernières playlists (Pro Tools : Maj+←). */
export function toggleRecentPlaylist(t: Track): Track {
  const { list } = playlistsOf(t);
  const r = t.recentPlaylistId;
  if (!r || !list.some(p => p.id === r)) return t;
  return switchPlaylist(t, r);
}

export function renamePlaylist(t: Track, id: string, name: string): Track {
  const n = name.trim();
  if (!n) return t;
  const { list } = playlistsOf(t);
  if (!list.some(p => p.id === id)) return t;
  return { ...t, playlists: list.map(p => (p.id === id ? { ...p, name: n } : p)), activePlaylistId: playlistsOf(t).activeId };
}

/** Supprime une playlist qui ne joue pas (l'active ne se supprime pas, comme Pro Tools). */
export function deletePlaylist(t: Track, id: string): Track {
  const { list, activeId } = playlistsOf(t);
  if (id === activeId || !list.some(p => p.id === id)) return t;
  const rest = list.filter(p => p.id !== id);
  const out: Track = { ...t, playlists: rest, activePlaylistId: activeId };
  if (out.recentPlaylistId === id) delete out.recentPlaylistId;
  // Plus qu'une version : la liste reste (une entrée) pour que la suppression voyage en collaboration.
  return out;
}

/** Clips des playlists qui ne jouent pas (leurs sons doivent rester en mémoire et voyager). */
export const inactivePlaylistClips = (t: Pick<Track, 'playlists' | 'activePlaylistId'>): Clip[] =>
  (t.playlists || []).filter(p => p.id !== t.activePlaylistId).flatMap(p => p.clips || []);

// ------------------------------------------------------------------ sauvegarde (.zip)

/** Marque des clips d'une playlist rangés le temps de la sauvegarde / du chargement. */
export const PACK_KEY = '__playlist';

/**
 * Sauvegarde : les clips des playlists rangées passent dans `clips` (marqués)
 * pour que le son de chacun soit écrit dans le .zip par le même chemin que les
 * autres (prises d'origine, justesse, gain rendu…). `unpackPlaylists` les remet
 * à leur place. Sans playlist : l'objet est rendu tel quel.
 */
export function packPlaylists<S extends { tracks: any[] }>(state: S): S {
  if (!state?.tracks?.some((t: any) => Array.isArray(t?.playlists) && t.playlists.some((p: any) => Array.isArray(p?.clips) && p.clips.length))) return state;
  return {
    ...state,
    tracks: state.tracks.map((t: any) => {
      if (!Array.isArray(t?.playlists)) return t;
      const extra: any[] = [];
      const playlists = t.playlists.map((p: any) => {
        if (!p || !Array.isArray(p.clips) || !p.clips.length) return p;
        for (const c of p.clips) extra.push({ ...c, [PACK_KEY]: p.id });
        return { ...p, clips: [] };
      });
      return extra.length ? { ...t, clips: [...(Array.isArray(t.clips) ? t.clips : []), ...extra], playlists } : t;
    }),
  };
}

/** Remet les clips marqués dans leur playlist (sur place : objet JSON sauvegardé ou chargé). */
export function unpackPlaylists(state: { tracks?: any[] } | null | undefined): void {
  for (const t of state?.tracks || []) {
    if (!t || !Array.isArray(t.clips) || !t.clips.some((c: any) => c && c[PACK_KEY])) continue;
    const byId = new Map<string, any[]>();
    const keep: any[] = [];
    for (const c of t.clips) {
      const pl = c && c[PACK_KEY];
      if (!pl) { keep.push(c); continue; }
      delete c[PACK_KEY];
      if (!byId.has(pl)) byId.set(pl, []);
      byId.get(pl)!.push(c);
    }
    t.clips = keep;
    if (!Array.isArray(t.playlists)) t.playlists = [];
    for (const [id, clips] of byId) {
      const p = t.playlists.find((x: any) => x && x.id === id);
      if (p) p.clips = [...(Array.isArray(p.clips) ? p.clips : []), ...clips];
      else t.playlists.push({ id, name: `${t.name || 'Piste'} (récupérée)`, clips });
    }
  }
}

// ------------------------------------------------------------------ collaboration

/** Ce qui voyage (op « content ») : liste, noms, clips des playlists rangées (sans le son). */
export function playlistsForWire(t: Track, clipForWire: (c: Clip) => Clip): { list: TrackPlaylist[]; active: string } | undefined {
  if (!t.playlists?.length) return undefined;
  const { list, activeId } = playlistsOf(t);
  return {
    active: activeId,
    list: list.map(p => ({
      id: p.id, name: p.name, clips: p.id === activeId ? [] : (p.clips || []).map(clipForWire),
      ...(p.id !== activeId && p.takeMeta?.length ? { takeMeta: p.takeMeta } : {}),
      ...(p.createdAt ? { createdAt: p.createdAt } : {}),
    })),
  };
}

/**
 * Playlists reçues d'un collaborateur (vérifiées : une donnée abîmée ne doit
 * jamais faire taire la piste). `null` = la piste n'a plus de playlists ;
 * `undefined` = champ absent (ancienne version de NOVA) : on garde les nôtres.
 */
export function sanitizeIncomingPlaylists(v: unknown): { list: TrackPlaylist[]; active: string } | null | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object') return null;
  const o = v as { list?: unknown; active?: unknown };
  if (!Array.isArray(o.list)) return null;
  const seen = new Set<string>();
  const list: TrackPlaylist[] = [];
  for (const p of o.list as any[]) {
    if (!p || typeof p.id !== 'string' || !p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    const clips: Clip[] = Array.isArray(p.clips) ? sanitizeIncomingClips<any>(p.clips.filter((c: any) => c && typeof c.id === 'string' && Number.isFinite(c.start) && Number.isFinite(c.duration) && c.duration > 0)) : [];
    const takeMeta: TakeMeta[] | undefined = Array.isArray(p.takeMeta) ? p.takeMeta.filter((m: any) => m && Number.isFinite(m.n)) : undefined;
    list.push({ id: p.id, name: typeof p.name === 'string' && p.name.trim() ? p.name.slice(0, 80) : 'Playlist', clips, ...(takeMeta?.length ? { takeMeta } : {}), ...(Number.isFinite(p.createdAt) ? { createdAt: p.createdAt } : {}) });
  }
  if (!list.length) return null;
  const active = typeof o.active === 'string' && seen.has(o.active) ? o.active : list[0].id;
  // L'active ne garde jamais de clips dans son entrée (ils sont dans Track.clips).
  return { list: list.map(p => (p.id === active ? { ...p, clips: [] } : p)), active };
}

/** Applique des playlists reçues sur la piste (brouillon Immer ou objet). */
export function applyIncomingPlaylists(t: Track, v: { list: TrackPlaylist[]; active: string } | null | undefined): void {
  if (v === undefined) return;
  if (v === null) { delete t.playlists; delete t.activePlaylistId; delete t.recentPlaylistId; return; }
  t.playlists = v.list;
  if (t.activePlaylistId !== v.active) t.recentPlaylistId = t.activePlaylistId;
  t.activePlaylistId = v.active;
  if (t.recentPlaylistId && !v.list.some(p => p.id === t.recentPlaylistId)) delete t.recentPlaylistId;
}
