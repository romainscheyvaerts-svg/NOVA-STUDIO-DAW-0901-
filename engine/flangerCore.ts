/**
 * Cœur du flanger NOVA (22/10/2026) : ligne de retard modulée AVEC réinjection, calculée
 * échantillon par échantillon dans un AudioWorklet.
 *
 * Pourquoi : dans Web Audio, un DelayNode placé dans une boucle (réinjection) ne peut pas
 * descendre sous un bloc de rendu (128 échantillons : 2,9 ms à 44,1 kHz, 2,7 ms à 48 kHz).
 * Le flanger affichait « Position 1,0 ms » mais retardait de 2,9 ms, et le bas de son
 * balayage était écrêté. Ici, la boucle est dans le cœur : retard exact jusqu'à 1 échantillon.
 *
 * Même code en lecture, à l'export (OfflineAudioContext) et dans les tests : la fonction
 * est sérialisée par `toString()` (elle ne référence RIEN en dehors d'elle-même).
 *
 *   entrée de la ligne = x + réinjection × y      sortie y(t) = ligne(t − retard(t))
 * Lecture interpolée linéairement (comme un DelayNode).
 */
export interface FlangerCore {
  /**
   * `delay` : retard en secondes, un par échantillon (a-rate) ou un seul pour tout le bloc ;
   * `fb` : réinjection (−0,95…0,95), idem. R peut être null (mono).
   */
  process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number, delay: Float32Array, fb: Float32Array): void;
  reset(): void;
}

export function createFlangerCore(sampleRate: number, maxDelaySec?: number): FlangerCore {
  var SR = sampleRate > 0 ? sampleRate : 48000;
  var maxD = Math.ceil((maxDelaySec || 0.025) * SR) + 4;
  var SIZE = 1;
  while (SIZE < maxD + 2) SIZE <<= 1;
  var MASK = SIZE - 1;
  var ring = [new Float32Array(SIZE), new Float32Array(SIZE)];
  var w = 0;

  function process(inL: Float32Array, inR: Float32Array | null, outL: Float32Array, outR: Float32Array | null, n: number, delay: Float32Array, fb: Float32Array) {
    var nCh = inR && outR ? 2 : 1;
    var dConst = delay.length < n, fConst = fb.length < n;
    for (var i = 0; i < n; i++) {
      var dS = (dConst ? delay[0] : delay[i]) * SR;
      if (!(dS >= 1)) dS = 1;              // au moins un échantillon (boucle causale)
      if (dS > maxD) dS = maxD;
      var g = fConst ? fb[0] : fb[i];
      if (g > 0.98) g = 0.98; else if (g < -0.98) g = -0.98;
      var pos = w - dS;
      var p0 = Math.floor(pos), t = pos - p0;
      for (var c = 0; c < nCh; c++) {
        var r = ring[c];
        var a = r[p0 & MASK], b = r[(p0 + 1) & MASK];
        var y = a + (b - a) * t;
        var x = c === 0 ? inL[i] : (inR as Float32Array)[i];
        var v = x + g * y;
        // Pas de dénormaux dans la queue de la réinjection.
        if (v < 1e-25 && v > -1e-25) v = 0;
        r[w & MASK] = v;
        if (c === 0) outL[i] = y; else (outR as Float32Array)[i] = y;
      }
      w++;
    }
  }

  function reset() { ring[0].fill(0); ring[1].fill(0); w = 0; }

  return { process: process, reset: reset };
}
