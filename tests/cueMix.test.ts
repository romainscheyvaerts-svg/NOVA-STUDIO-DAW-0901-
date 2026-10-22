import { FADER_MAX_GAIN } from '../utils/faderLaw';
import { describe, expect, it } from 'vitest';
import {
  balanceGains, copyMainMix, cueLevelOf, cueProblems, cueRoutable, defaultCueMixes, directMonitorRoutes, newCueMix, outputLayout,
  outputPairs, pairLabel, sanitizeCueMixes, setCueLevel,
} from '../utils/cueMix';
import { makeTrack } from './helpers/fixtures';

describe('R15 · mixes casque', () => {
  it('deux mixes de départ : artiste sur 3-4, ingé sur 5-6 ; un nouveau prend la paire libre', () => {
    const [a, b] = defaultCueMixes();
    expect([a.name, a.pair, b.name, b.pair]).toEqual(['Casque artiste', 1, 'Casque ingé', 2]);
    expect(pairLabel(a.pair)).toBe('Sorties 3-4');
    expect(newCueMix([a, b]).pair).toBe(3);
    expect(outputPairs(8)).toBe(4);
    expect(outputPairs(2)).toBe(1);
  });

  it('une piste jamais réglée suit le mix principal ; un réglage la détache', () => {
    const t = makeTrack({ id: 'v', volume: 0.5, pan: -0.4 });
    const [m] = defaultCueMixes();
    expect(cueLevelOf(m, t)).toEqual({ level: 0.5, pan: -0.4 });
    const m2 = setCueLevel(m, 'v', { level: 1.2 }, t);
    expect(cueLevelOf(m2, t)).toEqual({ level: 1.2, pan: -0.4 });
    expect(cueLevelOf(setCueLevel(m2, 'v', { muted: true }, t), t).muted).toBe(true);
    expect(cueLevelOf(setCueLevel(m2, 'v', { level: 9, pan: 3 }), t)).toEqual({ level: FADER_MAX_GAIN, pan: 1 });
    const c = copyMainMix(m, [t, makeTrack({ id: 'b', volume: 0.8, pan: 0.2, isMuted: true })]);
    expect(c.levels).toEqual({ v: { level: 0.5, pan: -0.4 }, b: { level: 0.8, pan: 0.2, muted: true } });
  });

  it('loi de balance : au centre, plein niveau des deux côtés', () => {
    expect(balanceGains(1, 0)).toEqual([1, 1]);
    expect(balanceGains(1, -1)).toEqual([1, 0]);
    expect(balanceGains(0.5, 0.5)).toEqual([0.25, 0.5]);
  });

  it('messages clairs : pas de pont, une seule paire, paire absente, même paire', () => {
    const mixes = defaultCueMixes();
    expect(cueProblems(mixes, { bridge: false, outputChannels: 2 })[0].kind).toBe('no-bridge');
    const one = cueProblems(mixes, { bridge: true, outputChannels: 2 });
    expect(one[0].kind).toBe('one-pair');
    expect(one[0].message).toContain('une paire de sorties');
    expect(one[0].message).toContain('Écouter');
    const four = cueProblems(mixes, { bridge: true, outputChannels: 4 });
    expect(four.map(p => p.kind)).toEqual(['pair-missing']);
    expect(four[0].mixIds).toEqual([mixes[1].id]);
    expect(cueProblems(mixes, { bridge: true, outputChannels: 8 })).toEqual([]);
    expect(cueProblems([mixes[0], { ...mixes[1], pair: 1 }], { bridge: true, outputChannels: 8 })[0].kind).toBe('same-pair');
    expect(cueRoutable(mixes[1], { bridge: true, outputChannels: 4 })).toBe(false);
  });

  it('sorties envoyées au pont : master sur 1-2 puis chaque mix routable sur sa paire', () => {
    const [a, b] = defaultCueMixes();
    expect(outputLayout([a, b], { bridge: true, outputChannels: 8 })).toEqual({ dests: [0, 1, 2, 3, 4, 5], mixIds: [a.id, b.id] });
    expect(outputLayout([a, { ...b, muted: true }], { bridge: true, outputChannels: 8 }).dests).toEqual([0, 1, 2, 3]);
    expect(outputLayout([a, b], { bridge: true, outputChannels: 2 }).dests).toEqual([0, 1]);
  });

  it('retour direct dans le pont : voix des pistes armées vers 1-2 et vers la paire de chaque mix', () => {
    const lead = makeTrack({ id: 'lead', volume: 1, pan: 0 });
    // Guitare : entrée stéréo (piste stéréo, G 100 / D 100) ; voix : entrée mono au centre (loi −3 dB).
    const gtr = { ...makeTrack({ id: 'gtr', volume: 1, pan: 0 }), stereo: true };
    let [art, inge] = defaultCueMixes();
    art = setCueLevel(art, 'lead', { level: 1, pan: 0 }, lead);
    art = setCueLevel(art, 'gtr', { level: 0.25, pan: -1 }, gtr);
    inge = setCueLevel(inge, 'lead', { level: 0.5, pan: 0 }, lead);
    const routes = directMonitorRoutes({
      armed: [{ track: lead, channels: [0] }, { track: gtr, channels: [2, 3] }],
      mixes: [art, inge], monitoring: true, monitorLevel: 0.8, outputChannels: 8,
    });
    const g = (i: number, o: number) => routes.find(r => r.in === i && r.out === o)?.gain ?? 0;
    // Sorties 1-2 : retour habituel (niveau du retour casque), pan de la piste à la loi du projet
    // (22/10/2026 : −3 dB au centre, comme la lecture ; avant, une loi de balance à 0 dB).
    const c = Math.round(Math.SQRT1_2 * 1e6) / 1e6;
    expect([g(0, 0), g(0, 1)]).toEqual([Math.round(0.8 * Math.SQRT1_2 * 1e6) / 1e6, Math.round(0.8 * Math.SQRT1_2 * 1e6) / 1e6]);
    expect([g(2, 0), g(3, 1), g(2, 1), g(3, 0)]).toEqual([0.8, 0.8, 0, 0]);       // stéréo : G → G, D → D
    // Casque artiste (3-4) : lead plein (centre −3 dB), guitare à -12 dB, pan du mix « G 100 » : les deux canaux à gauche.
    expect([g(0, 2), g(0, 3)]).toEqual([c, c]);
    expect([g(2, 2), g(3, 2), g(3, 3)]).toEqual([0.25, 0.25, 0]);
    // Casque ingé (5-6) : lead à -6 dB, guitare suit le mix principal (volume 1, G / D).
    expect([g(0, 4), g(0, 5)]).toEqual([Math.round(0.5 * Math.SQRT1_2 * 1e6) / 1e6, Math.round(0.5 * Math.SQRT1_2 * 1e6) / 1e6]);
    expect([g(2, 4), g(3, 5)]).toEqual([1, 1]);
    // Sans retour casque : seuls les mixes casque reçoivent la voix.
    const off = directMonitorRoutes({ armed: [{ track: lead, channels: [0] }], mixes: [art], monitoring: false, monitorLevel: 1, outputChannels: 8 });
    expect(off.every(r => r.out >= 2)).toBe(true);
    // Une seule paire : rien vers 3-4 ; « Écouter » le mix artiste : ses niveaux sur 1-2.
    const one = directMonitorRoutes({ armed: [{ track: lead, channels: [0] }], mixes: [inge], monitoring: true, monitorLevel: 1, outputChannels: 2, listenId: inge.id });
    const h = Math.round(0.5 * Math.SQRT1_2 * 1e6) / 1e6;
    expect(one).toEqual([{ in: 0, out: 0, gain: h }, { in: 0, out: 1, gain: h }]);
    // Loi −6 dB : centre à 0,5 de chaque côté ; loi 0 dB : plein niveau des deux côtés.
    const six = directMonitorRoutes({ panLaw: -6, armed: [{ track: lead, channels: [0] }], mixes: [], monitoring: true, monitorLevel: 1, outputChannels: 2 });
    expect(six).toEqual([{ in: 0, out: 0, gain: 0.5 }, { in: 0, out: 1, gain: 0.5 }]);
    const zero = directMonitorRoutes({ panLaw: 0, armed: [{ track: lead, channels: [0] }], mixes: [], monitoring: true, monitorLevel: 1, outputChannels: 2 });
    expect(zero).toEqual([{ in: 0, out: 0, gain: 1 }, { in: 0, out: 1, gain: 1 }]);
  });

  it('lecture d’un projet : valeurs bornées, champs inconnus ignorés', () => {
    const m = sanitizeCueMixes([{ id: 'x', name: '  Casque  ', pair: 2, click: 9, levels: { a: { level: 5, pan: -3, muted: 1 } }, junk: 1 }, null, 'x']);
    expect(m).toEqual([{ id: 'x', name: 'Casque', pair: 2, click: FADER_MAX_GAIN, master: 1, levels: { a: { level: FADER_MAX_GAIN, pan: -1, muted: true } } }]);
    expect(sanitizeCueMixes('nope')).toEqual([]);
  });
});
