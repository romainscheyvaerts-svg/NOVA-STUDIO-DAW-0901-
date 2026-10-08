/**
 * Petit serveur du labo : exécute le cœur DSP NOVA (le même code TypeScript
 * que l'AudioWorklet) dans Node, pour le comparateur Python.
 * Entrée (stdin, une ligne JSON) : { kind, params, sr, n, data (base64 float32, 2 x n) }
 * Sortie (stdout, une ligne JSON) : { data (base64 float32, 2 x n), latency, grDb }
 */
import { createAnalogCompCore } from '../../engine/analogCompCore';
import { buildAnalogInternal } from '../../engine/analogCompMaps';
import { ANALOG_PROFILES } from '../../engine/analogProfiles';
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
    const inL = all.slice(0, n), inR = all.slice(n, 2 * n);
    const outL = new Float32Array(n), outR = new Float32Array(n);
    const core = createAnalogCompCore(sr);
    core.setInternal(buildAnalogInternal(req.kind, req.params || {}, ANALOG_PROFILES[req.kind], sr));
    // blocs de 128 échantillons comme l'AudioWorklet
    let grDb = 0;
    for (let i = 0; i < n; i += 128) {
      const m = Math.min(128, n - i);
      core.process(inL.subarray(i, i + m), inR.subarray(i, i + m), outL.subarray(i, i + m), outR.subarray(i, i + m), m);
      grDb = Math.max(grDb, core.takeMeters().grDb);
    }
    const out = new Float32Array(2 * n);
    out.set(outL, 0); out.set(outR, n);
    process.stdout.write(JSON.stringify({ data: Buffer.from(out.buffer).toString('base64'), latency: 0, grDb }) + '\n');
  } catch (e: any) {
    process.stdout.write(JSON.stringify({ error: String(e && e.stack || e) }) + '\n');
  }
});
