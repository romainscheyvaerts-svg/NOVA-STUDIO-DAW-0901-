/**
 * Ouverture des fenêtres « façon Pro Tools » (repères, Strip Silence,
 * renommer / couleur, raccourcis) depuis n'importe quel composant, sans faire
 * descendre de nouvelles props dans l'arrangement : un simple événement que
 * components/ProToolsWindows écoute.
 */
export type NovaWindowName = 'memory-locations' | 'strip-silence' | 'clip-props' | 'track-color' | 'shortcuts' | 'pitch-editor' | 'pitch-batch' | 'audio-to-midi' | 'ara-melodyne' | 'ara-vocalign'
  // R4 / R6 : Track Presets, Commit / Consolider avec effets, AudioSuite, impression de bus.
  | 'track-preset' | 'bounce' | 'audiosuite' | 'print-bus';

export interface NovaWindowDetail {
  name: NovaWindowName;
  /** Clips visés (Strip Silence, renommer / couleur, justesse note par note). */
  targets?: { trackId: string; clipId: string }[];
  trackId?: string;
  /** Champ mis en avant à l'ouverture. */
  focus?: 'name' | 'color';
  /** Audio → MIDI (V20) : mélodie, batterie ou harmonie ; micro ; instrument ; version simple. */
  convert?: { mode: 'melody' | 'drums' | 'harmony'; mic?: boolean; instrument?: '808' | 'piano' | 'lead' | 'pad'; simple?: boolean };
  /** Commit / Consolider (R6) : piste entière (commit) ou plage (bounce). */
  bounce?: { mode: 'commit' | 'range'; trackIds?: string[]; start?: number; end?: number };
  /** AudioSuite (R6) : plage de la sélection (sinon les clips visés). */
  range?: { start: number; end: number; trackIds: string[] };
}

export const NOVA_WINDOW_EVENT = 'nova:open-window';

export const openNovaWindow = (name: NovaWindowName, detail: Omit<NovaWindowDetail, 'name'> = {}) => {
  try { window.dispatchEvent(new CustomEvent<NovaWindowDetail>(NOVA_WINDOW_EVENT, { detail: { name, ...detail } })); } catch { /* hors navigateur */ }
};
