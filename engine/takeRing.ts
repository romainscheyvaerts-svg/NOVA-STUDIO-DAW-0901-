/**
 * Anneau d'échantillons sans verrou entre le fil audio (AudioWorklet, producteur) et l'écrivain de
 * prises (Worker, lecteur) : même principe que le moteur natif (native-audio/Source/Rings.h, mode
 * « borné » de la lecture) transposé à SharedArrayBuffer + Atomics.
 *
 *  - en-tête Int32Array (8 cases) : [0] images publiées, [1] images lues, [2] images perdues (anneau
 *    plein : le fil audio n'attend JAMAIS), [3] état (1 = prise en cours, 2 = arrêtée) ; positions
 *    sur 32 bits qui font le tour (différences `(w - r) | 0`, valables tant qu'elles restent sous
 *    2^31 images, soit 12 h) ; puis un Float64 (octets 32 à 39) : n° d'image (horloge du contexte)
 *    du 1er échantillon, écrit AVANT la publication des images (Atomics.store fait barrière) ;
 *  - données planaires : canal c aux indices [c × capacité, (c + 1) × capacité), capacité en
 *    puissance de 2.
 *
 * Le fil audio n'alloue rien, ne bloque jamais, ne poste aucun message pendant la prise.
 * Les fonctions `ringWrite` et `ringRead` sont autonomes (aucune référence extérieure) : injectées
 * telles quelles dans le code du worklet par `takeRingSource()`.
 */

export const RING_HEADER_BYTES = 64;
export const RING_WRITE = 0;
export const RING_READ = 1;
export const RING_LOST = 2;
export const RING_STATE = 3;

export interface TakeRingShared { header: SharedArrayBuffer; data: SharedArrayBuffer; channels: number; capacity: number }

/** Isolation cross-origin active (SharedArrayBuffer utilisable entre les fils). */
export function canShareMemory(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined'
    && (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated === true);
}

const nextPow2 = (v: number) => { let p = 1; while (p < v && p < (1 << 28)) p <<= 1; return p; };

/** Anneau de `seconds` secondes pour `channels` canaux (8 s par défaut : un Worker figé 8 s ne perd rien). */
export function createTakeRing(channels: number, sampleRate: number, seconds = 8): TakeRingShared {
  const capacity = nextPow2(Math.ceil(sampleRate * seconds));
  const ch = Math.max(1, channels);
  return { header: new SharedArrayBuffer(RING_HEADER_BYTES), data: new SharedArrayBuffer(capacity * ch * 4), channels: ch, capacity };
}

/**
 * Producteur (fil audio) : écrit `len` images de `inp` (tableau de canaux, absents = silence).
 * mono = true : moyenne des canaux présents dans le canal 0 (voix sur un seul canal à niveau plein).
 * Rend false si l'anneau est plein (images comptées perdues, rien n'est écrasé).
 */
export function ringWrite(h: Int32Array, d: Float32Array, cap: number, k: number, inp: Float32Array[] | null | undefined, len: number, mono: boolean): boolean {
  const w = Atomics.load(h, 0);
  const r = Atomics.load(h, 1);
  if (cap - ((w - r) | 0) < len) { Atomics.add(h, 2, len); return false; }
  const m = cap - 1;
  if (mono) {
    const nIn = inp ? inp.length : 0;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < nIn; c++) v += inp![c][i];
      d[(w + i) & m] = nIn > 1 ? v / nIn : v;
    }
  } else {
    for (let c = 0; c < k; c++) {
      const src = inp && c < inp.length ? inp[c] : null;
      const base = c * cap;
      if (src) for (let i = 0; i < len; i++) d[base + ((w + i) & m)] = src[i];
      else for (let i = 0; i < len; i++) d[base + ((w + i) & m)] = 0;
    }
  }
  Atomics.store(h, 0, (w + len) | 0);
  return true;
}

/**
 * Lecteur (Worker) : copie tout ce qui est publié (au plus `max` images) dans de nouveaux tableaux,
 * un par canal, et libère la place. Rend null s'il n'y a rien.
 */
export function ringRead(h: Int32Array, d: Float32Array, cap: number, k: number, max: number): Float32Array[] | null {
  const w = Atomics.load(h, 0);
  const r = Atomics.load(h, 1);
  const n = Math.min((w - r) | 0, max);
  if (n <= 0) return null;
  const m = cap - 1;
  const out: Float32Array[] = [];
  for (let c = 0; c < k; c++) {
    const x = new Float32Array(n);
    const base = c * cap;
    const s = r & m;
    const first = Math.min(n, cap - s);
    x.set(d.subarray(base + s, base + s + first), 0);
    if (first < n) x.set(d.subarray(base, base + (n - first)), first);
    out.push(x);
  }
  Atomics.store(h, 1, (r + n) | 0);
  return out;
}

/** Source JavaScript à placer en tête du module du worklet (définit `ringWrite`). */
export const takeRingSource = (): string => `const ringWrite = (${ringWrite.toString()});\n`;
