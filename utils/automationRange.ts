import type { AutomationLane, AutomationPoint, Track } from '../types';
import { valueAtPoints } from './automationWrite';

/**
 * Volume d'une plage (Pro Tools : Sélecteur sur la plage en vue volume, puis
 * outil Trim, ou « Write to Selection ») : la courbe de volume de la plage est
 * montée ou baissée de N dB, avec une rampe courte à chaque bord (pas de clic),
 * le reste du morceau ne bouge pas. Appliqué deux fois : les dB s'ajoutent.
 * Module pur : tests/automationRange.test.ts.
 */

/** Rampe à chaque bord de la plage (s). */
export const RANGE_RAMP = 0.01;
/** Bornes de la voie de volume de NOVA (gain linéaire, 1,5 ≈ +3,5 dB). */
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1.5;

const dbToGain = (db: number) => Math.pow(10, db / 20);
let seq = 0;
const pid = () => `ar-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export interface RangeVolumeResult<T> { track: T; clamped: boolean; points: number }

/**
 * Monte / baisse la voie de volume de `track` de `db` sur [start, end].
 * Sans voie de volume : elle est créée (point de départ = volume du fader).
 * La voie est dépliée (visible sous la piste).
 */
export function trimVolumeRange<T extends Pick<Track, 'volume' | 'automationLanes' | 'color'>>(track: T, start: number, end: number, db: number): RangeVolumeResult<T> {
  const a = Math.max(0, Math.min(start, end));
  const b = Math.max(start, end);
  const lanes = track.automationLanes || [];
  const existing = lanes.find(l => l.parameterName === 'volume');
  const lo = existing?.min ?? VOLUME_MIN;
  const hi = Math.max(existing?.max ?? VOLUME_MAX, VOLUME_MAX);
  const base = Number.isFinite(track.volume) ? track.volume : 1;
  const pts: AutomationPoint[] = existing && existing.points.length
    ? [...existing.points].sort((p, q) => p.time - q.time)
    : [{ id: pid(), time: 0, value: base }];
  if (b - a < 1e-4 || !Number.isFinite(db) || Math.abs(db) < 1e-9) return { track, clamped: false, points: 0 };
  const g = dbToGain(db);
  const at = (t: number) => valueAtPoints(pts, t, base);
  let clamped = false;
  const clamp = (v: number) => { const c = Math.max(lo, Math.min(hi, v)); if (Math.abs(c - v) > 1e-9) clamped = true; return c; };
  const preT = a - RANGE_RAMP;
  const postT = b + RANGE_RAMP;
  const out: AutomationPoint[] = pts.filter(p => p.time < Math.max(0, preT) - 1e-9 || p.time > postT + 1e-9);
  const added: AutomationPoint[] = [];
  if (preT > 1e-6) added.push({ id: pid(), time: preT, value: at(preT) });
  added.push({ id: pid(), time: a, value: clamp(at(a) * g) });
  for (const p of pts) if (p.time > a + 1e-9 && p.time < b - 1e-9) added.push({ ...p, value: clamp(p.value * g) });
  added.push({ id: pid(), time: b, value: clamp(at(b) * g) });
  added.push({ id: pid(), time: postT, value: at(postT) });
  // Le début du morceau garde sa valeur (plage qui commence à 0 : rien avant).
  const next = [...out, ...added].sort((p, q) => p.time - q.time);
  const lane: AutomationLane = existing
    ? { ...existing, points: next, isExpanded: true, max: hi, min: lo }
    : { id: `auto-${Date.now().toString(36)}`, parameterName: 'volume', points: next, color: track.color, isExpanded: true, min: lo, max: hi };
  const newLanes = existing ? lanes.map(l => (l === existing ? lane : l)) : [...lanes, lane];
  return { track: { ...track, automationLanes: newLanes }, clamped, points: added.length };
}

/** « +2 dB », « −1,5 dB ». */
export const fmtDb = (db: number) => `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(Math.round(db * 10) / 10).toString().replace('.', ',')} dB`;

/** Saisie libre : « 2 », « +2 », « -1,5 », « −3 dB » → nombre (null si illisible). */
export function parseDb(text: string): number | null {
  const t = (text || '').replace(/[−–]/g, '-').replace(',', '.').replace(/db/i, '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && Math.abs(n) <= 48 ? n : null;
}
