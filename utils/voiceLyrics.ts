/**
 * R24 · Paroles calées sur la voix (transcription Whisper faite sur le PC).
 *
 *  - Chaque clip voix transcrit garde ses mots (`Clip.transcript`), en temps du
 *    SON du clip : le texte suit les déplacements et les rognages du clip.
 *  - Les paroles du projet (`lyrics`, prompteur et onglet Paroles) restent un
 *    texte libre que l'artiste corrige. Le calage est recalculé à chaque fois en
 *    alignant ce texte sur les mots transcrits (distance d'édition mot à mot) :
 *    une ligne corrigée garde son temps, une ligne ajoutée prend celui de ses
 *    voisines. Les lignes « [Refrain] » sont des titres de section, pas des mots.
 *  - Corriger le texte réécrit aussi les mots des clips (texte au-dessus du clip).
 *
 * Module pur : tests/voiceLyrics.test.ts.
 */
import type { Clip, ClipTranscript, Track, TranscriptWord } from '../types';
import { TrackType } from '../types';

/** Un mot transcrit placé dans le morceau (secondes de la timeline). */
export interface TimedWord {
  w: string;
  t: number;
  e: number;
  /** Début de phrase (segment de Whisper). */
  b?: boolean;
  clipId: string;
  trackId: string;
}

export interface LyricsSection { name: string; start: number; end: number }

/** Sauvegarde d'un projet : les identifiants des sons changent à la réouverture ; on garde
 *  seulement « la transcription est celle du son du clip » ou « d'un autre son » (caduque). */
export const TRANSCRIPT_SAME_SOUND = '@meme-son';
export const TRANSCRIPT_OTHER_SOUND = '@autre-son';

/** Ligne de titre de section (« [Refrain] ») : pas chantée, pas alignée. */
export const isHeaderLine = (line: string): boolean => /^\s*\[[^\]]*\]\s*$/.test(line);

/** Forme comparable d'un mot : minuscules, sans accents, sans ponctuation. */
export function normWord(w: string): string {
  return w.toLowerCase().replace(/[’`]/g, "'").normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/[^a-z0-9']+/g, '').replace(/^'+|'+$/g, '');
}

export interface LyricToken { line: number; raw: string; norm: string }

/** Mots des paroles, ligne par ligne (titres de section ignorés). */
export function lyricTokens(text: string): LyricToken[] {
  const out: LyricToken[] = [];
  text.split('\n').forEach((line, i) => {
    if (isHeaderLine(line)) return;
    for (const raw of line.split(/\s+/)) {
      const n = normWord(raw);
      if (n) out.push({ line: i, raw, norm: n });
    }
  });
  return out;
}

/** La transcription d'un clip est-elle encore valable (même son, sens normal) ? */
export function transcriptValid(clip: Pick<Clip, 'transcript' | 'bufferId' | 'isReversed' | 'type'>): clip is Clip & { transcript: ClipTranscript } {
  const tr = clip.transcript;
  if (!tr || !tr.words?.length || clip.isReversed || clip.type === TrackType.MIDI) return false;
  return !tr.bufferId || !clip.bufferId || tr.bufferId === clip.bufferId;
}

/** Mots du clip qui s'entendent (partie montrée), en temps de la timeline. */
export function clipTimedWords(clip: Clip, trackId: string): TimedWord[] {
  if (!transcriptValid(clip)) return [];
  const off = clip.offset || 0;
  const end = off + clip.duration;
  return clip.transcript.words
    .filter(w => w.s >= off - 0.05 && w.s < end - 0.02)
    .map(w => ({ w: w.w, t: clip.start + (w.s - off), e: clip.start + (Math.min(w.e, end) - off), clipId: clip.id, trackId, ...(w.b ? { b: true } : {}) }));
}

/**
 * Tous les mots transcrits du projet, dans l'ordre du temps. Une prise qui en
 * recouvre une autre déjà retenue (double, back) est laissée de côté : le
 * prompteur suit une seule voix.
 */
export function projectTimedWords(tracks: Pick<Track, 'id' | 'clips' | 'isMuted'>[]): TimedWord[] {
  const cand: { words: TimedWord[]; s: number; e: number }[] = [];
  for (const t of tracks) {
    for (const c of t.clips || []) {
      if (c.isMuted) continue;
      const words = clipTimedWords(c as Clip, t.id);
      if (words.length) cand.push({ words, s: words[0].t, e: words[words.length - 1].e });
    }
  }
  cand.sort((a, b) => a.s - b.s || b.words.length - a.words.length);
  const kept: { s: number; e: number }[] = [];
  const out: TimedWord[] = [];
  for (const c of cand) {
    const span = Math.max(0.01, c.e - c.s);
    const overlap = kept.reduce((acc, k) => acc + Math.max(0, Math.min(k.e, c.e) - Math.max(k.s, c.s)), 0);
    if (overlap > span * 0.5) continue;
    kept.push({ s: c.s, e: c.e });
    out.push(...c.words);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Proximité de deux mots (0 = identiques, 1 = sans rapport), pour l'alignement. */
function wordCost(a: string, b: string): number {
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (!n || !m) return 1;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  const ratio = prev[m] / Math.max(n, m);
  return ratio <= 0.34 ? 0.4 : ratio <= 0.6 ? 0.8 : 1;
}

/**
 * Alignement mot à mot (distance d'édition, substitution pondérée) : paires
 * [index dans a | null, index dans b | null] dans l'ordre.
 */
export function alignWords(a: string[], b: string[]): [number | null, number | null][] {
  const n = a.length, m = b.length;
  const W = m + 1;
  const d = new Float32Array((n + 1) * W);
  for (let i = 0; i <= n; i++) d[i * W] = i;
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i * W + j] = Math.min(d[(i - 1) * W + j] + 1, d[i * W + j - 1] + 1, d[(i - 1) * W + j - 1] + 1.2 * wordCost(a[i - 1], b[j - 1]));
    }
  }
  const path: [number | null, number | null][] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && Math.abs(d[i * W + j] - (d[(i - 1) * W + j - 1] + 1.2 * wordCost(a[i - 1], b[j - 1]))) < 1e-4) {
      path.push([i - 1, j - 1]); i--; j--;
    } else if (i > 0 && Math.abs(d[i * W + j] - (d[(i - 1) * W + j] + 1)) < 1e-4) {
      path.push([i - 1, null]); i--;
    } else {
      path.push([null, j - 1]); j--;
    }
  }
  return path.reverse();
}

/** Paires [jeton des paroles, mot transcrit] retenues (même mot ou mot corrigé). */
function matchedPairs(tokens: LyricToken[], words: TimedWord[]): [number, number][] {
  const path = alignWords(tokens.map(t => t.norm), words.map(w => normWord(w.w)));
  return path.filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
}

/**
 * Début de chaque ligne des paroles (s, timeline), ou null si la ligne ne
 * correspond à aucun mot chanté (titre de section, couplet pas encore enregistré).
 */
export function lyricLineTimes(text: string, words: TimedWord[]): (number | null)[] {
  const lines = text.split('\n');
  const out: (number | null)[] = lines.map(() => null);
  if (!words.length) return out;
  const tokens = lyricTokens(text);
  for (const [ti, wi] of matchedPairs(tokens, words)) {
    const l = tokens[ti].line;
    if (out[l] === null) out[l] = words[wi].t;
  }
  return out;
}

export interface PrompterAnchor { t: number; line: number }

/**
 * Points de calage du prompteur (temps → ligne) tirés des mots transcrits :
 * chaque ligne chantée passe sur la ligne de lecture quand son premier mot est
 * chanté. Les lignes sans temps (titres, ajouts) sont interpolées entre leurs
 * voisines. Vide : pas de transcription utilisable.
 */
export function timedAnchors(text: string, words: TimedWord[]): PrompterAnchor[] {
  const times = lyricLineTimes(text, words);
  const anchors: PrompterAnchor[] = [];
  let last = -Infinity;
  let lastLine = -1;
  times.forEach((t, line) => {
    if (t === null || t <= last + 0.05) return; // l'ordre du temps prime (répétitions mal alignées)
    // Titre de section juste avant : il passe un peu avant sa première ligne.
    if (line > 0 && isHeaderLine(text.split('\n')[line - 1] || '') && anchors.length) {
      anchors.push({ t: Math.max(last + 0.01, t - 0.8), line: line - 1 });
    }
    anchors.push({ t, line });
    last = t;
    lastLine = line;
  });
  if (anchors.length < 2) return anchors.length === 1 && words.length ? [anchors[0], { t: words[words.length - 1].e + 0.3, line: anchors[0].line + 1 }] : [];
  // Fin : la dernière ligne chantée quitte la ligne de lecture après son dernier mot.
  const tokens = lyricTokens(text);
  const pairs = matchedPairs(tokens, words);
  const lastMatch = pairs.filter(([ti]) => tokens[ti].line === lastLine).pop();
  const endT = lastMatch ? words[lastMatch[1]].e : words[words.length - 1].e;
  anchors.push({ t: Math.max(last + 0.2, endT + 0.3), line: lastLine + 1 });
  return anchors;
}

/** Indice du mot en cours dans une ligne (surlignage façon karaoké), -1 si aucun. */
export function activeWordInLine(text: string, words: TimedWord[], line: number, t: number): number {
  const tokens = lyricTokens(text);
  let idx = -1;
  let k = -1;
  const pairs = new Map(matchedPairs(tokens, words));
  tokens.forEach((tok, ti) => {
    if (tok.line !== line) return;
    k++;
    const wi = pairs.get(ti);
    if (wi !== undefined && words[wi].t <= t) idx = k;
  });
  return idx;
}

const ENDS_PHRASE = /[.!?…]$/;

function cleanWord(w: string): string {
  return w.trim().replace(/^[«"“]+|[»"”]+$/g, '');
}

/**
 * Paroles tirées de la transcription : une ligne par phrase (pause, ponctuation,
 * ou 10 mots au plus), une ligne vide entre les parties, et le nom de la section
 * (« [Refrain] ») quand le projet a des repères.
 */
export function lyricsFromWords(words: TimedWord[], sections: LyricsSection[] = [], opts: { lineGap?: number; blockGap?: number; maxWords?: number } = {}): string {
  const lineGap = opts.lineGap ?? 0.6;
  const blockGap = opts.blockGap ?? 2.5;
  const maxWords = opts.maxWords ?? 10;
  const sorted = [...sections].sort((a, b) => a.start - b.start);
  const sectionAt = (t: number) => sorted.filter(s => t >= s.start - 0.05 && t < s.end).pop() || null;
  const out: string[] = [];
  let line: string[] = [];
  let prev: TimedWord | null = null;
  let curSection: LyricsSection | null | undefined;
  const flush = () => {
    if (!line.length) return;
    let s = line.join(' ').replace(/\s+([,;:!?.…])/g, '$1').replace(/[,;:.]+$/, '');
    s = s.charAt(0).toUpperCase() + s.slice(1);
    out.push(s);
    line = [];
  };
  for (const w of words) {
    const txt = cleanWord(w.w);
    if (!txt) continue;
    const gap = prev ? w.t - prev.e : Infinity;
    const natural = !prev || gap >= lineGap || line.length >= maxWords || ((w.b || ENDS_PHRASE.test(cleanWord(prev.w))) && line.length >= 3);
    // Une ligne appartient à la section où elle commence (un repère posé au milieu d'un vers ne le coupe pas).
    const sec = natural ? sectionAt(w.t) : curSection ?? null;
    const newSection = natural && sorted.length > 0 && (curSection === undefined || (sec?.name ?? null) !== (curSection?.name ?? null) || (!!sec && !!curSection && sec.start !== curSection.start));
    if (newSection || gap >= blockGap) {
      flush();
      if (out.length && out[out.length - 1] !== '') out.push('');
      if (newSection && sec) out.push(`[${sec.name}]`);
      curSection = sec;
    } else if (natural) {
      flush();
    }
    line.push(txt);
    prev = w;
  }
  flush();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/**
 * Le texte corrigé par l'artiste reporté sur les mots des clips (texte affiché
 * au-dessus du clip) : mot corrigé = même temps ; mot ajouté = temps entre ses
 * voisins (dans le clip du mot d'avant) ; mot supprimé = retiré. Un passage
 * ajouté de plus de 6 mots (couplet pas encore enregistré) n'est pas reporté.
 * Renvoie les nouveaux mots (temps du son du clip) des seuls clips changés.
 */
export function correctedTranscripts(tracks: Pick<Track, 'id' | 'clips' | 'isMuted'>[], text: string): Map<string, TranscriptWord[]> {
  const words = projectTimedWords(tracks);
  const changed = new Map<string, TranscriptWord[]>();
  if (!words.length) return changed;
  const tokens = lyricTokens(text);
  const path = alignWords(tokens.map(t => t.norm), words.map(w => normWord(w.w)));
  const clips = new Map<string, Clip>();
  tracks.forEach(t => t.clips.forEach(c => clips.set(c.id, c as Clip)));
  // Nouveaux mots, en temps de la timeline, par clip.
  type Fresh = { w: string; t: number; e: number; b?: boolean };
  const perClip = new Map<string, Fresh[]>();
  const push = (clipId: string, w: Fresh) => {
    const l = perClip.get(clipId) || [];
    l.push(w);
    perClip.set(clipId, l);
  };
  let dirty = new Set<string>();
  for (let k = 0; k < path.length; k++) {
    const [ti, wi] = path[k];
    if (ti !== null && wi !== null) {
      const src = words[wi];
      const raw = tokens[ti].raw;
      if (normWord(src.w) !== tokens[ti].norm) dirty.add(src.clipId);
      push(src.clipId, { w: raw, t: src.t, e: src.e, ...(src.b ? { b: true } : {}) });
    } else if (wi !== null) {
      dirty.add(words[wi].clipId); // mot retiré par l'artiste
    } else if (ti !== null) {
      // Suite de mots ajoutés : entre le mot transcrit d'avant et celui d'après.
      let k2 = k;
      while (k2 < path.length && path[k2][1] === null && path[k2][0] !== null) k2++;
      const run = path.slice(k, k2).map(p => tokens[p[0] as number]);
      const before = [...path.slice(0, k)].reverse().find(p => p[1] !== null);
      const after = path.slice(k2).find(p => p[1] !== null);
      const prevW = before ? words[before[1] as number] : null;
      const nextW = after ? words[after[1] as number] : null;
      if (run.length <= 6 && (prevW || nextW)) {
        const home = prevW || nextW!;
        const t0 = prevW ? prevW.e : Math.max(0, nextW!.t - 0.3 * run.length);
        const t1 = nextW && (!prevW || nextW.clipId === prevW.clipId) ? nextW.t : t0 + 0.3 * run.length;
        const step = Math.max(0.05, (t1 - t0) / run.length);
        run.forEach((tok, r) => push(home.clipId, { w: tok.raw, t: t0 + r * step, e: t0 + (r + 1) * step }));
        dirty.add(home.clipId);
      }
      k = k2 - 1;
    }
  }
  dirty = new Set([...dirty].filter(id => clips.has(id)));
  for (const id of dirty) {
    const c = clips.get(id)!;
    const off = c.offset || 0;
    const kept = (c.transcript?.words || []).filter(w => w.s < off - 0.05 || w.s >= off + c.duration - 0.02); // hors de la partie montrée : gardés tels quels
    const fresh = (perClip.get(id) || []).map(w => ({ w: w.w, s: round3(w.t - c.start + off), e: round3(w.e - c.start + off), ...(w.b ? { b: true } : {}) }));
    changed.set(id, [...kept, ...fresh].sort((a, b) => a.s - b.s));
  }
  return changed;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Mots du transcript décalés quand le son du clip change (AudioSuite : le nouveau son commence `from` s plus loin). */
export function shiftTranscript(tr: ClipTranscript, from: number, newBufferId: string): ClipTranscript {
  return { ...tr, bufferId: newBufferId, words: tr.words.map(w => ({ ...w, s: round3(w.s - from), e: round3(w.e - from) })) };
}

/** Mots à dessiner au-dessus d'un clip (temps relatif au début du clip). */
export function clipLyricLabels(clip: Clip): { text: string; at: number }[] {
  if (!clip.transcript?.show || !transcriptValid(clip)) return [];
  const off = clip.offset || 0;
  return clip.transcript.words
    .filter(w => w.s >= off - 0.05 && w.s < off + clip.duration)
    .map(w => ({ text: cleanWord(w.w), at: w.s - off }));
}

/** Transcription d'un clip à partir des mots renvoyés par le pont (temps du son envoyé, qui commence à `from` dans le son du clip). */
export function buildTranscript(words: { w: string; s: number; e: number; p?: number; b?: boolean }[], o: { from: number; bufferId?: string; language: string; model: string; show?: boolean; now?: number }): ClipTranscript {
  return {
    version: 1,
    language: o.language,
    model: o.model,
    words: words.filter(w => cleanWord(w.w)).map(w => ({ w: w.w.trim(), s: round3(w.s + o.from), e: round3(w.e + o.from), ...(w.p !== undefined ? { p: Math.round(w.p * 1000) / 1000 } : {}), ...(w.b ? { b: true } : {}) })),
    ...(o.bufferId ? { bufferId: o.bufferId } : {}),
    at: o.now ?? Date.now(),
    ...(o.show ? { show: true } : {}),
  };
}

/**
 * Nouvelles paroles (prompteur, onglet Paroles) : le texte change, et les mots des
 * clips transcrits suivent la correction (une seule étape d'annulation).
 */
export function withLyricsCorrections<S extends { lyrics?: string; tracks: Track[] }>(state: S, text: string): S {
  const changed = correctedTranscripts(state.tracks, text);
  if (!changed.size) return state.lyrics === text ? state : { ...state, lyrics: text };
  return {
    ...state,
    lyrics: text,
    tracks: state.tracks.map(t => (t.clips.some(c => changed.has(c.id)) ? {
      ...t,
      clips: t.clips.map(c => (changed.has(c.id) && c.transcript ? { ...c, transcript: { ...c.transcript, words: changed.get(c.id)! } } : c)),
    } : t)),
  };
}

/**
 * Temps de chaque mot des paroles, ligne par ligne (null : mot ajouté, pas chanté) :
 * calculé une fois, puis lu à chaque image du prompteur (surlignage du mot chanté).
 */
export function lineWordTimes(text: string, words: TimedWord[]): (number | null)[][] {
  const lines = text.split('\n');
  const out: (number | null)[][] = lines.map(() => []);
  const tokens = lyricTokens(text);
  const pairs = words.length ? new Map(matchedPairs(tokens, words)) : new Map<number, number>();
  tokens.forEach((tok, ti) => {
    const wi = pairs.get(ti);
    out[tok.line].push(wi !== undefined ? words[wi].t : null);
  });
  return out;
}

/** Indice du dernier mot déjà chanté dans une ligne (temps précalculés), -1 si aucun. */
export function wordIndexAt(times: (number | null)[] | undefined, t: number): number {
  if (!times) return -1;
  let idx = -1;
  times.forEach((x, i) => { if (x !== null && x <= t) idx = i; });
  return idx;
}
