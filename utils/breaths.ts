import type { BreathEdit, Clip, Track } from '../types';
import { BREATH_REMOVE_DB, DEFAULT_BREATH_FADE } from './breathEnvelope';
import { getVocalRole, isVoiceTrack } from './vocalRoles';

/**
 * Respirations d'une prise de voix : détection et traitement (comme Breath
 * Control de Waves ou De-breath de RX), en local, sans dépendance.
 *
 * Détection (analyse par trames de 10 ms) :
 *  - niveau : une respiration est nettement sous le niveau des mots autour
 *    (référence = crête lissée des mots sur ±1 s) et au-dessus du bruit de fond ;
 *  - souffle : pas de hauteur (périodicité NSDF faible), spectre plat, centre
 *    de gravité entre ~0,9 et 4,5 kHz (un « s » ou un « ch » est plus aigu,
 *    plus fort et collé au mot ; une queue de mot ou de réverb est grave) ;
 *  - durée 80 à 900 ms, souvent entre deux phrases ;
 *  - sécurité : marges après la fin d'un mot (plus grandes après une
 *    sifflante) et avant l'attaque du suivant, la décroissance d'une fin de
 *    mot n'est jamais prise, et toute zone douteuse est laissée telle quelle.
 *    Mieux vaut rater une respiration que toucher un mot.
 *
 * Traitement : non destructif, par gain de clip (Clip.breaths, en secondes de
 * l'audio source), avec des fondus en cosinus DANS la zone (utils/breathEnvelope).
 * Réappliquer remplace les zones du clip : les baisses ne se cumulent jamais.
 */

export type BreathSensitivity = 'prudente' | 'normale' | 'forte';
export const BREATH_SENSITIVITIES: { id: BreathSensitivity; label: string; hint: string }[] = [
  { id: 'prudente', label: 'Prudente', hint: 'Ne prend que les respirations évidentes : zéro risque pour les mots.' },
  { id: 'normale', label: 'Normale', hint: 'Le bon réglage pour la plupart des prises.' },
  { id: 'forte', label: 'Forte', hint: 'Prend aussi les petites respirations proches des mots. Vérifie à l’écoute.' },
];

interface Params {
  /** Écart minimal sous le niveau des mots (dB). */
  gapDb: number;
  /** Au-dessus de cette périodicité (0..1), la trame chante : protégée. */
  voicedNsdf: number;
  /** Périodicité moyenne maximale d'une respiration. */
  maxNsdf: number;
  /** Centre de gravité spectral moyen (Hz). */
  minCentroid: number;
  maxCentroid: number;
  /** Part d'énergie au-dessus de 4,5 kHz (« s », « ch »). */
  maxHf: number;
  /** Platitude spectrale moyenne minimale (souffle = bruit). */
  minFlat: number;
  /** Marges (s) après un mot, après une sifflante, avant l'attaque suivante. */
  guardAfter: number;
  guardAfterSibilant: number;
  guardBefore: number;
  minDur: number;
  maxDur: number;
  /** Au-dessus du bruit de fond (dB) : sinon c'est un blanc, pas un souffle. */
  aboveNoiseDb: number;
  /**
   * Une trame périodique n'est un mot que si elle est à moins de `quietDb` des
   * mots ou si son spectre est tonal (platitude < `voicedFlat`). Plus bas et
   * bruité, c'est un souffle par-dessus un résidu (réverb, basse qui bave
   * dans un stem séparé), pas un mot.
   */
  quietDb: number;
  voicedFlat: number;
}

const PARAMS: Record<BreathSensitivity, Params> = {
  prudente: { gapDb: 13, voicedNsdf: 0.6, maxNsdf: 0.42, minCentroid: 1000, maxCentroid: 4200, maxHf: 0.42, minFlat: 0.08, guardAfter: 0.08, guardAfterSibilant: 0.12, guardBefore: 0.045, minDur: 0.1, maxDur: 0.9, aboveNoiseDb: 6, quietDb: 24, voicedFlat: 0.045 },
  normale: { gapDb: 10, voicedNsdf: 0.65, maxNsdf: 0.5, minCentroid: 850, maxCentroid: 4500, maxHf: 0.48, minFlat: 0.07, guardAfter: 0.07, guardAfterSibilant: 0.1, guardBefore: 0.04, minDur: 0.09, maxDur: 0.9, aboveNoiseDb: 5, quietDb: 20, voicedFlat: 0.05 },
  forte: { gapDb: 7, voicedNsdf: 0.7, maxNsdf: 0.58, minCentroid: 700, maxCentroid: 4800, maxHf: 0.55, minFlat: 0.05, guardAfter: 0.05, guardAfterSibilant: 0.08, guardBefore: 0.03, minDur: 0.08, maxDur: 0.9, aboveNoiseDb: 4, quietDb: 16, voicedFlat: 0.055 },
};

export interface BreathRegion {
  /** Début / fin (s) dans le repère demandé (audio source pour detectBreaths). */
  start: number;
  end: number;
  /** Crête de la respiration et niveau des mots autour (dBFS). */
  peakDb: number;
  wordDb: number;
  centroid: number;
  nsdf: number;
}

export type BreathRejectReason = 'sifflante' | 'voisee' | 'grave' | 'trop-courte' | 'trop-longue' | 'tonale';
export interface BreathAnalysis {
  regions: BreathRegion[];
  /** Zones écartées (diagnostic, tests) avec la raison. */
  rejected: { start: number; end: number; reason: BreathRejectReason }[];
  /** Mesures par trame (seulement avec `debug`). */
  frames?: { t: number; db: number; ref: number; kind: number; centroid: number; hf: number; flat: number; nsdf: number }[];
}

export interface BreathDetectOptions {
  sensitivity?: BreathSensitivity;
  /** Diagnostic : renvoie aussi les mesures par trame. */
  debug?: boolean;
}

const HOP = 0.01;
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));

// ------------------------------------------------------------------ FFT (radix 2)

const fftCache = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array; hann: Float64Array }>();
function fftTables(n: number) {
  let t = fftCache.get(n);
  if (t) return t;
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), rev = new Uint32Array(n), hann = new Float64Array(n);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  t = { cos, sin, rev, hann };
  fftCache.set(n, t);
  return t;
}

/** Spectre de puissance d'une trame (fenêtre de Hann), bins 0..n/2. */
function powerSpectrum(x: Float32Array, at: number, n: number, out: Float64Array, re: Float64Array, im: Float64Array) {
  const { cos, sin, rev, hann } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const k = at + i;
    re[rev[i]] = (k >= 0 && k < x.length ? x[k] : 0) * hann[i];
    im[rev[i]] = 0;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < half; j++) {
        const a = i + j, b = a + half, w = j * step;
        const tr = re[b] * cos[w] - im[b] * sin[w];
        const ti = re[b] * sin[w] + im[b] * cos[w];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
}

// ------------------------------------------------------------------ détection

/** Filtre de Butterworth du 2e ordre (biquad), passe-bas ou passe-haut. */
function biquad(x: Float32Array, sr: number, fc: number, high = false): Float32Array {
  const w = Math.tan((Math.PI * fc) / sr), q = Math.SQRT1_2;
  const n = 1 / (1 + w / q + w * w);
  const b0 = high ? n : w * w * n, b1 = high ? -2 * n : 2 * w * w * n, b2 = b0;
  const a1 = 2 * (w * w - 1) * n, a2 = (1 - w / q + w * w) * n;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Mono (moyenne des canaux) d'un buffer, sur [from, to] (s). */
export function monoSlice(buffer: Pick<AudioBuffer, 'numberOfChannels' | 'sampleRate' | 'length' | 'getChannelData'>, from = 0, to?: number): Float32Array {
  const sr = buffer.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(buffer.length, Math.ceil((to ?? buffer.length / sr) * sr));
  const out = new Float32Array(Math.max(0, b - a));
  const nc = Math.max(1, buffer.numberOfChannels);
  for (let c = 0; c < nc; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[a + i] / nc;
  }
  return out;
}

/**
 * Respirations d'un signal mono. Les temps sont en secondes depuis le début
 * de `x` (ajoute ton propre décalage).
 */
export function analyzeBreaths(x: Float32Array, sr: number, options: BreathDetectOptions = {}): BreathAnalysis {
  const P = PARAMS[options.sensitivity || 'normale'];
  const hop = Math.max(1, Math.round(HOP * sr));
  const win = Math.round(0.02 * sr);
  const nFrames = Math.floor(Math.max(0, x.length - win) / hop) + 1;
  const empty: BreathAnalysis = { regions: [], rejected: [] };
  if (x.length < win * 4 || nFrames < 10) return empty;

  // 1. Niveau par trame (fenêtre 20 ms, pas 10 ms) ; temps = centre de la fenêtre.
  const rms = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let s = 0;
    const a = f * hop;
    for (let i = a; i < a + win; i++) s += x[i] * x[i];
    rms[f] = db(Math.sqrt(s / win));
  }
  const tOf = (f: number) => (f * hop + win / 2) / sr;

  const sorted = Array.from(rms).sort((a, b) => a - b);
  const noise = Math.max(-96, sorted[Math.floor(sorted.length * 0.05)]);
  const loud = sorted.filter(v => v > noise + 15);
  if (loud.length < 5) return empty;
  const speech = loud[Math.floor(loud.length * 0.8)];

  // 2. Niveau des mots autour : crête du niveau lissé (50 ms) sur ±1 s, jamais
  //    sous le niveau de la voix − 10 dB (une respiration seule dans un long blanc
  //    reste comparée à la voix).
  const smooth = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, f - 2); k <= Math.min(nFrames - 1, f + 2); k++) { s += Math.pow(10, rms[k] / 10); n++; }
    smooth[f] = 10 * Math.log10(s / n);
  }
  const R = Math.round(1 / HOP);
  const wordRef = new Float64Array(nFrames);
  // Max glissant (deque) sur ±R trames.
  const dq: number[] = [];
  let head = 0;
  for (let f = 0, k = 0; f < nFrames; f++) {
    for (; k < nFrames && k <= f + R; k++) {
      while (dq.length > head && smooth[dq[dq.length - 1]] <= smooth[k]) dq.pop();
      dq.push(k);
    }
    while (dq[head] < f - R) head++;
    wordRef[f] = Math.max(smooth[dq[head]], speech - 10);
  }

  // 3. Trames candidates (assez basses, assez au-dessus du bruit) : leurs
  //    caractéristiques de souffle. Les autres trames non silencieuses = mots.
  type Kind = 0 | 1 | 2 | 3 | 4; // 0 silence, 1 mot (fort ou chanté), 2 sifflante, 3 souffle, 4 autre (douteux)
  const kind = new Uint8Array(nFrames);
  const centroid = new Float64Array(nFrames), hf = new Float64Array(nFrames), flat = new Float64Array(nFrames), nsdf = new Float64Array(nFrames);
  const N = sr > 30000 ? 1024 : 512;
  const spec = new Float64Array(N / 2 + 1), re = new Float64Array(N), im = new Float64Array(N);
  const binHz = sr / N;
  const k150 = Math.ceil(150 / binHz), k300 = Math.ceil(300 / binHz), k4500 = Math.ceil(4500 / binHz), k8000 = Math.min(N / 2, Math.floor(8000 / binHz));
  // Périodicité (NSDF de McLeod) dans la bande 300–1500 Hz : là où sont les
  // harmoniques d'une voix ; un souffle y est sans hauteur, et la basse / 808
  // qui bave dans un stem voix séparé reste dessous. Décimé vers ~4,4 kHz,
  // fenêtre 40 ms, fondamentale 70–500 Hz.
  const lp = biquad(biquad(biquad(biquad(x, sr, 1500), sr, 1500), sr, 300, true), sr, 300, true);
  const dec = Math.max(1, Math.floor(sr / 4410));
  const ds = new Float32Array(Math.floor(x.length / dec));
  for (let i = 0; i < ds.length; i++) ds[i] = lp[i * dec];
  const dsr = sr / dec;
  const W = Math.round(0.04 * dsr), tauMin = Math.max(2, Math.floor(dsr / 500)), tauMax = Math.ceil(dsr / 70);

  for (let f = 0; f < nFrames; f++) {
    if (rms[f] < noise + P.aboveNoiseDb || rms[f] < -80) { kind[f] = 0; continue; }
    if (rms[f] > wordRef[f] - P.gapDb) { kind[f] = 1; continue; }
    const c = f * hop + win / 2;
    powerSpectrum(x, Math.round(c - N / 2), N, spec, re, im);
    let tot = 0, hi = 0, cen = 0, lg = 0, ar = 0, nb = 0;
    for (let k = k150; k <= N / 2; k++) { tot += spec[k]; cen += spec[k] * k * binHz; if (k >= k4500) hi += spec[k]; }
    for (let k = k300; k <= k8000; k++) { lg += Math.log(spec[k] + 1e-20); ar += spec[k]; nb++; }
    centroid[f] = tot > 0 ? cen / tot : 0;
    hf[f] = tot > 0 ? hi / tot : 0;
    flat[f] = nb && ar > 0 ? Math.exp(lg / nb) / (ar / nb) : 0;
    // NSDF : premier grand pic après le premier passage par zéro (McLeod).
    const a0 = Math.round(c / dec - W / 2);
    let best = 0;
    if (a0 >= 0 && a0 + W + tauMax < ds.length) {
      let crossed = false;
      for (let tau = 1; tau <= tauMax; tau++) {
        let r = 0, m = 0;
        for (let j = a0; j < a0 + W; j++) { const u = ds[j], v = ds[j + tau]; r += u * v; m += u * u + v * v; }
        const n = m > 0 ? (2 * r) / m : 0;
        if (!crossed) { if (n < 0) crossed = true; continue; }
        if (tau >= tauMin && n > best) best = n;
      }
    }
    nsdf[f] = best;
    const pitched = best >= P.voicedNsdf && (rms[f] > wordRef[f] - P.quietDb || flat[f] < P.voicedFlat);
    if (pitched) kind[f] = 1;
    else if (hf[f] > P.maxHf && centroid[f] > 4000) kind[f] = 2;
    else if (flat[f] >= P.minFlat * 0.8 && centroid[f] >= P.minCentroid * 0.8 && centroid[f] <= P.maxCentroid * 1.1) kind[f] = 3;
    else kind[f] = 4;
  }

  // Un mot fort qui précède une zone : est-ce une sifflante (« s » final) ?
  // Calculé seulement là où ça compte (marge plus grande après un « s »).
  const sibMemo = new Map<number, boolean>();
  const loudSibilant = (f: number): boolean => {
    if (kind[f] === 2) return true;
    let v = sibMemo.get(f);
    if (v === undefined) {
      powerSpectrum(x, Math.round(f * hop + win / 2 - N / 2), N, spec, re, im);
      let tot = 0, hi = 0;
      for (let k = k150; k <= N / 2; k++) { tot += spec[k]; if (k >= k4500) hi += spec[k]; }
      v = tot > 0 && hi / tot > 0.5;
      sibMemo.set(f, v);
    }
    return v;
  };

  // 4. Zones : suites de trames « souffle », trous de ≤ 40 ms (silence / douteux) tolérés.
  const regions: BreathRegion[] = [];
  const rejected: BreathAnalysis['rejected'] = [];
  const isProtected = (k: number) => kind[k] === 1 || kind[k] === 2;
  let f = 0;
  while (f < nFrames) {
    if (kind[f] !== 3) { f++; continue; }
    let a = f, b = f, gap = 0;
    let g = f + 1;
    while (g < nFrames) {
      if (kind[g] === 3) { b = g; gap = 0; }
      else if (isProtected(g)) break;
      else if (++gap > 4) break;
      g++;
    }
    f = b + 1;
    // Mot / sifflante protégés de part et d'autre.
    let p = a - 1; while (p >= 0 && !isProtected(p)) p--;
    let q = b + 1; while (q < nFrames && !isProtected(q)) q++;
    // Fin de mot qui s'éteint : on saute la décroissance qui suit le mot.
    if (p >= 0 && a - p <= 4) {
      while (a < b && rms[a + 1] < rms[a] - 0.5) a++;
    }
    let start = tOf(a) - HOP / 2;
    let end = tOf(b) + HOP / 2;
    if (p >= 0) start = Math.max(start, tOf(p) + win / sr / 2 + (loudSibilant(p) ? P.guardAfterSibilant : P.guardAfter));
    if (q < nFrames) end = Math.min(end, tOf(q) - win / sr / 2 - P.guardBefore);
    const dur = end - start;
    if (dur < P.minDur) { rejected.push({ start: tOf(a), end: tOf(b), reason: 'trop-courte' }); continue; }
    if (dur > P.maxDur) { rejected.push({ start, end, reason: 'trop-longue' }); continue; }
    // Statistiques de la zone (trames entièrement dedans).
    let n = 0, sc = 0, sh = 0, sf = 0, sn = 0, pk = -200, wr = -200;
    for (let k = 0; k < nFrames; k++) {
      const t = tOf(k);
      if (t < start || t > end || kind[k] !== 3 && kind[k] !== 4) continue;
      n++; sc += centroid[k]; sh += hf[k]; sf += flat[k]; sn += nsdf[k];
      pk = Math.max(pk, rms[k]); wr = Math.max(wr, wordRef[k]);
    }
    if (!n) { rejected.push({ start, end, reason: 'trop-courte' }); continue; }
    const mc = sc / n, mh = sh / n, mf = sf / n, mn = sn / n;
    const adjacent = (p >= 0 && start - tOf(p) < 0.15) || (q < nFrames && tOf(q) - end < 0.15);
    let reason: BreathRejectReason | null = null;
    if (mn > P.maxNsdf && wr - pk < P.quietDb) reason = 'voisee';
    else if (mh > P.maxHf || mc > P.maxCentroid || (adjacent && mc > 3800 && dur < 0.25)) reason = 'sifflante';
    else if (mc < P.minCentroid) reason = 'grave';
    else if (mf < P.minFlat) reason = 'tonale';
    if (reason) { rejected.push({ start, end, reason }); continue; }
    // Presque inaudible (sous -65 dBFS) : rien à gagner à y toucher.
    if (pk < -65) continue;
    regions.push({ start, end, peakDb: pk, wordDb: wr, centroid: mc, nsdf: mn });
  }
  const out: BreathAnalysis = { regions, rejected };
  if (options.debug) out.frames = Array.from({ length: nFrames }, (_, k) => ({ t: tOf(k), db: rms[k], ref: wordRef[k], kind: kind[k], centroid: centroid[k], hf: hf[k], flat: flat[k], nsdf: nsdf[k] }));
  return out;
}

/** Respirations d'un buffer sur [from, to] (s) ; temps en secondes de l'audio source. */
export function detectBreaths(
  buffer: Pick<AudioBuffer, 'numberOfChannels' | 'sampleRate' | 'length' | 'getChannelData'>,
  from = 0,
  to = buffer.length / buffer.sampleRate,
  options: BreathDetectOptions = {},
): BreathRegion[] {
  // Un peu de contexte de chaque côté (niveau des mots, marges), puis on
  // ne garde que les zones entièrement dans [from, to].
  const ctxSec = 1;
  const a = Math.max(0, from - ctxSec);
  const b = Math.min(buffer.length / buffer.sampleRate, to + ctxSec);
  const x = monoSlice(buffer, a, b);
  return analyzeBreaths(x, buffer.sampleRate, options).regions
    .map(r => ({ ...r, start: r.start + a, end: r.end + a }))
    .filter(r => r.start >= from - 1e-6 && r.end <= to + 1e-6);
}

// ------------------------------------------------------------------ traitement

/** Type de voix pour les respirations : la lead est baissée, les autres supprimées. */
export type BreathKind = 'lead' | 'extra' | 'skip';

export const BREATH_KIND_LABELS: Record<BreathKind, string> = {
  lead: 'Voix principale',
  extra: 'Voix additionnelle',
  skip: 'Ne pas toucher',
};

/**
 * Devine le type d'une piste : par son nom (LEAD, VOIX → principale ; BACK,
 * DOUBLE, ADLIB, HARMO, CHOEUR, BV… → additionnelle), puis par son rôle.
 * Une piste qui n'est pas une voix n'est jamais touchée. Le choix fait à la
 * main (Track.breathKind) gagne toujours.
 */
export function guessBreathKind(t: Pick<Track, 'id' | 'name' | 'type' | 'instrumentId'> & { breathKind?: BreathKind }): BreathKind {
  if (t.breathKind) return t.breathKind;
  if (!isVoiceTrack(t as Track)) return 'skip';
  const n = (t.name || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/\b(BACKS?|BCK|BV|BGV|DOUBLES?|DBL|TRIPLE|OCT\w*|HARMO\w*|CHOEURS?|CHŒURS?|CHORUS VOX|ADD?\b|AD.?LIBS?|ADLIBS?|STACK|LAYER|UNISSON|TIERCE|QUINTE|ECHO)/.test(n)) return 'extra';
  if (/\b(LEAD|LD|MAIN|VOIX|VOCALS?|VOX|VOC|CHANT|COUPLET|REFRAIN|REC)\b/.test(n)) return 'lead';
  const role = getVocalRole(t as Track);
  if (role === 'back' || role === 'harmony' || role === 'adlib') return 'extra';
  return role === 'lead' ? 'lead' : 'skip';
}

export interface BreathSettings {
  /** Baisse de la voix principale (dB, 0 à 40) ; `leadRemove` = supprimer. */
  leadDb: number;
  leadRemove: boolean;
  /** Voix additionnelles : supprimer (par défaut) ou baisser de `extraDb`. */
  extraRemove: boolean;
  extraDb: number;
  sensitivity: BreathSensitivity;
  /** Fondus (ms), 5 à 15. */
  fadeMs: number;
}

export const DEFAULT_BREATH_SETTINGS: BreathSettings = {
  leadDb: 15, leadRemove: false, extraRemove: true, extraDb: 25, sensitivity: 'normale', fadeMs: 10,
};

/** Gain (dB) appliqué selon le type de piste. */
export function breathGainFor(kind: BreathKind, s: BreathSettings): number | null {
  if (kind === 'skip') return null;
  if (kind === 'lead') return s.leadRemove ? BREATH_REMOVE_DB * 1.2 : -Math.max(0, Math.min(40, s.leadDb));
  return s.extraRemove ? BREATH_REMOVE_DB * 1.2 : -Math.max(0, Math.min(40, s.extraDb));
}

export const breathDoseLabel = (gainDb: number | null): string =>
  gainDb == null ? 'non traitée' : gainDb <= BREATH_REMOVE_DB ? 'supprimées' : gainDb === 0 ? 'intactes (0 dB)' : `${Math.round(gainDb)} dB`.replace('-', '−');

/** Zones → réglages enregistrés dans le clip. */
export function breathEditsFor(regions: Pick<BreathRegion, 'start' | 'end'>[], gainDb: number, fadeMs = DEFAULT_BREATH_FADE * 1000): BreathEdit[] {
  const fade = Math.max(0.005, Math.min(0.015, fadeMs / 1000));
  return regions
    .filter(r => r.end - r.start > 3 * 0.005)
    .map(r => ({ start: round5(r.start), end: round5(r.end), gainDb, fade }));
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

/**
 * Remplace les respirations du clip DANS sa fenêtre (offset → offset + durée)
 * par `edits` : réappliquer avec d'autres réglages ne cumule jamais les baisses.
 * Les zones hors de la fenêtre (audio caché par une découpe) sont gardées.
 */
export function withBreaths<T extends Pick<Clip, 'offset' | 'duration' | 'breaths'>>(clip: T, edits: BreathEdit[]): T {
  const a = clip.offset || 0, b = a + clip.duration;
  const outside = (clip.breaths || []).filter(e => e.end <= a || e.start >= b);
  const inside = edits.filter(e => e.end > a && e.start < b);
  const all = [...outside, ...inside].sort((p, q) => p.start - q.start);
  const next = { ...clip } as T;
  if (all.length) next.breaths = all; else delete next.breaths;
  return next;
}

/** Le clip peut-il être traité ? (audio, pas inversé ni étiré) */
export const canTreatBreaths = (c: Clip): boolean =>
  c.type !== 'MIDI' && !c.isReversed && !c.warp?.enabled && !c.isFreezeSlice && !!(c.bufferId || c.buffer);

// ------------------------------------------------------------------ plan pour une session

export interface BreathClipPlan {
  clipId: string;
  regions: BreathRegion[];
  edits: BreathEdit[];
}

export interface BreathTrackPlan {
  trackId: string;
  name: string;
  kind: BreathKind;
  gainDb: number | null;
  count: number;
  clips: BreathClipPlan[];
}

type BufferOf = (c: Clip) => Pick<AudioBuffer, 'numberOfChannels' | 'sampleRate' | 'length' | 'getChannelData'> | undefined;

/** Cache des détections : même audio, même fenêtre, même sensibilité → même résultat. */
const detectCache = new Map<string, BreathRegion[]>();
export const clearBreathCache = () => detectCache.clear();

export function detectClipBreaths(c: Clip, buf: NonNullable<ReturnType<BufferOf>>, sensitivity: BreathSensitivity): BreathRegion[] {
  const from = c.offset || 0;
  const to = Math.min(buf.length / buf.sampleRate, from + c.duration);
  const key = `${c.bufferId || c.id}|${buf.length}|${from.toFixed(4)}|${to.toFixed(4)}|${sensitivity}`;
  let r = detectCache.get(key);
  if (!r) {
    r = detectBreaths(buf, from, to, { sensitivity });
    if (detectCache.size > 400) detectCache.clear();
    detectCache.set(key, r);
  }
  return r;
}

export interface BreathScope {
  /** Pistes visées (toutes les voix si absent). */
  trackIds?: string[];
  /** Clips visés (tous les clips des pistes si absent). */
  clipIds?: string[];
  /** Types choisis dans la fenêtre (sinon devinés). */
  kinds?: Record<string, BreathKind>;
  /** Zones exclues / ajoutées à la main (secondes source) par clip. */
  excluded?: Record<string, { start: number; end: number }[]>;
  added?: Record<string, { start: number; end: number }[]>;
}

/** Ce que ferait le traitement, piste par piste (rien n'est modifié). */
export function planBreaths(tracks: Track[], bufferOf: BufferOf, s: BreathSettings, scope: BreathScope = {}): BreathTrackPlan[] {
  const out: BreathTrackPlan[] = [];
  for (const t of tracks) {
    if (scope.trackIds && !scope.trackIds.includes(t.id)) continue;
    if (!isVoiceTrack(t)) continue;
    const kind = scope.kinds?.[t.id] ?? guessBreathKind(t);
    const gainDb = breathGainFor(kind, s);
    const plan: BreathTrackPlan = { trackId: t.id, name: t.name, kind, gainDb, count: 0, clips: [] };
    for (const c of t.clips) {
      if (scope.clipIds && !scope.clipIds.includes(c.id)) continue;
      if (c.isMuted && !scope.clipIds) continue;
      if (!canTreatBreaths(c)) continue;
      const buf = bufferOf(c);
      if (!buf) continue;
      const ex = scope.excluded?.[c.id] || [];
      const add = (scope.added?.[c.id] || []).map(r => ({ start: r.start, end: r.end, peakDb: 0, wordDb: 0, centroid: 0, nsdf: 0 }));
      const regions = [...detectClipBreaths(c, buf, s.sensitivity).filter(r => !ex.some(e => e.start < r.end && e.end > r.start)), ...add]
        .sort((p, q) => p.start - q.start);
      const edits = gainDb == null ? [] : breathEditsFor(regions, gainDb, s.fadeMs);
      plan.clips.push({ clipId: c.id, regions, edits });
      if (gainDb != null) plan.count += regions.length;
    }
    out.push(plan);
  }
  return out;
}

/**
 * Applique un plan aux pistes (à appeler dans UN seul setState : une seule
 * étape d'annulation). Une piste « Ne pas toucher » retrouve ses respirations
 * d'origine. Renvoie les pistes modifiées (immuable).
 */
export function applyBreathPlan(tracks: Track[], plans: BreathTrackPlan[]): Track[] {
  const byTrack = new Map(plans.map(p => [p.trackId, p]));
  return tracks.map(t => {
    const p = byTrack.get(t.id);
    if (!p) return t;
    // Par audio source (bufferId) : fenêtres traitées et leurs nouvelles zones.
    // Tous les clips de la piste qui partagent cet audio (morceaux d'une même
    // prise, tours de Loop Record, segments du comp) reçoivent la même liste :
    // un comp reconstruit plus tard depuis n'importe quel morceau la garde.
    const srcKey = (c: Clip) => c.bufferId || c.id;
    const bySrc = new Map<string, { windows: [number, number][]; edits: BreathEdit[] }>();
    for (const cp of p.clips) {
      const c = t.clips.find(x => x.id === cp.clipId);
      if (!c) continue;
      const k = srcKey(c);
      const e = bySrc.get(k) || { windows: [], edits: [] };
      const a = c.offset || 0;
      e.windows.push([a, a + c.duration]);
      e.edits.push(...cp.edits.filter(x => x.end > a && x.start < a + c.duration));
      bySrc.set(k, e);
    }
    let changed = false;
    const clips = t.clips.map(c => {
      const e = bySrc.get(srcKey(c));
      if (!e || !canTreatBreaths(c)) return c;
      const inWin = (x: BreathEdit) => e.windows.some(([a, b]) => x.end > a && x.start < b);
      const kept = (c.breaths || []).filter(x => !inWin(x));
      const uniq = new Map<string, BreathEdit>();
      for (const x of [...kept, ...e.edits]) uniq.set(`${x.start}|${x.end}`, x);
      const all = Array.from(uniq.values()).sort((u, v) => u.start - v.start);
      if (JSON.stringify(all) === JSON.stringify(c.breaths || [])) return c;
      changed = true;
      const next = { ...c };
      if (all.length) next.breaths = all; else delete next.breaths;
      return next;
    });
    return changed ? { ...t, clips } : t;
  });
}

/** Récapitulatif lisible : « LEAD : 23 respirations −15 dB ; BACK 1 : 18 supprimées ». */
export function summarizeBreathPlan(plans: BreathTrackPlan[]): string {
  const parts = plans.filter(p => p.kind !== 'skip' && p.clips.length).map(p => {
    const n = p.count;
    if (!n) return `${p.name} : aucune respiration trouvée`;
    const what = `${n} respiration${n > 1 ? 's' : ''}`;
    if (p.gainDb != null && p.gainDb <= BREATH_REMOVE_DB) return `${p.name} : ${what} supprimée${n > 1 ? 's' : ''}`;
    return `${p.name} : ${what} ${breathDoseLabel(p.gainDb)}`;
  });
  return parts.length ? parts.join(' ; ') : 'Aucune piste voix à traiter';
}

export const breathTotal = (plans: BreathTrackPlan[]) => plans.reduce((n, p) => n + (p.kind === 'skip' ? 0 : p.count), 0);

// ------------------------------------------------------------------ préférences

export interface BreathPrefs {
  settings: BreathSettings;
  /** Traiter automatiquement après chaque prise (désactivé par défaut). */
  auto: boolean;
  /** Case « Traiter les respirations » du Mix auto (cochée par défaut). */
  withMix: boolean;
}

const PREFS_KEY = 'nova_breaths';
export const DEFAULT_BREATH_PREFS: BreathPrefs = { settings: DEFAULT_BREATH_SETTINGS, auto: false, withMix: true };

export function loadBreathPrefs(): BreathPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return { ...DEFAULT_BREATH_PREFS, ...raw, settings: { ...DEFAULT_BREATH_SETTINGS, ...(raw.settings || {}) } };
  } catch { return DEFAULT_BREATH_PREFS; }
}

export function saveBreathPrefs(p: BreathPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* navigation privée */ }
}
