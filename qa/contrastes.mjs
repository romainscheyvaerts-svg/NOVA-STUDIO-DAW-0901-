// Contrastes AA des jetons de thème (sombre et clair) — node qa/contrastes.mjs
// Calcule le rapport WCAG de chaque couleur de texte de la palette sur les fonds
// principaux des deux thèmes et signale ce qui reste sous 4,5:1.
import { novaContrastData as D } from '../styles/novaTheme.js';

const lum = (rgb) => {
  const [r, g, b] = rgb.split(' ').map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ');

const themes = {
  sombre: { text: D.darkVars('text'), fonds: { 'fond (#0c0d10)': '12 13 16', 'surface (#14161a)': '20 22 26', 'relief (#1c1f25)': '28 31 37' } },
  clair: { text: D.lightVars('text'), fonds: { 'surface (blanc)': '255 255 255', 'fond (#f1f4f8)': '241 244 248', 'panneau (#e8ecf2)': '232 236 242' } },
};
// Textes réellement utilisés comme texte courant (les teintes 800-950 servent
// de texte sur pastille claire, les 50-200 de texte sur pastille foncée).
const COURANTS = ['white', ...['slate'].flatMap((c) => ['100', '200', '300', '400', '500', '600'].map((s) => `${c}-${s}`)),
  ...D.CHROMA.flatMap((c) => ['300', '400', '500'].map((s) => `${c}-${s}`))];
let echecs = 0;
for (const [nom, t] of Object.entries(themes)) {
  console.log(`\n== Thème ${nom}`);
  for (const k of COURANTS) {
    const col = t.text[`--nv-t-${k}`];
    const r = Object.entries(t.fonds).map(([f, bg]) => [f, ratio(col, bg)]);
    const min = Math.min(...r.map((x) => x[1]));
    if (min < 4.5) echecs++;
    console.log(`${min < 4.5 ? '✗' : '✓'} text-${k.padEnd(12)} ${r.map(([f, v]) => `${v.toFixed(2)} sur ${f}`).join(' · ')}`);
  }
}
// Accent et texte secondaire historiques
const sem = [['sombre', D.SEM_DARK, '20 22 26'], ['clair', D.SEM_LIGHT, '255 255 255']];
for (const [nom, S, bg] of sem) {
  for (const k of ['--text-primary', '--text-secondary', '--accent-text']) console.log(`${nom} ${k} ${ratio(hex(S[k]), bg).toFixed(2)}`);
}
console.log(`\n${echecs} couleur(s) de texte courant sous 4,5:1 sur au moins un fond.`);
