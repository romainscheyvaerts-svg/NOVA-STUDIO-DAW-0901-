// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAudio, fetchAudioPreview, noteAudioVersion, PREVIEW_BYTES, REVALIDATE_MS, trimmedWav, previewBytesNeeded } from '../utils/audioCache';
import { catalogStatus } from '../utils/catalogStatus';

/** Cache Storage minimal (une boîte par nom). */
class FakeCache {
  store = new Map<string, Response>();
  async match(url: string) { const r = this.store.get(url); return r ? r.clone() : undefined; }
  async put(url: string, r: Response) { this.store.set(url, r); }
  async delete(url: string) { return this.store.delete(url); }
}
let boxes: Map<string, FakeCache>;
const box = (name = 'nova-audio-v1') => { if (!boxes.has(name)) boxes.set(name, new FakeCache()); return boxes.get(name)!; };
const bytes = (n: number) => new Uint8Array([n, n, n]).buffer;
const ok = (n: number) => new Response(bytes(n), { status: 200 });
const flush = () => new Promise(r => setTimeout(r, 0));

/** Serveur simulé : fichier de `size` octets, plages HTTP honorées ou non. */
function server(size: number, opts: { ranges?: boolean; status?: number } = {}) {
  const file = new Uint8Array(size).map((_, i) => i % 251);
  const calls: { range: string | null; headers: Record<string, string> }[] = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers || {}) as Record<string, string>;
    const range = headers.Range || null;
    calls.push({ range, headers });
    if (opts.status) return new Response('{"message":"Service for this project is restricted: exceed_egress_quota"}', { status: opts.status });
    const m = /bytes=(\d+)-(\d*)/.exec(range || '');
    if (m && opts.ranges !== false) {
      const a = +m[1], b = m[2] ? Math.min(+m[2], size - 1) : size - 1;
      return new Response(file.slice(a, b + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${size}`, 'content-type': 'audio/mpeg' } });
    }
    return new Response(file.slice(), { status: 200, headers: { 'content-length': String(size), 'content-type': 'audio/mpeg' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { file, calls, fetchMock };
}

beforeEach(() => {
  boxes = new Map();
  (globalThis as any).caches = { open: vi.fn(async (name: string) => box(name)) };
  localStorage.clear();
  catalogStatus.reset();
});

describe('fetchAudio (cache des beats)', () => {
  it('première écoute : réseau puis mise en cache', async () => {
    const fetchMock = vi.fn(async () => ok(1));
    vi.stubGlobal('fetch', fetchMock);
    const buf = await fetchAudio('https://cdn.example/beat.mp3');
    expect(new Uint8Array(buf)[0]).toBe(1);
    expect(box().store.has('https://cdn.example/beat.mp3')).toBe(true);
  });

  it('déjà en cache : rendu sans attendre le réseau, même hors ligne', async () => {
    box().store.set('https://cdn.example/beat.mp3', ok(7));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('hors ligne'); }));
    const buf = await fetchAudio('https://cdn.example/beat.mp3');
    expect(new Uint8Array(buf)[0]).toBe(7);
  });

  it('déjà en cache et récent : AUCUNE requête (avant : retéléchargement complet en arrière-plan)', async () => {
    const s = server(5000);
    await fetchAudio('https://cdn.example/r.mp3');
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
    await fetchAudio('https://cdn.example/r.mp3');
    await fetchAudio('https://cdn.example/r.mp3');
    await flush();
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('version de la fiche inchangée : aucune requête, même ancien ; version changée : nouveau téléchargement', async () => {
    const s = server(4000);
    noteAudioVersion('https://cdn.example/v.mp3', '2026-09-14');
    await fetchAudio('https://cdn.example/v.mp3');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + REVALIDATE_MS * 3);
    await fetchAudio('https://cdn.example/v.mp3'); await flush();
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
    noteAudioVersion('https://cdn.example/v.mp3', '2026-10-01');
    await fetchAudio('https://cdn.example/v.mp3');
    expect(s.fetchMock).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('vieux de plus de 7 jours sans version : vérification d\'UN octet, pas du fichier', async () => {
    const s = server(9000);
    await fetchAudio('https://cdn.example/old.mp3');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + REVALIDATE_MS + 1000);
    await fetchAudio('https://cdn.example/old.mp3');
    await flush(); await flush(); await flush();
    expect(s.calls.length).toBe(2);
    expect(s.calls[1].range).toBe('bytes=0-0');
    vi.restoreAllMocks();
  });

  it('erreur HTTP sans cache : exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 404 })));
    await expect(fetchAudio('https://cdn.example/absent.mp3')).rejects.toThrow('404');
  });

  it('quota Supabase dépassé (402) : exception claire, et plus aucune requête pendant le délai', async () => {
    const s = server(1000, { status: 402 });
    const url = 'https://mxdrxpzxbgybchzzvpkf.supabase.co/functions/v1/stream-instrumental?fileId=x';
    await expect(fetchAudio(url)).rejects.toThrow('402');
    expect(catalogStatus.get()?.kind).toBe('quota');
    await expect(fetchAudio(url)).rejects.toThrow();
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adresses blob: / data: : jamais mises en cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(3)));
    await fetchAudio('blob:https://app/123');
    expect(box().store.size).toBe(0);
  });

  it('garde les 40 derniers beats', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(1)));
    for (let i = 0; i < 43; i++) await fetchAudio(`https://cdn.example/b${i}.mp3`);
    await flush();
    expect(box().store.size).toBeLessThanOrEqual(40);
    expect(box().store.has('https://cdn.example/b42.mp3')).toBe(true);
    expect(box().store.has('https://cdn.example/b0.mp3')).toBe(false);
  });
});

describe('fetchAudioPreview (écoute dans le catalogue)', () => {
  const size = PREVIEW_BYTES * 5;

  it('plage HTTP : seulement le début du fichier', async () => {
    const s = server(size);
    const p = await fetchAudioPreview('https://cdn.example/p.mp3');
    expect(p.complete).toBe(false);
    expect(p.data.byteLength).toBe(PREVIEW_BYTES);
    expect(s.calls[0].range).toBe(`bytes=0-${PREVIEW_BYTES - 1}`);
  });

  it('réécoute : depuis le cache, aucune requête', async () => {
    const s = server(size);
    await fetchAudioPreview('https://cdn.example/p.mp3');
    await fetchAudioPreview('https://cdn.example/p.mp3');
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('beat choisi après l\'écoute : seulement la SUITE est téléchargée, fichier exact', async () => {
    const s = server(size);
    await fetchAudioPreview('https://cdn.example/p.mp3');
    const full = new Uint8Array(await fetchAudio('https://cdn.example/p.mp3'));
    expect(s.calls[1].range).toBe(`bytes=${PREVIEW_BYTES}-`);
    expect(full.byteLength).toBe(size);
    expect(full.every((v, i) => v === s.file[i])).toBe(true);
    // et ensuite : plus rien
    await fetchAudioPreview('https://cdn.example/p.mp3');
    await fetchAudio('https://cdn.example/p.mp3'); await flush();
    expect(s.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serveur sans plages (200) : on ne lit que le début puis on coupe', async () => {
    // Corps envoyé par morceaux de 64 Ko, comme sur le réseau : on compte ce qui est tiré.
    let pulled = 0;
    const CH = 65_536;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(c) { if (pulled * CH >= size) { c.close(); return; } pulled++; c.enqueue(new Uint8Array(CH)); },
    }), { status: 200, headers: { 'content-length': String(size), 'content-type': 'audio/mpeg' } })));
    const p = await fetchAudioPreview('https://cdn.example/np.mp3');
    expect(p.complete).toBe(false);
    expect(p.data.byteLength).toBe(PREVIEW_BYTES);
    expect(pulled * CH).toBeLessThanOrEqual(PREVIEW_BYTES + 2 * CH);
  });

  it('petit fichier : rendu entier, gardé comme fichier complet', async () => {
    const s = server(2000);
    const p = await fetchAudioPreview('https://cdn.example/small.mp3');
    expect(p.complete).toBe(true);
    await fetchAudio('https://cdn.example/small.mp3');
    expect(s.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('extraits WAV / MP3', () => {
  const wav = (dataBytes: number) => {
    const b = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(b);
    const w = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, 44100, true); dv.setUint32(28, 176400, true);
    dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, 1_000_000, true);
    return b;
  };

  it('WAV tronqué : tailles RIFF / data ramenées à ce qui est là', () => {
    const out = new DataView(trimmedWav(wav(1002)));
    expect(out.getUint32(40, true)).toBe(1000);
    expect(out.getUint32(4, true)).toBe(out.byteLength - 8);
  });

  it('WAV : il faut ≈ 30 s (plafonné), MP3 avec grosse pochette intégrée : étiquette + extrait', () => {
    expect(previewBytesNeeded(wav(100))).toBeGreaterThan(PREVIEW_BYTES);
    const id3 = new Uint8Array(20); id3.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0x10, 0, 0]); // 262 144 octets d'étiquette
    expect(previewBytesNeeded(id3.buffer)).toBe(10 + 262_144 + PREVIEW_BYTES);
    const small = new Uint8Array(20); small.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 40]);
    expect(previewBytesNeeded(small.buffer)).toBe(PREVIEW_BYTES);
  });
});
