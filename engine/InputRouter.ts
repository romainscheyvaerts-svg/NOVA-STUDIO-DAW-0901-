/**
 * R14 · Aiguillage des entrées vers les pistes armées (plusieurs à la fois).
 *
 * UNE source partagée (le micro du navigateur en multicanal, ou toutes les entrées de
 * la carte via le pont ASIO) est séparée canal par canal ; chaque piste armée prend
 * SON entrée (mono : un canal, stéréo : une paire), avec :
 *  - son retour casque (gain → entrée de la piste, donc ses effets) ;
 *  - son vumètre d'entrée (AnalyserNode de la piste) ;
 *  - sa part de l'enregistreur commun (voir recorderInput : un seul enregistreur pour
 *    toutes les pistes, alignement à l'échantillon).
 *
 * Entrée « auto » (piste sans réglage) : comme avant R14 — sur la carte, l'entrée des
 * Réglages audio (ou 1+2 additionnées) ; au navigateur, la moyenne des canaux du micro.
 */
import type { RecordInput } from '../types';
import { channelsOf, inputWidth } from '../utils/multiRecord';

export interface RouterSource {
  node: AudioNode;
  /** Sortie du nœud à utiliser (ASIOInput : 1 = toutes les entrées). */
  output: number;
  /** Canaux portés par la source. */
  channels: number;
  kind: 'asio' | 'navigateur';
  /** Entrée « auto » sur la carte : -1 = entrées 1+2 additionnées, sinon l'entrée. */
  autoChannel: number;
}

export interface InputTap {
  trackId: string;
  spec: RecordInput | null;
  width: 1 | 2;
  /** Signal de la piste (1 ou 2 canaux). */
  out: GainNode;
  /** Retour casque vers l'entrée de la piste. */
  monitor: GainNode;
  /** Canaux de la source réellement lus (auto résolu). */
  channels: number[];
  /** Entrée demandée absente de la source. */
  missing: boolean;
  dest: AudioNode;
  analyser?: AnalyserNode;
  /** Nœuds intermédiaires (paire stéréo), à débrancher. */
  extra: AudioNode[];
}

export class InputRouter {
  private source: RouterSource | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private taps = new Map<string, InputTap>();

  constructor(private ctx: AudioContext) {}

  getSource() { return this.source; }
  ids(): string[] { return [...this.taps.keys()]; }
  has(trackId: string) { return this.taps.has(trackId); }
  tap(trackId: string) { return this.taps.get(trackId) || null; }
  all(): InputTap[] { return [...this.taps.values()]; }
  get size() { return this.taps.size; }

  /** Nouvelle source (micro rouvert, flux de la carte) : toutes les pistes armées sont recâblées. */
  setSource(src: RouterSource | null) {
    const prev = { splitter: this.splitter, source: this.source?.node || null };
    for (const t of this.taps.values()) this.unwire(t, prev.splitter, prev.source);
    if (this.splitter) { try { this.source?.node.disconnect(this.splitter); } catch { /* */ } try { this.splitter.disconnect(); } catch { /* */ } }
    this.splitter = null;
    this.source = src;
    if (src) {
      this.splitter = this.ctx.createChannelSplitter(Math.max(1, Math.min(32, src.channels)));
      try { src.node.connect(this.splitter, src.output); } catch (e) { console.warn('[InputRouter] source', e); }
    }
    for (const t of this.taps.values()) this.wire(t, { splitter: null, source: null });
  }

  /** Canaux lus par une piste (auto résolu selon la source). */
  resolve(spec: RecordInput | null): { channels: number[]; mode: 'mono' | 'stereo' | 'sum' | 'average' } {
    const ch = channelsOf(spec);
    if (ch.length) return { channels: ch, mode: ch.length > 1 ? 'stereo' : 'mono' };
    const s = this.source;
    if (s?.kind === 'asio') {
      if (s.autoChannel >= 0) return { channels: [s.autoChannel], mode: 'mono' };
      return { channels: s.channels > 1 ? [0, 1] : [0], mode: 'sum' };
    }
    const n = Math.max(1, Math.min(2, s?.channels || 1));
    return { channels: n > 1 ? [0, 1] : [0], mode: 'average' };
  }

  /** Débranche ce qui ENTRE dans le tap (ses sorties : retour, vumètre, enregistreur, restent). */
  private unwire(t: InputTap, splitter: ChannelSplitterNode | null, source: AudioNode | null) {
    try { splitter?.disconnect(t.out); } catch { /* */ }
    try { source?.disconnect(t.out); } catch { /* */ }
    t.extra.forEach(n => { try { splitter?.disconnect(n); } catch { /* */ } try { n.disconnect(); } catch { /* */ } });
    t.extra = [];
  }

  private wire(t: InputTap, prev?: { splitter: ChannelSplitterNode | null; source: AudioNode | null }) {
    this.unwire(t, prev ? prev.splitter : this.splitter, prev ? prev.source : (this.source?.node || null));
    const r = this.resolve(t.spec);
    t.channels = r.channels;
    const avail = this.source?.channels || 0;
    t.missing = !!channelsOf(t.spec).length && channelsOf(t.spec).some(c => c >= avail);
    if (!this.source || !this.splitter) return;
    const sp = this.splitter;
    const ok = (c: number) => c < avail;
    if (r.mode === 'average') {
      // Navigateur, entrée auto : la source entière, réduite en mono (moyenne).
      try { this.source.node.connect(t.out, this.source.output); } catch { /* */ }
      return;
    }
    if (r.mode === 'stereo') {
      const m = this.ctx.createChannelMerger(2);
      if (ok(r.channels[0])) sp.connect(m, r.channels[0], 0);
      if (ok(r.channels[1])) sp.connect(m, r.channels[1], 1);
      m.connect(t.out);
      t.extra.push(m);
      return;
    }
    // mono, ou somme 1+2 (plusieurs canaux branchés sur une entrée mono = addition)
    for (const c of r.channels) if (ok(c)) sp.connect(t.out, c);
  }

  /** Arme une piste : son entrée, son retour casque (`monitorGain`), son vumètre. */
  arm(trackId: string, spec: RecordInput | null, dest: AudioNode, analyser: AnalyserNode | undefined, monitorGain: number): InputTap {
    this.disarm(trackId);
    const width = inputWidth(spec);
    const out = this.ctx.createGain();
    out.channelCount = width;
    out.channelCountMode = 'explicit';
    out.channelInterpretation = width === 1 ? 'speakers' : 'discrete';
    const monitor = this.ctx.createGain();
    monitor.gain.value = monitorGain;
    out.connect(monitor);
    monitor.connect(dest);
    if (analyser) out.connect(analyser);
    const t: InputTap = { trackId, spec, width, out, monitor, channels: [], missing: false, dest, analyser, extra: [] };
    this.taps.set(trackId, t);
    this.wire(t);
    return t;
  }

  /** Change l'entrée d'une piste armée (le retour et le vumètre suivent). */
  setSpec(trackId: string, spec: RecordInput | null): InputTap | null {
    const t = this.taps.get(trackId);
    if (!t) return null;
    if (inputWidth(spec) !== t.width) {
      // Largeur différente (mono ↔ stéréo) : nouveau tap.
      return this.arm(trackId, spec, t.dest, t.analyser, t.monitor.gain.value);
    }
    t.spec = spec;
    this.wire(t);
    return t;
  }

  disarm(trackId: string) {
    const t = this.taps.get(trackId);
    if (!t) return;
    this.taps.delete(trackId);
    this.unwire(t, this.splitter, this.source?.node || null);
    try { t.out.disconnect(); } catch { /* */ }
    try { t.monitor.disconnect(); } catch { /* */ }
  }

  clear() { for (const id of [...this.taps.keys()]) this.disarm(id); }

  setMonitorGain(gain: number, at: number, only?: (t: InputTap) => boolean) {
    for (const t of this.taps.values()) {
      const g = only && !only(t) ? 0 : gain;
      t.monitor.gain.setTargetAtTime(g, at, 0.01);
    }
  }

  /**
   * Entrée de l'enregistreur commun : les pistes à enregistrer mises côte à côte dans
   * un ChannelMerger (une colonne par canal). `layout` : où commence chaque piste.
   */
  recorderInput(trackIds: string[]): { node: ChannelMergerNode; channels: number; layout: { trackId: string; first: number; width: 1 | 2 }[]; dispose: () => void } | null {
    const taps = trackIds.map(id => this.taps.get(id)).filter((t): t is InputTap => !!t);
    if (!taps.length) return null;
    const total = taps.reduce((s, t) => s + t.width, 0);
    if (total > 32) return null;
    const merger = this.ctx.createChannelMerger(total);
    const extra: AudioNode[] = [];
    const layout: { trackId: string; first: number; width: 1 | 2 }[] = [];
    let k = 0;
    for (const t of taps) {
      layout.push({ trackId: t.trackId, first: k, width: t.width });
      if (t.width === 1) t.out.connect(merger, 0, k);
      else {
        const sp = this.ctx.createChannelSplitter(2);
        t.out.connect(sp);
        sp.connect(merger, 0, k);
        sp.connect(merger, 1, k + 1);
        extra.push(sp);
      }
      k += t.width;
    }
    return {
      node: merger, channels: total, layout,
      dispose: () => {
        for (const t of taps) { try { t.out.disconnect(merger); } catch { /* */ } }
        extra.forEach(n => { try { n.disconnect(); } catch { /* */ } });
        for (const t of taps) extra.forEach(n => { try { t.out.disconnect(n); } catch { /* */ } });
        try { merger.disconnect(); } catch { /* */ }
      },
    };
  }
}
