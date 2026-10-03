import { describe, expect, it } from 'vitest';
import { autoRegionMap, lyricBlocks, prompterLine, regionAnchors } from '../utils/lyricsTiming';
import type { Marker } from '../types';

const region = (id: string, time: number, endTime: number): Marker => ({ id, name: id, time, endTime, type: 'REGION', color: '#fff' });

const LYRICS = ['Couplet 1', 'ligne a', 'ligne b', '', '', 'Refrain', 'ligne c', '', 'Couplet 2', 'ligne d'];

describe('prompteur calé sur des régions', () => {
  it('découpe les paroles en blocs séparés par des lignes vides', () => {
    expect(lyricBlocks(LYRICS)).toEqual([
      { start: 0, end: 3, title: 'Couplet 1' },
      { start: 5, end: 7, title: 'Refrain' },
      { start: 8, end: 10, title: 'Couplet 2' },
    ]);
    expect(lyricBlocks(['', '  ', ''])).toEqual([]);
  });

  it('sans région : vitesse fixe depuis le départ', () => {
    expect(prompterLine(30, { anchors: [], start: 10, speed: 12 })).toBeCloseTo(4);
    expect(prompterLine(5, { anchors: [], start: 10, speed: 12 })).toBe(0);
  });

  it('un bloc défile exactement sur la durée de sa région', () => {
    const blocks = lyricBlocks(LYRICS);
    const regions = [region('r1', 10, 20), region('r2', 30, 34)];
    const anchors = regionAnchors(blocks, { '0': 'r1', '1': 'r2' }, regions);
    const at = (t: number) => prompterLine(t, { anchors, start: 0, speed: 12 });
    expect(at(0)).toBe(0);          // avant : le 1er bloc attend sur la ligne de lecture
    expect(at(10)).toBe(0);
    expect(at(15)).toBeCloseTo(1.5); // milieu de la région 1 : milieu du bloc (3 lignes)
    expect(at(20)).toBe(3);         // fin de région : fin du bloc
    expect(at(25)).toBeCloseTo(4);  // entre deux régions : glisse vers le bloc suivant
    expect(at(30)).toBe(5);
    expect(at(32)).toBeCloseTo(6);  // région 2 plus courte : défile plus vite
    expect(at(34)).toBe(7);
    expect(at(39)).toBeCloseTo(8);  // après : vitesse fixe (12 lignes / min)
  });

  it('allonger une région ralentit le défilement de son bloc', () => {
    const blocks = lyricBlocks(LYRICS);
    const court = regionAnchors(blocks, { '0': 'r' }, [region('r', 0, 6)]);
    const long = regionAnchors(blocks, { '0': 'r' }, [region('r', 0, 12)]);
    expect(prompterLine(3, { anchors: court, start: 0, speed: 0 })).toBeCloseTo(1.5);
    expect(prompterLine(3, { anchors: long, start: 0, speed: 0 })).toBeCloseTo(0.75);
  });

  it('association automatique dans l\'ordre du temps, régions vides ignorées', () => {
    const blocks = lyricBlocks(LYRICS);
    const map = autoRegionMap(blocks, [region('b', 40, 60), region('a', 0, 20), region('vide', 70, 70)]);
    expect(map).toEqual({ '0': 'a', '1': 'b' });
  });

  it('région supprimée : le bloc repasse à la vitesse fixe', () => {
    const blocks = lyricBlocks(LYRICS);
    expect(regionAnchors(blocks, { '0': 'disparue' }, [])).toEqual([]);
  });
});
