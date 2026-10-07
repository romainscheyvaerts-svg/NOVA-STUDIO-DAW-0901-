/**
 * Détection d'attaques (Pro Tools : Tab to Transient). Énergie par tranches de
 * 5 ms : une attaque = un saut d'au moins 9 dB par rapport aux 20 ms d'avant,
 * au-dessus de -50 dBFS, au moins 60 ms après la précédente. La position est
 * ensuite affinée à l'échantillon (premier échantillon qui dépasse 30 % de la
 * crête de la tranche). Logique pure (tests/editModes.test.ts) + cache par buffer.
 */

export interface TransientOptions {
  hopSec?: number;
  jumpDb?: number;
  floorDb?: number;
  minGapSec?: number;
}

/** Instants (s, depuis le début de l'audio) des attaques d'un signal mono. */
export function detectTransients(x: Float32Array | number[], sr: number, o: TransientOptions = {}): number[] {
  const hop = Math.max(16, Math.round(sr * (o.hopSec ?? 0.005)));
  const jump = o.jumpDb ?? 9;
  const floor = o.floorDb ?? -50;
  const minGap = Math.round(sr * (o.minGapSec ?? 0.06));
  const frames = Math.floor(x.length / hop);
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * hop, e = i + hop; i < e; i++) s += x[i] * x[i];
    const rms = Math.sqrt(s / hop);
    db[f] = rms > 1e-9 ? 20 * Math.log10(rms) : -200;
  }
  const out: number[] = [];
  let last = -Infinity;
  for (let f = 1; f < frames; f++) {
    if (db[f] < floor) continue;
    let prevMin = Infinity;
    for (let k = Math.max(0, f - 4); k < f; k++) prevMin = Math.min(prevMin, db[k]);
    if (db[f] - prevMin < jump) continue;
    // Le saut peut s'étaler sur deux tranches : on prend la tranche d'avant si elle monte déjà.
    const f0 = f > 0 && db[f - 1] - prevMin >= jump / 2 && db[f - 1] >= floor ? f - 1 : f;
    let peak = 0;
    for (let i = f0 * hop, e = Math.min(x.length, (f + 1) * hop); i < e; i++) peak = Math.max(peak, Math.abs(x[i]));
    let at = f0 * hop;
    for (let i = f0 * hop, e = Math.min(x.length, (f + 1) * hop); i < e; i++) if (Math.abs(x[i]) >= peak * 0.3) { at = i; break; }
    if (at - last < minGap) continue;
    out.push(at / sr);
    last = at;
  }
  return out;
}

const cache = new WeakMap<object, number[]>();

/** Attaques d'un AudioBuffer (canaux mélangés), mises en cache. */
export function transientsOf(buffer: AudioBuffer): number[] {
  const hit = cache.get(buffer);
  if (hit) return hit;
  const n = buffer.length, ch = buffer.numberOfChannels;
  let mono: Float32Array;
  if (ch === 1) mono = buffer.getChannelData(0);
  else {
    mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
  }
  const list = detectTransients(mono, buffer.sampleRate);
  cache.set(buffer, list);
  return list;
}

export interface TabClip { start: number; duration: number; offset?: number; isReversed?: boolean }

/** Attaques d'un clip en temps de la timeline (seulement la partie visible du clip). */
export function clipTransients(c: TabClip, sourceTimes: number[], bufferDuration?: number): number[] {
  const off = c.offset || 0;
  return sourceTimes
    .map(s => (c.isReversed && bufferDuration !== undefined ? bufferDuration - s : s))
    .filter(s => s >= off - 1e-9 && s <= off + c.duration + 1e-9)
    .map(s => c.start + (s - off))
    .sort((a, b) => a - b);
}

/** Prochain instant de la liste après `t` (dir 1) ou avant (dir -1), à 1 ms près. */
export function nextIn(list: number[], t: number, dir: 1 | -1): number | null {
  if (dir > 0) { for (const v of list) if (v > t + 1e-3) return v; return null; }
  for (let i = list.length - 1; i >= 0; i--) if (list[i] < t - 1e-3) return list[i];
  return null;
}
