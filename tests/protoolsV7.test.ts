import { describe, expect, it, vi } from 'vitest';
import { KEYMAP, chordFromEvent, chordLabel, findConflicts, findShortcut, searchShortcuts } from '../utils/keymap';
import { gridStepSeconds, gridSubdivisionsPerBar, isBeatLine, snapToGrid } from '../utils/grid';
import { registerEditCommands, runEditCommand } from '../utils/editCommands';
import { MarkerRecallBuffer, barsBeats, markerByNumber, markerNumbers, nextMarkerNumber } from '../utils/memoryLocations';
import { fadeInTo, fadeOutTo, quickFades, trimEndTo, trimStartTo } from '../utils/clipKeyCommands';
import { stepTrackHeight, TRACK_HEIGHTS } from '../utils/trackHeights';
import { detectVoiceSegments } from '../utils/stripSilence';
import { stripOptions, DEFAULT_STRIP_SETTINGS } from '../components/StripSilenceDialog';
import { FakeAudioBuffer } from './helpers/audio';
import { makeClip } from './helpers/fixtures';
import type { Marker } from '../types';

describe('table des raccourcis', () => {
  it('aucun conflit (NOVA existant, Pro Tools, Keyboard Focus)', () => {
    expect(findConflicts()).toEqual([]);
  });
  it('détecte un conflit introduit', () => {
    const bad = [...KEYMAP, { id: 'x', keys: ['ctrl+e'], label: 'x', category: 'Édition' as const, context: 'global' as const, owner: 'keymap' as const }];
    expect(findConflicts(bad).length).toBeGreaterThan(0);
  });
  it('normalise les touches (lettres, pavé, chiffres AZERTY, flèches)', () => {
    expect(chordFromEvent({ key: 'e', code: 'KeyE', ctrlKey: true })).toBe('ctrl+e');
    expect(chordFromEvent({ key: 'E', code: 'KeyE', metaKey: true, shiftKey: true })).toBe('ctrl+shift+e');
    expect(chordFromEvent({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true })).toBe('ctrl+alt+f');
    expect(chordFromEvent({ key: 'Enter', code: 'NumpadEnter' })).toBe('numenter');
    expect(chordFromEvent({ key: '3', code: 'Numpad3' })).toBe('num3');
    expect(chordFromEvent({ key: '+', code: 'NumpadAdd' })).toBe('numadd');
    expect(chordFromEvent({ key: '&', code: 'Digit1', ctrlKey: true, altKey: true })).toBe('ctrl+alt+1');
    expect(chordFromEvent({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })).toBe('alt+arrowleft');
    expect(chordFromEvent({ key: ' ', code: 'Space', ctrlKey: true })).toBe('ctrl+space');
    expect(chordFromEvent({ key: '?', code: 'Comma', shiftKey: true })).toBe('?');
  });
  it('les touches de NOVA restent à NOVA, sauf en Keyboard Focus', () => {
    expect(findShortcut('r', false)).toBeNull();           // R = enregistrer (App.tsx)
    expect(findShortcut('r', true)?.command).toBe('zoomOut');
    expect(findShortcut('s', false)).toBeNull();
    expect(findShortcut('s', true)?.command).toBe('trimEndToCursor');
    expect(findShortcut('ctrl+e', false)?.command).toBe('split');
    expect(findShortcut('ctrl+e', true)?.command).toBe('split');
    expect(findShortcut('num3', false)?.id).toBe('pt.recordAlt');
    expect(findShortcut('ctrl+c', false)).toBeNull();        // géré par l'arrangement
  });
  it('libellés lisibles et recherche sans accents', () => {
    expect(chordLabel('ctrl+alt+f')).toBe('Ctrl + Alt + F');
    expect(chordLabel('numenter')).toBe('Entrée (pavé)');
    expect(chordLabel('numadd')).toBe('Pavé +');
    expect(searchShortcuts('separer').map(s => s.id)).toContain('pt.split');
    expect(searchShortcuts('ctrl+e').map(s => s.id)).toContain('pt.split');
    expect(searchShortcuts('pavé 7').map(s => s.id)).toContain('pt.numClick');
    expect(searchShortcuts('zzzz introuvable')).toEqual([]);
  });
  it('les entrées d’édition des vagues V1-V3 existent (nudge, séparer, fondus)', () => {
    const cmds = new Set(KEYMAP.map(s => s.command).filter(Boolean));
    ['nudgeLeft', 'nudgeRight', 'split', 'quickFades', 'trimStartToCursor', 'fadeInToCursor'].forEach(c => expect(cmds.has(c as any)).toBe(true));
  });
});

describe('bus des commandes d’édition', () => {
  it('le dernier inscrit passe en premier, false passe au suivant, désinscription', () => {
    const base = vi.fn(() => true);
    const off1 = registerEditCommands({ split: base });
    const plage = vi.fn(() => false);
    const off2 = registerEditCommands({ split: plage });
    expect(runEditCommand('split')).toBe(true);
    expect(plage).toHaveBeenCalled();
    expect(base).toHaveBeenCalled();
    off2(); off1();
    expect(runEditCommand('split')).toBe(false);
    expect(runEditCommand('nudgeLeft')).toBe(false);
  });
});

describe('grille', () => {
  it('1/32 et triolets', () => {
    expect(gridSubdivisionsPerBar('1/32')).toBe(32);
    expect(gridSubdivisionsPerBar('1/8T')).toBe(12);
    expect(gridSubdivisionsPerBar('1/16T')).toBe(24);
    expect(gridSubdivisionsPerBar('1/4T')).toBe(6);
    expect(gridStepSeconds('1/4', 120)).toBeCloseTo(0.5);
    expect(gridStepSeconds('1/32', 120)).toBeCloseTo(0.0625);
    expect(gridStepSeconds('1/8T', 120)).toBeCloseTo(1 / 6);
    expect(snapToGrid(0.18, 120, '1/8T', true)).toBeCloseTo(1 / 6);
    expect(snapToGrid(0.18, 120, '1/8T', false)).toBe(0.18);
    expect(isBeatLine(3, 12)).toBe(true);
    expect(isBeatLine(1, 12)).toBe(false);
    expect(isBeatLine(3, 6)).toBe(true);
    expect(isBeatLine(1, 6)).toBe(false);
  });
});

describe('repères numérotés', () => {
  const mk = (id: string, time: number, number?: number): Marker => ({ id, name: id, time, type: 'MARKER', color: '#fff', number });
  it('numéros fixes gardés, anciens repères numérotés dans l’ordre du temps', () => {
    const ms = [mk('a', 10, 2), mk('b', 5), mk('c', 1)];
    const n = markerNumbers(ms);
    expect(n.get('a')).toBe(2);
    expect(n.get('c')).toBe(1);
    expect(n.get('b')).toBe(3);
    expect(nextMarkerNumber(ms)).toBe(4);
    expect(markerByNumber(ms, 3)?.id).toBe('b');
  });
  it('saisie « . 1 2 . » au pavé', () => {
    const r = new MarkerRecallBuffer();
    expect(r.dot(0)).toBeNull();
    r.digit('1'); r.digit('2');
    expect(r.dot(100)).toBe(12);
    expect(r.active).toBe(false);
    expect(r.digit('3')).toBe(false);
  });
  it('mesure.temps', () => {
    expect(barsBeats(0, 120)).toBe('1.1');
    expect(barsBeats(2.5, 120)).toBe('2.2');
  });
});

describe('commandes à la tête de lecture (Keyboard Focus A S D G)', () => {
  const clip = makeClip({ start: 2, duration: 4, offset: 1, fadeIn: 0, fadeOut: 0 });
  it('trim et fondus', () => {
    expect(trimStartTo(clip, 3)).toMatchObject({ start: 3, offset: 2, duration: 3 });
    expect(trimEndTo(clip, 3)).toMatchObject({ duration: 1 });
    expect(fadeInTo(clip, 3)).toEqual({ fadeIn: 1 });
    expect(fadeOutTo(clip, 5)).toEqual({ fadeOut: 1 });
    expect(trimStartTo(clip, 7)).toBeNull();
    expect(quickFades(clip)).toEqual({ fadeIn: 0.01, fadeOut: 0.01 });
    expect(quickFades({ ...clip, fadeIn: 0.5 })).toEqual({ fadeIn: 0.5, fadeOut: 0.01 });
  });
});

describe('hauteur des pistes', () => {
  it('pas suivants / précédents bornés', () => {
    expect(stepTrackHeight(120, 1)).toBe(180);
    expect(stepTrackHeight(120, -1)).toBe(96);
    expect(stepTrackHeight(TRACK_HEIGHTS[0].px, -1)).toBe(TRACK_HEIGHTS[0].px);
    expect(stepTrackHeight(999, 1)).toBe(TRACK_HEIGHTS[TRACK_HEIGHTS.length - 1].px);
  });
});

describe('Strip Silence avec seuil fixe', () => {
  const SR = 8000;
  const take = () => {
    const b = new FakeAudioBuffer({ numberOfChannels: 1, length: 6 * SR, sampleRate: SR });
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.01 * Math.sin(i * 0.7);       // ≈ -43 dBFS (souffle)
    for (let i = 1 * SR; i < 2 * SR; i++) d[i] = 0.5 * Math.sin(i * 0.3);     // phrase 1
    for (let i = 4 * SR; i < 5 * SR; i++) d[i] = 0.5 * Math.sin(i * 0.3);     // phrase 2
    return b as unknown as AudioBuffer;
  };
  it('le seuil décide de ce qui est un blanc ; les marges s’ajoutent', () => {
    const o = stripOptions({ ...DEFAULT_STRIP_SETTINGS, thresholdDb: -30, startPadMs: 100, endPadMs: 200 });
    const segs = detectVoiceSegments(take(), 0, 6, o);
    expect(segs).toHaveLength(2);
    expect(segs[0].start).toBeCloseTo(0.9, 1);
    expect(segs[0].end).toBeCloseTo(2.2, 1);
    // Seuil sous le souffle : tout est gardé d'un bloc.
    expect(detectVoiceSegments(take(), 0, 6, stripOptions({ ...DEFAULT_STRIP_SETTINGS, thresholdDb: -60 }))).toHaveLength(1);
    // Blanc minimum plus long que le trou (2 s) : une seule région.
    expect(detectVoiceSegments(take(), 0, 6, stripOptions({ ...DEFAULT_STRIP_SETTINGS, thresholdDb: -30, minStripMs: 2500 }))).toHaveLength(1);
  });
});
