// Serveur SIMULÉ du studio pour la QA (chantier 17 · « Envoyer au studio »).
//
// Fait tourner le VRAI code de la fonction supabase/functions/studio-inbox/index.ts
// (empaqueté par esbuild), avec la fausse base en mémoire des tests
// (supabase/tests/fakes/supabase.ts) : aucune base réelle, aucun réseau sortant.
// Le scénario qa/studio_connecte.py y redirige les appels de NOVA :
//   POST /functions/v1/studio-inbox                           → la fonction, telle quelle
//   POST|PUT /storage/v1/object/upload/sign/studio-packages/… → dépôt d'un fichier (taille + contenu gardés)
//   POST /__user {token, id, email}                           → compte simulé
//   GET  /__db                                                → tables + stockage (vérifications)
//   GET  /__file?path=…                                       → contenu d'un fichier déposé
//
// Usage : node qa/harness/studio_inbox_serveur.mjs
// Écrit « PORT <n> » quand il écoute (port libre choisi par le système, 127.0.0.1 seulement).
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKES = path.join(ROOT, 'supabase', 'tests', 'fakes').replace(/\\/g, '/');
const FN = path.join(ROOT, 'supabase', 'functions', 'studio-inbox', 'index.ts').replace(/\\/g, '/');
const out = path.join(os.tmpdir(), `studio-inbox-qa-${process.pid}.mjs`);

await esbuild.build({
  stdin: {
    contents: `import ${JSON.stringify(FN)};\nexport { lastHandler } from ${JSON.stringify(FAKES + '/denoServe.ts')};\nexport { createFakeDb, setCurrentDb } from ${JSON.stringify(FAKES + '/supabase.ts')};\n`,
    resolveDir: ROOT, loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
  plugins: [{
    name: 'faux-imports-distants',
    setup(b) {
      b.onResolve({ filter: /^https:\/\/deno\.land\/std@[^/]+\/http\/server\.ts$/ }, () => ({ path: path.resolve(FAKES, 'denoServe.ts') }));
      b.onResolve({ filter: /^https:\/\/esm\.sh\/@supabase\/supabase-js@/ }, () => ({ path: path.resolve(FAKES, 'supabase.ts') }));
      b.onResolve({ filter: /^https?:\/\// }, a => ({ errors: [{ text: `import distant interdit en QA : ${a.path}` }] }));
    },
  }],
});

globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: 'http://studio-simule.local', SUPABASE_SERVICE_ROLE_KEY: 'service-simulee', STUDIO_ADMIN_EMAILS: 'studio@makemusic.test' })[k] } };
const { lastHandler, createFakeDb, setCurrentDb } = await import(pathToFileURL(out).href);
const db = createFakeDb();
setCurrentDb(db);
const handler = lastHandler();
const bytes = new Map(); // chemin → contenu déposé
const log = [];

const readBody = (req) => new Promise((ok, ko) => { const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => ok(Buffer.concat(parts))); req.on('error', ko); });
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    if (url.pathname === '/__user' && req.method === 'POST') {
      const u = JSON.parse(body.toString('utf8'));
      db.users[u.token] = { id: u.id, email: u.email };
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__db') {
      const storage = {};
      for (const [b, m] of Object.entries(db.storage)) storage[b] = Object.fromEntries([...m.entries()].map(([k, v]) => [k, v.size]));
      return send(res, 200, { tables: db.tables, storage, log });
    }
    if (url.pathname === '/__file') {
      const b = bytes.get(url.searchParams.get('path') || '');
      if (!b) return send(res, 404, { error: 'absent' });
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(b);
    }
    if (url.pathname === '/functions/v1/studio-inbox') {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      const r = await handler(new Request('http://studio-simule.local/functions/v1/studio-inbox', { method: req.method, headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : body }));
      const text = await r.text();
      log.push({ t: Date.now(), action: (() => { try { return JSON.parse(body.toString('utf8')).action; } catch { return req.method; } })(), status: r.status });
      res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
      return res.end(text);
    }
    const m = url.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/studio-packages\/(.+)$/);
    if (m) {
      if (req.method === 'OPTIONS') return send(res, 204, '');
      const p = decodeURIComponent(m[1]);
      let data = body;
      const ctype = req.headers['content-type'] || '';
      if (ctype.startsWith('multipart/form-data')) {
        const fd = await new Request('http://x', { method: 'POST', headers: { 'content-type': ctype }, body }).formData();
        for (const [, v] of fd.entries()) if (typeof v !== 'string') { data = Buffer.from(await v.arrayBuffer()); break; }
      }
      const token = url.searchParams.get('token');
      if (token !== `tok-${p}`) return send(res, 400, { statusCode: '400', error: 'InvalidJWT', message: 'jeton d’envoi invalide' });
      bytes.set(p, data);
      (db.storage['studio-packages'] ||= new Map()).set(p, { size: data.length, created_at: new Date().toISOString() });
      log.push({ t: Date.now(), action: 'upload', path: p, size: data.length });
      return send(res, 200, { Key: `studio-packages/${p}` });
    }
    send(res, 404, { error: 'inconnu' });
  } catch (e) {
    send(res, 500, { error: String(e && e.message || e) });
  }
});
server.listen(0, '127.0.0.1', () => { console.log(`PORT ${server.address().port}`); });
