import { describe, expect, it } from 'vitest';
import { registerEditCommands, runEditCommand } from '../utils/editCommands';

describe('bus des commandes d’édition : priorité', () => {
  it('la sélection (priorité 10) passe devant la base, même si la base se réinscrit après', () => {
    const appels: string[] = [];
    const offSel = registerEditCommands({ split: () => { appels.push('plage'); return true; } }, 10);
    const offBase = registerEditCommands({ split: () => { appels.push('base'); return true; } });
    runEditCommand('split');
    expect(appels).toEqual(['plage']);
    offSel(); offBase();
  });
  it('sans sélection (false), la base prend le relais', () => {
    const appels: string[] = [];
    const offSel = registerEditCommands({ split: () => false }, 10);
    const offBase = registerEditCommands({ split: () => { appels.push('base'); return true; } });
    expect(runEditCommand('split')).toBe(true);
    expect(appels).toEqual(['base']);
    offSel(); offBase();
  });
});
