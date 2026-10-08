/**
 * Tour 2 : coût CPU du cœur des compresseurs analogiques (même code que l'AudioWorklet),
 * mesuré sous Node : 20 s de bruit rose stéréo, blocs de 128, réglages par défaut + réglages
 * de Romain. Résultat en % d'un cœur (temps de calcul / durée audio).
 */
import { createAnalogCompCore } from '../../../engine/analogCompCore';
import { buildAnalogInternal } from '../../../engine/analogCompMaps';
import { ANALOG_PROFILES } from '../../../engine/analogProfiles';
import { ANALOG_SPECS } from '../../../engine/analogCompParams';

const SR = 48000, SEC = 20, N = SR * SEC;
const L = new Float32Array(N), R = new Float32Array(N);
let seed = 1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
let b0 = 0, b1 = 0, b2 = 0;
for (let i = 0; i < N; i++) {
  const w = rnd();
  b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527;
  const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.3 * i / SR);
  L[i] = (b0 + b1 + b2) * 0.08 * env; R[i] = L[i] * 0.9;
}
const out: Record<string, number> = {};
const MONO = process.argv.includes('--mono');
if (MONO) R.set(L);
for (const kind of Object.keys(ANALOG_SPECS)) {
  const core = createAnalogCompCore(SR);
  core.setInternal(buildAnalogInternal(kind, ANALOG_SPECS[kind].defaults as any, ANALOG_PROFILES[kind], SR));
  const oL = new Float32Array(128), oR = new Float32Array(128);
  // chauffe (JIT)
  for (let i = 0; i < SR * 2; i += 128) core.process(L.subarray(i, i + 128), R.subarray(i, i + 128), oL, oR, 128);
  // temps CPU du processus (et non temps mural) : peu sensible aux autres calculs de la machine
  const c0 = process.cpuUsage();
  for (let i = 0; i + 128 <= N; i += 128) core.process(L.subarray(i, i + 128), R.subarray(i, i + 128), oL, oR, 128);
  const cu = process.cpuUsage(c0);
  const dt = (cu.user + cu.system) / 1e6;
  out[kind] = Math.round(dt / SEC * 100 * 1000) / 1000;
}
process.stdout.write(JSON.stringify(out) + '\n');
