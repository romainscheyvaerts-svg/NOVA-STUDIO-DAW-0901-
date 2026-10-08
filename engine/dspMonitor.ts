/**
 * Surveillance de la charge audio (comme le compteur CPU / DSP de Pro Tools).
 *
 * Toutes les 500 ms :
 *  - sous-régimes du contexte audio : AudioContext.playbackStats (Chromium :
 *    underrunEvents / underrunDuration). Sans cette API (Safari, Firefox) :
 *    dérive de l'horloge audio par rapport à l'horloge murale (un rendu qui ne
 *    suit pas fait avancer currentTime moins vite que le temps réel) ;
 *  - retards du planificateur du moteur (fenêtre programmée alors que son début
 *    était déjà passé : sons qui partent en retard) ;
 *  - charge du fil principal (tâches longues : interface figée, planificateur en retard).
 *
 * Le niveau « surcharge » n'est CONFIRMÉ qu'après plusieurs fenêtres consécutives
 * pendant la lecture (le chargement d'une session ou l'ouverture d'une fenêtre
 * produisent des à-coups isolés, sans intérêt pour l'artiste).
 *
 * Module sans dépendance au moteur : il lit ses sources par `attach()` (testable).
 */

export type DspLevel = 'ok' | 'charge' | 'surcharge';

export interface DspState {
  /** Charge audio 0–100 (estimation + sous-régimes mesurés). */
  dsp: number;
  /** Charge du fil principal (interface) 0–100. */
  ui: number;
  level: DspLevel;
  /** Surcharge confirmée (plusieurs fenêtres d'affilée pendant la lecture). */
  confirmed: boolean;
  /** Sous-régimes (craquements) sur la dernière minute. */
  underrunsPerMin: number;
  /** Retards du planificateur sur la dernière minute. */
  lateEvents: number;
  /** Début du niveau actuel (ms, horloge de la page). */
  since: number;
  /** Source de la mesure audio. */
  source: 'playbackStats' | 'drift' | 'none';
  /** Charge estimée d'après les effets actifs (0–100+), si fournie. */
  estimated: number | null;
}

export interface DspSources {
  getContext: () => (BaseAudioContext & { playbackStats?: any; getOutputTimestamp?: () => AudioTimestamp }) | null;
  /** Lecture ou enregistrement en cours (la surcharge n'est confirmée qu'alors). */
  isActive: () => boolean;
  /** Retards cumulés du planificateur du moteur. */
  getLateTicks?: () => number;
  /** Charge estimée d'après la session (0–100+). */
  getEstimatedLoad?: () => number | null;
}

export interface DspMonitorOptions {
  now?: () => number;
  windowMs?: number;
  /** Fenêtres de surcharge d'affilée pour confirmer. */
  confirmWindows?: number;
  /** Fenêtres calmes d'affilée pour clore l'épisode. */
  clearWindows?: number;
  /** Surcharge qui dure : l'épisode est de nouveau signalé toutes les N ms (une piste de plus à geler). */
  repeatMs?: number;
  /** Abonnement aux tâches longues (durée en ms). Par défaut : PerformanceObserver. */
  observeLongTasks?: (cb: (ms: number) => void) => (() => void) | void;
  setInterval?: (fn: () => void, ms: number) => any;
  clearInterval?: (id: any) => void;
}

export type DspEpisodeEvent = { type: 'overload'; state: DspState } | { type: 'recovered'; state: DspState };

/** Fenêtre glissante (ms) pour juger la surcharge. */
const RECENT_MS = 1500;

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

export class DspMonitor {
  private sources: DspSources | null = null;
  private listeners = new Set<(s: DspState) => void>();
  private episodeListeners = new Set<(e: DspEpisodeEvent) => void>();
  private timer: any = null;
  private stopLongTasks: (() => void) | null = null;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly confirmWindows: number;
  private readonly clearWindows: number;
  private readonly repeatMs: number;
  private lastEpisodeAt = 0;
  private readonly opts: DspMonitorOptions;

  private last: { wall: number; ctxTime: number; events: number; durationS: number; late: number } | null = null;
  private longMs = 0;
  /** Historique des fenêtres (1 min) : [instant, sous-régimes, retards, part en sous-régime]. */
  private history: { at: number; underruns: number; late: number; lateDelta: number; ratio: number }[] = [];
  private overStreak = 0;
  private calmStreak = 0;
  private confirmed = false;
  private state: DspState;

  constructor(opts: DspMonitorOptions = {}) {
    this.opts = opts;
    this.now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.windowMs = opts.windowMs ?? 500;
    this.confirmWindows = opts.confirmWindows ?? 6;
    this.clearWindows = opts.clearWindows ?? 10;
    this.repeatMs = opts.repeatMs ?? 15_000;
    this.state = { dsp: 0, ui: 0, level: 'ok', confirmed: false, underrunsPerMin: 0, lateEvents: 0, since: this.now(), source: 'none', estimated: null };
  }

  /** Branche les sources (moteur) et démarre la surveillance. */
  attach(sources: DspSources) {
    this.sources = sources;
    this.last = null;
    if (!this.timer) {
      const si = this.opts.setInterval || ((fn: () => void, ms: number) => setInterval(fn, ms));
      this.timer = si(() => this.tick(), this.windowMs);
    }
    if (!this.stopLongTasks) {
      const obs = this.opts.observeLongTasks || defaultLongTasks;
      this.stopLongTasks = obs(ms => { this.longMs += ms; }) || (() => {});
    }
  }

  detach() {
    if (this.timer) (this.opts.clearInterval || clearInterval)(this.timer);
    this.timer = null;
    this.stopLongTasks?.();
    this.stopLongTasks = null;
    this.sources = null;
  }

  getState(): DspState { return this.state; }

  subscribe(cb: (s: DspState) => void): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => { this.listeners.delete(cb); };
  }

  /** Épisodes de surcharge confirmée (début / fin). */
  onEpisode(cb: (e: DspEpisodeEvent) => void): () => void {
    this.episodeListeners.add(cb);
    return () => { this.episodeListeners.delete(cb); };
  }

  /** Une mesure (appelée par le minuteur ; publique pour les tests). */
  tick() {
    const src = this.sources;
    const wall = this.now();
    const ctx = src?.getContext() || null;
    let underruns = 0, ratio = 0, source: DspState['source'] = 'none';
    const late = src?.getLateTicks?.() ?? 0;
    if (ctx && ctx.state === 'running') {
      const ps = (ctx as any).playbackStats;
      const events = ps ? Number(ps.underrunEvents) || 0 : 0;
      const durationS = ps ? Number(ps.underrunDuration) || 0 : 0;
      const ctxTime = ctx.currentTime;
      if (this.last) {
        const dWall = Math.max(1, wall - this.last.wall) / 1000;
        if (ps) {
          source = 'playbackStats';
          underruns = Math.max(0, events - this.last.events);
          ratio = clamp(Math.max(0, durationS - this.last.durationS) / dWall, 0, 1);
        } else {
          source = 'drift';
          const lost = dWall - Math.max(0, ctxTime - this.last.ctxTime);
          // Au-delà de 5 ms perdues sur la fenêtre : le rendu n'a pas suivi.
          if (lost > 0.005) { ratio = clamp(lost / dWall, 0, 1); underruns = Math.max(1, Math.round(lost / 0.01)); }
        }
      }
      this.last = { wall, ctxTime, events, durationS, late };
    } else {
      this.last = ctx ? { wall, ctxTime: ctx.currentTime, events: 0, durationS: 0, late } : null;
    }
    const prevLate = this.history.length ? this.history[this.history.length - 1].late : late;
    const lateDelta = Math.max(0, late - prevLate);
    this.history.push({ at: wall, underruns, late, lateDelta, ratio });
    while (this.history.length && wall - this.history[0].at > 60_000) this.history.shift();
    const lateWindowEvents = this.history.length > 1 ? Math.max(0, late - this.history[0].late) : 0;

    const ui = clamp(Math.round((this.longMs / this.windowMs) * 100));
    this.longMs = 0;
    // Fenêtre glissante de 1,5 s : les sous-régimes arrivent par salves, une fenêtre
    // de 500 ms isolée peut être calme au milieu d'une vraie surcharge.
    const recent = this.history.filter(h => wall - h.at < RECENT_MS);
    const recentRatio = recent.length ? recent.reduce((s, h) => s + h.ratio, 0) / recent.length : 0;
    const estimated = src?.getEstimatedLoad?.() ?? null;
    let dsp = estimated !== null ? Math.min(95, estimated) : 0;
    if (recentRatio > 0) dsp = Math.max(dsp, 85 + Math.min(15, recentRatio * 300));
    dsp = clamp(Math.round(dsp));

    const recentUnder = recent.reduce((s, h) => s + h.underruns, 0);
    const recentLate = recent.reduce((s, h) => s + h.lateDelta, 0);
    const overloaded = recentUnder >= 3 || recentRatio > 0.02 || recentLate > 0;
    const level: DspLevel = overloaded ? 'surcharge' : (dsp >= 70 || ui >= 60 || recentRatio > 0 ? 'charge' : 'ok');
    const active = !!src?.isActive();
    if (overloaded && active) { this.overStreak++; this.calmStreak = 0; }
    else { this.calmStreak++; if (!overloaded) this.overStreak = 0; }

    let event: DspEpisodeEvent['type'] | null = null;
    if (!this.confirmed && this.overStreak >= this.confirmWindows) { this.confirmed = true; event = 'overload'; }
    else if (this.confirmed && active && overloaded && wall - this.lastEpisodeAt >= this.repeatMs) event = 'overload';
    else if (this.confirmed && (this.calmStreak >= this.clearWindows || !active)) { this.confirmed = false; this.overStreak = 0; event = 'recovered'; }

    const underrunsPerMin = this.history.reduce((s, h) => s + h.underruns, 0);
    const since = level === this.state.level ? this.state.since : wall;
    this.state = { dsp, ui, level, confirmed: this.confirmed, underrunsPerMin, lateEvents: lateWindowEvents, since, source, estimated };
    this.listeners.forEach(cb => { try { cb(this.state); } catch { /* écouteur fautif */ } });
    if (event === 'overload') this.lastEpisodeAt = wall;
    if (event) {
      const e = { type: event, state: this.state } as DspEpisodeEvent;
      this.episodeListeners.forEach(cb => { try { cb(e); } catch { /* */ } });
    }
  }
}

function defaultLongTasks(cb: (ms: number) => void): (() => void) | void {
  if (typeof PerformanceObserver === 'undefined') return;
  const types: string[] = (PerformanceObserver as any).supportedEntryTypes || [];
  const type = types.includes('long-animation-frame') ? 'long-animation-frame' : types.includes('longtask') ? 'longtask' : null;
  if (!type) return;
  try {
    const obs = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        // long-animation-frame : seule la part bloquante (au-delà de 50 ms) compte.
        const blocking = (e as any).blockingDuration;
        cb(typeof blocking === 'number' ? blocking : Math.max(0, e.duration - 50));
      }
    });
    obs.observe({ type, buffered: false } as any);
    return () => obs.disconnect();
  } catch { return; }
}

/** Instance de l'appli (branchée au moteur par App). */
export const dspMonitor = new DspMonitor();

// --- Mode sécurité (mémorisé sur l'appareil) ----------------------------------

const SAFE_KEY = 'nova_safe_mode';
const safeListeners = new Set<() => void>();
let safeOn = (() => { try { return typeof localStorage !== 'undefined' && localStorage.getItem(SAFE_KEY) === '1'; } catch { return false; } })();

export const safeModeStore = {
  get: () => safeOn,
  set(on: boolean) {
    safeOn = on;
    try { localStorage.setItem(SAFE_KEY, on ? '1' : '0'); } catch { /* stockage indisponible */ }
    safeListeners.forEach(l => { try { l(); } catch { /* */ } });
  },
  subscribe(cb: () => void) { safeListeners.add(cb); return () => { safeListeners.delete(cb); }; },
};
