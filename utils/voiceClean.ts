/**
 * Lot 1 · « Voix propre » en un clic (le Voice Cleaner de BandLab, partout) :
 * bruit de fond, réverbe de la pièce et niveau, sur un clip voix, hors ligne et
 * non destructif (AudioSuite : l'original est gardé, Ctrl+Z, « Revenir à l'original »).
 *
 * Moteurs :
 *  - site, téléphone, appli sans module voix : RNNoise 0.2 en WebAssembly
 *    (utils/rnnoise, BSD-3) dans un Worker (services/VoiceCleanWorker), à 48 kHz ;
 *    puis un nettoyage des silences guidé par la probabilité de voix de RNNoise
 *    (plus fort en « Fort ») ;
 *  - appli Windows avec le module voix : DeepFilterNet 3 du pont (déjà utilisé pour
 *    la réverbe, services/VoiceAI), avec la réverbe tardive si « Réverbe » est cochée ;
 *  - réverbe sur le site : PAS proposée. L'estimateur de réverbe tardive du pont
 *    (Lebart / Habets), porté en TypeScript puis mesuré seul sur 6 prises en pièce,
 *    ne retirait que 1,7 dB de queue en abîmant la voix sèche (null test −12,5 dB,
 *    spectre ±2,2 dB) : pas assez propre (RAPPORT du lot 1). La réverbe reste dans
 *    Nova Studio (DeepFilterNet 3 : −15 dB de queue) ;
 *  - niveau : gain de clip doux vers −18 LUFS à court terme sur les phrases
 *    (pondération K de utils/loudness), les écarts entre phrases réduits, les
 *    silences jamais remontés, crête bornée à −1 dBFS.
 *
 * « Léger / Moyen / Fort » règle le mélange avec la prise d'origine, la baisse
 * des silences et la force du nivellement.
 *
 * Logique pure, sans DOM (tests/voiceClean.test.ts).
 */
import type { Clip } from '../types';
import { audioSuiteBlock, audioSuitePatch, audioSuiteRegion } from './clipProcess';
import { kWeighted } from './loudness';
import { resampleChannel } from './resample';
import { denoiseChannel, RNNOISE_FRAME, RNNOISE_SAMPLE_RATE, type RnnoiseEngine } from './rnnoise';
import { shiftTranscript, transcriptValid } from './voiceLyrics';

// ─── Réglages ──────────────────────────────────────────────────────────────────

export type CleanStrength = 'light' | 'medium' | 'strong';
export type CleanEngineId = 'rnnoise' | 'deepfilter';

export interface CleanOptions {
  /** Bruit de fond (ventilo, clim, souffle, rue). */
  noise: boolean;
  /** Réverbe de la pièce. */
  reverb: boolean;
  /** Niveau égalisé (phrases trop basses ou trop fortes). */
  level: boolean;
  strength: CleanStrength;
}

export const DEFAULT_CLEAN_OPTIONS: CleanOptions = { noise: true, reverb: true, level: true, strength: 'medium' };

export interface StrengthPreset {
  label: string;
  hint: string;
  /** Part de la voix débruitée (le reste : la prise d'origine). */
  mix: number;
  /** Baisse supplémentaire des silences (dB), guidée par la probabilité de voix. */
  silenceDb: number;
  /** Nivellement : part des écarts de niveau entre phrases corrigée (0 → 1). */
  level: number;
}

export const STRENGTHS: Record<CleanStrength, StrengthPreset> = {
  light: { label: 'Léger', hint: 'Le bruit baisse, la voix garde un peu d’air et d’ambiance.', mix: 0.85, silenceDb: 8, level: 0.3 },
  medium: { label: 'Moyen', hint: 'Conseillé : bruit de fond retiré, voix naturelle.', mix: 1, silenceDb: 12, level: 0.5 },
  strong: { label: 'Fort', hint: 'Pièce très bruyante (ventilo, rue) : silences muets, voix bien en avant.', mix: 1, silenceDb: 24, level: 0.7 },
};

export const STRENGTH_ORDER: CleanStrength[] = ['light', 'medium', 'strong'];

/** Niveau visé sur les phrases (LUFS à court terme). */
export const LEVEL_TARGET_LUFS = -18;
/** Crête maximale après nivellement (dBFS). */
export const LEVEL_PEAK_DB = -1;

export { CLEAN_TOOLTIP, CLEAN_MENU_LABEL, pickCleanTarget } from './voiceCleanLabels';

// ─── Clip ─────────────────────────────────────────────────────────────────────

/** Poignées traitées avec le clip (s) : la queue de réverbe juste après le clip est nettoyée aussi. */
export const CLEAN_HANDLE = 0.5;

/** Ce clip peut-il être nettoyé ? (sinon : la raison, qui dit quoi faire) */
export function cleanBlock(c: Clip | null | undefined): string | null {
  if (!c) return 'Clip introuvable : il a peut-être été supprimé.';
  const b = audioSuiteBlock(c);
  if (b) return b.replace('AudioSuite traite', 'Le nettoyage traite');
  if (c.duration < 0.3) return 'Clip trop court (0,3 s minimum) : agrandis-le ou choisis la prise entière.';
  return null;
}

/** Partie du son à traiter (clip + poignées). */
export const cleanRegion = (c: Pick<Clip, 'offset' | 'duration'>, bufferDuration: number) => audioSuiteRegion(c, bufferDuration, CLEAN_HANDLE);

/** Nom de l'étape (liste AudioSuite, nom du clip) : « Voix nettoyée (Moyen) ». */
export function cleanStepName(o: Pick<CleanOptions, 'strength'>): string {
  return `Voix nettoyée (${STRENGTHS[o.strength]?.label || 'Moyen'})`;
}

/**
 * Changements du clip une fois la voix nettoyée enregistrée sous `newBufferId`
 * (elle commence à `from` dans le son actuel du clip). Comme AudioSuite : la prise
 * d'origine est gardée ; la transcription éventuelle suit le nouveau son.
 */
export function cleanPatch(c: Clip, o: { newBufferId: string; from: number; options: Pick<CleanOptions, 'strength'>; now?: number }): Partial<Clip> {
  const patch = audioSuitePatch(c, { newBufferId: o.newBufferId, from: o.from, step: { type: 'AI_VOICE_CLEAN', name: cleanStepName(o.options), at: o.now ?? Date.now() } });
  if (c.transcript && transcriptValid(c)) patch.transcript = shiftTranscript(c.transcript, o.from, o.newBufferId);
  return patch;
}

// ─── Petits outils de signal ───────────────────────────────────────────────────

const dbToLin = (db: number) => Math.pow(10, db / 20);

function percentile(values: ArrayLike<number>, p: number): number {
  const a = Array.from(values).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const idx = (Math.max(0, Math.min(100, p)) / 100) * (a.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

function mono(chs: Float32Array[]): Float32Array {
  if (chs.length === 1) return chs[0];
  const n = chs[0].length;
  const out = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) out[i] += c[i] / chs.length;
  return out;
}

const fitLength = (x: Float32Array, n: number): Float32Array => {
  if (x.length === n) return x;
  const out = new Float32Array(n);
  out.set(x.subarray(0, Math.min(n, x.length)));
  return out;
};

/** Mélange prise d'origine / voix traitée : 0 = original, 1 = traitement complet. */
export function blendChannels(orig: Float32Array[], wet: Float32Array[], mix: number): Float32Array[] {
  const a = Math.max(0, Math.min(1, mix));
  return orig.map((o, c) => {
    const w = wet[Math.min(c, wet.length - 1)] || o;
    if (a === 1) return fitLength(new Float32Array(w), o.length);
    const out = new Float32Array(o.length);
    for (let i = 0; i < o.length; i++) out[i] = (1 - a) * o[i] + a * (w[i] ?? 0);
    return out;
  });
}

/**
 * Plancher de bruit (dB) : 10e centile de l'énergie par tranches de 20 ms (les
 * passages les plus calmes). Sert au résumé « bruit de fond −X dB ».
 */
export function noiseFloorDb(chs: Float32Array[], sr: number): number {
  const m = mono(chs);
  const n = Math.max(1, Math.round(0.02 * sr));
  const frames = Math.floor(m.length / n);
  if (frames < 1) return -120;
  const e: number[] = [];
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * n; i < (f + 1) * n; i++) s += m[i] * m[i];
    e.push(10 * Math.log10(s / n + 1e-12));
  }
  return Math.max(-120, percentile(e, 10));
}

// ─── Silences guidés par la probabilité de voix (RNNoise) ─────────────────────

/**
 * Gain (dB) par trame de 10 ms : 0 dB dès qu'il y a de la voix autour (40 ms avant,
 * 150 ms après : attaques et fins de mots gardées), jusqu'à −silenceDb dans les
 * silences. Lissé (pas de « pompage »).
 */
export function silenceGainsDb(vad: Float32Array, silenceDb: number, o: { threshold?: number; before?: number; after?: number } = {}): Float32Array {
  const thr = o.threshold ?? 0.35, before = o.before ?? 4, after = o.after ?? 15;
  const n = vad.length;
  const g = new Float32Array(n);
  if (silenceDb <= 0 || !n) return g;
  for (let f = 0; f < n; f++) {
    let v = 0;
    for (let k = Math.max(0, f - after); k <= Math.min(n - 1, f + before); k++) if (vad[k] > v) v = vad[k];
    g[f] = -silenceDb * Math.max(0, Math.min(1, (thr - v) / thr));
  }
  // Moyenne glissante sur 5 trames, deux fois ; jamais en dessous du gain brut là où il y a
  // de la voix (le lissage ne doit pas mordre sur les attaques).
  let cur = g;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, f - 2); k <= Math.min(n - 1, f + 2); k++) { s += cur[k]; c++; }
      next[f] = s / c;
    }
    cur = next;
  }
  for (let f = 0; f < n; f++) if (g[f] > cur[f]) cur[f] = g[f];
  return cur;
}

/** Applique un gain par trame (dB, trames de `frame` échantillons), interpolé entre les centres. */
export function applyFrameGains(ch: Float32Array, gainsDb: Float32Array, frame: number): Float32Array {
  const out = new Float32Array(ch.length);
  const nf = gainsDb.length;
  if (!nf) { out.set(ch); return out; }
  for (let i = 0; i < ch.length; i++) {
    const pos = (i - frame / 2) / frame;
    const f0 = Math.max(0, Math.min(nf - 1, Math.floor(pos)));
    const f1 = Math.min(nf - 1, f0 + 1);
    const t = Math.max(0, Math.min(1, pos - f0));
    const db = gainsDb[f0] + (gainsDb[f1] - gainsDb[f0]) * t;
    out[i] = ch[i] * (db === 0 ? 1 : dbToLin(db));
  }
  return out;
}

// ─── Niveau ───────────────────────────────────────────────────────────────────

/**
 * Nivellement doux : gain de clip vers `target` LUFS à court terme sur les phrases
 * (fenêtres de 400 ms), écarts entre phrases réduits de `amount` (0 → 1), silences
 * au gain de la phrase voisine (jamais remontés seuls), lissé sur ~0,5 s, crête
 * bornée à `peakDb`. Renvoie aussi le gain médian appliqué aux phrases.
 */
export function levelVoice(chs: Float32Array[], sr: number, amount: number, o: { target?: number; peakDb?: number } = {}): { out: Float32Array[]; gainDb: number | null; phraseLufs: number | null } {
  const target = o.target ?? LEVEL_TARGET_LUFS, peakLin = dbToLin(o.peakDb ?? LEVEL_PEAK_DB);
  const n = chs[0]?.length || 0;
  const block = Math.round(0.4 * sr), hop = Math.round(0.1 * sr);
  if (n < block) return { out: chs.map(c => new Float32Array(c)), gainDb: null, phraseLufs: null };
  const kw = chs.slice(0, 2).map(c => kWeighted(c, sr));
  const nw = 1 + Math.floor((n - block) / hop);
  const L = new Float64Array(nw);
  // Sommes cumulées de l'énergie pondérée (rapide sur les longs clips).
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { let s = 0; for (const k of kw) s += k[i] * k[i]; cum[i + 1] = cum[i] + s; }
  for (let w = 0; w < nw; w++) L[w] = -0.691 + 10 * Math.log10((cum[w * hop + block] - cum[w * hop]) / block + 1e-12);
  const abs = Array.from(L).filter(v => v > -60);
  if (!abs.length) return { out: chs.map(c => new Float32Array(c)), gainDb: null, phraseLufs: null };
  const energyMean = (vals: number[]) => -0.691 + 10 * Math.log10(vals.reduce((a, v) => a + Math.pow(10, (v + 0.691) / 10), 0) / vals.length);
  const integrated = energyMean(abs.filter(v => v > energyMean(abs) - 10));
  const isPhrase = (v: number) => v > -60 && v > integrated - 15;
  const g0 = Math.max(-12, Math.min(12, target - integrated));
  const a = Math.max(0, Math.min(1, amount));
  const local = new Float64Array(nw).fill(NaN);
  for (let w = 0; w < nw; w++) if (isPhrase(L[w])) local[w] = a * Math.max(-8, Math.min(8, integrated - L[w]));
  // Silences : gain de la phrase voisine (avant, sinon après).
  let last = NaN;
  for (let w = 0; w < nw; w++) { if (!Number.isNaN(local[w])) last = local[w]; else local[w] = last; }
  last = NaN;
  for (let w = nw - 1; w >= 0; w--) { if (!Number.isNaN(local[w])) last = local[w]; else local[w] = last; }
  for (let w = 0; w < nw; w++) if (Number.isNaN(local[w])) local[w] = 0;
  let gain = Array.from(local, v => g0 + v);
  for (let pass = 0; pass < 2; pass++) {
    gain = gain.map((_, w) => { let s = 0, c = 0; for (let k = Math.max(0, w - 2); k <= Math.min(nw - 1, w + 2); k++) { s += gain[k]; c++; } return s / c; });
  }
  const centers = (w: number) => w * hop + block / 2;
  const gainAt = (i: number) => {
    const pos = (i - block / 2) / hop;
    const w0 = Math.max(0, Math.min(nw - 1, Math.floor(pos)));
    const w1 = Math.min(nw - 1, w0 + 1);
    const t = Math.max(0, Math.min(1, (i - centers(w0)) / hop));
    return gain[w0] + (gain[w1] - gain[w0]) * t;
  };
  const lin = new Float32Array(n);
  for (let i = 0; i < n; i++) lin[i] = dbToLin(gainAt(i));
  let peak = 0;
  const out = chs.map(c => {
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = c[i] * lin[i]; r[i] = v; const av = v < 0 ? -v : v; if (av > peak) peak = av; }
    return r;
  });
  let cut = 0;
  if (peak > peakLin) {
    const k = peakLin / peak;
    cut = 20 * Math.log10(k);
    for (const r of out) for (let i = 0; i < n; i++) r[i] *= k;
  }
  const applied = gain.filter((_, w) => isPhrase(L[w]));
  return { out, gainDb: applied.length ? percentile(applied, 50) + cut : null, phraseLufs: integrated };
}

// ─── Chaîne complète ──────────────────────────────────────────────────────────

/** Ce que garde un premier calcul (changer Léger / Moyen / Fort ne relance pas RNNoise). */
export interface CleanCache {
  x48: Float32Array[];
  den48: Float32Array[] | null;
  vad: Float32Array | null;
}

export interface CleanStats {
  engine: CleanEngineId | 'none';
  /** Plancher de bruit avant / après (dB) et écart (négatif = bruit retiré). */
  noiseBeforeDb: number;
  noiseAfterDb: number;
  noiseReductionDb: number;
  /** Réverbe de la pièce réellement retirée (DeepFilterNet 3 + réverbe tardive, appli Windows). */
  reverb: boolean;
  /** Durée de réverbération lue sur la prise (pont), s. */
  rt60: number | null;
  levelGainDb: number | null;
  seconds: number;
  duration: number;
}

export interface CleanResult {
  channels: Float32Array[];
  sampleRate: number;
  stats: CleanStats;
  cache: CleanCache | null;
}

export interface CleanDeps {
  /** RNNoise (site) ; inutile si `external` est fourni. */
  engine?: RnnoiseEngine | null;
  /**
   * Voix déjà traitée à 100 % par DeepFilterNet 3 (pont de l'appli Windows), à la fréquence
   * d'entrée ; `reverb` : la réverbe tardive a été retirée aussi (case « Réverbe »).
   */
  external?: { channels: Float32Array[]; reverb: boolean; rt60?: number | null } | null;
  cache?: CleanCache | null;
  onProgress?: (pct: number, message: string) => void;
  now?: () => number;
}

export const STAGE_MESSAGES = {
  prepare: 'Préparation de la voix',
  noise: 'Retrait du bruit de fond',
  level: 'Niveau de la voix',
} as const;

/**
 * Nettoie une voix (canaux à `sampleRate`). Même longueur et mêmes canaux en sortie.
 * Synchrone (à lancer dans un Worker) ; la progression passe par `onProgress`.
 * Sur le site, `options.reverb` est sans effet (voir l'en-tête) : seul le pont la retire.
 */
export function cleanVoice(req: { channels: Float32Array[]; sampleRate: number; options: CleanOptions }, deps: CleanDeps = {}): CleanResult {
  const now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const t0 = now();
  const prog = (pct: number, msg: string) => deps.onProgress?.(Math.max(0, Math.min(100, pct)), msg);
  const { channels: orig, sampleRate: sr, options } = req;
  const P = STRENGTHS[options.strength] || STRENGTHS.medium;
  const n = orig[0]?.length || 0;
  if (!n) throw new Error('Clip vide : rien à nettoyer.');
  let y: Float32Array[] = orig;
  let cache: CleanCache | null = deps.cache ?? null;
  let engine: CleanStats['engine'] = 'none';
  let reverb = false;
  let rt60: number | null = null;

  if (deps.external) {
    engine = 'deepfilter';
    reverb = !!deps.external.reverb;
    rt60 = deps.external.rt60 ?? null;
    prog(85, STAGE_MESSAGES.noise);
    y = blendChannels(orig, deps.external.channels, P.mix);
    // Silences : DeepFilterNet 3 laisse un léger bruit entre les phrases (mesuré) ; la probabilité
    // de voix de RNNoise, lue sur la voix déjà nettoyée, guide la même baisse que sur le site.
    if (P.silenceDb > 0 && (deps.engine || cache?.vad)) {
      if (!cache) cache = { x48: [], den48: null, vad: null };
      if (!cache.vad) {
        const R = RNNOISE_SAMPLE_RATE;
        const m = mono(deps.external.channels);
        cache.vad = denoiseChannel(deps.engine!, sr === R ? m : resampleChannel(m, sr, R), f => prog(85 + 5 * f, STAGE_MESSAGES.noise)).vad;
      }
      const gains = silenceGainsDb(cache.vad, P.silenceDb);
      const frame = (RNNOISE_FRAME * sr) / RNNOISE_SAMPLE_RATE;
      y = y.map(c => applyFrameGains(c, gains, frame));
    }
  } else if (options.noise) {
    const R = RNNOISE_SAMPLE_RATE;
    prog(1, STAGE_MESSAGES.prepare);
    if (!cache) cache = { x48: sr === R ? orig : orig.map(c => resampleChannel(c, sr, R)), den48: null, vad: null };
    const x48 = cache.x48;
    if (!cache.den48 || !cache.vad) {
      if (!deps.engine) throw new Error('Moteur de bruit absent');
      const den: Float32Array[] = [];
      let vad: Float32Array | null = null;
      x48.forEach((c, ci) => {
        const r = denoiseChannel(deps.engine!, c, f => prog(8 + 74 * ((ci + f) / x48.length), STAGE_MESSAGES.noise));
        den.push(r.out);
        if (!vad) vad = r.vad; else for (let k = 0; k < vad.length; k++) vad[k] = Math.max(vad[k], r.vad[k] ?? 0);
      });
      cache.den48 = den;
      cache.vad = vad;
    }
    engine = 'rnnoise';
    prog(83, STAGE_MESSAGES.noise);
    let y48 = blendChannels(x48, cache.den48!, P.mix);
    if (P.silenceDb > 0 && cache.vad) {
      const gains = silenceGainsDb(cache.vad, P.silenceDb);
      y48 = y48.map(c => applyFrameGains(c, gains, RNNOISE_FRAME));
    }
    prog(88, STAGE_MESSAGES.noise);
    y = sr === R ? y48 : y48.map(c => fitLength(resampleChannel(c, R, sr), n));
  }

  let levelGainDb: number | null = null;
  if (options.level) {
    prog(93, STAGE_MESSAGES.level);
    const lv = levelVoice(y, sr, P.level);
    y = lv.out;
    levelGainDb = lv.gainDb;
  }
  if (y === orig) y = orig.map(c => new Float32Array(c));
  y = y.map(c => fitLength(c, n));
  const noiseBeforeDb = noiseFloorDb(orig, sr);
  const noiseAfterDb = noiseFloorDb(y, sr);
  prog(100, 'Terminé');
  return {
    channels: y,
    sampleRate: sr,
    cache,
    stats: {
      engine, noiseBeforeDb, noiseAfterDb, noiseReductionDb: Math.round((noiseAfterDb - noiseBeforeDb) * 10) / 10,
      reverb, rt60: rt60 === null ? null : Math.round(rt60 * 100) / 100,
      levelGainDb: levelGainDb === null ? null : Math.round(levelGainDb * 10) / 10,
      seconds: Math.round((now() - t0)) / 1000, duration: n / sr,
    },
  };
}

// ─── Textes ───────────────────────────────────────────────────────────────────

const fr1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1).replace('.', ',').replace(',0', '');

/** Résumé après le calcul : « Bruit de fond −24 dB · réverbe de la pièce (≈ 0,6 s) retirée · niveau +3 dB ». */
export function cleanSummary(stats: CleanStats, o: CleanOptions): string {
  const parts: string[] = [];
  if (o.noise) {
    const r = stats.noiseReductionDb;
    // Au-delà de 40 dB, le plancher mesuré n'est plus que le silence numérique : on ne fait pas mousser le chiffre.
    parts.push(r <= -40 ? 'bruit de fond retiré (plus de 40 dB en moins)' : r < -0.5 ? `bruit de fond ${fr1(r).replace('-', '−')} dB` : 'peu de bruit de fond trouvé');
  }
  if (stats.reverb) parts.push(stats.rt60 ? `réverbe de la pièce (≈ ${fr1(stats.rt60)} s) retirée` : 'réverbe de la pièce retirée');
  if (o.level && stats.levelGainDb !== null) parts.push(`niveau ${stats.levelGainDb >= 0 ? '+' : '−'}${fr1(Math.abs(stats.levelGainDb))} dB`);
  const s = parts.join(' · ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Voix traitée';
}

/** Temps de calcul annoncé (s), d'après les mesures du lot 1 (RAPPORT.md). */
export function estimateCleanSeconds(durationS: number, engine: CleanEngineId, sampleRate = 48000): number {
  const perSecond = engine === 'deepfilter' ? 0.2 : (sampleRate === RNNOISE_SAMPLE_RATE ? 0.1 : 0.16);
  return Math.max(1, Math.round(durationS * perSecond));
}

/** Moteur pour ce poste : DeepFilterNet 3 si l'appli Windows a le module voix installé, sinon RNNoise. */
export function cleanEngineFor(bridge: { status: string; voice?: boolean }, deverbInstalled: boolean | null | undefined): CleanEngineId {
  return bridge.status === 'connected' && bridge.voice && deverbInstalled ? 'deepfilter' : 'rnnoise';
}

export const ENGINE_LABELS: Record<CleanEngineId, string> = {
  rnnoise: 'RNNoise (IA libre, dans ton navigateur)',
  deepfilter: 'DeepFilterNet 3 (IA libre, sur ton PC)',
};

/** Message clair pour une erreur du nettoyage (ce qui s'est passé + quoi faire). */
export function describeCleanError(err: unknown): string {
  const e = err as { message?: string; code?: string; name?: string } | null;
  const msg = String(e?.message || err || '').trim();
  if (e?.code === 'cancelled' || /annul/i.test(msg)) return 'Nettoyage annulé.';
  if (/wasm|fetch|réseau|network|charger|load/i.test(msg)) return 'Le moteur de nettoyage (1,4 Mo) n’a pas pu se charger : vérifie ta connexion Internet, puis réessaie.';
  if (/memory|mémoire|allocation|RangeError/i.test(msg)) return 'Mémoire insuffisante pour un clip aussi long : coupe-le en deux (touche S), puis nettoie chaque partie.';
  if (/pont|bridge/i.test(msg)) return 'L’appli Windows ne répond plus : le nettoyage repasse par le navigateur. Réessaie.';
  return msg ? `Le nettoyage a échoué : ${msg}` : 'Le nettoyage a échoué : réessaie.';
}
