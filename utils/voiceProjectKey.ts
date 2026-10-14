/**
 * Tonalité du projet pour Nova Tune quand une chaîne voix est posée depuis la console
 * (One Knob, presets voix) : la tranche ne reçoit pas l'état du projet. App.tsx déclare
 * un lecteur ; sans lui, Nova Tune corrige en chromatique.
 */
let reader: (() => { key: number | null; scale: string | null }) | null = null;

export const setProjectKeyReader = (fn: typeof reader) => { reader = fn; };

export function projectKey(): { key: number | null; scale: string | null } {
  try { return reader ? reader() : { key: null, scale: null }; } catch { return { key: null, scale: null }; }
}
