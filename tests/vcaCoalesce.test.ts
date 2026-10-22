import { describe, expect, it } from 'vitest';
import { coalesceOverflow, coalesceVca } from '../utils/vcaCoalesce';
import { engineView } from '../utils/trackStructure';
import { makeTrack } from './helpers/fixtures';

const db = (g: number) => 20 * Math.log10(g);

describe('fusionner un VCA dans ses pistes (Coalesce)', () => {
  const mk = () => [
    makeTrack({ id: 'a', name: 'Voix', volume: 0.8, vcaId: 'vca', automationLanes: [{ id: 'l', parameterName: 'volume', points: [{ id: 'p', time: 0, value: 1 }, { id: 'q', time: 5, value: 0.5 }], color: '#fff', isExpanded: false, min: 0, max: 1.5 }] }),
    makeTrack({ id: 'b', name: 'Backs', volume: 0.6, vcaId: 'vca' }),
    makeTrack({ id: 'c', name: 'Beat', volume: 1 }),
    makeTrack({ id: 'vca', name: 'VCA voix', isVca: true, volume: 0.5, type: 'BUS' as any }),
  ];

  it('le gain du VCA passe dans le fader et la courbe de chaque membre ; le VCA revient à 0 dB ; le son ne change pas', () => {
    const before = mk();
    const r = coalesceVca(before, 'vca');
    expect(r.members.sort()).toEqual(['a', 'b']);
    expect(db(r.gain)).toBeCloseTo(-6.02, 1);
    const t = (id: string) => r.tracks.find(x => x.id === id)!;
    expect(t('vca').volume).toBe(1);
    expect(t('a').volume).toBeCloseTo(0.4, 6);
    expect(t('b').volume).toBeCloseTo(0.3, 6);
    expect(t('c').volume).toBe(1);
    expect(t('a').automationLanes[0].points.map(p => p.value)).toEqual([0.5, 0.25]);
    // Ce que le moteur joue : gain effectif identique avant / après.
    const eff = (ts: typeof before, id: string) => ts.find(x => x.id === id)!.volume * (engineView(ts).vcaScale.get(id) ?? 1);
    for (const id of ['a', 'b', 'c']) expect(eff(r.tracks, id)).toBeCloseTo(eff(before, id), 9);
  });

  it('VCA à 0 dB ou sans membre : rien à faire', () => {
    const ts = mk().map(t => (t.id === 'vca' ? { ...t, volume: 1 } : t));
    expect(coalesceVca(ts, 'vca').members).toEqual([]);
    expect(coalesceVca(mk(), 'inconnu').members).toEqual([]);
  });

  it('un membre qui dépasserait +12 dB (butée des faders) est signalé', () => {
    const ts = mk().map(t => (t.id === 'vca' ? { ...t, volume: 3 } : t.id === 'a' ? { ...t, volume: 2 } : t));
    expect(coalesceOverflow(coalesceVca(ts, 'vca'))).toEqual(['Voix']);
  });
});
