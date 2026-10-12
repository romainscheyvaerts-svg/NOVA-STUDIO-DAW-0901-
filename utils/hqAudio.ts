/**
 * Conversion de fréquence des SONS du projet, en qualité studio (utils/resample),
 * une seule fois par son, gardée en cache.
 *
 *  - Import (fichier, cloud, collaboration, projet .zip) : le décodeur du
 *    navigateur rééchantillonne lui-même vers la fréquence du contexte, avec une
 *    perte d'aigus mesurée (Chromium, 44,1 → 48 kHz : −2,6 dB à 19 kHz, −6,9 dB
 *    à 20 kHz). installHQDecode remplace decodeAudioData du contexte du moteur :
 *    la fréquence d'origine est lue dans l'en-tête (utils/projectRate.sniffSampleRate),
 *    le fichier est décodé à SA fréquence, puis converti ici (plat à 20 kHz).
 *    Fréquence illisible : décodeur du navigateur (comme avant).
 *  - Changement de fréquence du projet : convertRegistryTo convertit chaque son
 *    du registre (clips, rendus gelés, pads, échantillons) et le remplace sous le
 *    même identifiant.
 *  - Lecture d'un son resté à une autre fréquence : le navigateur l'interpolerait
 *    linéairement (−1,5 dB dès 10 kHz) ; d'où la conversion systématique.
 *
 * Calcul dans des workers (un canal par worker) : l'interface ne fige pas.
 */
import { resampleChannel } from './resample';
import { sniffSampleRate } from './projectRate';
import { audioBufferRegistry } from './audioBufferRegistry';

// ------------------------------------------------------------------ workers

interface Job { resolve: (c: Float32Array) => void; reject: (e: unknown) => void; canal: Float32Array; de: number; vers: number }
let pool: Worker[] | null = null;
let rr = 0;
let seq = 1;
const jobs = new Map<number, Job>();

function workers(): Worker[] {
  if (pool) return pool;
  pool = [];
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return pool;
  const n = Math.max(1, Math.min(4, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4) - 1));
  try {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./resample.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; canal?: Float32Array; erreur?: string }>) => {
        const j = jobs.get(e.data.id);
        if (!j) return;
        jobs.delete(e.data.id);
        if (e.data.canal) j.resolve(e.data.canal);
        else j.reject(new Error(e.data.erreur || 'conversion impossible'));
      };
      w.onerror = (ev) => {
        // Worker indisponible (CSP, build) : on bascule tout en calcul direct.
        ev.preventDefault?.();
        pool = [];
        for (const [id, j] of [...jobs]) { jobs.delete(id); try { j.resolve(resampleChannel(j.canal, j.de, j.vers)); } catch (e) { j.reject(e); } }
      };
      pool.push(w);
    }
  } catch { pool = []; }
  return pool;
}

/** Convertit un canal (copie : l'original n'est pas touché). */
export function resampleChannelAsync(canal: Float32Array, de: number, vers: number): Promise<Float32Array> {
  if (de === vers) return Promise.resolve(new Float32Array(canal));
  const ws = workers();
  if (!ws.length) return new Promise((res, rej) => { setTimeout(() => { try { res(resampleChannel(canal, de, vers)); } catch (e) { rej(e); } }, 0); });
  const id = seq++;
  const copie = new Float32Array(canal);
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, canal, de, vers });
    ws[rr++ % ws.length].postMessage({ id, canal: copie, de, vers }, [copie.buffer]);
  });
}

// ------------------------------------------------------------------ AudioBuffer

/** Statistiques (QA, diagnostic) : combien de sons convertis, et par quel chemin. */
export const hqStats = { converted: 0, seconds: 0, decodedAtSource: 0, decodedByBrowser: 0 };
if (typeof window !== 'undefined') (window as unknown as { __novaHq?: typeof hqStats }).__novaHq = hqStats;

const cache = new WeakMap<AudioBuffer, Map<number, Promise<AudioBuffer>>>();

const makeBuffer = (chs: Float32Array[], sampleRate: number): AudioBuffer => {
  const b = new AudioBuffer({ length: Math.max(1, chs[0]?.length || 1), numberOfChannels: Math.max(1, chs.length), sampleRate });
  chs.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return b;
};

/**
 * Le son à la fréquence voulue (le même s'il y est déjà). Une conversion par
 * (son, fréquence) : deux demandes du même son partagent le même calcul.
 */
export function resampleBuffer(buf: AudioBuffer, rate: number): Promise<AudioBuffer> {
  if (!buf || buf.sampleRate === rate) return Promise.resolve(buf);
  let byRate = cache.get(buf);
  if (!byRate) { byRate = new Map(); cache.set(buf, byRate); }
  const hit = byRate.get(rate);
  if (hit) return hit;
  const p = (async () => {
    const chs: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    const out = await Promise.all(chs.map(c => resampleChannelAsync(c, buf.sampleRate, rate)));
    hqStats.converted++;
    hqStats.seconds += buf.duration;
    return makeBuffer(out, rate);
  })();
  byRate.set(rate, p);
  p.catch(() => byRate!.delete(rate));
  return p;
}

/**
 * Décode un fichier à la fréquence `rate` : à sa propre fréquence puis converti en
 * qualité studio, ou par le décodeur du navigateur si sa fréquence est illisible.
 */
export async function decodeAtRate(data: ArrayBuffer, rate: number, browserDecode: (d: ArrayBuffer) => Promise<AudioBuffer>): Promise<AudioBuffer> {
  let src: number | null = null;
  try { src = sniffSampleRate(data); } catch { src = null; }
  if (!src || src === rate || typeof OfflineAudioContext === 'undefined') {
    hqStats.decodedByBrowser++;
    return browserDecode(data);
  }
  let native: AudioBuffer;
  try {
    native = await new OfflineAudioContext(1, 1, src).decodeAudioData(data.slice(0));
  } catch {
    hqStats.decodedByBrowser++;
    return browserDecode(data);
  }
  hqStats.decodedAtSource++;
  return resampleBuffer(native, rate);
}

const HQ = Symbol.for('nova.hqDecode');

/**
 * decodeAudioData du contexte du moteur passe par decodeAtRate (toutes les
 * importations du DAW en profitent sans changer leur code). Formes promesse et
 * rappels acceptées, comme l'API d'origine.
 */
export function installHQDecode(ctx: BaseAudioContext): void {
  const anyCtx = ctx as unknown as Record<symbol, unknown> & { decodeAudioData: BaseAudioContext['decodeAudioData'] };
  if (anyCtx[HQ]) return;
  const browserDecode = ctx.decodeAudioData.bind(ctx) as (d: ArrayBuffer) => Promise<AudioBuffer>;
  const hq = (data: ArrayBuffer, ok?: DecodeSuccessCallback | null, err?: DecodeErrorCallback | null): Promise<AudioBuffer> => {
    const p = decodeAtRate(data, ctx.sampleRate, browserDecode);
    if (ok || err) p.then(b => ok?.(b), e => err?.(e as DOMException));
    return p;
  };
  try {
    Object.defineProperty(ctx, 'decodeAudioData', { value: hq, configurable: true, writable: true });
    anyCtx[HQ] = true;
  } catch { /* objet figé : décodeur du navigateur */ }
}

// ------------------------------------------------------------------ registre

/** Sons du registre qui ne sont pas à `rate` (pour l'avertissement : nombre et durée). */
export function registryConversionPlan(rate: number): { buffers: number; seconds: number } {
  let buffers = 0, seconds = 0;
  for (const id of audioBufferRegistry.ids()) {
    const b = audioBufferRegistry.get(id);
    if (b && b.sampleRate !== rate) { buffers++; seconds += b.duration; }
  }
  return { buffers, seconds };
}

/**
 * Convertit tous les sons du registre à `rate` (même identifiant). Un même son
 * enregistré sous plusieurs identifiants n'est converti qu'une fois.
 */
export async function convertRegistryTo(rate: number, onProgress?: (done: number, total: number) => void): Promise<{ converted: number; seconds: number }> {
  const todo = audioBufferRegistry.ids().map(id => [id, audioBufferRegistry.get(id)] as const).filter(([, b]) => b && b.sampleRate !== rate) as [string, AudioBuffer][];
  let done = 0, seconds = 0;
  onProgress?.(0, todo.length);
  // Quelques sons à la fois (mémoire : chaque conversion copie ses canaux).
  const width = Math.max(1, workers().length || 1);
  let next = 0;
  const lane = async () => {
    while (next < todo.length) {
      const [id, b] = todo[next++];
      const nb = await resampleBuffer(b, rate);
      // Remplacé seulement si personne ne l'a changé pendant la conversion.
      if (audioBufferRegistry.get(id) === b) audioBufferRegistry.replace(id, nb);
      seconds += b.duration;
      onProgress?.(++done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, todo.length) }, lane));
  return { converted: todo.length, seconds };
}
