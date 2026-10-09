import { describe, expect, it } from 'vitest';
import { SelectionHistory, isEmptySnapshot, sameSnapshot, type SelectionSnapshot } from '../utils/selectionMemory';
import { cleanMarkerSelection, isSelectionMarker, selectionFromMarker, selectionMarker } from '../utils/selectionMarkers';
import { markerSig } from '../utils/collabPeers';
import { repairProject } from '../utils/projectRepair';

const range = (start: number, end: number, ids = ['lead']): SelectionSnapshot => ({ time: { start, end, trackIds: ids }, clipIds: [] });
const clips = (...ids: string[]): SelectionSnapshot => ({ time: null, clipIds: ids });
const EMPTY: SelectionSnapshot = { time: null, clipIds: [] };

describe('Restaurer la dernière sélection (Ctrl+Alt+Z, Pro Tools : Restore Last Selection)', () => {
  it('rend la sélection précédente, puis va-et-vient', () => {
    const h = new SelectionHistory();
    h.observe(range(1, 2), 1000);
    h.observe(range(5, 9, ['lead', 'double']), 5000);
    expect(h.restore()).toEqual(range(1, 2));
    h.observe(range(1, 2), 6000); // la vue applique la sélection rendue : pas une nouvelle entrée
    expect(h.restore()).toEqual(range(5, 9, ['lead', 'double']));
    expect(h.restore()).toEqual(range(1, 2));
  });

  it('un glisser (une sélection par image) ne compte qu’une fois', () => {
    const h = new SelectionHistory();
    h.observe(range(1, 2), 1000);
    let t = 5000;
    for (let e = 6.1; e <= 9; e += 0.5) h.observe(range(6, e), (t += 16));
    h.observe(range(6, 9), (t += 16));
    expect(h.restore()).toEqual(range(1, 2));
    expect(h.restore()).toEqual(range(6, 9));
  });

  it('saute les sélections vides (clic dans le vide) et les doublons', () => {
    const h = new SelectionHistory();
    h.observe(clips('a', 'b'), 1000);
    h.observe(EMPTY, 2000);
    h.observe(range(3, 4), 3000);
    h.observe(EMPTY, 4000);
    expect(h.restore()).toEqual(range(3, 4));
    expect(h.restore()).toEqual(clips('a', 'b'));
  });

  it('retire ce qui n’existe plus (piste ou clip supprimés) et passe à la précédente si plus rien', () => {
    const h = new SelectionHistory();
    h.observe(clips('gone'), 1000);
    h.observe(range(1, 2), 2000);
    h.observe(clips('x'), 3000);
    const keep = (s: SelectionSnapshot) => { const o = { time: s.time, clipIds: s.clipIds.filter(id => id !== 'gone') }; return isEmptySnapshot(o) ? null : o; };
    expect(h.restore(keep)).toEqual(range(1, 2));
    expect(h.restore(keep)).toEqual(clips('x'));
  });

  it('rien avant : null', () => {
    const h = new SelectionHistory();
    h.observe(range(1, 2));
    expect(h.restore()).toBeNull();
  });

  it('comparaison des sélections', () => {
    expect(sameSnapshot(clips('a', 'b'), clips('b', 'a'))).toBe(true);
    expect(sameSnapshot(range(1, 2), range(1, 2.5))).toBe(false);
    expect(isEmptySnapshot(EMPTY)).toBe(true);
  });
});

describe('Repère de sélection (Memory Location « Selection »)', () => {
  const sel = { start: 6.86, end: 13.71, trackIds: ['voix-lead', 'backs'] };
  const m = selectionMarker(sel, { id: 'mk-1', number: 3, color: '#00f2ff' });

  it('garde la plage et les pistes ; nom par défaut', () => {
    expect(m).toMatchObject({ name: 'Sélection 3', time: 6.86, type: 'MARKER', selection: { end: 13.71, trackIds: ['voix-lead', 'backs'] } });
    expect(isSelectionMarker(m)).toBe(true);
    expect(isSelectionMarker({ selection: undefined })).toBe(false);
  });

  it('au rappel : la plage revient, sans les pistes supprimées', () => {
    expect(selectionFromMarker(m, ['voix-lead', 'beat'])).toEqual({ start: 6.86, end: 13.71, trackIds: ['voix-lead'] });
    expect(selectionFromMarker(m, ['beat'])).toEqual({ start: 6.86, end: 13.71, trackIds: ['beat'] });
    expect(selectionFromMarker({ ...m, selection: undefined }, ['beat'])).toBeNull();
  });

  it('collaboration : un changement de plage est envoyé (signature)', () => {
    expect(markerSig(m)).not.toBe(markerSig({ ...m, selection: { end: 12, trackIds: ['voix-lead', 'backs'] } }));
    expect(markerSig(m)).not.toBe(markerSig({ ...m, selection: undefined }));
  });

  it('chargement : une plage abîmée est retirée, le repère reste', () => {
    const bad: any = { ...m, id: 'mk-bad', selection: { end: 'x', trackIds: 3 } };
    cleanMarkerSelection(bad);
    expect(bad.selection).toBeUndefined();
    const r = repairProject({ id: 'p', name: 'P', bpm: 120, tracks: [], markers: [bad, m] } as any, {});
    const st: any = r.state || { markers: [bad, m] };
    expect(st.markers.find((x: any) => x.id === 'mk-1').selection).toEqual({ end: 13.71, trackIds: ['voix-lead', 'backs'] });
  });
});
