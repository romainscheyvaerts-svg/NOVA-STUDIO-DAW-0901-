/**
 * Lot 2a · Dessin d'une image du clip vertical (1080 × 1920), le même pour l'aperçu de la
 * fenêtre et pour l'export : styles de paroles, fonds, titre, artiste, logo NOVA discret.
 */
import { CLIP_H, CLIP_W, lyricsAt, type ClipLine } from './lyricVideo';

export type ClipStyle = 'tiktok' | 'neon' | 'minimal' | 'tombent';
export type ClipBackground = 'degrade' | 'couleur' | 'image' | 'visualiseur';

export const CLIP_STYLES: { id: ClipStyle; label: string; hint: string }[] = [
  { id: 'tiktok', label: 'Gros sous-titres', hint: 'Le mot chanté passe en jaune, comme sur TikTok' },
  { id: 'neon', label: 'Néon', hint: 'Les mots s’allument au fur et à mesure' },
  { id: 'minimal', label: 'Minimal', hint: 'Sobre, en bas de l’écran' },
  { id: 'tombent', label: 'Paroles qui tombent', hint: 'Chaque mot tombe quand il est chanté' },
];

export const CLIP_BACKGROUNDS: { id: ClipBackground; label: string }[] = [
  { id: 'degrade', label: 'Dégradé animé' },
  { id: 'couleur', label: 'Couleur unie' },
  { id: 'image', label: 'Pochette / image' },
  { id: 'visualiseur', label: 'Visualiseur' },
];

export interface ClipPalette { name: string; a: string; b: string; accent: string }
export const CLIP_PALETTES: ClipPalette[] = [
  { name: 'Nuit', a: '#0b1026', b: '#5b21b6', accent: '#22d3ee' },
  { name: 'Coucher de soleil', a: '#c2410c', b: '#9d174d', accent: '#fde047' },
  { name: 'Océan', a: '#0e7490', b: '#172554', accent: '#67e8f9' },
  { name: 'Forêt', a: '#064e3b', b: '#0b1220', accent: '#a3e635' },
  { name: 'Noir', a: '#050505', b: '#27272a', accent: '#facc15' },
];

/** Jaune du mot chanté (style « Gros sous-titres ») : repéré par la QA sur les images du clip. */
export const TIKTOK_YELLOW = '#FFE14D';

export interface ClipLook {
  style: ClipStyle;
  background: ClipBackground;
  palette: number;
  title: string;
  artist: string;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Img = CanvasImageSource & { width: number; height: number };

export interface ClipFrameInput {
  /** Temps du morceau (s). */
  t: number;
  /** Temps depuis le début du clip (s) et durée du clip. */
  clipT: number;
  duration: number;
  lines: ClipLine[];
  spectrum: { bands: Float32Array; level: number } | null;
  /** Fond flouté préparé (prepareBackdrop) et pochette nette (prepareCover). */
  backdrop: Img | null;
  cover: Img | null;
}

const FONT = 'Inter, "Segoe UI", system-ui, sans-serif';

export function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function coverRect(iw: number, ih: number, w: number, h: number) {
  const s = Math.max(w / iw, h / ih);
  return { x: (w - iw * s) / 2, y: (h - ih * s) / 2, w: iw * s, h: ih * s };
}

/** Fond flouté (réduction puis agrandissement : flou sans filtre, rapide partout). */
export function prepareBackdrop(img: Img): Img {
  const small = makeCanvas(27, 48);
  const sg = small.getContext('2d') as Ctx;
  const r = coverRect(img.width, img.height, 27, 48);
  sg.drawImage(img, r.x, r.y, r.w, r.h);
  const mid = makeCanvas(135, 240);
  const mg = mid.getContext('2d') as Ctx;
  mg.imageSmoothingEnabled = true;
  mg.drawImage(small as any, 0, 0, 135, 240);
  const big = makeCanvas(CLIP_W, CLIP_H);
  const bg = big.getContext('2d') as Ctx;
  bg.imageSmoothingEnabled = true;
  (bg as any).imageSmoothingQuality = 'high';
  bg.drawImage(mid as any, 0, 0, CLIP_W, CLIP_H);
  return big as unknown as Img;
}

/** Pochette carrée nette aux coins arrondis (620 px). */
export function prepareCover(img: Img, size = 620): Img {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d') as Ctx;
  roundRect(g, 0, 0, size, size, 44);
  g.clip();
  const r = coverRect(img.width, img.height, size, size);
  g.drawImage(img, r.x, r.y, r.w, r.h);
  return c as unknown as Img;
}

function roundRect(g: Ctx, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex: string, a: number) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };

// ── Fonds ────────────────────────────────────────────────────────────────────

function drawBackground(g: Ctx, look: ClipLook, f: ClipFrameInput, pal: ClipPalette) {
  const level = f.spectrum?.level ?? 0;
  if (look.background === 'couleur') {
    g.fillStyle = pal.a; g.fillRect(0, 0, CLIP_W, CLIP_H);
    const v = g.createRadialGradient(CLIP_W / 2, CLIP_H / 2, 200, CLIP_W / 2, CLIP_H / 2, 1250);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = v; g.fillRect(0, 0, CLIP_W, CLIP_H);
    return;
  }
  if (look.background === 'image' && f.backdrop) {
    const z = 1 + 0.06 * (f.clipT / Math.max(1, f.duration));
    const w = CLIP_W * z, h = CLIP_H * z;
    g.drawImage(f.backdrop, (CLIP_W - w) / 2, (CLIP_H - h) / 2, w, h);
    g.fillStyle = 'rgba(0,0,0,0.42)'; g.fillRect(0, 0, CLIP_W, CLIP_H);
    return;
  }
  // Dégradé animé (aussi sous le visualiseur et quand l'image manque).
  const ang = (f.clipT / 18) * Math.PI * 2;
  const cx = CLIP_W / 2, cy = CLIP_H / 2, rad = 1100;
  const lg = g.createLinearGradient(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, cx - Math.cos(ang) * rad, cy - Math.sin(ang) * rad);
  const dim = look.background === 'visualiseur' ? 0.55 : 1;
  lg.addColorStop(0, rgba(pal.a, 1)); lg.addColorStop(1, rgba(pal.b, 1));
  g.fillStyle = lg; g.fillRect(0, 0, CLIP_W, CLIP_H);
  if (dim < 1) { g.fillStyle = `rgba(0,0,0,${1 - dim})`; g.fillRect(0, 0, CLIP_W, CLIP_H); }
  // Halo qui respire avec le son.
  const hx = cx + Math.cos(ang * 0.7) * 260, hy = cy * 0.8 + Math.sin(ang * 0.5) * 300;
  const halo = g.createRadialGradient(hx, hy, 40, hx, hy, 700 + 260 * level);
  halo.addColorStop(0, rgba(pal.accent, 0.16 + 0.22 * level)); halo.addColorStop(1, rgba(pal.accent, 0));
  g.fillStyle = halo; g.fillRect(0, 0, CLIP_W, CLIP_H);
}

const VIS_CY = 700;

function drawVisualizer(g: Ctx, f: ClipFrameInput, pal: ClipPalette) {
  const bands = f.spectrum?.bands;
  const level = f.spectrum?.level ?? 0;
  const cx = CLIP_W / 2, cy = VIS_CY, r0 = 230 + 18 * level;
  const n = bands ? bands.length : 48;
  g.save();
  g.lineCap = 'round';
  for (let i = 0; i < n * 2; i++) {
    const b = i < n ? i : 2 * n - 1 - i;
    const v = bands ? bands[b] : 0.15 + 0.1 * Math.sin(f.clipT * 3 + i);
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    const len = 14 + v * 210;
    const k = b / (n - 1);
    g.strokeStyle = k < 0.5 ? rgba(pal.accent, 0.55 + 0.45 * v) : rgba('#ffffff', 0.35 + 0.5 * v);
    g.lineWidth = 11;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    g.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
    g.stroke();
  }
  g.restore();
  // Disque central : pochette (si dispo) ou couleur.
  g.save();
  g.beginPath(); g.arc(cx, cy, r0 - 16, 0, Math.PI * 2); g.closePath();
  if (f.cover) {
    g.clip();
    g.drawImage(f.cover, cx - (r0 - 16), cy - (r0 - 16), (r0 - 16) * 2, (r0 - 16) * 2);
  } else {
    const rg = g.createRadialGradient(cx, cy, 10, cx, cy, r0);
    rg.addColorStop(0, rgba(pal.accent, 0.35)); rg.addColorStop(1, rgba(pal.b, 0.9));
    g.fillStyle = rg; g.fill();
  }
  g.restore();
}

function drawCoverCard(g: Ctx, f: ClipFrameInput) {
  if (!f.cover) return;
  const s = 620, x = (CLIP_W - s) / 2, y = 400;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 50; g.shadowOffsetY = 18;
  g.fillStyle = '#000'; roundRect(g, x, y, s, s, 44); g.fill();
  g.restore();
  g.drawImage(f.cover, x, y, s, s);
}

// ── Titre, artiste, logo, progression ───────────────────────────────────────

function fitFont(g: Ctx, text: string, weight: number, size: number, maxW: number, min = 28): number {
  let s = size;
  for (; s > min; s -= 2) { g.font = `${weight} ${s}px ${FONT}`; if (g.measureText(text).width <= maxW) break; }
  g.font = `${weight} ${s}px ${FONT}`;
  return s;
}

function drawHeader(g: Ctx, look: ClipLook, pal: ClipPalette) {
  g.save();
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const artist = (look.artist || '').trim();
  const title = (look.title || '').trim();
  if (artist) {
    fitFont(g, artist.toUpperCase(), 700, 36, 880);
    (g as any).letterSpacing = '6px';
    g.fillStyle = rgba(pal.accent, 0.95);
    g.fillText(artist.toUpperCase(), CLIP_W / 2, 200);
    (g as any).letterSpacing = '0px';
  }
  if (title) {
    fitFont(g, title, 900, 70, 900, 36);
    g.fillStyle = '#ffffff';
    g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 16;
    g.fillText(title, CLIP_W / 2, artist ? 290 : 250);
  }
  g.restore();
}

/** Petit logo NOVA discret (en bas, au-dessus de la zone des boutons de TikTok / Reels). */
function drawLogo(g: Ctx) {
  g.save();
  g.globalAlpha = 0.55;
  const x = CLIP_W / 2, y = 1712;
  g.font = `900 30px ${FONT}`;
  (g as any).letterSpacing = '8px';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const w = g.measureText('NOVA').width;
  // Pastille (orbite) devant le mot.
  g.strokeStyle = '#ffffff'; g.lineWidth = 3;
  g.beginPath(); g.arc(x - w / 2 - 22, y, 11, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(x - w / 2 - 22, y, 4, 0, Math.PI * 2); g.fill();
  g.fillText('NOVA', x + 4, y + 1);
  (g as any).letterSpacing = '0px';
  g.restore();
}

function drawProgress(g: Ctx, f: ClipFrameInput, pal: ClipPalette) {
  const p = Math.max(0, Math.min(1, f.clipT / Math.max(0.01, f.duration)));
  const x = 140, w = CLIP_W - 280, y = 1640;
  g.fillStyle = 'rgba(255,255,255,0.16)'; g.fillRect(x, y, w, 5);
  g.fillStyle = rgba(pal.accent, 0.9); g.fillRect(x, y, w * p, 5);
}

// ── Paroles ──────────────────────────────────────────────────────────────────

interface Placed { k: number; x: number; y: number; w: number }

/** Mots répartis en lignes centrées (ou à gauche) dans la largeur donnée. */
function layoutWords(g: Ctx, words: string[], font: string, maxW: number, lineH: number, cy: number, align: 'center' | 'left', left = 110, extraGap = 0): Placed[] {
  g.font = font;
  const space = g.measureText(' ').width + extraGap;
  const rows: { k: number; w: number }[][] = [[]];
  let rowW = 0;
  words.forEach((w, k) => {
    const ww = g.measureText(w).width;
    const cur = rows[rows.length - 1];
    if (cur.length && rowW + space + ww > maxW) { rows.push([{ k, w: ww }]); rowW = ww; }
    else { cur.push({ k, w: ww }); rowW += (cur.length > 1 ? space : 0) + ww; }
  });
  const out: Placed[] = [];
  const top = cy - ((rows.length - 1) * lineH) / 2;
  rows.forEach((row, r) => {
    const total = row.reduce((a, x) => a + x.w, 0) + space * (row.length - 1);
    let x = align === 'center' ? (CLIP_W - total) / 2 : left;
    row.forEach(it => { out.push({ k: it.k, x, y: top + r * lineH, w: it.w }); x += it.w + space; });
  });
  return out;
}

/** Taille de police qui tient en `maxRows` lignes au plus. */
function fitWords(g: Ctx, words: string[], weight: number, size: number, maxW: number, maxRows: number, min = 44, gapRatio = 0): number {
  for (let s = size; s >= min; s -= 4) {
    g.font = `${weight} ${s}px ${FONT}`;
    const space = g.measureText(' ').width + s * gapRatio;
    let rows = 1, rowW = 0;
    for (const w of words) {
      const ww = g.measureText(w).width;
      if (rowW && rowW + space + ww > maxW) { rows++; rowW = ww; } else rowW += (rowW ? space : 0) + ww;
    }
    if (rows <= maxRows) return s;
  }
  return min;
}

const easeOutBack = (x: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

function lyricsCenterY(look: ClipLook): number {
  if (look.style === 'minimal') return 1380;
  return look.background === 'image' || look.background === 'visualiseur' ? 1300 : 1000;
}

function drawLyrics(g: Ctx, look: ClipLook, f: ClipFrameInput, pal: ClipPalette, cyOverride?: number) {
  const fr = lyricsAt(f.lines, f.t);
  if (fr.line < 0) return;
  const line = f.lines[fr.line];
  const words = line.words.map(w => w.text);
  const cy = cyOverride ?? lyricsCenterY(look);
  const appear = Math.min(1, fr.sinceShow / 0.18);
  g.save();
  g.textBaseline = 'middle'; g.textAlign = 'left';

  if (look.style === 'tiktok') {
    const size = fitWords(g, words, 900, 96, 900, 3, 44, 0.16);
    const font = `900 ${size}px ${FONT}`;
    const placed = layoutWords(g, words, font, 900, size * 1.22, cy, 'center', 110, size * 0.16);
    g.globalAlpha = appear;
    g.lineJoin = 'round';
    for (const p of placed) {
      const cur = p.k === fr.sung;
      const sc = cur ? 1 + 0.08 * Math.sin(Math.min(1, fr.wordProgress * 3) * Math.PI / 2) : 1;
      g.save();
      g.translate(p.x + p.w / 2, p.y);
      g.scale(sc, sc);
      g.font = font;
      g.lineWidth = Math.max(10, size * 0.16);
      g.strokeStyle = '#000000';
      g.strokeText(words[p.k], -p.w / 2, 0);
      g.fillStyle = cur ? TIKTOK_YELLOW : '#ffffff';
      g.fillText(words[p.k], -p.w / 2, 0);
      g.restore();
    }
  } else if (look.style === 'neon') {
    const size = fitWords(g, words, 800, 86, 900, 3);
    const font = `800 ${size}px ${FONT}`;
    const placed = layoutWords(g, words, font, 900, size * 1.25, cy, 'center');
    g.font = font;
    for (const p of placed) {
      const sung = p.k <= fr.sung;
      const cur = p.k === fr.sung;
      g.globalAlpha = appear;
      if (!sung) {
        g.lineWidth = 2.5; g.strokeStyle = rgba(pal.accent, 0.45);
        g.strokeText(words[p.k], p.x, p.y);
      } else {
        g.save();
        g.shadowColor = pal.accent; g.shadowBlur = cur ? 34 : 18;
        g.fillStyle = cur ? '#ffffff' : rgba(pal.accent, 1);
        g.fillText(words[p.k], p.x, p.y);
        g.restore();
      }
    }
    // Ligne suivante en aperçu, très discrète.
    if (fr.next >= 0) {
      const nw = f.lines[fr.next].words.map(w => w.text);
      const ns = Math.round(size * 0.5);
      const np = layoutWords(g, nw, `700 ${ns}px ${FONT}`, 860, ns * 1.2, cy + size * 1.25 * 1.6 + 40, 'center');
      g.globalAlpha = 0.28; g.fillStyle = '#ffffff';
      for (const p of np) g.fillText(nw[p.k], p.x, p.y);
    }
  } else if (look.style === 'minimal') {
    const size = fitWords(g, words, 600, 66, 860, 3, 40);
    const font = `600 ${size}px ${FONT}`;
    const placed = layoutWords(g, words, font, 860, size * 1.3, cy, 'left', 110);
    g.font = font;
    g.fillStyle = rgba(pal.accent, 0.9);
    g.fillRect(110, Math.min(...placed.map(p => p.y)) - size * 0.95, 64, 6);
    for (const p of placed) {
      g.globalAlpha = appear * (p.k <= fr.sung ? 1 : 0.38);
      g.fillStyle = '#ffffff';
      g.fillText(words[p.k], p.x, p.y);
    }
    if (fr.next >= 0) {
      const nw = f.lines[fr.next].words.map(w => w.text);
      const ns = Math.round(size * 0.62);
      const np = layoutWords(g, nw, `500 ${ns}px ${FONT}`, 860, ns * 1.3, Math.max(...placed.map(p => p.y)) + size * 1.25 + ns, 'left', 110);
      g.globalAlpha = 0.3;
      for (const p of np) g.fillText(nw[p.k], p.x, p.y);
    }
  } else {
    // Paroles qui tombent : chaque mot tombe de haut quand il est chanté, avec un rebond.
    const size = fitWords(g, words, 900, 100, 900, 3, 44, 0.1);
    const font = `900 ${size}px ${FONT}`;
    const placed = layoutWords(g, words, font, 900, size * 1.22, cy, 'center', 110, size * 0.1);
    g.font = font;
    for (const p of placed) {
      const w = line.words[p.k];
      if (w.t > f.t) continue;
      const age = Math.min(1, (f.t - w.t) / 0.32);
      const y = p.y - 280 * (1 - easeOutBack(age));
      const rot = ((p.k % 3) - 1) * 0.06 * (1 - age);
      g.save();
      g.globalAlpha = Math.min(1, age * 2.5);
      g.translate(p.x + p.w / 2, y);
      g.rotate(rot);
      g.fillStyle = p.k === fr.sung ? pal.accent : '#ffffff';
      g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 14; g.shadowOffsetY = 6;
      g.fillText(words[p.k], -p.w / 2, 0);
      g.restore();
    }
  }
  g.restore();
}

/**
 * Lot 2b · Paroles seules, par-dessus une autre image (vidéo de la prise). Coordonnées d'une
 * colonne de 1080 de large (translater et mettre l'échelle avant) ; `cy` : centre vertical.
 */
export function drawLyricsOverlay(g: Ctx, look: ClipLook, f: ClipFrameInput, cy?: number): void {
  const pal = CLIP_PALETTES[look.palette] || CLIP_PALETTES[0];
  drawLyrics(g, look, f, pal, cy);
}

/** Dessine l'image du clip à l'instant donné (coordonnées 1080 × 1920 ; mettre l'échelle avant pour l'aperçu). */
export function drawClipFrame(g: Ctx, look: ClipLook, f: ClipFrameInput): void {
  const pal = CLIP_PALETTES[look.palette] || CLIP_PALETTES[0];
  g.save();
  drawBackground(g, look, f, pal);
  if (look.background === 'visualiseur') drawVisualizer(g, f, pal);
  else if (look.background === 'image') drawCoverCard(g, f);
  drawHeader(g, look, pal);
  drawLyrics(g, look, f, pal);
  drawProgress(g, f, pal);
  drawLogo(g);
  g.restore();
}
