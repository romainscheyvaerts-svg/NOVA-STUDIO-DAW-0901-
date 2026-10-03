import { Bass808Style, BASS808_ROOT, BASS808_RELEASE, DEFAULT_GLIDE_TIME, midiToHz, rateForPitch, Voice808, Event808, Bass808Settings, plan808 } from '../utils/bass808';
import { Clip, TrackType } from '../types';

/** Notes (temps absolus) de clips MIDI, clips coupés exclus. */
export function notesOfClips(clips: Clip[]) {
  return clips.filter(c => !c.isMuted && c.type === TrackType.MIDI && c.notes && c.notes.length)
    .flatMap(c => c.notes!.filter(n => n.start < c.duration).map(n => ({
      pitch: n.pitch, velocity: n.velocity, start: c.start + n.start, duration: Math.min(n.duration, c.duration - n.start),
    })));
}

/** Plan 808 mis en cache par liste de clips (recalculé seulement si les clips changent). */
const planCache = new WeakMap<Clip[], { glide: boolean; voices: Voice808[] }>();
export function planOfClips(clips: Clip[], s: Bass808Settings): Voice808[] {
  const c = planCache.get(clips);
  if (c && c.glide === !!s.glide) return c.voices;
  const voices = plan808(notesOfClips(clips), !!s.glide);
  planCache.set(clips, { glide: !!s.glide, voices });
  return voices;
}

/**
 * Instrument 808 d'une piste MIDI : un son de 808 (synthétisé sur Do 2) rejoué
 * à la hauteur de chaque note, monophonique, avec glissé de hauteur.
 * Les appels doivent arriver dans l'ordre du temps (voir plan808 / events808).
 */

const cache = new Map<string, Promise<AudioBuffer>>();

/** Son 808 de référence (Do 2), long (3,5 s) pour tenir les notes longues. */
export function render808Sample(style: Bass808Style, sampleRate: number): Promise<AudioBuffer> {
  const key = `${style}|${sampleRate}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const len = 3.5;
      const ctx = new OfflineAudioContext(1, Math.ceil(len * sampleRate), sampleRate);
      const dist = style === '808-dist';
      const f = midiToHz(BASS808_ROOT);
      const o = ctx.createOscillator();
      // « Knock » : la hauteur tombe vite sur la fondamentale.
      o.frequency.setValueAtTime(f * 2.6, 0);
      o.frequency.exponentialRampToValueAtTime(f, 0.035);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, 0);
      env.gain.linearRampToValueAtTime(1, 0.003);
      env.gain.setValueAtTime(1, 0.06);
      env.gain.setTargetAtTime(0, 0.06, dist ? 0.8 : 1.0);
      env.gain.setValueAtTime(0.03, len - 0.25);
      env.gain.linearRampToValueAtTime(0, len);
      // Saturation douce : des harmoniques pour l'entendre aussi sur un téléphone.
      const sh = ctx.createWaveShaper();
      const k = dist ? 5 : 2;
      const curve = new Float32Array(2048);
      for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); }
      sh.curve = curve;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = dist ? 2600 : 800; lp.Q.value = 0.7;
      o.connect(env).connect(sh).connect(lp).connect(ctx.destination);
      o.start(0); o.stop(len);
      const buf = await ctx.startRendering();
      const d = buf.getChannelData(0);
      let pk = 0; for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; }
      if (pk > 0) { const g = 0.8 / pk; for (let i = 0; i < d.length; i++) d[i] *= g; }
      return buf;
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

interface Voice { src: AudioBufferSourceNode; g: GainNode; pitch: number; level: number; start: number }

export class Bass808Node {
  public output: GainNode;
  public ready: Promise<void> = Promise.resolve();
  private ctx: BaseAudioContext;
  private buffer: AudioBuffer | null = null;
  private style: Bass808Style | null = null;
  private glideTime = DEFAULT_GLIDE_TIME;
  private cur: Voice | null = null;
  /** Dernière voix relâchée (sa queue est coupée si une note repart dessus). */
  private tail: { v: Voice; t: number; fade: number } | null = null;

  constructor(ctx: BaseAudioContext, style: Bass808Style = '808') {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.setStyle(style);
  }

  public setStyle(style: Bass808Style) {
    if (style === this.style) return;
    this.style = style;
    this.ready = render808Sample(style, this.ctx.sampleRate)
      .then(b => { if (this.style === style) this.buffer = b; })
      .catch(e => console.warn('[808] son indisponible', e));
  }

  public setGlideTime(s?: number) { this.glideTime = Math.max(0.01, Math.min(0.3, s ?? DEFAULT_GLIDE_TIME)); }

  /**
   * Repart de `value` à l'instant t. Une rampe s'appuie sur l'événement
   * précédent : sans ce point fixe, le relâchement (ou le glissé) s'étalait
   * depuis le début de la note (cancelAndHoldAtTime n'en ajoute pas toujours).
   */
  private from(p: AudioParam, t: number, value: number) {
    p.cancelScheduledValues(t);
    p.setValueAtTime(value, t);
  }

  private end(v: Voice, time: number, fade: number) {
    try {
      const t = Math.max(time, v.start + 0.002);
      this.from(v.g.gain, t, v.level);
      v.g.gain.linearRampToValueAtTime(0, t + fade);
      v.src.stop(t + fade + 0.02);
      this.tail = { v, t, fade };
    } catch { /* déjà arrêtée */ }
  }

  public startVoice(time: number, pitch: number, velocity = 0.9) {
    const t = Math.max(time, this.ctx.currentTime);
    // Mono : l'ancienne voix (ou la queue de son relâchement) s'éteint en 4 ms
    // et se tait pile à l'attaque (pas de cumul ni de crête).
    if (this.cur) { this.end(this.cur, Math.max(t - 0.004, this.ctx.currentTime), 0.004); this.cur = null; }
    else if (this.tail && t < this.tail.t + this.tail.fade) {
      const { v, t: t0, fade } = this.tail;
      const c = Math.max(t - 0.004, this.ctx.currentTime, v.start + 0.002);
      const val = v.level * Math.min(1, Math.max(0, 1 - (c - t0) / fade));
      try { this.from(v.g.gain, c, val); v.g.gain.linearRampToValueAtTime(0, Math.max(t, c + 0.001)); } catch { /* */ }
    }
    this.tail = null;
    if (!this.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.setValueAtTime(rateForPitch(pitch), t);
    const g = this.ctx.createGain();
    const level = Math.max(0.05, Math.min(1, velocity));
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.002);
    src.connect(g).connect(this.output);
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* */ } };
    src.start(t);
    this.cur = { src, g, pitch, level, start: t };
  }

  /** Glissé de la voix en cours vers `pitch` (sans réattaque). */
  public glideTo(time: number, pitch: number, velocity = 0.9) {
    if (!this.cur) { this.startVoice(time, pitch, velocity); return; }
    const t = Math.max(time, this.ctx.currentTime);
    const p = this.cur.src.playbackRate;
    this.from(p, t, rateForPitch(this.cur.pitch));
    p.exponentialRampToValueAtTime(rateForPitch(pitch), t + this.glideTime);
    this.cur.pitch = pitch;
  }

  public stopVoice(time: number, release = BASS808_RELEASE) {
    if (!this.cur) return;
    this.end(this.cur, Math.max(time, this.ctx.currentTime), release);
    this.cur = null;
  }

  /** Événements d'un plan (temps projet), `toCtx` donne l'instant du contexte audio. */
  public play(events: Event808[], toCtx: (t: number) => number) {
    for (const e of events) {
      if (e.kind === 'start') this.startVoice(toCtx(e.t), e.pitch, e.velocity);
      else if (e.kind === 'glide') this.glideTo(toCtx(e.t), e.pitch);
      else this.stopVoice(toCtx(e.t));
    }
  }

  /** Plan entier (rendu hors temps réel). */
  public playVoices(voices: Voice808[], offset: number) {
    for (const v of voices) {
      const s = v.start - offset;
      if (s < 0) continue; // note commencée avant la zone rendue : comme en lecture
      this.startVoice(s, v.steps[0].pitch, v.velocity);
      v.steps.slice(1).forEach(st => this.glideTo(st.t - offset, st.pitch));
      this.stopVoice(v.end - offset);
    }
  }

  // Interface commune des instruments (aperçu du piano roll, clavier)
  public triggerAttack(pitch: number, velocity = 0.8, time = 0) { this.startVoice(time, pitch, velocity); }
  public triggerRelease(pitch: number, time = 0) { if (this.cur && this.cur.pitch === pitch) this.stopVoice(time); }

  public stopAll(time?: number) {
    if (!this.cur) return;
    this.end(this.cur, Math.max(time ?? 0, this.ctx.currentTime), 0.015);
    this.cur = null;
  }
}
