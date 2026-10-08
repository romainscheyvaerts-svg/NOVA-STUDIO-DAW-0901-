import { Clip, DAWState, Track, TrackType } from '../types';

/**
 * R21 · Liste des clips de la session (Pro Tools : Clips List ; Logic : Project
 * Audio Browser).
 *
 *  - tous les clips audio et MIDI de la timeline, avec leur piste, leur durée et
 *    leur son d'origine (le fichier d'où ils viennent) ;
 *  - les clips RETIRÉS de la timeline restent dans la liste (comme dans Pro
 *    Tools) : rangés dans `clipBin`, on les repose d'un glisser ;
 *  - « Supprimer les clips inutilisés » (Pro Tools : Clear Unused) vide cette
 *    réserve : la timeline n'est pas touchée et Ctrl+Z les remet.
 *
 * Module pur : tests/clipsList.test.ts.
 */

export interface BinClip extends Clip {
  /** Piste d'où il vient (pour le reposer au même endroit). */
  fromTrackId?: string;
  fromTrackName?: string;
  /** Moment où il a quitté la timeline (ms). */
  removedAt: number;
}

export type ClipKind = 'audio' | 'midi';
export interface ClipRow {
  key: string;            // « t:<piste>:<clip> » ou « b:<clip> »
  clipId: string;
  name: string;
  kind: ClipKind;
  trackId: string | null; // null : hors timeline (réserve)
  trackName: string;
  start: number;
  duration: number;
  /** Son d'origine (fichier) : nom lisible. */
  source: string;
  /** Identifiant du son (audio), pour regrouper les clips d'un même fichier. */
  bufferId?: string;
  notes: number;
  used: boolean;
  muted: boolean;
  color: string;
  offline: boolean;
}

export const MAX_BIN = 300;

const isMidi = (c: Clip) => c.type === TrackType.MIDI || Array.isArray(c.notes);
const strip = (n: string) => (n || '').replace(/^🚫\s*/, '').replace(/\s*\(Licence requise\)$/, '').trim();

/** Son d'origine d'un clip : nom du fichier gardé, sinon le nom du 1er clip qui le joue. */
export function sourceNameOf(c: Clip, firstByBuffer: Map<string, string>): string {
  const own = (c as Clip & { sourceFile?: string }).sourceFile || c.elastic?.sourceName;
  if (own) return own;
  if (isMidi(c)) return 'MIDI';
  if (c.bufferId && firstByBuffer.has(c.bufferId)) return firstByBuffer.get(c.bufferId)!;
  return strip(c.name) || 'Son';
}

/** Toutes les lignes de la liste (timeline puis réserve). */
export function clipRows(s: Pick<DAWState, 'tracks' | 'clipBin'>): ClipRow[] {
  const firstByBuffer = new Map<string, string>();
  const all: { c: Clip; t: Track | null }[] = [];
  for (const t of s.tracks) for (const c of t.clips || []) all.push({ c, t });
  for (const c of s.clipBin || []) all.push({ c, t: null });
  [...all].sort((a, b) => (a.c.originStart ?? a.c.start) - (b.c.originStart ?? b.c.start)).forEach(({ c }) => {
    if (c.bufferId && !firstByBuffer.has(c.bufferId)) firstByBuffer.set(c.bufferId, strip(c.name).replace(/\s*[-_#.]\d+$/, '') || 'Son');
  });
  const onTimeline = new Set<string>();
  for (const t of s.tracks) for (const c of t.clips || []) onTimeline.add(c.id);
  const rows: ClipRow[] = [];
  for (const { c, t } of all) {
    if (!t && onTimeline.has(c.id)) continue; // revenu sur la timeline (annulation)
    const b = c as BinClip;
    rows.push({
      key: t ? `t:${t.id}:${c.id}` : `b:${c.id}`,
      clipId: c.id,
      name: strip(c.name) || (isMidi(c) ? 'Clip MIDI' : 'Clip'),
      kind: isMidi(c) ? 'midi' : 'audio',
      trackId: t ? t.id : null,
      trackName: t ? t.name : (b.fromTrackName ? `hors timeline (de « ${b.fromTrackName} »)` : 'hors timeline'),
      start: c.start,
      duration: c.duration,
      source: sourceNameOf(c, firstByBuffer),
      bufferId: c.bufferId,
      notes: (c.notes || []).length,
      used: !!t,
      muted: !!c.isMuted,
      color: c.color || '#64748b',
      offline: !!c.isOffline,
    });
  }
  return rows;
}

export type ClipSort = 'name' | 'duration' | 'track' | 'start' | 'source';

/** Recherche (nom, piste, son d'origine) et tri. */
export function filterRows(rows: ClipRow[], query: string, sort: ClipSort = 'start', dir: 1 | -1 = 1, only: 'all' | 'audio' | 'midi' | 'unused' = 'all'): ClipRow[] {
  const q = query.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const norm = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const out = rows.filter(r => (only === 'all' || (only === 'unused' ? !r.used : r.kind === only))
    && (!q || norm(`${r.name} ${r.trackName} ${r.source}`).includes(q)));
  const key = (r: ClipRow): number | string => sort === 'duration' ? r.duration : sort === 'start' ? (r.used ? r.start : 1e9 + r.start) : sort === 'track' ? norm(r.trackName) : sort === 'source' ? norm(r.source) : norm(r.name);
  return out.sort((a, b) => {
    const ka = key(a), kb = key(b);
    const c = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb), 'fr');
    return (c || a.name.localeCompare(b.name, 'fr')) * dir;
  });
}

/** Clips inutilisés : ceux de la réserve qui ne sont pas revenus sur la timeline. */
export function unusedClips(s: Pick<DAWState, 'tracks' | 'clipBin'>): BinClip[] {
  const on = new Set<string>();
  for (const t of s.tracks) for (const c of t.clips || []) on.add(c.id);
  return (s.clipBin || []).filter(c => !on.has(c.id));
}

/** « Supprimer les clips inutilisés » : la réserve est vidée (la timeline n'est pas touchée). */
export function clearUnused<S extends Pick<DAWState, 'tracks' | 'clipBin'>>(s: S, keys?: string[]): { state: S; removed: number } {
  const unused = unusedClips(s);
  const drop = new Set((keys ? unused.filter(c => keys.includes(`b:${c.id}`)) : unused).map(c => c.id));
  if (!drop.size) return { state: s, removed: 0 };
  return { state: { ...s, clipBin: (s.clipBin || []).filter(c => !drop.has(c.id)) }, removed: drop.size };
}

/**
 * Clips qui viennent de quitter la timeline (suppression, annulation d'un
 * import…) à garder dans la réserve. Pas les morceaux d'un clip coupé : un
 * clip audio dont le son est encore joué, ou un clip MIDI recouvert par ce qui
 * reste sur sa piste, n'a pas vraiment disparu.
 */
export function removedClips(prev: Track[], next: Track[], now = Date.now()): BinClip[] {
  const nextIds = new Set<string>();
  const usedBuffers = new Set<string>();
  for (const t of next) for (const c of t.clips || []) { nextIds.add(c.id); if (c.bufferId) usedBuffers.add(c.bufferId); }
  const out: BinClip[] = [];
  for (const t of prev) {
    const nt = next.find(x => x.id === t.id);
    for (const c of t.clips || []) {
      if (nextIds.has(c.id) || c.isFreezeSlice) continue;
      if (isMidi(c)) {
        if (!(c.notes || []).length) continue;
        const covered = (nt?.clips || []).some(x => isMidi(x) && x.start < c.start + c.duration - 1e-6 && x.start + x.duration > c.start + 1e-6);
        if (covered) continue;
      } else {
        if (!c.bufferId || usedBuffers.has(c.bufferId)) continue;
      }
      const { buffer: _b, ...rest } = c as Clip;
      out.push({ ...(rest as Clip), fromTrackId: t.id, fromTrackName: t.name, removedAt: now });
    }
  }
  return out;
}

/** Réserve mise à jour (les plus récents gardés, pas de doublon). */
export function addToBin(bin: BinClip[] | undefined, add: BinClip[]): BinClip[] {
  if (!add.length) return bin || [];
  const ids = new Set(add.map(c => c.id));
  return [...(bin || []).filter(c => !ids.has(c.id)), ...add].slice(-MAX_BIN);
}

/** Type de piste qui peut recevoir le clip. */
export function canDropOn(kind: ClipKind, t: Pick<Track, 'type' | 'id'>): boolean {
  if (t.id === 'master') return false;
  if (kind === 'midi') return t.type === TrackType.MIDI;
  return t.type === TrackType.AUDIO;
}

/**
 * Pose un clip de la liste sur une piste à `time` : copie (nouvel identifiant)
 * d'un clip de la timeline, ou clip de la réserve qui y retourne.
 */
export function placeClip<S extends Pick<DAWState, 'tracks' | 'clipBin'>>(s: S, key: string, trackId: string, time: number, newId: string): { state: S; clip: Clip | null; error?: string } {
  const row = clipRows(s).find(r => r.key === key);
  if (!row) return { state: s, clip: null, error: 'Ce clip n\'existe plus.' };
  const t = s.tracks.find(x => x.id === trackId);
  if (!t) return { state: s, clip: null, error: 'Piste introuvable.' };
  if (!canDropOn(row.kind, t)) return { state: s, clip: null, error: row.kind === 'midi' ? 'Un clip MIDI se pose sur une piste MIDI.' : 'Un clip audio se pose sur une piste audio.' };
  if (row.offline) return { state: s, clip: null, error: 'Le son de ce clip est hors ligne.' };
  const src: Clip | undefined = row.trackId
    ? s.tracks.find(x => x.id === row.trackId)?.clips.find(c => c.id === row.clipId)
    : (s.clipBin || []).find(c => c.id === row.clipId);
  if (!src) return { state: s, clip: null, error: 'Ce clip n\'existe plus.' };
  const { fromTrackId: _a, fromTrackName: _b, removedAt: _c, ...base } = src as BinClip;
  const clip: Clip = { ...(base as Clip), id: row.trackId ? newId : src.id, start: Math.max(0, time), isMuted: false };
  delete (clip as Clip & { takeNumber?: number }).takeNumber;
  const tracks = s.tracks.map(x => (x.id === trackId ? { ...x, clips: [...x.clips, clip] } : x));
  const clipBin = row.trackId ? s.clipBin : (s.clipBin || []).filter(c => c.id !== src.id);
  return { state: { ...s, tracks, clipBin }, clip };
}

/** Identifiants de sons gardés par la réserve (sauvegarde, historique). */
export const binBufferIds = (s: Pick<DAWState, 'clipBin'>): string[] => (s.clipBin || []).map(c => c.bufferId).filter((x): x is string => !!x);

export const fmtDuration = (sec: number) => {
  if (!Number.isFinite(sec)) return '–';
  const m = Math.floor(sec / 60), r = sec - m * 60;
  return m ? `${m}:${r.toFixed(1).padStart(4, '0').replace('.', ',')}` : `${r.toFixed(2).replace('.', ',')} s`;
};

/** Type MIME du glisser d'un clip de la liste vers une piste. */
export const CLIP_DRAG_TYPE = 'application/x-nova-clip';
