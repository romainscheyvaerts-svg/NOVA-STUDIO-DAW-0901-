import path from 'path';
import fs from 'fs';
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * En production, les fichiers de `api/` sont servis par les fonctions serverless
 * de Vercel. En local (`npm run dev`), Vite ne les sert pas : /api/chat renvoyait
 * une 404 et l'assistant IA était donc totalement inutilisable hors Vercel.
 * Ce plugin exécute le même handler dans le serveur de dev.
 */
const devApiPlugin = (): Plugin => ({
  name: 'nova-dev-api',
  apply: 'serve',
  configureServer(server: ViteDevServer) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url || !req.url.startsWith('/api/')) return next();

      const route = req.url.split('?')[0].replace(/\/+$/, '');
      const handlerPath = path.resolve(__dirname, '.' + route + '.ts');
      if (!handlerPath.startsWith(path.resolve(__dirname, 'api')) || !fs.existsSync(handlerPath)) {
        return next();
      }

      try {
        const rawBody = await new Promise<string>((resolve, reject) => {
          let data = '';
          req.on('data', chunk => { data += chunk; });
          req.on('end', () => resolve(data));
          req.on('error', reject);
        });

        let parsedBody: any = {};
        if (rawBody) {
          try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = rawBody; }
        }

        const mod = await server.ssrLoadModule(handlerPath);
        const handler = mod.default;
        if (typeof handler !== 'function') return next();

        // Shim minimal de l'API Vercel (req.body / res.status().json()).
        let statusCode = 200;
        const shimRes = {
          setHeader: (k: string, v: string) => { res.setHeader(k, v); return shimRes; },
          status: (code: number) => { statusCode = code; return shimRes; },
          json: (payload: any) => {
            res.statusCode = statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(payload));
            return shimRes;
          },
          send: (payload: any) => {
            res.statusCode = statusCode;
            res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
            return shimRes;
          },
          end: () => { res.statusCode = statusCode; res.end(); return shimRes; }
        };

        await handler({ ...req, method: req.method, body: parsedBody, query: {} } as any, shimRes as any);
      } catch (error: any) {
        console.error(`[dev-api] ${route} :`, error);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          text: `❌ Erreur locale sur ${route} : ${error?.message || 'inconnue'}`,
          actions: [],
          error: error?.message
        }));
      }
    });
  }
});

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const isVercel = process.env.VERCEL === '1';

    // Le handler api/chat.ts lit process.env : on lui transmet ce que Vite a chargé
    // depuis .env.local pour que le mode dev fonctionne comme en production.
    if (env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY) {
      process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;
    }

    return {
      // Base: '/' sur Vercel, '/NOVA-STUDIO-DAW-0901-/' sur GitHub Pages
      base: isVercel ? '/' : (mode === 'production' ? '/NOVA-STUDIO-DAW-0901-/' : '/'),
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react(), devApiPlugin()],
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
