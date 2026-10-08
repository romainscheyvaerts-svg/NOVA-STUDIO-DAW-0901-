import { describe, expect, it } from 'vitest';
import { KEYMAP, MIDI_KEYBOARD_SHORTCUTS, findConflicts, findShortcut, ShortcutDef } from '../utils/keymap';
import { isComputerKeyboardCode, KEY_TO_SEMITONE } from '../utils/computerKeyboard';

/** Lettre QWERTY → code de touche physique (« a » → « KeyA »). */
const codeOf = (k: string) => (k === ';' ? 'Semicolon' : k === "'" ? 'Quote' : `Key${k.toUpperCase()}`);

describe('Clavier MIDI de l’ordinateur dans la table des raccourcis', () => {
  it('aucun conflit dans la table (global, Keyboard Focus, clavier MIDI)', () => {
    expect(findConflicts()).toEqual([]);
  });

  it('documente exactement les touches captées par le piano roll', () => {
    const keys = MIDI_KEYBOARD_SHORTCUTS.flatMap(s => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(isComputerKeyboardCode(codeOf(k))).toBe(true);
    // Toutes les notes (17 touches), octave (Z / X) et vélocité (C / V).
    expect(keys.length).toBe(Object.keys(KEY_TO_SEMITONE).length + 4);
    expect(KEYMAP.filter(s => s.context === 'midi')).toHaveLength(MIDI_KEYBOARD_SHORTCUTS.length);
  });

  it('les lettres de NOVA remplacées (S coupe, L boucle, K repère…) le sont exprès', () => {
    const nova = new Set(KEYMAP.filter(s => s.owner === 'nova' && s.context === 'global').flatMap(s => s.keys));
    const overridden = MIDI_KEYBOARD_SHORTCUTS.filter(s => s.keys.some(k => nova.has(k)));
    expect(overridden.length).toBeGreaterThan(0);
    for (const s of overridden) expect(s.overridesNova).toBe(true);
    const sneaky: ShortcutDef = { ...MIDI_KEYBOARD_SHORTCUTS[0], id: 'midi.x', keys: ['m'], overridesNova: false };
    expect(findConflicts([...KEYMAP, sneaky]).some(c => c.includes('midi.x') || c.includes('« m »'))).toBe(true);
  });

  it('le clavier MIDI n’est jamais déclenché par la table (le piano roll le gère seul)', () => {
    expect(findShortcut('a', false)).toBeNull();
    expect(findShortcut('z', true)?.id).toBe('kf.undo');
  });
});
