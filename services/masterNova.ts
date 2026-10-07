/**
 * « Master Nova » (V15), partie navigateur : rendu du mix, passage dans la
 * chaîne proposée (mêmes nœuds qu'en lecture et à l'export), réglage du
 * limiteur jusqu'à la cible LUFS, rapport avant / après.
 *
 * La logique (cibles, analyse, chaîne) est dans utils/masterAssistant.ts.
 */
import { audioEngine } from '../engine/AudioEngine';
import { LimiterNode } from '../engine/LimiterNode';
import { ProEQ12Node } from '../plugins/ProEQ12Plugin';
import { CompressorNode } from '../plugins/CompressorPlugin';
import type { PluginInstance, Track } from '../types';
import { analyzeMix, proposeChain, nextLimiterGain, MixAnalysis, MasterChainProposal, MasterCharacter, PlatformTarget } from '../utils/masterAssistant';
import { lufsOf } from '../utils/audioMeasure';

export const MASTER_ID = 'master';
export const isMasterNovaPlugin = (p: PluginInstance) => !!(p.params && (p.params as any).masterNova);

const SR = 44100;

/** Pistes telles que le master Nova les écoute : sans ses propres effets, fader master à 0 dB. */
export function tracksWithoutMasterNova(tracks: Track[]): Track[] {
  return tracks.map(t => t.id !== MASTER_ID ? t : { ...t, volume: 1, pan: 0, plugins: (t.plugins || []).filter(p => !isMasterNovaPlugin(p)) });
}

export function projectDuration(tracks: Track[]): number {
  const end = Math.max(0, ...tracks.flatMap(t => (t.clips || []).map(c => c.start + c.duration)));
  return end + 1;
}

const channels = (b: AudioBuffer) => Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, c) => b.getChannelData(c));

/** Passe un rendu dans [EQ → compression] (puis le limiteur si fourni), latence retirée. */
async function throughChain(input: AudioBuffer, parts: { eq?: Record<string, any>; comp?: Record<string, any>; limiter?: Record<string, any> }): Promise<AudioBuffer> {
  const pad = Math.round(0.05 * input.sampleRate);
  const ctx = new OfflineAudioContext(2, input.length + pad, input.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = input;
  let head: AudioNode = src;
  let latency = 0;
  const actx = ctx as unknown as AudioContext;
  if (parts.eq) { const eq = new ProEQ12Node(actx, parts.eq as any); head.connect(eq.input); head = eq.output; }
  if (parts.comp) {
    const comp = new CompressorNode(actx);
    comp.updateParams({ ...(parts.comp as any), isEnabled: true });
    await comp.ready;
    head.connect(comp.input); head = comp.output; latency += comp.latency || 0;
  }
  if (parts.limiter) {
    const lim = new LimiterNode(ctx, parts.limiter as any);
    await lim.ready;
    head.connect(lim.input); head = lim.output; latency += lim.latency;
  }
  head.connect(ctx.destination);
  src.start(0);
  const out = await ctx.startRendering();
  const shift = Math.round(latency * input.sampleRate);
  const res = new AudioBuffer({ length: input.length, numberOfChannels: 2, sampleRate: input.sampleRate });
  for (let c = 0; c < 2; c++) res.copyToChannel(out.getChannelData(c).subarray(shift, shift + input.length), c);
  return res;
}

export interface MasterNovaResult {
  before: MixAnalysis;
  after: MixAnalysis;
  proposal: MasterChainProposal;
  /** Effets à insérer en fin de chaîne master (une seule étape d'annulation). */
  plugins: PluginInstance[];
  iterations: { gain: number; lufs: number }[];
  reached: boolean;
}

export interface MasterNovaOptions { target: PlatformTarget; character: MasterCharacter; eqAmount: number }

/** Rend le mix actuel (master Nova exclu) : ce que le mastering reçoit. */
export async function renderMixForMaster(tracks: Track[], onProgress?: (p: number) => void): Promise<AudioBuffer> {
  await audioEngine.init?.();
  return audioEngine.renderProject(tracksWithoutMasterNova(tracks), projectDuration(tracks), 0, SR, onProgress);
}

/** Mesure la loudness du mix tel qu'il sort (master Nova compris) : sert à aligner la référence. */
export async function measureCurrentMix(tracks: Track[]): Promise<{ lufs: number; buffer: AudioBuffer }> {
  await audioEngine.init?.();
  const b = await audioEngine.renderProject(tracks, projectDuration(tracks), 0, SR);
  return { lufs: lufsOf(channels(b), b.sampleRate), buffer: b };
}

export async function runMasterNova(tracks: Track[], opts: MasterNovaOptions, onStep?: (label: string, progress: number) => void): Promise<MasterNovaResult> {
  onStep?.('Rendu de ton mix…', 0.05);
  const mix = await renderMixForMaster(tracks, p => onStep?.('Rendu de ton mix…', 0.05 + 0.35 * p));
  onStep?.('Analyse (loudness, crête vraie, spectre)…', 0.42);
  const before = analyzeMix(channels(mix), mix.sampleRate);
  if (!Number.isFinite(before.lufs)) throw new Error('Le mix est silencieux : rien à masteriser.');
  const proposal = proposeChain(before, opts.target, opts.character, opts.eqAmount);

  onStep?.('Égalisation et compression de bus…', 0.5);
  const glued = await throughChain(mix, { eq: proposal.eqParams, comp: proposal.compParams });
  const gluedLufs = lufsOf(channels(glued), glued.sampleRate);

  const iterations: { gain: number; lufs: number }[] = [];
  let gain = Math.max(0, Math.min(24, opts.target.lufs - gluedLufs));
  let last: AudioBuffer = glued;
  for (let k = 0; k < 7; k++) {
    onStep?.(`Limiteur : réglage du niveau (essai ${k + 1})…`, 0.55 + 0.06 * k);
    last = await throughChain(glued, { limiter: { ...proposal.limiterParams, inputGain: gain } });
    const l = lufsOf(channels(last), last.sampleRate);
    iterations.push({ gain, lufs: l });
    if (Math.abs(l - opts.target.lufs) < 0.1) break;
    const next = nextLimiterGain(iterations, opts.target.lufs);
    if (Math.abs(next - gain) < 0.01) break;
    gain = next;
  }
  // Meilleur essai (le plus proche de la cible).
  const best = iterations.reduce((a, b) => (Math.abs(b.lufs - opts.target.lufs) < Math.abs(a.lufs - opts.target.lufs) ? b : a));
  if (best.gain !== gain) last = await throughChain(glued, { limiter: { ...proposal.limiterParams, inputGain: best.gain } });
  proposal.limiterParams = { ...proposal.limiterParams, inputGain: Math.round(best.gain * 100) / 100 };

  onStep?.('Rapport avant / après…', 0.97);
  const after = analyzeMix(channels(last), last.sampleRate);
  const stamp = Date.now();
  const mk = (type: PluginInstance['type'], name: string, params: Record<string, any>, i: number): PluginInstance =>
    ({ id: `pl-mn-${stamp}-${i}`, type, name, isEnabled: true, params: { ...params, isEnabled: true, masterNova: true }, latency: 0 } as PluginInstance);
  const plugins = [
    mk('PROEQ12', 'Master Nova · EQ', proposal.eqParams, 0),
    mk('COMPRESSOR', 'Master Nova · Compression', proposal.compParams, 1),
    mk('LIMITER', 'Master Nova · Limiteur', proposal.limiterParams, 2),
  ];
  onStep?.('Terminé', 1);
  return { before, after, proposal, plugins, iterations, reached: Math.abs(after.lufs - opts.target.lufs) <= 0.5 };
}
