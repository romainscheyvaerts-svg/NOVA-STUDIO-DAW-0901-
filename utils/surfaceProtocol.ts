import { FADER_MAX_GAIN, faderPosToGain, gainToFaderPos } from './faderLaw';
/**
 * Surfaces de contrôle (chantier A5) : vocabulaire commun aux protocoles
 * Mackie Control Universal (utils/mcu.ts) et HUI (utils/hui.ts).
 *
 * Un « codec » traduit les octets MIDI de la surface en événements simples
 * (fader, toucher, bouton, potard, molette) et, dans l'autre sens, l'état de
 * NOVA en messages (moteur des faders, voyants, anneaux des potards, afficheurs,
 * vumètres, compteur). La logique (banques, anti-combat des faders, écriture
 * d'automation) vit dans services/ControlSurfaceController.ts, sans Web MIDI.
 *
 * Logique pure : tests/controlSurface.test.ts.
 */

export type SurfaceProtocolId = 'mcu' | 'hui';

/** Tranches d'une banque (MCU, HUI, X-Touch, UF8 : 8). */
export const STRIPS = 8;
/** Indice du fader master (MCU : pitch bend canal 9). */
export const MASTER_STRIP = 8;

/** Boutons compris par NOVA (les autres sont ignorés). */
export type SurfaceButton =
  // par tranche
  | 'rec' | 'solo' | 'mute' | 'select' | 'vpotPush'
  // banques
  | 'bankLeft' | 'bankRight' | 'channelLeft' | 'channelRight'
  // transport
  | 'play' | 'stop' | 'record' | 'rewind' | 'forward' | 'loop'
  // molette, compteur
  | 'scrub' | 'timeMode'
  // automation de la piste sélectionnée
  | 'autoRead' | 'autoWrite' | 'autoTrim' | 'autoTouch' | 'autoLatch'
  // divers
  | 'undo' | 'save' | 'marker' | 'click'
  // voyants seuls (MCU : SMPTE / BEATS à côté du compteur)
  | 'smpteLed' | 'beatsLed';

export type SurfaceEvent =
  /** Fader (0…1, position mécanique) ; strip 0-7, 8 = master. */
  | { kind: 'fader'; strip: number; value: number }
  /** Doigt posé / levé sur un fader tactile. */
  | { kind: 'touch'; strip: number; on: boolean }
  | { kind: 'button'; button: SurfaceButton; strip?: number; pressed: boolean }
  /** Potard (V-Pot) : crans signés, positif = sens horaire. */
  | { kind: 'vpot'; strip: number; delta: number }
  /** Molette jog : crans signés, positif = sens horaire. */
  | { kind: 'jog'; delta: number }
  /** La surface s'est présentée (réponse à l'interrogation, ping HUI). */
  | { kind: 'hello'; detail?: string }
  /** Messages à renvoyer tout de suite (poignée de main MCU). */
  | { kind: 'reply'; messages: number[][] };

export interface SurfaceCodec {
  readonly protocol: SurfaceProtocolId;
  /** Caractères par tranche sur l'afficheur (MCU 7 dont un séparateur, HUI 4). */
  readonly cellWidth: number;
  /** Lignes d'afficheur par tranche (MCU 2, HUI 1). */
  readonly lcdRows: number;
  /** Chiffres du compteur (MCU 10, HUI 8). */
  readonly timecodeDigits: number;
  /** Octets reçus de la surface → événements. */
  decode(bytes: ArrayLike<number>): SurfaceEvent[];
  /** Position d'un fader motorisé (0…1). */
  fader(strip: number, value: number): number[][];
  /** Voyant d'un bouton ; null si la surface n'en a pas. */
  led(button: SurfaceButton, strip: number | undefined, on: boolean): number[][] | null;
  /** Anneau du potard : panoramique −1…1. */
  vpotPan(strip: number, pan: number): number[][];
  /** Texte d'une case de l'afficheur (déjà à la bonne largeur). */
  lcd(strip: number, row: number, text: string): number[][];
  /** Vumètre : niveau 0…12 (12 = 0 dBFS). */
  meter(strip: number, level: number): number[][];
  /** Compteur : texte (chiffres et lettres) + points, de gauche à droite ; seuls les chiffres changés sont envoyés. */
  timecode(text: string, dots: boolean[], prev: string | null, prevDots: boolean[] | null): number[][];
  /** Afficheur 2 caractères (MCU « Assignment ») ; [] si absent. */
  assignment(text: string): number[][];
  /** Interrogation de la surface à la connexion. */
  query(): number[][];
  /** À renvoyer régulièrement pour garder la surface en ligne (HUI : ping chaque seconde). */
  keepAlive(): number[][];
  /** Surface « éteinte » : faders en bas, voyants et afficheurs éteints. */
  reset(): number[][];
}

// --- Conversions communes -----------------------------------------------------------

/** Course du volume de NOVA (gain linéaire, +12 dB en haut), comme son fader à l'écran. */
export const VOLUME_MAX = FADER_MAX_GAIN;

/** Volume (gain) → position du fader 0…1 (même échelle que la console de NOVA, utils/faderLaw). */
export const volumeToFader = (v: number): number => gainToFaderPos(Math.max(0, Number.isFinite(v) ? v : 0));

/** Position du fader 0…1 → volume (gain). */
export const faderToVolume = (p: number): number => faderPosToGain(Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0)));

export const to14 = (p: number): number => Math.max(0, Math.min(16383, Math.round(Math.max(0, Math.min(1, p)) * 16383)));
export const from14 = (v: number): number => Math.max(0, Math.min(1, v / 16383));

/**
 * Vumètre de la surface : 12 segments (Mackie : −60, −50, −40, −30, −20, −14,
 * −10, −8, −6, −4, −2, 0 dBFS). Le même barème sert au HUI.
 */
export const METER_STEPS_DB = [-60, -50, -40, -30, -20, -14, -10, -8, -6, -4, -2, 0];
export const dbToMeterLevel = (db: number | null | undefined): number => {
  if (typeof db !== 'number' || !Number.isFinite(db)) return 0;
  let n = 0;
  for (const s of METER_STEPS_DB) if (db >= s - 1e-9) n++;
  return n;
};

/** Texte affichable par une surface : ASCII imprimable (accents retirés). */
export const asciiOnly = (s: string): string =>
  String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[œŒ]/g, m => (m === 'œ' ? 'oe' : 'OE')).replace(/[æÆ]/g, m => (m === 'æ' ? 'ae' : 'AE'))
    .replace(/[−–—]/g, '-')
    .replace(/[^\x20-\x7e]/g, '');

/**
 * Nom de piste réduit à `width` caractères, façon Pro Tools : on retire les
 * espaces, puis les voyelles (sauf la première lettre), puis on coupe.
 */
export const abbreviate = (name: string, width: number): string => {
  let s = asciiOnly(name).trim();
  if (s.length <= width) return s;
  s = s.replace(/\s+/g, '');
  if (s.length <= width) return s;
  const head = s[0];
  let rest = s.slice(1);
  while (head.length + rest.length > width) {
    const i = rest.search(/[aeiouy](?!.*[aeiouy])/);
    if (i < 0) break;
    rest = rest.slice(0, i) + rest.slice(i + 1);
  }
  return (head + rest).slice(0, width);
};

/** Case d'afficheur : `width` caractères, centrée, une colonne libre à droite pour séparer les tranches. */
export const lcdCell = (text: string, width: number, separator = true): string => {
  const inner = separator ? width - 1 : width;
  const t = abbreviate(text, inner);
  const left = Math.floor((inner - t.length) / 2);
  return (' '.repeat(left) + t).padEnd(inner, ' ') + (separator ? ' ' : '');
};

/** Volume lisible sur l'afficheur (« -6.0 », « +2.5 », « -inf »). */
export const fmtDbShort = (gain: number): string => {
  if (!(gain > 1e-5)) return '-inf';
  const db = 20 * Math.log10(gain);
  const r = Math.round(db * 10) / 10;
  if (Math.abs(r) < 0.05) return '0.0';
  return `${r > 0 ? '+' : ''}${r.toFixed(Math.abs(r) >= 10 ? 0 : 1)}`;
};

/** Panoramique lisible (« <C> », « L30 », « R100 »). */
export const fmtPanShort = (pan: number): string => {
  const p = Math.round(Math.max(-1, Math.min(1, pan || 0)) * 100);
  if (p === 0) return '<C>';
  return `${p < 0 ? 'L' : 'R'}${Math.abs(p)}`;
};

// --- Compteur ---------------------------------------------------------------------

export interface CounterText { text: string; dots: boolean[] }

/**
 * Mesures (« BBB.bb.ss.ttt » sur 10 chiffres, comme Logic / Pro Tools sur un
 * MCU) : mesure (3), temps (2), double-croche (2), ticks (3, sur 240 par double-croche).
 */
export const barsCounter = (bar: number, beat: number, frac: number, digits = 10): CounterText => {
  const sixteenth = Math.min(3, Math.floor(frac * 4 + 1e-9));
  const ticks = Math.min(239, Math.floor((frac * 4 - sixteenth) * 240 + 1e-6));
  const b = String(Math.max(1, bar + 1)).padStart(3, ' ').slice(-3);
  const bt = String(beat + 1).padStart(2, ' ').slice(-2);
  const sx = String(sixteenth + 1).padStart(2, ' ').slice(-2);
  const tk = String(Math.max(0, ticks)).padStart(3, '0');
  const full = `${b}${bt}${sx}${tk}`;
  const dots = Array(10).fill(false);
  dots[2] = true; dots[4] = true; dots[6] = true;
  return trimCounter({ text: full, dots }, digits);
};

/** Temps (« HHH.MM.SS.FFF » sur 10 chiffres : heures, minutes, secondes, images à 30 i/s). */
export const smpteCounter = (seconds: number, digits = 10, fps = 30): CounterText => {
  const t = Math.max(0, seconds || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const f = Math.min(fps - 1, Math.floor((t - Math.floor(t)) * fps + 1e-6));
  const full = `${String(h).padStart(3, ' ').slice(-3)}${String(m).padStart(2, '0')}${String(s).padStart(2, '0')}${String(f).padStart(3, '0').slice(-3)}`;
  const dots = Array(10).fill(false);
  dots[2] = true; dots[4] = true; dots[6] = true;
  return trimCounter({ text: full, dots }, digits);
};

/** Compteur plus court (HUI : 8 chiffres) : on garde la droite, en retirant les chiffres de tête. */
const trimCounter = (c: CounterText, digits: number): CounterText => {
  if (digits >= c.text.length) return c;
  const cut = c.text.length - digits;
  return { text: c.text.slice(cut), dots: c.dots.slice(cut) };
};
