/**
 * Outils de mesure du banc de métrologie (22/10/2026) : niveaux, fréquence,
 * temps d'arrivée, temps de réverbération, et le journal « affiché → mesuré ».
 *
 * Le journal (`metro`) est écrit dans le fichier JSON désigné par METRO_JSON à la
 * fin de chaque fichier de test (`flushMetroLog`) : le rapport en est tiré.
 */
import fs from 'fs';
import path from 'path';

export const dB = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
export const fromDb = (d: number) => Math.pow(10, d / 20);

export function sine(sr: number, seconds: number, f: number, amp = 1, phase = 0): Float32Array {
  const n = Math.round(sr * seconds), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / sr + phase);
  return x;
}

export function rms(x: ArrayLike<number>, a = 0, b = x.length): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

export function peak(x: ArrayLike<number>, a = 0, b = x.length): number {
  let m = 0;
  for (let i = a; i < b; i++) { const v = Math.abs(x[i]); if (v > m) m = v; }
  return m;
}

/** Amplitude et phase de la composante à f (moindres carrés sur [a, b), nombre entier de périodes conseillé). */
export function toneAt(x: ArrayLike<number>, sr: number, f: number, a = 0, b = x.length): { amp: number; phase: number } {
  let sc = 0, ss = 0, cc = 0, cs = 0, nn = 0;
  for (let i = a; i < b; i++) {
    const w = 2 * Math.PI * f * i / sr, c = Math.cos(w), s = Math.sin(w);
    sc += x[i] * c; ss += x[i] * s; cc += c * c; cs += s * s; nn++;
  }
  const A = sc / Math.max(1e-12, cc), B = ss / Math.max(1e-12, cs);
  return { amp: Math.hypot(A, B), phase: Math.atan2(A, B) };
}

/**
 * Fréquence d'un son quasi sinusoïdal : passages par zéro montants interpolés,
 * pente moyenne (moindres carrés) sur [a, b). Précision ~0,01 cent sur 1 s de sinus pur.
 */
export function freqOf(x: ArrayLike<number>, sr: number, a = 0, b = x.length): number {
  const zc: number[] = [];
  for (let i = Math.max(1, a); i < b; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) zc.push(i - 1 + (-x[i - 1]) / (x[i] - x[i - 1]));
  }
  if (zc.length < 3) return NaN;
  const n = zc.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let k = 0; k < n; k++) { sx += k; sy += zc[k]; sxx += k * k; sxy += k * zc[k]; }
  const period = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return sr / period;
}

export const cents = (f: number, ref: number) => 1200 * Math.log2(f / ref);

/** Premier échantillon où |x| dépasse `thr` (index, ou -1). */
export function onset(x: ArrayLike<number>, thr: number, from = 0): number {
  for (let i = from; i < x.length; i++) if (Math.abs(x[i]) > thr) return i;
  return -1;
}

/** Index du maximum de |x|. */
export function argmaxAbs(x: ArrayLike<number>, a = 0, b = x.length): number {
  let m = -1, k = -1;
  for (let i = a; i < b; i++) { const v = Math.abs(x[i]); if (v > m) { m = v; k = i; } }
  return k;
}

/** Biquad RBJ simple (filtre de bande d'octave pour le RT60). */
function bandpass(x: Float32Array, sr: number, f0: number, Q: number): Float32Array {
  const w = 2 * Math.PI * f0 / sr, al = Math.sin(w) / (2 * Q), c = Math.cos(w), a0 = 1 + al;
  const b0 = al / a0, b2 = -al / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/**
 * Temps de réverbération (ISO 3382) d'une réponse impulsionnelle : bande d'octave
 * autour de `f0` (deux passe-bandes en cascade), intégrale de Schroeder, droite
 * des moindres carrés entre −5 et −35 dB (T30), extrapolée à −60 dB.
 */
export function rt60(ir: Float32Array, sr: number, f0: number, from = -5, to = -35): number {
  const y = f0 > 0 ? bandpass(bandpass(ir, sr, f0, Math.SQRT2), sr, f0, Math.SQRT2) : ir;
  const e = new Float64Array(y.length);
  let acc = 0;
  for (let i = y.length - 1; i >= 0; i--) { acc += y[i] * y[i]; e[i] = acc; }
  const e0 = e[0];
  const L = (i: number) => 10 * Math.log10(e[i] / e0 + 1e-30);
  let i1 = 0; while (i1 < y.length && L(i1) > from) i1++;
  let i2 = i1; while (i2 < y.length && L(i2) > to) i2++;
  if (i2 >= y.length - 1) return NaN;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let i = i1; i <= i2; i++) { const t = i / sr, v = L(i); sx += t; sy += v; sxx += t * t; sxy += t * v; n++; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx); // dB / s
  return -60 / slope;
}

/** Corrélation de phase de deux canaux. */
export function correlation(L: ArrayLike<number>, R: ArrayLike<number>, a = 0, b = L.length): number {
  let lr = 0, ll = 0, rr = 0;
  for (let i = a; i < b; i++) { lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i]; }
  return lr / Math.sqrt(ll * rr || 1e-30);
}

// ───────────────────── Journal « affiché → mesuré » ─────────────────────

export interface MetroRow {
  /** Effet, mètre ou fonction de console. */
  sujet: string;
  /** Réglage (et contexte : fréquence d'échantillonnage, tempo…). */
  reglage: string;
  affiche: string;
  mesure: string;
  ecart: string;
  tolerance: string;
  ok: boolean;
}

const rows: MetroRow[] = [];
/** Mesures hors tolérance depuis le dernier assertMetro(). */
let failed: MetroRow[] = [];

/** Ajoute une ligne au journal et renvoie `ok` (pour expect). */
export function metro(sujet: string, reglage: string, affiche: number | string, mesure: number | string, unite: string, tol: number | null, ecartVal?: number, fmt = 3): boolean {
  const num = (v: number | string) => (typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(fmt) : String(v)) : v);
  const e = ecartVal ?? (typeof affiche === 'number' && typeof mesure === 'number' ? mesure - affiche : NaN);
  const ok = tol === null ? true : Number.isFinite(e) && Math.abs(e) <= tol;
  rows.push({
    sujet, reglage,
    affiche: `${num(affiche)}${unite ? ' ' + unite : ''}`,
    mesure: `${num(mesure)}${unite ? ' ' + unite : ''}`,
    ecart: Number.isFinite(e) ? `${e >= 0 ? '+' : ''}${e.toFixed(fmt)}${unite ? ' ' + unite : ''}` : '—',
    tolerance: tol === null ? 'info' : `±${tol} ${unite}`.trim(),
    ok,
  });
  if (!ok) failed.push(rows[rows.length - 1]);
  return ok;
}

/** Échoue (une seule fois, avec la liste) si une mesure est sortie de sa tolérance depuis le dernier appel. */
export function assertMetro() {
  const f = failed;
  failed = [];
  const NL = String.fromCharCode(10);
  if (f.length) throw new Error(`Hors tolérance (${f.length}) :${NL}` + f.map(r => `  ${r.sujet} | ${r.reglage} : affiché ${r.affiche} → mesuré ${r.mesure} (écart ${r.ecart}, tolérance ${r.tolerance})`).join(NL));
}

/** Écrit le journal du fichier de test (fusionné avec les autres fichiers du banc). */
export function flushMetroLog(file: string) {
  // Seulement sur demande (METRO_JSON=chemin) : la suite normale n'écrit rien sur le disque.
  const target = process.env.METRO_JSON;
  if (!target) return;
  const out = path.resolve(target);
  let all: Record<string, MetroRow[]> = {};
  try { all = JSON.parse(fs.readFileSync(out, 'utf-8')); } catch { /* premier fichier */ }
  all[file] = rows.slice();
  try { fs.writeFileSync(out, JSON.stringify(all, null, 1)); } catch { /* disque en lecture seule : le test reste valable */ }
}
