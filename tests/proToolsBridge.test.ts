import { describe, expect, it, vi } from 'vitest';
import { parseBwf } from '../utils/bwf';
import { inputVerdict, inputVerdictMessage, planTake, sanitizePtSettings, takeSig, DEFAULT_PT_SETTINGS } from '../utils/proToolsBridge';
import { ProToolsSink, PtDeps, takesBatchOf, writtenMessage } from '../services/ProToolsBridge';

/** Pont Pro Tools (chantier 9) : quelles prises écrire, où, et le diagnostic de l'entrée diffusée. */

const fakeBuffer = (n: number, sr: number, ch = 1) => {
  const data = Array.from({ length: ch }, (_c, c) => Float32Array.from({ length: n }, (_x, i) => Math.fround(Math.sin(i * (0.01 + c * 0.003)) * 0.5)));
  return { length: n, sampleRate: sr, numberOfChannels: ch, getChannelData: (c: number) => data[c] };
};

function deps(over: Partial<PtDeps> = {}) {
  const store = new Map<string, string>();
  const written: { via: string; name: string; bytes: Uint8Array; folder?: string }[] = [];
  const buffers: Record<string, ReturnType<typeof fakeBuffer>> = { b1: fakeBuffer(48000 * 3, 48000), b2: fakeBuffer(44100 * 2, 44100, 2) };
  let t = 1000;
  const d: PtDeps = {
    getBuffer: (id) => buffers[id],
    bridgeReady: async () => true,
    writeBridge: async (folder, name, bytes) => { written.push({ via: 'bridge', folder, name, bytes }); return { path: `${folder || 'C:\\Docs\\Pro Tools'}\\${name}`, renamed: false }; },
    writeFolder: async (_dir, name, bytes) => { written.push({ via: 'folder', name, bytes }); },
    folderPermission: async () => 'granted',
    download: (name, bytes) => { written.push({ via: 'download', name, bytes }); },
    now: () => (t += 5),
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } },
    ...over,
  };
  return { d, written, buffers, store };
}

const take = (id: string, extra: Record<string, unknown> = {}) => ({ id, bufferId: 'b1', start: 2, offset: 0.25, duration: 2, takeNumber: 3, name: 'Prise 3', ...extra });

describe('réglages', () => {
  it('bornés à la lecture (format, cadence, timecode invalide → défaut)', () => {
    expect(sanitizePtSettings(null)).toEqual(DEFAULT_PT_SETTINGS);
    expect(sanitizePtSettings({ enabled: true, folder: ' D:\\PT ', sessionStart: '01:00:00:00', fps: 30, format: '32f' }))
      .toEqual({ enabled: true, folder: 'D:\\PT', sessionStart: '01:00:00:00', fps: 30, format: '32f' });
    expect(sanitizePtSettings({ sessionStart: '99:00', fps: 29, format: 'mp3' })).toMatchObject({ sessionStart: '00:00:00:00', fps: 25, format: '24' });
  });
  it('gardés d’une visite à l’autre', () => {
    const { d, store } = deps();
    new ProToolsSink(d).setSettings({ enabled: true, format: '32f' });
    expect(new ProToolsSink(d).getSettings()).toMatchObject({ enabled: true, format: '32f' });
    expect(store.size).toBe(1);
  });
});

describe('plan d’une prise', () => {
  it('TimeReference = départ de séance + position du clip, en échantillons', () => {
    const s = sanitizePtSettings({ sessionStart: '01:00:00:00' });
    const p = planTake({ clipId: 'c', bufferId: 'b', start: 2, offset: 0.25, duration: 2, takeNumber: 3 }, 'Voix lead', 'Lina', 48000 * 3, 48000, s)!;
    expect(p.name).toBe('Voix lead_Prise 3_Lina.wav');
    expect(p.region).toEqual({ position: 96000, from: 12000, length: 96000 });
    expect(p.timeReference).toBe(3600 * 48000 + 96000);
  });
});

describe('écriture des prises reçues', () => {
  it('désactivé : rien', async () => {
    const { d, written } = deps();
    const sink = new ProToolsSink(d);
    expect(sink.noteIncoming(takesBatchOf('v', 'Voix lead', 'Lina', [take('c1')]))).toBe(0);
    await sink.idle();
    expect(written).toHaveLength(0);
  });
  it('pont : BWF écrit dans le dossier choisi, au bit près ; même prise reçue deux fois : une seule écriture', async () => {
    const { d, written, buffers } = deps();
    const sink = new ProToolsSink(d);
    sink.setSettings({ enabled: true, folder: 'D:\\Séances\\PT', sessionStart: '01:00:00:00', format: '32f' });
    const onW = vi.fn();
    sink.onWritten = onW;
    sink.noteIncoming(takesBatchOf('v', 'Voix lead', 'Lina', [take('c1'), { id: 'beat', bufferId: 'b1', start: 0, duration: 4 } as any], 'Séance'));
    sink.noteIncoming(takesBatchOf('v', 'Voix lead', 'Lina', [take('c1')], 'Séance'));
    await sink.idle();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ via: 'bridge', folder: 'D:\\Séances\\PT', name: 'Voix lead_Prise 3_Lina.wav' });
    const p = parseBwf(written[0].bytes);
    expect(p.timeReference).toBe(3600 * 48000 + 96000);
    expect(Array.from(p.samples[0] as Float32Array)).toEqual(Array.from(buffers.b1.getChannelData(0).slice(12000, 12000 + 96000)));
    expect(sink.entries[0]).toMatchObject({ status: 'ok', target: 'bridge', position: 96000, file: 'Voix lead_Prise 3_Lina.wav' });
    expect(onW).toHaveBeenCalledTimes(1);
    expect(writtenMessage(sink.entries[0])).toMatch(/Prise envoyée vers Pro Tools : « Voix lead_Prise 3_Lina\.wav » dans le dossier Pro Tools \(Spot à 0:02,000\)/);
  });
  it('prise déplacée par l’artiste : réécrite (mise à jour), même nom', async () => {
    const { d, written } = deps();
    const sink = new ProToolsSink(d);
    sink.setSettings({ enabled: true });
    sink.noteIncoming(takesBatchOf('v', 'Voix lead', 'Lina', [take('c1')]));
    sink.noteIncoming(takesBatchOf('v', 'Voix lead', 'Lina', [take('c1', { start: 3 })]));
    await sink.idle();
    expect(written.map(w => w.name)).toEqual(['Voix lead_Prise 3_Lina.wav', 'Voix lead_Prise 3_Lina.wav']);
    expect(parseBwf(written[1].bytes).timeReference).toBe(3 * 48000);
    expect(sink.entries[0]).toMatchObject({ updated: true, status: 'ok' });
  });
  it('stéréo à 44,1 kHz en 24 bits', async () => {
    const { d, written } = deps();
    const sink = new ProToolsSink(d);
    sink.setSettings({ enabled: true, format: '24' });
    sink.noteIncoming(takesBatchOf('v', 'Double', 'Léo', [{ id: 'c2', bufferId: 'b2', start: 1.5, offset: 0, duration: 1, takeNumber: 1 }]));
    await sink.idle();
    const p = parseBwf(written[0].bytes);
    expect(p).toMatchObject({ sampleRate: 44100, channels: 2, bits: 24, timeReference: 66150, frames: 44100 });
  });
  it('sans pont, dossier du navigateur : accès à redemander → la prise attend « Autoriser », puis part', async () => {
    let perm: 'granted' | 'prompt' = 'prompt';
    const { d, written } = deps({ bridgeReady: async () => false, folderPermission: async (_dir, ask) => (ask ? (perm = 'granted') : perm) });
    const sink = new ProToolsSink(d);
    sink.setSettings({ enabled: true });
    sink.setDir({ name: 'Prises PT' });
    sink.noteIncoming(takesBatchOf('v', 'Voix lead', 'Lina', [take('c1')]));
    await sink.idle();
    expect(written).toHaveLength(0);
    expect(sink.pendingPermission()).toBe(1);
    expect(sink.entries[0].status).toBe('attente');
    expect(await sink.grantFolder()).toBe(true);
    await sink.idle();
    expect(written).toHaveLength(1);
    expect(written[0].via).toBe('folder');
    expect(sink.entries[0].status).toBe('ok');
  });
  it('ni pont ni dossier : téléchargement', async () => {
    const { d, written } = deps({ bridgeReady: async () => false });
    const sink = new ProToolsSink(d);
    sink.setSettings({ enabled: true });
    sink.noteIncoming(takesBatchOf('v', 'Voix lead', 'Lina', [take('c1')]));
    await sink.idle();
    expect(written[0].via).toBe('download');
    expect(writtenMessage(sink.entries[0])).toContain('dans Téléchargements');
  });
  it('échec du pont : erreur affichée, la prise repart à la réception suivante', async () => {
    let fail = true;
    const { d, written } = deps({ writeBridge: async (_f, name, bytes) => { if (fail) throw new Error('Dossier en lecture seule'); written.push({ via: 'bridge', name, bytes }); return { path: name, renamed: false }; } });
    const sink = new ProToolsSink(d);
    sink.setSettings({ enabled: true });
    sink.noteIncoming(takesBatchOf('v', 'Voix lead', 'Lina', [take('c1')]));
    await sink.idle();
    expect(sink.entries[0]).toMatchObject({ status: 'erreur', error: 'Dossier en lecture seule' });
    fail = false;
    sink.noteIncoming(takesBatchOf('v', 'Voix lead', 'Lina', [take('c1')]));
    await sink.idle();
    expect(written).toHaveLength(1);
    expect(sink.entries[0].status).toBe('ok');
  });
  it('réglage changé : les prises déjà écrites ne sont pas réécrites en douce ; « Envoyer les prises déjà là » après forget() les renvoie', async () => {
    const t = { clipId: 'c', bufferId: 'b', start: 1, duration: 1, takeNumber: 1 };
    expect(takeSig(t)).toBe(takeSig({ ...t }));
    expect(takeSig(t)).not.toBe(takeSig({ ...t, start: 1.5 }));
    const { d, written } = deps();
    const sink = new ProToolsSink(d);
    sink.setSettings({ enabled: true, format: '24' });
    sink.noteIncoming(takesBatchOf('v', 'Voix lead', 'Lina', [take('c1')]));
    sink.setSettings({ format: '32f' });
    sink.noteIncoming(takesBatchOf('v', 'Voix lead', 'Lina', [take('c1')]));
    await sink.idle();
    expect(written).toHaveLength(1);
    sink.forget();
    expect(sink.sendExisting([takesBatchOf('v', 'Voix lead', 'Lina', [take('c1')])])).toBe(1);
    await sink.idle();
    expect(parseBwf(written[1].bytes).float).toBe(true);
  });
});

describe('entrée système diffusée : diagnostic', () => {
  const w = (o: Partial<Parameters<typeof inputVerdict>[0]>) => ({ channelCount: 2, msL: 0.01, msR: 0.01, msDiff: 0.02, seconds: 1, silentFor: 0, ...o });
  it('stéréo : gauche et droite différentes', () => expect(inputVerdict(w({}))).toBe('stereo'));
  it('mono annoncé par la piste', () => expect(inputVerdict(w({ channelCount: 1 }))).toBe('mono'));
  it('mono sur deux canaux (G = D)', () => expect(inputVerdict(w({ msDiff: 1e-12 }))).toBe('mono'));
  it('un seul côté', () => {
    expect(inputVerdict(w({ msR: 1e-12, msDiff: 0.01 }))).toBe('gauche');
    expect(inputVerdict(w({ msL: 1e-12, msDiff: 0.01 }))).toBe('droite');
  });
  it('muette au bout de 2 s', () => {
    expect(inputVerdict(w({ msL: 0, msR: 0, msDiff: 0, silentFor: 1 }))).toBe('attente');
    expect(inputVerdict(w({ msL: 0, msR: 0, msDiff: 0, silentFor: 2.1 }))).toBe('muette');
  });
  it('messages clairs', () => {
    expect(inputVerdictMessage('mono', 'CABLE Output').warn).toBe(true);
    expect(inputVerdictMessage('mono', 'CABLE Output').text).toMatch(/Entrée mono/);
    expect(inputVerdictMessage('muette', 'CABLE Output').text).toMatch(/Aucun son sur « CABLE Output »/);
    expect(inputVerdictMessage('stereo', 'CABLE Output')).toMatchObject({ warn: false });
  });
});
