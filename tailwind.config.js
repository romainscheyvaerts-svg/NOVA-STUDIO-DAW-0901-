/** @type {import('tailwindcss').Config} */
import animate from 'tailwindcss-animate';

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
  theme: { extend: {} },
  // Le code utilise animate-in / fade-in / zoom-in / slide-in-from-* un peu
  // partout (fenetres de plugins, menus deroulants). Ces classes viennent de ce
  // plugin, qui n'avait jamais ete installe : les animations n'ont donc jamais
  // fonctionne, pas davantage avec l'ancien CDN qui ne l'embarque pas non plus.
  plugins: [animate],
};
