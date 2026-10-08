/**
 * R13 · Rendu d'un clip transposé / étiré / recalé et pose du résultat dans
 * le projet (une seule étape d'annulation, même pour plusieurs clips).
 *
 * Le calcul tourne dans un worker (utils/clipTranspose.worker.ts) ; sans
 * worker (tests, vieux navigateur) il tourne sur place.
 */
import type { Clip, DAWState, ElasticInfo } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import {
  editingElastic, elasticPatch, elasticRevertPatch, ElasticJob, ElasticResult, isNeutralElastic, renderElastic, renderPlan, semitoneText, stretchOf,
} from '../utils/clipTranspose';

const has = (id: string) => !!audioBufferRegistry.get(id);

async function runJob(job: ElasticJob): Promise<ElasticResult> {
  if (typeof Worker === 'undefined') return renderElastic(job);
  try {
    const worker = new Worker(new URL('../utils/clipTranspose.worker.ts', import.meta.url), { type: 'module' });
    try {
      return await new Promise<ElasticResult>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<ElasticResult & { error?: string }>) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data));
        worker.onerror = ev => reject(new Error(ev.message || 'worker'));
        worker.postMessage(job, job.channels.map(c => c.buffer as ArrayBuffer));
      });
    } finally { worker.terminate(); }
  } catch (e) {
    if (e instanceof Error && e.message !== 'worker') throw e;
    return renderElastic(job);
  }
}

export interface ElasticRequest { trackId: string; clipId: string; info: ElasticInfo }

/**
 * Rend un clip avec le réglage `info` (réglage complet, tel que renvoyé par
 * editingElastic puis retouché). Renvoie le patch à poser sur le clip.
 * Réglage neutre : retour à l'original (si on l'a).
 */
export async function renderElasticClip(clip: Clip, info: ElasticInfo): Promise<{ patch: Partial<Clip>; used?: 'voice' | 'poly' }> {
  if (isNeutralElastic(info)) {
    const back = clip.elastic ? elasticRevertPatch(clip, has) : null;
    return { patch: back || {} };
  }
  const base = editingElastic(clip, has);
  const srcId = base.bufferId;
  const src = srcId ? audioBufferRegistry.get(srcId) : clip.buffer;
  if (!src) throw new Error(`Le son de « ${clip.name} » n'est pas chargé.`);
  const sr = src.sampleRate;
  const plan = renderPlan(info, sr, src.length);
  if (!plan.segments.length) throw new Error('Rien à rendre (clip trop court).');
  const a0 = Math.round(plan.regionStart * sr);
  const n = plan.segments[plan.segments.length - 1].s1;
  const channels: Float32Array[] = [];
  for (let c = 0; c < src.numberOfChannels; c++) channels.push(src.getChannelData(c).slice(a0, a0 + n));
  const res = await runJob({ channels, sr, segments: plan.segments, semitones: info.semitones, formants: info.formants, algo: info.algo });
  const out = new AudioBuffer({ length: Math.max(1, res.channels[0].length), numberOfChannels: res.channels.length, sampleRate: sr });
  res.channels.forEach((c, i) => out.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  const id = `elastic-${clip.id}-${Date.now().toString(36)}`;
  audioBufferRegistry.register(out, id);
  const full: ElasticInfo = { ...info, regionStart: plan.regionStart, regionEnd: plan.regionEnd, renderedOffset: plan.renderedOffset, used: res.used };
  return { patch: elasticPatch(clip, { newBufferId: id, info: full, sourceBufferId: srcId }), used: res.used };
}

const notify = (text: string) => { try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: text })); } catch { /* hors navigateur */ } };

/** Pose les patchs dans le projet (une seule étape d'annulation). */
export function applyClipPatches(setState: (fn: (prev: DAWState) => DAWState) => void, patches: { trackId: string; clipId: string; patch: Partial<Clip> }[]) {
  if (!patches.length) return;
  setState(prev => ({
    ...prev,
    tracks: prev.tracks.map(t => {
      const mine = patches.filter(p => p.trackId === t.id);
      if (!mine.length) return t;
      return {
        ...t,
        clips: t.clips.map(c => {
          const p = mine.find(x => x.clipId === c.id);
          if (!p) return c;
          const out = { ...c } as Record<string, unknown>;
          for (const [k, v] of Object.entries(p.patch)) { if (v === undefined) delete out[k]; else out[k] = v; }
          return out as unknown as Clip;
        }),
      };
    }),
  }));
}

/** Rend plusieurs clips puis les pose ensemble. `progress` : message d'attente. */
export async function renderAndApply(
  tracks: { id: string; clips: Clip[] }[], reqs: ElasticRequest[],
  setState: (fn: (prev: DAWState) => DAWState) => void, progress?: (msg: string) => void,
): Promise<number> {
  const patches: { trackId: string; clipId: string; patch: Partial<Clip> }[] = [];
  let i = 0;
  for (const r of reqs) {
    i++;
    const clip = tracks.find(t => t.id === r.trackId)?.clips.find(c => c.id === r.clipId);
    if (!clip) continue;
    progress?.(`Rendu ${reqs.length > 1 ? `${i}/${reqs.length} ` : ''}: ${clip.name}…`);
    const { patch } = await renderElasticClip(clip, r.info);
    if (Object.keys(patch).length) patches.push({ trackId: r.trackId, clipId: r.clipId, patch });
  }
  applyClipPatches(setState, patches);
  return patches.length;
}

/** Message de fin (« Transposé de +3 demi-tons · 110 % »). */
export function doneMessage(info: ElasticInfo, count = 1): string {
  if (isNeutralElastic(info)) return `↩️ ${count > 1 ? `${count} clips revenus` : 'Clip revenu'} à l'original.`;
  const parts: string[] = [];
  if (Math.abs(info.semitones) >= 0.005) parts.push(`transposé de ${semitoneText(info.semitones)}`);
  const s = stretchOf(info);
  if (Math.abs(s - 1) > 1e-4) parts.push(`étiré à ${Math.round(s * 1000) / 10} %`);
  if (info.markers?.length) parts.push(`${info.markers.length} marqueur${info.markers.length > 1 ? 's' : ''} de warp`);
  return `🎚️ ${count > 1 ? `${count} clips` : 'Clip'} ${parts.join(', ')}. L'original est gardé (menu du clip → « Revenir à l'original »). Ctrl+Z pour annuler.`;
}

export { notify as notifyElastic };
