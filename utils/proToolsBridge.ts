/**
 * Pont Pro Tools (chantier 9, B2) — règles pures (testées telles quelles) :
 *  - réglages de l'ingé (dossier, départ de séance, format), bornés à la lecture ;
 *  - quelles prises reçues écrire (nouvelles ou modifiées), sous quel nom, à quelle position ;
 *  - diagnostic de l'entrée système diffusée comme mix (stéréo, mono, un seul côté, muette).
 * Les effets (écriture, micro, WebRTC) sont dans services/ProToolsBridge.ts.
 */
import { BwfFormat, TIMECODE_FPS, TimecodeFps, takeFileName, takeRegion, timecodeToSamples, TakeRegion } from './bwf';

export interface ProToolsSettings {
  /** Écrire chaque prise reçue dans le dossier Pro Tools. */
  enabled: boolean;
  /** Dossier (chemin complet) quand le pont de Nova Studio écrit ; vide = Documents\Nova Studio\Pro Tools. */
  folder: string;
  /** Départ de la séance Pro Tools (Session Start), « HH:MM:SS:FF ». */
  sessionStart: string;
  fps: TimecodeFps;
  format: BwfFormat;
}

export const DEFAULT_PT_SETTINGS: ProToolsSettings = { enabled: false, folder: '', sessionStart: '00:00:00:00', fps: 25, format: '24' };

export const PT_SETTINGS_KEY = 'nova_protools_bridge';

export function sanitizePtSettings(v: unknown): ProToolsSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const fps = (TIMECODE_FPS as readonly number[]).includes(Number(o.fps)) ? (Number(o.fps) as TimecodeFps) : DEFAULT_PT_SETTINGS.fps;
  const tc = typeof o.sessionStart === 'string' && timecodeToSamples(o.sessionStart, fps, 48000) !== null ? o.sessionStart.trim() : DEFAULT_PT_SETTINGS.sessionStart;
  return {
    enabled: o.enabled === true,
    folder: typeof o.folder === 'string' ? o.folder.trim().slice(0, 400) : '',
    sessionStart: tc,
    fps,
    format: o.format === '32f' ? '32f' : '24',
  };
}

/** Une prise reçue (clip posé chez l'ingé). */
export interface IncomingTake {
  clipId: string;
  bufferId?: string;
  start: number;
  offset?: number;
  duration: number;
  takeNumber?: number;
  name?: string;
  isUnlicensed?: boolean;
}

/**
 * Empreinte de la prise (son, position, découpe) : même empreinte = fichier déjà à jour.
 * Les réglages (format, départ de séance) valent pour les prises suivantes : une prise
 * déjà écrite n'est pas réécrite en douce quand l'artiste renvoie sa piste.
 */
export const takeSig = (t: IncomingTake): string => [t.bufferId, t.start, t.offset || 0, t.duration].join('|');

/** Est-ce une prise (et pas un sample, un beat, un rendu) ? */
export const isTake = (t: IncomingTake): boolean =>
  !!t.bufferId && !t.isUnlicensed && typeof t.takeNumber === 'number' && t.takeNumber > 0 && t.duration > 0;

/** Plan d'écriture d'une prise : nom, région, TimeReference (échantillons depuis minuit). */
export interface TakePlan {
  name: string;
  region: TakeRegion;
  /** Décalage du départ de séance, en échantillons. */
  sessionOffset: number;
  timeReference: number;
}

export function planTake(t: IncomingTake, track: string, artist: string, bufferLength: number, sampleRate: number, s: ProToolsSettings): TakePlan | null {
  const region = takeRegion(t, bufferLength, sampleRate);
  if (!region) return null;
  const sessionOffset = timecodeToSamples(s.sessionStart, s.fps, sampleRate) ?? 0;
  return { name: takeFileName(track, t.takeNumber || 1, artist), region, sessionOffset, timeReference: sessionOffset + region.position };
}

/** « 0:12,345 » : position lisible d'une prise. */
export const positionLabel = (samples: number, sampleRate: number): string => {
  const s = samples / sampleRate;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0').replace('.', ',')}`;
};

// --- Entrée système diffusée comme mix -------------------------------------------------------

export type InputVerdict = 'attente' | 'stereo' | 'mono' | 'gauche' | 'droite' | 'muette';

export interface InputWindow {
  /** Canaux annoncés par la piste (getSettings().channelCount), null : inconnu. */
  channelCount: number | null;
  /** Énergie moyenne (carré moyen) gauche, droite, et de la différence G − D, sur la fenêtre. */
  msL: number;
  msR: number;
  msDiff: number;
  /** Durée mesurée (s) ; durée continue sans aucun son (s). */
  seconds: number;
  silentFor: number;
}

const db = (ms: number) => 10 * Math.log10(ms + 1e-20);
/** En dessous : silence (−70 dBFS RMS). */
export const SILENCE_DB = -70;

/** Diagnostic d'une entrée (fenêtre glissante d'environ 1 s). */
export function inputVerdict(w: InputWindow): InputVerdict {
  if (w.silentFor >= 2) return 'muette';
  if (w.seconds < 0.3) return 'attente';
  const l = db(w.msL), r = db(w.msR), peak = Math.max(l, r);
  if (peak < SILENCE_DB) return w.channelCount === 1 ? 'mono' : 'attente';
  if (w.channelCount === 1) return 'mono';
  if (l < SILENCE_DB && r >= SILENCE_DB + 10) return 'droite';
  if (r < SILENCE_DB && l >= SILENCE_DB + 10) return 'gauche';
  // Gauche et droite identiques (à −60 dB près) : du mono sur deux canaux.
  if (db(w.msDiff) < peak - 60) return 'mono';
  return 'stereo';
}

export function inputVerdictMessage(v: InputVerdict, label: string): { text: string; warn: boolean } {
  switch (v) {
    case 'stereo': return { text: `Stéréo : l'artiste reçoit « ${label} » en gauche / droite.`, warn: false };
    case 'mono': return { text: `Entrée mono : l'artiste entendra le même son des deux côtés. Choisis une entrée stéréo (le retour de la sortie de ton logiciel de studio, ex. « CABLE Output » ou « Loopback 1-2 »).`, warn: true };
    case 'gauche': return { text: 'Son seulement à GAUCHE : vérifie que la sortie de ton logiciel de studio envoie bien ses deux canaux vers cette entrée.', warn: true };
    case 'droite': return { text: 'Son seulement à DROITE : vérifie que la sortie de ton logiciel de studio envoie bien ses deux canaux vers cette entrée.', warn: true };
    case 'muette': return { text: `Aucun son sur « ${label} » depuis 2 s : lance la lecture dans ton logiciel de studio et vérifie que sa sortie arrive bien sur cette entrée.`, warn: true };
    default: return { text: 'Écoute de l’entrée…', warn: false };
  }
}

/** Niveau lisible (« −18 dB ») d'une énergie moyenne. */
export const levelLabel = (ms: number): string => {
  const d = db(ms);
  return d < -90 ? '−∞' : `${Math.round(d)} dB`.replace('-', '−');
};
