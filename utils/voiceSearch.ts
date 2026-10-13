/**
 * B7 · Recherche d'un mot dans les prises (paroles transcrites sur le PC, Whisper local).
 *
 * « trouver "j'arrive" » (palette Ctrl+K, ou le champ du prompteur) : tous les clips voix
 * transcrits du projet sont parcourus, prises non retenues et autres playlists comprises,
 * et chaque endroit où la suite de mots est chantée devient un résultat (piste, prise,
 * temps du morceau). Choisir un résultat place la tête de lecture sur le mot.
 *
 *  - Mots comparés sans casse, sans accents ni ponctuation (« J'arrive, » = « j'arrive »),
 *    apostrophe facultative (« jarrive »), faute de frappe ou de transcription tolérée
 *    sur les mots de 5 lettres et plus, dernier mot en cours de frappe (début de mot).
 *  - Seule la partie montrée du clip compte (un mot rogné n'est pas proposé).
 *
 * Module pur : tests/voiceSearch.test.ts.
 */
import type { Clip, Track } from '../types';
import { normWord, transcriptValid } from './voiceLyrics';
import { takeNumberOf } from './takes';
import { metaOf } from './playlists';

export interface TakeWordHit {
  /** Identifiant stable (palette, liste). */
  key: string;
  trackId: string;
  trackName: string;
  clipId: string;
  clipName: string;
  /** « Prise 3 » (ou son nom) quand le clip est une prise d'un couloir. */
  take?: string;
  /** Playlist non active qui contient le clip (son nom), sinon absent. */
  playlist?: string;
  /** Le clip s'entend tel quel (playlist active et clip non muté). */
  audible: boolean;
  /** Temps du morceau (s) : début du premier mot trouvé, fin du dernier. */
  t: number;
  e: number;
  /** Mots tels que transcrits. */
  text: string;
  /** Contexte : quelques mots avant / après. */
  before: string;
  after: string;
  /** Tous les mots identiques à la recherche (pas de faute tolérée). */
  exact: boolean;
  score: number;
}

const VERB_PREFIX = /^\s*(?:trouver|trouve|cherche|chercher|rechercher|find|search|aller\s+[àa]|va\s+[àa])\s*:?\s+/i;
const QUOTES = /["«»“”„]/g;

/** Mots cherchés, normalisés (« trouver "j'arrive" » → ["j'arrive"]). */
export function parseWordQuery(query: string): string[] {
  const q = query.replace(VERB_PREFIX, '').replace(QUOTES, ' ');
  return q.split(/\s+/).map(normWord).filter(Boolean);
}

/** Texte cherché tel que tapé, sans le verbe ni les guillemets (« trouver "J'arrive" » → « J'arrive »). */
export const wordQueryText = (query: string): string => query.replace(VERB_PREFIX, '').replace(QUOTES, ' ').replace(/\s+/g, ' ').trim();

/** La recherche vise-t-elle explicitement des paroles (verbe ou guillemets) ? */
export const isExplicitWordQuery = (query: string): boolean => VERB_PREFIX.test(query) || /["«“]/.test(query);

const bare = (w: string) => w.replace(/'/g, '');

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Coût d'un mot (0 = identique, 1 = refusé). `last` : dernier mot cherché (peut être en cours de frappe). */
export function wordMatchCost(query: string, word: string, last = false): number {
  if (!word) return 1;
  if (query === word || bare(query) === bare(word)) return 0;
  // Élision collée ou non : « j'arrive » contre « arrive », seulement si le reste est long.
  const qa = bare(query), wa = bare(word);
  if (last && qa.length >= 2 && wa.startsWith(qa)) return 0.25;
  if (qa.length >= 5 && wa.length >= 4) {
    const d = editDistance(qa, wa, 2);
    if (d <= (qa.length >= 8 ? 2 : 1)) return 0.5;
  }
  return 1;
}

interface Source { track: Pick<Track, 'id' | 'name' | 'takeMeta'>; clip: Clip; audible: boolean; playlist?: string }

/** Clips voix transcrits du projet : ceux de la piste (prises comprises) et ceux des autres playlists. */
function sources(tracks: Pick<Track, 'id' | 'name' | 'clips' | 'takeMeta' | 'playlists' | 'activePlaylistId' | 'isMuted'>[]): Source[] {
  const out: Source[] = [];
  for (const t of tracks) {
    for (const c of t.clips || []) out.push({ track: t, clip: c, audible: !c.isMuted && !t.isMuted });
    for (const pl of t.playlists || []) {
      if (pl.id === t.activePlaylistId || !pl.clips?.length) continue;
      for (const c of pl.clips) out.push({ track: { id: t.id, name: t.name, takeMeta: pl.takeMeta }, clip: c, audible: false, playlist: pl.name });
    }
  }
  return out;
}

/**
 * Tous les endroits où la suite de mots est chantée, du meilleur au moins bon
 * (exact d'abord, prise entendue avant prise mise de côté, puis dans l'ordre du temps).
 */
export function searchTakeWords(
  tracks: Pick<Track, 'id' | 'name' | 'clips' | 'takeMeta' | 'playlists' | 'activePlaylistId' | 'isMuted'>[],
  query: string,
  opts: { limit?: number; context?: number } = {},
): TakeWordHit[] {
  const q = parseWordQuery(query);
  if (!q.length || (q.length === 1 && bare(q[0]).length < 2)) return [];
  const ctx = opts.context ?? 3;
  const hits: TakeWordHit[] = [];
  for (const src of sources(tracks)) {
    const c = src.clip;
    if (!transcriptValid(c)) continue;
    const off = c.offset || 0;
    const end = off + c.duration;
    const words = c.transcript.words.filter(w => w.s >= off - 0.05 && w.s < end - 0.02);
    const norm = words.map(w => normWord(w.w));
    for (let i = 0; i + q.length <= words.length; i++) {
      let cost = 0;
      for (let k = 0; k < q.length && cost < q.length; k++) cost += wordMatchCost(q[k], norm[i + k], k === q.length - 1);
      if (cost > Math.max(0.5, 0.34 * q.length)) continue;
      const first = words[i], last = words[i + q.length - 1];
      const n = takeNumberOf(c);
      const meta = n !== null ? metaOf(src.track, n) : undefined;
      hits.push({
        key: `${src.track.id}:${c.id}:${i}`,
        trackId: src.track.id,
        trackName: src.track.name,
        clipId: c.id,
        clipName: c.name,
        ...(n !== null ? { take: meta?.name?.trim() || `Prise ${n}` } : {}),
        ...(src.playlist ? { playlist: src.playlist } : {}),
        audible: src.audible,
        t: Math.round((c.start + Math.max(0, first.s - off)) * 1000) / 1000,
        e: Math.round((c.start + Math.min(last.e, end) - off) * 1000) / 1000,
        text: words.slice(i, i + q.length).map(w => w.w.trim()).join(' '),
        before: words.slice(Math.max(0, i - ctx), i).map(w => w.w.trim()).join(' '),
        after: words.slice(i + q.length, i + q.length + ctx).map(w => w.w.trim()).join(' '),
        exact: cost === 0,
        score: 100 - (cost / q.length) * 60 + (src.audible ? 8 : 0) + (src.playlist ? -4 : 0),
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.t - b.t || a.trackName.localeCompare(b.trackName));
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}

/** Temps « 1:12.4 ». */
export const fmtHitTime = (t: number) => {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
};

/** Où se trouve le mot, en clair : « Lead · Prise 3 · 1:12.4 ». */
export function hitWhere(h: TakeWordHit): string {
  return [h.trackName, h.playlist ? `playlist ${h.playlist}` : null, h.take, fmtHitTime(h.t)].filter(Boolean).join(' · ');
}

/** Phrase de l'avis affiché après le saut. */
export function hitNotice(h: TakeWordHit): string {
  const where = hitWhere(h);
  if (h.playlist) return `🔎 « ${h.text} » : ${where}. Ce mot est dans une autre playlist : active-la pour l’entendre.`;
  if (!h.audible) return `🔎 « ${h.text} » : ${where}. Prise mise de côté (mutée) : ouvre les couloirs de prises pour l’écouter.`;
  return `🔎 « ${h.text} » : ${where}. Espace pour écouter.`;
}

/** Événement : la timeline montre ce temps (et cette piste) si ils sont hors de la vue. */
export const REVEAL_TIME_EVENT = 'nova:reveal-time';
export interface RevealTimeDetail { time: number; trackId?: string }
