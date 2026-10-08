import type { AutomationPoint, Track } from '../types';
import {
  AUTOMATCH_SEC, AutomationMode, ParamSpec, Sample, WriteKind,
  automationModeOf, commitSegment, findLane, isFaderParam, isWriteMode,
  paramSpec, parsePluginParam, pluginParamName, sendParamName, sortedPoints,
  staticParamValue, trimValue, valueAtPoints, widenSpec,
} from '../utils/automationWrite';

/**
 * ÉCRITURE D'AUTOMATION (modes Touch / Latch / Write / Trim façon Pro Tools)
 * -------------------------------------------------------------------------
 * Ce module était du code mort (un registre de potards jamais relié aux voies
 * des pistes). Il pilote maintenant l'écriture réelle :
 *
 * - les faders, potards et effets signalent `touch` / `change` / `release` ;
 * - pendant la lecture, sur une piste en Touch, Latch, Write ou Trim, la valeur
 *   entendue est échantillonnée, imposée au moteur (`setOverride`) puis, à la
 *   fin du passage, fusionnée dans `track.automationLanes` (points simplifiés) ;
 * - une seule étape d'annulation par passe (`beginUndoStep`).
 *
 * Le module ne dépend ni de React ni du moteur audio : l'hôte (hooks/
 * useAutomationWrite) les branche. Les tests l'utilisent avec un hôte factice.
 */

export { interpolateCurve } from '../utils/automationWrite';
export type { AutomationMode } from '../utils/automationWrite';

export interface AutomationCommit {
  trackId: string;
  param: string;
  points: AutomationPoint[];
  spec: ParamSpec;
  /** Valeur du fader à la fin du passage (il reste là où on l'entend). */
  staticValue: number | null;
}

export interface AutomationHost {
  getTracks(): Track[];
  /** Temps du projet (s). */
  getTime(): number;
  isPlaying(): boolean;
  /** Valeur imposée pendant l'écriture ; null rend la main à l'automation (nouveaux points fournis). */
  setOverride(trackId: string, param: string, value: number | null, points?: AutomationPoint[]): void;
  /** Avant la 1re écriture d'une passe : une seule étape d'annulation par passe. */
  beginUndoStep(): void;
  commit(c: AutomationCommit): void;
  /** Après une passe Write, la piste repasse en Touch (préférence par défaut de Pro Tools). */
  setTrackMode(trackId: string, mode: AutomationMode): void;
  /** Horloge murale (ms), pour relâcher un réglage fait à la molette. */
  wallClock?(): number;
}

interface ActiveWrite {
  key: string;
  trackId: string;
  param: string;
  kind: WriteKind;
  start: number;
  lastTime: number;
  lastSampleTime: number;
  samples: Sample[];
  /** Position du fader. */
  ctrl: number;
  touched: boolean;
  /** Touché par un changement de valeur (molette, groupe, effet) plutôt que par un appui. */
  implicit: boolean;
  lastChangeWall: number;
  trimRef: number;
  orig: AutomationPoint[];
  baseline: number;
  spec: ParamSpec;
}

/** Réglage à la molette / au clavier : relâché après ce délai sans mouvement. */
const IMPLICIT_RELEASE_MS = 700;
/** Échantillons plus rapprochés que ça : on garde le dernier (≈ une demi-image). */
const SAMPLE_INTERVAL = 0.008;

export const automationKey = (trackId: string, param: string) => `${trackId}|${param}`;

export class AutomationRecorder {
  private host: AutomationHost | null = null;
  private active = new Map<string, ActiveWrite>();
  private undoTaken = false;
  private writePassTracks = new Set<string>();
  private pointerDown = false;
  /** Points déjà écrits mais pas encore revenus de l'état React (passes rapprochées). */
  private written = new Map<string, { points: AutomationPoint[]; staleRef: AutomationPoint[] | undefined }>();
  private counter = 0;
  private listeners = new Set<() => void>();
  private version = 0;

  configure(host: AutomationHost | null) { this.host = host; }

  /** Abonnement de l'interface : un passage commence ou se termine. */
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  getVersion() { return this.version; }
  private emit() { this.version++; this.listeners.forEach(fn => { try { fn(); } catch { /* */ } }); }

  // --- Lecture de l'état -------------------------------------------------------------

  private track(trackId: string): Track | undefined {
    return this.host?.getTracks().find(t => t.id === trackId);
  }

  private wall(): number {
    return this.host?.wallClock ? this.host.wallClock() : Date.now();
  }

  private lanePoints(track: Track, param: string): AutomationPoint[] {
    const host = findLane(track, param)?.points;
    const w = this.written.get(automationKey(track.id, param));
    if (w && w.staleRef === host) return w.points;
    if (w) this.written.delete(automationKey(track.id, param));
    return sortedPoints(host);
  }

  /** Valeur entendue d'un paramètre à un instant (automation rejouée, sinon réglage). */
  displayedValue(track: Track, param: string, time: number): number {
    const stat = staticParamValue(track, param) ?? (param === 'volume' ? 1 : 0);
    if (automationModeOf(track) === 'off') return stat;
    return valueAtPoints(this.lanePoints(track, param), time, stat);
  }

  isCapturing(trackId: string, param?: string): boolean {
    if (param) return this.active.has(automationKey(trackId, param));
    for (const a of this.active.values()) if (a.trackId === trackId) return true;
    return false;
  }

  /** Valeur imposée en ce moment (null si ce paramètre n'est pas en écriture). */
  activeOutput(trackId: string, param: string): number | null {
    const a = this.active.get(automationKey(trackId, param));
    return a ? this.output(a, a.lastTime) : null;
  }

  activeKeys(): { trackId: string; param: string }[] {
    return [...this.active.values()].map(a => ({ trackId: a.trackId, param: a.param }));
  }

  // --- Gestes ---------------------------------------------------------------------

  setPointerDown(down: boolean) { this.pointerDown = down; }

  /** Appui sur un fader / potard. */
  touch(trackId: string, param: string) {
    const ctx = this.writable(trackId, param);
    if (!ctx) return;
    const a = this.active.get(automationKey(trackId, param));
    if (a) { a.touched = true; a.implicit = false; a.lastChangeWall = this.wall(); return; }
    this.begin(ctx.track, param, ctx.kind, ctx.now, true, false);
  }

  /**
   * Nouvelle valeur d'un fader. Renvoie true si elle est écrite (l'appelant
   * met alors l'état à jour sans créer d'étape d'annulation).
   */
  change(trackId: string, param: string, value: number, before?: number): boolean {
    if (!Number.isFinite(value)) return false;
    const ctx = this.writable(trackId, param);
    if (!ctx) return false;
    let a = this.active.get(automationKey(trackId, param));
    if (!a) a = this.begin(ctx.track, param, ctx.kind, ctx.now, true, true, before);
    if (!a.touched) { a.touched = true; a.implicit = !this.pointerDown; }
    a.ctrl = value;
    a.lastChangeWall = this.wall();
    if (a.kind !== 'trim' && parsePluginParam(param)) a.spec = widenSpec(a.spec, [value]);
    this.sample(a, Math.max(ctx.now, a.lastTime), true);
    return true;
  }

  /** Relâchement : Touch et Trim reviennent à la courbe ; Latch et Write gardent la valeur. */
  release(trackId: string, param: string) {
    const a = this.active.get(automationKey(trackId, param));
    if (!a) return;
    if (a.kind === 'touch' || a.kind === 'trim') {
      const now = this.host?.isPlaying() ? this.host.getTime() : a.lastTime;
      if (now >= a.lastTime - 0.05) this.sample(a, Math.max(now, a.lastTime), false);
      this.finish(a, Math.max(a.lastTime, a.start));
    } else {
      a.touched = false;
      a.implicit = false;
    }
  }

  /** Fin d'un appui quelque part dans la page : relâche les réglages « implicites ». */
  releaseImplicit() {
    for (const a of [...this.active.values()]) if (a.touched && a.implicit) this.release(a.trackId, a.param);
  }

  // --- Transport ---------------------------------------------------------------------

  onPlay() {
    const host = this.host;
    if (!host) return;
    this.undoTaken = false;
    this.writePassTracks.clear();
    const now = host.getTime();
    // Write : tout le passage lu est écrasé, même sans toucher le fader.
    for (const track of host.getTracks()) {
      if (automationModeOf(track) !== 'write') continue;
      const params = new Set<string>(['volume']);
      (track.automationLanes || []).forEach(l => { if (l.points?.length && isFaderParam(l.parameterName)) params.add(l.parameterName); });
      params.forEach(p => { if (!this.active.has(automationKey(track.id, p))) this.begin(track, p, 'write', now, false, false); });
      this.writePassTracks.add(track.id);
    }
  }

  onStop(time?: number) {
    for (const a of [...this.active.values()]) {
      const end = typeof time === 'number' && time >= a.start && time <= a.lastTime + 0.25 ? time : a.lastTime;
      if (end > a.lastTime) this.sample(a, end, false);
      this.finish(a, Math.max(a.start, end));
    }
    this.writePassTracks.forEach(id => this.host?.setTrackMode(id, 'touch'));
    this.writePassTracks.clear();
    this.undoTaken = false;
  }

  /** Appelé à chaque image pendant la lecture. */
  tick() {
    const host = this.host;
    if (!host || !host.isPlaying() || this.active.size === 0) return;
    const now = host.getTime();
    const wall = this.wall();
    for (const a of [...this.active.values()]) {
      // Bouclage ou saut : le passage se termine où on était, un autre commence.
      if (now < a.lastTime - 0.05 || now > a.lastTime + 1) {
        const { kind, touched, implicit, ctrl, trackId, param } = a;
        this.finish(a, a.lastTime);
        const track = this.track(trackId);
        if (track && (touched || kind === 'latch' || kind === 'write')) {
          const b = this.begin(track, param, kind, now, touched, implicit);
          if (kind !== 'trim') { b.ctrl = ctrl; b.samples = [{ time: now, value: ctrl }]; host.setOverride(trackId, param, ctrl); }
        }
        continue;
      }
      if (a.touched && a.implicit && !this.pointerDown && wall - a.lastChangeWall > IMPLICIT_RELEASE_MS) {
        this.release(a.trackId, a.param);
        continue;
      }
      if (a.touched || a.kind === 'latch' || a.kind === 'write') this.sample(a, now, a.kind === 'trim');
      else a.lastTime = Math.max(a.lastTime, now);
    }
  }

  /** Changement de mode : les passages en cours se terminent proprement. */
  stopTrack(trackId: string) {
    for (const a of [...this.active.values()]) if (a.trackId === trackId) this.finish(a, a.lastTime);
    this.writePassTracks.delete(trackId);
  }

  // --- Captures depuis l'état de l'application --------------------------------------

  /**
   * Mise à jour d'une piste venant d'un fader (volume, pan, envois). Renvoie
   * true si TOUT le changement est de l'automation écrite : l'appelant le
   * range alors sans nouvelle étape d'annulation (une seule par passe).
   */
  captureTrackUpdate(prev: Track, next: Track): boolean {
    if (!this.host?.isPlaying() || prev.id !== next.id) return false;
    if (!isWriteMode(automationModeOf(next))) return false;
    const changes: [string, number][] = [];
    if (prev.volume !== next.volume) changes.push(['volume', next.volume]);
    if (prev.pan !== next.pan) changes.push(['pan', next.pan]);
    if (prev.sends !== next.sends) {
      const a = prev.sends || [], b = next.sends || [];
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i].id !== b[i].id || a[i].isEnabled !== b[i].isEnabled) return false;
        if (a[i].level !== b[i].level) changes.push([sendParamName(b[i].id), b[i].level]);
      }
    }
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const k of keys) {
      if (k === 'volume' || k === 'pan' || k === 'sends') continue;
      if ((prev as any)[k] !== (next as any)[k]) return false;
    }
    if (!changes.length) return false;
    let all = true;
    for (const [p, v] of changes) all = this.change(next.id, p, v) && all;
    return all;
  }

  /** La piste écrit-elle de l'automation en ce moment (lecture + Touch / Latch / Write / Trim) ? */
  canWrite(trackId: string): boolean {
    if (!this.host?.isPlaying()) return false;
    const track = this.track(trackId);
    return !!track && isWriteMode(automationModeOf(track));
  }

  /**
   * Réglage d'un effet depuis sa fenêtre : effet natif, ou VST3 (R9 : réglage bougé
   * dans la fenêtre du plugin, signalé par le pont ; valeur brute 0–1, sans valeur
   * fixe connue dans le projet).
   */
  capturePluginParams(trackId: string, pluginId: string, params: Record<string, any>, before?: Record<string, number>): boolean {
    if (!this.host?.isPlaying()) return false;
    const track = this.track(trackId);
    if (!track || !isWriteMode(automationModeOf(track))) return false;
    const plugin = (track.plugins || []).find(p => p.id === pluginId);
    if (!plugin) return false;
    const vst = plugin.type === 'VST3';
    const stat = plugin.params || {};
    let any = false, all = true;
    for (const [k, v] of Object.entries(params || {})) {
      if (stat[k] === v) continue;
      if (typeof v !== 'number' || (!vst && typeof stat[k] !== 'number')) { all = false; continue; }
      any = true;
      // VST : la valeur d'avant le geste (relevée par le pont) sert de référence hors du passage.
      all = this.change(trackId, pluginParamName(pluginId, k), v, before?.[k]) && all;
    }
    return any && all;
  }

  // --- Interne -----------------------------------------------------------------------

  private writable(trackId: string, param: string): { track: Track; kind: WriteKind; now: number } | null {
    const host = this.host;
    if (!host || !host.isPlaying() || !isFaderParam(param)) return null;
    const track = this.track(trackId);
    if (!track) return null;
    const mode = automationModeOf(track);
    if (!isWriteMode(mode)) return null;
    return { track, kind: mode as WriteKind, now: host.getTime() };
  }

  private begin(track: Track, param: string, kind: WriteKind, now: number, touched: boolean, implicit: boolean, hint?: number): ActiveWrite {
    const host = this.host!;
    if (!this.undoTaken) { host.beginUndoStep(); this.undoTaken = true; }
    const orig = this.lanePoints(track, param);
    const stat = staticParamValue(track, param) ?? (typeof hint === 'number' && Number.isFinite(hint) ? hint : null);
    const baseline = stat ?? (param === 'volume' ? 1 : 0);
    const shown = valueAtPoints(orig, now, baseline);
    const lane = findLane(track, param);
    const pp = parsePluginParam(param);
    // Réglage VST (R9) : valeur brute du plugin, toujours 0–1.
    const vst = !!pp && (track.plugins || []).find(x => x.id === pp.pluginId)?.type === 'VST3';
    let spec = vst ? { min: 0, max: 1, kind: 'linear' as const } : paramSpec(param, shown);
    if (lane && parsePluginParam(param)) spec = widenSpec({ ...spec, min: lane.min, max: lane.max }, [shown]);
    const a: ActiveWrite = {
      key: automationKey(track.id, param), trackId: track.id, param, kind,
      start: now, lastTime: now, lastSampleTime: now,
      samples: [{ time: now, value: shown }],
      ctrl: shown, touched, implicit, lastChangeWall: this.wall(), trimRef: shown,
      orig, baseline, spec,
    };
    this.active.set(a.key, a);
    host.setOverride(track.id, param, shown);
    this.emit();
    return a;
  }

  private output(a: ActiveWrite, t: number): number {
    if (a.kind === 'trim') return trimValue(a.spec, valueAtPoints(a.orig, t, a.baseline), a.ctrl, a.trimRef);
    return a.ctrl;
  }

  private sample(a: ActiveWrite, t: number, pushOverride: boolean) {
    const v = a.kind === 'trim' ? a.ctrl : this.output(a, t);
    const last = a.samples[a.samples.length - 1];
    if (last && t - last.time < SAMPLE_INTERVAL && Math.abs(t - last.time) < 1) {
      // Échantillons trop rapprochés : on garde la dernière valeur à la date la plus récente.
      if (t >= last.time) a.samples[a.samples.length - 1] = { time: t, value: v };
    } else if (!last || t > last.time) {
      a.samples.push({ time: t, value: v });
    }
    a.lastTime = Math.max(a.lastTime, t);
    a.lastSampleTime = t;
    if (pushOverride) this.host?.setOverride(a.trackId, a.param, this.output(a, t));
  }

  private finish(a: ActiveWrite, end: number) {
    const host = this.host;
    this.active.delete(a.key);
    this.emit();
    if (!host) return;
    const points = commitSegment(a.orig, {
      kind: a.kind, start: a.start, end: Math.max(a.start, end), samples: a.samples, trimRef: a.trimRef,
    }, { spec: a.spec, baseline: a.baseline, idPrefix: `aw${(++this.counter).toString(36)}${Date.now().toString(36)}` });
    const track = this.track(a.trackId);
    const staleRef = track ? findLane(track, a.param)?.points : undefined;
    this.written.set(a.key, { points, staleRef });
    const spec = parsePluginParam(a.param) ? widenSpec(a.spec, points.map(p => p.value)) : a.spec;
    host.commit({
      trackId: a.trackId, param: a.param, points, spec,
      // Réglage de la piste = ce que la courbe rejoue après le passage (retour AutoMatch compris) :
      // effacer l'automation plus tard ne laisse pas le fader coincé sur la valeur du geste.
      staticValue: valueAtPoints(points, Math.max(a.start, end) + AUTOMATCH_SEC + 0.001, a.baseline),
    });
    host.setOverride(a.trackId, a.param, null, points);
  }
}

export const automationRecorder = new AutomationRecorder();
