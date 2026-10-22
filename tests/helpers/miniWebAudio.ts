/**
 * Mini Web Audio pour Node (banc de métrologie, 22/10/2026).
 *
 * Un moteur de rendu HORS LIGNE qui suit la spécification Web Audio (W3C) pour les
 * nœuds natifs que NOVA utilise : gain, retard (cycles compris), biquad (formules de
 * la spec : Q en dB pour passe-bas / passe-haut), panoramique stéréo (loi de la spec),
 * séparateur / fusionneur, waveshaper, convolveur (normalisation de la spec, convolution
 * par blocs sans latence), oscillateur (formes simples et ondes périodiques),
 * source constante, lecteur de buffer, analyseur (FFT de Blackman de la spec) et
 * AudioWorklet (le code du module est exécuté dans un bac à sable `vm`).
 *
 * But : faire tourner le VRAI code des effets et de l'export (AudioEngine.renderProject)
 * sous vitest, puis MESURER le son rendu (temps, niveaux, fréquences). Ce n'est pas
 * Chrome : les écarts propres au navigateur (interpolation exacte, ordre de calcul
 * dans un même bloc) ne sont pas reproduits au bit près, mais tout ce qui est défini
 * par la spec l'est (gains, lois, formules des filtres, temps de retard).
 *
 * Usage : `installMiniWebAudio()` pose OfflineAudioContext, AudioBuffer, AudioNode…
 * sur globalThis ; `new OfflineAudioContext(2, n, sr).startRendering()`.
 */
import vm from 'vm';

const Q = 128; // taille d'un bloc de rendu (render quantum)

// ───────────────────────────── AudioBuffer ─────────────────────────────

export class MiniAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private chs: Float32Array[];
  constructor(o: { numberOfChannels?: number; length: number; sampleRate: number }) {
    this.numberOfChannels = Math.max(1, o.numberOfChannels ?? 1);
    this.length = Math.max(1, Math.floor(o.length));
    this.sampleRate = o.sampleRate;
    this.chs = Array.from({ length: this.numberOfChannels }, () => new Float32Array(this.length));
  }
  get duration() { return this.length / this.sampleRate; }
  getChannelData(c: number) { const d = this.chs[c]; if (!d) throw new Error(`canal ${c} inexistant`); return d; }
  copyToChannel(src: Float32Array, c: number, start = 0) { this.getChannelData(c).set(src.subarray(0, Math.max(0, this.length - start)), start); }
  copyFromChannel(dst: Float32Array, c: number, start = 0) { dst.set(this.getChannelData(c).subarray(start, start + dst.length)); }
}

// ───────────────────────────── AudioParam ──────────────────────────────

type Ev =
  | { k: 'set'; t: number; v: number }
  | { k: 'lin'; t: number; v: number }
  | { k: 'exp'; t: number; v: number }
  | { k: 'target'; t: number; v: number; tau: number }
  | { k: 'curve'; t: number; v: number; curve: Float32Array; dur: number };

export class MiniAudioParam {
  defaultValue: number;
  minValue: number;
  maxValue: number;
  automationRate: 'a-rate' | 'k-rate';
  /** Valeur intrinsèque sans événement. */
  private base: number;
  private evs: Ev[] = [];
  /** Connexions entrantes (modulation). */
  inputs: { node: MiniNode; output: number }[] = [];
  private last: number;
  constructor(private ctx: MiniBaseContext, def: number, min = -3.4028234663852886e38, max = 3.4028234663852886e38, rate: 'a-rate' | 'k-rate' = 'a-rate') {
    this.defaultValue = def; this.minValue = min; this.maxValue = max; this.automationRate = rate;
    this.base = def; this.last = def;
  }
  get value() { return this.evs.length ? this.valueAt(this.ctx.currentTime) : this.base; }
  set value(v: number) {
    if (!Number.isFinite(v)) throw new TypeError('valeur non finie');
    // Spec : équivaut à setValueAtTime(v, currentTime).
    if (this.evs.length) this.setValueAtTime(v, this.ctx.currentTime);
    else this.base = v;
    this.last = v;
  }
  private insert(e: Ev) {
    if (!Number.isFinite(e.t) || e.t < 0) throw new RangeError('temps invalide');
    let i = this.evs.length;
    while (i > 0 && this.evs[i - 1].t > e.t) i--;
    this.evs.splice(i, 0, e);
    return this;
  }
  setValueAtTime(v: number, t: number) { return this.insert({ k: 'set', t, v }); }
  linearRampToValueAtTime(v: number, t: number) { return this.insert({ k: 'lin', t, v }); }
  exponentialRampToValueAtTime(v: number, t: number) { if (v === 0) throw new RangeError('rampe exponentielle vers 0'); return this.insert({ k: 'exp', t, v }); }
  setTargetAtTime(v: number, t: number, tau: number) { return this.insert({ k: 'target', t, v, tau: Math.max(0, tau) }); }
  setValueCurveAtTime(values: ArrayLike<number>, t: number, dur: number) {
    const curve = Float32Array.from(values as ArrayLike<number>);
    return this.insert({ k: 'curve', t, v: curve[curve.length - 1], curve, dur });
  }
  cancelScheduledValues(t: number) { this.evs = this.evs.filter(e => e.t < t); return this; }
  cancelAndHoldAtTime(t: number) {
    const v = this.valueAt(t);
    this.evs = this.evs.filter(e => e.t < t);
    this.evs.push({ k: 'set', t, v });
    return this;
  }
  /** Valeur de la ligne d'automation à l'instant t (sans les entrées de modulation). */
  valueAt(t: number): number {
    const evs = this.evs;
    // mode 0 : valeur tenue ; mode 1 : approche exponentielle (setTarget)
    let mode = 0, pv = this.base, pt = 0, tgt = 0, tau = 0, t0 = 0, v0 = 0;
    const cur = (x: number) => (mode === 0 ? pv : tgt + (v0 - tgt) * (tau > 0 ? Math.exp(-(x - t0) / tau) : 0));
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.t > t) {
        if (e.k === 'lin') return pv + (e.v - pv) * (t - pt) / Math.max(1e-12, e.t - pt);
        if (e.k === 'exp') return pv * Math.pow(e.v / pv, (t - pt) / Math.max(1e-12, e.t - pt));
        return cur(t);
      }
      switch (e.k) {
        case 'set': case 'lin': case 'exp': pv = e.v; pt = e.t; mode = 0; break;
        case 'target': v0 = cur(e.t); pv = v0; pt = e.t; t0 = e.t; tgt = e.v; tau = e.tau; mode = 1; break;
        case 'curve': {
          const n = e.curve.length;
          if (t < e.t + e.dur) {
            const k = (n - 1) * (t - e.t) / e.dur;
            const k0 = Math.floor(k), f = k - k0;
            return k0 + 1 < n ? e.curve[k0] * (1 - f) + e.curve[k0 + 1] * f : e.curve[n - 1];
          }
          pv = e.curve[n - 1]; pt = e.t + e.dur; mode = 0;
          break;
        }
      }
    }
    return cur(t);
  }
  /** Vrai si la valeur ne bouge plus à partir de t (tous les événements passés et tenus). */
  private steadyFrom(t: number): boolean {
    const last = this.evs[this.evs.length - 1];
    if (!last) return true;
    if (last.k === 'target') return false;
    if (last.k === 'curve') return last.t + last.dur <= t;
    return last.t <= t;
  }
  hasEvents() { return this.evs.length > 0; }
  /** Valeurs du bloc (a-rate : par échantillon ; k-rate : première valeur répétée). */
  block(frame: number, sr: number, q: number): Float32Array {
    const out = new Float32Array(Q);
    if (!this.evs.length) out.fill(this.base);
    else if (this.steadyFrom(frame / sr)) out.fill(this.valueAt(frame / sr));
    else if (this.automationRate === 'k-rate') out.fill(this.valueAt(frame / sr));
    else for (let i = 0; i < Q; i++) out[i] = this.valueAt((frame + i) / sr);
    for (const c of this.inputs) {
      const chs = c.node.pull(q)[c.output] || [];
      if (!chs.length) continue;
      // Entrée de paramètre : mixée en mono (speakers).
      if (chs.length === 1) { const a = chs[0]; for (let i = 0; i < Q; i++) out[i] += a[i]; }
      else { const a = chs[0], b = chs[1]; for (let i = 0; i < Q; i++) out[i] += 0.5 * (a[i] + b[i]); }
    }
    if (this.automationRate === 'k-rate' && this.inputs.length) out.fill(out[0]);
    for (let i = 0; i < Q; i++) { const x = out[i]; out[i] = x < this.minValue ? this.minValue : x > this.maxValue ? this.maxValue : x; }
    this.last = out[Q - 1];
    return out;
  }
}

// ───────────────────────────── Nœuds ───────────────────────────────────

type Chans = Float32Array[];
type Conn = { node: MiniNode; output: number };

const zeros = (n: number): Chans => Array.from({ length: n }, () => new Float32Array(Q));

/** Mélange des entrées d'une entrée de nœud (spec : canaux calculés, speakers / discrete). */
function mixInputs(conns: Conn[], q: number, count: number, mode: string, interp: string): Chans {
  const ins = conns.map(c => c.node.pull(q)[c.output] || zeros(1));
  let n: number;
  const maxIn = ins.reduce((m, c) => Math.max(m, c.length), 1);
  if (mode === 'explicit') n = count;
  else if (mode === 'clamped-max') n = Math.min(maxIn, count);
  else n = maxIn;
  const out = zeros(n);
  for (const src of ins) addMixed(out, src, interp);
  return out;
}

function addMixed(out: Chans, src: Chans, interp: string) {
  const n = out.length, m = src.length;
  if (m === n) { for (let c = 0; c < n; c++) { const o = out[c], s = src[c]; for (let i = 0; i < Q; i++) o[i] += s[i]; } return; }
  if (interp === 'speakers') {
    if (m === 1 && n === 2) { for (let c = 0; c < 2; c++) { const o = out[c], s = src[0]; for (let i = 0; i < Q; i++) o[i] += s[i]; } return; }
    if (m === 2 && n === 1) { const o = out[0], a = src[0], b = src[1]; for (let i = 0; i < Q; i++) o[i] += 0.5 * (a[i] + b[i]); return; }
  }
  // discrete : canaux copiés tant qu'ils existent
  for (let c = 0; c < Math.min(n, m); c++) { const o = out[c], s = src[c]; for (let i = 0; i < Q; i++) o[i] += s[i]; }
}

let NODE_ID = 0;

export class MiniNode {
  readonly id = ++NODE_ID;
  numberOfInputs: number;
  numberOfOutputs: number;
  channelCount = 2;
  channelCountMode: 'max' | 'clamped-max' | 'explicit' = 'max';
  channelInterpretation: 'speakers' | 'discrete' = 'speakers';
  inputs: Conn[][];
  /** Destinations (pour la détection des cycles). */
  outs: { node: MiniNode | MiniAudioParam; owner: MiniNode | null }[] = [];
  onended: (() => void) | null = null;
  private cacheQ = -1;
  private cache: Chans[] = [];
  private busy = false;
  constructor(public readonly context: MiniBaseContext, nIn: number, nOut: number) {
    this.numberOfInputs = nIn; this.numberOfOutputs = nOut;
    this.inputs = Array.from({ length: nIn }, () => []);
    context._register(this);
  }
  connect(dest: any, output = 0, input = 0) {
    if (dest instanceof MiniAudioParam) {
      dest.inputs.push({ node: this, output });
      this.outs.push({ node: dest, owner: (dest as any)._owner || null });
    } else if (dest instanceof MiniNode) {
      if (!dest.inputs[input]) throw new RangeError(`entrée ${input} inexistante`);
      if (!dest.inputs[input].some(c => c.node === this && c.output === output)) dest.inputs[input].push({ node: this, output });
      this.outs.push({ node: dest, owner: dest });
    } else throw new TypeError('destination invalide');
    this.context._graphVersion++;
    return dest;
  }
  disconnect(dest?: any, output?: number, input?: number) {
    const all = this.context._allNodes();
    const drop = (list: Conn[]) => {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].node === this && (output === undefined || list[i].output === output)) list.splice(i, 1);
    };
    if (dest === undefined || typeof dest === 'number') {
      const o = typeof dest === 'number' ? dest : undefined;
      for (const n of all) for (const inp of n.inputs) for (let i = inp.length - 1; i >= 0; i--) if (inp[i].node === this && (o === undefined || inp[i].output === o)) inp.splice(i, 1);
      for (const p of this.context._allParams()) for (let i = p.inputs.length - 1; i >= 0; i--) if (p.inputs[i].node === this && (o === undefined || p.inputs[i].output === o)) p.inputs.splice(i, 1);
      this.outs = [];
    } else if (dest instanceof MiniAudioParam) {
      const before = dest.inputs.length;
      drop(dest.inputs);
      if (before === dest.inputs.length) throw new DOMException('pas connecté', 'InvalidAccessError');
      this.outs = this.outs.filter(o => o.node !== dest);
    } else if (dest instanceof MiniNode) {
      let found = false;
      dest.inputs.forEach((inp, k) => {
        if (input !== undefined && k !== input) return;
        const before = inp.length; drop(inp); if (inp.length !== before) found = true;
      });
      if (!found) throw new DOMException('pas connecté', 'InvalidAccessError');
      this.outs = this.outs.filter(o => o.node !== dest || dest.inputs.some(inp => inp.some(c => c.node === this)));
    }
    this.context._graphVersion++;
  }
  addEventListener(type: string, f: () => void) { if (type === 'ended') this.onended = f; }
  removeEventListener() { /* */ }
  /** Sorties du bloc q (mémorisées). Un nœud ré-entré (cycle sans retard) rend du silence. */
  pull(q: number): Chans[] {
    if (this.cacheQ === q) return this.cache;
    if (this.busy) return Array.from({ length: this.numberOfOutputs }, () => zeros(1));
    this.busy = true;
    try {
      const ins = this.inputs.map(conns => this.mixInput(conns, q));
      this.cache = this.process(ins, q);
    } finally { this.busy = false; }
    this.cacheQ = q;
    return this.cache;
  }
  /** Pose la sortie du bloc sans calculer (retards dans un cycle). */
  _preset(q: number, outs: Chans[]) { this.cacheQ = q; this.cache = outs; }
  _cachedAt() { return this.cacheQ; }
  protected mixInput(conns: Conn[], q: number): Chans {
    return mixInputs(conns, q, this.channelCount, this.channelCountMode, this.channelInterpretation);
  }
  protected process(ins: Chans[], _q: number): Chans[] {
    return Array.from({ length: this.numberOfOutputs }, () => ins[0] ? ins[0].map(c => c.slice()) : zeros(1));
  }
  protected frameOf(q: number) { return q * Q; }
  protected get sr() { return this.context.sampleRate; }
}

class MiniGain extends MiniNode {
  gain: MiniAudioParam;
  constructor(ctx: MiniBaseContext) { super(ctx, 1, 1); this.gain = ctx._param(this, 1); }
  protected process(ins: Chans[], q: number) {
    const g = this.gain.block(this.frameOf(q), this.sr, q);
    return [ins[0].map(ch => { const o = new Float32Array(Q); for (let i = 0; i < Q; i++) o[i] = ch[i] * g[i]; return o; })];
  }
}

export class MiniDelay extends MiniNode {
  delayTime: MiniAudioParam;
  readonly maxDelay: number;
  private ring: Float32Array[] = [];
  private size: number;
  private written = 0; // échantillons écrits
  inCycle = false;
  constructor(ctx: MiniBaseContext, max = 1) {
    super(ctx, 1, 1);
    this.maxDelay = max;
    this.delayTime = ctx._param(this, 0, 0, max);
    this.size = Math.ceil(max * ctx.sampleRate) + 2 * Q + 4;
  }
  private ensure(n: number) { while (this.ring.length < n) this.ring.push(new Float32Array(this.size)); }
  _write(ch: Chans) {
    this.ensure(ch.length);
    for (let c = 0; c < this.ring.length; c++) {
      const r = this.ring[c], s = ch[Math.min(c, ch.length - 1)];
      const mono = ch.length === 1;
      for (let i = 0; i < Q; i++) r[(this.written + i) % this.size] = mono || c < ch.length ? s[i] : 0;
    }
    this.written += Q;
  }
  /** Lit le bloc q (écriture du bloc déjà faite ou non selon `afterWrite`). */
  _read(q: number, afterWrite: boolean): Chans {
    const d = this.delayTime.block(this.frameOf(q), this.sr, q);
    const n = Math.max(1, this.ring.length);
    this.ensure(n);
    const out = zeros(n);
    const base = this.written - (afterWrite ? Q : 0); // index absolu du 1er échantillon du bloc
    for (let i = 0; i < Q; i++) {
      let dd = d[i] * this.sr;
      if (this.inCycle && dd < Q) dd = Q;
      if (dd > this.size - Q - 2) dd = this.size - Q - 2;
      const pos = base + i - dd;
      if (pos < 0) continue;
      const p0 = Math.floor(pos), f = pos - p0;
      for (let c = 0; c < n; c++) {
        const r = this.ring[c];
        const a = r[p0 % this.size];
        const b = f > 0 ? r[(p0 + 1) % this.size] : 0;
        out[c][i] = a + (b - a) * f;
      }
    }
    return out;
  }
  protected process(ins: Chans[], q: number) {
    this._write(ins[0]);
    return [this._read(q, true)];
  }
}

export class MiniBiquad extends MiniNode {
  type: BiquadFilterType = 'lowpass';
  frequency: MiniAudioParam; detune: MiniAudioParam; Q: MiniAudioParam; gain: MiniAudioParam;
  private st: Float64Array[] = [];
  constructor(ctx: MiniBaseContext) {
    super(ctx, 1, 1);
    const ny = ctx.sampleRate / 2;
    this.frequency = ctx._param(this, 350, 0, ny);
    this.detune = ctx._param(this, 0);
    this.Q = ctx._param(this, 1);
    this.gain = ctx._param(this, 0);
  }
  /** Coefficients normalisés [b0, b1, b2, a1, a2] (formules de la spec Web Audio). */
  coefs(f0: number, Qv: number, G: number, det = 0): number[] {
    const sr = this.sr, ny = sr / 2;
    let f = f0 * Math.pow(2, det / 1200);
    f = Math.max(0, Math.min(ny, f));
    const w0 = 2 * Math.PI * f / sr, c = Math.cos(w0), s = Math.sin(w0);
    const A = Math.pow(10, G / 40);
    const aQ = s / (2 * Qv);
    const aQdB = s / (2 * Math.pow(10, Qv / 20));
    const aS = (s / 2) * Math.SQRT2;
    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    switch (this.type) {
      case 'lowpass':
        if (f >= ny) return [1, 0, 0, 0, 0];
        if (f <= 0) return [0, 0, 0, 0, 0];
        b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + aQdB; a1 = -2 * c; a2 = 1 - aQdB; break;
      case 'highpass':
        if (f >= ny) return [0, 0, 0, 0, 0];
        if (f <= 0) return [1, 0, 0, 0, 0];
        b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + aQdB; a1 = -2 * c; a2 = 1 - aQdB; break;
      case 'bandpass': b0 = aQ; b1 = 0; b2 = -aQ; a0 = 1 + aQ; a1 = -2 * c; a2 = 1 - aQ; break;
      case 'notch': b0 = 1; b1 = -2 * c; b2 = 1; a0 = 1 + aQ; a1 = -2 * c; a2 = 1 - aQ; break;
      case 'allpass': b0 = 1 - aQ; b1 = -2 * c; b2 = 1 + aQ; a0 = 1 + aQ; a1 = -2 * c; a2 = 1 - aQ; break;
      case 'peaking': b0 = 1 + aQ * A; b1 = -2 * c; b2 = 1 - aQ * A; a0 = 1 + aQ / A; a1 = -2 * c; a2 = 1 - aQ / A; break;
      case 'lowshelf': {
        const k = 2 * aS * Math.sqrt(A);
        b0 = A * ((A + 1) - (A - 1) * c + k); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - k);
        a0 = (A + 1) + (A - 1) * c + k; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - k; break;
      }
      case 'highshelf': {
        const k = 2 * aS * Math.sqrt(A);
        b0 = A * ((A + 1) + (A - 1) * c + k); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - k);
        a0 = (A + 1) - (A - 1) * c + k; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - k; break;
      }
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  getFrequencyResponse(freqs: Float32Array, mag: Float32Array, phase: Float32Array) {
    const [b0, b1, b2, a1, a2] = this.coefs(this.frequency.value, this.Q.value, this.gain.value, this.detune.value);
    for (let i = 0; i < freqs.length; i++) {
      const w = 2 * Math.PI * freqs[i] / this.sr;
      const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
      const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
      const den = dr * dr + di * di;
      mag[i] = Math.sqrt((nr * nr + ni * ni) / den);
      phase[i] = Math.atan2(ni * dr - nr * di, nr * dr + ni * di);
    }
  }
  protected process(ins: Chans[], q: number) {
    const fr = this.frequency.block(this.frameOf(q), this.sr, q);
    const qq = this.Q.block(this.frameOf(q), this.sr, q);
    const gg = this.gain.block(this.frameOf(q), this.sr, q);
    const dt = this.detune.block(this.frameOf(q), this.sr, q);
    const k = this.coefs(fr[0], qq[0], gg[0], dt[0]);
    const vary = fr[0] !== fr[Q - 1] || qq[0] !== qq[Q - 1] || gg[0] !== gg[Q - 1];
    while (this.st.length < ins[0].length) this.st.push(new Float64Array(4));
    const out = ins[0].map((x, c) => {
      const s = this.st[c];
      let [x1, x2, y1, y2] = s;
      let [b0, b1, b2, a1, a2] = k;
      const o = new Float32Array(Q);
      for (let i = 0; i < Q; i++) {
        if (vary && (i & 15) === 0) [b0, b1, b2, a1, a2] = this.coefs(fr[i], qq[i], gg[i], dt[i]);
        const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
        o[i] = y;
      }
      s[0] = x1; s[1] = x2; s[2] = y1; s[3] = y2;
      return o;
    });
    return [out];
  }
}

class MiniPanner extends MiniNode {
  pan: MiniAudioParam;
  constructor(ctx: MiniBaseContext) { super(ctx, 1, 1); this.channelCountMode = 'clamped-max'; this.pan = ctx._param(this, 0, -1, 1); }
  protected process(ins: Chans[], q: number) {
    const p = this.pan.block(this.frameOf(q), this.sr, q);
    const x = ins[0];
    const L = new Float32Array(Q), R = new Float32Array(Q);
    for (let i = 0; i < Q; i++) {
      const pan = Math.max(-1, Math.min(1, p[i]));
      if (x.length === 1) {
        const xx = (pan + 1) / 2;
        L[i] = x[0][i] * Math.cos(xx * Math.PI / 2); R[i] = x[0][i] * Math.sin(xx * Math.PI / 2);
      } else if (pan <= 0) {
        const xx = pan + 1, gl = Math.cos(xx * Math.PI / 2), gr = Math.sin(xx * Math.PI / 2);
        L[i] = x[0][i] + x[1][i] * gl; R[i] = x[1][i] * gr;
      } else {
        const gl = Math.cos(pan * Math.PI / 2), gr = Math.sin(pan * Math.PI / 2);
        L[i] = x[0][i] * gl; R[i] = x[1][i] + x[0][i] * gr;
      }
    }
    return [[L, R]];
  }
}

class MiniSplitter extends MiniNode {
  constructor(ctx: MiniBaseContext, n = 6) { super(ctx, 1, n); this.channelCount = n; this.channelCountMode = 'explicit'; this.channelInterpretation = 'discrete'; }
  protected mixInput(conns: Conn[], q: number) {
    // Le séparateur garde les canaux tels quels (discret), sans en ajouter.
    return mixInputs(conns, q, this.numberOfOutputs, 'max', 'discrete');
  }
  protected process(ins: Chans[]) {
    return Array.from({ length: this.numberOfOutputs }, (_, k) => [ins[0][k] ? ins[0][k].slice() : new Float32Array(Q)]);
  }
}

class MiniMerger extends MiniNode {
  constructor(ctx: MiniBaseContext, n = 6) { super(ctx, n, 1); this.channelCount = 1; this.channelCountMode = 'explicit'; }
  protected process(ins: Chans[]) { return [ins.map(c => c[0].slice())]; }
}

class MiniShaper extends MiniNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
  protected process(ins: Chans[]) {
    const cv = this.curve;
    if (!cv) return [ins[0].map(c => c.slice())];
    const n = cv.length;
    return [ins[0].map(x => {
      const o = new Float32Array(Q);
      for (let i = 0; i < Q; i++) {
        const v = (n - 1) / 2 * (x[i] + 1);
        if (v <= 0) o[i] = cv[0];
        else if (v >= n - 1) o[i] = cv[n - 1];
        else { const k = Math.floor(v), f = v - k; o[i] = (1 - f) * cv[k] + f * cv[k + 1]; }
      }
      return o;
    })];
  }
}

// FFT radix-2 en place (réel/imag séparés)
function fft(re: Float64Array, im: Float64Array, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j], ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
export { fft as miniFft };

/** Convolution par partitions uniformes (blocs de 128, FFT 256), sans latence. */
class Partitioned {
  private parts: { re: Float64Array; im: Float64Array }[] = [];
  private fdl: { re: Float64Array; im: Float64Array }[] = [];
  private pos = 0;
  private prev = new Float64Array(Q);
  constructor(h: Float32Array, scale: number) {
    for (let o = 0; o < h.length; o += Q) {
      const re = new Float64Array(2 * Q), im = new Float64Array(2 * Q);
      for (let i = 0; i < Q && o + i < h.length; i++) re[i] = h[o + i] * scale;
      fft(re, im);
      this.parts.push({ re, im });
      this.fdl.push({ re: new Float64Array(2 * Q), im: new Float64Array(2 * Q) });
    }
  }
  process(x: Float32Array): Float32Array {
    const P = this.parts.length;
    const re = new Float64Array(2 * Q), im = new Float64Array(2 * Q);
    re.set(this.prev, 0);
    for (let i = 0; i < Q; i++) re[Q + i] = x[i];
    this.prev = Float64Array.from(x);
    fft(re, im);
    this.pos = (this.pos + P - 1) % P;
    this.fdl[this.pos].re.set(re); this.fdl[this.pos].im.set(im);
    const yr = new Float64Array(2 * Q), yi = new Float64Array(2 * Q);
    for (let p = 0; p < P; p++) {
      const X = this.fdl[(this.pos + p) % P], H = this.parts[p];
      for (let k = 0; k < 2 * Q; k++) {
        yr[k] += X.re[k] * H.re[k] - X.im[k] * H.im[k];
        yi[k] += X.re[k] * H.im[k] + X.im[k] * H.re[k];
      }
    }
    fft(yr, yi, true);
    const out = new Float32Array(Q);
    for (let i = 0; i < Q; i++) out[i] = yr[Q + i];
    return out;
  }
}

/** Normalisation du convolveur (spec Web Audio, « calculateNormalizationScale »). */
export function convolverNormalizationScale(b: { numberOfChannels: number; length: number; sampleRate: number; getChannelData(c: number): Float32Array }): number {
  const GainCalibration = 0.00125, GainCalibrationSampleRate = 44100, MinPower = 0.000125;
  let power = 0;
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) power += d[i] * d[i]; }
  power = Math.sqrt(power / (b.numberOfChannels * b.length));
  if (!Number.isFinite(power) || power < MinPower) power = MinPower;
  let scale = (1 / power) * GainCalibration;
  scale *= GainCalibrationSampleRate / b.sampleRate;
  if (b.numberOfChannels === 4) scale *= 0.5;
  return scale;
}

class MiniConvolver extends MiniNode {
  normalize = true;
  private _buffer: MiniAudioBuffer | null = null;
  private engines: Partitioned[] = [];
  constructor(ctx: MiniBaseContext) { super(ctx, 1, 1); this.channelCountMode = 'clamped-max'; }
  get buffer() { return this._buffer; }
  set buffer(b: MiniAudioBuffer | null) {
    this._buffer = b;
    this.engines = [];
    if (!b) return;
    const scale = this.normalize ? convolverNormalizationScale(b) : 1;
    for (let c = 0; c < Math.min(2, b.numberOfChannels); c++) this.engines.push(new Partitioned(b.getChannelData(c), scale));
    if (b.numberOfChannels === 1) this.engines.push(new Partitioned(b.getChannelData(0), scale));
  }
  protected process(ins: Chans[]) {
    if (!this._buffer) return [zeros(1)];
    const x = ins[0];
    const L = x[0], R = x.length > 1 ? x[1] : x[0];
    if (this._buffer.numberOfChannels === 1 && x.length === 1) return [[this.engines[0].process(L)]];
    return [[this.engines[0].process(L), this.engines[1].process(R)]];
  }
}

abstract class MiniSource extends MiniNode {
  protected startAt = Infinity;
  protected stopAt = Infinity;
  private ended = false;
  constructor(ctx: MiniBaseContext) { super(ctx, 0, 1); }
  start(when = 0, ..._rest: any[]) { this.startAt = Math.max(0, when); }
  stop(when = 0) { this.stopAt = Math.max(0, when ?? 0); }
  protected active(frame: number) { const t = frame / this.sr; return t >= this.startAt && t < this.stopAt; }
  protected process(_ins: Chans[], q: number): Chans[] {
    const f0 = this.frameOf(q);
    const tEnd = (f0 + Q) / this.sr;
    if (tEnd <= this.startAt) return [zeros(1)];
    if (f0 / this.sr >= this.stopAt) {
      if (!this.ended) { this.ended = true; const cb = this.onended; if (cb) this.context._later(() => cb.call(this)); }
      return [zeros(1)];
    }
    return [this.render(f0, q)];
  }
  protected abstract render(f0: number, q: number): Chans;
}

export class MiniPeriodicWave {
  constructor(public real: Float32Array, public imag: Float32Array, public norm: boolean) {}
}

class MiniOscillator extends MiniSource {
  frequency: MiniAudioParam; detune: MiniAudioParam;
  private _type: OscillatorType = 'sine';
  private wave: { re: Float32Array; im: Float32Array; scale: number } | null = null;
  private phase = 0; // en cycles
  constructor(ctx: MiniBaseContext) { super(ctx); this.frequency = ctx._param(this, 440, -ctx.sampleRate / 2, ctx.sampleRate / 2); this.detune = ctx._param(this, 0); }
  get type() { return this._type; }
  set type(t: OscillatorType) { if (t === 'custom') throw new DOMException('custom', 'InvalidStateError'); this._type = t; this.wave = null; }
  setPeriodicWave(w: MiniPeriodicWave) {
    let scale = 1;
    if (w.norm) {
      let mx = 0;
      for (let i = 0; i < 2048; i++) { const v = Math.abs(this.evalWave(w.real, w.imag, i / 2048)); if (v > mx) mx = v; }
      scale = mx > 0 ? 1 / mx : 1;
    }
    this.wave = { re: w.real, im: w.imag, scale };
    this._type = 'custom';
  }
  private evalWave(re: Float32Array, im: Float32Array, ph: number) {
    let v = 0;
    for (let k = 1; k < re.length; k++) v += re[k] * Math.cos(2 * Math.PI * k * ph) + im[k] * Math.sin(2 * Math.PI * k * ph);
    return v;
  }
  protected render(f0: number, q: number) {
    const fr = this.frequency.block(f0, this.sr, q), dt = this.detune.block(f0, this.sr, q);
    const o = new Float32Array(Q);
    for (let i = 0; i < Q; i++) {
      if (!this.active(f0 + i)) { o[i] = 0; continue; }
      const ph = this.phase - Math.floor(this.phase);
      let v: number;
      if (this.wave) v = this.wave.scale * this.evalWave(this.wave.re, this.wave.im, ph);
      else switch (this._type) {
        case 'square': v = ph < 0.5 ? 1 : -1; break;
        case 'sawtooth': v = ph < 0.5 ? 2 * ph : 2 * ph - 2; break;
        case 'triangle': v = ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4; break;
        default: v = Math.sin(2 * Math.PI * ph);
      }
      o[i] = v;
      this.phase += fr[i] * Math.pow(2, dt[i] / 1200) / this.sr;
    }
    return [o];
  }
}

class MiniConstant extends MiniSource {
  offset: MiniAudioParam;
  constructor(ctx: MiniBaseContext) { super(ctx); this.offset = ctx._param(this, 1); }
  protected render(f0: number, q: number) {
    const v = this.offset.block(f0, this.sr, q);
    const o = new Float32Array(Q);
    for (let i = 0; i < Q; i++) o[i] = this.active(f0 + i) ? v[i] : 0;
    return [o];
  }
}

class MiniBufferSource extends MiniSource {
  buffer: MiniAudioBuffer | null = null;
  playbackRate: MiniAudioParam; detune: MiniAudioParam;
  loop = false; loopStart = 0; loopEnd = 0;
  private offset = 0; private dur = Infinity;
  private pos = NaN; // position dans le buffer (échantillons du buffer)
  constructor(ctx: MiniBaseContext) { super(ctx); this.playbackRate = ctx._param(this, 1, -3.4e38, 3.4e38, 'k-rate'); this.detune = ctx._param(this, 0, -3.4e38, 3.4e38, 'k-rate'); }
  start(when = 0, offset = 0, duration?: number) { super.start(when); this.offset = Math.max(0, offset || 0); if (duration !== undefined) this.dur = duration; }
  protected render(f0: number, q: number) {
    const b = this.buffer;
    if (!b) return zeros(1);
    const rate = this.playbackRate.block(f0, this.sr, q)[0] * Math.pow(2, this.detune.block(f0, this.sr, q)[0] / 1200);
    const step = rate * b.sampleRate / this.sr;
    const out = zeros(b.numberOfChannels);
    const endPos = Number.isFinite(this.dur) ? (this.offset + this.dur) * b.sampleRate : Infinity;
    for (let i = 0; i < Q; i++) {
      const t = (f0 + i) / this.sr;
      if (t < this.startAt || t >= this.stopAt) continue;
      // Départ au sous-échantillon près (spec) : position = offset + temps écoulé.
      if (Number.isNaN(this.pos)) this.pos = this.offset * b.sampleRate + (t - this.startAt) * rate * b.sampleRate;
      let p = this.pos;
      this.pos += step;
      if (!this.loop && p >= endPos) continue;
      if (this.loop) {
        const ls = this.loopStart * b.sampleRate, le = (this.loopEnd > 0 ? this.loopEnd : b.duration) * b.sampleRate;
        if (le > ls) while (p >= le) p -= le - ls;
      }
      if (p >= 0 && p < b.length) {
        const p0 = Math.floor(p), f = p - p0;
        for (let c = 0; c < b.numberOfChannels; c++) {
          const d = b.getChannelData(c);
          const a = d[p0], n = p0 + 1 < b.length ? d[p0 + 1] : 0;
          out[c][i] = f ? a + (n - a) * f : a;
        }
      }
    }
    return out;
  }
}

class MiniAnalyser extends MiniNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  minDecibels = -100;
  maxDecibels = -30;
  private hist = new Float32Array(32768);
  private w = 0;
  private prevMag: Float64Array | null = null;
  get frequencyBinCount() { return this.fftSize / 2; }
  protected process(ins: Chans[]) {
    const x = ins[0];
    for (let i = 0; i < Q; i++) {
      let s = 0; for (const c of x) s += c[i];
      this.hist[(this.w + i) % this.hist.length] = s / x.length;
    }
    this.w += Q;
    return [x.map(c => c.slice())];
  }
  private frame(): Float64Array {
    const n = this.fftSize, f = new Float64Array(n);
    for (let i = 0; i < n; i++) f[i] = this.hist[(this.w - n + i + this.hist.length * 4) % this.hist.length];
    return f;
  }
  getFloatTimeDomainData(a: Float32Array) { const f = this.frame(); for (let i = 0; i < Math.min(a.length, f.length); i++) a[i] = f[i]; }
  /** Spec : fenêtre de Blackman (α = 0,16), |X[k]| / N, lissage temporel, puis dB. */
  getFloatFrequencyData(a: Float32Array) {
    const n = this.fftSize, x = this.frame();
    const re = new Float64Array(n), im = new Float64Array(n);
    const al = 0.16, a0 = (1 - al) / 2, a1 = 0.5, a2 = al / 2;
    for (let i = 0; i < n; i++) re[i] = x[i] * (a0 - a1 * Math.cos(2 * Math.PI * i / n) + a2 * Math.cos(4 * Math.PI * i / n));
    fft(re, im);
    const m = new Float64Array(n / 2);
    const tau = this.smoothingTimeConstant;
    for (let k = 0; k < n / 2; k++) {
      const mag = Math.hypot(re[k], im[k]) / n;
      m[k] = this.prevMag ? tau * this.prevMag[k] + (1 - tau) * mag : (1 - tau) * mag;
    }
    this.prevMag = m;
    for (let k = 0; k < Math.min(a.length, n / 2); k++) a[k] = m[k] > 0 ? 20 * Math.log10(m[k]) : -Infinity;
  }
  getByteTimeDomainData(a: Uint8Array) { const f = this.frame(); for (let i = 0; i < Math.min(a.length, f.length); i++) a[i] = Math.max(0, Math.min(255, 128 * (1 + f[i]))); }
  getByteFrequencyData(a: Uint8Array) { const f = new Float32Array(a.length); this.getFloatFrequencyData(f); for (let i = 0; i < a.length; i++) a[i] = Math.max(0, Math.min(255, 255 * (f[i] - this.minDecibels) / (this.maxDecibels - this.minDecibels))); }
}

class MiniDestination extends MiniNode {
  maxChannelCount = 2;
  constructor(ctx: MiniBaseContext, ch: number) { super(ctx, 1, 0); this.channelCount = ch; this.channelCountMode = 'explicit'; }
  protected process(ins: Chans[]) { return [ins[0]]; }
}

class MiniDynamicsCompressor extends MiniNode {
  threshold: MiniAudioParam; knee: MiniAudioParam; ratio: MiniAudioParam; attack: MiniAudioParam; release: MiniAudioParam; reduction = 0;
  constructor(ctx: MiniBaseContext) {
    super(ctx, 1, 1);
    this.threshold = ctx._param(this, -24); this.knee = ctx._param(this, 30); this.ratio = ctx._param(this, 12); this.attack = ctx._param(this, 0.003); this.release = ctx._param(this, 0.25);
  }
}

// ───────────────────────────── AudioWorklet ────────────────────────────

class MiniPort {
  onmessage: ((e: { data: any }) => void) | null = null;
  other: MiniPort | null = null;
  constructor(private ctx: MiniBaseContext) {}
  postMessage(data: any) { const o = this.other; if (o) this.ctx._later(() => o.onmessage?.({ data })); }
  start() { /* */ }
  close() { /* */ }
  addEventListener(t: string, f: any) { if (t === 'message') this.onmessage = f; }
  removeEventListener() { /* */ }
}

class MiniWorkletNode extends MiniNode {
  port: MiniPort;
  parameters: Map<string, MiniAudioParam>;
  private proc: any;
  private outCh: number[];
  private fixedOut = false;
  onprocessorerror: any = null;
  constructor(ctx: MiniBaseContext, name: string, opts: any = {}) {
    super(ctx, opts.numberOfInputs ?? 1, opts.numberOfOutputs ?? 1);
    const def = ctx._processors.get(name);
    if (!def) throw new DOMException(`processeur inconnu : ${name}`, 'InvalidStateError');
    if (opts.channelCount) this.channelCount = opts.channelCount;
    if (opts.channelCountMode) this.channelCountMode = opts.channelCountMode;
    if (opts.channelInterpretation) this.channelInterpretation = opts.channelInterpretation;
    this.fixedOut = !!opts.outputChannelCount;
    this.outCh = opts.outputChannelCount || Array.from({ length: this.numberOfOutputs }, () => 1);
    const nodePort = new MiniPort(ctx), procPort = new MiniPort(ctx);
    nodePort.other = procPort; procPort.other = nodePort;
    this.port = nodePort;
    this.parameters = new Map();
    for (const d of (def.cls.parameterDescriptors || [])) {
      const p = ctx._param(this, d.defaultValue ?? 0, d.minValue ?? -3.4e38, d.maxValue ?? 3.4e38, d.automationRate || 'a-rate');
      this.parameters.set(d.name, p);
    }
    ctx._sandbox.__nextPort = procPort;
    this.proc = new def.cls({ ...opts, processorOptions: opts.processorOptions || {} });
    ctx._sandbox.__nextPort = null;
    if (!this.proc.port) this.proc.port = procPort;
  }
  protected mixInput(conns: Conn[], q: number): Chans {
    if (!conns.length) return [];
    return super.mixInput(conns, q);
  }
  private alive = true;
  protected process(ins: Chans[], q: number): Chans[] {
    const f0 = this.frameOf(q);
    // Spec : sans outputChannelCount, 1 entrée et 1 sortie → la sortie suit l'entrée ; sinon 1 canal.
    const outs = this.outCh.map(n => zeros(!this.fixedOut && this.numberOfInputs === 1 && this.numberOfOutputs === 1 ? Math.max(1, ins[0]?.length || 1) : n));
    const params: Record<string, Float32Array> = {};
    this.parameters.forEach((p, name) => {
      const b = p.block(f0, this.sr, q);
      let same = true; for (let i = 1; i < Q; i++) if (b[i] !== b[0]) { same = false; break; }
      params[name] = same ? b.subarray(0, 1) : b;
    });
    this.context._sandbox.currentFrame = f0;
    this.context._sandbox.currentTime = f0 / this.sr;
    if (this.alive) {
      try { this.alive = !!this.proc.process(ins, outs, params); }
      catch (e) { this.alive = false; this.onprocessorerror?.(e); throw e; }
    }
    return outs;
  }
}

// ───────────────────────────── Contexte ────────────────────────────────

export class MiniBaseContext {
  readonly sampleRate: number;
  currentTime = 0;
  state: AudioContextState = 'suspended';
  readonly _dest: MiniDestination;
  get destination(): AudioDestinationNode { return this._dest as unknown as AudioDestinationNode; }
  listener = {};
  _graphVersion = 0;
  private nodes: MiniNode[] = [];
  private params: MiniAudioParam[] = [];
  private tasks: (() => void)[] = [];
  _processors = new Map<string, { cls: any }>();
  _sandbox: any;
  audioWorklet: { addModule: (url: string) => Promise<void> };
  onstatechange: any = null;
  constructor(channels: number, sampleRate: number) {
    this.sampleRate = sampleRate;
    this._dest = new MiniDestination(this, channels);
    const self = this;
    this._sandbox = vm.createContext({
      sampleRate, currentTime: 0, currentFrame: 0, console, Math, Float32Array, Float64Array, Int32Array, Uint8Array, Array, Object, Number, Map, Set, Error, JSON, isFinite, isNaN,
      registerProcessor(name: string, cls: any) { self._processors.set(name, { cls }); },
    });
    vm.runInContext(`class AudioWorkletProcessor { constructor() { this.port = globalThis.__nextPort; } }; globalThis.AudioWorkletProcessor = AudioWorkletProcessor;`, this._sandbox);
    this.audioWorklet = {
      addModule: async (url: string) => {
        const code = blobStore.get(url);
        if (code === undefined) throw new Error(`module introuvable : ${url}`);
        vm.runInContext(code, this._sandbox);
      },
    };
  }
  _register(n: MiniNode) { this.nodes.push(n); }
  _allNodes() { return this.nodes; }
  _allParams() { return this.params; }
  _param(owner: MiniNode, def: number, min?: number, max?: number, rate?: 'a-rate' | 'k-rate') {
    const p = new MiniAudioParam(this, def, min, max, rate);
    (p as any)._owner = owner;
    this.params.push(p);
    return p;
  }
  _later(f: () => void) { this.tasks.push(f); }
  createGain() { return new MiniGain(this) as unknown as GainNode; }
  createDelay(max = 1) { return new MiniDelay(this, max) as unknown as DelayNode; }
  createBiquadFilter() { return new MiniBiquad(this) as unknown as BiquadFilterNode; }
  createStereoPanner() { return new MiniPanner(this) as unknown as StereoPannerNode; }
  createChannelSplitter(n = 6) { return new MiniSplitter(this, n) as unknown as ChannelSplitterNode; }
  createChannelMerger(n = 6) { return new MiniMerger(this, n) as unknown as ChannelMergerNode; }
  createWaveShaper() { return new MiniShaper(this, 1, 1) as unknown as WaveShaperNode; }
  createConvolver() { return new MiniConvolver(this) as unknown as ConvolverNode; }
  createOscillator() { return new MiniOscillator(this) as unknown as OscillatorNode; }
  createConstantSource() { return new MiniConstant(this) as unknown as ConstantSourceNode; }
  createBufferSource() { return new MiniBufferSource(this) as unknown as AudioBufferSourceNode; }
  createAnalyser() { return new MiniAnalyser(this, 1, 1) as unknown as AnalyserNode; }
  createDynamicsCompressor() { return new MiniDynamicsCompressor(this) as unknown as DynamicsCompressorNode; }
  createBuffer(ch: number, len: number, sr: number) { return new MiniAudioBuffer({ numberOfChannels: ch, length: len, sampleRate: sr }) as unknown as AudioBuffer; }
  createPeriodicWave(re: ArrayLike<number>, im: ArrayLike<number>, o?: { disableNormalization?: boolean }) {
    return new MiniPeriodicWave(Float32Array.from(re as any), Float32Array.from(im as any), !o?.disableNormalization) as unknown as PeriodicWave;
  }
  createMediaStreamSource(): never { throw new Error('micro indisponible dans le banc'); }
  createMediaStreamDestination(): never { throw new Error('flux indisponible dans le banc'); }
  createScriptProcessor(): never { throw new Error('ScriptProcessor indisponible dans le banc'); }
  decodeAudioData(): Promise<AudioBuffer> { return Promise.reject(new Error('décodage indisponible dans le banc')); }
  async resume() { /* */ }
  async suspend() { /* */ }
  async close() { /* */ }
  addEventListener() { /* */ }
  removeEventListener() { /* */ }

  /** Rend `frames` échantillons (boucle de blocs). */
  protected renderFrames(out: MiniAudioBuffer) {
    const nQ = Math.ceil(out.length / Q);
    let ver = -1;
    let cycDelays: MiniDelay[] = [];
    for (let q = 0; q < nQ; q++) {
      this.currentTime = q * Q / this.sampleRate;
      this.runTasks();
      if (ver !== this._graphVersion) { ver = this._graphVersion; cycDelays = this.cycleDelays(); }
      // 1. Retards dans un cycle : sortie tirée de l'historique (≥ 1 bloc), comme la spec.
      for (const d of cycDelays) d._preset(q, [d._read(q, false)]);
      // 2. Tout le graphe (chaque nœud une fois par bloc).
      const res = this._dest.pull(q)[0];
      for (const n of this.nodes) n.pull(q);
      // 3. Les retards en cycle écrivent leur entrée du bloc.
      for (const d of cycDelays) {
        const ins = mixInputs(d.inputs[0], q, d.channelCount, d.channelCountMode, d.channelInterpretation);
        d._write(ins);
      }
      const off = q * Q;
      for (let c = 0; c < out.numberOfChannels; c++) {
        const dst = out.getChannelData(c);
        const src = res[Math.min(c, res.length - 1)];
        const mono = res.length === 1;
        for (let i = 0; i < Q && off + i < out.length; i++) dst[off + i] = mono || c < res.length ? src[i] : 0;
      }
    }
    this.currentTime = out.length / this.sampleRate;
    this.runTasks();
  }
  private runTasks() { const t = this.tasks; this.tasks = []; for (const f of t) { try { f(); } catch (e) { /* tâche d'un nœud libéré */ } } }
  /** Retards qui se retrouvent en aval d'eux-mêmes. */
  private cycleDelays(): MiniDelay[] {
    const res: MiniDelay[] = [];
    for (const n of this.nodes) {
      if (!(n instanceof MiniDelay)) continue;
      n.inCycle = this.reaches(n, n);
      if (n.inCycle) res.push(n);
    }
    return res;
  }
  private reaches(from: MiniNode, target: MiniNode): boolean {
    const seen = new Set<MiniNode>();
    const stack: MiniNode[] = [from];
    while (stack.length) {
      const x = stack.pop()!;
      for (const o of x.outs) {
        const nx = o.node instanceof MiniAudioParam ? o.owner : o.node;
        if (!nx) continue;
        if (nx === target) return true;
        if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
      }
    }
    return false;
  }
}

export class MiniOfflineAudioContext extends MiniBaseContext {
  readonly length: number;
  private rendering = false;
  oncomplete: any = null;
  constructor(a: number | { numberOfChannels?: number; length: number; sampleRate: number }, len?: number, sr?: number) {
    const o = typeof a === 'number' ? { numberOfChannels: a, length: len!, sampleRate: sr! } : a;
    super(o.numberOfChannels ?? 1, o.sampleRate);
    this.length = o.length;
  }
  async startRendering(): Promise<AudioBuffer> {
    if (this.rendering) throw new DOMException('déjà lancé', 'InvalidStateError');
    this.rendering = true;
    this.state = 'running';
    const out = new MiniAudioBuffer({ numberOfChannels: this._dest.channelCount, length: this.length, sampleRate: this.sampleRate });
    this.renderFrames(out);
    this.state = 'closed';
    return out as unknown as AudioBuffer;
  }
}

/** Contexte « temps réel » simulé (rien ne tourne ; currentTime réglable à la main). */
export class MiniAudioContext extends MiniBaseContext {
  baseLatency = 0; outputLatency = 0;
  constructor(o?: { sampleRate?: number }) { super(2, o?.sampleRate ?? 48000); this.state = 'running'; }
  /** Rend `seconds` secondes vers un buffer (tests : écouter un effet « en direct »). */
  renderFor(seconds: number): MiniAudioBuffer {
    const out = new MiniAudioBuffer({ numberOfChannels: this._dest.channelCount, length: Math.ceil(seconds * this.sampleRate), sampleRate: this.sampleRate });
    this.renderFrames(out);
    return out;
  }
}

// URL d'objet → code (AudioWorklet)
const blobStore = new Map<string, string>();
let blobN = 0;

/** Pose l'API sur globalThis. Renvoie une fonction qui remet l'état d'avant. */
export function installMiniWebAudio(): () => void {
  const g = globalThis as any;
  const keys = ['OfflineAudioContext', 'AudioContext', 'BaseAudioContext', 'AudioBuffer', 'AudioNode', 'AudioParam', 'AudioWorkletNode', 'ChannelSplitterNode', 'ScriptProcessorNode'];
  const before: Record<string, any> = {};
  for (const k of keys) before[k] = g[k];
  g.OfflineAudioContext = MiniOfflineAudioContext;
  g.AudioContext = MiniAudioContext;
  g.BaseAudioContext = MiniBaseContext;
  g.AudioBuffer = MiniAudioBuffer;
  g.AudioNode = MiniNode;
  g.AudioParam = MiniAudioParam;
  g.AudioWorkletNode = MiniWorkletNode;
  g.ChannelSplitterNode = MiniSplitter;
  g.ScriptProcessorNode = class {};
  const origCreate = URL.createObjectURL, origRevoke = URL.revokeObjectURL;
  (URL as any).createObjectURL = (b: any) => {
    const url = `blob:mini/${++blobN}`;
    const parts: any[] = b && b.__parts ? b.__parts : [];
    blobStore.set(url, parts.join(''));
    return url;
  };
  (URL as any).revokeObjectURL = (u: string) => { blobStore.delete(u); };
  const OrigBlob = g.Blob;
  g.Blob = class extends (OrigBlob || Object) { __parts: any[]; constructor(parts: any[] = [], o?: any) { super(parts, o); this.__parts = parts.map(p => String(p)); } };
  return () => {
    for (const k of keys) { if (before[k] === undefined) delete g[k]; else g[k] = before[k]; }
    (URL as any).createObjectURL = origCreate; (URL as any).revokeObjectURL = origRevoke;
    g.Blob = OrigBlob;
  };
}
