import { afterEach, describe, expect, it } from 'vitest';
import { NOVA_RECORDER_WORKLET } from '../engine/NovaRecorder';

/**
 * L'enregistreur de prises (AudioWorklet) exécuté tel quel, avec un faux
 * environnement de rendu : blocs de 128 échantillons, `currentFrame` qui avance,
 * et des blocs SANS entrée (source débranchée ou inactive) au milieu de la prise.
 * Un bloc manquant doit devenir du silence à sa place : la prise reste calée
 * sur l'horloge, sa longueur = le temps écoulé.
 */
type Msg = { type: string; data?: Float32Array | Float32Array[]; first?: number };

function makeRecorder(processorOptions: Record<string, unknown>) {
  let Klass: any = null;
  const g = globalThis as any;
  class FakeProcessor { port: any; constructor() { this.port = { onmessage: null as any, sent: [] as Msg[], postMessage(m: Msg) { this.sent.push(m); } }; } }
  g.AudioWorkletProcessor = FakeProcessor;
  g.registerProcessor = (_n: string, k: any) => { Klass = k; };
  g.currentFrame = 0;
  // eslint-disable-next-line no-new-func
  new Function(NOVA_RECORDER_WORKLET)();
  const p = new Klass({ processorOptions });
  const send = (data: unknown) => p.port.onmessage({ data });
  const out = [[new Float32Array(128)]];
  return {
    start: () => send('start'),
    /** Un bloc de rendu : `inputs` = canaux (vide = aucune entrée). */
    block: (channels: Float32Array[]) => { p.process([channels], out); g.currentFrame += 128; },
    stop: () => {
      send('stop');
      const msgs: Msg[] = p.port.sent;
      const done = msgs.find(m => m.type === 'done')!;
      const mono = msgs.filter(m => m.type === 'data').map(m => m.data as Float32Array);
      const multi = msgs.filter(m => m.type === 'multi').map(m => (m.data as Float32Array[])[0]);
      const parts = mono.length ? mono : multi;
      const n = parts.reduce((s, c) => s + c.length, 0);
      const x = new Float32Array(n);
      let o = 0;
      for (const c of parts) { x.set(c, o); o += c.length; }
      return { x, first: done.first as number };
    },
  };
}

/** Bloc avec un clic à l'échantillon `at` (sinon silence). */
const blk = (at = -1) => { const b = new Float32Array(128); if (at >= 0) b[at] = 1; return b; };

afterEach(() => { const g = globalThis as any; delete g.AudioWorkletProcessor; delete g.registerProcessor; delete g.currentFrame; });

/**
 * 40 blocs : 2 avant la prise, clics aux blocs 5, 15, 25 et 35 (échantillon 17),
 * blocs 10 à 13 et 20 à 21 sans entrée. Renvoie l'écart (échantillons) de chaque clic.
 */
function run(opts: Record<string, unknown>, channels: number) {
  const r = makeRecorder(opts);
  r.block([blk()]); r.block([blk()]);   // avant « start » : rien n'est gardé
  r.start();
  const clicks = [5, 15, 25, 35];
  const hole = (b: number) => (b >= 10 && b <= 13) || (b >= 20 && b <= 21);
  for (let b = 2; b < 40; b++) {
    if (hole(b)) r.block([]);
    else {
      const c = blk(clicks.includes(b) ? 17 : -1);
      r.block(channels === 2 ? [c, blk()] : [c]);
    }
  }
  const { x, first } = r.stop();
  const found: number[] = [];
  for (let i = 0; i < x.length; i++) if (x[i] > 0.4) found.push(first + i);
  const want = clicks.map(b => b * 128 + 17);
  return { first, length: x.length, errors: found.map((f, i) => f - want[i]), found: found.length };
}

describe('enregistreur de prises : un bloc sans entrée ne raccourcit jamais la prise', () => {
  it('mono (Fredonne → MIDI, échauffement) : silence à la place des blocs manquants, clics à 0 échantillon', () => {
    const r = run({}, 1);
    expect(r.first).toBe(2 * 128);
    expect(r.length).toBe(38 * 128);
    expect(r.found).toBe(4);
    expect(r.errors).toEqual([0, 0, 0, 0]);
  });

  it('mono, entrée stéréo moyennée : même calage', () => {
    const r = run({}, 2);
    expect(r.errors).toEqual([0, 0, 0, 0]);
    expect(r.length).toBe(38 * 128);
  });

  it('multipiste (prises normales, InputRouter) : déjà calé, inchangé', () => {
    const r = run({ channels: 1 }, 1);
    expect(r.length).toBe(38 * 128);
    expect(r.errors).toEqual([0, 0, 0, 0]);
  });

  it('ancien comportement (keepClock: false) : la prise raccourcit, les clics arrivent trop tôt (le défaut corrigé)', () => {
    const r = run({ keepClock: false }, 1);
    expect(r.length).toBe(32 * 128);
    // Après les 4 blocs sautés : 512 échantillons trop tôt ; après les 6 : 768.
    expect(r.errors).toEqual([0, -512, -768, -768]);
  });

  it('entrée absente dès le départ : le début de la prise attend la 1re entrée (rien d’inventé avant)', () => {
    const rec = makeRecorder({});
    rec.start();
    rec.block([]); rec.block([]);
    rec.block([blk(5)]);
    rec.block([]);
    rec.block([blk(9)]);
    const { x, first } = rec.stop();
    expect(first).toBe(2 * 128);
    expect(x.length).toBe(3 * 128);
    expect(x[5]).toBe(1);
    expect(x[2 * 128 + 9]).toBe(1);
  });
});
