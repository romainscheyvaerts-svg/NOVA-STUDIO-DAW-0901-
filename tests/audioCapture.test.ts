import { describe, it, expect } from 'vitest';
import { CaptureRing, chooseCapture, captureWorkletSource } from '../utils/audioCapture';

const ramp = (from: number, n: number) => Float32Array.from({ length: n }, (_, i) => (from + i) / 1e6);

describe('capture après coup : anneau du micro', () => {
  it('relit exactement ce qui a été écrit, avec son n° d\'échantillon', () => {
    const r = new CaptureRing(1000);
    for (let f = 0; f < 600; f += 128) r.write(ramp(f, 128), f);
    const got = r.read(100, 300)!;
    expect(got.firstFrame).toBe(100);
    expect(Array.from(got.samples)).toEqual(Array.from(ramp(100, 200)));
  });
  it('tourne : ne garde que les N dernières secondes', () => {
    const r = new CaptureRing(1000);
    for (let f = 0; f < 5000; f += 128) r.write(ramp(f, 128), f);
    expect(r.oldestFrame()).toBe(r.endFrame()! - 1000);
    const got = r.read(0, 99999)!;
    expect(got.firstFrame).toBe(r.endFrame()! - 1000);
    expect(got.samples.length).toBe(1000);
    expect(got.samples[0]).toBeCloseTo((r.endFrame()! - 1000) / 1e6, 9);
    expect(got.samples[999]).toBeCloseTo((r.endFrame()! - 1) / 1e6, 9);
  });
  it('lecture arrêtée puis reprise : deux segments, jamais mélangés', () => {
    const r = new CaptureRing(10000);
    for (let f = 0; f < 1024; f += 128) r.write(ramp(f, 128), f);       // 1er passage
    for (let f = 50000; f < 50512; f += 128) r.write(ramp(f, 128), f);  // 2e passage, plus tard
    expect(r.segs.length).toBe(2);
    const last = r.read(0, 1e9)!;
    expect(last.firstFrame).toBe(50000);
    expect(last.samples.length).toBe(512);
    const first = r.read(0, 1024)!;
    expect(first.firstFrame).toBe(0);
    expect(first.samples.length).toBe(1024);
    expect(r.read(2000, 3000)).toBeNull();
  });
  it('le code de l\'AudioWorklet utilise le même anneau (exécuté ici avec un faux AudioWorkletProcessor)', () => {
    const posted: any[] = [];
    let Proc: any = null;
    class FakeProc { port = { postMessage: (m: any) => posted.push(m), onmessage: null as any }; }
    const fn = new Function('AudioWorkletProcessor', 'registerProcessor', 'currentFrame', captureWorkletSource());
    fn(FakeProc, (_name: string, cls: any) => { Proc = cls; }, 0);
    const p = new Proc({ processorOptions: { capacity: 4096 } });
    p.port.onmessage({ data: { type: 'on' } });
    // process() lit currentFrame dans la portée du module : on rejoue avec la même source.
    for (let f = 0; f < 1024; f += 128) p.ring.write(ramp(f, 128), f);
    p.port.onmessage({ data: { type: 'read', id: 7, from: 256, to: 512 } });
    expect(posted[0].id).toBe(7);
    expect(posted[0].firstFrame).toBe(256);
    expect(posted[0].samples.length).toBe(256);
    const out = [[new Float32Array(128)]];
    expect(p.process([[new Float32Array(128).fill(0.5), new Float32Array(128).fill(0.5)]], out)).toBe(true);
    expect(p.ring.endFrame()).toBe(128); // currentFrame = 0 dans ce faux environnement : nouveau segment
  });
});

describe('capture après coup : quel passage', () => {
  it('le dernier passage, un tour de boucle trop court ignoré, borné par la mémoire', () => {
    const runs = [{ from: 10, to: 20, startTime: 10 }, { from: 30, to: 45, startTime: 28 }, { from: 45, to: 45.2, startTime: 41 }];
    expect(chooseCapture(runs, 50, 0)).toEqual({ from: 30, to: 45, songTime: 2 });
    // Mémoire limitée : on ne garde que la fin
    expect(chooseCapture(runs, 50, 40)).toEqual({ from: 40, to: 45, songTime: 12 });
    // Passage en cours (lecture qui tourne encore)
    expect(chooseCapture([{ from: 5, to: null, startTime: 3 }], 9, 0)).toEqual({ from: 5, to: 9, songTime: 2 });
    expect(chooseCapture([], 9, 0)).toBeNull();
    expect(chooseCapture(runs, 50, null)).toBeNull();
  });
});
