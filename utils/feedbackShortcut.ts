import { chordFromEvent, KEYMAP, type KeyLike } from './keymap';

/** Raccourci « Signaler un bug / proposer une idée » (entrée nova.feedback de utils/keymap). */
export const FEEDBACK_SHORTCUT = KEYMAP.find(s => s.id === 'nova.feedback')?.keys[0] || 'ctrl+shift+b';

export const isFeedbackShortcut = (e: KeyLike): boolean => {
  try { return chordFromEvent(e) === FEEDBACK_SHORTCUT; } catch { return false; }
};
