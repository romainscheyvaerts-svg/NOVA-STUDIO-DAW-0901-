import { Clip } from '../types';

/**
 * Édition des clips en français (audit G7 / G8).
 * - Bulle de glissement : « Fondu d'entrée · 0,25 s », « Déplacer · mes. 5.2 »
 *   au lieu de « 1.234s [FADE_IN] ».
 * - Fondus prédéfinis du menu du clip : 10 ms, 50 ms, 1 temps.
 */
export const DRAG_LABELS: Record<string, string> = {
  MOVE: 'Déplacer', TRIM_START: 'Rogner le début', TRIM_END: 'Rogner la fin',
  FADE_IN: "Fondu d'entrée", FADE_OUT: 'Fondu de sortie', GAIN: 'Gain',
  XFADE: 'Fondu enchaîné', RANGE: 'Sélection', SCRUB: 'Lecture',
};

/** Durée courte lisible : « 50 ms », « 0,25 s », « 2,5 s ». */
export function secFr(s: number): string {
  const v = Math.max(0, s);
  if (v < 0.1) return `${Math.round(v * 1000)} ms`;
  return `${(v < 10 ? v.toFixed(2) : v.toFixed(1)).replace('.', ',')} s`;
}

/** Position en mesure.temps (comme la règle) : 0 s à 120 BPM → « 1.1 ». */
export function barsBeats(sec: number, bpm: number, beatsPerBar = 4): string {
  const beat = 60 / Math.max(1, bpm);
  const totalBeats = Math.max(0, sec) / beat + 1e-6;
  const bar = Math.floor(totalBeats / beatsPerBar) + 1;
  const b = Math.floor(totalBeats % beatsPerBar) + 1;
  return `${bar}.${b}`;
}

/** Texte de la bulle pendant un glissement sur un clip. */
export function dragTipText(action: string | null, clip: Pick<Clip, 'start' | 'duration' | 'fadeIn' | 'fadeOut'> | null | undefined, bpm: number, beatsPerBar = 4): string | null {
  if (!action || !clip) return null;
  const label = DRAG_LABELS[action] || action;
  switch (action) {
    case 'MOVE':
    case 'TRIM_START': return `${label} · mes. ${barsBeats(clip.start, bpm, beatsPerBar)}`;
    case 'TRIM_END': return `${label} · mes. ${barsBeats(clip.start + clip.duration, bpm, beatsPerBar)} (durée ${secFr(clip.duration)})`;
    case 'FADE_IN': return `${label} · ${secFr(clip.fadeIn || 0)}`;
    case 'FADE_OUT': return `${label} · ${secFr(clip.fadeOut || 0)}`;
    default: return null;
  }
}

export type FadePreset = '10ms' | '50ms' | 'beat';
export const FADE_PRESETS: { id: FadePreset; label: string }[] = [
  { id: '10ms', label: '10 ms' }, { id: '50ms', label: '50 ms' }, { id: 'beat', label: '1 temps' },
];

export const fadePresetSeconds = (p: FadePreset, bpm: number) =>
  p === '10ms' ? 0.01 : p === '50ms' ? 0.05 : 60 / Math.max(1, bpm);

/** Nouveau fondu borné : jamais plus long que ce que laisse l'autre fondu. */
export function fadeWithPreset(clip: Pick<Clip, 'duration' | 'fadeIn' | 'fadeOut'>, which: 'in' | 'out', p: FadePreset, bpm: number): Partial<Clip> {
  const want = fadePresetSeconds(p, bpm);
  const other = which === 'in' ? (clip.fadeOut || 0) : (clip.fadeIn || 0);
  const v = Math.max(0, Math.min(want, clip.duration - other));
  return which === 'in' ? { fadeIn: v } : { fadeOut: v };
}
