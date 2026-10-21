/**
 * Macros (écart 21) : 5 commandes sur une touche = UNE étape d'annulation, jouées en
 * moins de 100 ms ; commandes absentes ou indisponibles sautées ; jamais de macro dans
 * une macro ; touches uniques et sans conflit avec la table ; export / import.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { PaletteAction } from '../utils/commandPalette';
import {
  __resetMacrosForTests, deleteMacro, exportNovamacros, importNovamacros, listMacros, macroCandidates, macroKeyConflict, macroPaletteActions,
  newMacroId, playSteps, saveMacro,
} from '../utils/macros';
import { closeUndoGroup, openUndoGroup, recordChange, UndoHistory } from '../utils/undoHistory';

type S = { n: number; log: string[] };

/** Historique d'annulation comme dans App (anti-rebond de 0 ms : chaque geste = une étape hors groupe). */
function studio() {
  let h: UndoHistory<S> = { past: [], present: { n: 0, log: [] }, future: [] };
  const set = (fn: (s: S) => S) => { h = recordChange(h, fn(h.present), Date.now() + h.past.length * 1000, { debounceMs: 0, limit: 256, clean: s => s }); };
  const act = (id: string, label = id, extra: Partial<PaletteAction> = {}): PaletteAction => ({ id, label, group: 'Édition', run: () => set(s => ({ n: s.n + 1, log: [...s.log, id] })), ...extra });
  return {
    get: () => h,
    actions: [act('split', 'Séparer le clip'), act('fade', 'Fondu'), act('norm', 'Normaliser'), act('dup', 'Dupliquer'), act('nudge', 'Décaler'),
      act('grise', 'Commande grisée', { disabledReason: 'Sélectionne d’abord un clip.' })],
    hooks: { begin: () => { h = openUndoGroup(h); }, end: () => { h = closeUndoGroup(h); } },
  };
}

beforeEach(() => __resetMacrosForTests());

describe('jouer une macro', () => {
  it('5 commandes = une seule étape d\'annulation, en moins de 100 ms', async () => {
    await playSteps(['split'], studio().actions); // mise en route (compilation à la volée)
    const s = studio();
    const r = await playSteps(['split', 'fade', 'norm', 'dup', 'nudge'], s.actions, s.hooks);
    expect(r.ok).toBe(true);
    expect(r.ran).toEqual(['split', 'fade', 'norm', 'dup', 'nudge']);
    expect(s.get().present.log).toEqual(['split', 'fade', 'norm', 'dup', 'nudge']);
    expect(s.get().past.length).toBe(1);
    expect(s.get().past[0].n).toBe(0);
    expect(r.ms).toBeLessThan(100);
    // Sans macro, les mêmes 5 gestes = 5 étapes.
    const t = studio();
    for (const a of t.actions.slice(0, 5)) a.run();
    expect(t.get().past.length).toBe(5);
  });

  it("express : les 5 commandes d'un coup (une étape), sans attendre l'écran entre elles", async () => {
    const s = studio();
    const r = await playSteps(['split', 'fade', 'norm', 'dup', 'nudge'], s.actions, s.hooks, { express: true });
    expect(r.ran.length).toBe(5);
    expect(s.get().past.length).toBe(1);
    expect(r.runMs).toBeLessThan(20);
    expect(r.runMs).toBeLessThanOrEqual(r.ms);
    expect(saveMacro({ id: 'e', name: 'E', steps: ['split'], express: true }).express).toBe(true);
    expect(saveMacro({ id: 'f', name: 'F', steps: ['split'] }).express).toBeUndefined();
  });

  it('commande absente, grisée ou macro dans la macro : sautée et signalée', async () => {
    const s = studio();
    const r = await playSteps(['split', 'disparue', 'grise', 'macro:x', 'fade'], s.actions, s.hooks);
    expect(r.ran).toEqual(['split', 'fade']);
    expect(r.skipped.map(x => x.id)).toEqual(['disparue', 'grise', 'macro:x']);
    expect(r.skipped[1].why).toMatch(/Sélectionne/);
    expect(r.ok).toBe(false);
    expect(s.get().past.length).toBe(1);
  });
});

describe('macros enregistrées', () => {
  it('nom, étapes (sans macro), touche unique ; palette', () => {
    const a = saveMacro({ id: 'a', name: '  Nettoyer la prise  ', steps: ['split', 'macro:b', 'fade'], keys: 'ctrl+alt+1' });
    expect(a).toMatchObject({ name: 'Nettoyer la prise', steps: ['split', 'fade'], keys: 'ctrl+alt+1' });
    saveMacro({ id: 'b', name: 'Autre', steps: ['norm'], keys: 'ctrl+alt+1' });
    expect(listMacros().find(m => m.id === 'a')!.keys).toBeUndefined();
    const pal = macroPaletteActions();
    expect(pal.map(p => [p.id, p.label, p.group])).toEqual([['macro:a', '▶ Macro : Nettoyer la prise', 'Macros'], ['macro:b', '▶ Macro : Autre', 'Macros']]);
    expect(pal[1].keys).toBe('Ctrl+Alt+1');
    deleteMacro('a');
    expect(listMacros().map(m => m.id)).toEqual(['b']);
  });

  it('touche déjà prise par un raccourci ou une autre macro : refusée avec la raison', () => {
    expect(macroKeyConflict('ctrl+z')).toMatch(/raccourci/);
    saveMacro({ id: 'm', name: 'Ma macro', steps: ['split'], keys: 'ctrl+alt+shift+9' });
    expect(macroKeyConflict('ctrl+alt+shift+9')).toBe('macro « Ma macro »');
    expect(macroKeyConflict('ctrl+alt+shift+9', 'm')).toBeNull();
  });

  it('export .novamacros puis import : mêmes macros ; touche prise ici retirée', () => {
    saveMacro({ id: 'a', name: 'Une', steps: ['split', 'fade'], keys: 'ctrl+alt+shift+8' });
    const text = exportNovamacros();
    expect(JSON.parse(text)).toMatchObject({ format: 'novamacros', version: 1 });
    __resetMacrosForTests();
    saveMacro({ id: 'z', name: 'Déjà là', steps: ['norm'], keys: 'ctrl+alt+shift+8' });
    const r = importNovamacros(text);
    expect(r).toEqual({ ok: true, added: 1, keysDropped: 1 });
    expect(listMacros().map(m => [m.name, m.steps, m.keys])).toEqual([['Déjà là', ['norm'], 'ctrl+alt+shift+8'], ['Une', ['split', 'fade'], undefined]]);
    expect(importNovamacros('{"format":"autre"}').ok).toBe(false);
    expect(importNovamacros('pas du json').error).toMatch(/illisible/);
    expect(newMacroId()).not.toBe(newMacroId());
  });

  it('candidats : ni macros, ni mots chantés, ni tutoriels', () => {
    const acts = [{ id: 'split', label: 'S', group: 'É', run: () => {} }, { id: 'macro:a', label: 'M', group: 'Macros', run: () => {} },
      { id: 'word:1', label: 'W', group: 'Paroles', run: () => {} }, { id: 'howto.x', label: 'H', group: 'Comment faire', run: () => {}, guide: true }];
    expect(macroCandidates(acts).map(a => a.id)).toEqual(['split']);
  });
});
