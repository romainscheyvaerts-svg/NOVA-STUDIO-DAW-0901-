import { KEYMAP, isShortcut, keysOf, type KeyLike } from './keymap';

/** Raccourci d'origine « Signaler un bug / proposer une idée » (entrée nova.feedback de utils/keymap). */
export const FEEDBACK_SHORTCUT = KEYMAP.find(s => s.id === 'nova.feedback')?.keys[0] || 'ctrl+shift+b';

/** Raccourci actif (il suit les remappages de l'éditeur de raccourcis). */
export const feedbackShortcutNow = (): string => keysOf('nova.feedback')[0] || '';

export const isFeedbackShortcut = (e: KeyLike): boolean => {
  try { return isShortcut(e, 'nova.feedback'); } catch { return false; }
};
