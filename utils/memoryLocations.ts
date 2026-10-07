import type { Marker } from '../types';

/**
 * Repères numérotés (Pro Tools : Memory Locations). Un repère créé ici garde
 * son numéro ; les anciens repères (sans numéro) reçoivent les plus petits
 * numéros libres, dans l'ordre du temps.
 */
export const markerNumbers = (markers: Marker[]): Map<string, number> => {
  const out = new Map<string, number>();
  const used = new Set<number>();
  for (const m of markers) {
    if (typeof m.number === 'number' && m.number > 0 && !used.has(m.number)) { out.set(m.id, m.number); used.add(m.number); }
  }
  let next = 1;
  for (const m of [...markers].sort((a, b) => a.time - b.time)) {
    if (out.has(m.id)) continue;
    while (used.has(next)) next++;
    out.set(m.id, next); used.add(next);
  }
  return out;
};

export const nextMarkerNumber = (markers: Marker[]): number => {
  const used = new Set(markerNumbers(markers).values());
  let n = 1;
  while (used.has(n)) n++;
  return n;
};

export const markerByNumber = (markers: Marker[], n: number): Marker | undefined => {
  const nums = markerNumbers(markers);
  return markers.find(m => nums.get(m.id) === n);
};

/** « 12.3 » (mesure.temps) en 4/4, comme la règle de NOVA. */
export const barsBeats = (time: number, bpm: number): string => {
  const beat = 60 / (bpm > 0 ? bpm : 120);
  const totalBeats = Math.max(0, time) / beat;
  const bar = Math.floor(totalBeats / 4) + 1;
  const b = Math.floor(totalBeats % 4) + 1;
  return `${bar}.${b}`;
};

export const minSec = (time: number): string => {
  const t = Math.max(0, time);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

/** Saisie « . N . » du pavé numérique : renvoie le numéro tapé une fois la saisie close. */
export class MarkerRecallBuffer {
  private digits: string | null = null;
  private startedAt = 0;
  get active() { return this.digits !== null; }
  get typed() { return this.digits ?? ''; }
  /** « . » : ouvre la saisie, ou la ferme (renvoie le numéro). */
  dot(now = Date.now()): number | null {
    if (this.digits === null || now - this.startedAt > 4000) { this.digits = ''; this.startedAt = now; return null; }
    return this.close();
  }
  digit(d: string): boolean {
    if (this.digits === null) return false;
    if (this.digits.length < 4) this.digits += d;
    return true;
  }
  close(): number | null {
    const n = this.digits ? parseInt(this.digits, 10) : NaN;
    this.digits = null;
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  cancel() { this.digits = null; }
}
