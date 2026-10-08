/**
 * Rendus de R6 : Commit, Consolider avec effets (bounce in place), AudioSuite
 * et impression de bus. Même son qu'à la lecture :
 *  - mêmes chemins que le gel et l'export (utils/freeze, services/VstFreeze) :
 *    effets NOVA hors ligne, VST3 du PC rendus par le pont ;
 *  - latence compensée (PDC du moteur, pré-roulement avant la plage) ;
 *  - queue de réverbe / délai incluse en option ;
 *  - automation des réglages d'effets rejouée ; volume avant effets inclus.
 * Le rendu est pris AVANT le fader (commit, bounce, AudioSuite) ou APRÈS le
 * fader du bus (impression) : la nouvelle piste garde le même mix.
 */
import { Clip, PluginInstance, Track, TrackType } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { novaBridge } from './NovaBridge';
import { renderThroughChain, prepareTracksForOffline } from './VstFreeze';
import { canBakeTrack, freezeIndex, isFreezeStale, isVst } from '../utils/freeze';
import { splitClipsAt, idGenerator } from '../utils/timeSelection';
import { engineView } from '../utils/trackStructure';
import { busUpstream, captureGraph, captureIds, trackContentEnd, trackContentStart } from '../utils/commit';
import { PRE_VOLUME } from '../utils/preFxEdits';

/** Queue par défaut (réverbe, délai) : comme le gel (services/VstFreeze FREEZE_TAIL_SECONDS). */
export const DEFAULT_TAIL = 3;
/** Pré-roulement avant une plage : couvre la latence des effets (compensée par le moteur). */
const PREROLL = 1;
/** Fin de queue sous ce niveau (≈ -120 dB) : coupée. */
const SILENCE = 1e-6;

const processing = (p: PluginInstance) => p.isEnabled && !p.isInactive;

/** Son vraiment utile : la queue numériquement muette après `minEnd` (s) est retirée. */
const trimTail = (buf: AudioBuffer, minEndSamples: number): AudioBuffer => {
  let last = minEndSamples;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = d.length - 1; i > last; i--) if (Math.abs(d[i]) > SILENCE) { last = i; break; }
  }
  const len = Math.min(buf.length, Math.max(1, last + 1 + Math.round(buf.sampleRate * 0.01)));
  if (len >= buf.length) return buf;
  return sliceBuffer(buf, 0, len);
};

/** Copie d'une partie d'un son (échantillons [from, from + len)), stéréo. */
export const sliceBuffer = (buf: AudioBuffer, from: number, len: number, channels = Math.max(2, buf.numberOfChannels)): AudioBuffer => {
  const out = new AudioBuffer({ length: Math.max(1, len), numberOfChannels: Math.min(2, channels), sampleRate: buf.sampleRate });
  for (let c = 0; c < out.numberOfChannels; c++) {
    const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
    const part = src.subarray(Math.max(0, from), Math.max(0, Math.min(src.length, from + len)));
    out.copyToChannel(part, c, Math.max(0, -from));
  }
  return out;
};

const registerClip = (buf: AudioBuffer, id: string, o: { name: string; color: string; start: number }): Clip => {
  audioBufferRegistry.register(buf, id);
  return {
    id, name: o.name, color: o.color, type: TrackType.AUDIO, start: o.start, duration: buf.length / buf.sampleRate,
    offset: 0, fadeIn: 0, fadeOut: 0, bufferId: id, gain: 1, isMuted: false,
  };
};

export interface InsertRenderOptions {
  /** Dernier effet inclus (index) ; absent : tous. */
  upTo?: number;
  /** Queue (s) après la fin ; 0 : coupé net. */
  tail?: number;
  /** Plage (s) ; absente : toute la piste. */
  range?: { start: number; end: number };
  /**
   * Pistes de la session : le rendu se fait dans le VRAI graphe (bus, retours,
   * master, compensation de latence), comme l'export. Absent : la piste seule.
   */
  session?: Track[];
  onStep?: (msg: string) => void;
}

/** Ce qui précède une plage et compte pour l'état des effets (s). */
const CONTEXT_SECONDS = 30;

/** Marge gardée avant le début (échantillons) : rien de ce que les effets sortent tôt n'est perdu. */
const MARGIN_SAMPLES = 256;

/**
 * Écoute un point du graphe de la session (avant le fader d'une piste, ou après
 * le fader d'un bus) dans le rendu hors ligne de l'export : mêmes effets, même
 * compensation de latence, mêmes modulations calées sur le temps du morceau.
 * L'échantillon 0 du son rendu correspond à l'instant `start` (s) du morceau.
 */
async function renderCapture(session: Track[], tapId: string, mode: 'pre' | 'post', o: {
  from: number; to: number; tail: number; onStep?: (msg: string) => void;
  /** Garder toute la longueur (soustraction d'un second rendu). */
  noTrim?: boolean;
}): Promise<{ buffer: AudioBuffer; start: number }> {
  await audioEngine.init();
  const sr = audioEngine.ctx!.sampleRate;
  // Pistes utiles : le point d'écoute, ce qui y entre (bus), ce qui est en aval
  // (leur latence compte dans la compensation), master, dossiers et VCA (résolution).
  const view0 = engineView(session).tracks;
  const keep = captureIds(view0, tapId, mode);
  const subset = session.filter(t => keep.has(t.id) || t.id === 'master' || t.isVca || !!t.folder);
  // VST du PC : rendus par le pont, exactement comme à l'export.
  const prep = await prepareTracksForOffline(subset, o.onStep);
  try {
    const resolved = engineView(prep.tracks).tracks;
    const silenced: Set<string> = (audioEngine as any).computeSoloSilencedIds(view0);
    const graph = captureGraph(resolved, tapId, mode, silenced);
    const startSample = Math.max(0, Math.round(o.from * sr) - MARGIN_SAMPLES);
    const endSample = Math.round((o.to + o.tail) * sr);
    // Le rendu part du début du morceau, comme l'export : modulations des effets
    // (LFO de la réverbe, chorus), effets calés sur le tempo, blocs de 128
    // échantillons et automation tombent au même échantillon. Le début est retiré.
    const full = await audioEngine.renderProject(graph, endSample / sr, 0, sr, undefined, {});
    const body = sliceBuffer(full, startSample, endSample - startSample);
    return { buffer: o.noTrim ? body : trimTail(body, Math.round(o.to * sr) - startSample), start: startSample / sr };
  } finally {
    prep.cleanup();
  }
}

/**
 * Rend une piste à travers ses inserts [0..upTo], avant le fader : même son
 * qu'à l'export, latence compensée, automation des effets et volume avant
 * effets compris. Renvoie le son et l'instant (s) où il commence.
 */
export async function renderTrackInserts(track: Track, opts: InsertRenderOptions = {}): Promise<{ buffer: AudioBuffer; start: number; upTo: number }> {
  if (!canBakeTrack(track)) throw new Error("Le beat n'est jamais rendu dans un fichier (licence).");
  const all = track.plugins || [];
  const upTo = Math.min(all.length - 1, opts.upTo ?? all.length - 1);
  const plugins = all.slice(0, upTo + 1);
  const tail = Math.max(0, opts.tail ?? DEFAULT_TAIL);
  const hasVst = plugins.some(p => isVst(p) && processing(p));
  const bridge = novaBridge.isConnected();
  // Sans pont : un VST n'est rendable que si la piste a un rendu gelé à jour qui le couvre.
  if (hasVst && !bridge) {
    const lastVst = plugins.reduce((m, p, i) => (isVst(p) && processing(p) ? i : m), -1);
    if (!(track.frozenClip && !isFreezeStale(track) && freezeIndex(track) >= lastVst)) {
      throw new Error('Connecte le pont VST (appli Windows Nova Studio) pour rendre les effets VST de cette piste.');
    }
  }
  const clips0 = (track.clips || []).filter(c => !c.isFreezeSlice);
  const s = opts.range ? opts.range.start : trackContentStart(track);
  const e = opts.range ? opts.range.end : trackContentEnd(track);
  if (!(e > s)) throw new Error('Rien à rendre sur cette piste.');
  const split = opts.range ? splitClipsAt(clips0, [s, e], idGenerator('rr')) : clips0;
  const clips = opts.range ? split.filter(c => c.start >= s - 1e-6 && c.start + c.duration <= e + 1e-6) : clips0;
  if (!clips.some(c => !c.isMuted)) throw new Error('Aucun clip à rendre dans la plage.');
  // Plage : les effets gardent leur état d'avant la plage (compresseur en cours de
  // relâchement, réverbe, écho). On rend la piste avec ce qui précède la plage, puis
  // on retire ce que ce début joue seul (il reste sur la piste d'origine) : piste
  // d'origine + bounce = exactement le son d'avant, même pour un effet non linéaire.
  const before = opts.range ? split.filter(c => c.start + c.duration <= s + 1e-6 && c.start + c.duration > s - CONTEXT_SECONDS && !c.isMuted) : [];
  // Gel manuel : on repart des vrais effets (le pont rend les VST, comme à l'export).
  const tapWith = (cs: Clip[]): Track[] => {
    const tap: Track = { ...track, clips: cs, plugins, isFrozen: hasVst && !bridge ? track.isFrozen : false };
    return (opts.session || [track]).map(t => (t.id === track.id ? tap : t));
  };
  opts.onStep?.(`Rendu de ${track.name}…`);
  const r = await renderCapture(tapWith([...before, ...clips]), track.id, 'pre', { from: s, to: e, tail, onStep: opts.onStep, noTrim: before.length > 0 });
  if (before.length) {
    const alone = await renderCapture(tapWith(before), track.id, 'pre', { from: s, to: e, tail, onStep: opts.onStep, noTrim: true });
    for (let c = 0; c < r.buffer.numberOfChannels; c++) {
      const d = r.buffer.getChannelData(c), b = alone.buffer.getChannelData(Math.min(c, alone.buffer.numberOfChannels - 1));
      for (let i = 0; i < d.length && i < b.length; i++) d[i] -= b[i];
    }
    const sr = r.buffer.sampleRate;
    return { buffer: trimTail(r.buffer, Math.round(e * sr) - Math.round(r.start * sr)), start: r.start, upTo };
  }
  return { ...r, upTo };
}

/** Commit / bounce : rendu prêt à poser (clip enregistré dans le registre audio). */
export async function renderCommitClip(track: Track, opts: InsertRenderOptions & { label: string }): Promise<{ clip: Clip; upTo: number }> {
  const r = await renderTrackInserts(track, opts);
  const id = `commit-${track.id}-${Date.now().toString(36)}`;
  return { clip: registerClip(r.buffer, id, { name: `${track.name} (${opts.label})`, color: track.color, start: r.start }), upTo: r.upTo };
}

// ─── AudioSuite ────────────────────────────────────────────────────────────────

/**
 * Passe une partie d'un son (échantillons [from, to)) dans des effets, hors
 * ligne (VST par le pont). Du silence encadre le son pendant le rendu : la
 * latence des effets ne mange pas le début. Même durée en sortie.
 */
export async function processRegion(source: AudioBuffer, from: number, to: number, plugins: PluginInstance[], host: Track, onStep?: (msg: string) => void): Promise<AudioBuffer> {
  await audioEngine.init();
  const sr = source.sampleRate;
  const pad = Math.round(sr * PREROLL);
  const len = Math.max(1, to - from);
  // Silence autour de la partie traitée (les poignées sont déjà dans [from, to)) :
  // l'effet ne voit rien d'autre que le clip et ses poignées.
  const part = sliceBuffer(source, from, len, 2);
  const padded = new AudioBuffer({ length: len + 2 * pad, numberOfChannels: 2, sampleRate: sr });
  for (let c = 0; c < 2; c++) padded.copyToChannel(part.getChannelData(c), c, pad);
  const chain = plugins.filter(processing);
  if (chain.some(isVst) && !novaBridge.isConnected()) throw new Error('Connecte le pont VST (appli Windows Nova Studio) pour traiter avec un VST.');
  const out = await renderThroughChain(padded, chain, { ...host, automationLanes: [], sends: [], isMuted: false, isSolo: false }, onStep);
  return sliceBuffer(out, pad, len);
}

// ─── Impression de bus ─────────────────────────────────────────────────────────

/**
 * Son exact d'un bus (après ses effets, son fader et son pan), aligné à
 * l'échantillon sur le morceau (le rendu commence à 0). VST : rendus par le
 * pont comme à l'export.
 */
export async function renderBusPrint(tracks: Track[], busId: string, opts: { tail?: number; onStep?: (msg: string) => void } = {}): Promise<{ clip: Clip }> {
  const bus = tracks.find(t => t.id === busId);
  if (!bus) throw new Error('Bus introuvable.');
  const view = engineView(tracks).tracks;
  const up = busUpstream(view, busId);
  const end = view.filter(t => up.has(t.id)).reduce((m, t) => Math.max(m, trackContentEnd(t)), 0);
  if (end <= 0) throw new Error(`Rien n'entre dans « ${bus.name} » : aucun son à imprimer.`);
  opts.onStep?.(`Impression de ${bus.name}…`);
  const r = await renderCapture(tracks, busId, 'post', { from: 0, to: end, tail: Math.max(0, opts.tail ?? DEFAULT_TAIL), onStep: opts.onStep });
  const id = `print-${bus.id}-${Date.now().toString(36)}`;
  return { clip: registerClip(r.buffer, id, { name: `${bus.name} (imprimé)`, color: bus.color, start: r.start }) };
}

/** Le volume avant effets (dessiné) passe dans le rendu : à retirer de la piste rendue. */
export const PRE_VOLUME_LANE = PRE_VOLUME;
