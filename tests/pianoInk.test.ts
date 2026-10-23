import { describe, it, expect } from 'vitest';
import { inkOn, velocityColor } from '../utils/pianoRollPro';

// Contraste WCAG entre le texte d'une note (« La0 ») et sa couleur de vélocité, thèmes sombre et clair.
const rgbOfHsl = (css: string): number[] => {
  const m = css.match(/hsl\((\d+(?:\.\d+)?) (\d+)% (\d+)%\)/)!;
  const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
  const k = (n: number) => (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map(n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
};
const lumOf = (rgb: number[]) => {
  const [r, g, b] = rgb.map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

describe('piano roll : texte des notes lisible sur la couleur de vélocité', () => {
  for (const light of [false, true]) {
    it(`${light ? 'clair' : 'sombre'} : au moins 4,5:1 sur toute la plage de vélocité`, () => {
      let worst = 99;
      for (let v = 0; v <= 1.0001; v += 0.01) {
        const a = lumOf(rgbOfHsl(velocityColor(v, light))), b = lumOf(hex(inkOn(v, light)));
        worst = Math.min(worst, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
      }
      expect(worst).toBeGreaterThanOrEqual(4.5);
    });
  }
});
