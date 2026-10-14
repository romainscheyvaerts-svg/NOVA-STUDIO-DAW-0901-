/**
 * Lot 2b · La caméra pendant la prise : calculs purs (testés par tests/videoTake.test.ts).
 *
 * Calage image ↔ son. Le moteur place chaque prise audio à la position du morceau que
 * l'artiste ENTENDAIT au moment où il chantait (latence de sortie + latence d'entrée
 * retirées, voir AudioEngine.stopCalibratedRecording). On fait pareil pour chaque image :
 *
 *   1. instant de capture de l'image (horloge `performance.now()`, en ms) ;
 *   2. → horloge du contexte audio : droite ajustée sur des paires (performance, contexte)
 *      relevées pendant la prise (getOutputTimestamp : temps du son qui SORT ; on rajoute
 *      `renderLead` pour revenir au temps de calcul du contexte, celui des échantillons) ;
 *   3. → temps entendu : moins `outputSide` (retard de sortie, le même que le moteur retire
 *      aux prises : baseLatency + outputLatency, ou la moitié sortie du pont ASIO) ;
 *   4. → temps du morceau : moins T0 (instant du contexte où le morceau est à 0 ; il change
 *      à chaque tour de boucle, d'où les segments) ;
 *   5. moins le décalage propre de la caméra (mesuré par le clap, ou réglé à la main).
 *
 * La pente de la droite absorbe la dérive entre l'horloge de la carte son et celle du PC
 * (0,01 % = 18 ms sur 3 minutes).
 */

import { LIMITED_MAX, LIMITED_VOICE_SHARE, voiceCoverage } from './lyricVideo';

export type VideoFormat = '9:16' | '16:9';

/** Taille de la vidéo gardée (et du MP4 exporté). */
export function formatSize(format: VideoFormat): { width: number; height: number } {
  return format === '9:16' ? { width: 720, height: 1280 } : { width: 1280, height: 720 };
}

/** Débit de la vidéo enregistrée pendant la prise (H.264). */
export const CAPTURE_BITRATE = 2_500_000;
export const CAPTURE_FPS = 30;
/** Octets par seconde de vidéo gardée (débit + conteneur et index, environ 3 %). */
export const BYTES_PER_SEC = Math.round((CAPTURE_BITRATE / 8) * 1.03);

// ─── Horloges ────────────────────────────────────────────────────────────────

/** Paire relevée au même instant : `p` = performance.now() (ms), `c` = horloge du contexte (s). */
export interface ClockPair { p: number; c: number }
/** c = a + b · (p / 1000). */
export interface ClockFit { a: number; b: number; n: number; residualMs: number }

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Droite des moindres carrés de l'horloge du contexte en fonction de performance.now().
 * Pente hors de [0,995 ; 1,005] (mesure impossible : quelques paires, ou paires bruitées) :
 * pente 1 et décalage médian.
 */
export function fitClock(pairs: ClockPair[]): ClockFit {
  const ok = pairs.filter(q => Number.isFinite(q.p) && Number.isFinite(q.c));
  if (!ok.length) return { a: 0, b: 1, n: 0, residualMs: 0 };
  const xs = ok.map(q => q.p / 1000), ys = ok.map(q => q.c);
  const resid = (a: number, b: number) => Math.max(...ok.map((q, i) => Math.abs(ys[i] - (a + b * xs[i])))) * 1000;
  const flat = () => { const a = median(ok.map((q, i) => ys[i] - xs[i])); return { a, b: 1, n: ok.length, residualMs: resid(a, 1) }; };
  if (ok.length < 3) return flat();
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  // Moins de 2 s de paires : la pente n'est pas fiable, on garde 1.
  if (sxx < 1 || xs[xs.length - 1] - xs[0] < 2) return flat();
  const b = sxy / sxx;
  if (!(b > 0.995 && b < 1.005)) return flat();
  const a = my - b * mx;
  return { a, b, n: ok.length, residualMs: resid(a, b) };
}

export const perfToCtx = (fit: ClockFit, pMs: number): number => fit.a + fit.b * (pMs / 1000);

/** Début du morceau sur l'horloge du contexte, à partir de l'instant `from` (temps entendu). */
export interface OriginSegment { from: number; t0: number }

/**
 * Segments d'origine du morceau relevés pendant la prise. Un tour de boucle = un nouveau
 * segment. Les relevés successifs avec la même origine (à 0,5 ms près) sont fusionnés.
 */
export function addOrigin(segs: OriginSegment[], from: number, t0: number): OriginSegment[] {
  if (!Number.isFinite(t0) || !Number.isFinite(from)) return segs;
  const last = segs[segs.length - 1];
  if (last && Math.abs(last.t0 - t0) < 0.0005) return segs;
  if (last && from < last.from) return segs;
  return [...segs, { from, t0 }];
}

/** Indice du segment valable à l'instant `h` (temps entendu, horloge du contexte). */
export function segmentAt(segs: OriginSegment[], h: number): number {
  let k = 0;
  for (let i = 0; i < segs.length; i++) if (segs[i].from <= h) k = i;
  return k;
}

export interface TakeSync {
  fit: ClockFit;
  /** Paires venues de getOutputTimestamp (temps du son qui sort) : on ajoute renderLead. */
  renderLead: number;
  /** Retard de sortie retiré aux prises audio par le moteur (s). */
  outputSide: number;
  segments: OriginSegment[];
  /** Décalage propre de la caméra (ms, positif = l'image arrive en retard) : clap ou réglage. */
  offsetMs: number;
}

/** Position dans le morceau (s) et tour de boucle d'une image capturée à `pMs`. */
export function frameTimeline(pMs: number, sync: TakeSync): { t: number; pass: number } {
  const render = perfToCtx(sync.fit, pMs) + sync.renderLead;
  const heard = render - sync.outputSide - sync.offsetMs / 1000;
  if (!sync.segments.length) return { t: heard, pass: 0 };
  const k = segmentAt(sync.segments, heard);
  return { t: heard - sync.segments[k].t0, pass: k };
}

/** Positions de toutes les images (s) et tour de boucle de chacune. */
export function frameTimelines(captures: number[], sync: TakeSync): { times: number[]; passes: number[] } {
  const times: number[] = [], passes: number[] = [];
  for (const p of captures) { const r = frameTimeline(p, sync); times.push(r.t); passes.push(r.pass); }
  return { times, passes };
}

/**
 * Horodatage des images de MediaStreamTrackProcessor (µs, horloge de capture de Chrome) vers
 * performance.now() (ms). La lecture d'une image arrive toujours APRÈS sa capture, donc
 * décalage ≥ max(ts/1000 − lecture). Avec les paires exactes de requestVideoFrameCallback
 * (captureTime, même image) on prend leur médiane.
 */
export function captureOffset(reads: { tsUs: number; readMs: number }[], exact: { tsUs: number; captureMs: number }[] = []): number | null {
  if (exact.length) return median(exact.map(e => e.tsUs / 1000 - e.captureMs));
  if (!reads.length) return null;
  return Math.max(...reads.map(r => r.tsUs / 1000 - r.readMs));
}

// ─── Clap / flash : mesure du décalage caméra ↔ son ─────────────────────────

/** Attaques franches dans une prise (s depuis le début du tampon). */
export function audioOnsets(x: Float32Array, sr: number, opts: { minGap?: number; rel?: number } = {}): number[] {
  const hop = Math.max(1, Math.round(sr * 0.002));
  const n = Math.floor(x.length / hop);
  if (!n) return [];
  const env = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = i * hop, e = j + hop; j < e; j++) { const v = Math.abs(x[j]); if (v > m) m = v; }
    env[i] = m; if (m > peak) peak = m;
  }
  if (peak < 0.02) return [];
  const thr = Math.max(0.02, peak * (opts.rel ?? 0.3));
  const minGap = Math.round((opts.minGap ?? 0.25) * sr / hop);
  const back = Math.round(0.05 * sr / hop);
  const out: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < n; i++) {
    if (env[i] < thr || env[i - 1] >= thr || i - last < minGap) continue;
    // Attaque = le niveau d'avant est bas (≤ 25 % du seuil sur les 50 ms d'avant).
    let quiet = 0;
    for (let k = Math.max(0, i - back); k < i - 1; k++) quiet = Math.max(quiet, env[k]);
    if (quiet > thr * 0.6) continue;
    // Échantillon exact : premier au-dessus de la moitié du seuil dans le bloc.
    let s = (i - 1) * hop;
    const e = (i + 1) * hop;
    while (s < e && Math.abs(x[s]) < thr * 0.5) s++;
    out.push(s / sr);
    last = i;
  }
  return out;
}

export interface FrameSignal { t: number; luma: number; motion: number }

/**
 * Événements visibles : un flash (la luminosité saute d'un coup) ou, à défaut, le pic de
 * mouvement d'un clap des mains. Rend les instants (s, temps du morceau) des images.
 */
export function visualEvents(frames: FrameSignal[], opts: { flash?: number; minGap?: number } = {}): { t: number; kind: 'flash' | 'mouvement' }[] {
  const flash = opts.flash ?? 30;
  const minGap = opts.minGap ?? 0.25;
  const out: { t: number; kind: 'flash' | 'mouvement' }[] = [];
  for (let k = 1; k < frames.length; k++) {
    const d = frames[k].luma - frames[k - 1].luma;
    if (d >= flash && (!out.length || frames[k].t - out[out.length - 1].t >= minGap)) out.push({ t: frames[k].t, kind: 'flash' });
  }
  if (out.length) return out;
  // Pas de flash : pics de mouvement nettement au-dessus du bruit (clap des mains).
  const ms = frames.map(f => f.motion);
  const noise = median(ms);
  const top = Math.max(0, ...ms);
  if (top < noise * 3 + 4) return [];
  const thr = noise + (top - noise) * 0.5;
  for (let k = 1; k < frames.length - 1; k++) {
    if (ms[k] >= thr && ms[k] >= ms[k - 1] && ms[k] > ms[k + 1] && (!out.length || frames[k].t - out[out.length - 1].t >= minGap)) out.push({ t: frames[k].t, kind: 'mouvement' });
  }
  return out;
}

export interface SyncMeasure { offsetMs: number; pairs: number; spreadMs: number; kind: 'flash' | 'mouvement' }

/**
 * Décalage image − son (ms) : chaque attaque du son est rapprochée de l'événement visible
 * le plus proche (à 400 ms près) ; on garde la médiane. Positif : l'image est en retard.
 */
export function measureSync(audio: number[], video: { t: number; kind: 'flash' | 'mouvement' }[], window = 0.4): SyncMeasure | null {
  const diffs: number[] = [];
  const kinds: string[] = [];
  for (const a of audio) {
    let best: { t: number; kind: string } | null = null;
    for (const v of video) if (Math.abs(v.t - a) <= window && (!best || Math.abs(v.t - a) < Math.abs(best.t - a))) best = v;
    if (best) { diffs.push((best.t - a) * 1000); kinds.push(best.kind); }
  }
  if (!diffs.length) return null;
  const m = median(diffs);
  return {
    offsetMs: Math.round(m * 10) / 10,
    pairs: diffs.length,
    spreadMs: Math.round((Math.max(...diffs) - Math.min(...diffs)) * 10) / 10,
    kind: kinds.includes('flash') ? 'flash' : 'mouvement',
  };
}

// ─── Export : choix des images ───────────────────────────────────────────────

export interface ExportFrame {
  /** Indice de l'image gardée, ou −1 (image noire : pas encore d'image filmée à cet instant). */
  src: number;
  /** Temps dans la vidéo exportée (s). */
  t: number;
}

/**
 * Images de l'export, à leur instant EXACT (fréquence variable, comme un téléphone) :
 * aucune image n'est déplacée sur une grille, donc aucun écart d'arrondi entre l'image
 * et le son. À t = 0 : la dernière image filmée avant le début (ou du noir).
 * `decodeFrom` : image clé d'où le décodage doit partir.
 */
export function planExportFrames(times: number[], keyframes: number[], range: { start: number; duration: number }, opts: { passes?: number[]; pass?: number } = {}): { frames: ExportFrame[]; decodeFrom: number; decodeTo: number } {
  const end = range.start + range.duration;
  const usable = (i: number) => opts.pass === undefined || !opts.passes || opts.passes[i] === opts.pass;
  const frames: ExportFrame[] = [];
  let before = -1;
  let first = -1, last = -1;
  for (let i = 0; i < times.length; i++) {
    if (!usable(i)) continue;
    const t = times[i];
    if (t <= range.start) { if (before < 0 || t >= times[before]) before = i; continue; }
    if (t >= end) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (before >= 0) { frames.push({ src: before, t: 0 }); if (first < 0) { first = before; last = before; } else first = Math.min(first, before); }
  else frames.push({ src: -1, t: 0 });
  if (first >= 0) {
    for (let i = first; i <= last; i++) {
      if (!usable(i) || i === before) continue;
      const t = times[i] - range.start;
      if (t <= 0 || t >= range.duration) continue;
      // Horodatages strictement croissants (au moins 1 ms d'écart).
      if (t - frames[frames.length - 1].t < 0.001) continue;
      frames.push({ src: i, t });
    }
  }
  const needFirst = frames.find(f => f.src >= 0)?.src ?? -1;
  let decodeFrom = -1;
  if (needFirst >= 0) for (const k of keyframes) if (k <= needFirst && k > decodeFrom) decodeFrom = k;
  if (needFirst >= 0 && decodeFrom < 0) decodeFrom = 0;
  const decodeTo = frames.reduce((m, f) => Math.max(m, f.src), -1);
  return { frames, decodeFrom, decodeTo };
}

/** Durée de chaque image exportée (jusqu'à la suivante, la dernière jusqu'à la fin). */
export function frameDurations(frames: ExportFrame[], duration: number): number[] {
  return frames.map((f, i) => Math.max(0.001, (i + 1 < frames.length ? frames[i + 1].t : duration) - f.t));
}

/** Plage filmée d'une prise (dans un tour donné). */
export function filmedSpan(times: number[], passes?: number[], pass?: number): { start: number; end: number } | null {
  let s = Infinity, e = -Infinity;
  for (let i = 0; i < times.length; i++) {
    if (pass !== undefined && passes && passes[i] !== pass) continue;
    if (times[i] < s) s = times[i];
    if (times[i] > e) e = times[i];
  }
  return Number.isFinite(s) && e > s ? { start: s, end: e } : null;
}

/** Tours de boucle présents dans la prise, avec leur nombre d'images (le dernier complet par défaut). */
export function passList(passes: number[]): { pass: number; frames: number }[] {
  const m = new Map<number, number>();
  for (const p of passes) m.set(p, (m.get(p) || 0) + 1);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([pass, frames]) => ({ pass, frames }));
}

/** Tour proposé : le dernier tour presque complet (≥ 80 % des images du plus long). */
export function defaultPass(passes: number[]): number {
  const l = passList(passes);
  if (!l.length) return 0;
  const most = Math.max(...l.map(x => x.frames));
  const full = l.filter(x => x.frames >= most * 0.8);
  return full[full.length - 1].pass;
}

// ─── Cadrage ─────────────────────────────────────────────────────────────────

/** Rectangle de la source à garder pour remplir w × h sans déformer (recadrage au centre). */
export function coverCrop(sw: number, sh: number, w: number, h: number): { sx: number; sy: number; sw: number; sh: number } {
  if (!sw || !sh) return { sx: 0, sy: 0, sw, sh };
  const want = w / h, have = sw / sh;
  if (have > want) { const cw = sh * want; return { sx: (sw - cw) / 2, sy: 0, sw: cw, sh }; }
  const ch = sw / want;
  return { sx: 0, sy: (sh - ch) / 2, sw, sh: ch };
}

// ─── Stockage ────────────────────────────────────────────────────────────────

/** En dessous : on ne lance pas la caméra (moins de 3 minutes de vidéo). */
export const STORAGE_FULL_BYTES = 60 * 1024 * 1024;
/** En dessous : avertissement (moins de 15 minutes environ). */
export const STORAGE_LOW_BYTES = 300 * 1024 * 1024;
/** Pendant une prise : la vidéo s'arrête (le son continue) sous cette marge. */
export const STORAGE_STOP_BYTES = 25 * 1024 * 1024;

export interface StorageAdvice { level: 'ok' | 'low' | 'full' | 'unknown'; freeBytes: number | null; minutes: number | null }

export function storageAdvice(est: { usage?: number; quota?: number } | null): StorageAdvice {
  if (!est || !est.quota) return { level: 'unknown', freeBytes: null, minutes: null };
  const free = Math.max(0, est.quota - (est.usage || 0));
  const minutes = Math.floor(free / BYTES_PER_SEC / 60);
  return { level: free < STORAGE_FULL_BYTES ? 'full' : free < STORAGE_LOW_BYTES ? 'low' : 'ok', freeBytes: free, minutes };
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} Go`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} Mo`;
  return `${Math.max(1, Math.round(n / 1024))} ko`;
}

export function fmtMinutes(min: number): string {
  if (min >= 120) return `${Math.floor(min / 60)} h`;
  if (min >= 60) return `1 h ${String(min - 60).padStart(2, '0')}`;
  return `${min} min`;
}

/** Clé de la caméra pour garder son décalage mesuré (son nom, sinon son identifiant). */
export const cameraKey = (label: string | undefined, deviceId: string | undefined): string => (label || deviceId || 'camera').trim().toLowerCase();

// ─── Droits (mêmes règles que le clip et l'export : utils/lyricVideo · clipRights) ───

/**
 * Passage permis pour la vidéo de la performance ? null : oui ; sinon le message.
 * Droits complets : toute la prise. Sinon comme l'extrait : 30 s au plus, sur la voix.
 * Pas de minimum de 5 s (une prise courte reste exportable), 1 s au moins.
 */
export function performanceProblem(r: { start: number; duration: number }, rights: { full: boolean; needsVoice: boolean }, spans: { start: number; duration: number }[]): string | null {
  if (r.duration < 1) return 'Vidéo trop courte : 1 s au moins.';
  if (!rights.full && r.duration > LIMITED_MAX + 0.01) return `${LIMITED_MAX} s au plus sans licence (comme l'extrait à partager).`;
  if (rights.needsVoice && voiceCoverage(spans, r) < LIMITED_VOICE_SHARE) return 'Sans licence, la vidéo montre ta voix : choisis un passage où tu chantes (au moins la moitié).';
  return null;
}
