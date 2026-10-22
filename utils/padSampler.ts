/**
 * Sampler des pads de la batterie (22/10/2026) : tout ce qu'un sampler classique règle sur un son,
 * pad par pad — zone jouée et boucle, gain, polarité, normalisation, enveloppe d'amplitude complète
 * (attaque, maintien, décroissance, sustain, relâchement, avec courbes), enveloppe de hauteur, hauteur
 * (demi-tons, centièmes, suivi, glisse, durée gardée), filtre multimode 12 / 24 dB/oct avec enveloppe et
 * suivi de vélocité, vélocité → volume / filtre / hauteur, couches de vélocité et alternance, drive,
 * réduction de résolution et d'échantillonnage, polyphonie / mono.
 *
 * RÈGLES
 *  - Absent (`row.smp` indéfini) ou valeurs par défaut : le son est EXACTEMENT celui d'avant (même chemin
 *    du moteur, voir DrumRackNode) — un ancien projet ne change pas.
 *  - Chaque valeur affichée est la valeur réelle : une attaque de 10 ms atteint son maximum en 10 ms,
 *    une coupure de 1 kHz est à −3,01 dB à 1 kHz (passe-bas / passe-haut, 12 et 24 dB/oct) ou à 0 dB
 *    (passe-bande), +6 dB = ×1,995, +12 demi-tons = ×2 (tests/padSampler.test.ts et qa/sampler_pads.py).
 *  - Lecture = export au bit près : le même code (DrumRackNode) programme les voix dans les deux
 *    contextes ; les traitements du son (polarité, normalisation, drive, résolution, durée gardée, fondu
 *    de boucle) sont calculés une fois sur le son du pad, partagé par la lecture et l'export.
 *
 * Module pur (aucun React, aucun moteur).
 */

export type FilterType = 'off' | 'lp' | 'hp' | 'bp';

export interface PadSamplerParams {
  // ── Sample ──
  /** 'oneshot' : le son joue jusqu'au bout ; 'gate' : tant que la note est tenue, puis relâchement. */
  mode?: 'oneshot' | 'gate';
  /** Boucle (début / fin en fraction de la zone jouée, fondu de boucle en s). Joue tant que la note est tenue. */
  loop?: boolean;
  loopStart?: number;
  loopEnd?: number;
  loopXfade?: number;
  // ── Niveau ──
  gainDb?: number;
  invert?: boolean;
  normalize?: boolean;
  // ── Enveloppe d'amplitude (s, sustain 0-1) ──
  attack?: number;
  hold?: number;
  decay?: number;
  sustain?: number;
  release?: number;
  /** Courbes : 0 = droite, 1 = exponentielle marquée. */
  attackCurve?: number;
  decayCurve?: number;
  releaseCurve?: number;
  // ── Hauteur ──
  cents?: number;
  /** Suivi de la hauteur des pas (0-1 ; 1 = un demi-ton par demi-ton). */
  keytrack?: number;
  /** Temps de glisse des pas « glisse » (ms). */
  glideMs?: number;
  /** Garder la durée quand on change la hauteur du pad (étirement). */
  stretch?: boolean;
  /** Enveloppe de hauteur : départ à +N demi-tons, retour en `pitchEnvDecay` s. */
  pitchEnvAmt?: number;
  pitchEnvDecay?: number;
  // ── Filtre ──
  filterType?: FilterType;
  filterSlope?: 12 | 24;
  cutoff?: number;
  /** Résonance 0-1 (0 = aucune bosse : −3 dB à la coupure). */
  reso?: number;
  /** Enveloppe de filtre : montant en octaves, attaque / décroissance (s), sustain 0-1. */
  filterEnvAmt?: number;
  filterAttack?: number;
  filterDecay?: number;
  filterSustain?: number;
  /** Vélocité → coupure, en octaves à vélocité maximale. */
  filterVel?: number;
  // ── Vélocité ──
  /** 0 : volume fixe, 1 : volume proportionnel à la vélocité (comme avant). */
  velToVol?: number;
  /** Vélocité → hauteur, en demi-tons à vélocité maximale. */
  velToPitch?: number;
  // ── Caractère ──
  /** Saturation douce 0-1. */
  drive?: number;
  /** Résolution en bits (0 = intacte, 2-16). */
  crushBits?: number;
  /** Réduction d'échantillonnage : un échantillon gardé sur N (1 = intacte). */
  crushDown?: number;
  // ── Voix ──
  poly?: 'poly' | 'mono';
  /** Autres sons du pad : couches de vélocité (du plus doux au plus fort) ou alternance. */
  layers?: { sound: string; name?: string }[];
  layerMode?: 'vel' | 'rr';
}

export const SAMPLER_DEFAULTS: Required<Omit<PadSamplerParams, 'layers'>> & { layers: { sound: string; name?: string }[] } = {
  mode: 'oneshot', loop: false, loopStart: 0, loopEnd: 1, loopXfade: 0,
  gainDb: 0, invert: false, normalize: false,
  attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.005, attackCurve: 0, decayCurve: 1, releaseCurve: 1,
  cents: 0, keytrack: 1, glideMs: 80, stretch: false, pitchEnvAmt: 0, pitchEnvDecay: 0.05,
  filterType: 'off', filterSlope: 12, cutoff: 1000, reso: 0, filterEnvAmt: 0, filterAttack: 0, filterDecay: 0.2, filterSustain: 0, filterVel: 0,
  velToVol: 1, velToPitch: 0,
  drive: 0, crushBits: 0, crushDown: 1,
  poly: 'poly', layers: [], layerMode: 'vel',
};

export const smpOf = (p: PadSamplerParams | undefined) => ({ ...SAMPLER_DEFAULTS, ...(p || {}) });

/** Relâchement minimal (s) d'une note tenue : évite le clic d'une coupe franche. */
export const MIN_RELEASE = 0.002;

/** Bornes (et pas) des réglages : les mêmes pour l'interface, les tests et le nettoyage d'un fichier reçu. */
export const SAMPLER_RANGES: Partial<Record<keyof PadSamplerParams, [number, number]>> = {
  loopStart: [0, 1], loopEnd: [0, 1], loopXfade: [0, 0.5],
  gainDb: [-48, 24],
  attack: [0, 4], hold: [0, 4], decay: [0, 8], sustain: [0, 1], release: [0.002, 8],
  attackCurve: [0, 1], decayCurve: [0, 1], releaseCurve: [0, 1],
  cents: [-100, 100], keytrack: [0, 1], glideMs: [0, 2000], pitchEnvAmt: [-48, 48], pitchEnvDecay: [0.001, 4],
  cutoff: [20, 20000], reso: [0, 1], filterEnvAmt: [-8, 8], filterAttack: [0, 4], filterDecay: [0.001, 8], filterSustain: [0, 1], filterVel: [-8, 8],
  velToVol: [0, 1], velToPitch: [-24, 24],
  drive: [0, 1], crushBits: [0, 16], crushDown: [1, 32],
};

/** Réglages nettoyés (bornes, types) : fichiers reçus, collaboration, presets. Les valeurs par défaut sont retirées. */
export function cleanSampler(p: PadSamplerParams | undefined | null): PadSamplerParams | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const out: PadSamplerParams = {};
  const d = SAMPLER_DEFAULTS as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    const rg = SAMPLER_RANGES[k as keyof PadSamplerParams];
    if (rg) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const c = Math.max(rg[0], Math.min(rg[1], v));
      if (c !== d[k]) (out as Record<string, unknown>)[k] = c;
    } else if (k === 'layers') {
      if (Array.isArray(v)) {
        const ls = v.filter(x => x && typeof x.sound === 'string').slice(0, 7).map(x => ({ sound: x.sound, ...(typeof x.name === 'string' ? { name: x.name.slice(0, 40) } : {}) }));
        if (ls.length) out.layers = ls;
      }
    } else if (k === 'mode' && (v === 'oneshot' || v === 'gate')) { if (v !== d[k]) out.mode = v; }
    else if (k === 'filterType' && ['off', 'lp', 'hp', 'bp'].includes(v as string)) { if (v !== d[k]) out.filterType = v as FilterType; }
    else if (k === 'filterSlope' && (v === 12 || v === 24)) { if (v !== d[k]) out.filterSlope = v; }
    else if (k === 'poly' && (v === 'poly' || v === 'mono')) { if (v !== d[k]) out.poly = v; }
    else if (k === 'layerMode' && (v === 'vel' || v === 'rr')) { if (v !== d[k]) out.layerMode = v; }
    else if ((k === 'loop' || k === 'invert' || k === 'normalize' || k === 'stretch') && typeof v === 'boolean') { if (v) (out as Record<string, unknown>)[k] = true; }
  }
  return Object.keys(out).length ? out : undefined;
}

// ── Unités ─────────────────────────────────────────────────────────────────────────────

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(1e-12, g));
export const semisToRatio = (st: number) => Math.pow(2, st / 12);

/** Le pad joue-t-il en « note tenue » (relâchement à la fin de la note) ? La boucle l'impose. */
export const gated = (p: PadSamplerParams | undefined) => !!p && (p.mode === 'gate' || !!p.loop);

// ── Enveloppes ─────────────────────────────────────────────────────────────────────────

/** Un segment d'enveloppe : de v0 (à t0) à v1 (à t1), droit (curve 0) ou courbé (curve > 0). */
export interface EnvSeg { t0: number; t1: number; v0: number; v1: number; curve: number }

/** Forme d'un segment (0 → 1) : droite, ou exponentielle (rapide au début, comme un son naturel). */
export function shape(x: number, curve: number): number {
  const c = Math.max(0, Math.min(1, curve));
  if (c < 1e-6) return x;
  const k = c * 6;
  return (1 - Math.exp(-k * x)) / (1 - Math.exp(-k));
}

/**
 * Enveloppe d'amplitude d'une note, en segments (s, depuis l'attaque). `noteLen` : durée tenue (mode
 * « tenue ») ; null = un seul coup (le sustain dure jusqu'à la fin du son). Attaque 0 = départ au
 * maximum ; décroissance 0 = saut direct au sustain.
 */
export function ampEnvelope(p: PadSamplerParams | undefined, peak: number, noteLen: number | null): EnvSeg[] {
  const s = smpOf(p);
  const A = Math.max(0, s.attack), H = Math.max(0, s.hold), D = Math.max(0, s.decay), S = Math.max(0, Math.min(1, s.sustain)) * peak;
  const segs: EnvSeg[] = [];
  let t = 0;
  if (A > 0) { segs.push({ t0: 0, t1: A, v0: 0, v1: peak, curve: s.attackCurve }); t = A; } else segs.push({ t0: 0, t1: 0, v0: peak, v1: peak, curve: 0 });
  if (H > 0) { segs.push({ t0: t, t1: t + H, v0: peak, v1: peak, curve: 0 }); t += H; }
  if (S !== peak) {
    if (D > 0) { segs.push({ t0: t, t1: t + D, v0: peak, v1: S, curve: s.decayCurve }); t += D; } else segs.push({ t0: t, t1: t, v0: S, v1: S, curve: 0 });
  }
  if (noteLen === null) return segs;
  // Note tenue : tout ce qui suit la fin de la note est coupé, puis relâchement depuis la valeur atteinte.
  const end = Math.max(0, noteLen);
  const cut: EnvSeg[] = [];
  for (const g of segs) {
    if (g.t0 >= end && !(g.t0 === 0 && g.t1 === 0)) break;
    if (g.t1 <= end) { cut.push(g); continue; }
    cut.push({ ...g, t1: end, v1: envValue([g], end) });
  }
  const from = envValue(cut, end);
  // Relâchement : 2 ms au moins (une coupe franche claque).
  const R = Math.max(MIN_RELEASE, s.release);
  cut.push({ t0: end, t1: end + R, v0: from, v1: 0, curve: s.releaseCurve });
  return cut;
}

/** Valeur de l'enveloppe à l'instant t (s). */
export function envValue(segs: EnvSeg[], t: number): number {
  let v = segs.length ? segs[0].v0 : 0;
  for (const g of segs) {
    if (t < g.t0) break;
    if (t >= g.t1) { v = g.v1; continue; }
    const x = (t - g.t0) / Math.max(1e-12, g.t1 - g.t0);
    return g.v0 + (g.v1 - g.v0) * shape(x, g.curve);
  }
  return v;
}

/** Fin de l'enveloppe (s) : fin du relâchement (note tenue), sinon null (le son va au bout). */
export function envEnd(segs: EnvSeg[], noteLen: number | null): number | null {
  return noteLen === null ? null : segs[segs.length - 1].t1;
}

/** Points d'une courbe pour `setValueCurveAtTime` (le dernier point est atteint pile à la fin). */
export function curvePoints(g: EnvSeg, n = 64): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = g.v0 + (g.v1 - g.v0) * shape(i / (n - 1), g.curve);
  return out;
}

/** Hauteur (demi-tons au-dessus de la hauteur de base) de l'enveloppe de hauteur à t (s) : droite en demi-tons. */
export function pitchEnvAt(p: PadSamplerParams | undefined, t: number): number {
  const s = smpOf(p);
  if (!s.pitchEnvAmt) return 0;
  const d = Math.max(1e-6, s.pitchEnvDecay);
  return t >= d ? 0 : s.pitchEnvAmt * (1 - t / d);
}

/** Enveloppe de filtre à t (s) : 0 → 1 en attaque, puis vers le sustain en décroissance (exponentielle). */
export function filterEnvAt(p: PadSamplerParams | undefined, t: number): number {
  const s = smpOf(p);
  const A = Math.max(0, s.filterAttack), D = Math.max(1e-6, s.filterDecay), S = Math.max(0, Math.min(1, s.filterSustain));
  if (t < A) return A > 0 ? t / A : 1;
  const x = Math.min(1, (t - A) / D);
  return 1 + (S - 1) * shape(x, 1);
}

// ── Filtre ─────────────────────────────────────────────────────────────────────────────

/** Une cellule biquad telle que le moteur la crée (`Q` dans l'unité de Web Audio : dB pour passe-bas / passe-haut). */
export interface BiquadSection { type: 'lowpass' | 'highpass' | 'bandpass'; Q: number }

/** Q de Butterworth d'ordre 4 (deux cellules) : −3,01 dB à la coupure. */
const BW4 = [1 / (2 * Math.cos(Math.PI / 8)), 1 / (2 * Math.cos((3 * Math.PI) / 8))];

/**
 * Cellules du filtre. Résonance 0 : Butterworth (−3,01 dB à la coupure en passe-bas / passe-haut,
 * 0 dB au centre en passe-bande) ; la résonance multiplie le Q de la dernière cellule (jusqu'à ×16).
 */
export function filterSections(type: FilterType, slope: 12 | 24, reso: number): BiquadSection[] {
  if (type === 'off') return [];
  const boost = Math.pow(2, Math.max(0, Math.min(1, reso)) * 4);
  if (type === 'bp') {
    const q = Math.SQRT1_2 * boost;
    return slope === 24 ? [{ type: 'bandpass', Q: q }, { type: 'bandpass', Q: q }] : [{ type: 'bandpass', Q: q }];
  }
  const t = type === 'lp' ? 'lowpass' : 'highpass';
  const qs = slope === 24 ? [BW4[0], BW4[1] * boost] : [Math.SQRT1_2 * boost];
  return qs.map(q => ({ type: t, Q: 20 * Math.log10(q) }));
}

/** Réponse en amplitude (dB) d'une cellule à la fréquence f, d'après les formules de la norme Web Audio. */
export function sectionGainDb(sec: BiquadSection, f0: number, f: number, sr: number): number {
  const w0 = (2 * Math.PI * f0) / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (sec.type === 'bandpass') {
    const al = sw / (2 * sec.Q);
    b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
  } else {
    const al = sw / (2 * Math.pow(10, sec.Q / 20));
    if (sec.type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; } else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
  }
  const w = (2 * Math.PI * f) / sr;
  const re = (c0: number, c1: number, c2: number) => c0 + c1 * Math.cos(-w) + c2 * Math.cos(-2 * w);
  const im = (c1: number, c2: number) => c1 * Math.sin(-w) + c2 * Math.sin(-2 * w);
  const num = Math.hypot(re(b0, b1, b2), im(b1, b2)), den = Math.hypot(re(a0, a1, a2), im(a1, a2));
  return 20 * Math.log10(num / den);
}

/** Coupure effective (Hz) d'une note à t : coupure × 2^(enveloppe + vélocité), bornée sous Nyquist. */
export function cutoffAt(p: PadSamplerParams | undefined, velocity: number, t: number, sr: number): number {
  const s = smpOf(p);
  const oct = s.filterEnvAmt * (s.filterEnvAmt ? filterEnvAt(p, t) : 0) + s.filterVel * velocity;
  return Math.max(20, Math.min(sr * 0.49, s.cutoff * Math.pow(2, oct)));
}

// ── Voix : hauteur, niveau, couche ─────────────────────────────────────────────────────

/** Hauteur de base d'une note (demi-tons) : accordage du pad + centièmes + suivi du pas + vélocité. */
export function noteSemis(p: PadSamplerParams | undefined, padTune: number, stepTune: number, velocity: number): number {
  const s = smpOf(p);
  return padTune + s.cents / 100 + s.keytrack * stepTune + s.velToPitch * velocity;
}

/** Niveau de crête d'une note (linéaire) : volume du pad × vélocité (selon le réglage) × gain. */
export function notePeak(p: PadSamplerParams | undefined, padVolume: number, velocity: number): number {
  const s = smpOf(p);
  const v = Math.max(0, Math.min(1, s.velToVol));
  return padVolume * (1 - v + v * velocity) * dbToGain(s.gainDb);
}

/** Couche jouée : par vélocité (du plus doux au plus fort, parts égales) ou en alternance. */
export function pickLayer(count: number, mode: 'vel' | 'rr' | undefined, velocity: number, rr: number): number {
  if (count <= 1) return 0;
  if (mode === 'rr') return ((Math.floor(rr) % count) + count) % count;
  return Math.max(0, Math.min(count - 1, Math.floor(Math.max(0, Math.min(1, velocity)) * count - 1e-9)));
}

// ── Traitement du son (calculé une fois, partagé lecture / export) ─────────────────────

/** Le son du pad doit-il être retraité (au-delà de la zone jouée) ? */
export function needsBake(p: PadSamplerParams | undefined, padTune = 0): boolean {
  if (!p) return false;
  const s = smpOf(p);
  return s.invert || s.normalize || s.drive > 0 || s.crushBits > 0 || s.crushDown > 1
    || (s.stretch && Math.abs(padTune + s.cents / 100) > 1e-9) || (s.loop && s.loopXfade > 0);
}

/** Clé de cache du traitement (vide sans traitement : la clé d'un ancien pad ne change pas). */
export function bakeKey(p: PadSamplerParams | undefined, padTune = 0): string {
  if (!needsBake(p, padTune)) return '';
  const s = smpOf(p);
  const st = s.stretch ? +(padTune + s.cents / 100).toFixed(4) : 0;
  return `smp:${s.invert ? 1 : 0},${s.normalize ? 1 : 0},${+s.drive.toFixed(4)},${s.crushBits},${s.crushDown},${st},${s.loop ? 1 : 0},${+s.loopStart.toFixed(5)},${+s.loopEnd.toFixed(5)},${+s.loopXfade.toFixed(4)}`;
}

/** Crête absolue d'un son (tous canaux). */
export function peakOf(ch: Float32Array[]): number {
  let pk = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) { const a = c[i] < 0 ? -c[i] : c[i]; if (a > pk) pk = a; }
  return pk;
}

/**
 * Étirement sans changer la hauteur (WSOLA : grains de 30 ms recalés sur la forme d'onde, fenêtres de
 * Hann à 50 %) : la durée est multipliée par `factor`, la période du son est gardée (pas de battement
 * de phase entre grains). Utilisé pour « garder la durée » quand on accorde le pad.
 */
export function timeStretch(ch: Float32Array[], sr: number, factor: number): Float32Array[] {
  if (Math.abs(factor - 1) < 1e-6) return ch.map(c => new Float32Array(c));
  const N = Math.max(256, Math.round(sr * 0.03) & ~1);
  const hs = N >> 1; // pas de synthèse (recouvrement 50 % : les fenêtres de Hann s'additionnent à 1)
  const ha = hs / factor; // pas d'analyse
  const tol = Math.round(sr * 0.008);
  const len = ch[0]?.length || 0;
  const outLen = Math.max(1, Math.round(len * factor));
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const mono = new Float32Array(len);
  ch.forEach(c => { for (let i = 0; i < len; i++) mono[i] += c[i] / ch.length; });
  const at = (i: number) => (i >= 0 && i < len ? mono[i] : 0);
  // Positions des grains : chacun prolonge au mieux le précédent (corrélation normalisée).
  const frames = Math.ceil(outLen / hs) + 1;
  const pos: number[] = [];
  let prev = 0;
  for (let k = 0; k < frames; k++) {
    const target = Math.round(k * ha);
    let p = target;
    if (k > 0) {
      const nat = prev + hs;
      let best = -Infinity;
      const score = (s0: number) => { let c = 0, e = 1e-12; for (let i = 0; i < hs; i += 2) { const v = at(s0 + i); c += v * at(nat + i); e += v * v; } return c / Math.sqrt(e); };
      for (let d = -tol; d <= tol; d += 2) { const s0 = target + d; if (s0 < 0) continue; const c = score(s0); if (c > best) { best = c; p = s0; } }
      for (const s0 of [p - 1, p + 1]) { if (s0 >= 0) { const c = score(s0); if (c > best) { best = c; p = s0; } } }
    }
    pos.push(p); prev = p;
  }
  return ch.map(x => {
    const y = new Float32Array(frames * hs + N);
    for (let k = 0; k < frames; k++) {
      const a = pos[k], o = k * hs;
      // 1er grain : pas de fondu d'entrée (l'attaque du son reste entière).
      for (let i = 0; i < N; i++) y[o + i] += (a + i < len && a + i >= 0 ? x[a + i] : 0) * (k === 0 && i < hs ? 1 : win[i]);
    }
    return y.slice(0, outLen);
  });
}

/**
 * Applique au son (déjà découpé à la zone jouée) : polarité, normalisation (crête à 0 dBFS), drive
 * (tanh, crête gardée), résolution (bits) et échantillonnage réduit, étirement (durée gardée), fondu
 * de boucle (puissance constante, avant la fin de boucle, avec ce qui précède le début de boucle).
 */
export function bakeChannels(ch: Float32Array[], sr: number, p: PadSamplerParams | undefined, padTune = 0): Float32Array[] {
  const s = smpOf(p);
  let out = ch.map(c => new Float32Array(c));
  if (s.invert) out.forEach(c => { for (let i = 0; i < c.length; i++) c[i] = -c[i]; });
  if (s.normalize) {
    const pk = peakOf(out);
    if (pk > 1e-9) { const g = 1 / pk; out.forEach(c => { for (let i = 0; i < c.length; i++) c[i] *= g; }); }
  }
  if (s.drive > 0) {
    const g = 1 + s.drive * 15, n = Math.tanh(g);
    out.forEach(c => { for (let i = 0; i < c.length; i++) c[i] = Math.tanh(g * c[i]) / n; });
  }
  if (s.crushDown > 1) {
    const R = Math.round(s.crushDown);
    out.forEach(c => { for (let i = 0; i < c.length; i++) c[i] = c[i - (i % R)]; });
  }
  if (s.crushBits > 0) {
    const q = Math.pow(2, Math.max(1, Math.round(s.crushBits)) - 1);
    out.forEach(c => { for (let i = 0; i < c.length; i++) c[i] = Math.round(c[i] * q) / q; });
  }
  const st = padTune + s.cents / 100;
  if (s.stretch && Math.abs(st) > 1e-9) out = timeStretch(out, sr, semisToRatio(st));
  if (s.loop && s.loopXfade > 0) {
    const len = out[0]?.length || 0;
    const L0 = Math.floor(Math.max(0, Math.min(1, s.loopStart)) * len), L1 = Math.floor(Math.max(0, Math.min(1, s.loopEnd)) * len);
    const xf = Math.min(Math.round(s.loopXfade * sr), L0, L1 - L0);
    if (xf > 1) out.forEach(c => {
      const pre = c.slice(L0 - xf, L0);
      for (let i = 0; i < xf; i++) {
        const w = (i + 1) / xf;
        const j = L1 - xf + i;
        c[j] = c[j] * Math.cos((w * Math.PI) / 2) + pre[i] * Math.sin((w * Math.PI) / 2);
      }
    });
  }
  return out;
}

/** Points de boucle (s) dans le son traité. */
export function loopTimes(p: PadSamplerParams | undefined, duration: number): { start: number; end: number } | null {
  const s = smpOf(p);
  if (!s.loop) return null;
  const a = Math.max(0, Math.min(1, s.loopStart)), b = Math.max(0, Math.min(1, s.loopEnd));
  if (b - a < 1e-4) return null;
  return { start: a * duration, end: b * duration };
}

/** Passage par zéro le plus proche de l'index i (±`span` échantillons), pour des coupes sans clic. */
export function nearestZeroCrossing(x: Float32Array, i: number, span: number): number {
  const at = (k: number) => k > 0 && k < x.length && ((x[k - 1] <= 0 && x[k] > 0) || (x[k - 1] >= 0 && x[k] < 0));
  for (let d = 0; d <= span; d++) {
    if (at(i - d)) return i - d;
    if (at(i + d)) return i + d;
  }
  return i;
}

// ── Presets de pad (sur cet appareil) ──────────────────────────────────────────────────

export interface PadPreset { id: string; name: string; smp: PadSamplerParams; tune?: number; decay?: number }
const PRESET_KEY = 'nova_pad_presets';

export function listPadPresets(): PadPreset[] {
  try {
    const a = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]');
    return Array.isArray(a) ? a.filter(x => x && typeof x.name === 'string').map(x => ({ ...x, smp: cleanSampler(x.smp) || {} })) : [];
  } catch { return []; }
}

export function savePadPreset(name: string, smp: PadSamplerParams | undefined, extra: { tune?: number; decay?: number } = {}): PadPreset | null {
  const n = name.trim().slice(0, 40);
  if (!n) return null;
  const p: PadPreset = { id: `pp${Date.now().toString(36)}`, name: n, smp: cleanSampler(smp) || {}, ...extra };
  try {
    const all = listPadPresets().filter(x => x.name !== n);
    localStorage.setItem(PRESET_KEY, JSON.stringify([...all, p].slice(-60)));
  } catch { return null; }
  return p;
}

export function deletePadPreset(id: string) {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(listPadPresets().filter(x => x.id !== id))); } catch { /* stockage bloqué */ }
}
