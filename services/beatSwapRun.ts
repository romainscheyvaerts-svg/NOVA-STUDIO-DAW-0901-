/**
 * R23 · Changer de beat : la partie navigateur (sons décodés, analyse, rendus).
 * La logique est dans utils/beatSwap (pure, testée) ; ici on lit les sons du
 * registre, on écoute les beats (tempo, tonalité, premier temps) et on rend
 * les voix recalées (utils/clipTranspose, dans un worker).
 */
import type { Clip, DAWState, ElasticInfo } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { analyzeBeatGrid, audioClipsToRender, BeatInfo, ClipRender, isBeatTrack, KeyInfo, SwapPlan } from '../utils/beatSwap';
import { editingElastic, estimateTempo, withDuration, withSemitones } from '../utils/clipTranspose';
import { detectKey } from '../utils/keyDetect';
import { renderElasticClip } from './elasticRender';

const has = (id: string) => !!audioBufferRegistry.get(id);

/** Mélange mono des `maxSec` premières secondes. */
export function monoOf(buf: AudioBuffer, maxSec = 90): Float32Array {
  const n = Math.min(buf.length, Math.round(maxSec * buf.sampleRate));
  const out = new Float32Array(n);
  const k = buf.numberOfChannels;
  for (let c = 0; c < k; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / k; }
  return out;
}

/** Premier clip du beat dont le son est chargé. */
export function currentBeatClip(state: DAWState): { clip: Clip; buffer: AudioBuffer } | null {
  const t = state.tracks.find(isBeatTrack);
  for (const c of t?.clips || []) {
    const b = c.bufferId ? audioBufferRegistry.get(c.bufferId) : c.buffer;
    if (b) return { clip: c, buffer: b };
  }
  return null;
}

const gridCache = new Map<string, { bpm: number; downbeat: number; confidence: number } | null>();
const tick = () => new Promise(r => setTimeout(r, 0));

/** Grille d'un son (mise en cache par identifiant de son). */
async function gridOf(id: string | undefined, buf: AudioBuffer, approx: number) {
  const key = `${id || ''}@${Math.round(approx * 100)}`;
  if (id && gridCache.has(key)) return gridCache.get(key)!;
  await tick();
  const g = analyzeBeatGrid(monoOf(buf), buf.sampleRate, approx);
  const out = g ? { bpm: g.bpm, downbeat: g.downbeat, confidence: g.confidence } : null;
  if (id) gridCache.set(key, out);
  return out;
}

/**
 * Le beat actuel : tempo du projet (affiné à l'écoute s'il est à moins de 3 %),
 * tonalité du projet (sinon à l'écoute), premier temps (s, temps du projet).
 */
export async function analyzeCurrentBeat(state: DAWState): Promise<BeatInfo | null> {
  const cur = currentBeatClip(state);
  if (!cur) return null;
  const g = await gridOf(cur.clip.bufferId, cur.buffer, state.bpm || 120);
  let bpm = state.bpm || 120, bpmFrom: BeatInfo['bpmFrom'] = 'projet';
  if (g && Math.abs(g.bpm / bpm - 1) < 0.03 && Math.abs(g.bpm - bpm) > 1e-3) { bpm = g.bpm; bpmFrom = 'écoute'; }
  let key: KeyInfo | null = typeof state.projectKey === 'number' ? { root: state.projectKey, scale: state.projectScale || 'MINOR' } : null;
  let keyFrom: BeatInfo['keyFrom'] = key ? 'projet' : undefined;
  if (!key) {
    const d = await detectKey(cur.buffer).catch(() => null);
    if (d) { key = { root: d.rootKey, scale: d.scale }; keyFrom = 'écoute'; }
  }
  // Premier temps dans le son → temps du projet.
  const db = g ? cur.clip.start + (g.downbeat - (cur.clip.offset || 0)) : cur.clip.start;
  return { bpm, key, downbeat: db, bpmFrom, keyFrom, downbeatConfidence: g?.confidence ?? 0, title: state.beatTitle || cur.clip.name };
}

/**
 * Le nouveau beat, posé à `start` (s) : tempo et tonalité du catalogue s'ils
 * sont connus (vérifiés à l'écoute), sinon détectés.
 */
export async function analyzeNewBeat(buf: AudioBuffer, start: number, meta: { bpm?: number; key?: KeyInfo | null; title?: string; id?: string }): Promise<BeatInfo> {
  let approx = meta.bpm && meta.bpm > 0 ? meta.bpm : 0;
  if (!approx) {
    await tick();
    approx = estimateTempo(monoOf(buf, 30), buf.sampleRate)?.bpm || 120;
  }
  const g = await gridOf(meta.id, buf, approx);
  let bpm = approx, bpmFrom: BeatInfo['bpmFrom'] = meta.bpm ? 'catalogue' : 'écoute';
  if (g) {
    if (!meta.bpm) bpm = g.bpm;
    else if (Math.abs(g.bpm / meta.bpm - 1) > 0.005 && g.confidence > 0.3) { bpm = g.bpm; bpmFrom = 'écoute'; }
  }
  let key = meta.key ?? null, keyFrom: BeatInfo['keyFrom'] = key ? 'catalogue' : undefined;
  if (!key) {
    const d = await detectKey(buf).catch(() => null);
    if (d) { key = { root: d.rootKey, scale: d.scale }; keyFrom = 'écoute'; }
  }
  return { bpm, key, downbeat: start + (g?.downbeat ?? 0), bpmFrom, keyFrom, downbeatConfidence: g?.confidence ?? 0, title: meta.title };
}

/** Réglage de rendu d'un clip de voix pour le plan (étirement, transposition, attaques ancrées). */
export function swapElastic(clip: Clip, plan: SwapPlan): ElasticInfo {
  let info = editingElastic(clip, has).info;
  if (plan.retime && Math.abs(plan.factor - 1) > 1e-6) info = withDuration(info, info.duration * plan.factor);
  if (plan.semitones) info = withSemitones(info, info.semitones + plan.semitones);
  return { ...info, attacks: true };
}

/** Rend toutes les voix (une à une, dans un worker). `progress(i, n, nom)`. */
export async function renderVoices(state: DAWState, plan: SwapPlan, progress?: (i: number, n: number, name: string) => void, cancelled?: () => boolean): Promise<ClipRender[]> {
  const list = audioClipsToRender(state.tracks);
  const out: ClipRender[] = [];
  let i = 0;
  for (const { trackId, clip } of list) {
    if (cancelled?.()) throw new Error('annulé');
    progress?.(++i, list.length, clip.name);
    if (!(plan.retime && Math.abs(plan.factor - 1) > 1e-6) && !plan.semitones) continue;
    const { patch } = await renderElasticClip(clip, swapElastic(clip, plan));
    if (Object.keys(patch).length) out.push({ trackId, clipId: clip.id, patch });
  }
  return out;
}
