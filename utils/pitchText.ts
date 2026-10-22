/**
 * Nova Pitch : hauteurs et durées écrites (affichage et saisie au clavier).
 * « La3 +4 c », « Sol#2 −10 c », « A3+4 », « 57,04 », « +2 c » (relatif) ;
 * durées « 420 ms », « 0,42 s », « 1/8 » (d'une ronde), « 2 t » (temps).
 */
import { NOTE_NAMES_FR } from './scales';

/** Pas fin de l'éditeur : 1/50 de demi-ton = 2 cents. */
export const FINE_STEP = 0.02;
export const roundFine = (semis: number) => Math.round(semis / FINE_STEP) * FINE_STEP;

/** « La3 +4 c » : demi-ton le plus proche et écart en cents. */
export function fmtPitch(m: number): string {
  if (!Number.isFinite(m)) return '—';
  const r = Math.round(m);
  const c = Math.round((m - r) * 100);
  const name = `${NOTE_NAMES_FR[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 2}`;
  return `${name} ${c > 0 ? '+' : c < 0 ? '−' : '±'}${Math.abs(c)} c`;
}

const FR: Record<string, number> = { do: 0, re: 2, ré: 2, mi: 4, fa: 5, sol: 7, la: 9, si: 11 };
const EN: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

const num = (s: string) => Number(s.replace(',', '.').replace('−', '-'));

/**
 * Hauteur saisie → MIDI fractionnaire (null si illisible). `current` sert aux
 * saisies relatives (« +4 c », « -1 dt »).
 */
export function parsePitch(text: string, current?: number): number | null {
  const s = text.trim().toLowerCase().replace(/−/g, '-').replace(/\s+/g, ' ');
  if (!s) return null;
  // Relatif : +4 c, -10 cents, +1 dt / demi-ton.
  const rel = s.match(/^([+-]\s?\d+(?:[.,]\d+)?)\s*(c|ct|cents?|dt|demi-?tons?|st)?$/);
  if (rel && typeof current === 'number' && (rel[2] || /^[+-]/.test(s)) && !/^\d/.test(s)) {
    const v = num(rel[1].replace(/\s/g, ''));
    const unit = rel[2] || 'c';
    return current + (/^c/.test(unit) ? v / 100 : v);
  }
  // Nombre MIDI.
  if (/^\d+(?:[.,]\d+)?$/.test(s)) { const v = num(s); return v >= 0 && v <= 127 ? v : null; }
  // Nom de note + octave + cents.
  const m = s.match(/^(do|ré|re|mi|fa|sol|la|si|[a-g])\s*(#|♯|b|♭|bémol|dièse)?\s*(-?\d)\s*(?:([+-]\s?\d+(?:[.,]\d+)?)\s*(?:c|ct|cents?)?)?$/);
  if (!m) return null;
  const base = FR[m[1]] ?? EN[m[1]];
  if (base === undefined) return null;
  const acc = m[2] ? (/^(#|♯|dièse)$/.test(m[2]) ? 1 : -1) : 0;
  const oct = Number(m[3]);
  const cents = m[4] ? num(m[4].replace(/\s/g, '')) : 0;
  const midi = (oct + 2) * 12 + base + acc + cents / 100;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/** Durée saisie → secondes (null si illisible). « 1/8 » = un huitième de ronde ; « 2 t » = deux temps. */
export function parseDuration(text: string, bpm: number): number | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  const beat = 60 / Math.max(1, bpm || 120);
  let m = s.match(/^(\d+(?:[.,]\d+)?)ms$/);
  if (m) return num(m[1]) / 1000;
  m = s.match(/^(\d+(?:[.,]\d+)?)s$/);
  if (m) return num(m[1]);
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m && Number(m[2]) > 0) return (Number(m[1]) / Number(m[2])) * 4 * beat;
  m = s.match(/^(\d+(?:[.,]\d+)?)(t|temps|b|beats?)$/);
  if (m) return num(m[1]) * beat;
  m = s.match(/^(\d+(?:[.,]\d+)?)$/);
  if (m) return num(m[1]) / 1000; // nombre seul : millisecondes
  return null;
}

/** « 420 ms · 0,84 t » */
export function fmtDuration(sec: number, bpm?: number): string {
  const ms = Math.round(sec * 1000);
  const beats = bpm ? sec / (60 / bpm) : NaN;
  return Number.isFinite(beats) ? `${ms} ms · ${beats.toFixed(2).replace('.', ',')} t` : `${ms} ms`;
}
