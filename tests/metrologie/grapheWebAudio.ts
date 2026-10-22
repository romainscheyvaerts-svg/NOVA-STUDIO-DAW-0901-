/**
 * Banc de métrologie : contexte Web Audio simulé qui CALCULE la réponse en fréquence d'un graphe
 * de nœuds natifs (gains, filtres biquad, retards, analyseurs), comme le navigateur le fait en
 * régime établi. Les filtres biquad suivent la spécification Web Audio (celle que Chrome
 * implémente : Q en dB pour lowpass / highpass, plateaux à pente S = 1, Q ignoré) ; un banc
 * navigateur (qa/metrologie_navigateur.py) vérifie la même chose dans le vrai Chrome.
 *
 * Usage : const ctx = fakeAudioContext(48000); const eq = new ProEQ12Node(ctx as any, params);
 *         graphDb(eq.input, eq.output, 1000, 48000) → gain (dB) mesuré de l'entrée à la sortie.
 */

type C = { re: number; im: number };
const cmul = (a: C, b: C): C => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cadd = (a: C, b: C): C => ({ re: a.re + b.re, im: a.im + b.im });

export class FakeParam {
  value: number;
  constructor(v = 0, public minValue = -3.4e38, public maxValue = 3.4e38) { this.value = v; }
  setValueAtTime(v: number) { this.value = v; return this; }
  linearRampToValueAtTime(v: number) { this.value = v; return this; }
  exponentialRampToValueAtTime(v: number) { this.value = v; return this; }
  /** Régime établi : la cible est atteinte. */
  setTargetAtTime(v: number) { this.value = v; return this; }
  setValueCurveAtTime(c: ArrayLike<number>) { this.value = c[c.length - 1]; return this; }
  cancelScheduledValues() { return this; }
  cancelAndHoldAtTime() { return this; }
}

export class FakeNode {
  outs: { node: FakeNode | FakeParam; out: number; inp: number }[] = [];
  channelCount = 2; channelCountMode = 'max'; channelInterpretation = 'speakers';
  numberOfInputs = 1; numberOfOutputs = 1;
  constructor(public ctx: any, public kind: string) {}
  connect(dest: any, out = 0, inp = 0) { this.outs.push({ node: dest, out, inp }); return dest; }
  disconnect(dest?: any) {
    if (dest === undefined) { this.outs = []; return; }
    const i = this.outs.findIndex(o => o.node === dest);
    if (i < 0) throw new Error('InvalidAccessError: not connected');
    this.outs = this.outs.filter(o => o.node !== dest);
  }
  /** Transfert local (complexe) à la fréquence f. */
  local(_f: number): C { return { re: 1, im: 0 }; }
}

export class FakeGain extends FakeNode {
  gain = new FakeParam(1);
  constructor(ctx: any) { super(ctx, 'gain'); }
  local(): C { return { re: this.gain.value, im: 0 }; }
}

export class FakeDelay extends FakeNode {
  delayTime = new FakeParam(0);
  constructor(ctx: any) { super(ctx, 'delay'); }
  local(f: number): C { const a = -2 * Math.PI * f * this.delayTime.value; return { re: Math.cos(a), im: Math.sin(a) }; }
}

/** Coefficients d'un BiquadFilterNode selon la spécification Web Audio (unités du nœud natif). */
export function webAudioBiquad(type: string, freq: number, Q: number, gain: number, sr: number): number[] {
  const nyq = sr / 2;
  const f0 = Math.max(0, Math.min(nyq, freq));
  const w0 = (2 * Math.PI * f0) / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  const A = Math.pow(10, gain / 40);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (type) {
    case 'lowpass': case 'highpass': {
      const al = sw / (2 * Math.pow(10, Q / 20));
      const lp = type === 'lowpass';
      b0 = lp ? (1 - cw) / 2 : (1 + cw) / 2; b1 = lp ? 1 - cw : -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    }
    case 'bandpass': { const al = sw / (2 * Q); b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break; }
    case 'notch': { const al = sw / (2 * Q); b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break; }
    case 'allpass': { const al = sw / (2 * Q); b0 = 1 - al; b1 = -2 * cw; b2 = 1 + al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break; }
    case 'peaking': { const al = sw / (2 * Q); b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; break; }
    case 'lowshelf': case 'highshelf': {
      const al = (sw / 2) * Math.SQRT2, sA = 2 * Math.sqrt(A) * al;
      if (type === 'lowshelf') {
        b0 = A * ((A + 1) - (A - 1) * cw + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sA);
        a0 = (A + 1) + (A - 1) * cw + sA; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sA;
      } else {
        b0 = A * ((A + 1) + (A - 1) * cw + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sA);
        a0 = (A + 1) - (A - 1) * cw + sA; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sA;
      }
      break;
    }
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

export function coefsAt(c: number[], f: number, sr: number): C {
  const w = (2 * Math.PI * f) / sr;
  const nr = c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w), ni = -(c[1] * Math.sin(w) + c[2] * Math.sin(2 * w));
  const dr = 1 + c[3] * Math.cos(w) + c[4] * Math.cos(2 * w), di = -(c[3] * Math.sin(w) + c[4] * Math.sin(2 * w));
  const den = dr * dr + di * di;
  return { re: (nr * dr + ni * di) / den, im: (ni * dr - nr * di) / den };
}

export class FakeBiquad extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
  gain = new FakeParam(0);
  detune = new FakeParam(0);
  constructor(ctx: any) { super(ctx, 'biquad'); }
  coefs(): number[] {
    const f = this.frequency.value * Math.pow(2, this.detune.value / 1200);
    return webAudioBiquad(this.type, f, this.Q.value, this.gain.value, this.ctx.sampleRate);
  }
  local(f: number): C { return coefsAt(this.coefs(), f, this.ctx.sampleRate); }
  getFrequencyResponse(freqs: Float32Array, mag: Float32Array, phase: Float32Array) {
    const c = this.coefs();
    for (let i = 0; i < freqs.length; i++) { const h = coefsAt(c, freqs[i], this.ctx.sampleRate); mag[i] = Math.hypot(h.re, h.im); phase[i] = Math.atan2(h.im, h.re); }
  }
}

export class FakeAnalyser extends FakeNode {
  fftSize = 2048; smoothingTimeConstant = 0.8; frequencyBinCount = 1024;
  constructor(ctx: any) { super(ctx, 'analyser'); }
  getByteFrequencyData(a: Uint8Array) { a.fill(0); }
  getFloatTimeDomainData(a: Float32Array) { a.fill(0); }
}

export function fakeAudioContext(sampleRate: number) {
  const ctx: any = {
    sampleRate, currentTime: 0, state: 'running',
    createGain: () => new FakeGain(ctx),
    createBiquadFilter: () => new FakeBiquad(ctx),
    createAnalyser: () => new FakeAnalyser(ctx),
    createDelay: () => new FakeDelay(ctx),
    createChannelSplitter: () => new FakeNode(ctx, 'splitter'),
    createChannelMerger: () => new FakeNode(ctx, 'merger'),
    createWaveShaper: () => Object.assign(new FakeNode(ctx, 'shaper'), { curve: null, oversample: 'none' }),
    createConstantSource: () => Object.assign(new FakeNode(ctx, 'const'), { offset: new FakeParam(1), start() {}, stop() {} }),
    audioWorklet: { addModule: () => Promise.reject(new Error('pas de worklet dans le banc')) },
  };
  return ctx;
}

/** Réponse complexe du graphe, de l'entrée de `from` à la sortie de `to` (somme des chemins). */
export function graphResp(from: FakeNode, to: FakeNode, f: number): C {
  const memo = new Map<FakeNode, C>();
  const visit = (n: FakeNode, depth: number): C => {
    if (depth > 400) throw new Error('graphe : cycle');
    const m = memo.get(n);
    if (m) return m;
    const loc = n.local(f);
    let acc: C;
    if (n === to) acc = { re: 1, im: 0 };
    else {
      acc = { re: 0, im: 0 };
      for (const o of n.outs) if (o.node instanceof FakeNode) acc = cadd(acc, visit(o.node, depth + 1));
    }
    const r = cmul(loc, acc);
    memo.set(n, r);
    return r;
  };
  return visit(from, 0);
}
export const graphDb = (from: any, to: any, f: number) => { const h = graphResp(from, to, f); return 10 * Math.log10(h.re * h.re + h.im * h.im + 1e-300); };
export const graphPhase = (from: any, to: any, f: number) => { const h = graphResp(from, to, f); return Math.atan2(h.im, h.re); };
