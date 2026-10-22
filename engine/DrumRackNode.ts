import { DrumPad } from '../types';
import { figerGain } from './audioParamUtils';
import {
  ampEnvelope, cutoffAt, shape, filterSections, gated, loopTimes, noteSemis, notePeak, pickLayer, pitchEnvAt, semisToRatio, smpOf,
  type EnvSeg, type PadSamplerParams,
} from '../utils/padSampler';

/**
 * Drum Rack Engine
 * Manages 30 distinct sample pads with individual volume/pan.
 * Triggered by MIDI notes 60 (Pad 1) to 89 (Pad 30).
 *
 * Séquenceur pro (22/10/2026) : un pad qui a un sampler (`smp`) joue par `triggerSampler` (enveloppes,
 * filtre, hauteur, couches, boucle, longueur de note, glisse). Sans sampler, EXACTEMENT le chemin d'avant.
 * Le même code tourne en lecture et à l'export (contexte hors ligne) : lecture = export.
 */
/** Durée réellement audible d'un son (jusqu'à -50 dB sous sa crête), mise en cache. */
const audibleCache = new WeakMap<AudioBuffer, number>();
function audibleLength(buf: AudioBuffer): number {
  const hit = audibleCache.get(buf);
  if (hit !== undefined) return hit;
  const d = buf.getChannelData(0);
  let pk = 0;
  for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > pk) pk = a; }
  const floor = pk * 0.00316;
  let last = d.length - 1;
  while (last > 0 && Math.abs(d[last]) < floor) last--;
  const len = Math.max(0.01, (last + 1) / buf.sampleRate);
  audibleCache.set(buf, len);
  return len;
}

/** Données propres à une note (pas de la boîte à rythmes). */
export interface DrumNoteEx {
  pan?: number; tune?: number;
  /** Note avec une longueur : relâchement à `duration` (s). */
  hold?: number; duration?: number;
  glide?: number; glideFrom?: number; glideTime?: number;
  rr?: number;
}

type Voice = { src: AudioBufferSourceNode; gain: GainNode; end: number };

/**
 * Programme une enveloppe (segments) sur un paramètre, à partir de `t0`. Les courbes sont tracées en
 * 32 droites (aucun chevauchement d'automation possible) : chaque segment arrive PILE à son instant.
 */
function scheduleEnv(param: AudioParam, segs: EnvSeg[], t0: number) {
  param.setValueAtTime(segs[0]?.v0 ?? 0, t0);
  let last = t0;
  for (const g of segs) {
    const a = t0 + g.t0, b = t0 + g.t1;
    if (b - a <= 1e-7) { param.setValueAtTime(g.v1, Math.max(a, last)); last = Math.max(a, last); continue; }
    if (a > last + 1e-9) param.setValueAtTime(g.v0, a);
    const n = g.curve < 1e-6 ? 1 : 32;
    for (let i = 1; i <= n; i++) param.linearRampToValueAtTime(g.v0 + (g.v1 - g.v0) * shape(i / n, g.curve), a + ((b - a) * i) / n);
    last = b;
  }
}

/** Trace une courbe f(t) (0 ≤ t ≤ dur) en droites, à partir de t0. */
function scheduleFn(param: AudioParam, t0: number, dur: number, n: number, f: (t: number) => number) {
  param.setValueAtTime(f(0), t0);
  for (let i = 1; i <= n; i++) param.linearRampToValueAtTime(f((dur * i) / n), t0 + (dur * i) / n);
}

export class DrumRackNode {
  private ctx: BaseAudioContext;
  public input: GainNode;
  public output: GainNode;

  // Map Pad ID (1-30) to Buffer
  private buffers: Map<number, AudioBuffer> = new Map();
  /** Autres sons du pad (couches de vélocité / alternance) : index 1, 2… (0 = le son du pad). */
  private layers: Map<number, (AudioBuffer | undefined)[]> = new Map();
  /** Alternance jouée au pad (pré-écoute, clavier) ; les notes du séquenceur portent leur rang (`rr`). */
  private rrLive: Map<number, number> = new Map();

  // Internal State (Vol/Pan/Mute) to apply on trigger
  private pads: Map<number, DrumPad> = new Map();
  // « Choke » : un pad coupe les autres du même groupe (hi-hat fermé / ouvert, 808).
  private chokeVoices: Map<number, { src: AudioBufferSourceNode; gain: GainNode }[]> = new Map();
  /** Voix en cours par pad (mode mono, glisse). */
  private padVoices: Map<number, Voice[]> = new Map();
  // Entrée de la chaîne d'effets propre à chaque pad (mix par pad) ; sinon sortie directe.
  private padInputs: Map<number, AudioNode> = new Map();

  public setPadInput(padId: number, node: AudioNode | null) {
    if (node) this.padInputs.set(padId, node); else this.padInputs.delete(padId);
  }

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain(); // Aux Input (rarely used for DrumRack but good for chain)
    this.output = ctx.createGain();

    // Pass-through input to output if any
    this.input.connect(this.output);
  }

  public updatePadsState(pads: DrumPad[]) {
    pads.forEach(pad => {
      this.pads.set(pad.id, pad);
      if (pad.buffer) {
        this.buffers.set(pad.id, pad.buffer);
      }
    });
  }

  /** Expose les samples charges (utilise par l'export offline). */
  public getBuffers(): Map<number, AudioBuffer> {
    return this.buffers;
  }

  /** Couches des pads (export hors ligne : reprises du drum rack de la lecture). */
  public getLayers(): Map<number, (AudioBuffer | undefined)[]> {
    return this.layers;
  }

  public loadSample(padId: number, buffer: AudioBuffer) {
    this.buffers.set(padId, buffer);
  }

  /** Son d'une couche du pad (`index` ≥ 1) ; `count` : nombre de couches en plus du son du pad. */
  public loadLayer(padId: number, index: number, buffer: AudioBuffer | null, count?: number) {
    const a = [...(this.layers.get(padId) || [])];
    if (typeof count === 'number') a.length = Math.max(0, count);
    if (index >= 1) a[index - 1] = buffer || undefined;
    this.layers.set(padId, a);
  }

  /** Copie les couches d'un autre drum rack (export). */
  public copyLayers(from: Map<number, (AudioBuffer | undefined)[]>) {
    from.forEach((v, k) => this.layers.set(k, [...v]));
  }

  /**
   * Triggers a specific Pad by ID (1-30) or MIDI Note (60-89)
   */
  public trigger(padIdOrNote: number, velocity: number = 1.0, time: number = 0, ex?: DrumNoteEx) {
    // Determine Pad ID. If > 30, assume it's a MIDI note.
    // MIDI 60 = Pad 1.
    const padId = padIdOrNote > 30 ? padIdOrNote - 59 : padIdOrNote;

    if (padId < 1 || padId > 30) return;

    const pad = this.pads.get(padId);
    if (!pad) return; // Pad state not found?

    // Mute/Solo Logic
    // Check global solo status (if any pad is soloed, this one must be soloed to play)
    const isAnySolo = Array.from(this.pads.values()).some(p => p.isSolo);
    if (pad.isMuted) return;
    if (isAnySolo && !pad.isSolo) return;

    const smp = (pad as DrumPad & { smp?: PadSamplerParams }).smp;
    if (smp || ex?.hold || ex?.glide) { this.triggerSampler(padId, pad, smp, velocity, time, ex); return; }

    const buffer = this.buffers.get(padId);
    if (!buffer) return;

    const now = Math.max(time, (this.ctx as AudioContext).currentTime);

    // Create Source
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    // Hauteur du pas (R18, Graph Editor de FL) ajoutée à l'accordage du pad.
    const tune = (pad.tune || 0) + (ex?.tune || 0);
    if (tune) source.playbackRate.value = Math.pow(2, tune / 12);

    // Create Gain (Volume * Velocity)
    const gainNode = this.ctx.createGain();
    const level = pad.volume * velocity;
    gainNode.gain.value = level;
    // Longueur : le son est raccourci par un fondu (comme le « decay » d'une MPC).
    const decay = pad.decay ?? 1;
    if (decay < 0.999) {
      const len = (audibleLength(buffer) / Math.pow(2, tune / 12)) * Math.max(0.05, decay);
      gainNode.gain.setValueAtTime(level, now);
      gainNode.gain.setTargetAtTime(0, now + len * 0.6, len * 0.15);
    }

    // Create Panner
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pad.pan + (ex?.pan || 0)));

    // Graph: Source -> Gain -> Panner -> Output
    source.connect(gainNode);
    gainNode.connect(panner);
    panner.connect(this.padInputs.get(padId) || this.output);

    source.start(now);

    this.choke(pad, source, gainNode, now);

    // Garbage Collection
    source.onended = () => {
        source.disconnect();
        gainNode.disconnect();
        panner.disconnect();
    };
  }

  /** Groupe d'étouffement : coupe brève (5 ms) des voix du groupe encore en train de sonner. */
  private choke(pad: DrumPad, source: AudioBufferSourceNode, gainNode: GainNode, now: number) {
    const group = (pad as any).chokeGroup as number | undefined;
    if (!group) return;
    const voices = this.chokeVoices.get(group) || [];
    voices.forEach(v => {
      try { v.gain.gain.setTargetAtTime(0, now, 0.005); v.src.stop(now + 0.05); } catch { /* déjà arrêtée */ }
    });
    this.chokeVoices.set(group, [{ src: source, gain: gainNode }]);
  }

  /** Voix du sampler de pad : couche, hauteur (+ enveloppe, glisse), filtre, enveloppe d'amplitude, boucle, longueur. */
  private triggerSampler(padId: number, pad: DrumPad, smp: PadSamplerParams | undefined, velocity: number, time: number, ex?: DrumNoteEx) {
    const s = smpOf(smp);
    const layerBufs = [this.buffers.get(padId), ...(this.layers.get(padId) || [])];
    const count = smp?.layers?.length ? layerBufs.length : 1;
    let rr = ex?.rr;
    if (rr === undefined && s.layerMode === 'rr' && count > 1) { rr = this.rrLive.get(padId) || 0; this.rrLive.set(padId, rr + 1); }
    const buffer = layerBufs[pickLayer(count, s.layerMode, velocity, rr || 0)] || layerBufs[0];
    if (!buffer) return;
    const ctx = this.ctx;
    const now = Math.max(time, (ctx as AudioContext).currentTime);
    const sr = ctx.sampleRate;

    // Mono (ou glisse) : la voix précédente du pad s'éteint en 5 ms.
    if (s.poly === 'mono' || ex?.glide) this.stopPadVoices(padId, now);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const lp = loopTimes(smp, buffer.duration);
    if (lp) { source.loop = true; source.loopStart = lp.start; source.loopEnd = lp.end; }

    // Hauteur : base, enveloppe de hauteur, glisse depuis le pas précédent (droites en demi-tons).
    const padTune = pad.tune || 0;
    // Durée gardée : le son traité est déjà étiré de l'accordage du pad.
    const base = noteSemis(smp, padTune, ex?.tune || 0, velocity);
    const glideFrom = ex?.glide && typeof ex.glideFrom === 'number' ? noteSemis(smp, padTune, ex.glideFrom, velocity) : null;
    const gT = glideFrom !== null ? Math.max(0, ex?.glideTime ?? s.glideMs / 1000) : 0;
    const pT = s.pitchEnvAmt ? Math.max(0.001, s.pitchEnvDecay) : 0;
    const semisAt = (t: number) => (glideFrom !== null && t < gT ? glideFrom + (base - glideFrom) * (t / gT) : base) + pitchEnvAt(smp, t);
    const modT = Math.max(gT, pT);
    if (modT > 0) scheduleFn(source.playbackRate, now, modT, Math.max(8, Math.min(256, Math.ceil(modT * 400))), t => semisToRatio(semisAt(t)));
    else if (base) source.playbackRate.value = semisToRatio(base);

    // Filtre (0, 1 ou 2 cellules), coupure suivant l'enveloppe et la vélocité.
    const sections = filterSections(s.filterType, s.filterSlope, s.reso);
    const filters = sections.map(sec => { const f = ctx.createBiquadFilter(); f.type = sec.type; f.Q.value = sec.Q; return f; });
    if (filters.length) {
      const fT = s.filterEnvAmt ? Math.max(0.001, s.filterAttack + s.filterDecay) : 0;
      if (fT > 0) {
        const n = Math.max(16, Math.min(512, Math.ceil(fT * 300)));
        filters.forEach(f => scheduleFn(f.frequency, now, fT, n, t => cutoffAt(smp, velocity, t, sr)));
      } else {
        const fc = cutoffAt(smp, velocity, 0, sr);
        filters.forEach(f => { f.frequency.value = fc; });
      }
    }

    // Niveau, enveloppe d'amplitude (note tenue : relâchement à la fin de la note).
    const peak = notePeak(smp, pad.volume, velocity);
    // Note tenue : jusqu'à la fin de la note (pré-écoute au pad : 0,5 s), puis relâchement.
    const noteLen = gated(smp) || ex?.hold ? (typeof ex?.duration === 'number' ? Math.max(0, ex.duration) : 0.5) : null;
    const segs = ampEnvelope(smp, peak, noteLen);
    const env = ctx.createGain();
    scheduleEnv(env.gain, segs, now);
    // Longueur du pad (« decay » d'avant) : même fondu qu'avant, sur un gain à part.
    const lenGain = ctx.createGain();
    const decay = pad.decay ?? 1;
    if (decay < 0.999) {
      const rate = semisToRatio(base);
      const len = (audibleLength(buffer) / rate) * Math.max(0.05, decay);
      lenGain.gain.setValueAtTime(1, now);
      lenGain.gain.setTargetAtTime(0, now + len * 0.6, len * 0.15);
    }

    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pad.pan + (ex?.pan || 0)));

    let head: AudioNode = source;
    for (const f of filters) { head.connect(f); head = f; }
    head.connect(env); env.connect(lenGain); lenGain.connect(panner);
    panner.connect(this.padInputs.get(padId) || this.output);

    source.start(now);
    const end = noteLen !== null ? now + segs[segs.length - 1].t1 : Infinity;
    if (Number.isFinite(end)) source.stop(end + 0.002);

    this.choke(pad, source, env, now);
    const voices = (this.padVoices.get(padId) || []).filter(v => v.end > now);
    voices.push({ src: source, gain: env, end });
    this.padVoices.set(padId, voices);

    source.onended = () => {
      try { source.disconnect(); filters.forEach(f => f.disconnect()); env.disconnect(); lenGain.disconnect(); panner.disconnect(); } catch { /* déjà */ }
      const vs = this.padVoices.get(padId);
      if (vs) this.padVoices.set(padId, vs.filter(v => v.src !== source));
    };
  }

  /** Éteint en 5 ms les voix en cours d'un pad (mode mono, glisse). */
  private stopPadVoices(padId: number, now: number) {
    for (const v of this.padVoices.get(padId) || []) {
      if (v.end <= now) continue;
      try {
        figerGain(v.gain.gain, now);
        v.gain.gain.setTargetAtTime(0, now, 0.005 / 3);
        v.src.stop(now + 0.03);
      } catch { /* déjà arrêtée */ }
    }
    this.padVoices.set(padId, []);
  }
}
