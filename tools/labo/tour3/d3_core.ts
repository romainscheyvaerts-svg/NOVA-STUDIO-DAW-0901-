/**
 * Tour 3 : exécute le cœur TS (le même que l'AudioWorklet) sur un vecteur P DONNÉ
 * (calculé par le portage Python) : sert à vérifier que les deux cœurs sont identiques
 * sur le détecteur à deux voies.
 * Entrée : fichier JSON { P, tab, l0, dl, x (tableau), stereo? } ; sortie : JSON { y } sur stdout.
 */
import { createAnalogCompCore } from '../../../engine/analogCompCore';
import * as fs from 'node:fs';

const req = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const x = Float32Array.from(req.x as number[]);
const n = x.length;
const core = createAnalogCompCore(48000);
core.setInternal({ P: req.P, tab: req.tab, l0: req.l0, dl: req.dl });
const xr = req.stereo ? Float32Array.from(x.map((v: number, i: number) => v * (0.5 + 0.5 * Math.cos(i / 900)))) : x;
const oL = new Float32Array(n), oR = new Float32Array(n);
for (let i = 0; i < n; i += 128) {
  const m = Math.min(128, n - i);
  core.process(x.subarray(i, i + m), xr.subarray(i, i + m), oL.subarray(i, i + m), oR.subarray(i, i + m), m);
}
process.stdout.write(JSON.stringify({ y: Array.from(oL), yr: Array.from(oR) }));
