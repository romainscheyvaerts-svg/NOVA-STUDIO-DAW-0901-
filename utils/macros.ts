import { useSyncExternalStore } from 'react';
import type { PaletteAction } from './commandPalette';
import { activeKeymap, eventChord } from './keymap';

/**
 * Macros (écart 21) : enchaîner plusieurs commandes de la palette Ctrl+K en une seule,
 * lancée par une touche, depuis la palette ou depuis l'éditeur de raccourcis.
 *
 *  - une macro = un nom + une liste d'identifiants d'actions de la palette (celles du
 *    studio et tous les raccourcis de la table) + une touche facultative ;
 *  - jouée d'un coup : UNE seule étape d'annulation (groupe d'annulation d'App) ;
 *    une commande absente de cette version ou indisponible (« sélectionne un clip »)
 *    est sautée et signalée ;
 *  - rangées sur l'appareil, exportables en fichier .novamacros ;
 *  - une macro ne contient jamais une autre macro (pas de boucle).
 */
export interface Macro {
  id: string;
  name: string;
  /** Identifiants des actions de la palette, dans l'ordre. */
  steps: string[];
  /** Touche (« ctrl+alt+1 »), comme la table des raccourcis. */
  keys?: string;
  /**
   * Express : toutes les commandes d'un coup, un seul rafraîchissement de l'écran à la fin
   * (sous 100 ms). Sans : l'écran est mis à jour entre chaque commande, pour celles qui
   * dépendent de la précédente (créer une piste PUIS la régler).
   */
  express?: boolean;
  createdAt?: number;
}

/** `ms` : jusqu'à l'écran à jour ; `runMs` : les commandes elles-mêmes (sans le dernier rafraîchissement). */
export interface MacroRun { ok: boolean; ran: string[]; skipped: { id: string; why: string }[]; ms: number; runMs: number }

export const MACRO_PREFIX = 'macro:';
export const MAX_STEPS = 32;
const KEY = 'nova_macros_v1';

let macros: Macro[] = (() => {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.filter(isMacro) : []; } catch { return []; }
})();
const listeners = new Set<() => void>();
const save = () => {
  try { localStorage.setItem(KEY, JSON.stringify(macros)); } catch { /* stockage indisponible */ }
  listeners.forEach(fn => fn());
};

function isMacro(m: any): m is Macro {
  return !!m && typeof m.id === 'string' && typeof m.name === 'string' && Array.isArray(m.steps) && m.steps.every((s: any) => typeof s === 'string');
}
const clean = (m: Macro): Macro => ({
  id: m.id, name: (m.name || 'Macro').trim().slice(0, 60) || 'Macro',
  steps: m.steps.filter(s => !s.startsWith(MACRO_PREFIX)).slice(0, MAX_STEPS),
  ...(m.keys ? { keys: m.keys } : {}), ...(m.express ? { express: true } : {}), createdAt: m.createdAt || Date.now(),
});

export const listMacros = (): Macro[] => macros;
export const getMacro = (id: string) => macros.find(m => m.id === id) || null;
export const newMacroId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function saveMacro(m: Macro): Macro {
  const c = clean(m);
  // Une touche n'appartient qu'à une macro.
  if (c.keys) macros = macros.map(x => (x.id !== c.id && x.keys === c.keys ? { ...x, keys: undefined } : x));
  macros = macros.some(x => x.id === c.id) ? macros.map(x => (x.id === c.id ? c : x)) : [...macros, c];
  save();
  return c;
}
export function deleteMacro(id: string) { macros = macros.filter(m => m.id !== id); save(); }

/** Touche libre pour une macro ? Sinon : à quoi elle sert déjà. */
export function macroKeyConflict(chord: string, macroId?: string): string | null {
  // Toute la table active (raccourcis de NOVA compris), arrangement et Keyboard Focus.
  const s = activeKeymap().find(d => (d.context === 'global' || d.context === 'focus') && d.keys.includes(chord));
  if (s) return `raccourci « ${s.label} »`;
  const m = macros.find(x => x.keys === chord && x.id !== macroId);
  if (m) return `macro « ${m.name} »`;
  return null;
}

export const macrosStore = { subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; } };
export const useMacros = (): Macro[] => useSyncExternalStore(macrosStore.subscribe, () => macros, () => macros);

// --- Exécution ----------------------------------------------------------------------------
interface Runtime {
  actions: () => PaletteAction[];
  begin: () => void;
  end: () => void;
  notify: (text: string) => void;
}
let runtime: Runtime | null = null;
let running = false;

/** App branche la palette et le groupe d'annulation ; renvoie le débranchement. */
export function configureMacros(r: Runtime): () => void {
  runtime = r;
  const off = installMacroKeys();
  return () => { off(); if (runtime === r) runtime = null; };
}

/** Actions que l'on peut mettre dans une macro (pas les macros, pas les mots chantés, pas les tutos). */
export function macroCandidates(actions: PaletteAction[] = runtime?.actions() || []): PaletteAction[] {
  return actions.filter(a => !a.id.startsWith(MACRO_PREFIX) && !a.id.startsWith('word:') && !a.guide);
}

/** Laisse React appliquer l'étape précédente (l'étape suivante lit l'état à jour). */
const settle = () => new Promise<void>(r => { setTimeout(r, 0); });

/**
 * Joue les étapes une à une, dans UN groupe d'annulation. `actions` : la palette
 * (les ids absents sont sautés). Pur vis-à-vis de React : testable.
 */
export async function playSteps(steps: string[], actions: PaletteAction[], hooks: { begin?: () => void; end?: () => void } = {}, opts: { express?: boolean } = {}): Promise<MacroRun> {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();
  let runMs = 0;
  const byId = new Map(actions.map(a => [a.id, a]));
  const ran: string[] = [];
  const skipped: MacroRun['skipped'] = [];
  hooks.begin?.();
  try {
    for (const id of steps) {
      if (id.startsWith(MACRO_PREFIX)) { skipped.push({ id, why: 'une macro ne lance pas une autre macro' }); continue; }
      const a = byId.get(id);
      if (!a) { skipped.push({ id, why: 'commande absente de cette version' }); continue; }
      if (a.disabledReason) { skipped.push({ id, why: a.disabledReason }); continue; }
      try { a.run(); ran.push(id); } catch (e: any) { skipped.push({ id, why: e?.message || String(e) }); }
      if (!opts.express) await settle();
    }
    runMs = now() - t0;
    await settle();
  } finally {
    hooks.end?.();
  }
  const ms = now() - t0;
  return { ok: skipped.length === 0, ran, skipped, ms, runMs: runMs || ms };
}

export async function runMacro(id: string): Promise<MacroRun | null> {
  const m = getMacro(id);
  if (!m || !runtime || running) return null;
  running = true;
  try {
    const actions = runtime.actions();
    const r = await playSteps(m.steps, actions, { begin: runtime.begin, end: runtime.end }, { express: m.express });
    const labelOf = (x: string) => actions.find(a => a.id === x)?.label || x;
    runtime.notify(r.skipped.length
      ? `▶ Macro « ${m.name} » : ${r.ran.length} commande${r.ran.length > 1 ? 's' : ''} jouée${r.ran.length > 1 ? 's' : ''}, ${r.skipped.length} sautée${r.skipped.length > 1 ? 's' : ''} (${r.skipped.slice(0, 2).map(s => `${labelOf(s.id)} : ${s.why}`).join(' ; ')}). Ctrl+Z annule tout.`
      : `▶ Macro « ${m.name} » : ${r.ran.length} commande${r.ran.length > 1 ? 's' : ''} jouée${r.ran.length > 1 ? 's' : ''}. Ctrl+Z annule tout d'un coup.`);
    (globalThis as any).__novaLastMacro = { id, ...r };
    return r;
  } finally { running = false; }
}

/** Les macros, en actions de la palette (« ▶ Macro : … »). */
export function macroPaletteActions(): PaletteAction[] {
  return macros.map(m => ({
    id: `${MACRO_PREFIX}${m.id}`, label: `▶ Macro : ${m.name}`, group: 'Macros',
    keywords: `macro enchaîner ${m.steps.length} commandes`, keys: m.keys ? chordText(m.keys) : undefined,
    run: () => { void runMacro(m.id); },
  }));
}
const chordText = (c: string) => c.split('+').map(p => (p.length === 1 ? p.toUpperCase() : p === 'ctrl' ? 'Ctrl' : p === 'alt' ? 'Alt' : p === 'shift' ? 'Maj' : p[0].toUpperCase() + p.slice(1))).join('+');

function installMacroKeys(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onKey = (e: KeyboardEvent) => {
    if (!macros.length || e.repeat) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest?.('input, textarea, select, [contenteditable="true"], [data-keymap-capture]')) return;
    if (document.querySelector('[data-keymap-capture], [data-macro-capture]')) return;
    const chord = eventChord(e);
    const m = macros.find(x => x.keys === chord);
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    void runMacro(m.id);
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}

// --- Fichier .novamacros -------------------------------------------------------------------
export interface NovamacrosFile { format: 'novamacros'; version: 1; exportedAt: string; macros: Macro[] }

export function exportNovamacros(ids?: string[]): string {
  const list = ids ? macros.filter(m => ids.includes(m.id)) : macros;
  const f: NovamacrosFile = { format: 'novamacros', version: 1, exportedAt: new Date().toISOString(), macros: list.map(clean) };
  return JSON.stringify(f, null, 2);
}

export function importNovamacros(text: string): { ok: boolean; error?: string; added: number; keysDropped: number } {
  let f: any;
  try { f = JSON.parse(text); } catch { return { ok: false, error: 'Fichier illisible (ce n’est pas un fichier .novamacros).', added: 0, keysDropped: 0 }; }
  if (!f || f.format !== 'novamacros' || !Array.isArray(f.macros)) return { ok: false, error: 'Ce n’est pas un fichier de macros NOVA.', added: 0, keysDropped: 0 };
  let added = 0, keysDropped = 0;
  for (const raw of f.macros) {
    if (!isMacro(raw)) continue;
    const m = clean({ ...raw, id: macros.some(x => x.id === raw.id) ? newMacroId() : raw.id });
    // Touche déjà prise ici (raccourci ou autre macro) : la macro arrive sans touche.
    if (m.keys && macroKeyConflict(m.keys, m.id)) { delete m.keys; keysDropped++; }
    macros = [...macros, m];
    added++;
  }
  save();
  return { ok: true, added, keysDropped };
}

/** « Macros » depuis la palette : l'éditeur de raccourcis s'ouvre sur l'onglet Macros. */
let macrosTabNext = false;
export const openMacrosTabNext = () => { macrosTabNext = true; };
export const takeMacrosTabNext = () => { const v = macrosTabNext; macrosTabNext = false; return v; };

/** Pour les tests. */
export const __resetMacrosForTests = () => { macros = []; runtime = null; running = false; };
