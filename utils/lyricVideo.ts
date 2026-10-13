/**
 * Lot 2a · Clip vertical avec les paroles synchronisées (la « vidéo de paroles » de BandLab, sans jetons).
 *
 * Module pur (tests/lyricVideo.test.ts) :
 *  - les lignes et les mots à afficher, avec leurs temps dans le morceau :
 *      1. paroles transcrites mot par mot (Whisper, appli Windows : utils/voiceLyrics) ;
 *      2. sinon les paroles tapées, calées comme le prompteur (régions associées, sinon
 *         départ + vitesse) ; les mots d'une ligne se répartissent sur la ligne ;
 *  - ce qui est affiché à l'instant t (ligne en cours, mots déjà chantés) ;
 *  - les plages proposées (refrain, passage le plus fort, boucle, entrée de la voix) ;
 *  - les droits du clip, selon les règles EXISTANTES de l'extrait et de l'export
 *    (components/ExportModal.tsx) : sans licence ou sans export payé, 30 s au plus,
 *    sur un passage où la voix de l'artiste s'entend (comme l'extrait). Aucun tag audio.
 */
import type { DAWState, Marker, Track } from '../types';
import { TrackType } from '../types';
import { isHeaderLine, lineWordTimes, lyricsFromWords, normWord, projectTimedWords, timedAnchors, type LyricsSection, type TimedWord } from './voiceLyrics';
import { lyricBlocks, prompterLine, regionAnchors } from './lyricsTiming';

export interface ClipWord { text: string; t: number; e: number }
export interface ClipLine { words: ClipWord[]; t: number; e: number; section?: string }
/** D'où viennent les temps : voix transcrite, régions du prompteur, vitesse du prompteur. */
export type LyricsSource = 'voix' | 'regions' | 'vitesse' | 'aucune';
export interface ClipLyrics { lines: ClipLine[]; source: LyricsSource; text: string }

export const CLIP_W = 1080;
export const CLIP_H = 1920;
export const CLIP_FPS = 30;
/** Durées proposées (s). */
export const CLIP_DURATIONS = [15, 30, 45, 60] as const;
/** Sans licence / export non payé : comme l'extrait à partager. */
export const LIMITED_MAX = 30;
export const FULL_MAX = 60;
export const MIN_CLIP = 5;

/** La ligne s'affiche un peu avant d'être chantée, et reste un peu après. */
export const LINE_PRE = 0.35;
export const LINE_HOLD = 1.2;

const isVoiceTrack = (t: Track) => t.type === TrackType.AUDIO && t.id !== 'instrumental' && !t.instrumentId;

function cleanWord(w: string): string {
  return w.trim().replace(/^[«"“(]+|[»"”)]+$/g, '');
}

/** Mots « chantables » d'une ligne, dans le même ordre que lyricTokens / lineWordTimes. */
export function lineRawWords(line: string): string[] {
  return line.split(/\s+/).filter(raw => !!normWord(raw)).map(cleanWord);
}

/** Sections « [Refrain] » du projet (régions) pour ranger les paroles tirées de la transcription. */
function regionSections(markers: Marker[]): LyricsSection[] {
  return markers.filter(m => m.type === 'REGION' && (m.endTime ?? 0) > m.time).map(m => ({ name: m.name, start: m.time, end: m.endTime as number }));
}

/** Premier instant où la position du prompteur atteint la ligne `line` (fonction croissante). */
function prompterLineStart(line: number, opts: { anchors: { t: number; line: number }[]; start: number; speed: number }, maxT: number): number | null {
  // Vitesse fixe : la ligne L passe à départ + L / vitesse (avant le départ, le texte attend).
  if (!opts.anchors.length) return opts.speed > 0 ? opts.start + (line * 60) / opts.speed : null;
  if (prompterLine(maxT, opts) < line) return null;
  let lo = 0, hi = maxT;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (prompterLine(mid, opts) >= line - 1e-9) hi = mid; else lo = mid;
  }
  // Avant la 1re région le texte attend sur son 1er bloc : la ligne commence avec la région.
  const first = opts.anchors[0];
  if (first && line <= first.line + 1e-9) return Math.max(hi, first.t);
  return hi;
}

/** Remplit les temps manquants d'une ligne (mots ajoutés à la main) entre leurs voisins. */
function fillTimes(times: (number | null)[], lineStart: number, lineEnd: number): number[] {
  const out = times.slice();
  const n = out.length;
  for (let i = 0; i < n; i++) {
    if (out[i] !== null) continue;
    let a = i - 1; while (a >= 0 && out[a] === null) a--;
    let b = i + 1; while (b < n && out[b] === null) b++;
    const ta = a >= 0 ? (out[a] as number) : lineStart;
    const tb = b < n ? (out[b] as number) : lineEnd;
    const span = b - a;
    for (let j = a + 1; j < b; j++) out[j] = ta + (tb - ta) * ((j - a) / span);
    i = b - 1;
  }
  return out as number[];
}

/**
 * Lignes du clip avec leurs mots chronométrés.
 * `text` : paroles du projet (vides : tirées de la transcription).
 */
export function clipLyricLines(input: {
  lyrics?: string;
  words: TimedWord[];
  markers?: Marker[];
  lyricsRegions?: Record<string, string>;
  lyricsStart?: number;
  lyricsSpeed?: number;
  /** Fin du morceau (s) : borne la recherche des temps du prompteur. */
  end: number;
}): ClipLyrics {
  const markers = input.markers || [];
  const words = input.words || [];
  const typed = (input.lyrics || '').trim() ? (input.lyrics as string) : '';
  const text = typed || (words.length ? lyricsFromWords(words, regionSections(markers)) : '');
  if (!text.trim()) return { lines: [], source: 'aucune', text: '' };
  const rawLines = text.split('\n');
  // Section en cours (titre « [Refrain] » au-dessus de la ligne).
  const sectionOf: (string | undefined)[] = [];
  let sec: string | undefined;
  rawLines.forEach((l, i) => { if (isHeaderLine(l)) sec = l.trim().slice(1, -1).trim(); else if (!l.trim()) { /* garde la section */ } sectionOf[i] = sec; });

  const lines: ClipLine[] = [];
  const voice = words.length > 0 && timedAnchors(text, words).length >= 2;
  if (voice) {
    const times = lineWordTimes(text, words);
    const endOf = new Map<number, number>();
    for (const w of words) endOf.set(Math.round(w.t * 1000), w.e);
    rawLines.forEach((l, i) => {
      if (isHeaderLine(l) || !l.trim()) return;
      const lt = times[i] || [];
      if (!lt.some(x => x !== null)) return; // ligne pas (encore) chantée
      const raw = lineRawWords(l);
      const known = lt.filter((x): x is number => x !== null);
      const first = Math.min(...known), last = Math.max(...known);
      const lastEnd = endOf.get(Math.round(last * 1000)) ?? last + 0.4;
      const filled = fillTimes(lt, first, lastEnd);
      const ws: ClipWord[] = raw.map((text, k) => {
        const t = filled[k] ?? first;
        const exact = lt[k] !== null ? endOf.get(Math.round((lt[k] as number) * 1000)) : undefined;
        const next = k + 1 < raw.length ? filled[k + 1] : lastEnd;
        return { text, t, e: Math.max(t + 0.05, exact !== undefined ? Math.min(exact, Math.max(next, t + 0.05)) : next) };
      });
      lines.push({ words: ws, t: ws[0].t, e: Math.max(ws[ws.length - 1].e, lastEnd), section: sectionOf[i] });
    });
    lines.sort((a, b) => a.t - b.t);
    return { lines: dedupeOrder(lines), source: 'voix', text };
  }

  // Paroles tapées : calage du prompteur.
  const blocks = lyricBlocks(rawLines);
  const anchors = regionAnchors(blocks, input.lyricsRegions || {}, markers.filter(m => m.type === 'REGION'));
  const speed = input.lyricsSpeed ?? 16;
  const opts = { anchors, start: input.lyricsStart ?? 0, speed };
  if (!anchors.length && speed <= 0) return { lines: [], source: 'vitesse', text };
  const maxT = Math.max(60, input.end + 120);
  const startOf = (i: number) => prompterLineStart(i, opts, maxT);
  rawLines.forEach((l, i) => {
    if (isHeaderLine(l) || !l.trim()) return;
    const t0 = startOf(i);
    if (t0 === null) return;
    const t1 = startOf(i + 1) ?? t0 + 60 / Math.max(1, speed);
    const raw = lineRawWords(l);
    if (!raw.length) return;
    const span = Math.max(0.3, Math.min(t1 - t0, 8));
    const step = (span * 0.9) / raw.length;
    const ws = raw.map((text, k) => ({ text, t: t0 + k * step, e: t0 + (k + 1) * step }));
    lines.push({ words: ws, t: t0, e: t0 + span, section: sectionOf[i] });
  });
  return { lines: dedupeOrder(lines), source: anchors.length ? 'regions' : 'vitesse', text };
}

/** Lignes dans l'ordre du temps, sans chevauchement (une ligne s'arrête quand la suivante commence). */
function dedupeOrder(lines: ClipLine[]): ClipLine[] {
  const out = lines.filter(l => l.words.length).sort((a, b) => a.t - b.t);
  for (let i = 0; i + 1 < out.length; i++) {
    if (out[i].e > out[i + 1].t) out[i] = { ...out[i], e: Math.max(out[i].t + 0.05, out[i + 1].t) };
  }
  return out;
}

/** Ce qui est à l'écran à l'instant t (temps du morceau). */
export interface LyricsFrame {
  /** Ligne affichée (indice dans lines), -1 : aucune. */
  line: number;
  /** Mots déjà chantés de la ligne (indice du dernier), -1 : aucun. */
  sung: number;
  /** Progression du mot en cours (0..1), pour les animations. */
  wordProgress: number;
  /** Temps écoulé depuis l'apparition de la ligne (s). */
  sinceShow: number;
  /** Ligne suivante (aperçu), -1 : aucune. */
  next: number;
}

export function lyricsAt(lines: ClipLine[], t: number): LyricsFrame {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t - LINE_PRE <= t) idx = i; else break;
  }
  if (idx >= 0 && t > lines[idx].e + LINE_HOLD && !(idx + 1 < lines.length && lines[idx + 1].t - LINE_PRE <= t)) {
    // Silence entre deux parties : rien à l'écran, la ligne suivante s'annonce juste avant.
    return { line: -1, sung: -1, wordProgress: 0, sinceShow: 0, next: idx + 1 < lines.length ? idx + 1 : -1 };
  }
  if (idx < 0) return { line: -1, sung: -1, wordProgress: 0, sinceShow: 0, next: lines.length ? 0 : -1 };
  const l = lines[idx];
  let sung = -1;
  l.words.forEach((w, k) => { if (w.t <= t) sung = k; });
  const cur = sung >= 0 ? l.words[sung] : null;
  const wordProgress = cur ? Math.max(0, Math.min(1, (t - cur.t) / Math.max(0.05, cur.e - cur.t))) : 0;
  return { line: idx, sung, wordProgress, sinceShow: Math.max(0, t - (l.t - LINE_PRE)), next: idx + 1 < lines.length ? idx + 1 : -1 };
}

/** Lignes qui touchent la plage [start, start + duration] (pour l'aperçu et les tests). */
export function linesInRange(lines: ClipLine[], start: number, duration: number): ClipLine[] {
  return lines.filter(l => l.e >= start && l.t <= start + duration);
}

// ── Plages ───────────────────────────────────────────────────────────────────

export interface ClipRange { start: number; duration: number }
export interface RangeSuggestion extends ClipRange { id: 'refrain' | 'fort' | 'boucle' | 'voix'; label: string }

/** Fin du projet (dernier clip non muet). */
export function songEnd(tracks: Pick<Track, 'clips'>[]): number {
  let end = 0;
  tracks.forEach(t => t.clips.forEach(c => { if (!c.isMuted) end = Math.max(end, c.start + c.duration); }));
  return end;
}

/** Plages des clips voix non muets (l'artiste). */
export function voiceSpans(tracks: Track[]): ClipRange[] {
  const out: ClipRange[] = [];
  tracks.filter(t => isVoiceTrack(t) && !t.isMuted).forEach(t => t.clips.forEach(c => { if (!c.isMuted && c.duration > 0) out.push({ start: c.start, duration: c.duration }); }));
  return out.sort((a, b) => a.start - b.start);
}

/** Part (0..1) de la plage où la voix de l'artiste s'entend. */
export function voiceCoverage(spans: ClipRange[], r: ClipRange): number {
  if (r.duration <= 0) return 0;
  const a = r.start, b = r.start + r.duration;
  const pts = spans.map(s => [Math.max(a, s.start), Math.min(b, s.start + s.duration)] as const).filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]);
  let covered = 0, curA = -Infinity, curB = -Infinity;
  for (const [x, y] of pts) {
    if (x > curB) { if (curB > curA) covered += curB - curA; curA = x; curB = y; } else curB = Math.max(curB, y);
  }
  if (curB > curA) covered += curB - curA;
  return covered / r.duration;
}

export function clampRange(r: ClipRange, end: number, maxDur: number): ClipRange {
  const duration = Math.max(Math.min(MIN_CLIP, end), Math.min(r.duration, maxDur, Math.max(MIN_CLIP, end)));
  const start = Math.max(0, Math.min(r.start, Math.max(0, end - duration)));
  return { start: round2(start), duration: round2(Math.min(duration, Math.max(0.5, end - start))) };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Énergie du morceau par tranches de `bin` s (somme des clips, gain et volume compris),
 * à partir des sons déjà chargés. Vide si aucun son n'est disponible.
 */
export function energyEnvelope(tracks: Track[], getBuffer: (c: Track['clips'][number]) => { sampleRate: number; length: number; getChannelData(c: number): Float32Array } | undefined, end: number, bin = 0.5): Float32Array {
  const n = Math.max(1, Math.ceil(end / bin));
  const env = new Float32Array(n);
  let any = false;
  for (const t of tracks) {
    if (t.isMuted || t.type !== TrackType.AUDIO) continue;
    const vol = typeof t.volume === 'number' ? t.volume : 1;
    for (const c of t.clips) {
      if (c.isMuted) continue;
      const buf = getBuffer(c);
      if (!buf) continue;
      any = true;
      const d = buf.getChannelData(0);
      const sr = buf.sampleRate;
      const g = (c.gain ?? 1) * vol;
      const off = c.offset || 0;
      for (let b = Math.floor(c.start / bin); b < n && b * bin < c.start + c.duration; b++) {
        const t0 = Math.max(b * bin, c.start), t1 = Math.min((b + 1) * bin, c.start + c.duration);
        if (t1 <= t0) continue;
        const s0 = Math.floor((t0 - c.start + off) * sr), s1 = Math.min(d.length, Math.floor((t1 - c.start + off) * sr));
        const stride = Math.max(1, Math.floor((s1 - s0) / 400));
        let acc = 0, k = 0;
        for (let s = Math.max(0, s0); s < s1; s += stride) { acc += d[s] * d[s]; k++; }
        if (k) env[b] += (acc / k) * g * g * ((t1 - t0) / bin);
      }
    }
  }
  return any ? env : new Float32Array(0);
}

/** Fenêtre de `duration` s la plus forte (énergie moyenne la plus haute). */
export function loudestWindow(env: Float32Array, bin: number, duration: number): number | null {
  const w = Math.max(1, Math.round(duration / bin));
  if (env.length === 0) return null;
  if (env.length <= w) return 0;
  let sum = 0;
  for (let i = 0; i < w; i++) sum += env[i];
  let best = sum, at = 0;
  for (let i = w; i < env.length; i++) {
    sum += env[i] - env[i - w];
    if (sum > best * 1.0001) { best = sum; at = i - w + 1; }
  }
  return at * bin;
}

const REFRAIN_RX = /\b(refrain|chorus|hook|ref)\b/i;

/**
 * Plages proposées, la meilleure d'abord : refrain (région ou titre « [Refrain] » des
 * paroles), passage le plus fort, boucle en cours, entrée de la voix.
 */
export function suggestRanges(o: {
  state: Pick<DAWState, 'tracks' | 'markers' | 'isLoopActive' | 'loopStart' | 'loopEnd'>;
  lines: ClipLine[];
  duration: number;
  env?: Float32Array;
  bin?: number;
}): RangeSuggestion[] {
  const { state, lines, duration } = o;
  const end = songEnd(state.tracks);
  if (end <= 0) return [];
  const out: RangeSuggestion[] = [];
  const add = (id: RangeSuggestion['id'], label: string, start: number) => {
    const r = clampRange({ start, duration }, end, duration);
    if (out.some(x => Math.abs(x.start - r.start) < 1.5)) return;
    out.push({ id, label, ...r });
  };
  const region = (state.markers || []).find(m => m.type === 'REGION' && REFRAIN_RX.test(m.name) && (m.endTime ?? 0) > m.time);
  if (region) add('refrain', region.name.trim() || 'Refrain', region.time);
  else {
    const l = lines.find(x => x.section && REFRAIN_RX.test(x.section));
    if (l) add('refrain', 'Refrain', Math.max(0, l.t - 0.5));
  }
  if (o.env && o.env.length) {
    const at = loudestWindow(o.env, o.bin ?? 0.5, duration);
    if (at !== null) add('fort', 'Passage le plus fort', at);
  }
  if (state.isLoopActive && state.loopEnd > state.loopStart + 1) add('boucle', 'Ta boucle', state.loopStart);
  const spans = voiceSpans(state.tracks as Track[]);
  if (spans.length) add('voix', 'Début de ta voix', Math.max(0, spans[0].start - 1));
  else add('voix', 'Début du morceau', 0);
  return out;
}

// ── Droits (règles existantes de l'extrait et de l'export, inchangées) ──────────

export interface ClipRights {
  /** Clip « complet » : jusqu'à 60 s, n'importe quel passage. */
  full: boolean;
  maxDuration: number;
  /** Pourquoi c'est limité (texte pour l'artiste), null si complet. */
  reason: string | null;
  /** Limité : la plage doit montrer la voix de l'artiste (comme l'extrait). */
  needsVoice: boolean;
}

/**
 * Mêmes règles que la fenêtre Exporter (mix complet) :
 *  - admin du studio : tout ;
 *  - instru / mélodie du catalogue pas achetée : pas d'export du mix → extrait seulement ;
 *  - projet sans instru du catalogue (instru importée) : export payant (2 € ou crédit
 *    Nova Pro) → extrait seulement tant que l'export n'est pas payé ;
 *  - tout acheté : export libre.
 * `exportPaid` null : vérification en cours (traité comme non payé).
 */
export function clipRights(o: { admin: boolean; unboughtCatalog: number; hasCatalogBeat: boolean; exportPaid: boolean | null }): ClipRights {
  if (o.admin) return { full: true, maxDuration: FULL_MAX, reason: null, needsVoice: false };
  if (o.unboughtCatalog > 0) {
    return { full: false, maxDuration: LIMITED_MAX, needsVoice: true,
      reason: o.unboughtCatalog > 1 ? `${o.unboughtCatalog} instrus de ton projet ne sont pas encore achetées` : "L'instru de ton projet n'est pas encore achetée" };
  }
  if (!o.hasCatalogBeat && o.exportPaid !== true) {
    return { full: false, maxDuration: LIMITED_MAX, needsVoice: true, reason: "L'export de ce projet n'est pas encore payé" };
  }
  return { full: true, maxDuration: FULL_MAX, reason: null, needsVoice: false };
}

/** Part minimale de voix dans un clip limité (l'extrait se cale sur la voix). */
export const LIMITED_VOICE_SHARE = 0.5;

/** La plage est-elle permise ? null : oui ; sinon le message à afficher. */
export function rangeProblem(r: ClipRange, rights: ClipRights, spans: ClipRange[]): string | null {
  if (r.duration > rights.maxDuration + 0.01) return `${rights.maxDuration} s au plus${rights.full ? '' : ' sans licence (comme l\'extrait)'}`;
  if (r.duration < MIN_CLIP - 0.01) return `${MIN_CLIP} s au moins`;
  if (rights.needsVoice && voiceCoverage(spans, r) < LIMITED_VOICE_SHARE) return 'Sans licence, le clip montre ta voix : choisis un passage où tu chantes (au moins la moitié du clip)';
  return null;
}

/** Plage la plus proche qui respecte la règle de la voix (même durée), ou null. */
export function nearestVoiceRange(r: ClipRange, spans: ClipRange[], end: number): ClipRange | null {
  if (voiceCoverage(spans, r) >= LIMITED_VOICE_SHARE) return r;
  let best: ClipRange | null = null, dist = Infinity;
  for (let s = 0; s <= Math.max(0, end - r.duration) + 1e-6; s += 0.5) {
    const c = { start: s, duration: r.duration };
    if (voiceCoverage(spans, c) >= LIMITED_VOICE_SHARE && Math.abs(s - r.start) < dist) { dist = Math.abs(s - r.start); best = { start: round2(s), duration: r.duration }; }
  }
  return best;
}

// ── Textes ───────────────────────────────────────────────────────────────────

export function fmtTime(t: number): string {
  const s = Math.max(0, t);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** Nom de fichier propre. */
export function clipFileName(title: string, ext: string): string {
  const base = (title || 'mon son').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'mon son';
  return `${base} - clip paroles.${ext}`;
}

export function projectWords(tracks: Track[]): TimedWord[] {
  return projectTimedWords(tracks);
}

// ── Spectre (visualiseur) : FFT radix 2, calcul hors temps réel ────────────────

/** FFT en place (re, im), taille puissance de 2. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/**
 * Analyseur du son du clip, image par image (déterministe : le même pour l'aperçu
 * et l'export) : bandes en échelle log (0..1) et niveau RMS (0..1).
 */
export class ClipSpectrum {
  private re: Float32Array;
  private im: Float32Array;
  private win: Float32Array;
  private prev: Float32Array;
  private edges: number[];
  constructor(private mono: Float32Array, private sampleRate: number, public bands = 48, private size = 2048) {
    this.re = new Float32Array(size); this.im = new Float32Array(size);
    this.win = new Float32Array(size);
    for (let i = 0; i < size; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    this.prev = new Float32Array(bands);
    const fMin = 40, fMax = Math.min(16000, sampleRate / 2 - 1);
    this.edges = [];
    for (let b = 0; b <= bands; b++) this.edges.push(Math.max(1, Math.round((fMin * Math.pow(fMax / fMin, b / bands)) * size / sampleRate)));
  }

  static fromChannels(chs: Float32Array[], sampleRate: number, bands = 48): ClipSpectrum {
    const n = chs[0]?.length || 0;
    const mono = new Float32Array(n);
    for (const c of chs) for (let i = 0; i < n; i++) mono[i] += c[i] / chs.length;
    return new ClipSpectrum(mono, sampleRate, bands);
  }

  /** Bandes et niveau à l'instant t (s, depuis le début du clip). `smooth` : lissage avec l'image d'avant. */
  at(t: number, smooth = true): { bands: Float32Array; level: number } {
    const { size, re, im, win, mono } = this;
    const c = Math.round(t * this.sampleRate) - size / 2;
    let rms = 0;
    for (let i = 0; i < size; i++) {
      const s = c + i >= 0 && c + i < mono.length ? mono[c + i] : 0;
      rms += s * s;
      re[i] = s * win[i]; im[i] = 0;
    }
    fft(re, im);
    const out = new Float32Array(this.bands);
    for (let b = 0; b < this.bands; b++) {
      const k0 = this.edges[b], k1 = Math.max(k0 + 1, this.edges[b + 1]);
      let m = 0;
      for (let k = k0; k < k1 && k < size / 2; k++) m = Math.max(m, Math.hypot(re[k], im[k]));
      const db = 20 * Math.log10(m / (size / 4) + 1e-9);
      let v = Math.max(0, Math.min(1, (db + 60) / 54));
      if (smooth) v = v >= this.prev[b] ? v : this.prev[b] * 0.82 + v * 0.18;
      out[b] = v;
    }
    if (smooth) this.prev = out;
    const level = Math.max(0, Math.min(1, (20 * Math.log10(Math.sqrt(rms / size) + 1e-9) + 42) / 36));
    return { bands: out, level };
  }
}
