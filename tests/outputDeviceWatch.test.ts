import { describe, expect, it, vi } from 'vitest';
import { createOutputDeviceWatch } from '../engine/outputDeviceWatch';

/**
 * Carte son débranchée / rebranchée (SIMULÉE : fausse liste de périphériques, faux setSinkId) :
 * repli immédiat sur la sortie de Windows, retour tout seul sur la carte, messages clairs, réglage
 * de l'artiste jamais perdu ; sortie « par défaut » : rien.
 */
const fakeMedia = () => {
  let devices = [
    { kind: 'audiooutput', deviceId: 'default', label: 'Par défaut - Haut-parleurs' },
    { kind: 'audiooutput', deviceId: 'focusrite', label: 'Focusrite USB Audio' },
    { kind: 'audioinput', deviceId: 'mic', label: 'Micro' },
  ];
  const listeners = new Set<() => void>();
  return {
    media: {
      enumerateDevices: async () => devices,
      addEventListener: (_: 'devicechange', fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: 'devicechange', fn: () => void) => { listeners.delete(fn); },
    },
    unplug() { devices = devices.filter(d => d.deviceId !== 'focusrite'); listeners.forEach(f => f()); },
    replug() { devices = [...devices, { kind: 'audiooutput', deviceId: 'focusrite', label: 'Focusrite USB Audio' }]; listeners.forEach(f => f()); },
    blank() { devices = []; listeners.forEach(f => f()); },
    listeners,
  };
};

describe('Sortie audio débranchée / rebranchée', () => {
  it('débranchée : sortie de Windows tout de suite ; rebranchée : retour sur la carte', async () => {
    vi.useFakeTimers();
    const fm = fakeMedia();
    const apply = vi.fn(async (_id: string) => {});
    const notify = vi.fn();
    let wanted = 'focusrite';
    const w = createOutputDeviceWatch({ media: fm.media, wanted: () => wanted, apply, notify, settleMs: 300 });
    await vi.runAllTimersAsync();
    expect(apply).not.toHaveBeenCalled();

    fm.unplug();
    await vi.advanceTimersByTimeAsync(350);
    expect(apply).toHaveBeenLastCalledWith('');
    expect(notify.mock.calls.at(-1)?.[0]).toMatch(/« Focusrite USB Audio » débranchée : le son passe par la sortie par défaut de Windows/);
    expect(w.isLost()).toBe(true);
    expect(wanted).toBe('focusrite'); // le choix de l'artiste reste

    fm.replug();
    await vi.advanceTimersByTimeAsync(350);
    expect(apply).toHaveBeenLastCalledWith('focusrite');
    expect(notify.mock.calls.at(-1)?.[0]).toMatch(/« Focusrite USB Audio » rebranchée/);
    expect(w.isLost()).toBe(false);
    expect(notify).toHaveBeenCalledTimes(2);
    w.dispose();
    expect(fm.listeners.size).toBe(0);
    vi.useRealTimers();
  });

  it('rafale d’annonces de Windows : un seul message', async () => {
    vi.useFakeTimers();
    const fm = fakeMedia();
    const notify = vi.fn();
    createOutputDeviceWatch({ media: fm.media, wanted: () => 'focusrite', apply: async () => {}, notify, settleMs: 300 });
    await vi.runAllTimersAsync();
    fm.unplug(); fm.unplug(); fm.unplug();
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(350);
    expect(notify).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('liste vide (autorisation, liste en cours) : on ne conclut rien', async () => {
    const fm = fakeMedia();
    const apply = vi.fn(async () => {});
    const w = createOutputDeviceWatch({ media: fm.media, wanted: () => 'focusrite', apply, notify: () => {} });
    await w.check();
    fm.blank();
    expect(await w.check()).toBe('ok');
    expect(apply).not.toHaveBeenCalled();
    w.dispose();
  });

  it('sortie par défaut choisie : rien à faire', async () => {
    const fm = fakeMedia();
    const apply = vi.fn(async () => {});
    const w = createOutputDeviceWatch({ media: fm.media, wanted: () => 'default', apply, notify: () => {} });
    fm.unplug();
    expect(await w.check()).toBe('idle');
    expect(apply).not.toHaveBeenCalled();
    w.dispose();
  });
});
