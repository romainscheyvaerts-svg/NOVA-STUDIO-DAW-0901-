/**
 * Serveur du labo : exécute le cœur « Mastering Transient » (le même code
 * TypeScript que l'AudioWorklet) dans Node, pour le calage et le comparateur.
 * Entrée (une ligne JSON) : { params, profile?, sr, n, data (base64 float32, 2 x n) }
 * Sortie (une ligne JSON) : { data (2 x n, latence retirée), latency, meters, ms }
 */
import { createMasterTransientCore } from '../../../engine/masterTransientCore';
import { createLimiterCore } from '../../../engine/limiterCore';
import { MASTER_TRANSIENT_PROFILE } from '../../../engine/masterTransientProfile';
import * as readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    const sr = req.sr || 48000;
    const n = req.n | 0;
    const buf = Buffer.from(req.data, 'base64');
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const prof = { ...MASTER_TRANSIENT_PROFILE, ...(req.profile || {}) };
    const core = createMasterTransientCore(sr, prof as any, createLimiterCore);
    core.setParams(req.params || {});
    const lat = core.latencySamples();
    const tot = n + lat;
    const inL = new Float32Array(tot), inR = new Float32Array(tot);
    inL.set(all.subarray(0, n)); inR.set(all.subarray(n, 2 * n));
    const outL = new Float32Array(tot), outR = new Float32Array(tot);
    const t0 = process.hrtime.bigint();
    let emph = 0, gr = 0;
    for (let i = 0; i < tot; i += 128) {
      const m = Math.min(128, tot - i);
      core.process(inL.subarray(i, i + m), inR.subarray(i, i + m), outL.subarray(i, i + m), outR.subarray(i, i + m), m);
      if ((i / 128) % 12 === 0) { const mm = core.takeMeters(); emph = Math.max(emph, mm.emphDb); gr = Math.max(gr, mm.grDb); }
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const out = new Float32Array(2 * n);
    out.set(outL.subarray(lat, lat + n), 0); out.set(outR.subarray(lat, lat + n), n);
    process.stdout.write(JSON.stringify({ data: Buffer.from(out.buffer).toString('base64'), latency: lat, emph, gr, ms }) + '\n');
  } catch (e: any) {
    process.stdout.write(JSON.stringify({ error: String(e && e.stack || e) }) + '\n');
  }
});
