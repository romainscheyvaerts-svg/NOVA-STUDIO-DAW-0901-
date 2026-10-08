/**
 * Contrôleurs MIDI des instruments de NOVA (R16) : pitch bend, modulation
 * (vibrato), expression / volume (CC11 / CC7) et brillance (CC74).
 *
 * Programmés à l'échantillon près sur l'horloge du son (lecture et export
 * identiques). Rien n'est branché tant que l'instrument n'a pas reçu de
 * contrôleur : une piste sans CC sonne exactement comme avant (aucun nœud
 * ajouté au chemin des voix).
 */
import { bendCents, modCents, ccGain, brightnessCents, PB, MODWHEEL, EXPRESSION, VOLUME, BRIGHTNESS, DEFAULT_BEND_RANGE } from '../utils/midiCc';

interface VoiceHandle { pitch: AudioParam[]; filter: AudioParam[]; pitchIn?: GainNode; filterIn?: GainNode; alive: boolean }

export class SynthControllers {
  private ctx: BaseAudioContext;
  private gainParam: AudioParam | null;
  private baseGain: number;
  private active = false;
  private bend?: ConstantSourceNode;
  private vib?: OscillatorNode;
  private vibDepth?: GainNode;
  private bright?: ConstantSourceNode;
  private voices = new Set<VoiceHandle>();
  private expr = 127;
  private vol = 127;
  bendRange = DEFAULT_BEND_RANGE;

  /** `gain` : gain de sortie de l'instrument (expression / volume), `baseGain` sa valeur normale. */
  constructor(ctx: BaseAudioContext, gain: AudioParam | null, baseGain = 1) {
    this.ctx = ctx;
    this.gainParam = gain;
    this.baseGain = baseGain;
  }

  get isActive() { return this.active; }

  private activate() {
    if (this.active) return;
    this.active = true;
    const ctx = this.ctx;
    this.bend = ctx.createConstantSource();
    this.bend.offset.value = 0;
    this.bend.start(0);
    this.vib = ctx.createOscillator();
    this.vib.frequency.value = 5.5;
    this.vibDepth = ctx.createGain();
    this.vibDepth.gain.value = 0;
    this.vib.connect(this.vibDepth);
    this.vib.start(0);
    this.bright = ctx.createConstantSource();
    this.bright.offset.value = 0;
    this.bright.start(0);
    this.voices.forEach(v => this.connectVoice(v));
  }

  private connectVoice(v: VoiceHandle) {
    if (!this.active || !v.alive || v.pitchIn) return;
    const ctx = this.ctx;
    if (v.pitch.length) {
      v.pitchIn = ctx.createGain();
      this.bend!.connect(v.pitchIn);
      this.vibDepth!.connect(v.pitchIn);
      v.pitch.forEach(p => v.pitchIn!.connect(p));
    }
    if (v.filter.length) {
      v.filterIn = ctx.createGain();
      this.bright!.connect(v.filterIn);
      v.filter.forEach(p => v.filterIn!.connect(p));
    }
  }

  /** Une voix commence : ses paramètres de hauteur (detune en cents) et de filtre suivront les contrôleurs. */
  attachVoice(pitch: AudioParam[], filter: AudioParam[] = []): () => void {
    const v: VoiceHandle = { pitch, filter, alive: true };
    this.voices.add(v);
    this.connectVoice(v);
    return () => {
      if (!v.alive) return;
      v.alive = false;
      this.voices.delete(v);
      try { if (v.pitchIn) { this.bend?.disconnect(v.pitchIn); this.vibDepth?.disconnect(v.pitchIn); v.pitchIn.disconnect(); } } catch { /* */ }
      try { if (v.filterIn) { this.bright?.disconnect(v.filterIn); v.filterIn.disconnect(); } } catch { /* */ }
    };
  }

  /** Contrôleur reçu (clé « pb », « cc1 »…, valeur MIDI brute) à l'instant `time` du contexte. */
  set(key: string, value: number, time: number) {
    const t = Math.max(time, this.ctx.currentTime);
    if (key === PB) { this.activate(); this.bend!.offset.setValueAtTime(bendCents(value, this.bendRange), t); return; }
    if (key === MODWHEEL) { this.activate(); this.vibDepth!.gain.setValueAtTime(modCents(value), t); return; }
    if (key === BRIGHTNESS) { this.activate(); this.bright!.offset.setValueAtTime(brightnessCents(value), t); return; }
    if ((key === EXPRESSION || key === VOLUME) && this.gainParam) {
      if (key === EXPRESSION) this.expr = value; else this.vol = value;
      this.gainParam.setValueAtTime(this.baseGain * ccGain(this.expr) * ccGain(this.vol), t);
    }
  }

  /** Arrêt de la lecture : retour au repos (bend 0, pas de vibrato, volume plein). */
  reset(time = 0) {
    const t = Math.max(time, this.ctx.currentTime);
    if (this.active) {
      this.bend!.offset.cancelScheduledValues(t); this.bend!.offset.setValueAtTime(0, t);
      this.vibDepth!.gain.cancelScheduledValues(t); this.vibDepth!.gain.setValueAtTime(0, t);
      this.bright!.offset.cancelScheduledValues(t); this.bright!.offset.setValueAtTime(0, t);
    }
    if (this.gainParam && (this.expr !== 127 || this.vol !== 127)) {
      this.expr = 127; this.vol = 127;
      this.gainParam.cancelScheduledValues(t);
      this.gainParam.setValueAtTime(this.baseGain, t);
    }
  }

  destroy() {
    for (const n of [this.bend, this.vib, this.bright]) { try { n?.stop(); n?.disconnect(); } catch { /* */ } }
    try { this.vibDepth?.disconnect(); } catch { /* */ }
    this.voices.clear();
  }
}
