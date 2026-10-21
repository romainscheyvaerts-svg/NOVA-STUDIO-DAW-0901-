/**
 * Rack d'effets parallèles (écart 13) : nœud audio. Règles pures dans engine/fxRack.ts.
 *
 * Déclaré comme un effet du registre (engine/pluginRegistry.ts) : il crée lui-même les effets
 * de ses branches par la fabrique du moteur (`host.createPlugin`, la même qu'à la lecture et à
 * l'export), donc rien ne change dans la construction des pistes d'AudioEngine.
 *
 * Nœuds natifs seulement (gains, filtres, retards) : en lecture comme à l'export, même graphe.
 * Les gains de niveau, de mélange et de sortie existent une fois pour toutes (automation) ;
 * une modification de structure (effet ajouté / retiré / contourné, division changée) recâble
 * les branches, avec un fondu de 10 ms en lecture (aucun clic). Un retard de réalignement n'est
 * câblé que s'il est non nul : une branche sans latence est reliée directement (bit près).
 */
import type { PluginInstance } from '../types';
import { AutomationSet, MappedParam, dbToLin } from './automationParams';
import { retireWorkletsOf } from './workletGuard';
import { activePlugins, levelToGain, rackAlignment, rackStructureKey, sanitizeRack, RACK_MAX_BRANCHES, type RackParams } from './fxRack';

export interface RackHost {
  /** Fabrique des effets du moteur (même code en lecture et à l'export). */
  createPlugin: (plugin: PluginInstance) => { input: AudioNode; output: AudioNode; node: any } | null;
}

interface Child { id: string; type: string; input: AudioNode; output: AudioNode; node: any; paramsKey: string }

const PDC_MAX = 2;
/** Butterworth : Q = 1/√2, en dB pour les filtres passe-bas / passe-haut du Web Audio. */
const BW_Q_DB = 20 * Math.log10(Math.SQRT1_2);

export class FxRackNode {
  public input: GainNode;
  public output: GainNode;
  private ctx: BaseAudioContext;
  private host: RackHost | null;
  private params: RackParams;
  private children = new Map<string, Child>();
  /** Nœuds de la structure courante (recréés à chaque recâblage). */
  private graph: AudioNode[] = [];
  /** Filtres de séparation des bandes, avec leur coupure (1 ou 2). */
  private xfilters: { f: BiquadFilterNode; which: 1 | 2 }[] = [];
  private structKey = '';
  private alignKey = '';
  private latencySamples = 0;
  private disposed = false;
  private rewireTimer: ReturnType<typeof setTimeout> | null = null;
  private lowLatency = false;
  // Nœuds permanents (automation).
  private dry: GainNode;
  private wet: GainNode;
  private out: GainNode;
  private fade: GainNode;
  private levels: GainNode[] = [];
  private mutes: GainNode[] = [];
  private auto = new AutomationSet();
  private automated = new Set<string>();

  constructor(ctx: BaseAudioContext, plugin: PluginInstance, host?: RackHost) {
    this.ctx = ctx;
    this.host = host || null;
    this.params = sanitizeRack(plugin.params || {});
    this.input = ctx.createGain();
    this.input.channelCount = 2; this.input.channelCountMode = 'explicit'; this.input.channelInterpretation = 'speakers';
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.out = ctx.createGain();
    this.fade = ctx.createGain();
    for (let i = 0; i < RACK_MAX_BRANCHES; i++) { this.levels.push(ctx.createGain()); this.mutes.push(ctx.createGain()); }
    this.dry.connect(this.out);
    this.wet.connect(this.out);
    this.out.connect(this.fade);
    this.fade.connect(this.output);
    // Automation : mélange, sortie, niveau de chaque branche (MappedParam : lecture et export).
    const m = this.params.mix;
    this.auto.add('mix', new MappedParam(ctx, [{ param: this.dry.gain, map: (v: number) => 1 - v / 100 }, { param: this.wet.gain, map: (v: number) => v / 100 }], { min: 0, max: 100, value: m, affine: true }));
    this.auto.add('outGain', new MappedParam(ctx, [{ param: this.out.gain, map: dbToLin }], { min: -24, max: 12, value: this.params.outGain }));
    this.levels.forEach((g, i) => this.auto.add(`br${i + 1}Level`, new MappedParam(ctx, [{ param: g.gain, map: levelToGain }], { min: -80, max: 12, value: this.params.branches[i]?.level ?? 0 })));
    this.rebuild();
    this.applyGains(true);
  }

  // ── Câblage ──────────────────────────────────────────────────────────────────────

  private childLatencySamples(c: Child): number {
    const l = c.node?.latency;
    return typeof l === 'number' && l > 0 && l < 0.5 ? Math.round(l * this.ctx.sampleRate) : 0;
  }

  /** Effets des branches : gardés s'ils existent déjà (même id et type), créés sinon ; `prune` libère ceux qui ont disparu. */
  private syncChildren(prune = true) {
    const keep = new Set<string>();
    for (const b of this.params.branches) {
      for (const p of b.plugins) {
        keep.add(p.id);
        const ex = this.children.get(p.id);
        if (ex && ex.type === p.type) continue;
        if (ex) { if (!prune) continue; this.disposeChild(ex); }
        if (!this.host) continue;
        let made: { input: AudioNode; output: AudioNode; node: any } | null = null;
        try { made = this.host.createPlugin({ ...p, isEnabled: true }); } catch (e) { console.warn('[Rack] effet ignoré', p.type, e); }
        if (!made) continue;
        const c: Child = { id: p.id, type: p.type, input: made.input, output: made.output, node: made.node, paramsKey: JSON.stringify(p.params || {}) };
        if (this.lowLatency) { try { c.node?.updateParams?.({ ...p.params, lowLatency: true }); } catch { /* */ } }
        this.children.set(p.id, c);
      }
    }
    if (prune) this.children.forEach((c, id) => { if (!keep.has(id)) { this.disposeChild(c); this.children.delete(id); } });
  }

  private disposeChild(c: Child) {
    try { c.input.disconnect(); } catch { /* */ }
    try { c.output.disconnect(); } catch { /* */ }
    retireWorkletsOf(c.node);
    try { c.node?.dispose?.(); } catch { /* */ }
  }

  private branchLatencies(): number[] {
    return this.params.branches.map(b => activePlugins(b).reduce((s, p) => { const c = this.children.get(p.id); return s + (c ? this.childLatencySamples(c) : 0); }, 0));
  }

  /** Recâble entièrement le rack (structure, réalignement). */
  private rebuild() {
    this.syncChildren();
    // Anciens liens de structure coupés (les effets gardent leur graphe interne).
    try { this.input.disconnect(); } catch { /* */ }
    for (const n of this.graph) { try { n.disconnect(); } catch { /* */ } }
    this.children.forEach(c => { try { c.output.disconnect(); } catch { /* */ } });
    this.levels.forEach(g => { try { g.disconnect(); } catch { /* */ } });
    this.mutes.forEach(g => { try { g.disconnect(); } catch { /* */ } });
    this.graph = [];
    this.xfilters = [];
    const ctx = this.ctx, sr = ctx.sampleRate, p = this.params;
    const keep = <T extends AudioNode>(n: T) => { this.graph.push(n); return n; };
    const delayOf = (from: AudioNode, samples: number): AudioNode => {
      if (samples <= 0) return from;
      const d = keep(ctx.createDelay(PDC_MAX));
      d.delayTime.value = samples / sr;
      from.connect(d);
      return d;
    };
    const lats = this.branchLatencies();
    const al = rackAlignment(lats);
    this.latencySamples = al.latency;
    this.alignKey = JSON.stringify(lats);
    // Son sec, retardé de la latence du rack.
    delayOf(this.input, al.latency).connect(this.dry);
    // Division.
    const heads = this.splitHeads();
    // Branches : effets en série → réalignement → coupure / solo → niveau → somme humide (ou décodage M/S).
    const tails: AudioNode[] = [];
    p.branches.forEach((b, i) => {
      let head: AudioNode = heads[i];
      for (const pl of activePlugins(b)) {
        const c = this.children.get(pl.id);
        if (!c) continue;
        head.connect(c.input);
        head = c.output;
      }
      head = delayOf(head, al.delays[i]);
      head.connect(this.mutes[i]);
      this.mutes[i].connect(this.levels[i]);
      tails.push(this.levels[i]);
    });
    if (p.mode === 'ms') this.decodeMs(tails[0], tails[1]);
    else tails.forEach(t => t.connect(this.wet));
    this.structKey = rackStructureKey(p);
  }

  /** Entrée de chaque branche selon la division. */
  private splitHeads(): AudioNode[] {
    const ctx = this.ctx, p = this.params;
    const keep = <T extends AudioNode>(n: T) => { this.graph.push(n); return n; };
    const n = p.branches.length;
    if (p.mode === 'parallele') return Array.from({ length: n }, () => this.input);
    if (p.mode === 'ms') {
      // M = (G + D) / 2 sur les deux canaux ; S = (G − D) / 2 sur les deux canaux.
      const sp = keep(ctx.createChannelSplitter(2));
      this.input.connect(sp);
      const mk = (sign: number) => {
        const merger = keep(ctx.createChannelMerger(2));
        const a = keep(ctx.createGain()); a.gain.value = 0.5;
        const bb = keep(ctx.createGain()); bb.gain.value = 0.5 * sign;
        sp.connect(a, 0); sp.connect(bb, 1);
        const sum = keep(ctx.createGain());
        a.connect(sum); bb.connect(sum);
        sum.connect(merger, 0, 0); sum.connect(merger, 0, 1);
        return merger;
      };
      return [mk(1), mk(-1)];
    }
    // Bandes : Linkwitz-Riley 24 dB/oct (deux Butterworth 12 dB/oct en série).
    const lr4 = (from: AudioNode, type: BiquadFilterType, f: number) => {
      const a = keep(ctx.createBiquadFilter()), b = keep(ctx.createBiquadFilter());
      for (const x of [a, b]) { x.type = type; x.frequency.value = f; x.Q.value = BW_Q_DB; this.xfilters.push({ f: x, which: f === p.x1 ? 1 : 2 }); }
      from.connect(a); a.connect(b);
      return b;
    };
    if (p.bandCount < 3) return [lr4(this.input, 'lowpass', p.x1), lr4(this.input, 'highpass', p.x1)];
    const low1 = lr4(this.input, 'lowpass', p.x1);
    const hi1 = lr4(this.input, 'highpass', p.x1);
    // Grave : passe-tout de la 2e coupure (somme passe-bas + passe-haut LR4), la somme reste plate.
    const ap = keep(ctx.createGain());
    lr4(low1, 'lowpass', p.x2).connect(ap);
    lr4(low1, 'highpass', p.x2).connect(ap);
    return [ap, lr4(hi1, 'lowpass', p.x2), lr4(hi1, 'highpass', p.x2)];
  }

  /** Décodage M/S : M' = moyenne des canaux de la branche centre, S' idem côtés ; G = M' + S', D = M' − S'. */
  private decodeMs(mTail: AudioNode, sTail: AudioNode) {
    const ctx = this.ctx;
    const keep = <T extends AudioNode>(n: T) => { this.graph.push(n); return n; };
    const mono = (from: AudioNode) => {
      const sp = keep(ctx.createChannelSplitter(2));
      from.connect(sp);
      const sum = keep(ctx.createGain());
      const a = keep(ctx.createGain()); a.gain.value = 0.5;
      const b = keep(ctx.createGain()); b.gain.value = 0.5;
      sp.connect(a, 0); sp.connect(b, 1); a.connect(sum); b.connect(sum);
      return sum;
    };
    const M = mono(mTail), S = mono(sTail);
    const negS = keep(ctx.createGain()); negS.gain.value = -1;
    S.connect(negS);
    const merger = keep(ctx.createChannelMerger(2));
    M.connect(merger, 0, 0); S.connect(merger, 0, 0);
    M.connect(merger, 0, 1); negS.connect(merger, 0, 1);
    merger.connect(this.wet);
  }

  // ── Réglages ─────────────────────────────────────────────────────────────────────

  private applyGains(immediate = false) {
    const p = this.params;
    const opts = { immediate: immediate || !this.realtime(), force: immediate };
    const put = (k: string, v: number) => { if (!this.automated.has(k)) this.auto.get(k)!.setStatic(v, opts); };
    put('mix', p.mix);
    put('outGain', p.outGain);
    for (let i = 0; i < RACK_MAX_BRANCHES; i++) {
      const b = p.branches[i];
      put(`br${i + 1}Level`, b ? b.level : 0);
      // Coupure / solo : gain séparé (l'automation du niveau n'est jamais contrariée).
      const anySolo = p.branches.some(x => x.solo);
      const on = b && !b.mute && !(anySolo && !b.solo) ? 1 : 0;
      const g = this.mutes[i].gain, t = this.ctx.currentTime;
      if (opts.immediate) { g.cancelScheduledValues(t); g.setValueAtTime(on, t); }
      else g.setTargetAtTime(on, t, 0.008);
    }
  }

  /** Contexte de lecture (sinon rendu hors ligne : export, où tout est immédiat). */
  private realtime() { return typeof (this.ctx as any).startRendering !== 'function'; }

  public updateParams(raw: Record<string, any>) {
    if (!raw || this.disposed) return;
    if (typeof raw.lowLatency === 'boolean' && raw.lowLatency !== this.lowLatency) {
      this.lowLatency = raw.lowLatency;
      this.children.forEach(c => { try { c.node?.updateParams?.({ lowLatency: this.lowLatency }); } catch { /* */ } });
    }
    const hasRack = ['mode', 'branches', 'bandCount', 'x1', 'x2', 'mix', 'outGain'].some(k => k in raw);
    if (!hasRack) return;
    const next = sanitizeRack({ ...this.params, ...raw });
    const prev = this.params;
    this.params = next;
    // Réglages des effets des branches.
    next.branches.forEach(b => b.plugins.forEach(pl => {
      const c = this.children.get(pl.id);
      if (!c) return;
      const k = JSON.stringify(pl.params || {});
      if (k === c.paramsKey) return;
      c.paramsKey = k;
      try { c.node?.updateParams?.({ ...pl.params, isEnabled: true, ...(this.lowLatency ? { lowLatency: true } : {}) }); } catch (e) { console.warn('[Rack] réglage refusé', pl.type, e); }
    }));
    // Nouveaux effets créés tout de suite (leur latence est connue avant le recâblage) ; les effets
    // retirés restent branchés jusqu'au recâblage, sous le fondu.
    this.syncChildren(false);
    const lats = this.branchLatencies();
    const structChanged = rackStructureKey(next) !== this.structKey;
    const alignChanged = JSON.stringify(lats) !== this.alignKey;
    // Latence annoncée tout de suite : le moteur recalcule la compensation dans la même mise à jour.
    this.latencySamples = rackAlignment(lats).latency;
    if (structChanged || alignChanged) this.scheduleRewire();
    else if (next.mode === 'bandes' && (next.x1 !== prev.x1 || next.x2 !== prev.x2)) this.retuneCrossovers();
    this.applyGains();
  }

  private retuneCrossovers() {
    const p = this.params, t = this.ctx.currentTime;
    for (const x of this.xfilters) x.f.frequency.setTargetAtTime(x.which === 1 ? p.x1 : p.x2, t, 0.01);
  }

  /** Recâblage : immédiat à l'export, sinon fondu 10 ms → recâblage → fondu retour. */
  private scheduleRewire() {
    if (!this.realtime()) { this.rebuild(); return; }
    if (this.rewireTimer) return;
    const g = this.fade.gain, now = this.ctx.currentTime;
    try { g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + 0.01); } catch { /* */ }
    this.rewireTimer = setTimeout(() => {
      this.rewireTimer = null;
      if (this.disposed) return;
      this.rebuild();
      this.applyGains(true);
      const t = this.ctx.currentTime;
      try { g.cancelScheduledValues(t); g.setValueAtTime(0, t); g.linearRampToValueAtTime(1, t + 0.01); } catch { /* */ }
    }, 15);
  }

  // ── Interface moteur ─────────────────────────────────────────────────────────────

  /** Retard ajouté (s) : la plus grande latence des branches, compensée par le moteur (PDC). */
  public get latency(): number { return this.latencySamples / this.ctx.sampleRate; }

  /** Effets des branches chargés (l'export les attend). */
  public get ready(): Promise<unknown> | undefined {
    const ps = [...this.children.values()].map(c => c.node?.ready).filter(x => x instanceof Promise);
    return ps.length ? Promise.all(ps) : undefined;
  }

  public getParams(): RackParams { return this.params; }

  /** Nœud d'un effet d'une branche (fenêtre de l'effet dans le rack). */
  public childNode(pluginId: string): any { return this.children.get(pluginId)?.node ?? null; }

  public automationParam(key: string): MappedParam | null {
    const mp = this.auto.get(key);
    if (mp) this.automated.add(key);
    return mp;
  }

  public restoreStatic() {
    this.automated.clear();
    this.auto.restoreStatic();
    this.applyGains(true);
    this.children.forEach(c => { try { c.node?.restoreStatic?.(); } catch { /* */ } });
  }

  /** Départ de lecture : les effets des branches qui savent repartir d'un état connu le font. */
  public resetAt(at: number) { this.children.forEach(c => { try { c.node?.resetAt?.(at); } catch { /* */ } }); }

  public disconnect() { try { this.input.disconnect(); } catch { /* */ } try { this.output.disconnect(); } catch { /* */ } }

  public dispose() {
    this.disposed = true;
    if (this.rewireTimer) { clearTimeout(this.rewireTimer); this.rewireTimer = null; }
    this.children.forEach(c => this.disposeChild(c));
    this.children.clear();
    for (const n of [...this.graph, this.input, this.output, this.dry, this.wet, this.out, this.fade, ...this.levels, ...this.mutes]) { try { n.disconnect(); } catch { /* */ } }
  }
}
