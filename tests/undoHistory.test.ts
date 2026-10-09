import { describe, expect, it } from 'vitest';
import { UNDO_LIMIT, isProjectSwitch } from '../utils/undoHistory';

const tr = (id: string) => ({ id } as any);

describe('historique d’annulation (utils/undoHistory)', () => {
  it('assez profond pour une séance de 200 gestes', () => {
    expect(UNDO_LIMIT).toBeGreaterThanOrEqual(200);
  });

  it('ouvrir un autre projet = changement de projet (historique vidé)', () => {
    const a = { id: 'proj-1', tracks: [tr('master'), tr('a')] };
    const b = { id: 'proj-2', tracks: [tr('master'), tr('b')] };
    expect(isProjectSwitch(a, b)).toBe(true);
  });

  it('1re sauvegarde dans le cloud : nouvel identifiant, mêmes pistes → historique gardé', () => {
    const a = { id: 'proj-1', tracks: [tr('master'), tr('a')] };
    expect(isProjectSwitch(a, { id: 'uuid-cloud', tracks: a.tracks })).toBe(false);
    expect(isProjectSwitch(a, { id: 'uuid-cloud', tracks: [a.tracks[0], tr('a2')] })).toBe(false);
  });

  it('édition dans le même projet : jamais un changement de projet', () => {
    const a = { id: 'proj-1', tracks: [tr('master')] };
    expect(isProjectSwitch(a, { id: 'proj-1', tracks: [tr('x')] })).toBe(false);
  });
});
