import { FADER_MAX_GAIN } from '../utils/faderLaw';
import { describe, expect, it } from 'vitest';
import { dragSendLevel, sendDbText, sendLevelAt, sendPos, sendTransferMenuItems, UNITY_SNAP } from '../utils/sendFader';
import { makeTrack } from './helpers/fixtures';
import type { Track } from '../types';

describe('envoi glissé au doigt comme un fader', () => {
  it('même échelle que les faders (−∞ … +12 dB, 0 dB aux 3/4), aller-retour exact', () => {
    for (const l of [0, 0.1, 0.5, 1, 1.5, 3]) expect(sendLevelAt(sendPos(l))).toBeCloseTo(l, 9);
    expect(sendPos(1)).toBe(0.75);
    expect(sendPos(5)).toBe(1);
    expect(sendPos(-1)).toBe(0);
  });

  it('glisser relatif : toute la course du fader = toute la plage, rien ne saute sous le doigt', () => {
    expect(dragSendLevel(0.5, 0, 200)).toBeCloseTo(0.5, 4);
    expect(dragSendLevel(0.5, 1000, 200)).toBeCloseTo(FADER_MAX_GAIN, 4);
    expect(dragSendLevel(0.5, -1000, 200)).toBe(0);
    const up = dragSendLevel(0.2, 30, 200);
    expect(up).toBeGreaterThan(0.2);
    // Deux doigts : 10 fois plus fin.
    const fine = dragSendLevel(0.2, 30, 200, true);
    expect(fine - 0.2).toBeLessThan((up - 0.2) / 5);
  });

  it('aimant sur 0 dB', () => {
    const p1 = sendPos(1);
    const dx = (p1 - sendPos(0.5)) * 200 + (UNITY_SNAP / 2) * 200;
    expect(dragSendLevel(0.5, dx, 200)).toBe(1);
  });

  it('affichage en dB', () => {
    expect(sendDbText(1)).toBe('0 dB');
    expect(sendDbText(0)).toBe('−∞');
    expect(sendDbText(0.5)).toBe('−6,0 dB');
    expect(sendDbText(1.5)).toBe('+3,5 dB');
  });

  it('menu au doigt : copier / déplacer vers les autres pistes (jamais vers le bus lui-même ni le master)', () => {
    const lead = makeTrack({ id: 'lead', name: 'Voix lead', sends: [{ id: 'verb', level: 0.6, isEnabled: true, preFader: true }] });
    const back = makeTrack({ id: 'back', name: 'Backs', sends: [] });
    const verb = makeTrack({ id: 'verb', name: 'Reverb', type: 'SEND' as any, sends: [] });
    const master = makeTrack({ id: 'master', name: 'MASTER', type: 'BUS' as any, sends: [] });
    let tracks: Track[] = [lead, back, verb, master];
    const items = sendTransferMenuItems(lead, lead.sends[0], tracks, 'Reverb', (fn) => { tracks = fn(tracks); });
    expect(items.map(i => i.label)).toEqual(['Copier vers « Backs »', 'Déplacer vers « Backs »']);
    items[0].onClick();
    const s = tracks.find(t => t.id === 'back')!.sends.find(x => x.id === 'verb')!;
    expect(s.level).toBe(0.6);
    expect(s.preFader).toBe(true);
    expect(tracks.find(t => t.id === 'lead')!.sends[0].level).toBe(0.6);
    items[1].onClick();
    expect(tracks.find(t => t.id === 'lead')!.sends[0].level).toBe(0);
  });
});
