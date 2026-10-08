import type { Clip, Track } from '../types';
import { TrackType } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';

/**
 * Scrub et shuttle audibles (R17, Pro Tools : Scrubber F9, Ctrl+glisser, Shuttle Lock).
 *
 * Son propre, sans clics : synthèse GRANULAIRE en recouvrement-addition.
 * Toutes les HOP secondes (horloge AUDIO, pas le minuteur JavaScript), un grain
 * de 2 × HOP secondes est joué depuis la position de scrub, fenêtré par une
 * demi-sinusoïde au carré (Hann). Deux grains Hann décalés de la moitié de leur
 * longueur s'additionnent à 1 : le niveau reste constant, et chaque grain
 * commence et finit à zéro (aucune discontinuité). La vitesse de lecture du
 * grain suit la vitesse de la souris ou du doigt (de 1/16 à ×4), en arrière avec
 * le fichier inversé.
 *
 * La position suit la cible (souris) avec un léger lissage : un geste saccadé
 * ou un doigt tremblant ne fait pas « bégayer » le son.
 */

export const SCRUB_HOP = 0.02;           // 20 ms entre deux grains
export const SCRUB_GRAIN = SCRUB_HOP * 2; // 40 ms par grain (recouvrement 50 %)
export const SCRUB_MIN_RATE = 1 / 16;
export const SCRUB_MAX_RATE = 4;
/** Lissage de la position (s) : la tête rattrape la souris en ~ 3 × LAG. */
const FOLLOW_LAG = 0.05;
const LOOKAHEAD = 0.05;

/** Fenêtre de Hann sur n points (commence et finit à 0). */
export function hannCurve(n = 128): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.sin((Math.PI * i) / (n - 1)) ** 2;
  return c;
}

export interface ScrubHost {
  ctx: AudioContext;
  /** Entrée de la piste (effets, volume, panoramique ensuite). */
  input(trackId: string): AudioNode | null;
  /** Piste muette ou coupée par un solo. */
  silenced(trackId: string): boolean;
  reversed(key: string, buf: AudioBuffer): AudioBuffer;
}

export interface GrainPlan { clipId: string; trackId: string; offset: number; rate: number; reverse: boolean; gain: number }

const bufferOf = (c: Clip): AudioBuffer | null => c.buffer || (c.bufferId ? audioBufferRegistry.get(c.bufferId) || null : null);

/** Grains à jouer pour une position et une vitesse (pur : testé sans audio). */
export function planGrains(tracks: Track[], pos: number, vel: number, silenced: (id: string) => boolean = () => false): GrainPlan[] {
  const speed = Math.abs(vel);
  if (speed < 1e-3) return [];
  const rate = Math.min(SCRUB_MAX_RATE, Math.max(SCRUB_MIN_RATE, speed));
  const out: GrainPlan[] = [];
  for (const t of tracks) {
    if (t.type === TrackType.MIDI || t.type === TrackType.DRUM_RACK || t.isMuted || silenced(t.id)) continue;
    for (const c of t.clips || []) {
      if (c.isMuted || pos < c.start || pos >= c.start + c.duration) continue;
      const buf = bufferOf(c);
      if (!buf) continue;
      const inClip = pos - c.start;
      // Position dans le fichier JOUÉ par le clip (inversé si clip.isReversed).
      const played = (c.offset || 0) + inClip;
      // En arrière : le fichier joué, lu à l'envers. Le fichier à prendre est donc
      // l'inverse de celui du clip (l'original pour un clip inversé).
      const reverse = vel < 0 !== !!c.isReversed;
      const read = vel < 0 ? buf.duration - played : played;
      if (read < 0 || read >= buf.duration) continue;
      out.push({ clipId: c.id, trackId: t.id, offset: read, rate, reverse, gain: c.gain ?? 1 });
    }
  }
  return out;
}

export interface ScrubStats { grains: number; ticks: number; peakRate: number; active: boolean; pos: number }

export class Scrubber {
  private tracks: Track[] = [];
  private target = 0;
  private pos = 0;
  private vel = 0;
  /** Shuttle : vitesse constante (× temps réel, signée) ; null = scrub à la souris. */
  private shuttleSpeed: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextGrainAt = 0;
  private curve = hannCurve();
  private live = new Set<AudioBufferSourceNode>();
  stats: ScrubStats = { grains: 0, ticks: 0, peakRate: 0, active: false, pos: 0 };
  /** Appelé à chaque déplacement de la position (tête de lecture affichée). */
  onMove: ((t: number) => void) | null = null;

  constructor(private host: ScrubHost) {}

  get active() { return this.timer !== null; }
  get position() { return this.pos; }

  /** Scrub : la position suit `time` (secondes du morceau). */
  scrubTo(tracks: Track[], time: number) {
    this.tracks = tracks;
    if (!this.active) { this.pos = time; this.vel = 0; this.start(); }
    this.shuttleSpeed = null;
    this.target = Math.max(0, time);
  }

  /** Shuttle : défile à `speed` × le temps réel (négatif = en arrière). 0 = immobile, le son se tait. */
  shuttle(tracks: Track[], speed: number, from?: number) {
    this.tracks = tracks;
    if (!this.active) { this.pos = Math.max(0, from ?? this.pos); this.start(); }
    this.shuttleSpeed = speed;
  }

  get shuttling() { return this.shuttleSpeed; }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.vel = 0;
    this.shuttleSpeed = null;
    this.stats.active = false;
    // Les grains déjà programmés finissent leur fenêtre (≤ 40 ms) : pas de coupure sèche.
  }

  private start() {
    const ctx = this.host.ctx;
    this.nextGrainAt = ctx.currentTime + 0.01;
    this.stats.active = true;
    this.timer = setInterval(() => this.tick(), 10);
    this.tick();
  }

  private tick() {
    const ctx = this.host.ctx;
    this.stats.ticks++;
    // Programme les grains jusqu'à LOOKAHEAD en avance, au pas fixe de l'horloge audio.
    if (this.nextGrainAt < ctx.currentTime) this.nextGrainAt = ctx.currentTime + 0.005;
    while (this.nextGrainAt < ctx.currentTime + LOOKAHEAD) {
      if (this.shuttleSpeed !== null) {
        this.vel = this.shuttleSpeed;
      } else {
        const gap = this.target - this.pos;
        this.vel = Math.abs(gap) < 1e-4 ? 0 : Math.max(-16, Math.min(16, gap / FOLLOW_LAG));
      }
      const from = this.pos;
      this.pos = Math.max(0, this.pos + this.vel * SCRUB_HOP);
      if (this.pos === 0 && this.vel < 0) this.vel = 0;
      this.emit(from, this.vel, this.nextGrainAt);
      this.nextGrainAt += SCRUB_HOP;
    }
    this.stats.pos = this.pos;
    this.onMove?.(this.pos);
  }

  private emit(pos: number, vel: number, when: number) {
    const plans = planGrains(this.tracks, pos, vel, id => this.host.silenced(id));
    if (!plans.length) return;
    const ctx = this.host.ctx;
    for (const p of plans) {
      const input = this.host.input(p.trackId);
      const clip = this.tracks.find(t => t.id === p.trackId)?.clips.find(c => c.id === p.clipId);
      const raw = clip && bufferOf(clip);
      if (!input || !raw) continue;
      const buf = p.reverse ? this.host.reversed(clip!.bufferId || clip!.id, raw) : raw;
      try {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = p.rate;
        const env = ctx.createGain();
        env.gain.value = 0;
        const peak = Float32Array.from(this.curve, v => v * p.gain);
        env.gain.setValueCurveAtTime(peak, when, SCRUB_GRAIN);
        src.connect(env);
        env.connect(input);
        src.start(when, Math.min(p.offset, buf.duration - 1e-3), SCRUB_GRAIN * p.rate + 0.002);
        src.stop(when + SCRUB_GRAIN + 0.005);
        this.live.add(src);
        src.onended = () => { this.live.delete(src); try { src.disconnect(); env.disconnect(); } catch { /* déjà débranché */ } };
        this.stats.grains++;
        this.stats.peakRate = Math.max(this.stats.peakRate, p.rate);
      } catch { /* contexte fermé : on ignore ce grain */ }
    }
  }
}
