/**
 * « Masteriser un morceau » (lot 4a, le mastering gratuit d'un fichier de
 * BandLab) : moteur pur, sans Web Audio. Il tourne dans un Worker
 * (utils/quickMaster.worker.ts), dans le fil principal en secours et sous
 * Node (tests, mesures). L'écoute et l'export utilisent LE MÊME tampon rendu
 * ici : ce qu'on entend est, au bit près, ce qu'on télécharge.
 *
 * Chaîne (cœurs DSP existants de NOVA, aucun nouvel effet) :
 *  1. Mastering Transient (engine/masterTransientCore.ts), entrée ramenée à
 *     −18 LUFS : emphase des attaques et limiteur multibande, dosés par le
 *     style et l'intensité ;
 *  2. EQ de 6 bandes larges (filtres du Pro-EQ 12, utils/referenceMatch.ts),
 *     calculée sur la sortie de l'étape 1 : vers la courbe du style, ou vers
 *     le morceau de référence (±4 dB au plus, lissée) ;
 *  3. limiteur crête vraie NOVA (engine/limiterCore.ts), gain d'entrée réglé
 *     par itérations jusqu'à la cible LUFS de la plateforme (méthode de
 *     Master Nova, utils/masterAssistant.ts) ;
 *  4. contrôle final de la crête vraie (×8, 64 coefficients) et ajustement
 *     de quelques centièmes de dB si besoin.
 */
import { createMasterTransientCore } from '../engine/masterTransientCore';
import { createLimiterCore } from '../engine/limiterCore';
import { MASTER_TRANSIENT_PROFILE } from '../engine/masterTransientProfile';
import { MT_DEFAULTS, mtToCore } from '../engine/masterTransientParams';
import { lufsOf, truePeakOf, loudnessRangeOf } from './audioMeasure';
import { PLATFORM_TARGETS, PlatformTarget } from './masterAssistant';
import {
  thirdOctaveSpectrum, normalizeCurve, smoothCurve, fitEqToCurve, fitEqAdaptive, applyEq, curveFromAnchors, curveDiff,
  matchToReference, spectralDistance, eqResponseDb, EqBand, MATCH_MAX_DB, THIRD_OCTAVE_CENTERS,
} from './referenceMatch';

// ---------------------------------------------------------------------------
// Styles et intensités
// ---------------------------------------------------------------------------

export type QmStyleId = 'rap' | 'rnb' | 'afro' | 'pop' | 'drill' | 'doux';
export type QmIntensity = 'leger' | 'moyen' | 'fort';

export interface QmStyle {
  id: QmStyleId; label: string; emoji: string; hint: string;
  /** Courbe tonale visée (dB par tiers d'octave, points d'ancrage fréquence → dB). */
  curve: [number, number][];
  /** Mastering Transient : emphase (%), poussée du limiteur multibande (dB), vitesse (ms), gain adaptatif (dB). */
  emphasis: number; push: number; speed: number; adaptiveGain: number;
  /** Relâchement du limiteur final (ms). */
  release: number;
}

/*
 * Courbes : bruit rose penché (≈ −3 dB par octave au-dessus des médiums),
 * comme la courbe « rap / R&B » de Master Nova, déclinée par style : sub plus
 * présent en drill et en trap, médiums ronds en R&B, aigus plus ouverts en
 * pop, grave retenu pour le doux / acoustique.
 */
export const QM_STYLES: QmStyle[] = [
  { id: 'rap', label: 'Rap / Trap', emoji: '🎤', hint: '808 et kick devant, voix nette, fort et dense.',
    curve: [[45, 12], [110, 11], [400, 5], [1600, 0], [5000, -5], [11000, -9], [16000, -13]], emphasis: 24, push: 3, speed: 1, adaptiveGain: 6, release: 60 },
  { id: 'rnb', label: 'R&B', emoji: '🌙', hint: 'Rond et doux : bas-médiums chauds, aigus soyeux, attaques arrondies.',
    curve: [[45, 10], [110, 10], [400, 5.5], [1600, 0], [5000, -5.5], [11000, -9.5], [16000, -14]], emphasis: 12, push: 2, speed: 2, adaptiveGain: 5, release: 150 },
  { id: 'afro', label: 'Afro', emoji: '🥁', hint: 'Percussions qui claquent, basse ronde, voix en avant.',
    curve: [[45, 9], [110, 10], [400, 4.5], [1600, 0], [5000, -4], [11000, -8.5], [16000, -12.5]], emphasis: 30, push: 2.5, speed: 1.5, adaptiveGain: 5, release: 90 },
  { id: 'pop', label: 'Pop', emoji: '✨', hint: 'Clair et brillant, équilibré, prêt pour la radio.',
    curve: [[45, 8], [110, 8.5], [400, 4], [1600, 0], [5000, -3.5], [11000, -7.5], [16000, -11.5]], emphasis: 18, push: 2.5, speed: 1.5, adaptiveGain: 5, release: 100 },
  { id: 'drill', label: 'Drill', emoji: '🔪', hint: 'Sub qui glisse très présent, charleys secs, sombre et serré.',
    curve: [[45, 13], [110, 10], [400, 4], [1600, 0], [5000, -4.5], [11000, -8.5], [16000, -12.5]], emphasis: 28, push: 3.5, speed: 0.8, adaptiveGain: 6, release: 50 },
  { id: 'doux', label: 'Doux / Acoustique', emoji: '🎸', hint: 'Naturel et aéré : peu de compression, la dynamique respire.',
    curve: [[45, 6], [110, 8], [400, 5], [1600, 0], [5000, -5], [11000, -9], [16000, -13]], emphasis: 6, push: 1, speed: 3, adaptiveGain: 3, release: 200 },
];

export const QM_INTENSITIES: { id: QmIntensity; label: string; hint: string; k: number; eq: number; refEq: number }[] = [
  { id: 'leger', label: 'Léger', hint: 'Le moins de traitement possible : le mix tel quel, au bon niveau.', k: 0.5, eq: 0.4, refEq: 0.6 },
  { id: 'moyen', label: 'Moyen', hint: 'Le réglage conseillé : couleur du style bien présente, sans excès.', k: 1, eq: 0.65, refEq: 0.85 },
  { id: 'fort', label: 'Fort', hint: 'Style poussé : plus de densité, d’attaque et de correction tonale.', k: 1.5, eq: 0.9, refEq: 1 },
];

/** Niveau de travail avant le Mastering Transient (LUFS). */
export const QM_WORK_LUFS = -18;

export interface QmTarget { id: string; label: string; lufs: number; ceiling: number }

/**
 * Cibles par plateforme (celles de Master Nova), crête vraie à −1 dBTP au plus
 * (même pour le club : le fichier passe ensuite par le MP3 / AAC des
 * plateformes). « Comme la référence » s'y ajoute quand on en dépose une.
 */
export const QM_TARGETS: QmTarget[] = PLATFORM_TARGETS.map((t: PlatformTarget) => ({ id: t.id, label: t.label, lufs: t.lufs, ceiling: Math.min(-1, t.ceiling) }));

/** Cible « comme la référence » : sa loudness (bornée à −20 / −7 LUFS), crête vraie −1 dBTP. */
export function referenceTarget(refLufs: number): QmTarget {
  const l = Math.max(-20, Math.min(-7, Number.isFinite(refLufs) ? refLufs : -14));
  return { id: 'reference', label: 'Comme la référence', lufs: Math.round(l * 10) / 10, ceiling: -1 };
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

export interface QmAnalysis {
  lufs: number;
  /** Crête vraie (dBTP), mesure stricte ×8 / 64 coefficients. */
  truePeak: number;
  /** Plage dynamique : crête vraie − loudness (PLR, dB) et étendue de loudness (LRA, LU). */
  plr: number;
  lra: number;
  /** Spectre par tiers d'octave (dB), 50 Hz – 16 kHz. */
  curve: number[];
  duration: number;
  sampleRate: number;
}

export function analyzeTrack(ch: Float32Array[], sampleRate: number): QmAnalysis {
  const lufs = lufsOf(ch, sampleRate);
  const truePeak = truePeakOf(ch, 8, 64);
  return {
    lufs, truePeak, plr: Number.isFinite(lufs) ? truePeak - lufs : 0, lra: loudnessRangeOf(ch, sampleRate),
    curve: thirdOctaveSpectrum(ch, sampleRate), duration: (ch[0]?.length || 0) / sampleRate, sampleRate,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface QmOptions {
  style: QmStyleId;
  intensity: QmIntensity;
  target: QmTarget;
  /** Spectre du morceau de référence (tiers d'octave) : l'EQ se cale dessus au lieu de la courbe du style. */
  refCurve?: number[] | null;
}

export const styleOf = (id: QmStyleId) => QM_STYLES.find(s => s.id === id) || QM_STYLES[0];
export const intensityOf = (id: QmIntensity) => QM_INTENSITIES.find(s => s.id === id) || QM_INTENSITIES[1];

/** Réglages du Mastering Transient pour un style et une intensité (entrée ramenée à −18 LUFS). */
export function mtParamsFor(style: QmStyleId, intensity: QmIntensity, inputLufs: number): Record<string, number> {
  const s = styleOf(style), it = intensityOf(intensity);
  const inputGain = Number.isFinite(inputLufs) ? Math.max(-24, Math.min(24, QM_WORK_LUFS - inputLufs)) : 0;
  return {
    ...MT_DEFAULTS,
    emphasis: Math.min(100, s.emphasis * it.k), adaptive: 50,
    limitGain: Math.min(12, s.push * it.k), speed: s.speed, adaptiveGain: s.adaptiveGain, adaptiveSpeed: 100,
    ceiling: -1, truePeak: 1, clipDrive: 0, clipShape: 0, clipperOn: 0, transientOn: 1, limiterOn: 1,
    inputGain: Math.round(inputGain * 100) / 100, outputGain: 0, soloBand: -1,
  };
}

/** EQ vers la courbe du style (douce : ±3 dB) ou vers la référence (±4 dB), selon ce qui est fourni. */
export function eqFor(curve: number[], sampleRate: number, opts: QmOptions): { bands: EqBand[]; source: 'style' | 'reference'; before?: number; predicted?: number } {
  const it = intensityOf(opts.intensity);
  if (opts.refCurve && opts.refCurve.length === curve.length) {
    const m = matchToReference(curve, opts.refCurve, sampleRate, it.refEq, MATCH_MAX_DB);
    return { bands: m.bands, source: 'reference', before: m.before, predicted: m.predicted };
  }
  const target = curveFromAnchors(styleOf(opts.style).curve);
  const nm = normalizeCurve(curve), nt = normalizeCurve(target);
  const wanted = smoothCurve(nt.map((v, i) => v - nm[i]), 2).map(v => v * it.eq);
  return { bands: fitEqToCurve(wanted, sampleRate, 3), source: 'style' };
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

export interface QmControl {
  onProgress?: (label: string, p: number) => void;
  /** Rend la main (Worker : laisse passer un message d'annulation). */
  yieldNow?: () => Promise<void>;
  isCancelled?: () => boolean;
}

export class QmCancelled extends Error { constructor() { super('annulé'); } }

const BLOCK = 4096;

/** Passe des canaux stéréo dans un cœur DSP (latence retirée), par blocs, en rendant la main de temps en temps. */
async function runCore(core: { process: (a: Float32Array, b: Float32Array | null, c: Float32Array, d: Float32Array | null, n: number) => void; latencySamples: () => number },
  L: Float32Array, R: Float32Array, ctl: QmControl, label: string, p0: number, p1: number): Promise<[Float32Array, Float32Array]> {
  const lat = core.latencySamples();
  const n = L.length, tot = n + lat;
  const oL = new Float32Array(n), oR = new Float32Array(n);
  const zL = new Float32Array(BLOCK), zR = new Float32Array(BLOCK);
  const bL = new Float32Array(BLOCK), bR = new Float32Array(BLOCK);
  let lastYield = Date.now();
  for (let pos = 0; pos < tot; pos += BLOCK) {
    const m = Math.min(BLOCK, tot - pos);
    let iL: Float32Array, iR: Float32Array;
    if (pos + m <= n) { iL = L.subarray(pos, pos + m); iR = R.subarray(pos, pos + m); }
    else {
      zL.fill(0); zR.fill(0);
      if (pos < n) { zL.set(L.subarray(pos, n)); zR.set(R.subarray(pos, n)); }
      iL = zL.subarray(0, m); iR = zR.subarray(0, m);
    }
    core.process(iL, iR, bL.subarray(0, m), bR.subarray(0, m), m);
    // Sortie décalée de la latence.
    const from = pos - lat;
    for (let k = 0; k < m; k++) {
      const j = from + k;
      if (j >= 0 && j < n) { oL[j] = bL[k]; oR[j] = bR[k]; }
    }
    if (Date.now() - lastYield > 120) {
      lastYield = Date.now();
      ctl.onProgress?.(label, p0 + (p1 - p0) * (pos / tot));
      if (ctl.yieldNow) await ctl.yieldNow();
      if (ctl.isCancelled?.()) throw new QmCancelled();
    }
  }
  return [oL, oR];
}

const stereo = (ch: Float32Array[]): [Float32Array, Float32Array] => [ch[0], ch[1] || ch[0]];

/**
 * Gain suivant du limiteur (méthode de la sécante de Master Nova,
 * utils/masterAssistant.ts nextLimiterGain), mais le gain peut aussi être
 * NÉGATIF : une cible plus douce que le niveau de travail (Apple −16, une
 * référence calme) se règle en baissant, sans limiter.
 */
export function nextGain(history: { gain: number; lufs: number }[], target: number): number {
  const last = history[history.length - 1];
  if (!last) return 0;
  const err = target - last.lufs;
  if (history.length < 2) return Math.max(-24, Math.min(24, last.gain + err));
  const prev = history[history.length - 2];
  const slope = (last.lufs - prev.lufs) / ((last.gain - prev.gain) || 1e-6);
  const sl = Math.max(0.15, Math.min(1.2, Number.isFinite(slope) ? slope : 1));
  return Math.max(-24, Math.min(24, last.gain + err / sl));
}

/** Étape 1 (la plus longue) : Mastering Transient. Ne dépend que du style, de l'intensité et du fichier : mise en cache. */
export async function renderTransientStage(ch: Float32Array[], sampleRate: number, mt: Record<string, number>, ctl: QmControl = {}): Promise<Float32Array[]> {
  const core = createMasterTransientCore(sampleRate, MASTER_TRANSIENT_PROFILE as any, createLimiterCore);
  core.setParams(mtToCore(mt));
  const [L, R] = stereo(ch);
  return runCore(core, L, R, ctl, 'Densité et attaques (Mastering Transient)…', 0.05, 0.6);
}

export interface QmLimiterParams { ceilingDb: number; releaseMs: number; lookaheadMs: number; oversample: number }

export function limiterFor(style: QmStyleId, target: QmTarget): QmLimiterParams {
  // Marge de 0,2 dB sous le plafond : le contrôle final mesure plus finement (×8) que la détection (×4).
  return { ceilingDb: target.ceiling - 0.2, releaseMs: styleOf(style).release, lookaheadMs: 3, oversample: 4 };
}

async function limitPass(ch: Float32Array[], sampleRate: number, lim: QmLimiterParams, gainDb: number, ctl: QmControl, label: string, p0: number, p1: number): Promise<Float32Array[]> {
  const core = createLimiterCore(sampleRate);
  core.setParams({ ...lim, inputGainDb: gainDb });
  const [L, R] = stereo(ch);
  return runCore(core, L, R, ctl, label, p0, p1);
}

/** Extrait représentatif (segments de 3 s répartis sur tout le morceau) pour régler le gain vite. */
function excerptOf(ch: Float32Array[], sampleRate: number): Float32Array[] {
  const n = ch[0].length, seg = Math.round(3 * sampleRate);
  if (n <= 60 * sampleRate) return ch;
  const count = Math.max(10, Math.min(40, Math.round(n / sampleRate / 9)));
  const step = (n - seg) / (count - 1);
  return ch.map(x => {
    const out = new Float32Array(seg * count);
    for (let k = 0; k < count; k++) { const s = Math.round(k * step); out.set(x.subarray(s, s + seg), k * seg); }
    return out;
  });
}

export interface QmResult {
  out: Float32Array[];
  before: QmAnalysis;
  after: QmAnalysis;
  eq: EqBand[];
  eqSource: 'style' | 'reference';
  mt: Record<string, number>;
  limiter: QmLimiterParams & { inputGainDb: number };
  iterations: { gain: number; lufs: number; full: boolean }[];
  /** Ajustement final de crête (dB, ≤ 0). */
  trimDb: number;
  reached: boolean;
  /** Écart spectral moyen avec la référence (dB), avant et après, si une référence est donnée. */
  refDistance?: { before: number; after: number; tonalBefore: number; tonalAfter: number };
  target: QmTarget;
  style: QmStyleId;
  intensity: QmIntensity;
}

export interface QmCache { key: string; stage: Float32Array[]; curve: number[] }

/**
 * Master complet. `cache` : étape du Mastering Transient déjà rendue pour ce
 * fichier, ce style et cette intensité (changer de plateforme ou de référence
 * ne refait que l'EQ et le limiteur).
 */
export async function renderQuickMaster(ch: Float32Array[], sampleRate: number, before: QmAnalysis, opts: QmOptions,
  ctl: QmControl = {}, cache?: { get: (k: string) => QmCache | undefined; set: (c: QmCache) => void }): Promise<QmResult> {
  if (!Number.isFinite(before.lufs)) throw new Error('Le fichier est silencieux : rien à masteriser.');
  const mt = mtParamsFor(opts.style, opts.intensity, before.lufs);
  const key = `${opts.style}|${opts.intensity}|${mt.inputGain}`;
  let c = cache?.get(key);
  if (!c) {
    const stage = await renderTransientStage(ch, sampleRate, mt, ctl);
    c = { key, stage, curve: thirdOctaveSpectrum(stage, sampleRate) };
    cache?.set(c);
  }
  ctl.onProgress?.('Égalisation…', 0.62);
  const eq = eqFor(c.curve, sampleRate, opts);
  const eqd = applyEq(c.stage, sampleRate, eq.bands);
  if (ctl.yieldNow) await ctl.yieldNow();
  if (ctl.isCancelled?.()) throw new QmCancelled();

  // Gain du limiteur : itérations sur un extrait, puis passes complètes de contrôle.
  const lim = limiterFor(opts.style, opts.target);
  const target = opts.target.lufs;
  const iterations: QmResult['iterations'] = [];
  const level = async (src: Float32Array[], p0: number, p1: number, hint?: { gain: number; exLufs: number }) => {
    const span = (k: number) => p0 + (p1 - p0) * k;
    const ex = excerptOf(src, sampleRate);
    const exLufs = lufsOf(ex, sampleRate);
    const hist: { gain: number; lufs: number }[] = [];
    // 2e passe : on part du gain trouvé, corrigé de l'écart de niveau dû à la nouvelle EQ.
    let gain = Math.max(-24, Math.min(24, hint ? hint.gain - (exLufs - hint.exLufs) : target - exLufs));
    for (let k = 0; k < 6; k++) {
      const o = await limitPass(ex, sampleRate, lim, gain, ctl, `Niveau : réglage du limiteur (essai ${k + 1})…`, span(0.1 * k), span(0.1 * k + 0.08));
      const l = lufsOf(o, sampleRate);
      hist.push({ gain, lufs: l }); iterations.push({ gain, lufs: l, full: ex === src });
      if (Math.abs(l - target) < 0.05) break;
      const next = nextGain(hist, target);
      if (Math.abs(next - gain) < 0.005) break;
      gain = next;
    }
    gain = hist.reduce((a, b) => (Math.abs(b.lufs - target) < Math.abs(a.lufs - target) ? b : a)).gain;
    let o = await limitPass(src, sampleRate, lim, gain, ctl, 'Limiteur : rendu du morceau entier…', span(0.6), span(0.85));
    let full = lufsOf(o, sampleRate);
    iterations.push({ gain, lufs: full, full: true });
    // L'extrait diffère un peu du morceau entier : une ou deux corrections sur le morceau entier.
    for (let k = 0; k < 2 && Math.abs(full - target) > 0.12; k++) {
      const slope = hist.length > 1 ? Math.max(0.3, Math.min(1.2, (hist[hist.length - 1].lufs - hist[0].lufs) / ((hist[hist.length - 1].gain - hist[0].gain) || 1))) : 1;
      gain = Math.max(-24, Math.min(24, gain + (target - full) / (Number.isFinite(slope) ? slope : 1)));
      o = await limitPass(src, sampleRate, lim, gain, ctl, 'Limiteur : correction du niveau…', span(0.85), span(1));
      full = lufsOf(o, sampleRate);
      iterations.push({ gain, lufs: full, full: true });
    }
    return { out: o, gain, exLufs };
  };
  const refMode = eq.source === 'reference' && !!opts.refCurve;
  const first = await level(eqd, 0.64, refMode ? 0.8 : 0.95);
  let { out, gain } = first;
  let bands = eq.bands;

  // Référence : le limiteur change un peu l'équilibre (il tasse surtout le grave). On mesure
  // le master, on ajoute l'écart restant à la correction (toujours 6 bandes, ±4 dB) et on
  // refait EQ + limiteur ; gardé seulement si le master se rapproche vraiment de la référence.
  if (refMode && opts.refCurve) {
    ctl.onProgress?.('Référence : contrôle de l’équilibre du master…', 0.8);
    const refC = opts.refCurve;
    const d1 = spectralDistance(thirdOctaveSpectrum(out, sampleRate), refC);
    const freqs = THIRD_OCTAVE_CENTERS.filter(f => f < sampleRate / 2);
    const resp = eqResponseDb(bands, freqs, sampleRate);
    const resid = smoothCurve(curveDiff(thirdOctaveSpectrum(out, sampleRate), refC), 1);
    const it = intensityOf(opts.intensity);
    const wanted = freqs.map((_, k) => resp[k] + resid[k] * it.refEq);
    const bands2 = fitEqAdaptive(wanted, sampleRate, MATCH_MAX_DB);
    if (bands2.some((b, i) => Math.abs(b.gainDb - (bands[i]?.gainDb ?? 0)) >= 0.3 || b.freq !== bands[i]?.freq)) {
      const eqd2 = applyEq(c.stage, sampleRate, bands2);
      const r2 = await level(eqd2, 0.8, 0.95, { gain: first.gain, exLufs: first.exLufs });
      if (spectralDistance(thirdOctaveSpectrum(r2.out, sampleRate), refC) < d1 - 0.05) { out = r2.out; gain = r2.gain; bands = bands2; }
    }
  }

  // Contrôle final de la crête vraie (mesure stricte) et léger ajustement si besoin.
  ctl.onProgress?.('Contrôle de la crête vraie…', 0.96);
  let trimDb = 0;
  const tp = truePeakOf(out, 8, 64);
  if (tp > opts.target.ceiling - 0.02) {
    trimDb = opts.target.ceiling - 0.03 - tp;
    const g = Math.pow(10, trimDb / 20);
    for (const x of out) for (let i = 0; i < x.length; i++) x[i] *= g;
  }
  ctl.onProgress?.('Mesures avant / après…', 0.98);
  const after = analyzeTrack(out, sampleRate);
  const res: QmResult = {
    out, before, after, eq: bands, eqSource: eq.source, mt, limiter: { ...lim, inputGainDb: Math.round(gain * 100) / 100 },
    iterations, trimDb, reached: Math.abs(after.lufs - target) <= 0.5 && after.truePeak <= opts.target.ceiling,
    target: opts.target, style: opts.style, intensity: opts.intensity,
  };
  if (opts.refCurve) res.refDistance = {
    before: spectralDistance(before.curve, opts.refCurve), after: spectralDistance(after.curve, opts.refCurve),
    tonalBefore: spectralDistance(before.curve, opts.refCurve, 2), tonalAfter: spectralDistance(after.curve, opts.refCurve, 2),
  };
  ctl.onProgress?.('Terminé', 1);
  return res;
}

// ---------------------------------------------------------------------------
// Écoute honnête
// ---------------------------------------------------------------------------

/**
 * Gains d'écoute (dB) pour entendre l'original, le master et la référence au
 * MÊME volume perçu : chacun est ramené au plus faible des trois (on ne
 * monte jamais un son, on baisse le plus fort). Sans ça, le plus fort paraît
 * toujours meilleur.
 */
export function listenGainsDb(levels: { original: number; master?: number | null; reference?: number | null }): { original: number; master: number; reference: number; common: number } {
  const vals = [levels.original, levels.master, levels.reference].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const common = vals.length ? Math.min(...vals) : 0;
  const g = (v?: number | null) => (typeof v === 'number' && Number.isFinite(v) ? common - v : 0);
  return { original: g(levels.original), master: g(levels.master), reference: g(levels.reference), common };
}

/**
 * Ce que chaque plateforme fera du master (normalisation) : baisse en dB si le
 * master est plus fort que sa cible (−) ; 0 s'il est en dessous (la plupart
 * ne remontent pas, ou seulement jusqu'à la crête).
 */
export function platformPlayback(lufs: number): { id: string; label: string; target: number; changeDb: number }[] {
  return PLATFORM_TARGETS.filter(t => t.id !== 'club').map(t => ({ id: t.id, label: t.label, target: t.lufs, changeDb: Number.isFinite(lufs) && lufs > t.lufs ? t.lufs - lufs : 0 }));
}

/** Nom du fichier exporté (« Mon son (master Nova Rap-Trap -14 LUFS).wav »). */
export function masterFileName(source: string, style: QmStyleId, target: QmTarget, ext: 'wav' | 'mp3'): string {
  const base = (source || 'Morceau').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Morceau';
  const st = styleOf(style).label.replace(/\s*\/\s*/g, '-');
  return `${base} (master Nova ${st} ${String(Math.round(target.lufs * 10) / 10).replace('.', ',')} LUFS).${ext}`;
}
