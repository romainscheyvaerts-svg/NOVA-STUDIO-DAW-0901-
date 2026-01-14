import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    // Détecte si on est sur Vercel (VERCEL=1) ou GitHub Pages
    const isVercel = process.env.VERCEL === '1';
    return {
      // Base URL pour GitHub Pages (nom du repo) - pas de base path pour Vercel
      base: isVercel ? '/' : (mode === 'production' ? '/NOVA-STUDIO-DAW-0901-/' : '/'),
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      build: {
        outDir: 'dist',
        sourcemap: false,
        minify: 'esbuild'
      }
    };
});
