/**
 * R13 · Lecture ralentie (Pro Tools : Half-Speed Playback, Maj+Espace ·
 * Logic : Varispeed « vitesse seulement » · Ableton : tempo baissé avec Warp ·
 * FL : tempo du projet baissé) : écouter de 50 à 100 % de la vitesse SANS
 * changer la hauteur, pour travailler un passage rapide ou apprendre un texte.
 *
 * C'est un réglage d'écoute (comme le volume du casque) : il ne va ni dans le
 * projet, ni en collaboration, et l'export n'est JAMAIS ralenti. Le moteur
 * (engine/AudioEngine : lecture d'entraînement) rend le mix par morceaux,
 * l'étire hors ligne (vocodeur de phase) et le joue ; la tête de lecture
 * avance à la même vitesse.
 */
import { useSyncExternalStore } from 'react';

export const PRACTICE_MIN = 0.5;
export const PRACTICE_MAX = 1;
export const PRACTICE_PRESETS = [0.5, 0.6, 0.75, 0.85, 1];

const KEY = 'nova_practice_speed';
type Listener = () => void;

export const clampPractice = (v: number): number => {
  if (!Number.isFinite(v)) return 1;
  return Math.max(PRACTICE_MIN, Math.min(PRACTICE_MAX, Math.round(v * 100) / 100));
};

const read = (): number => {
  try { const v = Number(localStorage.getItem(KEY)); return v ? clampPractice(v) : 1; } catch { return 1; }
};

let speed = read();
const listeners = new Set<Listener>();

export const practiceSpeedStore = {
  get: (): number => speed,
  set(v: number) {
    const next = clampPractice(v);
    if (next === speed) return;
    speed = next;
    try { localStorage.setItem(KEY, String(speed)); } catch { /* stockage indisponible */ }
    listeners.forEach(l => l());
  },
  subscribe(l: Listener): () => void { listeners.add(l); return () => { listeners.delete(l); }; },
};

export function usePracticeSpeed(): number {
  return useSyncExternalStore(practiceSpeedStore.subscribe, practiceSpeedStore.get, practiceSpeedStore.get);
}

/** « 75 % » */
export const practiceLabel = (v: number): string => `${Math.round(v * 100)} %`;

/** Préréglage suivant (bouton du téléphone : 100 → 85 → 75 → 60 → 50 → 100). */
export const nextPreset = (v: number): number => {
  const down = [...PRACTICE_PRESETS].sort((a, b) => b - a);
  const i = down.findIndex(p => p < v - 1e-6);
  return i < 0 ? 1 : down[i];
};
