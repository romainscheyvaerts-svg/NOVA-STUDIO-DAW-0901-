import {
  DEFAULT_SAMPLER, MelodicSamplerSettings, normalizeSampler, pickZone, playbackRateFor, SamplerZone, velocityGain,
} from '../utils/melodicSampler';

/**
 * R18 · Moteur du sampler mélodique et R20 · instruments multi-échantillons.
 *
 * Chaque note choisit une zone (note, vélocité, round-robin), lit son
 * échantillon à la bonne vitesse (racine + accord fin + hauteur de la note +
 * pitch bend), avec une enveloppe ADSR, une boucle, un glissé (portamento)
 * et un mode mono (legato, pile de notes comme un synthé mono) ou poly.
 * Pitch bend (« pb »), modulation (« cc1 », vibrato), volume (« cc7 ») et
 * expression (« cc11 ») de R16 sont suivis. Même code en lecture et à
 * l'export (OfflineAudioContext).
 */

/** Ancienne interface (éditeur d'avant R18) : gardée pour la compatibilité des types. */
export type MelodicSamplerParams = MelodicSamplerSettings;

export interface LoadedZone extends SamplerZone { buffer: AudioBuffer }

interface Voice {
  pitch: number;
  src: AudioBufferSourceNode;
  env: GainNode;
  pan?: StereoPannerNode;
  filter?: BiquadFilterNode;
  /** Vitesse de la zone pour la note (sans pitch bend). */
  rate: number;
  zone: LoadedZone;
  peak: number;
  releasedAt: number | null;
  startedAt: number;
}

const MAX_VOICES = 32;
const SEMI = 100; // cents

export class MelodicSamplerNode {
  private ctx: BaseAudioContext;
  public input: GainNode;
  public output: GainNode;
  private bus: GainNode;
  private expr: GainNode;
  private settings: MelodicSamplerSettings = { ...DEFAULT_SAMPLER };
  private zones: LoadedZone[] = [];
  private voices: Voice[] = [];
  /** Mono : notes tenues (la dernière joue ; la relâcher revient à la précédente). */
  private held: { pitch: number; velocity: number }[] = [];
  /** Hauteur de la note précédente (demi-tons, glissé). */
  private lastPitch: number | null = null;
  private vibratoOn = false;
  private rr = 0;
  /** Pitch bend en cents (R16). */
  private bendCents = 0;
  private vibrato: OscillatorNode;
  private vibratoDepth: GainNode;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.bus = ctx.createGain();
    this.expr = ctx.createGain();
    this.bus.connect(this.expr);
    this.expr.connect(this.output);
    this.input.connect(this.output);
    // Vibrato (CC1 modulation) : un LFO partagé branché sur le détune de chaque voix.
    this.vibrato = ctx.createOscillator();
    this.vibrato.frequency.value = 5.5;
    this.vibratoDepth = ctx.createGain();
    this.vibratoDepth.gain.value = 0;
    this.vibrato.connect(this.vibratoDepth);
    this.vibrato.start();
    this.applyGain();
  }

  // ===== Réglages et sons =====

  public setSettings(s: Partial<MelodicSamplerSettings>) {
    this.settings = normalizeSampler({ ...this.settings, ...s });
    this.applyGain();
  }
  public getSettings(): MelodicSamplerSettings { return { ...this.settings }; }

  private applyGain() {
    this.bus.gain.value = Math.pow(10, this.settings.gainDb / 20);
  }

  /** Zones prêtes à jouer (instrument multi-échantillons ou sample perso). */
  public setZones(zones: LoadedZone[]) {
    this.zones = zones.filter(z => !!z.buffer);
  }
  public getZones(): LoadedZone[] { return this.zones; }
  public hasSound() { return this.zones.length > 0; }

  /** Ancienne API : un seul son, sur toutes les notes (racine des réglages). */
  public loadBuffer(buffer: AudioBuffer) {
    this.setZones([{ file: '', buffer, root: this.settings.rootKey, tune: this.settings.fineTune, lo: 0, hi: 127, velLo: 1, velHi: 127 }]);
  }
  public getBuffer(): AudioBuffer | null { return this.zones[0]?.buffer || null; }
  /** Ancienne API (éditeur d'avant R18). */
  public updateParams(p: Partial<MelodicSamplerSettings>) { this.setSettings(p); }
  public getParams() { return this.getSettings(); }

  // ===== Notes =====

  public triggerAttack(pitch: number, velocity: number, time: number, ex?: { pan?: number; tune?: number }) {
    const now = Math.max(time, this.ctx.currentTime);
    const s = this.settings;
    if (s.mono) {
      const prev = this.held.length ? this.held[this.held.length - 1] : null;
      this.held = this.held.filter(h => h.pitch !== pitch);
      this.held.push({ pitch, velocity });
      const live = this.voices.find(v => v.releasedAt === null);
      // Legato : la voix tenue glisse vers la nouvelle note (sans nouvelle attaque).
      if (prev && live && s.glide > 0) { this.glideVoice(live, pitch, now); return; }
      this.voices.forEach(v => { if (v.releasedAt === null) this.release(v, now, 0.006); });
    } else {
      // Même note rejouée : la précédente se relâche (piano, comme un vrai clavier).
      this.voices.forEach(v => { if (v.pitch === pitch && v.releasedAt === null) this.release(v, now); });
    }
    this.start(pitch, velocity, now, ex);
  }

  public triggerRelease(pitch: number, time: number) {
    const now = Math.max(time, this.ctx.currentTime);
    if (this.settings.mono) {
      const top = this.held.length ? this.held[this.held.length - 1].pitch : null;
      this.held = this.held.filter(h => h.pitch !== pitch);
      const live = this.voices.find(v => v.releasedAt === null);
      if (top === pitch && this.held.length && live) {
        // Retour à la note encore tenue (mono, comme un synthé).
        const back = this.held[this.held.length - 1];
        if (this.settings.glide > 0) this.glideVoice(live, back.pitch, now);
        else { this.release(live, now, 0.006); this.start(back.pitch, back.velocity, now); }
        return;
      }
      if (top !== pitch && this.held.length) return;
      this.voices.forEach(v => { if (v.releasedAt === null) this.release(v, now); });
      return;
    }
    this.voices.forEach(v => { if (v.pitch === pitch && v.releasedAt === null) this.release(v, now); });
  }

  private start(pitch: number, velocity: number, now: number, ex?: { pan?: number; tune?: number }) {
    const zone = pickZone(this.zones, pitch, velocity * 127, this.rr++);
    if (!zone) return;
    const s = this.settings;
    const buf = zone.buffer;
    const p = pitch + (ex?.tune || 0);
    const rate = playbackRateFor(p, zone.root, zone.tune || 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    // Glissé (portamento) : la note part de la hauteur de la précédente.
    const from = s.glide > 0 && this.lastPitch !== null && !zone.exact ? playbackRateFor(this.lastPitch, zone.root, zone.tune || 0) : rate;
    src.playbackRate.setValueAtTime(from, now);
    if (from !== rate) src.playbackRate.setTargetAtTime(rate, now, Math.max(0.002, s.glide / 3));
    this.lastPitch = p;
    src.detune.setValueAtTime(this.bendCents, now);
    if (this.vibratoOn) this.vibratoDepth.connect(src.detune);

    const offset = Math.max(0, Math.min(buf.duration - 0.001, zone.offset || 0));
    const sliceEnd = zone.end && zone.end > offset ? zone.end : 0;
    if (typeof zone.loopStart === 'number' && typeof zone.loopEnd === 'number' && zone.loopEnd > zone.loopStart + 0.005) {
      src.loop = true;
      src.loopStart = zone.loopStart;
      src.loopEnd = Math.min(buf.duration, zone.loopEnd);
    }

    const env = this.ctx.createGain();
    const peak = velocityGain(velocity, s.velSens);
    const g = env.gain;
    const slice = !!(zone.exact && sliceEnd);
    if (slice) {
      // Tranche d'un chop : jouée telle quelle (bords coupés sur des passages par zéro),
      // pour que les tranches mises bout à bout redonnent exactement l'original.
      g.setValueAtTime(peak, now);
    } else {
      g.setValueAtTime(0, now);
      const atk = Math.max(0.0015, s.attack);
      g.linearRampToValueAtTime(peak, now + atk);
      if (s.sustain < 0.999) g.setTargetAtTime(peak * s.sustain, now + atk, Math.max(0.003, s.decay / 3));
    }

    let node: AudioNode = src;
    let filter: BiquadFilterNode | undefined;
    if (s.cutoff < 19999) {
      filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = s.cutoff;
      filter.Q.value = s.resonance;
      node.connect(filter); node = filter;
    }
    node.connect(env);
    let pan: StereoPannerNode | undefined;
    if (ex?.pan) {
      pan = this.ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, ex.pan));
      env.connect(pan); pan.connect(this.bus);
    } else env.connect(this.bus);

    if (slice) {
      src.start(now, offset, sliceEnd - offset);
    } else if (sliceEnd) {
      // Zone bornée (hors chop) : jouée jusqu'à sa fin avec un micro-fondu de sortie.
      const dur = (sliceEnd - offset) / rate;
      src.start(now, offset);
      g.setValueAtTime(peak, now + Math.max(0.002, dur - 0.004));
      g.linearRampToValueAtTime(0, now + dur);
      src.stop(now + dur + 0.01);
    } else {
      src.start(now, offset);
    }
    const v: Voice = { pitch, src, env, pan, filter, rate, zone, peak, releasedAt: null, startedAt: now };
    src.onended = () => {
      try { src.disconnect(); env.disconnect(); filter?.disconnect(); pan?.disconnect(); } catch { /* déjà débranché */ }
      if (this.vibratoOn) try { this.vibratoDepth.disconnect(src.detune); } catch { /* pas branché */ }
      this.voices = this.voices.filter(x => x !== v);
    };
    this.voices.push(v);
    // Polyphonie bornée : la voix la plus ancienne s'éteint.
    if (this.voices.length > MAX_VOICES) this.release(this.voices[0], now, 0.01);
  }

  private glideVoice(v: Voice, pitch: number, now: number) {
    const rate = playbackRateFor(pitch, v.zone.root, v.zone.tune || 0);
    v.src.playbackRate.cancelScheduledValues(now);
    v.src.playbackRate.setTargetAtTime(rate, now, Math.max(0.002, this.settings.glide / 3));
    v.pitch = pitch;
    v.rate = rate;
    this.lastPitch = pitch;
  }

  private release(v: Voice, now: number, fast?: number) {
    if (v.releasedAt !== null) return;
    // Tranche : elle va au bout d'elle-même (sauf coupure forcée : arrêt, même tranche rejouée).
    if (v.zone.exact && fast === undefined) return;
    v.releasedAt = now;
    const rel = fast ?? Math.max(0.005, this.settings.release);
    const g = v.env.gain;
    const anyG = g as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
    if (anyG.cancelAndHoldAtTime) anyG.cancelAndHoldAtTime(now);
    else { g.cancelScheduledValues(now); }
    g.setTargetAtTime(0, now, rel / 4);
    try { v.src.stop(now + rel * 1.6 + 0.02); } catch { /* déjà arrêtée */ }
  }

  // ===== Contrôleurs MIDI (R16) =====

  /** `key` : « pb » (0-16383, centre 8192), « cc1 » (vibrato), « cc7 » (volume), « cc11 » (expression). */
  public setController(key: string, value: number, time: number) {
    const t = Math.max(time, this.ctx.currentTime);
    if (key === 'pb') {
      const norm = Math.max(-1, Math.min(1, (value - 8192) / 8192));
      this.bendCents = norm * this.settings.bendRange * SEMI;
      this.voices.forEach(v => { if (v.releasedAt === null || v.releasedAt > t) v.src.detune.setValueAtTime(this.bendCents, t); });
    } else if (key === 'cc1') {
      if (value > 0 && !this.vibratoOn) {
        this.vibratoOn = true;
        this.voices.forEach(v => { try { this.vibratoDepth.connect(v.src.detune); } catch { /* voix finie */ } });
      }
      this.vibratoDepth.gain.setValueAtTime((value / 127) * 50, t); // jusqu'à ±50 cents
    } else if (key === 'cc7' || key === 'cc11') {
      this.expr.gain.setValueAtTime(Math.pow(Math.max(0, Math.min(127, value)) / 127, 1.6), t);
    }
  }

  public stopAll(time?: number) {
    const now = Math.max(time ?? 0, this.ctx.currentTime);
    this.held = [];
    this.voices.forEach(v => this.release(v, now, 0.01));
  }

  public dispose() {
    this.stopAll();
    try { this.vibrato.stop(); this.vibrato.disconnect(); this.vibratoDepth.disconnect(); } catch { /* déjà arrêté */ }
  }
}
