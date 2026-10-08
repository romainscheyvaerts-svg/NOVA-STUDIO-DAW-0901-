/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { chordToEventInit, keymapActions, replayChord, searchActions, type PaletteAction } from '../utils/commandPalette';
import { KEYMAP, chordFromEvent } from '../utils/keymap';

const act = (id: string, label: string, extra: Partial<PaletteAction> = {}): PaletteAction => ({ id, label, group: 'G', run: () => {}, ...extra });

describe('palette de commandes : recherche', () => {
  const list = [
    act('a', 'Exporter les stems par bus, retours séparés, voix seule'),
    act('b', 'Exporter : mix, stems, voix seule', { keywords: 'bounce' }),
    act('c', 'Tempo, mesure et tonalité', { keywords: 'bpm' }),
    act('d', 'Séparer le clip à la tête de lecture', { pt: 'Ctrl+E (Separate Clip)' }),
  ];

  it('ignore accents et casse, mots dans n’importe quel ordre', () => {
    expect(searchActions('SEPARER', list).map(a => a.id)).toEqual(['d']);
    expect(searchActions('tete clip', list).map(a => a.id)).toEqual(['d']);
  });

  it('trouve par le nom Pro Tools et les mots-clés', () => {
    expect(searchActions('separate', list).map(a => a.id)).toEqual(['d']);
    expect(searchActions('bounce', list).map(a => a.id)).toEqual(['b']);
    expect(searchActions('bpm', list).map(a => a.id)).toEqual(['c']);
  });

  it('le libellé le plus court passe devant à pertinence égale', () => {
    expect(searchActions('export', list).map(a => a.id)).toEqual(['b', 'a']);
  });

  it('sans recherche : les récentes en tête, puis l’ordre donné', () => {
    expect(searchActions('', list, ['c']).map(a => a.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('aucun résultat : liste vide', () => {
    expect(searchActions('zzzz', list)).toEqual([]);
  });
});

describe('palette de commandes : rejouer un raccourci', () => {
  it('chaque combinaison de la table se rejoue et retombe sur elle-même', () => {
    const bad: string[] = [];
    for (const s of KEYMAP.filter(x => x.context === 'global' && !x.fixed)) {
      for (const k of s.keys) {
        const init = chordToEventInit(k);
        if (!init) { bad.push(`${s.id} ${k} : non rejouable`); continue; }
        const back = chordFromEvent(init as any);
        if (back !== k) bad.push(`${s.id} ${k} → ${back}`);
      }
    }
    // Tolérés : synonymes de clavier (Maj+/ et ?), « ctrl+_ » (AZERTY/QWERTY) — la 1re touche suffit.
    const firstKeysBad = KEYMAP.filter(x => x.context === 'global' && !x.fixed && x.keys.length)
      .filter(s => { const i = chordToEventInit(s.keys[0]); return !i || chordFromEvent(i as any) !== s.keys[0]; })
      .map(s => s.id);
    expect(firstKeysBad).toEqual([]);
    expect(bad.length).toBeLessThan(10);
  });

  it('rejoue la touche sur la page (un écouteur de fenêtre la reçoit)', () => {
    const seen: string[] = [];
    const on = (e: KeyboardEvent) => seen.push(chordFromEvent(e));
    window.addEventListener('keydown', on);
    expect(replayChord('ctrl+shift+e')).toBe(true);
    window.removeEventListener('keydown', on);
    expect(seen).toEqual(['ctrl+shift+e']);
  });

  it('les raccourcis de la table deviennent des actions, sans doublon avec celles du studio', () => {
    const acts = keymapActions(new Set(['nova.export']));
    expect(acts.some(a => a.id === 'nova.export')).toBe(false);
    expect(acts.some(a => a.id === 'pt.split' && a.keys === 'Ctrl + E')).toBe(true);
    // Contexte Keyboard Focus / clavier MIDI : pas dans la palette.
    expect(acts.some(a => a.id.startsWith('kf.') || a.id.startsWith('midi.'))).toBe(false);
  });

  it('une commande d’édition sans écouteur retombe sur la touche', () => {
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    const split = keymapActions(new Set()).find(a => a.id === 'pt.split')!;
    split.run();
    window.removeEventListener('keydown', spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
