import { useSyncExternalStore } from 'react';
import { KEYMAP, configureKeymapRuntime, type ShortcutContext, type ShortcutDef } from './keymap';

/**
 * Raccourcis personnalisables (R17).
 *
 * La table d'origine (utils/keymap) donne TOUTES les commandes de NOVA avec
 * leurs touches par défaut. Ici :
 * - un PRÉRÉGLAGE complet (NOVA, Pro Tools Windows, FL Studio, Ableton Live)
 *   change les touches d'un coup ;
 * - les REMAPPAGES de l'utilisateur passent par-dessus (capture de touches
 *   dans components/KeymapEditor) ;
 * - le tout est stocké sur l'appareil, exportable en fichier `.novakeys`.
 *
 * Tous les gestionnaires (hooks/useProToolsShortcuts, App.tsx, ArrangementView,
 * PianoRoll, MidiHost, FeedbackModal…) lisent la table ACTIVE via
 * utils/keymap (`isShortcut`, `matchShortcut`, `findShortcut`), où ce module
 * s'inscrit au chargement.
 */

export type KeymapPresetId = 'nova' | 'protools' | 'fl' | 'ableton';

export interface KeymapPreset {
  id: KeymapPresetId;
  name: string;
  description: string;
  /** D'où viennent les touches. */
  source: string;
  /** Touches lues par position, comme un clavier US (Pro Tools : « Lock to U.S. Layout »). */
  usLayout?: boolean;
  /** Ctrl+F = fondus même sans plage (Pro Tools). */
  ctrlFFades?: boolean;
  /** Touches explicites du préréglage. Les autres commandes gardent celles de NOVA, sauf si elles entrent en conflit. */
  keys: Record<string, string[]>;
}

const PROTOOLS: KeymapPreset = {
  id: 'protools',
  name: 'Pro Tools (Windows)',
  description: 'Les raccourcis relevés sur le Pro Tools 2026 de Romain et dans le guide officiel d’Avid. Touches lues par position, comme « Lock to U.S. Layout » : en AZERTY, Annuler est sur la touche W, comme dans Pro Tools.',
  source: 'Relevé des menus de Pro Tools 2026 (protools_menus.json) + Avid « Pro Tools Keyboard Shortcuts » (2025)',
  usLayout: true,
  ctrlFFades: true,
  keys: {
    // Transport
    'nova.play': ['space'],
    'nova.record': [],
    'pt.recordAlt': ['ctrl+space', 'f12', 'num3'],
    'nova.stop': [],
    'nova.home': ['enter', 'home'],
    'nova.end': ['ctrl+enter', 'end'],
    'nova.loop': ['ctrl+shift+l'],
    'nova.tap': [],
    'pt.quickPunch': ['ctrl+shift+p'],
    'pt.numPlay': ['num0'], 'pt.numRew': ['num1'], 'pt.numFf': ['num2'], 'pt.numLoop': ['num4'],
    'pt.numLoopRec': ['num5'], 'pt.numQuickPunch': ['num6'], 'pt.numClick': ['num7'], 'pt.numCountoff': ['num8'], 'pt.numMidiMerge': ['num9'],
    // Repères
    'nova.marker': [],
    'pt.newMarker': ['numenter'],
    'pt.memoryWindow': ['ctrl+num5'],
    // Édition
    'nova.undo': ['ctrl+z'],
    'nova.redo': ['ctrl+shift+z'],
    'nova.save': ['ctrl+s'],
    'nova.export': ['ctrl+alt+b'],
    'nova.copy': ['ctrl+c'], 'nova.cut': ['ctrl+x'], 'nova.paste': ['ctrl+v'], 'nova.duplicate': ['ctrl+d'],
    'nova.delete': ['delete', 'backspace', 'ctrl+b'],
    'nova.mute': ['ctrl+m'],
    'nova.split': [],
    'pt.split': ['ctrl+e'],
    'pt.fadesRange': ['ctrl+f'],
    'pt.quickFades': [],
    'pt.selectAll': ['ctrl+a'],
    'pt.rename': ['ctrl+alt+shift+r'],
    'pt.syncPoint': ['ctrl+,'],
    'pt.heal': ['ctrl+h'],
    'pt.repeat': ['alt+r'],
    'pt.loopClip': ['ctrl+alt+l'],
    'pt.groupCreate': ['ctrl+g'],
    'pt.groupsSuspend': ['ctrl+shift+g'],
    'pt.insertTime': ['ctrl+shift+e'],
    'pt.stripSilence': ['ctrl+u'],
    'pt.consolidate': ['alt+shift+3'],
    // Outils et modes
    'tool.zoom': ['f5', 'ctrl+1'],
    'tool.smart': ['f6', 'ctrl+2', 'ctrl+7'],
    'tool.range': ['f7', 'ctrl+3'],
    'tool.select': ['f8', 'ctrl+4'],
    'tool.scrub': ['f9', 'ctrl+5'],
    'tool.draw': ['f10', 'ctrl+6'],
    'tool.split': [], 'tool.erase': [],
    'tool.cycle': ['escape'],
    'pt.modeShuffle': ['f1', 'alt+1'], 'pt.modeSlip': ['f2', 'alt+2'], 'pt.modeSpot': ['f3', 'alt+3'], 'pt.modeGrid': ['f4', 'alt+4'],
    'pt.modeCycle': ['`'],
    // Zoom, vues
    'pt.zoomIn': ['ctrl+]'], 'pt.zoomOut': ['ctrl+['],
    'view.mixEdit': ['ctrl+='],
    'layout.list': ['ctrl+alt+j'],
    'keymap.editor': ['ctrl+alt+k'],
  },
};

const FL: KeymapPreset = {
  id: 'fl',
  name: 'FL Studio',
  description: 'Les raccourcis de la documentation d’Image-Line : P crayon, C découpe, D gomme, E sélection, Z zoom, Y lecture (scrub), Ctrl+B dupliquer, Ctrl+R exporter, F5 Playlist, F9 Mixer…',
  source: 'Image-Line, FL Studio Online Manual « Keyboard shortcuts » (basics_shortcuts.htm)',
  keys: {
    'nova.play': ['space'],
    'nova.record': ['r'],
    'nova.home': ['home'],
    'nova.metronome': ['ctrl+m'],
    'pt.numCountoff': ['ctrl+p', 'num8'],
    'pt.numPlay': [],
    'pt.numFf': ['num0'],
    'nova.barPrev': [',', ';', 'numdiv'],
    'nova.barNext': ['.', ':', 'nummul'],
    'nova.undo': ['ctrl+z', 'ctrl+alt+z'],
    'nova.save': ['ctrl+s'],
    'nova.export': ['ctrl+r'],
    'nova.copy': ['ctrl+c'], 'nova.cut': ['ctrl+x'], 'nova.paste': ['ctrl+v'],
    'nova.duplicate': ['ctrl+b'],
    'nova.delete': ['delete'],
    'pt.selectAll': ['ctrl+a'],
    'nova.mute': ['alt+m'],
    'nova.split': ['insert'],
    'nova.marker': ['alt+t'],
    'nova.computerKeyboard': ['ctrl+t'],
    'pt.insertTime': ['ctrl+insert'],
    'tool.draw': ['p', 'b'],
    'tool.split': ['c'],
    'tool.erase': ['d'],
    'tool.select': ['e'],
    'tool.zoom': ['z'],
    'tool.scrub': ['y'],
    'view.arrangement': ['f5'],
    'view.mixer': ['f9'],
    'view.browser': ['alt+f8'],
    'pt.zoomIn': ['pageup'],
    'pt.zoomOut': ['pagedown'],
    'pt.zoomSel': ['shift+5'],
    // Piano roll
    'pr.selectAll': ['ctrl+a'],
    'pr.double': ['ctrl+b'],
    'pr.delete': ['delete'],
    'nova.muteNotes': ['alt+m'],
    'pr.quantize': ['ctrl+alt+q', 'alt+q'],
    'pr.octUp': ['ctrl+arrowup'], 'pr.octDown': ['ctrl+arrowdown'],
  },
};

const ABLETON: KeymapPreset = {
  id: 'ableton',
  name: 'Ableton Live',
  description: 'Les raccourcis du manuel d’Ableton Live 12 : F9 enregistrer, Ctrl+L boucle, Ctrl+E séparer, Ctrl+J consolider, B crayon, M clavier MIDI, O métronome, Ctrl+Alt+M console…',
  source: 'Ableton Live 12 Reference Manual, chapitre « Live Keyboard Shortcuts »',
  keys: {
    'nova.play': ['space'],
    'nova.home': ['home'],
    'nova.end': ['end'],
    'nova.record': ['f9'],
    'nova.loop': ['ctrl+l'],
    'nova.metronome': ['o'],
    'pt.split': ['ctrl+e'],
    'pt.consolidate': ['ctrl+j'],
    'nova.duplicate': ['ctrl+d'],
    'nova.delete': ['delete'],
    'pt.rename': ['ctrl+r'],
    'nova.undo': ['ctrl+z'],
    'nova.redo': ['ctrl+y'],
    'pt.quickFades': ['ctrl+alt+f'],
    'nova.save': ['ctrl+s'],
    'nova.export': ['ctrl+shift+r'],
    'pt.selectAll': ['ctrl+a'],
    'tool.draw': ['b'],
    'pt.zoomIn': ['plus', '='],
    'pt.zoomOut': ['-'],
    'pt.zoomSel': ['z'],
    'nova.computerKeyboard': ['m'],
    'nova.mute': ['0'],
    'pt.groupCreate': ['ctrl+g'],
    'view.browser': ['ctrl+alt+b'],
    'view.mixer': ['ctrl+alt+m'],
    // Éditeur de notes MIDI
    'pr.quantize': ['ctrl+u'],
    'pr.double': ['ctrl+d'],
    'pr.selectAll': ['ctrl+a'],
    'pr.delete': ['delete'],
    'pr.octUp': ['shift+arrowup'], 'pr.octDown': ['shift+arrowdown'],
  },
};

const NOVA: KeymapPreset = {
  id: 'nova',
  name: 'NOVA',
  description: 'Les raccourcis d’origine de NOVA : une lettre pour les gestes courants (R enregistrer, S couper, L boucle, K repère), plus le pavé numérique et les combinaisons de Pro Tools.',
  source: 'NOVA',
  keys: {},
};

export const KEYMAP_PRESETS: KeymapPreset[] = [NOVA, PROTOOLS, FL, ABLETON];
export const presetById = (id: string): KeymapPreset => KEYMAP_PRESETS.find(p => p.id === id) || NOVA;

/** Contextes où deux commandes peuvent se gêner (piano roll et Keyboard Focus passent avant global). */
const CONTEXTS: ShortcutContext[] = ['global', 'focus', 'pianoroll', 'midi'];

/**
 * Table complète d'un préréglage : touches explicites, puis celles de NOVA
 * pour le reste, moins les touches déjà prises dans le même contexte.
 */
export function resolvePreset(preset: KeymapPreset, base: ShortcutDef[] = KEYMAP): ShortcutDef[] {
  const explicit = preset.keys;
  const out = base.map(d => ({ ...d, keys: [...(explicit[d.id] ?? d.keys)] }));
  for (const ctx of CONTEXTS) {
    const claimed = new Set(out.filter(d => d.context === ctx && explicit[d.id]).flatMap(d => d.keys));
    for (const d of out) {
      if (d.context !== ctx || explicit[d.id] || d.fixed) continue;
      d.keys = d.keys.filter(k => !claimed.has(k));
    }
  }
  return out;
}

// --- Réglages et stockage -----------------------------------------------------------

export interface KeymapSettings {
  preset: KeymapPresetId;
  usLayout: boolean;
  ctrlFFades: boolean;
  /** Touches choisies par l'utilisateur, par commande (remplacent celles du préréglage). */
  overrides: Record<string, string[]>;
}

const STORAGE_KEY = 'nova_keymap_v1';
const defaults = (): KeymapSettings => ({ preset: 'nova', usLayout: false, ctrlFFades: false, overrides: {} });

const validChord = (k: unknown): k is string => typeof k === 'string' && k.length > 0 && k.length < 40 && !/\s/.test(k);
const knownIds = () => new Set(KEYMAP.map(d => d.id));

function sanitize(raw: any): KeymapSettings {
  const d = defaults();
  if (!raw || typeof raw !== 'object') return d;
  const preset = KEYMAP_PRESETS.some(p => p.id === raw.preset) ? raw.preset : 'nova';
  const ids = knownIds();
  const overrides: Record<string, string[]> = {};
  if (raw.overrides && typeof raw.overrides === 'object') {
    for (const [id, keys] of Object.entries(raw.overrides)) {
      if (!ids.has(id) || !Array.isArray(keys)) continue;
      if (KEYMAP.find(x => x.id === id)?.fixed) continue;
      overrides[id] = Array.from(new Set((keys as unknown[]).filter(validChord)));
    }
  }
  return { preset, usLayout: !!raw.usLayout, ctrlFFades: !!raw.ctrlFFades, overrides };
}

let settings: KeymapSettings = (() => {
  try { const t = localStorage.getItem(STORAGE_KEY); return t ? sanitize(JSON.parse(t)) : defaults(); } catch { return defaults(); }
})();
let active: ShortcutDef[] | null = null;
const listeners = new Set<() => void>();

function computeActive(s: KeymapSettings): ShortcutDef[] {
  const resolved = resolvePreset(presetById(s.preset));
  return resolved.map(d => (s.overrides[d.id] && !d.fixed ? { ...d, keys: [...s.overrides[d.id]] } : d));
}

function commit(next: KeymapSettings) {
  settings = next;
  active = null;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* stockage indisponible : la session garde le réglage */ }
  listeners.forEach(fn => fn());
}

export const getActiveKeymap = (): ShortcutDef[] => (active ??= computeActive(settings));

configureKeymapRuntime({ map: getActiveKeymap, usLayout: () => settings.usLayout });

export interface KeyConflict { chord: string; with: ShortcutDef }

/** Commandes du même contexte qui utilisent déjà cette combinaison. */
export function conflictsFor(id: string, chord: string, map: ShortcutDef[] = getActiveKeymap()): ShortcutDef[] {
  const me = map.find(d => d.id === id) || KEYMAP.find(d => d.id === id);
  if (!me) return [];
  return map.filter(d => d.id !== id && d.context === me.context && d.keys.includes(chord));
}

/** Tous les conflits de la table (même contexte) : [combinaison, ids]. */
export function keymapConflicts(map: ShortcutDef[] = getActiveKeymap()): { context: ShortcutContext; chord: string; ids: string[] }[] {
  const out: { context: ShortcutContext; chord: string; ids: string[] }[] = [];
  for (const ctx of CONTEXTS) {
    const by = new Map<string, string[]>();
    for (const d of map) if (d.context === ctx) for (const k of d.keys) by.set(k, [...(by.get(k) || []), d.id]);
    by.forEach((ids, chord) => { const u = Array.from(new Set(ids)); if (u.length > 1) out.push({ context: ctx, chord, ids: u }); });
  }
  return out;
}

const keysNow = (id: string) => getActiveKeymap().find(d => d.id === id)?.keys || [];

export type ConflictResolution = 'steal' | 'swap';

export const keymapStore = {
  get: (): KeymapSettings => settings,
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },

  /** Change de préréglage : les remappages sont effacés (on repart du préréglage complet). */
  setPreset(id: KeymapPresetId) {
    const p = presetById(id);
    commit({ preset: p.id, usLayout: !!p.usLayout, ctrlFFades: !!p.ctrlFFades, overrides: {} });
  },
  setUsLayout(v: boolean) { commit({ ...settings, usLayout: v }); },
  setCtrlFFades(v: boolean) { commit({ ...settings, ctrlFFades: v }); },

  /** Touches d'une commande (remplace toutes ses touches). */
  setKeys(id: string, keys: string[]) {
    const def = KEYMAP.find(d => d.id === id);
    if (!def || def.fixed) return;
    commit({ ...settings, overrides: { ...settings.overrides, [id]: Array.from(new Set(keys.filter(validChord))) } });
  },

  /**
   * Donne `chord` à `id`.
   * - `replaceIndex` : remplace cette touche de la commande (sinon ajoute) ;
   * - conflit : « steal » retire la touche aux autres commandes, « swap » leur
   *   donne en échange l'ancienne touche de `id` (quand il y en a une).
   * Renvoie les commandes touchées par la résolution.
   */
  assign(id: string, chord: string, opts: { replaceIndex?: number; resolve?: ConflictResolution } = {}): string[] {
    const def = KEYMAP.find(d => d.id === id);
    if (!def || def.fixed || !validChord(chord)) return [];
    const mine = [...keysNow(id)];
    const old = opts.replaceIndex !== undefined ? mine[opts.replaceIndex] : undefined;
    let next = mine.filter(k => k !== chord);
    if (opts.replaceIndex !== undefined && opts.replaceIndex < mine.length) next = mine.map((k, i) => (i === opts.replaceIndex ? chord : k)).filter((k, i, a) => a.indexOf(k) === i);
    else next.push(chord);
    const overrides = { ...settings.overrides, [id]: next };
    const touched: string[] = [];
    for (const other of conflictsFor(id, chord)) {
      if (other.fixed) continue;
      let keys = other.keys.filter(k => k !== chord);
      if (opts.resolve === 'swap' && old && old !== chord && !keys.includes(old)) keys = [...keys, old];
      overrides[other.id] = keys;
      touched.push(other.id);
    }
    commit({ ...settings, overrides });
    return touched;
  },

  /** Retire une touche d'une commande. */
  removeKey(id: string, chord: string) {
    const def = KEYMAP.find(d => d.id === id);
    if (!def || def.fixed) return;
    commit({ ...settings, overrides: { ...settings.overrides, [id]: keysNow(id).filter(k => k !== chord) } });
  },

  /** Remet une commande comme dans le préréglage. */
  resetCommand(id: string) {
    const { [id]: _drop, ...rest } = settings.overrides;
    commit({ ...settings, overrides: rest });
  },

  /** « Remettre par défaut » : le préréglage choisi, sans aucun remappage. */
  resetAll() { this.setPreset(settings.preset); },

  /** Retour complet à NOVA (préréglage, options, remappages). */
  factoryReset() { commit(defaults()); },

  isCustomized: (id: string) => Object.prototype.hasOwnProperty.call(settings.overrides, id),
};

/** Raccourcis actifs, à jour (React). */
export const useKeymap = (): ShortcutDef[] => useSyncExternalStore(keymapStore.subscribe, getActiveKeymap, getActiveKeymap);
export const useKeymapSettings = (): KeymapSettings => useSyncExternalStore(keymapStore.subscribe, keymapStore.get, keymapStore.get);

// --- Fichier .novakeys ----------------------------------------------------------------

export interface NovakeysFile {
  format: 'novakeys';
  version: 1;
  name?: string;
  exportedAt: string;
  preset: KeymapPresetId;
  usLayout: boolean;
  ctrlFFades: boolean;
  /** Toutes les commandes avec leurs touches (lisible et fiable d'une version à l'autre). */
  bindings: Record<string, string[]>;
}

export function exportNovakeys(name?: string): string {
  const bindings: Record<string, string[]> = {};
  for (const d of getActiveKeymap()) if (!d.fixed) bindings[d.id] = d.keys;
  const file: NovakeysFile = { format: 'novakeys', version: 1, name, exportedAt: new Date().toISOString(), preset: settings.preset, usLayout: settings.usLayout, ctrlFFades: settings.ctrlFFades, bindings };
  return JSON.stringify(file, null, 2);
}

export interface ImportResult { ok: boolean; error?: string; applied: number; unknown: string[] }

/** Lit un fichier .novakeys : les commandes inconnues (version plus récente) sont ignorées et listées. */
export function importNovakeys(text: string): ImportResult {
  let raw: any;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: 'Ce fichier n’est pas un fichier de raccourcis NOVA (.novakeys) lisible.', applied: 0, unknown: [] }; }
  if (!raw || raw.format !== 'novakeys' || typeof raw.bindings !== 'object' || !raw.bindings) {
    return { ok: false, error: 'Ce fichier n’est pas un fichier de raccourcis NOVA (.novakeys).', applied: 0, unknown: [] };
  }
  const preset = presetById(String(raw.preset || 'nova'));
  const base = resolvePreset(preset);
  const ids = knownIds();
  const unknown: string[] = [];
  const overrides: Record<string, string[]> = {};
  let applied = 0;
  for (const [id, keys] of Object.entries(raw.bindings)) {
    if (!ids.has(id)) { unknown.push(id); continue; }
    const def = base.find(d => d.id === id)!;
    if (def.fixed || !Array.isArray(keys)) continue;
    const clean = Array.from(new Set((keys as unknown[]).filter(validChord)));
    applied++;
    if (clean.join('|') !== def.keys.join('|')) overrides[id] = clean;
  }
  commit({ preset: preset.id, usLayout: !!raw.usLayout, ctrlFFades: !!raw.ctrlFFades, overrides });
  return { ok: true, applied, unknown };
}

/** Pour les tests : repart des réglages d'usine sans toucher au stockage. */
export const __resetKeymapForTests = () => { settings = defaults(); active = null; listeners.forEach(fn => fn()); };
