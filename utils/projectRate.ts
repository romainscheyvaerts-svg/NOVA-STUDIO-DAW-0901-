/**
 * Fréquence d'échantillonnage du projet (comme Pro Tools : réglée à la création
 * de la session, modifiable ensuite avec conversion des clips).
 *
 *  - 44,1 / 48 / 88,2 / 96 kHz ;
 *  - 48 kHz pour un NOUVEAU projet (celle de la diffusion en direct Opus, de la
 *    vidéo et de la plupart des sessions de studio) ;
 *  - un projet existant garde la sienne ; absente (projet d'avant le réglage) =
 *    44,1 kHz, la fréquence fixe de l'ancien moteur : rien ne change pour lui.
 *
 * Module pur (testable tel quel) : la lecture de la fréquence d'un fichier audio
 * (sniffSampleRate) sert à décoder un import à SA fréquence, puis à le convertir
 * une seule fois avec le rééchantillonneur studio (utils/resample) au lieu du
 * décodeur du navigateur (−6,9 dB à 20 kHz en 44,1 → 48).
 */

export const PROJECT_RATES = [44100, 48000, 88200, 96000] as const;
export type ProjectRate = typeof PROJECT_RATES[number];

/** Nouveau projet. */
export const NEW_PROJECT_RATE: ProjectRate = 48000;
/** Projet sans fréquence enregistrée (avant ce réglage) : l'ancien moteur tournait à 44,1 kHz. */
export const LEGACY_PROJECT_RATE: ProjectRate = 44100;

export const isProjectRate = (x: unknown): x is ProjectRate =>
  typeof x === 'number' && (PROJECT_RATES as readonly number[]).includes(x);

/** Fréquence d'un projet (absente ou invalide : 44,1 kHz). */
export const projectRateOf = (s: { sampleRate?: unknown } | null | undefined): ProjectRate =>
  (s && isProjectRate(s.sampleRate) ? s.sampleRate : LEGACY_PROJECT_RATE);

/** Valeur reçue (fichier, collaboration, réglage) ramenée à une fréquence permise, sinon null. */
export const sanitizeRate = (x: unknown): ProjectRate | null => {
  const n = typeof x === 'string' ? Number(x) : x;
  return isProjectRate(n) ? n : null;
};

/** « 44,1 kHz », « 48 kHz », « 88,2 kHz ». */
export const rateLabel = (r: number): string => {
  const k = r / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1).replace('.', ',')} kHz`;
};

/** Usage de chaque fréquence (aide dans les réglages). */
export const RATE_HINT: Record<ProjectRate, string> = {
  44100: 'CD, streaming, anciens projets',
  48000: 'Standard studio et vidéo, direct en collaboration (recommandé)',
  88200: 'Haute résolution (multiple de 44,1)',
  96000: 'Haute résolution, plus lourd pour l\'ordinateur',
};

/** Ce que coûte un changement de fréquence (texte de l'avertissement). */
export interface RateChangePlan {
  from: ProjectRate;
  to: ProjectRate;
  /** Sons à convertir (clips, rendus gelés, pads…), et leur durée totale (s). */
  buffers: number;
  seconds: number;
}

export const rateChangeMessage = (p: RateChangePlan): string => {
  const what = p.buffers === 0
    ? 'Aucun son à convertir.'
    : `${p.buffers} son${p.buffers > 1 ? 's' : ''} (${formatDuration(p.seconds)}) ser${p.buffers > 1 ? 'ont' : 'a'} rééchantillonné${p.buffers > 1 ? 's' : ''} une fois, en qualité studio.`;
  return `Passer le projet de ${rateLabel(p.from)} à ${rateLabel(p.to)}. ${what} Le moteur audio redémarre (lecture arrêtée), les effets VST sont rechargés à la nouvelle fréquence. Ctrl+Z repasse en ${rateLabel(p.from)} (les sons sont reconvertis).`;
};

const formatDuration = (s: number): string => {
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return `${m} min${r ? ` ${String(r).padStart(2, '0')} s` : ''}`;
};

// ---------------------------------------------------------------- lecture d'en-tête

const MP3_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000],  // MPEG-2.5
};

const ascii = (b: Uint8Array, at: number, n: number) => {
  let s = '';
  for (let i = 0; i < n && at + i < b.length; i++) s += String.fromCharCode(b[at + i]);
  return s;
};

/** Flottant étendu 80 bits (AIFF « COMM »). */
const ieee80 = (b: Uint8Array, at: number): number => {
  const exp = ((b[at] & 0x7f) << 8) | b[at + 1];
  let mant = 0;
  for (let i = 0; i < 8; i++) mant = mant * 256 + b[at + 2 + i];
  if (exp === 0 && mant === 0) return 0;
  return mant * Math.pow(2, exp - 16383 - 63);
};

const find = (b: Uint8Array, tag: string, from = 0, to = b.length): number => {
  const c0 = tag.charCodeAt(0);
  outer: for (let i = from; i <= Math.min(to, b.length) - tag.length; i++) {
    if (b[i] !== c0) continue;
    for (let k = 1; k < tag.length; k++) if (b[i + k] !== tag.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
};

const plausible = (r: number) => (Number.isFinite(r) && r >= 3000 && r <= 768000 ? Math.round(r) : null);

/**
 * Fréquence d'origine d'un fichier audio, lue dans son en-tête (WAV / RF64 /
 * BW64, AIFF / AIFC, FLAC, MP3, Ogg Vorbis / Opus, WebM / Matroska, MP4 / M4A).
 * null : inconnue (le navigateur décode alors directement à la fréquence du projet).
 * Une erreur ici ne casse jamais rien : au pire la conversion passe par le décodeur du navigateur.
 */
export function sniffSampleRate(data: ArrayBuffer | Uint8Array): number | null {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (b.length < 12) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const head4 = ascii(b, 0, 4);
  try {
    // WAV (RIFF), RF64, BW64 : chunk « fmt ».
    if ((head4 === 'RIFF' || head4 === 'RF64' || head4 === 'BW64') && ascii(b, 8, 4) === 'WAVE') {
      let p = 12;
      while (p + 8 <= b.length) {
        const id = ascii(b, p, 4), size = dv.getUint32(p + 4, true);
        if (id === 'fmt ' && p + 16 <= b.length) return plausible(dv.getUint32(p + 12, true));
        p += 8 + size + (size & 1);
        if (size > b.length) break;
      }
      return null;
    }
    // AIFF / AIFC : chunk « COMM » (fréquence en flottant 80 bits).
    if (head4 === 'FORM' && (ascii(b, 8, 4) === 'AIFF' || ascii(b, 8, 4) === 'AIFC')) {
      let p = 12;
      while (p + 8 <= b.length) {
        const id = ascii(b, p, 4), size = dv.getUint32(p + 4, false);
        if (id === 'COMM' && p + 26 <= b.length) return plausible(ieee80(b, p + 16));
        p += 8 + size + (size & 1);
      }
      return null;
    }
    // FLAC : bloc STREAMINFO (20 bits).
    if (head4 === 'fLaC' && b.length >= 8 + 18) {
      const at = 8 + 10;
      return plausible((b[at] << 12) | (b[at + 1] << 4) | (b[at + 2] >> 4));
    }
    // Ogg : Vorbis (fréquence dans l'en-tête), Opus (toujours décodé en 48 kHz).
    if (head4 === 'OggS') {
      if (find(b, 'OpusHead', 0, 512) >= 0) return 48000;
      const v = find(b, '\x01vorbis', 0, 512);
      if (v >= 0 && v + 16 <= b.length) return plausible(dv.getUint32(v + 12, true));
      const f = find(b, '\x7fFLAC', 0, 512);
      if (f >= 0 && f + 9 + 4 + 18 <= b.length) { const at = f + 13 + 4 + 10; return plausible((b[at] << 12) | (b[at + 1] << 4) | (b[at + 2] >> 4)); }
      return null;
    }
    // WebM / Matroska : Opus = 48 kHz ; sinon élément SamplingFrequency (0xB5, flottant).
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
      const lim = Math.min(b.length, 1 << 16);
      if (find(b, 'A_OPUS', 0, lim) >= 0) return 48000;
      for (let i = 0; i < lim - 10; i++) {
        if (b[i] !== 0xb5) continue;
        const len = b[i + 1];
        if (len === 0x88) { const r = plausible(dv.getFloat64(i + 2, false)); if (r) return r; }
        if (len === 0x84) { const r = plausible(dv.getFloat32(i + 2, false)); if (r) return r; }
      }
      return null;
    }
    // MP4 / M4A : entrée « mp4a » (fréquence 16.16) ; AAC HE (SBR) peut doubler : sans gravité.
    if (ascii(b, 4, 4) === 'ftyp') {
      const lim = Math.min(b.length, 4 << 20);
      for (const tag of ['mp4a', 'alac', 'fLaC', 'Opus']) {
        const at = find(b, tag, 0, lim);
        if (at < 4) continue;
        if (tag === 'Opus') return 48000;
        const entry = at - 4;
        if (entry + 34 <= b.length) { const r = plausible(dv.getUint16(entry + 32, false)); if (r) return r; }
      }
      const md = find(b, 'mdhd', 0, lim);
      if (md >= 0 && md + 20 <= b.length) {
        const ver = b[md + 4];
        const ts = ver === 1 ? dv.getUint32(md + 4 + 4 + 16, false) : dv.getUint32(md + 4 + 4 + 8, false);
        return plausible(ts);
      }
      return null;
    }
    // MP3 : ID3v2 sauté, puis 1re trame valide.
    let p = 0;
    if (head4.startsWith('ID3') && b.length > 10) {
      p = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
    }
    const end = Math.min(b.length - 4, p + 64 * 1024);
    for (let i = p; i < end; i++) {
      if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
      const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, br = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3;
      if (ver === 1 || layer === 0 || br === 0 || br === 15 || sri === 3) continue;
      return MP3_RATES[ver]?.[sri] ?? null;
    }
  } catch { /* en-tête abîmé : fréquence inconnue */ }
  return null;
}

// ---------------------------------------------------------------- fréquence en cours

let current: number = NEW_PROJECT_RATE;
/**
 * Fréquence du moteur en ce moment (réglée par AudioEngine à chaque contexte créé) :
 * valeur de repli des modules qui n'importent pas le moteur (réponses du pont sans
 * fréquence, journal des prises, aperçus). Remplace les « || 44100 » d'avant.
 */
export const currentRate = (): number => current;
export const setCurrentRate = (r: number) => { if (Number.isFinite(r) && r > 0) current = r; };
