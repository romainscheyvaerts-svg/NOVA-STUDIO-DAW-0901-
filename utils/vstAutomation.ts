import type { AutomationPoint, PluginInstance, Track } from '../types';
import { interpolateCurve, parsePluginParam, playedLanes, sortedPoints } from './automationWrite';

/**
 * Automation des VST du PC (R9) — côté rendu hors ligne (gel, export, Commit).
 *
 * En lecture, le worklet du pont (vst-bridge-processor-v5) envoie avec chaque
 * bloc de 128 échantillons :
 *   - la valeur au début du bloc si elle a bougé de plus de VST_AUTO_TOL, au plus
 *     une fois tous les VST_AUTO_RAMP_BLOCKS blocs (débit des rampes limité) ;
 *   - tout saut de plus de VST_AUTO_JUMP dans le bloc, à son échantillon exact.
 * Le rendu hors ligne envoie au pont la MÊME suite de changements, calculée ici
 * à partir des voies (images depuis le début du son rendu) : l'export rejoue
 * l'automation comme la lecture, au bloc près pour les rampes et à l'échantillon
 * près pour les paliers.
 */

export const VST_AUTO_BLOCK = 128;
export const VST_AUTO_TOL = 1e-4;
export const VST_AUTO_JUMP = 0.02;
export const VST_AUTO_RAMP_BLOCKS = 2;

export interface VstAutomationLane { name: string; frames: number[]; values: number[] }

/** Valeur d'une voie triée, avec un curseur qui avance (lecture séquentielle). */
class Walker {
  private i = 0;
  constructor(private pts: AutomationPoint[]) {}
  at(t: number): number {
    const p = this.pts;
    if (!p.length) return 0;
    if (t <= p[0].time) return p[0].value;
    const last = p[p.length - 1];
    if (t >= last.time) return last.value;
    if (this.i > 0 && p[this.i].time > t) this.i = 0;
    while (this.i < p.length - 2 && p[this.i + 1].time <= t) this.i++;
    const a = p[this.i], b = p[this.i + 1];
    const d = b.time - a.time;
    return interpolateCurve(a.value, b.value, d > 0 ? (t - a.time) / d : 1, a.curveType || 'LINEAR');
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Changements à rejouer pour une voie (valeurs brutes 0–1) sur un rendu de
 * `frames` échantillons commençant au temps `startTime` du morceau.
 */
export function laneEvents(points: AutomationPoint[], startTime: number, sampleRate: number, frames: number): { frames: number[]; values: number[] } {
  const pts = sortedPoints(points);
  const out = { frames: [] as number[], values: [] as number[] };
  if (!pts.length || frames <= 0) return out;
  const w = new Walker(pts);
  // Instants des paliers (saut de plus de JUMP en un point) : appliqués à l'échantillon près.
  const steps = new Map<number, number[]>();
  const before = new Walker(pts);
  for (let k = 0; k < pts.length; k++) {
    // Premier échantillon à l'heure du point ou après (règle de setValueAtTime en Web Audio).
    const f = Math.ceil((pts[k].time - startTime) * sampleRate - 1e-7);
    if (f <= 0 || f >= frames) continue;
    const prev = k > 0 ? (pts[k - 1].curveType === 'HOLD' || pts[k - 1].time === pts[k].time ? pts[k - 1].value : before.at(pts[k].time - 1e-9)) : pts[k].value;
    if (Math.abs(pts[k].value - prev) > VST_AUTO_JUMP) {
      const b = Math.floor(f / VST_AUTO_BLOCK);
      const l = steps.get(b) || [];
      l.push(f);
      steps.set(b, l);
    }
  }
  let last = NaN;
  let lastAt = -1e9;
  const nBlocks = Math.ceil(frames / VST_AUTO_BLOCK);
  for (let b = 0; b < nBlocks; b++) {
    const f0 = b * VST_AUTO_BLOCK;
    // Valeurs en flottants 32 bits, comme l'AudioParam lu par le worklet : mêmes décisions, au bit près.
    const v0 = Math.fround(clamp01(w.at(startTime + f0 / sampleRate)));
    if (!(Math.abs(v0 - last) <= VST_AUTO_TOL) && (last !== last || b - lastAt >= VST_AUTO_RAMP_BLOCKS)) { out.frames.push(f0); out.values.push(v0); last = v0; lastAt = b; }
    const inBlock = steps.get(b);
    if (inBlock) {
      for (const f of inBlock.sort((x, y) => x - y)) {
        if (f === f0) continue;
        const v = Math.fround(clamp01(w.at(startTime + f / sampleRate + 1e-9)));
        if (Math.abs(v - last) > VST_AUTO_JUMP) { out.frames.push(f); out.values.push(v); last = v; lastAt = b; }
      }
    }
  }
  return out;
}

/** Voies d'automation (jouées) d'un effet VST de la piste, prêtes pour le rendu du pont. */
export function vstAutomationFor(track: Pick<Track, 'automationLanes' | 'automationMode'>, pluginId: string, startTime: number, sampleRate: number, frames: number): VstAutomationLane[] {
  const out: VstAutomationLane[] = [];
  for (const lane of playedLanes(track as Track)) {
    const pp = parsePluginParam(lane.parameterName);
    if (!pp || pp.pluginId !== pluginId || !lane.points?.length) continue;
    const ev = laneEvents(lane.points, startTime, sampleRate, frames);
    if (ev.frames.length) out.push({ name: pp.key, ...ev });
  }
  return out;
}

/** Empreinte des voies jouées des VST d'une piste (un rendu gelé périme quand elles changent). */
export function vstAutomationSig(track: Pick<Track, 'automationLanes' | 'automationMode' | 'plugins'>, upTo?: number): string {
  const list = typeof upTo === 'number' ? (track.plugins || []).slice(0, upTo + 1) : (track.plugins || []);
  const vst = new Set(list.filter((p: PluginInstance) => p.type === 'VST3').map(p => p.id));
  if (!vst.size) return '';
  const parts: string[] = [];
  for (const lane of playedLanes(track as Track)) {
    const pp = parsePluginParam(lane.parameterName);
    if (!pp || !vst.has(pp.pluginId) || !lane.points?.length) continue;
    parts.push(`${lane.parameterName}=${sortedPoints(lane.points).map(p => `${p.time.toFixed(6)},${p.value.toFixed(6)},${p.curveType || ''}`).join(';')}`);
  }
  if (!parts.length) return '';
  parts.sort();
  let h = 0x811c9dc5;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** La piste porte-t-elle de l'automation jouée sur un de ses VST ? */
export const hasVstAutomation = (track: Pick<Track, 'automationLanes' | 'automationMode' | 'plugins'>): boolean => vstAutomationSig(track) !== '';
