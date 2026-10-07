/**
 * Formats de temps de la fenêtre Spot (Pro Tools : Spot Dialog) :
 * - BARS : mesures|temps|ticks (960 ticks par temps, comme Pro Tools), en 4/4
 *   comme la règle de NOVA ;
 * - MINSEC : minutes:secondes.millisecondes ;
 * - SAMPLES : échantillons.
 * Logique pure, testée dans tests/editModes.test.ts.
 */
import { sessionSampleRate, syncOffsetOf, SyncClip } from './editModes';

export type SpotFormat = 'BARS' | 'MINSEC' | 'SAMPLES';
export type SpotAnchor = 'START' | 'SYNC' | 'END';

export const TICKS_PER_BEAT = 960;
export const BEATS_PER_BAR = 4;

export const SPOT_FORMATS: { id: SpotFormat; label: string; example: string }[] = [
  { id: 'BARS', label: 'Mesures|temps|ticks', example: '5|1|000' },
  { id: 'MINSEC', label: 'Min:sec', example: '0:08.000' },
  { id: 'SAMPLES', label: 'Échantillons', example: '384000' },
];

export interface SpotContext { bpm: number; sr?: number; beatsPerBar?: number }

const beatSec = (bpm: number) => 60 / (bpm > 0 ? bpm : 120);

export function formatBars(t: number, c: SpotContext): string {
  const bpb = c.beatsPerBar || BEATS_PER_BAR;
  const ticksTotal = Math.round((Math.max(0, t) / beatSec(c.bpm)) * TICKS_PER_BEAT);
  const beatsTotal = Math.floor(ticksTotal / TICKS_PER_BEAT);
  const ticks = ticksTotal - beatsTotal * TICKS_PER_BEAT;
  const bar = Math.floor(beatsTotal / bpb) + 1;
  const beat = (beatsTotal % bpb) + 1;
  return `${bar}|${beat}|${String(ticks).padStart(3, '0')}`;
}

export function formatMinSec(t: number): string {
  const ms = Math.round(Math.max(0, t) * 1000);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

export function formatSamples(t: number, c: SpotContext): string {
  return String(Math.round(Math.max(0, t) * (c.sr || sessionSampleRate())));
}

export function formatSpot(t: number, f: SpotFormat, c: SpotContext): string {
  return f === 'BARS' ? formatBars(t, c) : f === 'MINSEC' ? formatMinSec(t) : formatSamples(t, c);
}

const num = (s: string) => Number(s.replace(',', '.'));

/** « 5|1|000 », « 5 1 480 », « 5.2 », « 5 » → secondes. Mesure et temps commencent à 1. */
export function parseBars(str: string, c: SpotContext): number | null {
  const parts = str.trim().split(/\s*[|.:\s]\s*/).filter(p => p !== '');
  if (!parts.length || parts.length > 3 || parts.some(p => !/^\d+$/.test(p))) return null;
  const [bar, beat = 1, ticks = 0] = parts.map(Number);
  const bpb = c.beatsPerBar || BEATS_PER_BAR;
  if (bar < 1 || beat < 1 || beat > bpb || ticks >= TICKS_PER_BEAT) return null;
  return ((bar - 1) * bpb + (beat - 1) + ticks / TICKS_PER_BEAT) * beatSec(c.bpm);
}

/** « 1:02.500 », « 0:08,25 », « 1:00:02.5 » (h:m:s) ou « 12.5 » (secondes) → secondes. */
export function parseMinSec(str: string): number | null {
  const parts = str.trim().split(':');
  if (!parts.length || parts.length > 3) return null;
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    if (!(last ? /^\d+(?:[.,]\d+)?$/ : /^\d+$/).test(parts[i])) return null;
    const v = num(parts[i]);
    // Minutes et secondes (sauf la première partie) restent sous 60.
    if (i > 0 && v >= 60) return null;
    total = total * 60 + v;
  }
  return total;
}

/** « 384000 » ou « 384 000 » → secondes. */
export function parseSamples(str: string, c: SpotContext): number | null {
  const s = str.trim().replace(/[\s _']/g, '');
  if (!/^\d+$/.test(s)) return null;
  return Number(s) / (c.sr || sessionSampleRate());
}

/**
 * Lit une position dans le format choisi ; si ça ne colle pas, reconnaît
 * « | » (mesures) et « : » (min:sec) tout seul.
 */
export function parseSpot(str: string, f: SpotFormat, c: SpotContext): { time: number; format: SpotFormat } | null {
  const tryOne = (fmt: SpotFormat) => {
    const t = fmt === 'BARS' ? parseBars(str, c) : fmt === 'MINSEC' ? parseMinSec(str) : parseSamples(str, c);
    return t === null ? null : { time: t, format: fmt };
  };
  const first = tryOne(f);
  if (first) return first;
  if (str.includes('|')) return tryOne('BARS');
  if (str.includes(':')) return tryOne('MINSEC');
  return null;
}

export interface SpotClip extends SyncClip { originStart?: number }

/** Instant affiché pour un ancrage (début, point de synchro, fin). */
export function anchorTime(c: SpotClip, a: SpotAnchor): number {
  if (a === 'END') return c.start + c.duration;
  if (a === 'SYNC') return c.start + (syncOffsetOf(c) ?? 0);
  return c.start;
}

/** Nouveau début du clip pour que l'ancrage tombe à `time` (null si avant 0). */
export function spotStart(c: SpotClip, a: SpotAnchor, time: number): number | null {
  const start = a === 'END' ? time - c.duration : a === 'SYNC' ? time - (syncOffsetOf(c) ?? 0) : time;
  return start < -1e-9 ? null : Math.max(0, start);
}

/**
 * Position d'origine (Pro Tools : Original Time Stamp) : là où ce passage de
 * l'audio a été enregistré. Clip.originStart = instant de la timeline où
 * commençait le fichier ; le passage montré commence `offset` plus loin.
 */
export function originalStartOf(c: SpotClip): number | null {
  return typeof c.originStart === 'number' && Number.isFinite(c.originStart) ? Math.max(0, c.originStart + (c.offset || 0)) : null;
}
