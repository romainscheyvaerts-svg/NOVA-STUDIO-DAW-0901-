import { describe, expect, it } from 'vitest';
import {
  accumulateSegment, cellularFrom, describeWebStemsError, etaSeconds, fillSegment, fitLength, formatEstimate, mixStats,
  ORT_WEB, restOf, segmentOffsets, segmentWeight, separateChannels, STEMS_WEB_MODEL, STEMS_WEB_SEGMENT, STEMS_WEB_SOURCES,
  stemsWebDownloadBytes, webStemPlan, webStemsVerdict, type SegmentRunner, type WebStemsCaps,
} from '../utils/stemsWeb';

/** Petit segment pour des tests rapides (le vrai fait 343 980 échantillons). */
const SEG = 1000;

const noise = (n: number, seed: number) => {
  let s = seed >>> 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = (s / 2 ** 32 - 0.5) * 0.6; }
  return out;
};

/**
 * Faux modèle : chaque source = un gain fixe × le segment d'entrée (la voix = 0,3 × le mélange…).
 * Un découpage ou un recollage faux (décalage, poids, bourrage du dernier segment) casse l'égalité.
 */
const GAINS = [0.1, 0.15, 0.2, 0.3, 0.05, 0.02];
const fakeModel = (segment = SEG, calls: Float32Array[] = []): SegmentRunner => async (input) => {
  calls.push(new Float32Array(input));
  const out = new Float32Array(STEMS_WEB_SOURCES.length * 2 * segment);
  STEMS_WEB_SOURCES.forEach((_, s) => {
    for (let ch = 0; ch < 2; ch++) for (let i = 0; i < segment; i++) out[(s * 2 + ch) * segment + i] = GAINS[s] * input[ch * segment + i];
  });
  return out;
};

const maxAbs = (a: Float32Array, b: Float32Array) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

describe('découpage en segments (comme demucs.apply_model, overlap 0,25)', () => {
  it('pas de 75 % du segment, de 0 jusqu’à la fin', () => {
    expect(segmentOffsets(750, 1000)).toEqual([0]);
    expect(segmentOffsets(1000, 1000)).toEqual([0, 750]); // range(0, 1000, 750), comme Demucs
    expect(segmentOffsets(1001, 1000)).toEqual([0, 750]);
    expect(segmentOffsets(2600, 1000)).toEqual([0, 750, 1500, 2250]);
    // 3 min 10 à 44,1 kHz → 33 passages de 7,8 s (pas de 257 985 échantillons).
    expect(segmentOffsets(Math.round(189.9 * 44100))).toHaveLength(33);
    expect(segmentOffsets(Math.round(189.9 * 44100))[1]).toBe(257985);
  });

  it('fenêtre triangulaire symétrique, sommet à 1, jamais nulle', () => {
    const w = segmentWeight(10);
    expect(Array.from(w).map(x => +x.toFixed(2))).toEqual([0.2, 0.4, 0.6, 0.8, 1, 1, 0.8, 0.6, 0.4, 0.2]);
    const big = segmentWeight(STEMS_WEB_SEGMENT);
    expect(big[0]).toBeGreaterThan(0);
    expect(Math.max(...big.subarray(171980, 172000))).toBe(1);
    expect(big[STEMS_WEB_SEGMENT - 1]).toBeCloseTo(big[0], 9);
  });

  it('segment plein : copie exacte gauche puis droite', () => {
    const l = noise(3000, 1), r = noise(3000, 2);
    const into = new Float32Array(2 * SEG);
    expect(fillSegment(l, r, 750, into, SEG)).toBe(SEG);
    expect(into.subarray(0, SEG)).toEqual(l.subarray(750, 1750));
    expect(into.subarray(SEG)).toEqual(r.subarray(750, 1750));
  });

  it('dernier segment plus court : centré, complété par le son d’avant puis des zéros (TensorChunk.padded)', () => {
    const l = noise(2600, 3), r = noise(2600, 4);
    const into = new Float32Array(2 * SEG);
    const chunk = fillSegment(l, r, 2250, into, SEG); // 350 utiles, 650 à compléter : 325 avant, 325 après
    expect(chunk).toBe(350);
    expect(into.subarray(0, 675)).toEqual(l.subarray(1925, 2600));
    expect(Array.from(into.subarray(675, SEG)).every(x => x === 0)).toBe(true);
    expect(into.subarray(SEG, SEG + 675)).toEqual(r.subarray(1925, 2600));
  });

  it('morceau plus court qu’un segment : centré, zéros des deux côtés', () => {
    const l = noise(400, 5), r = noise(400, 6);
    const into = new Float32Array(2 * SEG).fill(9);
    expect(fillSegment(l, r, 0, into, SEG)).toBe(400);
    expect(Array.from(into.subarray(0, 300)).every(x => x === 0)).toBe(true);
    expect(into.subarray(300, 700)).toEqual(l);
    expect(Array.from(into.subarray(700, SEG)).every(x => x === 0)).toBe(true);
  });
});

describe('recollage pondéré', () => {
  it('modèle identité : chaque échantillon revient à sa place, au bit près (poids normalisés)', () => {
    const n = 2600;
    const l = noise(n, 7), r = noise(n, 8);
    const plan = { computed: [{ key: 'vocals' as const, sources: [3] }] };
    const acc = [[new Float32Array(n), new Float32Array(n)]];
    const ws = new Float32Array(n);
    const w = segmentWeight(SEG);
    const into = new Float32Array(2 * SEG);
    for (const o of segmentOffsets(n, SEG)) {
      const chunk = fillSegment(l, r, o, into, SEG);
      const out = new Float32Array(6 * 2 * SEG);
      out.set(into.subarray(0, SEG), (3 * 2 + 0) * SEG);
      out.set(into.subarray(SEG), (3 * 2 + 1) * SEG);
      accumulateSegment(acc, ws, out, plan, o, chunk, w, SEG);
    }
    const back = acc[0].map(a => a.map((x, i) => x / ws[i]));
    expect(maxAbs(back[0], l)).toBeLessThan(1e-6);
    expect(maxAbs(back[1], r)).toBeLessThan(1e-6);
  });

  it('les sources d’un même stem s’additionnent (4 stems : « autres » = reste)', () => {
    expect(webStemPlan(2)).toEqual({ keys: ['vocals', 'instrumental'], computed: [{ key: 'vocals', sources: [3] }], rest: 'instrumental' });
    const p4 = webStemPlan(4);
    expect(p4.keys).toEqual(['vocals', 'drums', 'bass', 'other']);
    expect(p4.computed.map(c => STEMS_WEB_SOURCES[c.sources[0]])).toEqual(['vocals', 'drums', 'bass']);
    expect(p4.rest).toBe('other');
  });
});

describe('separateChannels (faux modèle, segments de 1000)', () => {
  it('2 stems stéréo 44,1 kHz : voix = 0,3 × mélange ; voix + instru = original au bit près', async () => {
    const n = 4321;
    const ch = [noise(n, 11), noise(n, 12)];
    const prog: number[] = [];
    const stems = await separateChannels(ch, 44100, 2, fakeModel(), { segment: SEG, onProgress: p => prog.push(p.done) });
    expect(stems.map(s => s.key)).toEqual(['vocals', 'instrumental']);
    const [v, inst] = stems;
    // Normalisation (moyenne, écart type) puis retour : la voix vaut 0,3 × (mix − m) + m.
    const { mean } = mixStats(ch[0], ch[1]);
    for (let c = 0; c < 2; c++) {
      const want = ch[c].map(x => 0.3 * (x - mean) + mean);
      expect(maxAbs(v.channels[c], want)).toBeLessThan(1e-5);
      const sum = v.channels[c].map((x, i) => x + inst.channels[c][i]);
      expect(maxAbs(sum, ch[c])).toBeLessThan(1e-6);
      expect(v.channels[c].length).toBe(n);
    }
    expect(prog).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('4 stems : voix, batterie, basse calculées, « autres » = original − le reste', async () => {
    const n = 2500;
    const ch = [noise(n, 21), noise(n, 22)];
    const stems = await separateChannels(ch, 44100, 4, fakeModel(), { segment: SEG });
    expect(stems.map(s => s.key)).toEqual(['vocals', 'drums', 'bass', 'other']);
    const { mean } = mixStats(ch[0], ch[1]);
    expect(maxAbs(stems[1].channels[0], ch[0].map(x => 0.1 * (x - mean) + mean))).toBeLessThan(1e-5);
    expect(maxAbs(stems[2].channels[1], ch[1].map(x => 0.15 * (x - mean) + mean))).toBeLessThan(1e-5);
    for (let c = 0; c < 2; c++) {
      const sum = ch[c].map((_, i) => stems.reduce((a, s) => a + s.channels[c][i], 0));
      expect(maxAbs(sum, ch[c])).toBeLessThan(1e-6);
    }
  });

  it('mono : le modèle reçoit le même canal à gauche et à droite, les stems ressortent en mono', async () => {
    const n = 1800;
    const mono = noise(n, 31);
    const calls: Float32Array[] = [];
    const stems = await separateChannels([mono], 44100, 2, fakeModel(SEG, calls), { segment: SEG });
    expect(calls[0].subarray(0, SEG)).toEqual(calls[0].subarray(SEG));
    expect(stems[0].channels).toHaveLength(1);
    const sum = stems[0].channels[0].map((x, i) => x + stems[1].channels[0][i]);
    expect(maxAbs(sum, mono)).toBeLessThan(1e-6);
  });

  it('48 kHz : calcul à 44,1 kHz, stems rendus à 48 kHz et à la longueur exacte du clip', async () => {
    const n = 4800;
    const ch = [noise(n, 41), noise(n, 42)];
    const calls: Float32Array[] = [];
    const stems = await separateChannels(ch, 48000, 2, fakeModel(SEG, calls), { segment: SEG });
    // 4800 à 48 kHz = 4410 à 44,1 kHz → 6 passages de 1000 (pas de 750).
    expect(calls).toHaveLength(6);
    for (const s of stems) for (const c of s.channels) expect(c.length).toBe(n);
    for (let c = 0; c < 2; c++) {
      const sum = stems[0].channels[c].map((x, i) => x + stems[1].channels[c][i]);
      expect(maxAbs(sum, ch[c])).toBeLessThan(1e-6);
    }
  });

  it('arrêt demandé entre deux segments : erreur « cancelled », rien de rendu', async () => {
    let k = 0;
    await expect(separateChannels([noise(5000, 51), noise(5000, 52)], 44100, 2, fakeModel(), { segment: SEG, stop: () => ++k > 2 }))
      .rejects.toMatchObject({ code: 'cancelled' });
  });

  it('sortie du modèle trop courte : erreur claire', async () => {
    await expect(separateChannels([noise(900, 1), noise(900, 2)], 44100, 2, async () => new Float32Array(10), { segment: SEG }))
      .rejects.toThrow(/Sortie du modèle inattendue/);
  });

  it('temps restant : moyenne des passages (le 1er, plus lent, écarté)', async () => {
    expect(etaSeconds([], 5)).toBeNull();
    expect(etaSeconds([2000], 3)).toBe(6);
    expect(etaSeconds([5000, 500, 500], 10)).toBe(5);
    let t = 0;
    const etas: (number | null)[] = [];
    await separateChannels([noise(3000, 1), noise(3000, 2)], 44100, 2, fakeModel(), {
      segment: SEG, now: () => (t += 500), onProgress: p => etas.push(p.etaSec),
    });
    expect(etas[0]).toBeNull();
    expect(etas[etas.length - 1]).toBe(0);
  });
});

describe('outils', () => {
  it('fitLength et restOf', () => {
    expect(Array.from(fitLength(new Float32Array([1, 2, 3]), 5))).toEqual([1, 2, 3, 0, 0]);
    expect(Array.from(fitLength(new Float32Array([1, 2, 3]), 2))).toEqual([1, 2]);
    const r = restOf([new Float32Array([1, 1])], [[new Float32Array([0.25, 0.5])], [new Float32Array([0.25, 0])]]);
    expect(Array.from(r[0])).toEqual([0.5, 0.5]);
  });

  it('mixStats : écart type non biaisé, silence → 1 (pas de division par zéro)', () => {
    const s = mixStats(new Float32Array([1, 3]), new Float32Array([1, 3]));
    expect(s.mean).toBe(2);
    expect(s.std).toBeCloseTo(Math.SQRT2, 9);
    expect(mixStats(new Float32Array(10), new Float32Array(10))).toEqual({ mean: 0, std: 1 });
  });

  it('modèle et moteur : adresses figées sur un commit / une version, empreintes SHA-256', () => {
    for (const s of STEMS_WEB_MODEL.sources) {
      expect(s.url).toMatch(/^https:\/\/huggingface\.co\/[\w-]+\/[\w-]+\/resolve\/[0-9a-f]{40}\/htdemucs_6s\.onnx$/);
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(ORT_WEB.base).toBe('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/');
    expect(ORT_WEB.js.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ORT_WEB.wasm.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stemsWebDownloadBytes()).toBeGreaterThan(246e6);
    expect(stemsWebDownloadBytes()).toBeLessThan(260e6);
  });
});

describe('choix du moteur et avertissements', () => {
  const pc: WebStemsCaps = { webgpu: true, mobile: false, deviceMemoryGb: 8, cellular: false, networkUnknown: false };

  it('PC avec carte graphique : OK, quelques secondes à une minute par minute de son', () => {
    const v = webStemsVerdict(pc, 190);
    expect(v).toMatchObject({ backend: 'webgpu', level: 'ok' });
    expect(v.estimate[0]).toBeLessThan(40);
    expect(formatEstimate(v.estimate)).toMatch(/s à .*min|min/);
  });

  it('PC sans WebGPU : processeur, « lent » mais possible', () => {
    expect(webStemsVerdict({ ...pc, webgpu: false }, 190)).toMatchObject({ backend: 'wasm', level: 'slow' });
  });

  it('téléphone sans WebGPU, ou peu de mémoire, ou clip trop long : on conseille le PC', () => {
    expect(webStemsVerdict({ ...pc, webgpu: false, mobile: true }, 190).level).toBe('too-weak');
    expect(webStemsVerdict({ ...pc, deviceMemoryGb: 2 }, 190).level).toBe('too-weak');
    expect(webStemsVerdict(pc, 11 * 60)).toMatchObject({ level: 'too-weak', reason: expect.stringMatching(/trop long/) });
    expect(webStemsVerdict({ ...pc, mobile: true }, 190).level).toBe('slow');
  });

  it('formatEstimate', () => {
    expect(formatEstimate([10, 45])).toBe('10 à 45 s');
    expect(formatEstimate([120, 600])).toBe('2 à 10 min');
    expect(formatEstimate([30, 200])).toBe('30 s à 3 min');
    expect(formatEstimate([60, 60])).toBe('environ 60 s');
  });

  it('réseau mobile : type cellulaire, 3G ou économie de données ; inconnu sans l’API', () => {
    expect(cellularFrom({ type: 'cellular' }).cellular).toBe(true);
    expect(cellularFrom({ effectiveType: '3g' }).cellular).toBe(true);
    expect(cellularFrom({ effectiveType: '4g', saveData: true }).cellular).toBe(true);
    expect(cellularFrom({ type: 'wifi', effectiveType: '4g' })).toEqual({ cellular: false, unknown: false });
    expect(cellularFrom(null)).toEqual({ cellular: false, unknown: true });
  });

  it('messages d’erreur actionnables', () => {
    expect(describeWebStemsError({ code: 'cancelled' })).toMatch(/annulée/);
    expect(describeWebStemsError({ code: 'network', message: 'x' })).toMatch(/connexion/);
    expect(describeWebStemsError({ code: 'model' })).toMatch(/abîmé ou modifié/);
    expect(describeWebStemsError({ code: 'engine' })).toMatch(/Chrome ou Edge/);
    expect(describeWebStemsError({ name: 'RangeError', message: 'Array buffer allocation failed' })).toMatch(/mémoire/);
    expect(describeWebStemsError(new Error('boom'))).toMatch(/boom/);
  });
});
