/**
 * Ouverture des fenêtres « façon Pro Tools » (repères, Strip Silence,
 * renommer / couleur, raccourcis) depuis n'importe quel composant, sans faire
 * descendre de nouvelles props dans l'arrangement : un simple événement que
 * components/ProToolsWindows écoute.
 */
export type NovaWindowName = 'memory-locations' | 'strip-silence' | 'clip-props' | 'track-color' | 'shortcuts' | 'pitch-editor' | 'pitch-batch' | 'audio-to-midi' | 'ara-melodyne' | 'ara-vocalign';

export interface NovaWindowDetail {
  name: NovaWindowName;
  /** Clips visés (Strip Silence, renommer / couleur, justesse note par note). */
  targets?: { trackId: string; clipId: string }[];
  trackId?: string;
  /** Champ mis en avant à l'ouverture. */
  focus?: 'name' | 'color';
  /** Audio → MIDI (V20) : mélodie, batterie ou harmonie ; micro ; instrument ; version simple. */
  convert?: { mode: 'melody' | 'drums' | 'harmony'; mic?: boolean; instrument?: '808' | 'piano' | 'lead' | 'pad'; simple?: boolean };
}

export const NOVA_WINDOW_EVENT = 'nova:open-window';

export const openNovaWindow = (name: NovaWindowName, detail: Omit<NovaWindowDetail, 'name'> = {}) => {
  try { window.dispatchEvent(new CustomEvent<NovaWindowDetail>(NOVA_WINDOW_EVENT, { detail: { name, ...detail } })); } catch { /* hors navigateur */ }
};
