import path from 'path';
import { defineConfig, loadEnv, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Plugin pour remplacer __BUILD_VERSION__ par le timestamp du build
function buildVersionPlugin(): Plugin {
  const buildVersion = Date.now().toString();
  return {
    name: 'build-version',
    transformIndexHtml(html) {
      return html.replace('__BUILD_VERSION__', buildVersion);
    },
  };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      // CORRECTION ICI : On met '/' tout le temps pour Vercel
      base: '/',
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        buildVersionPlugin()
      ],
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
