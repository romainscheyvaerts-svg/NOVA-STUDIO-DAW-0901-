/**
 * Serveur Node du labo de-esser : passe des signaux dans le cœur
 * engine/deesserCore.ts (le MÊME code que l'AudioWorklet). Une requête JSON
 * par ligne sur stdin : { params, n, data (base64 Float32 2×n) } -> { data }.
 */
import { createDeesserCore } from '../../../engine/deesserCore';
import * as readline from 'readline';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const r = JSON.parse(line);
    const n = r.n | 0;
    const buf = Buffer.from(r.data, 'base64');
    const all = new Float32Array(buf.buffer, buf.byteOffset, 2 * n);
    const inL = all.slice(0, n), inR = all.slice(n, 2 * n);
    const outL = new Float32Array(n), outR = new Float32Array(n);
    const core = createDeesserCore(r.sr || 48000);
    core.setParams(r.params || {});
    const B = 128;
    const gr = new Float32Array(Math.ceil(n / B));
    for (let i = 0, k = 0; i < n; i += B, k++) {
      const m = Math.min(B, n - i);
      core.process(inL.subarray(i, i + m), inR.subarray(i, i + m), outL.subarray(i, i + m), outR.subarray(i, i + m), m);
      gr[k] = core.takeMeters().grNowDb;
    }
    const out = new Float32Array(2 * n); out.set(outL, 0); out.set(outR, n);
    process.stdout.write(JSON.stringify({ data: Buffer.from(out.buffer).toString('base64'), gr: Array.from(gr) }) + '\n');
  } catch (e: any) {
    process.stdout.write(JSON.stringify({ error: String(e && e.stack || e) }) + '\n');
  }
});
