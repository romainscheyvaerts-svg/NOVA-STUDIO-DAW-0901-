import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { KEYMAP, chordFromEvent, eventChord, findConflicts, findShortcut, isShortcut, keysOf, matchShortcut, shortcutHint, type KeyLike } from '../utils/keymap';
import {
  KEYMAP_PRESETS, __resetKeymapForTests, conflictsFor, exportNovakeys, getActiveKeymap, importNovakeys, keymapConflicts, keymapStore, presetById, resolvePreset,
} from '../utils/keymapStore';
import { isFeedbackShortcut } from '../utils/feedbackShortcut';

const ev = (key: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, code, ...mods });

beforeEach(() => __resetKeymapForTests());

describe('R17 · table des commandes', () => {
  it('toutes les commandes ont un identifiant unique et un libellé en français', () => {
    const ids = KEYMAP.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of KEYMAP) expect(d.label.length).toBeGreaterThan(2);
  });

  it('la table d’origine (NOVA) reste sans conflit', () => {
    expect(findConflicts()).toEqual([]);
    expect(keymapConflicts(KEYMAP)).toEqual([]);
  });

  it('F5 à F10 donnent les outils comme Pro Tools', () => {
    expect(keysOf('tool.zoom')).toContain('f5');
    expect(keysOf('tool.smart')).toContain('f6');
    expect(keysOf('tool.range')).toContain('f7');
    expect(keysOf('tool.select')).toContain('f8');
    expect(keysOf('tool.scrub')).toContain('f9');
    expect(keysOf('tool.draw')).toContain('f10');
  });
});

describe('R17 · préréglages complets', () => {
  for (const p of KEYMAP_PRESETS) {
    it(`« ${p.name} » : aucun conflit interne`, () => {
      const map = resolvePreset(p);
      expect(keymapConflicts(map)).toEqual([]);
      expect(map.length).toBe(KEYMAP.length);
    });
    it(`« ${p.name} » : toutes ses touches visent des commandes connues`, () => {
      const ids = new Set(KEYMAP.map(d => d.id));
      for (const id of Object.keys(p.keys)) expect(ids.has(id), id).toBe(true);
    });
  }

  it('Pro Tools : 10 raccourcis relevés sur le Pro Tools de Romain', () => {
    keymapStore.setPreset('protools');
    const pt = (chord: string) => getActiveKeymap().filter(d => d.context === 'global' && d.keys.includes(chord)).map(d => d.id);
    expect(pt('ctrl+e')).toEqual(['pt.split']);
    expect(pt('ctrl+shift+l')).toEqual(['nova.loop']);
    expect(pt('ctrl+alt+b')).toEqual(['nova.export']);          // Bounce Mix
    expect(pt('ctrl+m')).toEqual(['nova.mute']);
    expect(pt('ctrl+h')).toEqual(['pt.heal']);
    expect(pt('ctrl+u')).toEqual(['pt.stripSilence']);
    expect(pt('ctrl+alt+shift+r')).toEqual(['pt.rename']);
    expect(pt('ctrl+shift+e')).toEqual(['pt.insertTime']);       // Insert Silence
    expect(pt('ctrl+shift+p')).toEqual(['pt.quickPunch']);
    expect(pt('f9')).toEqual(['tool.scrub']);
    expect(pt('ctrl+space')).toEqual(['pt.recordAlt']);
    expect(pt('ctrl+=')).toEqual(['view.mixEdit']);
    // R n'enregistre plus, S ne coupe plus : comme dans Pro Tools.
    expect(pt('r')).toEqual([]);
    expect(pt('s')).toEqual([]);
    expect(keymapStore.get().usLayout).toBe(true);
    expect(keymapStore.get().ctrlFFades).toBe(true);
  });

  it('Pro Tools : touches par position (AZERTY : Ctrl+W = annuler, comme « Lock to U.S. Layout »)', () => {
    keymapStore.setPreset('protools');
    // Touche W d'un clavier AZERTY = position du Z en QWERTY.
    expect(isShortcut(ev('w', 'KeyZ', { ctrlKey: true }), 'nova.undo')).toBe(true);
    // Touche A d'un AZERTY = position du Q : rien ; touche Q d'un AZERTY = position du A : tout sélectionner.
    expect(findShortcut(eventChord(ev('q', 'KeyA', { ctrlKey: true })), false)?.id).toBe('pt.selectAll');
    keymapStore.setPreset('nova');
    expect(isShortcut(ev('w', 'KeyZ', { ctrlKey: true }), 'nova.undo')).toBe(false);
    expect(isShortcut(ev('z', 'KeyW', { ctrlKey: true }), 'nova.undo')).toBe(true);
  });

  it('FL Studio et Ableton Live : les touches de leur documentation', () => {
    keymapStore.setPreset('fl');
    expect(keysOf('nova.duplicate')).toEqual(['ctrl+b']);
    expect(keysOf('nova.export')).toEqual(['ctrl+r']);
    expect(keysOf('tool.draw')).toEqual(['p', 'b']);
    expect(keysOf('tool.scrub')).toEqual(['y']);
    expect(keysOf('view.mixer')).toEqual(['f9']);
    keymapStore.setPreset('ableton');
    expect(keysOf('nova.record')).toEqual(['f9']);
    expect(keysOf('nova.loop')).toEqual(['ctrl+l']);
    expect(keysOf('pt.consolidate')).toEqual(['ctrl+j']);
    expect(keysOf('nova.computerKeyboard')).toEqual(['m']);
    // F9 = enregistrer : l'outil Scrubber le perd, sans conflit.
    expect(keysOf('tool.scrub')).not.toContain('f9');
  });
});

describe('R17 · remappage et conflits', () => {
  it('remappe une commande et la table active suit', () => {
    keymapStore.assign('nova.marker', 'j', { replaceIndex: 0 });
    expect(keysOf('nova.marker')).toEqual(['j']);
    expect(isShortcut(ev('j', 'KeyJ'), 'nova.marker')).toBe(true);
    expect(isShortcut(ev('k', 'KeyK'), 'nova.marker')).toBe(false);
    expect(shortcutHint('nova.marker')).toBe('J');
    expect(keymapStore.isCustomized('nova.marker')).toBe(true);
  });

  it('détecte le conflit et propose de retirer la touche à l’autre commande', () => {
    expect(conflictsFor('nova.marker', 'ctrl+e').map(d => d.id)).toEqual(['pt.split']);
    const touched = keymapStore.assign('nova.marker', 'ctrl+e', { replaceIndex: 0, resolve: 'steal' });
    expect(touched).toEqual(['pt.split']);
    expect(keysOf('pt.split')).toEqual([]);
    expect(keymapConflicts()).toEqual([]);
  });

  it('ou de les échanger', () => {
    keymapStore.assign('nova.marker', 'ctrl+e', { replaceIndex: 0, resolve: 'swap' });
    expect(keysOf('nova.marker')).toEqual(['ctrl+e']);
    expect(keysOf('pt.split')).toEqual(['k']);
    expect(keymapConflicts()).toEqual([]);
  });

  it('pas de conflit entre contextes (piano roll et arrangement)', () => {
    expect(conflictsFor('pr.quantize', 'ctrl+a').map(d => d.id)).toEqual(['pr.selectAll']);
    expect(conflictsFor('pr.quantize', 'ctrl+e')).toEqual([]);
  });

  it('les familles fixes (clavier MIDI, Shuttle Lock) ne se remappent pas', () => {
    const before = keysOf('shuttle.lock');
    keymapStore.assign('shuttle.lock', 'x');
    expect(keysOf('shuttle.lock')).toEqual(before);
  });

  it('« Remettre par défaut » revient au préréglage', () => {
    keymapStore.setPreset('protools');
    keymapStore.assign('pt.split', 'ctrl+alt+x', { replaceIndex: 0 });
    keymapStore.resetCommand('pt.split');
    expect(keysOf('pt.split')).toEqual(['ctrl+e']);
    keymapStore.assign('pt.heal', 'ctrl+alt+x', { replaceIndex: 0 });
    keymapStore.resetAll();
    expect(keysOf('pt.heal')).toEqual(['ctrl+h']);
    expect(keymapStore.get().preset).toBe('protools');
    keymapStore.factoryReset();
    expect(keymapStore.get().preset).toBe('nova');
    expect(keysOf('nova.record')).toEqual(['r']);
  });
});

describe('R17 · export / import .novakeys', () => {
  it('aller-retour fidèle', () => {
    keymapStore.setPreset('fl');
    keymapStore.assign('nova.marker', 'ctrl+alt+m', { replaceIndex: 0 });
    const text = exportNovakeys('Studio A');
    const file = JSON.parse(text);
    expect(file.format).toBe('novakeys');
    expect(file.preset).toBe('fl');
    expect(file.bindings['nova.marker']).toEqual(['ctrl+alt+m']);
    keymapStore.factoryReset();
    expect(keysOf('nova.marker')).toEqual(['k']);
    const r = importNovakeys(text);
    expect(r.ok).toBe(true);
    expect(r.unknown).toEqual([]);
    expect(keymapStore.get().preset).toBe('fl');
    expect(keysOf('nova.marker')).toEqual(['ctrl+alt+m']);
    expect(keysOf('nova.duplicate')).toEqual(['ctrl+b']);
  });

  it('refuse un fichier qui n’en est pas un, ignore les commandes inconnues', () => {
    expect(importNovakeys('pas du json').ok).toBe(false);
    expect(importNovakeys('{"format":"autre"}').ok).toBe(false);
    const r = importNovakeys(JSON.stringify({ format: 'novakeys', version: 1, preset: 'nova', bindings: { 'nova.loop': ['ctrl+alt+o'], 'futur.cmd': ['x'] } }));
    expect(r.ok).toBe(true);
    expect(r.unknown).toEqual(['futur.cmd']);
    expect(keysOf('nova.loop')).toEqual(['ctrl+alt+o']);
  });
});

describe('R17 · tous les gestionnaires lisent la table active', () => {
  it('useProToolsShortcuts (findShortcut) suit un remappage', () => {
    keymapStore.assign('pt.split', 'ctrl+alt+x', { replaceIndex: 0 });
    expect(findShortcut('ctrl+e', false)).toBeNull();
    expect(findShortcut('ctrl+alt+x', false)?.command).toBe('split');
  });

  it('matchShortcut (App, arrangement, piano roll) suit un remappage', () => {
    keymapStore.assign('nova.record', 'f2', { replaceIndex: 0, resolve: 'steal' });
    expect(matchShortcut(ev('F2', 'F2'), ['nova.play', 'nova.record'])).toBe('nova.record');
    expect(matchShortcut(ev('r', 'KeyR'), ['nova.play', 'nova.record'])).toBeNull();
    keymapStore.assign('pr.quantize', 'ctrl+alt+q', { replaceIndex: 0 });
    expect(isShortcut(ev('q', 'KeyQ', { ctrlKey: true, altKey: true }), 'pr.quantize')).toBe(true);
  });

  it('le signalement de bug (FeedbackModal) suit un remappage', () => {
    expect(isFeedbackShortcut(ev('b', 'KeyB', { ctrlKey: true, shiftKey: true }))).toBe(true);
    keymapStore.assign('nova.feedback', 'ctrl+alt+shift+f', { replaceIndex: 0 });
    expect(isFeedbackShortcut(ev('b', 'KeyB', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isFeedbackShortcut(ev('f', 'KeyF', { ctrlKey: true, altKey: true, shiftKey: true }))).toBe(true);
  });

  it('aucun gestionnaire ne garde de touche codée en dur pour une commande de la table', () => {
    const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
    const files = ['App.tsx', 'components/ArrangementView.tsx', 'components/PianoRoll.tsx', 'components/MidiHost.tsx', 'components/MidiInputHost.tsx', 'hooks/useProToolsShortcuts.ts'];
    for (const f of files) {
      const src = read(f);
      expect(/isShortcut|matchShortcut|findShortcut|eventChord/.test(src), f).toBe(true);
    }
    // Les anciennes comparaisons directes des gestes remappables ont disparu.
    const app = read('App.tsx');
    expect(app).not.toMatch(/e\.key === 'r' \|\| e\.key === 'R'/);
    expect(app).not.toMatch(/e\.key === 'k' \|\| e\.key === 'K'/);
    const arr = read('components/ArrangementView.tsx');
    expect(arr).not.toMatch(/e\.key === '1'\) \{ setActiveTool/);
    expect(arr).not.toMatch(/e\.key === 'm' \|\| e\.key === 'M'/);
    const pr = read('components/PianoRoll.tsx');
    expect(pr).not.toMatch(/e\.key === 'q'\)/);
  });

  it('chordFromEvent sans réglage reste celui d’avant (caractères)', () => {
    expect(chordFromEvent(ev('z', 'KeyW', { ctrlKey: true }))).toBe('ctrl+z');
    expect(chordFromEvent(ev('w', 'KeyZ', { ctrlKey: true }), true)).toBe('ctrl+z');
    expect(presetById('inconnu').id).toBe('nova');
  });
});
