/**
 * Vrais vumètres NOVA (R11) : banc de mesure AudioWorklet partagé.
 *
 * Un seul module AudioWorklet (« nova-meter-bank ») ; chaque nœud a 16 ENTRÉES,
 * une par point de mesure (piste, bus, master de piste). Une session de 40
 * pistes tient donc dans 3 nœuds : 3 appels JavaScript par bloc de 128
 * échantillons au lieu de 40, et un message par nœud ~30 fois par seconde
 * (au lieu d'un AnalyserNode lu par piste à chaque image). Les pistes muettes
 * n'envoient rien.
 *
 * Point de mesure au choix (Pro Tools : « Pre-Fader Metering ») : après les
 * effets et AVANT le fader (pré), ou après le fader et le pan (post).
 *
 * La sortie finale du master a son propre nœud : crête vraie complète,
 * énergie pondérée K (LUFS, LRA) et points du goniomètre.
 *
 * Affichage : une seule boucle requestAnimationFrame partagée, limitée à
 * 30 images/s (meterClock) ; les composants dessinent dans des canvas sans
 * rendu React pendant la lecture.
 */
import { createMeterCore } from './meterCore';
import { LoudnessMeter, correlationOf } from './loudness';
import { loadWorkletModule } from '../../plugins/vocalDspUtils';

const SLOTS = 16;
const PEAK_FALL_DB_S = 20;   // retombée de la barre de crête
const RMS_TAU_S = 0.3;       // intégration RMS / VU (300 ms)
const CORR_TAU_S = 0.4;      // lissage du corrélomètre
export const HOLD_MS = 2500;  // maintien de crête (trait)

const WORKLET_CODE = `
const createMeterCore = (${createMeterCore.toString()});
class NovaMeterBank extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.coreOpts = o.core || {};
    this.always = !!o.always;
    this.cores = [];
    this.silent = [];
    this.every = Math.max(1, Math.round(sampleRate / ${30} / 128));
    this.count = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.free === 'number') { this.cores[d.free] = null; this.silent[d.free] = 0; }
    };
  }
  process(inputs) {
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      if (!inp || !inp.length || !inp[0]) continue;
      let core = this.cores[i];
      if (!core) core = this.cores[i] = createMeterCore(sampleRate, this.coreOpts);
      core.process(inp[0], inp.length > 1 ? inp[1] : null, inp[0].length);
    }
    if (++this.count >= this.every) {
      this.count = 0;
      const out = [];
      let extra = null;
      for (let i = 0; i < this.cores.length; i++) {
        const core = this.cores[i];
        if (!core) continue;
        const t = core.take();
        if (t.n === 0 && !this.always) continue;
        const silent = t.peakL === 0 && t.peakR === 0;
        if (silent && this.silent[i] && !this.always) continue;
        this.silent[i] = silent ? 1 : 0;
        out.push(i, t.n, t.peakL, t.peakR, t.tpL, t.tpR, t.sumL, t.sumR, t.lr, t.stereo ? 1 : 0);
        if (t.k.length || t.gonio.length) { extra = extra || {}; extra[i] = { k: t.k, g: t.gonio }; }
      }
      if (out.length) {
        const d = new Float64Array(out);
        this.port.postMessage({ t: currentTime, d, x: extra }, [d.buffer]);
      }
    }
    return true;
  }
}
try { registerProcessor('nova-meter-bank-v1', NovaMeterBank); } catch (e) {}
`;
const FIELDS = 10;

export type TapMode = 'pre' | 'post';

/** État affichable d'un point de mesure (dB, dBFS). */
export interface MeterView {
  /** Barre de crête (retombée 20 dB/s). */
  peak: [number, number];
  /** RMS intégré sur 300 ms. */
  rms: [number, number];
  /** Trait de maintien (2,5 s). */
  hold: [number, number];
  /** Crête vraie la plus haute depuis la remise à zéro (lecture numérique). */
  maxTp: number;
  /** Crête échantillon la plus haute depuis la remise à zéro. */
  maxPeak: number;
  /** 0 = rien ; 1 = dépassement inter-échantillons seulement (> 0 dBTP) ; 2 = saturation (≥ 0 dBFS). Reste allumé jusqu'au clic. */
  clip: 0 | 1 | 2;
  /** Position du morceau à la première saturation (s), si connue. */
  clipAt: number | null;
  corr: number;
  stereo: boolean;
  /** Dernière mesure reçue (performance.now()). */
  at: number;
}

interface PointState extends MeterView {
  ms: [number, number];
  holdAt: [number, number];
  lr: number; ll: number; rr: number;
  slot: { node: number; index: number } | null;
}

const NEG = -Infinity;
const lin2db = (x: number) => (x > 1e-10 ? 20 * Math.log10(x) : NEG);

function freshState(): PointState {
  return {
    peak: [NEG, NEG], rms: [NEG, NEG], hold: [NEG, NEG], maxTp: NEG, maxPeak: NEG, clip: 0, clipAt: null,
    corr: 0, stereo: false, at: 0, ms: [0, 0], holdAt: [0, 0], lr: 0, ll: 0, rr: 0, slot: null,
  };
}

export const MASTER_OUT = '__master_out__';

class MeterBank {
  private ctx: BaseAudioContext | null = null;
  private ready = false;
  private failed = false;
  private nodes: AudioWorkletNode[] = [];
  private used: (string | null)[][] = [];
  private masterNode: AudioWorkletNode | null = null;
  private masterSrc: AudioNode | null = null;
  private points = new Map<string, PointState>();
  private taps = new Map<string, { pre: AudioNode; post: AudioNode; src: AudioNode | null }>();
  private mode: TapMode = 'post';
  /** Position du morceau (pour dater une saturation) ; fournie par l'app. */
  public positionOf: () => number | null = () => null;
  readonly loudness = new LoudnessMeter();
  /** Derniers points du goniomètre (L, R alternés). */
  gonio: Float32Array = new Float32Array(0);
  gonioAt = 0;
  private kAt = 0;
  private sampleRate = 48000;
  /** Statistiques de coût (messages reçus, temps passé à les traiter). */
  readonly stats = { messages: 0, handleMs: 0, since: 0 };

  constructor() {
    try { const m = localStorage.getItem('nova_meter_tap'); if (m === 'pre' || m === 'post') this.mode = m; } catch { /* stockage indisponible */ }
  }

  /** Branche le banc sur le contexte du moteur ; `masterOut` = sortie finale du master. */
  init(ctx: BaseAudioContext, masterOut: AudioNode) {
    if (this.ctx === ctx) return;
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    this.ready = false; this.failed = false;
    this.nodes = []; this.used = []; this.masterNode = null;
    this.masterSrc = masterOut;
    this.points.forEach(p => { p.slot = null; });
    loadWorkletModule(ctx, 'nova-meter-bank', WORKLET_CODE).then(() => {
      if (this.ctx !== ctx) return;
      this.ready = true;
      this.masterNode = new AudioWorkletNode(ctx, 'nova-meter-bank-v1', {
        numberOfInputs: 1, numberOfOutputs: 0,
        processorOptions: { core: { loudness: true, gonio: true, tpTaps: 16, tpGate: false }, always: true },
      });
      this.masterNode.port.onmessage = (e) => this.onMessage(e.data, [MASTER_OUT]);
      try { this.masterSrc?.connect(this.masterNode); } catch { /* */ }
      this.taps.forEach((_, id) => this.connectTap(id));
    }).catch(e => { this.failed = true; console.warn('[Mètres] AudioWorklet indisponible :', e); });
  }

  isReady() { return this.ready; }
  hasFailed() { return this.failed; }
  getTapMode(): TapMode { return this.mode; }

  /** Pré-fader (après les effets, avant le fader) ou post-fader (après fader et pan). */
  setTapMode(m: TapMode) {
    if (m === this.mode) return;
    this.mode = m;
    try { localStorage.setItem('nova_meter_tap', m); } catch { /* */ }
    this.taps.forEach((_, id) => this.connectTap(id));
    this.points.forEach(p => { p.hold = [NEG, NEG]; });
    meterClock.poke();
  }

  /** (Re)branche le point de mesure d'une piste : appelé après chaque recâblage de la piste. */
  attachTrack(id: string, pre: AudioNode, post: AudioNode) {
    const prev = this.taps.get(id);
    this.taps.set(id, { pre, post, src: prev && (prev.src === pre || prev.src === post) ? prev.src : null });
    if (!this.points.has(id)) this.points.set(id, freshState());
    if (this.ready) this.connectTap(id);
  }

  detachTrack(id: string) {
    const tap = this.taps.get(id);
    const st = this.points.get(id);
    if (tap?.src && st?.slot) { try { tap.src.disconnect(this.nodes[st.slot.node], 0, st.slot.index); } catch { /* déjà débranché */ } }
    if (st?.slot) {
      this.used[st.slot.node][st.slot.index] = null;
      this.nodes[st.slot.node]?.port.postMessage({ free: st.slot.index });
    }
    this.taps.delete(id);
    this.points.delete(id);
  }

  private allocSlot(id: string): { node: number; index: number } | null {
    if (!this.ctx) return null;
    for (let n = 0; n < this.nodes.length; n++) {
      const i = this.used[n].indexOf(null);
      if (i >= 0) { this.used[n][i] = id; return { node: n, index: i }; }
    }
    const node = new AudioWorkletNode(this.ctx, 'nova-meter-bank-v1', {
      numberOfInputs: SLOTS, numberOfOutputs: 0,
      processorOptions: { core: { tpTaps: 8, tpGate: true } },
    });
    const n = this.nodes.length;
    this.nodes.push(node);
    this.used.push(new Array(SLOTS).fill(null));
    node.port.onmessage = (e) => this.onMessage(e.data, this.used[n]);
    this.used[n][0] = id;
    return { node: n, index: 0 };
  }

  private connectTap(id: string) {
    const tap = this.taps.get(id);
    if (!tap || !this.ready) return;
    let st = this.points.get(id);
    if (!st) { st = freshState(); this.points.set(id, st); }
    if (!st.slot) st.slot = this.allocSlot(id);
    if (!st.slot) return;
    const node = this.nodes[st.slot.node];
    const want = this.mode === 'pre' ? tap.pre : tap.post;
    if (tap.src && tap.src !== want) { try { tap.src.disconnect(node, 0, st.slot.index); } catch { /* */ } }
    // Le recâblage de la piste a coupé toutes ses sorties : on rebranche (sans doublon).
    try { want.disconnect(node, 0, st.slot.index); } catch { /* pas branché */ }
    try { want.connect(node, 0, st.slot.index); tap.src = want; } catch (e) { console.warn('[Mètres] branchement impossible', id, e); }
  }

  private onMessage(msg: { t: number; d: Float64Array; x: Record<number, { k: number[]; g: number[] }> | null }, owners: (string | null)[]) {
    const t0 = performance.now();
    const now = t0;
    const d = msg.d;
    for (let o = 0; o + FIELDS <= d.length; o += FIELDS) {
      const slot = d[o];
      const id = owners[slot];
      if (!id) continue;
      let st = this.points.get(id);
      if (!st) { st = freshState(); this.points.set(id, st); }
      this.apply(st, d, o, now);
      const ex = msg.x && msg.x[slot];
      if (ex && id === MASTER_OUT) {
        if (ex.k.length) { this.loudness.pushMany(ex.k); this.kAt = now; }
        if (ex.g.length) { this.gonio = Float32Array.from(ex.g); this.gonioAt = now; }
      }
    }
    this.stats.messages++;
    this.stats.handleMs += performance.now() - t0;
  }

  private apply(st: PointState, d: Float64Array, o: number, now: number) {
    const n = d[o + 1];
    const dt = n > 0 ? n / this.sampleRate : 1 / 30;
    // Écart depuis la dernière mesure (piste muette qui reprend) : retombée d'abord.
    this.decay(st, now);
    const pk = [d[o + 2], d[o + 3]], tp = [d[o + 4], d[o + 5]], sm = [d[o + 6], d[o + 7]];
    const a = 1 - Math.exp(-dt / RMS_TAU_S);
    for (let ch = 0; ch < 2; ch++) {
      const pdb = lin2db(pk[ch]);
      st.peak[ch] = Math.max(pdb, st.peak[ch]);
      st.ms[ch] += a * ((n > 0 ? sm[ch] / n : 0) - st.ms[ch]);
      st.rms[ch] = lin2db(Math.sqrt(st.ms[ch]));
      const tdb = lin2db(tp[ch]);
      if (tdb >= st.hold[ch] || now - st.holdAt[ch] > HOLD_MS) { st.hold[ch] = tdb; st.holdAt[ch] = now; }
      if (tdb > st.maxTp) st.maxTp = tdb;
      if (pdb > st.maxPeak) st.maxPeak = pdb;
      if (pk[ch] >= 1) { if (st.clip < 2) st.clipAt = st.clipAt ?? this.positionOf(); st.clip = 2; }
      else if (tp[ch] > 1 && st.clip === 0) { st.clip = 1; st.clipAt = this.positionOf(); }
    }
    const b = 1 - Math.exp(-dt / CORR_TAU_S);
    const nn = Math.max(1, n);
    st.lr += b * (d[o + 8] / nn - st.lr);
    st.ll += b * (sm[0] / nn - st.ll);
    st.rr += b * (sm[1] / nn - st.rr);
    st.corr = correlationOf(st.lr, st.ll, st.rr);
    st.stereo = d[o + 9] === 1;
    st.at = now;
  }

  /** Retombée paresseuse : appliquée à la lecture (aucun message quand la piste se tait). */
  private decay(st: PointState, now: number) {
    if (!st.at) return;
    const gap = (now - st.at) / 1000;
    if (gap <= 0.001) return;
    const f = Math.exp(-gap / RMS_TAU_S);
    for (let ch = 0; ch < 2; ch++) {
      st.peak[ch] -= PEAK_FALL_DB_S * gap;
      if (st.peak[ch] < -150) st.peak[ch] = NEG;
      st.ms[ch] *= f;
      st.rms[ch] = lin2db(Math.sqrt(st.ms[ch]));
      if (now - st.holdAt[ch] > HOLD_MS) st.hold[ch] = st.peak[ch];
    }
    st.at = now;
  }

  /** Valeurs à dessiner maintenant (retombée appliquée). null : point inconnu. */
  view(id: string, now = performance.now()): MeterView | null {
    const st = this.points.get(id);
    if (!st) return null;
    this.decay(st, now);
    return st;
  }

  /** Éteint la diode de saturation et la crête maximale (clic sur la diode / la valeur). */
  resetClip(id?: string) {
    const one = (st: PointState) => { st.clip = 0; st.clipAt = null; st.maxTp = NEG; st.maxPeak = NEG; st.hold = [NEG, NEG]; };
    if (id) { const st = this.points.get(id); if (st) one(st); } else this.points.forEach(one);
    meterClock.poke();
  }

  /** LUFS momentané « vivant » : −∞ si plus rien n'arrive depuis 0,5 s. */
  loudnessLive(now = performance.now()) {
    const s = this.loudness.snapshot();
    if (now - this.kAt > 500) { s.momentary = NEG; s.shortTerm = NEG; }
    return s;
  }

  resetLoudness() { this.loudness.reset(); this.resetClip(MASTER_OUT); meterClock.poke(); }

  /** Nombre de nœuds AudioWorklet et de points branchés (rapport de coût). */
  info() { return { nodes: this.nodes.length + (this.masterNode ? 1 : 0), points: this.taps.size, mode: this.mode, ready: this.ready }; }
}

export const meterBank = new MeterBank();

// ---------- Horloge d'affichage partagée (≤ 30 images/s) ----------

type Frame = (now: number) => void;

class MeterClock {
  private subs = new Set<Frame>();
  private raf = 0;
  private last = 0;
  readonly minFrameMs = 1000 / 30 - 2;
  /** Images dessinées et temps passé à dessiner (rapport de coût). */
  readonly stats = { frames: 0, drawMs: 0 };

  subscribe(f: Frame): () => void {
    this.subs.add(f);
    this.start();
    return () => { this.subs.delete(f); if (!this.subs.size && this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; } };
  }

  private start() {
    if (this.raf || typeof requestAnimationFrame === 'undefined') return;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    if (now - this.last < this.minFrameMs) return;
    this.last = now;
    this.run(now);
  };

  private run(now: number) {
    const t0 = performance.now();
    this.subs.forEach(f => { try { f(now); } catch (e) { /* un mètre cassé ne bloque pas les autres */ } });
    this.stats.frames++;
    this.stats.drawMs += performance.now() - t0;
  }

  /** Redessine tout de suite (clic sur une diode, changement d'échelle). */
  poke() { this.run(performance.now()); }
}

export const meterClock = new MeterClock();
