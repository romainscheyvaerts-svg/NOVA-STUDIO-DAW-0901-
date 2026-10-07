import type { BreathKind } from './breaths';

/**
 * Demandes de traitement des respirations, depuis n'importe où (menus, Nova,
 * raccourci, fin de prise, Mix auto) : un simple événement que
 * components/BreathTools (BreathHost) écoute. Rien à faire descendre en props.
 */
export interface BreathRequest {
  /** dialog : ouvrir la fenêtre ; apply : traiter tout de suite ; auto : fin de prise (si le mode auto est actif). */
  mode: 'dialog' | 'apply' | 'auto';
  trackIds?: string[];
  clipIds?: string[];
  /** Seulement les voix de ce type (« enlève les respirations des backs »). */
  only?: BreathKind;
  /** Forcer un dosage pour cette demande (Nova : « supprime les respirations »). */
  remove?: boolean;
  reason?: 'take' | 'mix' | 'nova' | 'menu' | 'panel' | 'shortcut';
}

export const BREATH_EVENT = 'nova:breaths';

export const requestBreaths = (r: BreathRequest) => {
  try { window.dispatchEvent(new CustomEvent<BreathRequest>(BREATH_EVENT, { detail: r })); } catch { /* hors navigateur */ }
};
