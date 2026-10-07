/**
 * Jetons de thème de NOVA (sombre / clair) — direction « Épure orbitale », 07/10/2026.
 *
 * Principe : toutes les couleurs Tailwind passent par des variables CSS.
 *  - En sombre, chaque variable vaut la couleur Tailwind d'origine : rien ne change
 *    pour le code existant.
 *  - En clair (<html data-theme="light">), les variables sont réaffectées :
 *      · neutres (white, black, slate…) inversés : « white » devient l'encre, les
 *        voiles bg-white/5 deviennent des voiles d'encre, bg-slate-800 devient clair ;
 *      · couleurs vives : les fonds très sombres (800-950) deviennent des teintes
 *        claires, et les TEXTES clairs (50-600) sont foncés pour rester lisibles
 *        sur blanc (contraste AA ≥ 4,5:1, vérifié par qa/contrastes.mjs).
 *  - Sur une pastille de couleur pleine (bg-red-600, bg-cyan-500…), les textes
 *    retrouvent leurs valeurs d'origine : « text-white » reste blanc sur le rouge.
 *  - .nova-sombre : zone qui reste sombre même en thème clair (fenêtres d'effets,
 *    dessinées comme du matériel).
 *  - Classes à couleur fixe codée en dur (bg-[#14161a]…) : relevées dans les
 *    sources et réaffectées en clair, du plus profond (gris) au plus en relief (blanc).
 *
 * Jetons sémantiques pour le nouveau code : bg-nv-bg, bg-nv-panel, bg-nv-surface,
 * bg-nv-raised, bg-nv-well, border-nv-line, text-nv-ink, text-nv-muted,
 * text-nv-accent, bg-nv-accent… (voir `semantic` ci-dessous).
 */
import fs from 'node:fs';
import path from 'node:path';
import colors from 'tailwindcss/colors.js';

const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
const CHROMA = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky',
  'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'];
const NEUTRAL = ['slate', 'gray', 'zinc', 'neutral', 'stone'];

const ch = (hex) => {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)).join(' ');
};
const v = (name) => `rgb(var(--nv-${name}) / <alpha-value>)`;

// --- Correspondances du thème clair ---------------------------------------
const INV = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 600, 500: 500, 600: 400, 700: 300, 800: 200, 900: 100, 950: 50 };
// Textes neutres : 600 (gris discret sur fond sombre) passe à 500 (#64748b, 4,8:1 sur blanc).
const NEUTRAL_TEXT = { 50: 900, 100: 900, 200: 800, 300: 700, 400: 600, 500: 600, 600: 600, 700: 400, 800: 300, 900: 200, 950: 100 };
const CHROMA_BG = { 800: 200, 900: 100, 950: 50 };
const CHROMA_TEXT = { 50: 900, 100: 900, 200: 800, 300: 800, 400: 700, 500: 700, 600: 700 };
// Teintes chaudes / vertes : le 700 reste sous 4,5:1 sur le gris clair, on prend le 800.
const CHROMA_TEXT_CHAUD = { 50: 900, 100: 900, 200: 900, 300: 800, 400: 800, 500: 800, 600: 800, 700: 800 };
const CHAUDS = ['orange', 'amber', 'yellow', 'lime', 'green'];

// Encre et papier du thème clair
const INK = '15 23 42';          // slate-900
const BLACK_LIGHT = '148 163 184'; // voiles « bg-black/40 » : gris bleuté léger (slate-400)

// --- Palette Tailwind -------------------------------------------------------
function palette(prefix) {
  const out = {
    transparent: 'transparent', current: 'currentColor', inherit: 'inherit',
    white: v(`${prefix}white`), black: v(`${prefix}black`),
  };
  for (const c of [...NEUTRAL, ...CHROMA]) {
    out[c] = {};
    for (const s of SHADES) out[c][s] = v(`${prefix}${c}-${s}`);
  }
  return out;
}

const semantic = {
  bg: 'rgb(var(--nv-bg) / <alpha-value>)',
  panel: 'rgb(var(--nv-panel) / <alpha-value>)',
  surface: 'rgb(var(--nv-surface) / <alpha-value>)',
  raised: 'rgb(var(--nv-raised) / <alpha-value>)',
  well: 'rgb(var(--nv-well) / <alpha-value>)',
  line: 'rgb(var(--nv-line) / <alpha-value>)',
  ink: 'rgb(var(--nv-ink) / <alpha-value>)',
  muted: 'rgb(var(--nv-muted) / <alpha-value>)',
  accent: 'rgb(var(--nv-accent) / <alpha-value>)',
  'accent-ink': 'rgb(var(--nv-accent-ink) / <alpha-value>)',
  rec: 'rgb(var(--nv-rec) / <alpha-value>)',
};

// --- Variables ----------------------------------------------------------------
// Textes gris du thème sombre éclaircis pour atteindre l'AA sur les fonds
// sombres (#0c0d10 / #14161a) : slate-500 #64748b ne donnait que 3,8:1.
const DARK_TEXT_FIX = { 500: '#8794a8', 600: '#7a879b', 700: '#64718a' };
// Couleurs dont le 500 est trop sombre pour du texte sur fond sombre : on prend le 400.
const SOMBRES_500 = ['red', 'blue', 'indigo', 'violet', 'purple', 'rose'];

function darkVars(kind /* 'bg' | 'text' */) {
  const p = kind === 'text' ? 't-' : '';
  const o = { [`--nv-${p}white`]: '255 255 255', [`--nv-${p}black`]: '0 0 0' };
  for (const c of [...NEUTRAL, ...CHROMA]) for (const s of SHADES) {
    const fix = kind !== 'text' ? null : NEUTRAL.includes(c) ? DARK_TEXT_FIX[s] : (s === '500' && SOMBRES_500.includes(c) ? colors[c]['400'] : null);
    o[`--nv-${p}${c}-${s}`] = ch(fix || colors[c][s]);
  }
  return o;
}
function lightVars(kind) {
  const p = kind === 'text' ? 't-' : '';
  const o = {
    [`--nv-${p}white`]: INK,
    [`--nv-${p}black`]: kind === 'text' ? '0 0 0' : BLACK_LIGHT,
  };
  for (const c of NEUTRAL) for (const s of SHADES) {
    const m = kind === 'text' ? NEUTRAL_TEXT : INV;
    o[`--nv-${p}${c}-${s}`] = ch(colors[c][m[s]]);
  }
  for (const c of CHROMA) for (const s of SHADES) {
    const m = kind === 'text' ? (CHAUDS.includes(c) ? CHROMA_TEXT_CHAUD : CHROMA_TEXT) : CHROMA_BG;
    o[`--nv-${p}${c}-${s}`] = ch(colors[c][m[s] || s]);
  }
  return o;
}

const SEM_DARK = {
  '--nv-bg': '12 13 16', '--nv-panel': '9 10 12', '--nv-surface': '20 22 26', '--nv-raised': '28 31 37',
  '--nv-well': '0 0 0', '--nv-line': '255 255 255', '--nv-ink': '226 232 240', '--nv-muted': '148 163 184',
  '--nv-accent': '34 211 238', '--nv-accent-ink': '34 211 238', '--nv-rec': '239 68 68',
  // Variables historiques lues en style={{…}} par les composants
  '--bg-main': '#0c0d10', '--bg-surface': '#14161a', '--bg-panel': '#08090b', '--bg-item': 'rgba(0, 0, 0, 0.4)',
  '--border-dim': 'rgba(255, 255, 255, 0.06)', '--border-highlight': 'rgba(255, 255, 255, 0.12)',
  '--text-primary': '#e2e8f0', '--text-secondary': '#94a3b8', '--accent-neon': '#22d3ee', '--accent-text': '#22d3ee',
  '--grid-line': 'rgba(255, 255, 255, 0.07)', '--grid-sub': 'rgba(255, 255, 255, 0.025)',
  colorScheme: 'dark',
};
const SEM_LIGHT = {
  '--nv-bg': '241 244 248', '--nv-panel': '232 236 242', '--nv-surface': '255 255 255', '--nv-raised': '255 255 255',
  '--nv-well': '148 163 184', '--nv-line': INK, '--nv-ink': INK, '--nv-muted': '71 85 105',
  '--nv-accent': '8 145 178', '--nv-accent-ink': '14 116 144', '--nv-rec': '220 38 38',
  '--bg-main': '#f1f4f8', '--bg-surface': '#ffffff', '--bg-panel': '#e8ecf2', '--bg-item': 'rgba(15, 23, 42, 0.05)',
  '--border-dim': 'rgba(15, 23, 42, 0.09)', '--border-highlight': 'rgba(15, 23, 42, 0.18)',
  '--text-primary': '#0f172a', '--text-secondary': '#475569', '--accent-neon': '#0891b2', '--accent-text': '#0e7490',
  '--grid-line': 'rgba(15, 23, 42, 0.10)', '--grid-sub': 'rgba(15, 23, 42, 0.045)',
  colorScheme: 'light',
};

// Pastilles de couleur pleine : leurs textes gardent les valeurs d'origine.
function solidSelectors() {
  const sel = [];
  for (const c of CHROMA) for (const s of ['400', '500', '600', '700']) {
    sel.push(`[class~="bg-${c}-${s}"]`, `[class~="from-${c}-${s}"]`, `[class~="hover:bg-${c}-${s}"]:hover`);
  }
  sel.push('[class~="bg-[#00f2ff]"]', '[class~="bg-[#38bdf8]"]');
  return sel;
}

// --- Couleurs codées en dur (bg-[#0c0d10]…) ----------------------------------
const SRC_DIRS = ['components', 'plugins', 'engine', 'services', 'utils', 'hooks'];
function scanHexClasses(root) {
  const found = new Set();
  const files = ['App.tsx'];
  for (const d of SRC_DIRS) {
    const dir = path.join(root, d);
    if (!fs.existsSync(dir)) continue;
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const fp = path.join(p, e.name);
        if (e.isDirectory()) walk(fp);
        else if (/\.(tsx|ts)$/.test(e.name)) files.push(path.relative(root, fp));
      }
    };
    walk(dir);
  }
  const rx = /\b((?:hover:)?(?:bg|from|via|to|ring|border|text))-\[#([0-9a-fA-F]{6})\](?:\/(\d+|\[[0-9.]+\]))?/g;
  for (const f of files) {
    let src = '';
    try { src = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(rx)) found.add(m[0]);
  }
  return [...found];
}

// Fond sombre codé en dur → équivalent clair : plus il était profond, plus il
// devient gris ; plus il était en relief, plus il devient blanc. La teinte
// (légèrement chaude, rouge…) est conservée.
function lightOf(hex) {
  const [r, g, b] = ch(hex).split(' ').map(Number);
  const lum = Math.max(r, g, b);
  if (lum > 90) return null; // couleur vive (accent) : on la laisse
  const t = Math.min(1, lum / 40); // 0 = très profond, 1 = en relief
  const base = 232 + t * 23;       // #e8 → #ff
  const k = 0.6;
  const avg = (r + g + b) / 3;
  const ch2 = (c) => Math.max(0, Math.min(255, Math.round(base + (c - avg) * k + (c === b ? 3 : 0))));
  return `${ch2(r)} ${ch2(g)} ${ch2(b)}`;
}

function hexOverrides(root) {
  const rules = {};
  for (const cls of scanHexClasses(root)) {
    const m = cls.match(/^((?:hover:)?)(bg|from|via|to|ring|border|text)-\[#([0-9a-fA-F]{6})\](?:\/(\d+|\[[0-9.]+\]))?$/);
    if (!m) continue;
    const [, hover, kind, hex, alpha] = m;
    const a = !alpha ? 1 : alpha.startsWith('[') ? Number(alpha.slice(1, -1)) : Number(alpha) / 100;
    const esc = cls.replace(/([:\[\]#\/.])/g, '\\$1');
    const sel = `[data-theme="light"] :not(.nova-sombre *):not(.nova-sombre).${esc}${hover ? ':hover' : ''}`;
    if (kind === 'text') {
      const lum = Math.max(...ch(hex).split(' ').map(Number));
      if (lum > 150) rules[sel] = { color: `rgb(var(--nv-ink) / ${a})` };
      continue;
    }
    const light = lightOf(hex);
    if (!light) continue;
    const col = `rgb(${light} / ${a})`;
    if (kind === 'bg') rules[sel] = { backgroundColor: col };
    else if (kind === 'border') rules[sel] = { borderColor: col };
    else if (kind === 'ring') rules[sel] = { '--tw-ring-color': col };
    else if (kind === 'from') rules[sel] = { '--tw-gradient-from': `${col} var(--tw-gradient-from-position)`, '--tw-gradient-to': `rgb(${light} / 0) var(--tw-gradient-to-position)`, '--tw-gradient-stops': 'var(--tw-gradient-from), var(--tw-gradient-to)' };
    else if (kind === 'via') rules[sel] = { '--tw-gradient-to': `rgb(${light} / 0) var(--tw-gradient-to-position)`, '--tw-gradient-stops': `var(--tw-gradient-from), ${col} var(--tw-gradient-via-position), var(--tw-gradient-to)` };
    else if (kind === 'to') rules[sel] = { '--tw-gradient-to': `${col} var(--tw-gradient-to-position)` };
  }
  return rules;
}

export function novaThemePlugin(root) {
  return ({ addBase }) => {
    const dark = { ...darkVars('bg'), ...darkVars('text'), ...SEM_DARK };
    addBase({
      ':root': dark,
      '[data-theme="light"]': { ...lightVars('bg'), ...lightVars('text'), ...SEM_LIGHT },
      [`[data-theme="light"] :is(${solidSelectors().join(', ')})`]: { ...darkVars('text') },
      // bg-white plein devient l'encre en clair : son texte noir passe en blanc.
      '[data-theme="light"] :is([class~="bg-white"], [class~="hover:bg-white"]:hover)': { '--nv-t-black': '255 255 255' },
      '[data-theme="light"] .nova-sombre': dark,
      ...hexOverrides(root),
    });
  };
}

export const novaContrastData = { darkVars, lightVars, SEM_DARK, SEM_LIGHT, CHROMA, NEUTRAL, SHADES };
export const novaColors = palette('');
export const novaTextColors = palette('t-');
export const novaSemantic = semantic;
