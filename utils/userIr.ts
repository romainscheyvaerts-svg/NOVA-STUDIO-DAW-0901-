import type { Track } from '../types';

/**
 * Réponse impulsionnelle IMPORTÉE par l'utilisateur pour la réverbe à
 * convolution (plugins/ReverbPlugin) : son propre fichier WAV / AIFF (salle,
 * plaque, ressort, cabine qu'il a enregistré ou dont il a les droits). NOVA
 * n'embarque aucune réponse de tiers.
 *
 * Le son est gardé dans le registre audio (utils/audioBufferRegistry) sous la
 * clé `userir:<id>` : il voyage avec le projet (.zip, dossier audio/), dans les
 * versions gardées sur l'appareil et, en collaboration, avec le contenu de la
 * piste qui porte la réverbe. Le réglage de l'effet ne contient que la clé, le
 * nom du fichier, la longueur gardée et le fondu de fin.
 *
 * Module pur (tests/mixEcoute.test.ts) : mise en forme de la réponse
 * (canaux, longueur, fondu) et niveau calibré.
 */

export const USER_IR_PREFIX = 'userir:';
export const userIrKey = (id: string) => `${USER_IR_PREFIX}${id}`;
export const isUserIrKey = (k: unknown): k is string => typeof k === 'string' && k.startsWith(USER_IR_PREFIX) && k.length > USER_IR_PREFIX.length && k.length < 120;
export const newUserIrId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Durée maximale gardée (s) : au-delà, la convolution coûte cher pour rien. */
export const USER_IR_MAX_SEC = 12;
/** Fondu de fin par défaut (s) : la queue coupée ne claque pas. */
export const USER_IR_DEFAULT_FADE = 0.15;
/** Fichiers acceptés (le décodeur du navigateur lit WAV et AIFF ; FLAC aussi). */
export const USER_IR_ACCEPT = '.wav,.wave,.aif,.aiff,.aifc,.flac,audio/wav,audio/x-wav,audio/aiff,audio/x-aiff,audio/flac';
export const isIrFileName = (name: string) => /\.(wav|wave|aif|aiff|aifc|flac)$/i.test(name || '');

/** Clés des réponses importées utilisées par les effets d'une piste. */
export function trackUserIrKeys(t: Pick<Track, 'plugins'>): string[] {
  const out: string[] = [];
  for (const p of t.plugins || []) {
    const k = (p?.params as { irUser?: unknown } | undefined)?.irUser;
    if (isUserIrKey(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

export interface IrShape {
  /** Longueur gardée (s) ; 0 ou absente = toute la réponse (bornée à USER_IR_MAX_SEC). */
  lengthSec?: number;
  /** Fondu de sortie à la fin de la partie gardée (s). */
  fadeSec?: number;
}

/**
 * Niveau calibré, calculé sur la réponse ENTIÈRE (avant rognage) : même règle
 * que la normalisation d’un ConvolverNode (spec Web Audio : 1 / puissance RMS,
 * × 0,00125, ramené à 44,1 kHz). Calculée une fois sur la réponse complète, elle
 * ne change pas quand on raccourcit la queue (sinon raccourcir faisait monter
 * le niveau). Le convolveur est alors réglé sans normalisation : la lecture et
 * l'export appliquent le MÊME facteur, quel que soit le navigateur.
 */
export function irCalibration(channels: Float32Array[], sampleRate: number): number {
  let power = 0, n = 0;
  for (const c of channels) { for (let i = 0; i < c.length; i++) power += c[i] * c[i]; n += c.length; }
  let rms = n ? Math.sqrt(power / n) : 0;
  if (!Number.isFinite(rms) || rms < 0.000125) rms = 0.000125;
  // 0,00125 exactement (≈ −58,06 dB), la constante de la spec Web Audio (GainCalibration) :
  // avant (22/10/2026), 10^(−58/20) donnait +0,06 dB de plus qu’un convolveur normalisé.
  return (1 / rms) * 0.00125 * (44100 / sampleRate);
}

/**
 * Réponse prête pour le convolveur : stéréo (une réponse mono va dans les deux
 * canaux ; au-delà de deux canaux, les deux premiers), rognée à `lengthSec`,
 * fondu en cosinus sur `fadeSec`, niveau calibré (voir irCalibration).
 */
export function shapeIr(channels: Float32Array[], sampleRate: number, shape: IrShape = {}): Float32Array[] {
  const src = channels.length ? channels : [new Float32Array(1)];
  const full = src[0].length;
  const maxN = Math.max(1, Math.round(USER_IR_MAX_SEC * sampleRate));
  const want = shape.lengthSec && shape.lengthSec > 0 ? Math.round(shape.lengthSec * sampleRate) : full;
  const n = Math.max(1, Math.min(full, want, maxN));
  const k = irCalibration(src, sampleRate);
  const fadeN = Math.min(n, Math.max(0, Math.round((shape.fadeSec ?? USER_IR_DEFAULT_FADE) * sampleRate)));
  const pick = [src[0], src[1] || src[0]];
  return pick.map(c => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = (c[i] || 0) * k;
    for (let j = 0; j < fadeN; j++) {
      const i = n - fadeN + j;
      // Cosinus de 1 à 0 : dernier échantillon à 0, sans marche.
      out[i] *= 0.5 * (1 + Math.cos(Math.PI * (j + 1) / fadeN));
    }
    return out;
  });
}

/** Durée affichée d'une réponse (s). */
export const irDurationSec = (frames: number, sampleRate: number) => (sampleRate > 0 ? frames / sampleRate : 0);
