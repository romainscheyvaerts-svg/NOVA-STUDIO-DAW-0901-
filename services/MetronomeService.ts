/**
 * MÉTRONOME (R2) : clic calé sur la carte des tempos et des mesures, sons au
 * choix, accent du premier temps, clic pendant l'enregistrement seulement ou
 * aussi en lecture, sortie, et décompte (utils/countIn).
 *
 * Comme la fenêtre Click/Countoff de Pro Tools, le métronome de Logic et
 * d'Ableton et celui de FL : le clic suit les changements de tempo et de mesure
 * de la piste tempo (utils/tempoMap), et il reste calé quand la boucle repart
 * (horloge du moteur, fenêtres de 25 ms programmées 120 ms à l'avance).
 */
import { TimeSignature, MetronomeSettings } from '../types';
import { buildTempoMap, beatsInRange, type TempoMap } from '../utils/tempoMap';
import type { CountInPlan } from '../utils/countIn';

export type MetronomeSound = MetronomeSettings['sound'];

export const METRONOME_SOUNDS: { id: MetronomeSound; label: string; hint: string }[] = [
  { id: 'CLICK', label: 'Clic', hint: 'Clic sinusoïdal court (Pro Tools Click II)' },
  { id: 'WOODBLOCK', label: 'Woodblock', hint: 'Bloc de bois (Logic, Ableton « Wood »)' },
  { id: 'STICK', label: 'Baguette', hint: 'Baguettes / charley fermé, discret sous la voix' },
  { id: 'COWBELL', label: 'Cloche', hint: 'Cloche (cowbell), perce un mix chargé' },
  { id: 'BEEP', label: 'Bip', hint: 'Bip carré, très net au casque' },
];

/** Horloge du moteur : début du morceau en temps du contexte, bouclage en cours, zone de boucle. */
export interface TransportClock {
  playing: boolean;
  startTime: number;
  wrap: { at: number; prevStart: number } | null;
  loop: { start: number; end: number } | null;
}

class MetronomeService {
  private static instance: MetronomeService;
  private ctx: AudioContext | null = null;

  private settings: MetronomeSettings = { enabled: false, volume: 0.7, countIn: 0, accentDownbeat: true, sound: 'CLICK' };
  private map: TempoMap = buildTempoMap(120, { numerator: 4, denominator: 4 }, []);
  private bpm = 120;
  private ts: TimeSignature = { numerator: 4, denominator: 4 };

  private isPlaying = false;
  private schedulerTimer: number | null = null;
  private scheduledUntil = 0;
  private lookaheadMs = 25;
  private scheduleAheadTime = 0.12;
  private clock: (() => TransportClock | null) | null = null;
  /** Repli sans horloge du moteur : instant du contexte où le morceau commence. */
  private freeStart = 0;
  /** Début (contexte) de la lecture en cours quand le clic a été lancé. */
  private runStart: number | null = null;

  private outputGain: GainNode | null = null;
  private outputs: { main: AudioNode | null; system: AudioNode | null } = { main: null, system: null };
  /** Clics programmés (pour les couper net à l'arrêt). */
  private live = new Set<AudioScheduledSourceNode>();
  /** Derniers clics programmés (tests, preuves) : instant du contexte et accent. */
  public lastScheduled: { at: number; accent: boolean; projectTime?: number }[] = [];

  private constructor() {}

  public static getInstance(): MetronomeService {
    if (!MetronomeService.instance) MetronomeService.instance = new MetronomeService();
    return MetronomeService.instance;
  }

  public init(audioContext: AudioContext) {
    this.ctx = audioContext;
    this.outputGain = this.ctx.createGain();
    this.outputGain.gain.value = this.settings.volume;
    this.outputs.system = this.ctx.destination;
    this.routeOutput();
  }

  /** Sorties possibles : « main » = comme la musique (carte son de NOVA, ASIO compris), « system » = sortie de l'ordinateur. */
  public setOutputs(o: { main?: AudioNode | null; system?: AudioNode | null }) {
    if (o.main !== undefined) this.outputs.main = o.main;
    if (o.system !== undefined) this.outputs.system = o.system;
    this.routeOutput();
  }

  private routeOutput() {
    if (!this.outputGain || !this.ctx) return;
    try { this.outputGain.disconnect(); } catch { /* pas encore relié */ }
    const target = (this.settings.output === 'system' ? this.outputs.system : this.outputs.main) || this.outputs.system || this.ctx.destination;
    this.outputGain.connect(target);
  }

  public setClock(fn: (() => TransportClock | null) | null) { this.clock = fn; }

  public setSettings(settings: Partial<MetronomeSettings>) {
    const prevOut = this.settings.output;
    this.settings = { ...this.settings, ...settings };
    if (this.outputGain && this.ctx) this.outputGain.gain.setTargetAtTime(this.settings.volume, this.ctx.currentTime, 0.01);
    if (prevOut !== this.settings.output) this.routeOutput();
  }

  public getSettings(): MetronomeSettings { return { ...this.settings }; }

  public setTempoMap(m: TempoMap) { this.map = m; }
  public getTempoMap(): TempoMap { return this.map; }

  /** Compatibilité : tempo et mesure fixes (sans changements). */
  public setTimeSignature(ts: TimeSignature) { this.ts = ts; this.map = buildTempoMap(this.bpm, ts, []); }
  public setBpm(bpm: number) { this.bpm = bpm; this.map = buildTempoMap(bpm, this.ts, []); }

  /**
   * Démarre le clic. `projectTime` : position au démarrage (repli sans horloge
   * du moteur). Avec l'horloge (setClock), le clic suit la lecture, la boucle comprise.
   */
  public start(projectTime: number = 0) {
    if (!this.ctx || !this.settings.enabled) return;
    const c = this.clock?.() ?? null;
    // Déjà lancé pour cette lecture (appel direct au démarrage, puis l'effet de l'interface) : rien à refaire.
    if (this.isPlaying && c?.playing && this.runStart !== null && Math.abs(c.startTime - this.runStart) < 1e-6) return;
    this.stopScheduler();
    this.isPlaying = true;
    this.runStart = c?.playing ? c.startTime : null;
    const now = this.ctx.currentTime;
    this.freeStart = now - Math.max(0, projectTime);
    // Le temps qui tombe au départ de la lecture sonne toujours, même si le contexte
    // a déjà avancé de quelques ms (au pire un bloc de rendu en retard, jamais sauté).
    const playFrom = c?.playing ? c.startTime + Math.max(0, projectTime) : now;
    this.scheduledUntil = playFrom > now - 0.05 ? Math.min(now, playFrom) - 0.0005 : now;
    this.startScheduler();
  }

  public stop() {
    this.isPlaying = false;
    this.runStart = null;
    this.stopScheduler();
    // Clics déjà programmés au-delà de maintenant : coupés.
    const now = this.ctx?.currentTime ?? 0;
    this.live.forEach(n => { try { n.stop(now); } catch { /* déjà fini */ } });
    this.live.clear();
  }

  /** Après un saut de la tête de lecture : on repart de la nouvelle position. */
  public syncToTime(time: number) {
    if (!this.isPlaying) return;
    this.start(time);
  }

  private stopScheduler() {
    if (this.schedulerTimer !== null) { clearTimeout(this.schedulerTimer); this.schedulerTimer = null; }
  }

  private startScheduler() {
    const tick = () => {
      if (!this.ctx || !this.isPlaying) return;
      this.scheduleWindow(this.ctx.currentTime + this.scheduleAheadTime);
      this.schedulerTimer = window.setTimeout(tick, this.lookaheadMs);
    };
    tick();
  }

  /** Programme les clics jusqu'à `horizon` (temps du contexte). */
  private scheduleWindow(horizon: number) {
    if (!this.ctx) return;
    const from = this.scheduledUntil;
    if (horizon <= from) return;
    const c = this.clock?.() ?? null;
    if (c && !c.playing) { this.scheduledUntil = horizon; return; }
    // Morceaux d'horloge : avant / après un bouclage déjà programmé par le moteur.
    const parts: { a: number; b: number; start: number }[] = [];
    if (!c) parts.push({ a: from, b: horizon, start: this.freeStart });
    else if (c.wrap && c.wrap.at > from) {
      parts.push({ a: from, b: Math.min(horizon, c.wrap.at), start: c.wrap.prevStart });
      if (horizon > c.wrap.at) parts.push({ a: c.wrap.at, b: horizon, start: c.startTime });
    } else parts.push({ a: from, b: horizon, start: c.startTime });
    for (const p of parts) {
      let pa = p.a - p.start, pb = p.b - p.start;
      // Boucle active : jamais de clic au-delà de la fin (le moteur n'a pas encore programmé le retour).
      if (c?.loop && c.loop.end > c.loop.start && pa < c.loop.end + 1e-6) pb = Math.min(pb, c.loop.end - 1e-6);
      if (pb <= pa) continue;
      for (const b of beatsInRange(this.map, Math.max(0, pa), pb)) {
        const at = p.start + b.time;
        if (at < from - 1e-6 || at < this.ctx.currentTime - 0.05) continue;
        this.playClick(at, b.downbeat && this.settings.accentDownbeat, b.time);
      }
    }
    this.scheduledUntil = horizon;
  }

  /** Programme le décompte ; renvoie l'instant (contexte) de sa fin et de quoi l'annuler. */
  public scheduleCountIn(plan: CountInPlan, lead = 0.06): { startsAt: number; endsAt: number; cancel: () => void } {
    if (!this.ctx || !plan.clicks.length) {
      const t = this.ctx?.currentTime ?? 0;
      return { startsAt: t, endsAt: t, cancel: () => {} };
    }
    const t0 = this.ctx.currentTime + lead;
    const nodes: AudioScheduledSourceNode[] = [];
    for (const c of plan.clicks) nodes.push(...this.playClick(t0 + c.at, c.accent));
    return {
      startsAt: t0,
      endsAt: t0 + plan.duration,
      cancel: () => { const now = this.ctx?.currentTime ?? 0; nodes.forEach(n => { try { n.stop(now); } catch { /* fini */ } }); },
    };
  }

  /** Un clic au son réglé ; renvoie les sources programmées. */
  public playClick(time: number, accent: boolean, projectTime?: number): AudioScheduledSourceNode[] {
    if (!this.ctx || !this.outputGain) return [];
    if (this.lastScheduled.length > 512) this.lastScheduled = this.lastScheduled.slice(-256);
    this.lastScheduled.push({ at: time, accent, projectTime });
    const level = accent ? 1 : Math.max(0.15, 1 - (this.settings.accentLevel ?? 0.6) * 0.6);
    let nodes: AudioScheduledSourceNode[];
    switch (this.settings.sound) {
      case 'WOODBLOCK': nodes = this.woodblock(time, accent, level); break;
      case 'BEEP': nodes = this.tone(time, accent ? 1200 : 960, level * 0.45, 'square', 0.015); break;
      case 'COWBELL': nodes = this.cowbell(time, accent, level); break;
      case 'STICK': nodes = this.stick(time, accent, level); break;
      default: nodes = this.tone(time, accent ? 1500 : 1000, level, 'sine', 0.02);
    }
    nodes.forEach(n => { this.live.add(n); n.onended = () => this.live.delete(n); });
    return nodes;
  }

  private env(time: number, peak: number, dur: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(peak, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0008, time + dur);
    g.connect(this.outputGain!);
    return g;
  }

  private tone(time: number, freq: number, peak: number, type: OscillatorType, dur: number): AudioScheduledSourceNode[] {
    const osc = this.ctx!.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(this.env(time, peak, dur));
    osc.start(time);
    osc.stop(time + dur + 0.01);
    return [osc];
  }

  private noise(time: number, dur: number): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buffer.getChannelData(0);
    let s = 0x2545f491;
    for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; d[i] = (s / 2147483648 - 1) * Math.exp(-i / (n * 0.15)); }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.start(time);
    return src;
  }

  private woodblock(time: number, accent: boolean, level: number): AudioScheduledSourceNode[] {
    const src = this.noise(time, 0.04);
    const f = this.ctx!.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = accent ? 2500 : 2000; f.Q.value = 15;
    src.connect(f); f.connect(this.env(time, level * 2.2, 0.05));
    return [src];
  }

  private stick(time: number, accent: boolean, level: number): AudioScheduledSourceNode[] {
    const src = this.noise(time, 0.03);
    const f = this.ctx!.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = accent ? 5000 : 7000;
    src.connect(f); f.connect(this.env(time, level * 0.9, 0.03));
    return [src];
  }

  private cowbell(time: number, accent: boolean, level: number): AudioScheduledSourceNode[] {
    const ctx = this.ctx!;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = accent ? 900 : 800; f.Q.value = 3;
    f.connect(this.env(time, level * 0.5, 0.12));
    return [540, 800].map(fr => {
      const o = ctx.createOscillator();
      o.type = 'square'; o.frequency.value = accent ? fr * 1.12 : fr;
      o.connect(f); o.start(time); o.stop(time + 0.14);
      return o;
    });
  }

  /** Un clic d'essai (fenêtre du métronome, tap tempo). */
  public playPreviewClick(accent = true) {
    if (!this.ctx) return;
    this.playClick(this.ctx.currentTime + 0.01, accent);
  }

  public isEnabled(): boolean { return this.settings.enabled; }
  public isRunning(): boolean { return this.isPlaying; }
}

export const metronomeService = MetronomeService.getInstance();
