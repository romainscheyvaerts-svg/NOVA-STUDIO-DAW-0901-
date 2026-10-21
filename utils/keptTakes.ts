import type { Clip, KeptTake, TakeMeta, Track } from '../types';
import { takeNumberOf } from './takes';
import { keepTake, listLanes, sanitizeKept, TakeLane } from './playlists';
import { CompOptions, readComp, rebuildTakeClips, takeSpans } from './comping';

/**
 * 📌 Prises gardées (module pur : tests/keptTakes.test.ts).
 *
 * Pendant une séance, après chaque prise, l'artiste ou l'ingé met de côté
 * celles qui valent le coup. Elles s'affichent dans une zone au-dessus de la
 * piste (une ligne par prise gardée, ajoutée en bas), pour les réécouter et
 * choisir à la fin : la meilleure en entier (« Mettre sur la piste ») ou un
 * mélange (balayer un passage d'une ligne = le comp de toujours).
 *
 * Aucun modèle parallèle : une prise gardée EST une prise du comp (ses clips,
 * muets quand on ne l'entend pas, restent dans `track.clips`) ; seul un repère
 * `kept` s'ajoute à son entrée de `track.takeMeta`. Donc :
 *  - le mix et l'export n'entendent que la piste principale (les clips muets
 *    ne jouent jamais) ;
 *  - la sauvegarde, l'annulation et la collaboration (op « content », champ
 *    takeMeta) suivent sans rien de plus ;
 *  - « Mettre sur la piste » = garder la prise entière (playlists.keepTake),
 *    « comp depuis une ligne » = comping.compSwipe.
 */

/** Couleurs proposées pour une prise gardée (pastille, bord de la ligne). */
export const KEPT_COLORS = ['#f59e0b', '#22d3ee', '#a78bfa', '#f472b6', '#34d399', '#fb923c', '#60a5fa', '#f87171'];
/** Note maximale (étoiles). */
export const KEPT_MAX_STARS = 3;

/** Hauteur de l'en-tête de la zone (px). */
export const KEPT_HEAD_H = 30;

export interface KeptLane extends TakeLane {
  kept: KeptTake;
  /** Note (0 = pas notée). */
  stars: number;
  /** Couleur de la ligne (choisie, sinon `fallback`). */
  color: string;
}

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const clampStars = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(KEPT_MAX_STARS, n)) : 0;
};

/** Repère reçu (collaboration, fichier) : vérifié (défini avec la collaboration des couloirs). */
export { sanitizeKept };

/** Couleur par défaut d'une prise gardée (selon son rang dans la zone). */
export const keptColorAt = (i: number) => KEPT_COLORS[((i % KEPT_COLORS.length) + KEPT_COLORS.length) % KEPT_COLORS.length];

/** Numéros des prises qui existent encore sur la piste (clips présents). */
function liveTakes(track: Pick<Track, 'clips'>): Set<number> {
  const s = new Set<number>();
  for (const c of track.clips || []) { const n = takeNumberOf(c); if (n !== null) s.add(n); }
  return s;
}

/** Repères des prises gardées encore présentes, dans l'ordre de la zone (la plus ancienne en haut). */
export function keptMetas(track: Pick<Track, 'clips' | 'takeMeta'>): TakeMeta[] {
  const live = liveTakes(track);
  return (track.takeMeta || [])
    .filter(m => m && m.kept && live.has(m.n))
    .sort((a, b) => (a.kept!.at - b.kept!.at) || (a.n - b.n));
}

export const keptCount = (track: Pick<Track, 'clips' | 'takeMeta'>): number => keptMetas(track).length;

export const isKept = (track: Pick<Track, 'clips' | 'takeMeta'>, n: number): boolean =>
  keptMetas(track).some(m => m.n === n);

/** Lignes de la zone : les couloirs des prises gardées (même calcul que les couloirs du comp). */
export function keptLanes(track: Pick<Track, 'clips' | 'takeMeta'>, lanes: TakeLane[] = listLanes(track)): KeptLane[] {
  const byN = new Map(lanes.map(l => [l.n, l]));
  const out: KeptLane[] = [];
  keptMetas(track).forEach((m, i) => {
    const l = byN.get(m.n);
    if (!l) return;
    out.push({ ...l, meta: m, kept: m.kept!, stars: clampStars(m.kept!.stars), color: isHex(m.kept!.color) ? m.kept!.color : keptColorAt(i) });
  });
  return out;
}

/** Remplace l'entrée n (sans toucher aux autres). */
function withMeta(meta: TakeMeta[] | undefined, n: number, f: (m: TakeMeta) => TakeMeta): TakeMeta[] {
  const list = (meta || []).filter(m => m && typeof m.n === 'number');
  const i = list.findIndex(m => m.n === n);
  const next = f(i >= 0 ? { ...list[i] } : { n });
  return i >= 0 ? list.map((m, k) => (k === i ? next : m)) : [...list, next].sort((a, b) => a.n - b.n);
}

/** 📌 Garde la prise n de côté (sans effet si elle l'est déjà). */
export function keepAside(meta: TakeMeta[] | undefined, n: number, now = Date.now(), color?: string): TakeMeta[] {
  if ((meta || []).some(m => m && m.n === n && m.kept)) return meta || [];
  return withMeta(meta, n, m => ({ ...m, kept: { at: now, ...(isHex(color) ? { color: color.toLowerCase() } : {}) } }));
}

/** Retire la prise n de la zone (la prise elle-même reste dans ses couloirs). */
export function unkeep(meta: TakeMeta[] | undefined, n: number): TakeMeta[] {
  if (!(meta || []).some(m => m && m.n === n && m.kept)) return meta || [];
  return withMeta(meta, n, m => { const x = { ...m }; delete x.kept; return x; });
}

/** Vide la zone (toutes les prises restent dans leurs couloirs). */
export function clearKept(meta: TakeMeta[] | undefined): TakeMeta[] {
  return (meta || []).map(m => { if (!m?.kept) return m; const x = { ...m }; delete x.kept; return x; });
}

/** Note de 0 à 3 étoiles (0 : retire la note). */
export function rateKept(meta: TakeMeta[] | undefined, n: number, stars: number): TakeMeta[] {
  const s = clampStars(stars);
  return withMeta(meta, n, m => {
    if (!m.kept) return m;
    const kept = { ...m.kept };
    if (s) kept.stars = s; else delete kept.stars;
    return { ...m, kept };
  });
}

/** Couleur de la ligne (null : celle par défaut). */
export function colorKept(meta: TakeMeta[] | undefined, n: number, color: string | null): TakeMeta[] {
  return withMeta(meta, n, m => {
    if (!m.kept) return m;
    const kept = { ...m.kept };
    if (color && isHex(color)) kept.color = color.toLowerCase(); else delete kept.color;
    return { ...m, kept };
  });
}

/** Étoile touchée : la même note une 2e fois l'enlève (comme un « j'aime »). */
export const nextStars = (current: number, tapped: number): number => (current === tapped ? 0 : clampStars(tapped));

/**
 * Prise visée par « 📌 Garder » sans précision (raccourci, bandeau de fin de
 * prise, cabine) : la dernière enregistrée sur la piste (la plus récente, sinon
 * le plus grand numéro). null : la piste n'a pas de prise.
 */
export function lastTakeNumber(track: Pick<Track, 'clips' | 'takeMeta'>): number | null {
  const live = liveTakes(track);
  if (!live.size) return null;
  let best: number | null = null, bestAt = -Infinity;
  for (const m of track.takeMeta || []) {
    if (!m || !live.has(m.n) || typeof m.recordedAt !== 'number') continue;
    if (m.recordedAt > bestAt || (m.recordedAt === bestAt && best !== null && m.n > best)) { best = m.n; bestAt = m.recordedAt; }
  }
  const maxN = Math.max(...live);
  // Une prise plus récente sans heure (prise MIDI, ancienne version) : le numéro décide.
  return best === null || maxN > best ? maxN : best;
}

/** Prise d'un clip (glisser dans la zone, bouton du clip). null : ce n'est pas une prise. */
export const takeOfClip = (c: Pick<Clip, 'takeNumber' | 'name'> | null | undefined): number | null => (c ? takeNumberOf(c) : null);

/** Titre de la zone (le mot des studios : la playlist des prises qu'on garde). */
export const KEPT_TITLE = 'Playlist · prises gardées';

/** Piste d'enregistrement d'un template, reconnue à son nom (REC, Voix lead, Lead…). */
const REC_NAME = /^\s*(rec|voix lead|lead|voix|vocal|vox lead)\b/i;

/**
 * Pistes qui montrent la playlist même vide : les pistes armées ; sans piste armée,
 * la piste d'enregistrement du projet (« track-rec-main », sinon la 1re piste audio
 * nommée REC / Voix lead…). Ainsi, dès l'ouverture d'un template, on voit où les
 * prises gardées vont s'ajouter.
 */
export function keptZoneTargets(tracks: Pick<Track, 'id' | 'name' | 'type' | 'isTrackArmed'>[]): Set<string> {
  const armed = tracks.filter(t => t.isTrackArmed);
  if (armed.length) return new Set(armed.map(t => t.id));
  const audio = tracks.filter(t => String(t.type) === 'AUDIO');
  const rec = audio.find(t => t.id === 'track-rec-main') || audio.find(t => REC_NAME.test(t.name || ''));
  return new Set(rec ? [rec.id] : []);
}

/**
 * Hauteur de la zone au-dessus de la piste (px), 0 sans zone. Elle grandit d'une
 * ligne par prise gardée ; une piste d'enregistrement (keptZoneTargets) montre
 * l'en-tête même sans prise (le « 📌 Garder » de fin de prise et l'état vide).
 */
export function keptZoneHeight(o: { kept: number; open: boolean; target: boolean; headH?: number; laneH: number }): number {
  const head = o.headH ?? KEPT_HEAD_H;
  if (o.kept > 0) return head + (o.open ? o.kept * o.laneH : 0);
  return o.target ? head : 0;
}

/** Bout d'une autre prise plus court que ça, collé à la prise mise sur la piste : retiré (s). */
export const SLIVER_SEC = 0.25;

/**
 * Après « Mettre sur la piste » : les bouts de l'ancienne prise qui dépassent à peine
 * (la prise 4 finit 30 ms après la 2 : on entendrait 30 ms de la 4) sont coupés. Seul
 * un bout court (< SLIVER_SEC), collé à la prise n et sans autre prise de l'autre côté,
 * est concerné : un vrai passage d'une autre prise reste (c'est le comp de l'utilisateur).
 */
export function dropSlivers(clips: Clip[], n: number, opts: CompOptions = {}): Clip[] {
  const spans = takeSpans(clips);
  const segs = readComp(clips, spans).sort((a, b) => a.start - b.start);
  const drop = new Set<number>();
  segs.forEach((s, i) => {
    if (s.n === n || s.end - s.start >= SLIVER_SEC) return;
    const prev = segs[i - 1], next = segs[i + 1];
    const touchPrev = !!prev && Math.abs(prev.end - s.start) < 1e-3;
    const touchNext = !!next && Math.abs(s.end - next.start) < 1e-3;
    if ((touchPrev && prev.n === n && !touchNext) || (touchNext && next.n === n && !touchPrev)) drop.add(i);
  });
  if (!drop.size) return clips;
  return rebuildTakeClips(clips, spans, segs.filter((_, i) => !drop.has(i)), opts);
}

/** « Mettre sur la piste » : la prise n entière remplace ce qu'on entend (sans bout de l'ancienne). */
export const putKeptOnTrack = (clips: Clip[], n: number, opts: CompOptions = {}): Clip[] => dropSlivers(keepTake(clips, n, opts), n, opts);

/** Résumé d'une ligne : « ★★☆ · 0:42 ». */
export function starsLabel(stars: number): string {
  const s = clampStars(stars);
  return '★'.repeat(s) + '☆'.repeat(KEPT_MAX_STARS - s);
}
