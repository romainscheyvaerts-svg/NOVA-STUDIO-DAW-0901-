/** @type {import('tailwindcss').Config} */
import animate from 'tailwindcss-animate';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { novaColors, novaTextColors, novaSemantic, novaThemePlugin } from './styles/novaTheme.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export default {
  // Toutes les sources qui contiennent des classes utilitaires.
  // Le purge s'appuie dessus : un fichier oublie ici perdrait ses styles.
  content: [
    './index.html',
    './index.tsx',
    './App.tsx',
    './components/**/*.{ts,tsx}',
    './plugins/**/*.{ts,tsx}',
    './engine/**/*.{ts,tsx}',
    './services/**/*.{ts,tsx}',
    './utils/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
  ],
  theme: {
    // Thème clair / sombre : toutes les couleurs passent par des variables CSS
    // (voir styles/novaTheme.js). En sombre elles valent les couleurs Tailwind
    // d'origine ; en clair elles sont réaffectées pour rester lisibles.
    colors: { ...novaColors, nv: novaSemantic },
    textColor: { ...novaTextColors, nv: novaSemantic },
    extend: {
      // « 2xl » ne sert qu'à la barre du haut du studio (version complète :
      // thème, compte, vues, modes PC/Tablette/Mobile). Elle mesurait ~1 880 px
      // (2 100 en mode avancé) dès 1536 px : sur les portables courants, le tempo,
      // la tonalité et les modes sortaient de l'écran et la page glissait de côté.
      // En dessous de 1880 px, la barre compacte (menu ☰) prend le relais.
      screens: { '2xl': '1880px' },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      transitionDuration: { DEFAULT: '160ms' },
    },
  },
  // Le code utilise animate-in / fade-in / zoom-in / slide-in-from-* un peu
  // partout (fenetres de plugins, menus deroulants). Ces classes viennent de ce
  // plugin, qui n'avait jamais ete installe : les animations n'ont donc jamais
  // fonctionne, pas davantage avec l'ancien CDN qui ne l'embarque pas non plus.
  plugins: [animate, novaThemePlugin(ROOT)],
};
