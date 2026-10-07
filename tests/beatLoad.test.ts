import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeatLoadCancelled, __resetBeatLoad, beatLoadStore, cancelBeatLoad, isBeatLoading, loadBeatAudio, retryBeatLoad } from '../utils/beatLoad';

/** Faux réseau : chaque appel renvoie une promesse qu'on résout / rejette à la main. */
function fakeNet() {
  const calls: { signal: AbortSignal; resolve: (b: ArrayBuffer) => void; reject: (e: any) => void }[] = [];
  const fetcher = (_url: string, signal: AbortSignal) => new Promise<ArrayBuffer>((resolve, reject) => { calls.push({ signal, resolve, reject }); });
  return { calls, fetcher };
}

describe('loadBeatAudio (B6 : beat qui n’arrive pas)', () => {
  beforeEach(() => { vi.useFakeTimers(); __resetBeatLoad(); });
  afterEach(() => { vi.useRealTimers(); });

  it('chargement normal : REC bloqué pendant, libéré après', async () => {
    const net = fakeNet();
    const p = loadBeatAudio('u', 'NOCTAMBULE', net.fetcher);
    expect(isBeatLoading()).toBe(true);
    expect(beatLoadStore.get().phase).toBe('loading');
    net.calls[0].resolve(new ArrayBuffer(8));
    await expect(p).resolves.toBeInstanceOf(ArrayBuffer);
    expect(isBeatLoading()).toBe(false);
  });

  it('au bout de 15 s : « slow » ; Réessayer coupe et relance', async () => {
    const net = fakeNet();
    const p = loadBeatAudio('u', 'NOCTAMBULE', net.fetcher);
    vi.advanceTimersByTime(14999);
    expect(beatLoadStore.get().phase).toBe('loading');
    vi.advanceTimersByTime(1);
    expect(beatLoadStore.get().phase).toBe('slow');
    retryBeatLoad();
    expect(net.calls).toHaveLength(2);
    expect(net.calls[0].signal.aborted).toBe(true);
    expect(beatLoadStore.get()).toMatchObject({ phase: 'loading', attempt: 2 });
    // L'ancien téléchargement qui arrive en retard est ignoré.
    net.calls[0].reject(new Error('aborted'));
    await Promise.resolve();
    expect(beatLoadStore.get().phase).toBe('loading');
    const buf = new ArrayBuffer(4);
    net.calls[1].resolve(buf);
    await expect(p).resolves.toBe(buf);
  });

  it('erreur réseau : « failed » (pas d’abandon silencieux), Réessayer peut réussir', async () => {
    const net = fakeNet();
    const p = loadBeatAudio('u', 'B', net.fetcher);
    net.calls[0].reject(new Error('Failed to fetch'));
    await Promise.resolve(); await Promise.resolve();
    expect(beatLoadStore.get()).toMatchObject({ phase: 'failed', error: 'Failed to fetch' });
    expect(isBeatLoading()).toBe(true);
    retryBeatLoad();
    net.calls[1].resolve(new ArrayBuffer(2));
    await expect(p).resolves.toBeInstanceOf(ArrayBuffer);
  });

  it('« Choisir un autre beat » annule (raison user) et libère REC', async () => {
    const net = fakeNet();
    const p = loadBeatAudio('u', 'B', net.fetcher);
    cancelBeatLoad();
    await expect(p).rejects.toMatchObject({ reason: 'user' });
    expect(net.calls[0].signal.aborted).toBe(true);
    expect(isBeatLoading()).toBe(false);
  });

  it('un nouveau beat remplace celui qui n’arrivait pas', async () => {
    const net = fakeNet();
    const p1 = loadBeatAudio('u1', 'A', net.fetcher);
    const p2 = loadBeatAudio('u2', 'B', net.fetcher);
    await expect(p1).rejects.toBeInstanceOf(BeatLoadCancelled);
    expect(beatLoadStore.get()).toMatchObject({ phase: 'loading', title: 'B' });
    net.calls[1].resolve(new ArrayBuffer(1));
    await expect(p2).resolves.toBeInstanceOf(ArrayBuffer);
  });
});
