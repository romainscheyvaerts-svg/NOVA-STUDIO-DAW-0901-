import type { Track } from '../types';

/**
 * Pilote du scrub et du shuttle pour l'interface (R17).
 *
 * L'arrangement (Scrubber F9, Ctrl+glisser, doigt), les raccourcis (shuttle
 * Alt+J / K / L, Shuttle Lock, scrub au clavier) passent par ici ; App y branche
 * le moteur et la validation de la position (handleSeek) au relâchement.
 */
export interface ScrubEngine {
  scrub(tracks: Track[], time: number): void;
  shuttle(tracks: Track[], speed: number, from?: number): void;
  stopScrubbing(): void;
  getScrubPosition(): number;
  getIsPlaying(): boolean;
}

interface Deps {
  engine: ScrubEngine;
  getTracks: () => Track[];
  /** Position validée (état du projet) au relâchement. */
  commit: (t: number) => void;
  /** Arrête la lecture (le scrub prend la main, comme dans Pro Tools). */
  stopPlayback: () => void;
  getTime: () => number;
}

let deps: Deps | null = null;
let dragging = false;
/** Vitesse du shuttle au clavier : palier courant (× temps réel, signé). */
let shuttleSpeed = 0;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());

export const SHUTTLE_STEPS = [1, 2, 4, 8];
/** Shuttle Lock de Pro Tools : 1 = minimum, 5 = temps réel, 9 = maximum. */
export const SHUTTLE_LOCK_SPEEDS = [0, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 3, 4, 8];

const prepare = (): Deps | null => {
  if (!deps) return null;
  if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
  if (deps.engine.getIsPlaying()) deps.stopPlayback();
  // Un scrub resté actif sans geste en cours (relâché hors de la fenêtre…) : on l'arrête.
  if (!dragging && shuttleSpeed === 0) deps.engine.stopScrubbing();
  return deps;
};

export const scrubControl = {
  configure(d: Deps) { deps = d; },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  get dragging() { return dragging; },
  get shuttleSpeed() { return shuttleSpeed; },

  /** Début d'un geste de scrub (souris ou doigt) à `time`. */
  begin(time: number) {
    const d = prepare(); if (!d) return;
    dragging = true; shuttleSpeed = 0;
    d.engine.scrub(d.getTracks(), Math.max(0, time));
    emit();
  },
  move(time: number) {
    if (!deps || !dragging) return;
    deps.engine.scrub(deps.getTracks(), Math.max(0, time));
  },
  /** Fin du geste : la tête de lecture reste où le son s'est arrêté. */
  end() {
    if (!deps || !dragging) return;
    dragging = false;
    const d = deps;
    // Laisse la position rattraper la souris (lissage ~ 150 ms) avant de valider.
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      const t = d.engine.getScrubPosition();
      d.engine.stopScrubbing();
      d.commit(t);
      emit();
    }, 160);
  },

  /** Simple appui (sans glisser) : la position est validée tout de suite. */
  endAt(time: number) {
    if (!deps) return;
    dragging = false;
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
    deps.engine.stopScrubbing();
    deps.commit(Math.max(0, time));
    emit();
  },

  /** Shuttle au clavier : chaque appui dans le même sens accélère (×1, ×2, ×4, ×8). */
  shuttleStep(dir: 1 | -1): number {
    const d = prepare(); if (!d) return 0;
    const cur = Math.abs(shuttleSpeed);
    const sameDir = Math.sign(shuttleSpeed) === dir;
    const next = sameDir ? (SHUTTLE_STEPS.find(s => s > cur) ?? SHUTTLE_STEPS[SHUTTLE_STEPS.length - 1]) : 1;
    shuttleSpeed = dir * next;
    d.engine.shuttle(d.getTracks(), shuttleSpeed, d.getTime());
    emit();
    return shuttleSpeed;
  },
  /** Shuttle Lock : vitesse 1–9, sens gardé (pavé − / + pour changer). */
  shuttleLock(level: number, dir?: 1 | -1): number {
    const d = prepare(); if (!d) return 0;
    const sign = dir ?? (shuttleSpeed < 0 ? -1 : 1);
    shuttleSpeed = sign * (SHUTTLE_LOCK_SPEEDS[Math.max(0, Math.min(9, level))] || 0);
    d.engine.shuttle(d.getTracks(), shuttleSpeed, d.getTime());
    emit();
    return shuttleSpeed;
  },
  /** Shuttle continu (souris : Alt + Scrubber) : vitesse signée, `from` au premier appel. */
  shuttleAt(speed: number, from?: number) {
    const d = from !== undefined ? prepare() : deps;
    if (!d) return;
    shuttleSpeed = speed;
    d.engine.shuttle(d.getTracks(), speed, from);
    emit();
  },
  /** Change de sens pendant le shuttle. */
  shuttleDirection(dir: 1 | -1) {
    if (!deps || !shuttleSpeed) return;
    shuttleSpeed = dir * Math.abs(shuttleSpeed);
    deps.engine.shuttle(deps.getTracks(), shuttleSpeed);
    emit();
  },
  get shuttling() { return shuttleSpeed !== 0; },
  /** Arrête le shuttle : la tête de lecture reste où elle est. */
  stopShuttle() {
    if (!deps) return;
    const was = shuttleSpeed !== 0;
    shuttleSpeed = 0;
    if (was) {
      const t = deps.engine.getScrubPosition();
      deps.engine.stopScrubbing();
      deps.commit(t);
    }
    emit();
  },
  /** Petit scrub au clavier : fait entendre `span` secondes autour de la tête, puis revient. */
  nudge(dir: 1 | -1, span = 0.25) {
    const d = prepare(); if (!d) return;
    const t0 = d.getTime();
    const t1 = Math.max(0, t0 + dir * span);
    d.engine.scrub(d.getTracks(), t0);
    d.engine.scrub(d.getTracks(), t1);
    releaseTimer = setTimeout(() => { releaseTimer = null; d.engine.stopScrubbing(); d.commit(t1); emit(); }, 260);
  },
};
