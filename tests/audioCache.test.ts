// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAudio } from '../utils/audioCache';

/** Cache Storage minimal (une seule boîte). */
class FakeCache {
  store = new Map<string, Response>();
  async match(url: string) { const r = this.store.get(url); return r ? r.clone() : undefined; }
  async put(url: string, r: Response) { this.store.set(url, r); }
  async delete(url: string) { return this.store.delete(url); }
}
let box: FakeCache;
const bytes = (n: number) => new Uint8Array([n, n, n]).buffer;
const ok = (n: number) => new Response(bytes(n), { status: 200 });

beforeEach(() => {
  box = new FakeCache();
  (globalThis as any).caches = { open: vi.fn(async () => box) };
  localStorage.clear();
});

describe('fetchAudio (cache des beats)', () => {
  it('première écoute : réseau puis mise en cache', async () => {
    const fetchMock = vi.fn(async () => ok(1));
    vi.stubGlobal('fetch', fetchMock);
    const buf = await fetchAudio('https://cdn.example/beat.mp3');
    expect(new Uint8Array(buf)[0]).toBe(1);
    expect(box.store.has('https://cdn.example/beat.mp3')).toBe(true);
  });

  it('déjà en cache : rendu sans attendre le réseau, même hors ligne', async () => {
    box.store.set('https://cdn.example/beat.mp3', ok(7));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('hors ligne'); }));
    const buf = await fetchAudio('https://cdn.example/beat.mp3');
    expect(new Uint8Array(buf)[0]).toBe(7);
  });

  it('erreur HTTP sans cache : exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 404 })));
    await expect(fetchAudio('https://cdn.example/absent.mp3')).rejects.toThrow('404');
  });

  it('adresses blob: / data: : jamais mises en cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(3)));
    await fetchAudio('blob:https://app/123');
    expect(box.store.size).toBe(0);
  });

  it('garde seulement les 20 derniers beats', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(1)));
    for (let i = 0; i < 23; i++) await fetchAudio(`https://cdn.example/b${i}.mp3`);
    await new Promise(r => setTimeout(r, 0));
    expect(box.store.size).toBeLessThanOrEqual(20);
    expect(box.store.has('https://cdn.example/b22.mp3')).toBe(true);
    expect(box.store.has('https://cdn.example/b0.mp3')).toBe(false);
  });
});
