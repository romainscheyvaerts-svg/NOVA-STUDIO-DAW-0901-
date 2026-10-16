/**
 * Lot 6c (BandLab Splitter) : séparation en stems DANS LE NAVIGATEUR, sans l'appli Windows.
 *
 * Moteur : Demucs v4 « htdemucs_6s » (Meta, licence MIT, poids compris) exporté en ONNX avec
 * la transformée de Fourier DANS le graphe (entrée : 7,8 s de son stéréo à 44,1 kHz ; sortie :
 * 6 sources). Il tourne avec onnxruntime-web chargé depuis un CDN à version figée (empreintes
 * SHA-256 vérifiées), sur la carte graphique (WebGPU) ou, à défaut, sur le processeur (WASM,
 * bien plus lent), dans un Web Worker (services/StemsWebWorker.ts).
 *
 * Ce fichier ne contient que la logique pure, testée par vitest (tests/stemsWeb.test.ts) :
 *  - le découpage du morceau en segments de 7,8 s qui se chevauchent de 25 % et leur recollage
 *    pondéré (fenêtre triangulaire), à l'identique de `demucs.apply.apply_model` (split=True,
 *    overlap=0.25) qu'utilise l'appli Windows (bridge-python/stems_worker.py) ;
 *  - la normalisation du morceau (moyenne et écart type de la somme mono), comme sur Windows ;
 *  - la règle « somme des stems = original » : ce que le modèle ne range nulle part va dans
 *    « Instru » (2 stems) ou « Autres » (4 stems), au bit près ;
 *  - le choix du moteur (carte graphique, processeur, ou « passe sur ton PC »), l'estimation
 *    du temps et l'avertissement « réseau mobile » avant un gros téléchargement.
 */
import { resampleChannel } from './resample';

// ─── Modèle et moteur ──────────────────────────────────────────────────────────

/** Fréquence du modèle (Demucs v4). */
export const STEMS_WEB_SR = 44100;
/** Longueur d'un segment : 7,8 s à 44,1 kHz (fixée dans le graphe ONNX). */
export const STEMS_WEB_SEGMENT = 343980;
/** Chevauchement des segments (comme sur Windows). */
export const STEMS_WEB_OVERLAP = 0.25;
/** Ordre des 6 sources en sortie du modèle htdemucs_6s. */
export const STEMS_WEB_SOURCES = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'] as const;
export type WebSource = typeof STEMS_WEB_SOURCES[number];
/** Au-delà, la mémoire d'un navigateur ne suffit plus toujours : l'appli Windows prend le relais. */
export const STEMS_WEB_MAX_SECONDS = 10 * 60;

export interface WebModelSource {
  /** Adresse figée sur un commit (le fichier ne peut pas changer sous nos pieds). */
  url: string;
  bytes: number;
  sha256: string;
  /** Dépôt d'origine (crédit, rapport). */
  repo: string;
}

/**
 * Le modèle, en deux exemplaires publics de Hugging Face (dépôts sous licence MIT, conversions
 * des poids MIT de Meta). Le premier qui répond et dont l'empreinte est bonne est gardé.
 * Vérifiés le 16/10/2026 : CORS ouvert, taille et SHA-256 (= « oid » LFS du dépôt).
 */
export const STEMS_WEB_MODEL = {
  id: 'htdemucs_6s',
  label: 'Demucs v4 (Meta, licence MIT)',
  sources: [
    {
      repo: 'smank/htdemucs-onnx',
      url: 'https://huggingface.co/smank/htdemucs-onnx/resolve/fb1fd25aa6260c253d86bbb4aa26b73aebc79f10/htdemucs_6s.onnx',
      bytes: 246_034_354,
      sha256: '82cd0479a55b6b4018b948c0bb620975f8cdc75f682f40ad1357d5eb834b438e',
    },
    {
      repo: 'kramp/htdemucs-6s-webgpu-onnx',
      url: 'https://huggingface.co/kramp/htdemucs-6s-webgpu-onnx/resolve/0c850a01007f48d94900b21b49a0d0ae1a17239f/htdemucs_6s.onnx',
      bytes: 284_797_240,
      sha256: 'a3f5050696cda4b2344d465123acb21ee699dad7d0634dba1d282497a04ac86a',
    },
  ] as WebModelSource[],
};

/** onnxruntime-web, version figée (publiée le 14/09/2026), chargé depuis jsDelivr et vérifié. */
export const ORT_WEB = {
  version: '1.30.0',
  base: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/',
  js: { file: 'ort.webgpu.bundle.min.mjs', sha256: '0730816731ce2cdfb06f273da065d4a1c7091eb9d1756a83b2916c8a89d015e2', bytes: 117_732 },
  wasm: { file: 'ort-wasm-simd-threaded.asyncify.wasm', sha256: '39f9f0894d478800487ed9f7dbe92618498db320cf55c8e3d89adff8dce658da', bytes: 26_781_914 },
  /** Octets réellement transférés (le CDN compresse le .wasm en brotli : 5,5 Mo). */
  transferBytes: 5_700_000,
};

/** Cache Storage du modèle (gardé par le service worker, voir public/sw.js). */
export const STEMS_WEB_CACHE = 'nova-models-v1';

/** Taille annoncée avant le premier téléchargement (modèle + moteur). */
export const stemsWebDownloadBytes = (): number => STEMS_WEB_MODEL.sources[0].bytes + ORT_WEB.transferBytes;

// ─── Jeux de stems ─────────────────────────────────────────────────────────────

/** Dans le navigateur : 2 ou 4 stems (6 stems et voix lead / chœurs restent dans l'appli Windows). */
export type WebStemSet = 2 | 4;
export type WebStemKey = 'vocals' | 'instrumental' | 'drums' | 'bass' | 'other';

export interface WebStemPlan {
  /** Stems dans l'ordre des pistes posées. */
  keys: WebStemKey[];
  /** Stems calculés par le modèle (index des sources à additionner) ; les autres viennent du reste. */
  computed: { key: WebStemKey; sources: number[] }[];
  /** Stem qui reçoit « l'original moins tout le reste » (somme des stems = original). */
  rest: WebStemKey;
}

const src = (k: WebSource) => STEMS_WEB_SOURCES.indexOf(k);

export function webStemPlan(set: WebStemSet): WebStemPlan {
  if (set === 4) {
    return {
      keys: ['vocals', 'drums', 'bass', 'other'],
      computed: [{ key: 'vocals', sources: [src('vocals')] }, { key: 'drums', sources: [src('drums')] }, { key: 'bass', sources: [src('bass')] }],
      rest: 'other',
    };
  }
  return { keys: ['vocals', 'instrumental'], computed: [{ key: 'vocals', sources: [src('vocals')] }], rest: 'instrumental' };
}

// ─── Découpage et recollage (demucs.apply.apply_model) ─────────────────────────

/** Début de chaque segment : range(0, longueur, pas), pas = 75 % d'un segment. */
export function segmentOffsets(length: number, segment = STEMS_WEB_SEGMENT, overlap = STEMS_WEB_OVERLAP): number[] {
  const stride = Math.floor((1 - overlap) * segment);
  const out: number[] = [];
  for (let o = 0; o < length; o += stride) out.push(o);
  return out;
}

/** Fenêtre de recollage : triangle 1…n/2 puis n−n/2…1, ramené à 1 au sommet. */
export function segmentWeight(segment = STEMS_WEB_SEGMENT): Float32Array {
  const half = Math.floor(segment / 2);
  const w = new Float32Array(segment);
  for (let i = 0; i < half; i++) w[i] = i + 1;
  for (let i = half; i < segment; i++) w[i] = segment - i;
  const max = Math.max(half, segment - half);
  for (let i = 0; i < segment; i++) w[i] /= max;
  return w;
}

/**
 * Entrée du modèle pour le segment qui commence à `offset` : [gauche…, droite…] sur `segment`
 * échantillons. Le dernier segment, plus court, est centré et complété par le son voisin (puis
 * des zéros hors du morceau), comme TensorChunk.padded de Demucs.
 * Renvoie la longueur utile du segment.
 */
export function fillSegment(left: Float32Array, right: Float32Array, offset: number, into: Float32Array, segment = STEMS_WEB_SEGMENT): number {
  const length = left.length;
  const chunk = Math.min(segment, length - offset);
  const delta = segment - chunk;
  const start = offset - Math.floor(delta / 2);
  const a = Math.max(0, start);
  const b = Math.min(length, start + segment);
  into.fill(0);
  into.set(left.subarray(a, b), a - start);
  into.set(right.subarray(a, b), segment + a - start);
  return chunk;
}

/**
 * Ajoute la sortie du modèle pour un segment (S sources × 2 canaux × segment, à plat) aux stems
 * calculés, pondérée par la fenêtre. La sortie est d'abord recentrée sur la partie utile
 * (center_trim de Demucs) quand le segment est plus court.
 */
export function accumulateSegment(
  acc: Float32Array[][], weightSum: Float32Array, output: Float32Array, plan: Pick<WebStemPlan, 'computed'>,
  offset: number, chunk: number, weight: Float32Array, segment = STEMS_WEB_SEGMENT,
): void {
  const trim = Math.floor((segment - chunk) / 2);
  for (let i = 0; i < chunk; i++) weightSum[offset + i] += weight[i];
  plan.computed.forEach((c, t) => {
    for (let ch = 0; ch < 2; ch++) {
      const dst = acc[t][ch];
      for (const s of c.sources) {
        const base = (s * 2 + ch) * segment + trim;
        for (let i = 0; i < chunk; i++) dst[offset + i] += weight[i] * output[base + i];
      }
    }
  });
}

/** Moyenne et écart type (non biaisé, comme torch.std) de la somme mono du morceau. */
export function mixStats(left: Float32Array, right: Float32Array): { mean: number; std: number } {
  const n = left.length;
  if (!n) return { mean: 0, std: 1 };
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (left[i] + right[i]) / 2;
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) { const d = (left[i] + right[i]) / 2 - mean; sq += d * d; }
  const std = n > 1 ? Math.sqrt(sq / (n - 1)) : 0;
  return { mean, std: std > 1e-8 ? std : 1 };
}

/** Stéréo à la fréquence du modèle (mono dupliqué, canaux en trop ignorés, rééchantillonné si besoin). */
export function prepareStereo(channels: Float32Array[], sampleRate: number): [Float32Array, Float32Array] {
  const l0 = channels[0] || new Float32Array(0);
  const r0 = channels[1] || l0;
  if (sampleRate === STEMS_WEB_SR) return [l0, r0];
  const l = resampleChannel(l0, sampleRate, STEMS_WEB_SR);
  return [l, r0 === l0 ? l : resampleChannel(r0, sampleRate, STEMS_WEB_SR)];
}

export interface SeparateProgress {
  /** Segments faits / total. */
  done: number;
  total: number;
  /** Temps restant estimé (s), d'après les segments déjà calculés ; null avant le premier. */
  etaSec: number | null;
}

export interface SeparatedWebStem { key: WebStemKey; channels: Float32Array[] }

/** Un segment passé au modèle : [gauche, droite] × STEMS_WEB_SEGMENT → S × 2 × STEMS_WEB_SEGMENT. */
export type SegmentRunner = (input: Float32Array) => Promise<Float32Array>;

/** Temps restant : moyenne des segments déjà faits (le 1er, qui compile les shaders, est écarté dès qu'il y en a d'autres). */
export function etaSeconds(segmentMs: number[], remaining: number): number | null {
  if (!segmentMs.length) return null;
  const pool = segmentMs.length > 1 ? segmentMs.slice(1) : segmentMs;
  const avg = pool.reduce((a, b) => a + b, 0) / pool.length;
  return Math.max(0, Math.round((avg * remaining) / 1000));
}

/**
 * Sépare un son (1 ou 2 canaux, n'importe quelle fréquence) en 2 ou 4 stems, à sa fréquence et
 * à sa longueur exactes. `run` passe un segment au modèle (onnxruntime-web dans le Worker, ou un
 * faux modèle dans les tests). `stop()` vrai : arrêt entre deux segments (erreur « cancelled »).
 */
export async function separateChannels(
  channels: Float32Array[], sampleRate: number, set: WebStemSet, run: SegmentRunner,
  opts: { onProgress?: (p: SeparateProgress) => void; stop?: () => boolean; now?: () => number; segment?: number } = {},
): Promise<SeparatedWebStem[]> {
  const segment = opts.segment ?? STEMS_WEB_SEGMENT;
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const plan = webStemPlan(set);
  const inLen = channels[0]?.length || 0;
  const [l, r] = prepareStereo(channels, sampleRate);
  const n = l.length;
  const { mean, std } = mixStats(l, r);
  const nl = new Float32Array(n), nr = new Float32Array(n);
  for (let i = 0; i < n; i++) { nl[i] = (l[i] - mean) / std; nr[i] = (r[i] - mean) / std; }

  const acc = plan.computed.map(() => [new Float32Array(n), new Float32Array(n)]);
  const weightSum = new Float32Array(n);
  const weight = segmentWeight(segment);
  const offsets = segmentOffsets(n, segment);
  const input = new Float32Array(2 * segment);
  const times: number[] = [];
  opts.onProgress?.({ done: 0, total: offsets.length, etaSec: null });
  for (let k = 0; k < offsets.length; k++) {
    if (opts.stop?.()) throw Object.assign(new Error('Séparation annulée.'), { code: 'cancelled' });
    const t0 = now();
    const chunk = fillSegment(nl, nr, offsets[k], input, segment);
    const out = await run(input);
    if (out.length < STEMS_WEB_SOURCES.length * 2 * segment) throw new Error(`Sortie du modèle inattendue (${out.length} valeurs).`);
    accumulateSegment(acc, weightSum, out, plan, offsets[k], chunk, weight, segment);
    times.push(now() - t0);
    opts.onProgress?.({ done: k + 1, total: offsets.length, etaSec: etaSeconds(times, offsets.length - k - 1) });
  }

  // Recollage, retour à l'échelle d'origine, puis à la fréquence et à la longueur du clip.
  const stems = new Map<WebStemKey, Float32Array[]>();
  const mono = channels.length < 2;
  plan.computed.forEach((c, t) => {
    let chs = acc[t].map(a => { for (let i = 0; i < n; i++) a[i] = (a[i] / (weightSum[i] || 1)) * std + mean; return a; });
    if (sampleRate !== STEMS_WEB_SR) chs = chs.map(a => fitLength(resampleChannel(a, STEMS_WEB_SR, sampleRate), inLen));
    if (mono) { const m = new Float32Array(inLen); for (let i = 0; i < inLen; i++) m[i] = (chs[0][i] + chs[1][i]) / 2; chs = [m]; }
    stems.set(c.key, chs);
  });
  stems.set(plan.rest, restOf(channels.slice(0, mono ? 1 : 2), [...stems.values()]));
  return plan.keys.map(key => ({ key, channels: stems.get(key)! }));
}

/** Coupe ou complète de silence à `len` échantillons. */
export function fitLength(a: Float32Array, len: number): Float32Array {
  if (a.length === len) return a;
  const out = new Float32Array(len);
  out.set(a.subarray(0, Math.min(len, a.length)));
  return out;
}

/** Original moins la somme des stems : rien ne disparaît quand on remet tous les stems ensemble. */
export function restOf(original: Float32Array[], stems: Float32Array[][]): Float32Array[] {
  return original.map((o, c) => {
    const out = new Float32Array(o);
    for (const s of stems) { const x = s[c]; for (let i = 0; i < out.length; i++) out[i] -= x[i]; }
    return out;
  });
}

// ─── Moteur, temps, réseau ─────────────────────────────────────────────────────

export interface WebStemsCaps {
  /** Une carte graphique WebGPU a répondu (requestAdapter). */
  webgpu: boolean;
  /** Téléphone ou tablette. */
  mobile: boolean;
  /** navigator.deviceMemory (Go, Chrome seulement ; arrondi vers le bas, plafonné à 8). */
  deviceMemoryGb?: number | null;
  /** Réseau mobile détecté (Network Information API) ou mode « économie de données ». */
  cellular: boolean;
  /** Type de réseau inconnu (Safari, Firefox) : prudence au téléphone. */
  networkUnknown: boolean;
}

export type WebStemsLevel = 'ok' | 'slow' | 'too-weak';

export interface WebStemsVerdict {
  backend: 'webgpu' | 'wasm';
  level: WebStemsLevel;
  /** Pourquoi on conseille le PC (niveau « too-weak »). */
  reason?: string;
  /** Fourchette de temps de calcul pour ce clip (s), avant toute mesure. */
  estimate: [number, number];
  /** Mise en garde (téléphone : la page peut manquer de mémoire). */
  warning?: string;
}

/** Mémoire mesurée le 16/10/2026 : ~1,4 à 1,7 Go pour la page (moteur + modèle), plus la mémoire graphique. */
export const STEMS_WEB_PHONE_WARNING = 'Sur téléphone, le calcul demande 1,5 à 2 Go de mémoire : la page peut se fermer si elle en manque. Enregistre ton projet avant, et ferme les autres onglets.';

/**
 * Secondes de calcul par minute de son, mesurées le 16/10/2026 (3 min 10 de « Silence blanc »,
 * voir RAPPORT.md) et élargies pour les machines plus modestes :
 *  - carte graphique : 11 s/min sur une RTX 5090 portable (3 min 10 en 34 s, chargement compris),
 *    davantage sur une puce graphique intégrée (non mesuré ici : fourchette large) ;
 *  - processeur (WASM, un seul cœur : le site n'est pas « cross-origin isolated ») : 3 min 07/min
 *    sur un Core Ultra 9 275HX (3 min 10 en 9 min 53), plus sur un PC ancien.
 */
const SEC_PER_MIN: Record<string, [number, number]> = {
  webgpu: [10, 90],
  wasm: [180, 480],
  'webgpu-mobile': [60, 240],
};

export function webStemsVerdict(caps: WebStemsCaps, clipSeconds: number): WebStemsVerdict {
  const backend = caps.webgpu ? 'webgpu' : 'wasm';
  const rate = SEC_PER_MIN[caps.webgpu ? (caps.mobile ? 'webgpu-mobile' : 'webgpu') : 'wasm'];
  const mins = Math.max(clipSeconds, 1) / 60;
  const estimate: [number, number] = [Math.round(rate[0] * mins) + 3, Math.round(rate[1] * mins) + 10];
  if (clipSeconds > STEMS_WEB_MAX_SECONDS) {
    return { backend, level: 'too-weak', estimate, reason: `Clip trop long pour le navigateur (plus de ${Math.round(STEMS_WEB_MAX_SECONDS / 60)} min) : coupe-le, ou sépare-le sur ton PC avec Nova Studio.` };
  }
  if (caps.deviceMemoryGb != null && caps.deviceMemoryGb > 0 && caps.deviceMemoryGb < 4) {
    return { backend, level: 'too-weak', estimate, reason: 'Cet appareil a trop peu de mémoire (il en faut environ 1,5 Go de libre) : la page risquerait de se fermer.' };
  }
  if (caps.mobile && !caps.webgpu) {
    return { backend, level: 'too-weak', estimate, reason: 'Ce téléphone n’a pas d’accès à la carte graphique pour le calcul (WebGPU) : sur son processeur, compte plus d’une demi-heure pour un morceau.' };
  }
  return { backend, level: caps.webgpu && !caps.mobile ? 'ok' : 'slow', estimate, ...(caps.mobile ? { warning: STEMS_WEB_PHONE_WARNING } : {}) };
}

/** « 10 à 45 s », « 2 à 8 min ». */
export function formatEstimate([a, b]: [number, number]): string {
  const f = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);
  const fa = f(a), fb = f(b);
  if (fa === fb) return `environ ${fa}`;
  if (a < 90 && b < 90) return `${Math.round(a)} à ${Math.round(b)} s`;
  if (a >= 90 && b >= 90) return `${Math.round(a / 60)} à ${Math.round(b / 60)} min`;
  return `${fa} à ${fb}`;
}

/** Réseau mobile d'après la Network Information API (Chrome Android) : type, débit, économie de données. */
export function cellularFrom(conn: { type?: string; effectiveType?: string; saveData?: boolean } | null | undefined): { cellular: boolean; unknown: boolean } {
  if (!conn) return { cellular: false, unknown: true };
  const cellular = conn.type === 'cellular' || !!conn.saveData || ['slow-2g', '2g', '3g'].includes(conn.effectiveType || '');
  const unknown = !conn.type && !conn.effectiveType;
  return { cellular, unknown };
}

/** Message clair pour une erreur du calcul dans le navigateur. */
export function describeWebStemsError(err: unknown): string {
  const e = err as { message?: string; code?: string; name?: string } | null;
  const msg = String(e?.message || err || '');
  if (e?.code === 'cancelled') return 'Séparation annulée : aucune piste ajoutée.';
  if (e?.code === 'model') return 'Le modèle téléchargé ne correspond pas à l’original (fichier abîmé ou modifié) : il n’a pas été utilisé. Réessaie plus tard.';
  if (e?.code === 'network' || /Failed to fetch|NetworkError|network|téléchargement/i.test(msg)) {
    return 'Le téléchargement s’est interrompu (connexion ?). Vérifie ta connexion puis réessaie : rien n’a été ajouté au projet.';
  }
  if (e?.code === 'engine') return 'Impossible de charger le moteur de calcul (connexion, ou navigateur trop ancien). Essaie avec Chrome ou Edge à jour, ou sépare sur ton PC avec Nova Studio.';
  if (e?.name === 'RangeError' || /memory|mémoire|allocat/i.test(msg)) {
    return 'Pas assez de mémoire sur cet appareil : ferme d’autres onglets ou coupe le clip en morceaux plus courts, ou sépare-le sur ton PC avec Nova Studio.';
  }
  return msg ? `La séparation a échoué : ${msg.slice(0, 200)}` : 'La séparation a échoué.';
}
