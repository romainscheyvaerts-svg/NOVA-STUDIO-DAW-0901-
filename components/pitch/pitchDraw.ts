/**
 * Nova Pitch · dessin de la grille (canvas) : clavier, lignes de la gamme,
 * grille du projet, forme d'onde, notes en « blocs » épaissis selon le niveau,
 * courbe de hauteur chantée et visée, tête de lecture.
 */
import { isInScale, noteNameFr } from '../../utils/scales';

export interface PitchPalette {
  bg: string; root: string; inKey: string; outKey: string; rowLine: string; bar: string; beat: string; sub: string;
  outside: string; wave: string; sung: string; target: string; ghost: string; selected: string; text: string; textSoft: string;
  playhead: string; preview: string; noteOk: string; noteNear: string; noteOff: string; noteEdited: string; label: string; handle: string;
  keysBg: string; keyBlack: string; keyWhite: string; keyMark: string; keyText: string; keyTextOff: string; unvoiced: string;
}

export const PITCH_DARK: PitchPalette = {
  bg: '#0b0d10', root: 'rgba(56,189,248,0.12)', inKey: 'rgba(56,189,248,0.05)', outKey: 'rgba(0,0,0,0.28)', rowLine: 'rgba(255,255,255,0.045)',
  bar: 'rgba(255,255,255,0.16)', beat: 'rgba(255,255,255,0.07)', sub: 'rgba(255,255,255,0.03)', outside: 'rgba(0,0,0,0.45)',
  wave: 'rgba(148,163,184,0.30)', sung: 'rgba(203,213,225,0.55)', target: '#7dd3fc', ghost: 'rgba(148,163,184,0.55)', selected: '#ffffff',
  text: '#e2e8f0', textSoft: 'rgba(148,163,184,0.85)', playhead: '#f472b6', preview: '#fbbf24',
  noteOk: '#38bdf8', noteNear: '#facc15', noteOff: '#fb7185', noteEdited: '#a78bfa', label: 'rgba(11,13,16,0.85)', handle: '#fde68a',
  keysBg: '#121418', keyBlack: '#1e2229', keyWhite: '#2a2f38', keyMark: '#38bdf8', keyText: '#e2e8f0', keyTextOff: '#64748b', unvoiced: 'rgba(251,191,36,0.10)',
};
export const PITCH_LIGHT: PitchPalette = {
  bg: '#f8fafc', root: 'rgba(3,105,161,0.14)', inKey: 'rgba(3,105,161,0.06)', outKey: 'rgba(15,23,42,0.05)', rowLine: 'rgba(15,23,42,0.07)',
  bar: 'rgba(15,23,42,0.22)', beat: 'rgba(15,23,42,0.10)', sub: 'rgba(15,23,42,0.045)', outside: 'rgba(100,116,139,0.22)',
  wave: 'rgba(71,85,105,0.30)', sung: 'rgba(71,85,105,0.55)', target: '#0369a1', ghost: 'rgba(71,85,105,0.6)', selected: '#0f172a',
  text: '#0f172a', textSoft: 'rgba(71,85,105,0.95)', playhead: '#db2777', preview: '#b45309',
  noteOk: '#0284c7', noteNear: '#ca8a04', noteOff: '#e11d48', noteEdited: '#7c3aed', label: 'rgba(255,255,255,0.92)', handle: '#b45309',
  keysBg: '#e2e8f0', keyBlack: '#cbd5e1', keyWhite: '#f1f5f9', keyMark: '#0369a1', keyText: '#0f172a', keyTextOff: '#64748b', unvoiced: 'rgba(180,83,9,0.08)',
};

/** Vue : temps à gauche (s), pixels par seconde, hauteur MIDI en haut, hauteur d'une ligne. */
export interface PitchView { t0: number; pps: number; top: number; rowH: number }

export const xOf = (v: PitchView, t: number) => (t - v.t0) * v.pps;
export const yOf = (v: PitchView, m: number) => (v.top - m) * v.rowH;
export const tOfX = (v: PitchView, x: number) => v.t0 + x / v.pps;
export const mOfY = (v: PitchView, y: number) => v.top - y / v.rowH;

/** Crêtes min / max par bloc de 128 échantillons (forme d'onde rapide à tout zoom). */
export interface Peaks { block: number; sr: number; start: number; min: Float32Array; max: Float32Array }

export function makePeaks(x: Float32Array, sr: number, start = 0, block = 128): Peaks {
  const n = Math.ceil(x.length / block);
  const min = new Float32Array(n), max = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    let lo = Infinity, hi = -Infinity;
    const e = Math.min(x.length, (b + 1) * block);
    for (let i = b * block; i < e; i++) { const s = x[i]; if (s < lo) lo = s; if (s > hi) hi = s; }
    min[b] = lo === Infinity ? 0 : lo; max[b] = hi === -Infinity ? 0 : hi;
  }
  return { block, sr, start, min, max };
}

export interface DrawNote {
  /** Début / fin dans le temps rendu (s, région). */
  a: number; b: number;
  /** Hauteur visée (MIDI). */
  m: number;
  /** Hauteur chantée (MIDI), pour le fantôme quand la note a bougé. */
  sung: number;
  /** Écart à la gamme (cents) de la hauteur visée. */
  cents: number;
  edited: boolean;
  selected: boolean;
  /** Épaisseur relative (0..1) par tranche de 10 ms, d'après le niveau. */
  body: Float32Array;
  label: string;
}

export interface DrawInput {
  w: number; h: number; v: PitchView; P: PitchPalette;
  key?: { root?: number; scale?: string };
  /** Lignes de la grille du projet (s, région) : mesures, temps, subdivisions. */
  grid: { t: number; kind: 0 | 1 | 2 }[];
  /** Partie jouée par le clip (s, région). */
  clip: { a: number; b: number };
  peaks?: Peaks | null;
  /** Courbes (MIDI) par trame de `hopSec`, dans le temps rendu. */
  sung?: Float32Array | null;
  target?: Float32Array | null;
  hopSec: number;
  notes: DrawNote[];
  /** Notes dont on montre les poignées (outil élastique). */
  handles: boolean;
  playhead?: number | null;
  preview?: number | null;
  rubber?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Repère de coupe (outil couper). */
  cutX?: number | null;
}

const noteColor = (P: PitchPalette, cents: number) => (Math.abs(cents) <= 8 ? P.noteOk : Math.abs(cents) <= 20 ? P.noteNear : P.noteOff);

export function drawGrid(ctx: CanvasRenderingContext2D, d: DrawInput) {
  const { w, h, v, P } = d;
  ctx.fillStyle = P.bg; ctx.fillRect(0, 0, w, h);
  const mLo = Math.floor(mOfY(v, h)) - 1, mHi = Math.ceil(v.top) + 1;
  for (let m = mLo; m <= mHi; m++) {
    const y = yOf(v, m) - v.rowH / 2;
    const known = typeof d.key?.root === 'number';
    const inKey = known && isInScale(m, d.key!.root!, d.key!.scale);
    const isRoot = known && (((m - d.key!.root!) % 12) + 12) % 12 === 0;
    ctx.fillStyle = isRoot ? P.root : inKey ? P.inKey : P.outKey;
    ctx.fillRect(0, y, w, v.rowH);
    ctx.fillStyle = P.rowLine; ctx.fillRect(0, y, w, 1);
  }
  for (const g of d.grid) {
    const x = Math.round(xOf(v, g.t));
    if (x < 0 || x > w) continue;
    ctx.fillStyle = g.kind === 0 ? P.bar : g.kind === 1 ? P.beat : P.sub;
    ctx.fillRect(x, 0, 1, h);
  }
  // Hors du clip (marge d'analyse) : assombri.
  const ca = xOf(v, d.clip.a), cb = xOf(v, d.clip.b);
  ctx.fillStyle = P.outside;
  if (ca > 0) ctx.fillRect(0, 0, Math.min(w, ca), h);
  if (cb < w) ctx.fillRect(Math.max(0, cb), 0, w - Math.max(0, cb), h);
}

export function drawWave(ctx: CanvasRenderingContext2D, d: DrawInput) {
  const p = d.peaks;
  if (!p) return;
  const { w, h, v, P } = d;
  const band = Math.max(26, h * 0.2), mid = h - band / 2;
  ctx.fillStyle = P.wave;
  const spp = p.sr / v.pps; // échantillons par pixel
  for (let x = 0; x < w; x++) {
    const t = tOfX(v, x);
    const s0 = Math.floor(t * p.sr) - p.start, s1 = Math.floor((t + 1 / v.pps) * p.sr) - p.start;
    if (s1 < 0) continue;
    const b0 = Math.max(0, Math.floor(s0 / p.block)), b1 = Math.min(p.min.length - 1, Math.floor(Math.max(s0, s1 - 1) / p.block));
    if (b0 > b1 || b0 >= p.min.length) continue;
    let lo = 0, hi = 0;
    for (let b = b0; b <= b1; b++) { if (p.min[b] < lo) lo = p.min[b]; if (p.max[b] > hi) hi = p.max[b]; }
    const y0 = mid - hi * band * 0.5, y1 = mid - lo * band * 0.5;
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    void spp;
  }
}

function drawCurve(ctx: CanvasRenderingContext2D, d: DrawInput, c: Float32Array, color: string, lw: number) {
  const { w, v } = d;
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.beginPath();
  const i0 = Math.max(0, Math.floor(v.t0 / d.hopSec) - 1), i1 = Math.min(c.length, Math.ceil(tOfX(v, w) / d.hopSec) + 2);
  let pen = false;
  for (let i = i0; i < i1; i++) {
    const m = c[i];
    if (Number.isNaN(m)) { pen = false; continue; }
    const x = xOf(v, i * d.hopSec), y = yOf(v, m);
    if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
  }
  ctx.stroke();
}

export function drawNotes(ctx: CanvasRenderingContext2D, d: DrawInput) {
  const { v, P, w } = d;
  const thick = Math.max(6, v.rowH * 0.95);
  for (const n of d.notes) {
    const x0 = xOf(v, n.a), x1 = xOf(v, n.b);
    if (x1 < -2 || x0 > w + 2) continue;
    // Fantôme : hauteur chantée quand la note a été déplacée.
    if (Math.abs(n.m - n.sung) > 0.005) {
      ctx.setLineDash([4, 3]); ctx.strokeStyle = P.ghost; ctx.lineWidth = 1;
      const hy = Math.max(5, v.rowH * 0.5);
      ctx.beginPath(); ctx.roundRect(x0, yOf(v, n.sung) - hy / 2, Math.max(2, x1 - x0), hy, Math.min(6, hy / 2)); ctx.stroke(); ctx.setLineDash([]);
    }
    // Bloc épaissi selon le niveau (comme une forme d'onde posée sur la note).
    const yc = yOf(v, n.m);
    const color = n.edited ? P.noteEdited : noteColor(P, n.cents);
    ctx.fillStyle = color;
    ctx.globalAlpha = n.selected ? 0.85 : 0.55;
    ctx.beginPath();
    const steps = Math.max(2, n.body.length);
    const seg = (x1 - x0) / steps;
    const half = (k: number) => Math.max(2.5, (0.22 + 0.78 * n.body[Math.min(n.body.length - 1, k)]) * thick / 2);
    ctx.moveTo(x0, yc);
    for (let k = 0; k < steps; k++) ctx.lineTo(x0 + (k + 0.5) * seg, yc - half(k));
    ctx.lineTo(x1, yc);
    for (let k = steps - 1; k >= 0; k--) ctx.lineTo(x0 + (k + 0.5) * seg, yc + half(k));
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
    if (n.selected) { ctx.strokeStyle = P.selected; ctx.lineWidth = 1.5; ctx.stroke(); }
    if (d.handles && x1 - x0 > 10) {
      ctx.fillStyle = P.handle;
      const hh = Math.max(10, v.rowH * 0.9);
      ctx.fillRect(x0, yc - hh / 2, 3, hh);
      ctx.fillRect(x1 - 3, yc - hh / 2, 3, hh);
    }
  }
}

export function drawLabels(ctx: CanvasRenderingContext2D, d: DrawInput) {
  const { v, P, w } = d;
  const fs = Math.max(9, Math.min(12, v.rowH * 0.6));
  ctx.font = `700 ${fs}px ui-sans-serif, system-ui`; ctx.textBaseline = 'middle';
  for (const n of d.notes) {
    const x0 = xOf(v, n.a), x1 = xOf(v, n.b);
    if (x1 < 0 || x0 > w || x1 - x0 < 30) continue;
    const text = x1 - x0 > 70 || n.selected ? n.label : n.label.split(' ').slice(-2).join(' ');
    const tw = ctx.measureText(text).width;
    const ty = yOf(v, n.m) - Math.max(6, v.rowH * 0.95) / 2 - fs * 0.8;
    const lx = Math.max(2, x0);
    ctx.fillStyle = P.label;
    ctx.beginPath(); ctx.roundRect(lx, ty - fs * 0.65, tw + 8, fs * 1.3, 4); ctx.fill();
    ctx.fillStyle = n.edited ? P.noteEdited : noteColor(P, n.cents);
    ctx.fillText(text, lx + 4, ty);
  }
}

export function drawAll(ctx: CanvasRenderingContext2D, d: DrawInput) {
  drawGrid(ctx, d);
  drawWave(ctx, d);
  drawNotes(ctx, d);
  if (d.sung) drawCurve(ctx, d, d.sung, d.P.sung, 1.2);
  if (d.target) drawCurve(ctx, d, d.target, d.P.target, 1.8);
  drawLabels(ctx, d);
  const { v, P, h } = d;
  if (d.cutX !== null && d.cutX !== undefined) { ctx.fillStyle = P.handle; ctx.fillRect(Math.round(d.cutX), 0, 1, h); }
  if (d.preview !== null && d.preview !== undefined) { ctx.fillStyle = P.preview; ctx.fillRect(Math.round(xOf(v, d.preview)), 0, 2, h); }
  if (d.playhead !== null && d.playhead !== undefined) { ctx.fillStyle = P.playhead; ctx.fillRect(Math.round(xOf(v, d.playhead)), 0, 2, h); }
  const r = d.rubber;
  if (r) {
    ctx.strokeStyle = P.selected; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.strokeRect(Math.min(r.x0, r.x1) + 0.5, Math.min(r.y0, r.y1) + 0.5, Math.abs(r.x1 - r.x0), Math.abs(r.y1 - r.y0));
    ctx.setLineDash([]);
  }
}

/** Clavier vertical (noms des notes, gamme marquée). */
export function drawKeys(ctx: CanvasRenderingContext2D, W: number, H: number, v: PitchView, P: PitchPalette, key?: { root?: number; scale?: string }) {
  ctx.fillStyle = P.keysBg; ctx.fillRect(0, 0, W, H);
  ctx.font = `${Math.max(8, Math.min(11, v.rowH * 0.6))}px ui-sans-serif, system-ui`; ctx.textBaseline = 'middle';
  const mLo = Math.floor(mOfY(v, H)) - 1, mHi = Math.ceil(v.top) + 1;
  for (let m = mLo; m <= mHi; m++) {
    const y = yOf(v, m);
    const black = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
    const inKey = typeof key?.root === 'number' && isInScale(m, key.root, key.scale);
    ctx.fillStyle = black ? P.keyBlack : P.keyWhite;
    ctx.fillRect(0, y - v.rowH / 2, W, v.rowH - 1);
    if (inKey) { ctx.fillStyle = P.keyMark; ctx.fillRect(W - 3, y - v.rowH / 2, 3, v.rowH - 1); }
    if (v.rowH >= 9 || ((m % 12) + 12) % 12 === 0) { ctx.fillStyle = inKey ? P.keyText : P.keyTextOff; ctx.fillText(noteNameFr(m), 4, y); }
  }
}
