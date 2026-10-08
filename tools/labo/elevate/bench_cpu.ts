/** Mesure de charge CPU du cœur « Mastering Transient » (Node, blocs de 128 comme l'AudioWorklet). */
import { createMasterTransientCore } from '../../../engine/masterTransientCore';
import { createLimiterCore } from '../../../engine/limiterCore';
import { MASTER_TRANSIENT_PROFILE } from '../../../engine/masterTransientProfile';
import { MT_DEFAULTS, MT_PRESETS, mtToCore } from '../../../engine/masterTransientParams';

const SR = 48000, SEC = 60;
const out: Record<string, number> = {};
for (const pr of [MT_PRESETS.find(p => p.id === 'romain')!, MT_PRESETS.find(p => p.id === 'neutre')!]) {
  const core = createMasterTransientCore(SR, MASTER_TRANSIENT_PROFILE as any, process.env.SANS_LIM ? undefined : createLimiterCore);
  core.setParams(mtToCore({ ...MT_DEFAULTS, ...pr.params } as any));
  const L = new Float32Array(128), R = new Float32Array(128), oL = new Float32Array(128), oR = new Float32Array(128);
  let s = 1;
  const blocks = (SR * SEC) / 128;
  // chauffe
  for (let b = 0; b < 2000; b++) { for (let i = 0; i < 128; i++) { s = (s * 1664525 + 1013904223) >>> 0; L[i] = R[i] = (s / 4294967296 - 0.5) * 0.6; } core.process(L, R, oL, oR, 128); }
  const t0 = process.hrtime.bigint();
  for (let b = 0; b < blocks; b++) { for (let i = 0; i < 128; i++) { s = (s * 1664525 + 1013904223) >>> 0; L[i] = R[i] = (s / 4294967296 - 0.5) * 0.6; } core.process(L, R, oL, oR, 128); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  out[pr.id] = (ms / 1000) / SEC * 100;
}
console.log(JSON.stringify({ pourcent_d_un_coeur: out }));
