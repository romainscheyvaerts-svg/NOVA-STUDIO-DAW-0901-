/** Charge CPU du cœur de-esser : 60 s stéréo à 48 kHz, blocs de 128 (comme l'AudioWorklet). */
import { createDeesserCore } from '../../../engine/deesserCore';
const SR = 48000, N = 60 * SR, B = 128;
const inL = new Float32Array(N), inR = new Float32Array(N);
let s = 1;
for (let i = 0; i < N; i++) { s = (s * 16807) % 2147483647; inL[i] = 0.1 * Math.sin(i * 0.05) + 0.05 * (s / 2147483647 - 0.5); inR[i] = inL[i] * 0.9; }
const oL = new Float32Array(B), oR = new Float32Array(B);
const out: Record<string, number> = {};
for (const [name, p] of Object.entries({ relatif: { detection: 'RELATIVE' }, absolu: { detection: 'ABSOLUTE', threshold: -40 } })) {
  const c = createDeesserCore(SR); c.setParams({ frequency: 8000, q: 1, reduction: 0.6, ...p });
  for (let r = 0; r < 2; r++) { // 1er passage = chauffe du JIT
    const t0 = performance.now();
    for (let i = 0; i < N; i += B) { c.process(inL.subarray(i, i + B), inR.subarray(i, i + B), oL, oR, B); if ((i / B) % 6 === 0) c.takeMeters(); }
    const dt = (performance.now() - t0) / 1000;
    out[name] = Math.round(dt / 60 * 100 * 1000) / 1000;
  }
}
console.log(JSON.stringify({ pourcent_d_un_coeur: out }));
