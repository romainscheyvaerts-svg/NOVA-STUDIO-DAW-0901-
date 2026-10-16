import { KEYMAP, isShortcut, type KeyLike } from './keymap';

/** Raccourci d'origine « Signaler un bug / proposer une idée » (entrée nova.feedback de utils/keymap). */
export const FEEDBACK_SHORTCUT = KEYMAP.find(s => s.id === 'nova.feedback')?.keys[0] || 'ctrl+shift+b';

export const isFeedbackShortcut = (e: KeyLike): boolean => {
  try { return isShortcut(e, 'nova.feedback'); } catch { return false; }
};
