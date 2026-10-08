import { describe, it, expect } from 'vitest';
import { exportQueue } from '../services/ExportQueue';
import type { ExportResult } from '../services/ExportPipeline';

const result = (name: string): ExportResult => ({
  download: { name, blob: new Blob(['x']) }, files: [],
  report: { lufs: -14, truePeak: -1, lra: 5, gainDb: 0, sampleRate: 44100, seconds: 1 },
});

describe("file d'exports", () => {
  it('exécute les exports un par un, dans l\'ordre, et enregistre à la fin', async () => {
    const saved: string[] = [];
    const order: string[] = [];
    exportQueue.autoSave = () => true;
    exportQueue.save = (_b, n) => { saved.push(n); };
    exportQueue.autoDismissMs = 0;
    let running = 0, maxRunning = 0;
    const job = (n: string) => async (onP: (p: number, t: string) => void) => {
      running++; maxRunning = Math.max(maxRunning, running);
      order.push(`début ${n}`);
      onP(50, 'moitié');
      await new Promise(r => setTimeout(r, 10));
      order.push(`fin ${n}`);
      running--;
      return result(`${n}.wav`);
    };
    const a = exportQueue.enqueue('A', job('A'));
    const b = exportQueue.enqueue('B', job('B'));
    const [ja, jb] = await Promise.all([exportQueue.wait(a), exportQueue.wait(b)]);
    expect(ja.status).toBe('done');
    expect(jb.status).toBe('done');
    expect(maxRunning).toBe(1);
    expect(order).toEqual(['début A', 'fin A', 'début B', 'fin B']);
    expect(saved).toEqual(['A.wav', 'B.wav']);
    expect(ja.saved).toBe(true);
  });
  it('sur écran tactile : pas d\'enregistrement automatique, « Télécharger » le fait (geste)', async () => {
    const saved: string[] = [];
    exportQueue.autoSave = () => false;
    exportQueue.save = (_b, n) => { saved.push(n); };
    const id = exportQueue.enqueue('C', async () => result('C.mp3'));
    const j = await exportQueue.wait(id);
    expect(j.saved).toBe(false);
    expect(saved).toEqual([]);
    await exportQueue.download(id);
    expect(saved).toEqual(['C.mp3']);
    expect(exportQueue.get().find(x => x.id === id)?.saved).toBe(true);
  });
  it('une erreur n\'arrête pas la file', async () => {
    exportQueue.autoSave = () => false;
    const bad = exportQueue.enqueue('KO', async () => { throw new Error('Aucune piste'); });
    const good = exportQueue.enqueue('OK', async () => result('ok.wav'));
    expect((await exportQueue.wait(bad)).error).toBe('Aucune piste');
    expect((await exportQueue.wait(good)).status).toBe('done');
    exportQueue.clearFinished();
    expect(exportQueue.get()).toEqual([]);
  });
});
