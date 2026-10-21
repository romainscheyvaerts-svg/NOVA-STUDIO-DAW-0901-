import { useSyncExternalStore } from 'react';

/**
 * Talkback, comme sur une console de studio (logique pure, sans audio).
 *
 * - Bouton de la barre de transport et touche du clavier (N par défaut, réglable
 *   dans « Personnaliser les raccourcis ») :
 *     appui COURT  (< 300 ms) = verrouillé : ça reste ouvert, un 2e appui coupe ;
 *     appui MAINTENU (≥ 300 ms) = ouvert tant qu'on tient (relâcher coupe).
 * - En collaboration : pilote le talkback EN DIRECT (services/CollabRtc), des deux côtés.
 * - Au studio (même PC, hors collaboration) : la voix du micro talkback part dans les
 *   mixes casque (engine/CueMixEngine), ou sur la sortie d'écoute s'il n'y a pas de mix
 *   casque ; JAMAIS dans le master, l'export ni les prises. Pendant qu'on parle, la
 *   musique baisse (« dim », −15 dB par défaut). Coupé pendant une prise.
 */

/** Au-delà, l'appui est « maintenu » (on parle tant qu'on tient). */
export const TALKBACK_HOLD_MS = 300;

/** Touche par défaut (libre partout : NOVA, Studio pro, FL Studio, Ableton Live, Keyboard Focus, clavier MIDI). */
export const TALKBACK_DEFAULT_KEY = 'n';

export type TalkbackSource = 'key' | 'button';

/**
 * Machine à états du bouton talkback. `onChange(open, latched)` est appelé à chaque
 * changement (ouverture, fermeture, verrouillage). Une seule source à la fois (la touche ou le bouton).
 */
export class TalkbackLatch {
  private isOpen = false;
  private isLatched = false;
  private down: { src: TalkbackSource; at: number; closing: boolean } | null = null;

  constructor(private onChange: (open: boolean, latched: boolean) => void = () => {}, private holdMs = TALKBACK_HOLD_MS) {}

  get open() { return this.isOpen; }
  /** Ouvert par un appui court (reste ouvert après le relâchement). */
  get latched() { return this.isLatched; }
  /** Une touche ou le bouton est tenu en ce moment. */
  get holding(): TalkbackSource | null { return this.down?.src ?? null; }

  private set(open: boolean, latched: boolean) {
    const l = open && latched;
    const changed = open !== this.isOpen || l !== this.isLatched;
    this.isOpen = open;
    this.isLatched = l;
    if (changed) this.onChange(open, l);
  }

  /** Appui (touche enfoncée, doigt / souris posés). Les répétitions du clavier sont ignorées. */
  press(src: TalkbackSource, now = Date.now()) {
    if (this.down) return;
    if (this.isOpen) {
      // Ouvert (verrouillé, ou par la palette) : ce 2e appui coupe tout de suite ; son relâchement ne fait rien.
      this.down = { src, at: now, closing: true };
      this.set(false, false);
      return;
    }
    this.down = { src, at: now, closing: false };
    this.set(true, false);
  }

  /** Relâchement : court = reste ouvert (verrouillé) ; maintenu = coupe. */
  release(src: TalkbackSource, now = Date.now()) {
    const d = this.down;
    if (!d || d.src !== src) return;
    this.down = null;
    if (d.closing || !this.isOpen) return;
    if (now - d.at < this.holdMs) this.set(true, true);
    else this.set(false, false);
  }

  /** Bascule (palette Ctrl+K, chat, clavier sur le bouton) : ouvert verrouillé, ou coupé. */
  toggle() {
    if (this.isOpen) this.forceClose();
    else this.set(true, true);
  }

  /** Coupe quoi qu'il arrive (prise qui commence, micro refusé, fin de collaboration). */
  forceClose() {
    if (this.down) this.down.closing = true;
    this.set(false, false);
  }
}

// --- Mixage du talkback local -------------------------------------------------------------

export const dbToGain = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20));

export interface TalkbackMixPlan {
  /** Où part la voix : les mixes casque, ou la sortie d'écoute (pas de mix casque). */
  route: 'cue' | 'main';
  /** Gain de la voix du talkback (0 = coupé). */
  talkGain: number;
  /** Gain de la musique dans le casque et l'écoute (1 = normal, dim quand on parle). */
  musicGain: number;
}

/**
 * Plan du talkback local : la voix seulement quand il est ouvert ET qu'aucune prise
 * ne tourne ; la musique baissée du « dim » pendant ce temps. Jamais vers le master.
 */
export function talkbackPlan(o: { open: boolean; recording: boolean; cueMixCount: number; dimDb: number; levelDb: number }): TalkbackMixPlan {
  const active = o.open && !o.recording;
  const dim = Math.max(-60, Math.min(0, Number.isFinite(o.dimDb) ? o.dimDb : DEFAULT_TALKBACK.dimDb));
  const level = Math.max(-24, Math.min(12, Number.isFinite(o.levelDb) ? o.levelDb : 0));
  return {
    route: o.cueMixCount > 0 ? 'cue' : 'main',
    talkGain: active ? dbToGain(level) : 0,
    musicGain: active ? dbToGain(dim) : 1,
  };
}

// --- Réglages (micro talkback, dim, niveau), gardés sur l'appareil ------------------------

export interface TalkbackSettings {
  /** Entrée du talkback ('' = micro par défaut de l'ordinateur). */
  deviceId: string;
  /** Baisse de la musique pendant qu'on parle (dB, 0 = aucune). */
  dimDb: number;
  /** Niveau de la voix du talkback dans le casque (dB). */
  levelDb: number;
}

export const DEFAULT_TALKBACK: TalkbackSettings = { deviceId: '', dimDb: -15, levelDb: 0 };
const STORAGE_KEY = 'nova_talkback_v1';

function sanitize(raw: any): TalkbackSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TALKBACK };
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  return {
    deviceId: typeof raw.deviceId === 'string' && raw.deviceId.length < 300 ? raw.deviceId : '',
    dimDb: num(raw.dimDb, DEFAULT_TALKBACK.dimDb, -60, 0),
    levelDb: num(raw.levelDb, DEFAULT_TALKBACK.levelDb, -24, 12),
  };
}

let settings: TalkbackSettings = (() => {
  try { const t = localStorage.getItem(STORAGE_KEY); return t ? sanitize(JSON.parse(t)) : { ...DEFAULT_TALKBACK }; } catch { return { ...DEFAULT_TALKBACK }; }
})();
const listeners = new Set<() => void>();

export const talkbackSettingsStore = {
  get: (): TalkbackSettings => settings,
  set(patch: Partial<TalkbackSettings>) {
    settings = sanitize({ ...settings, ...patch });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* stockage indisponible : réglage gardé le temps de la session */ }
    listeners.forEach(l => l());
  },
  reset() { this.set({ ...DEFAULT_TALKBACK }); },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};

export const useTalkbackSettings = (): TalkbackSettings =>
  useSyncExternalStore(talkbackSettingsStore.subscribe, talkbackSettingsStore.get, talkbackSettingsStore.get);

// --- Textes -------------------------------------------------------------------------------

/** Message clair quand le micro du talkback ne s'ouvre pas (getUserMedia). */
export function talkbackMicError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return '🎙️ Talkback : le micro est refusé. Autorise-le (icône 🔒 à gauche de l’adresse, « Micro » › Autoriser), puis réappuie.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError')
    return '🎙️ Talkback : aucun micro trouvé. Branche un micro ou choisis-en un autre dans Réglages audio › Talkback.';
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return '🎙️ Talkback : le micro est déjà pris par une autre appli. Ferme-la ou choisis un autre micro dans Réglages audio › Talkback.';
  return '🎙️ Talkback : le micro n’est pas disponible (autorise-le dans le navigateur, puis réappuie).';
}

/** Infobulle du bouton (le raccourci actif, et ce que fait le talkback ici). */
export function talkbackTitle(keyHint: string, collab: boolean): string {
  const key = keyHint ? ` (touche ${keyHint})` : '';
  const how = 'appui court = reste ouvert, 2e appui = coupé ; maintenu = tu parles tant que tu tiens.';
  return collab
    ? `Talkback${key} : ${how} Ta voix part en direct chez les autres de la séance (coupée chez l’artiste pendant sa prise).`
    : `Talkback${key} : ${how} Ta voix part dans le casque de l’artiste (mixes casque, ou la sortie d’écoute), jamais dans le mix, l’export ni les prises ; la musique baisse pendant que tu parles.`;
}

/** Pastille « 🎙️ Nina te parle » (plusieurs : « Nina, Max te parlent »). */
export function talkingLabel(names: string[]): string {
  if (!names.length) return '';
  return `🎙️ ${names.join(', ')} te parle${names.length > 1 ? 'nt' : ''}`;
}
