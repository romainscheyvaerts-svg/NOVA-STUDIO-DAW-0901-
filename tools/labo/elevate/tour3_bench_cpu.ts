/**
 * Tour 3 : charge CPU du cœur « Mastering Transient » (Node, blocs de 128 comme l'AudioWorklet),
 * profil du dépôt complété par un JSON (variable PROFIL), temps CPU du processus (comme le tour 2 : process.cpuUsage).
 * Usage : npx esbuild … ; PROFIL=chemin.json node bundle.mjs
 */
import { createMasterTransientCore } from '../../../engine/masterTransientCore';
import { createLimiterCore } from '../../../engine/limiterCore';
import { MASTER_TRANSIENT_PROFILE } from '../../../engine/masterTransientProfile';
import { MT_DEFAULTS, MT_PRESETS, mtToCore } from '../../../engine/masterTransientParams';
import * as fs from 'node:fs';

const SR = 48000, SEC = 30;
const extra = process.env.PROFIL ? JSON.parse(fs.readFileSync(process.env.PROFIL, 'utf8')) : {};
const prof = { ...MASTER_TRANSIENT_PROFILE, ...extra };
const out: Record<string, number> = {};
for (const pr of [MT_PRESETS.find(p => p.id === 'romain')!, MT_PRESETS.find(p => p.id === 'neutre')!]) {
  const core = createMasterTransientCore(SR, prof as any, createLimiterCore);
  core.setParams(mtToCore({ ...MT_DEFAULTS, ...pr.params } as any));
  const L = new Float32Array(128), R = new Float32Array(128), oL = new Float32Array(128), oR = new Float32Array(128);
  let s = 1;
  const blocks = (SR * SEC) / 128;
  for (let b = 0; b < 2000; b++) { for (let i = 0; i < 128; i++) { s = (s * 1664525 + 1013904223) >>> 0; L[i] = R[i] = (s / 4294967296 - 0.5) * 0.6; } core.process(L, R, oL, oR, 128); }
  const c0 = process.cpuUsage();
  for (let b = 0; b < blocks; b++) { for (let i = 0; i < 128; i++) { s = (s * 1664525 + 1013904223) >>> 0; L[i] = R[i] = (s / 4294967296 - 0.5) * 0.6; } core.process(L, R, oL, oR, 128); }
  const c1 = process.cpuUsage(c0);
  out[pr.id] = ((c1.user + c1.system) / 1e6) / SEC * 100;
}
console.log(JSON.stringify(out));
