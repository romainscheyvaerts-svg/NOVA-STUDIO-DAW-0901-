/**
 * RNNoise (Xiph / Mozilla, BSD-3) en WebAssembly : réduction de bruit par réseau
 * de neurones, dans le navigateur, sans serveur (lot 1 « Voix propre »).
 *
 * Le binaire `public/wasm/rnnoise/rnnoise.wasm` est RNNoise 0.2 compilé avec
 * Emscripten (build de Jitsi, Apache-2.0 ; licences dans le même dossier). Il
 * n'importe que deux fonctions (agrandir la mémoire, copier un bloc) : on
 * l'instancie ici, sans la colle JavaScript d'Emscripten, ce qui le rend
 * utilisable à l'identique dans un Worker, dans la page et dans les tests (Node).
 *
 * Contrat de RNNoise : mono, 48 kHz, trames de 480 échantillons (10 ms), valeurs
 * à l'échelle d'un PCM 16 bits. Chaque trame renvoie aussi une probabilité de voix
 * (0 à 1), qui sert au nettoyage des silences (utils/voiceClean).
 *
 * Logique sans DOM (tests/rnnoise.test.ts).
 */

export const RNNOISE_SAMPLE_RATE = 48000;
export const RNNOISE_FRAME = 480;
/** Retard introduit par RNNoise 0.2 (mesuré : deux trames, 20 ms), compensé par denoiseChannel. */
export const RNNOISE_DELAY = 2 * RNNOISE_FRAME;

export interface RnnoiseState {
  /** Traite une trame de 480 échantillons EN PLACE (échelle 16 bits) ; renvoie la probabilité de voix. */
  process(frame: Float32Array): number;
  destroy(): void;
}

export interface RnnoiseEngine {
  create(): RnnoiseState;
}

interface RnnoiseExports {
  c: WebAssembly.Memory;
  d: () => void;                         // __wasm_call_ctors
  e: (n: number) => number;              // malloc
  f: (p: number) => void;                // free
  h: (model: number) => number;          // rnnoise_create(modèle par défaut = 0)
  i: (st: number) => void;               // rnnoise_destroy
  j: (st: number, out: number, inp: number) => number; // rnnoise_process_frame
}

/** Instancie RNNoise depuis les octets du fichier .wasm (ou un module déjà compilé). */
export async function createRnnoise(source: ArrayBuffer | Uint8Array | WebAssembly.Module): Promise<RnnoiseEngine> {
  let memory: WebAssembly.Memory | null = null;
  const imports = {
    a: {
      // emscripten_resize_heap(taille demandée) : agrandit la mémoire par pages de 64 Ko.
      a: (requested: number) => {
        if (!memory) return 0;
        const need = (requested >>> 0) - memory.buffer.byteLength;
        if (need <= 0) return 1;
        try { memory.grow(Math.ceil(need / 65536)); return 1; } catch { return 0; }
      },
      // emscripten_memcpy_big(dest, src, n)
      b: (dest: number, src: number, n: number) => {
        if (!memory) return;
        const u8 = new Uint8Array(memory.buffer);
        u8.copyWithin(dest, src, src + n);
      },
    },
  };
  const instance = source instanceof WebAssembly.Module
    ? await WebAssembly.instantiate(source, imports)
    : (await WebAssembly.instantiate(source instanceof Uint8Array ? source : new Uint8Array(source), imports)).instance;
  const ex = instance.exports as unknown as RnnoiseExports;
  memory = ex.c;
  ex.d();
  return {
    create(): RnnoiseState {
      const st = ex.h(0);
      if (!st) throw new Error('RNNoise : mémoire insuffisante');
      const bytes = RNNOISE_FRAME * 4;
      const inPtr = ex.e(bytes);
      const outPtr = ex.e(bytes);
      let alive = true;
      return {
        process(frame: Float32Array): number {
          if (!alive) throw new Error('RNNoise : état détruit');
          // La mémoire peut avoir grandi : vue recréée à chaque trame.
          const heap = new Float32Array(ex.c.buffer);
          heap.set(frame.subarray(0, RNNOISE_FRAME), inPtr >> 2);
          const vad = ex.j(st, outPtr, inPtr);
          frame.set(new Float32Array(ex.c.buffer, outPtr, RNNOISE_FRAME));
          return vad;
        },
        destroy() {
          if (!alive) return;
          alive = false;
          ex.i(st); ex.f(inPtr); ex.f(outPtr);
        },
      };
    },
  };
}

export interface DenoisedChannel {
  /** Voix débruitée, même longueur et même alignement que l'entrée (retard compensé). */
  out: Float32Array;
  /** Probabilité de voix par trame de 10 ms (alignée sur l'entrée). */
  vad: Float32Array;
}

/**
 * Débruite un canal à 48 kHz. Le retard d'une trame de RNNoise est compensé :
 * la sortie est alignée échantillon par échantillon sur l'entrée (nécessaire au
 * mélange avant / après et aux mesures). `onProgress` reçoit 0 → 1.
 */
export function denoiseChannel(engine: RnnoiseEngine, x: Float32Array, onProgress?: (f: number) => void): DenoisedChannel {
  const n = x.length;
  const frames = Math.ceil((n + RNNOISE_DELAY) / RNNOISE_FRAME);
  const st = engine.create();
  const out = new Float32Array(n);
  const vadRaw = new Float32Array(frames);
  const buf = new Float32Array(RNNOISE_FRAME);
  try {
    for (let f = 0; f < frames; f++) {
      const a = f * RNNOISE_FRAME;
      for (let i = 0; i < RNNOISE_FRAME; i++) { const k = a + i; buf[i] = k < n ? x[k] * 32768 : 0; }
      vadRaw[f] = st.process(buf);
      // Sortie de la trame f = entrée retardée de RNNOISE_DELAY.
      for (let i = 0; i < RNNOISE_FRAME; i++) {
        const k = a + i - RNNOISE_DELAY;
        if (k >= 0 && k < n) out[k] = buf[i] / 32768;
      }
      if (onProgress && (f & 255) === 0) onProgress(f / frames);
    }
  } finally { st.destroy(); }
  // La probabilité de voix de la trame f décrit l'entrée de la trame f (pas de décalage).
  const nf = Math.ceil(n / RNNOISE_FRAME);
  const vad = vadRaw.slice(0, nf);
  onProgress?.(1);
  return { out, vad };
}
