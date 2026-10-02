import { DrumRackNode } from './DrumRackNode';
import { DrumRow, padFxPlugins, padSends } from '../utils/drumKits';

type CreateNode = (plugin: any, ctx: BaseAudioContext) => { input: AudioNode; output: AudioNode; node: any } | null;

interface PadChain {
  input: GainNode;
  output: GainNode;
  verb: GainNode;
  delay: GainNode;
  /** Plugins créés, par id stable (pad-eq, pad-comp, pad-sat). */
  plugins: Map<string, { input: AudioNode; output: AudioNode; node: any }>;
  signature: string | null;
}

/**
 * Mix par pad de la batterie : chaque pad passe dans sa propre chaîne
 * d'effets natifs du DAW (EQ, compresseur, saturateur), puis vers la sortie du
 * drum rack, avec ses envois vers la réverb et le délai du projet.
 * Utilisé en lecture (contexte live) et à l'export (contexte offline).
 */
export class DrumPadFxBank {
  private chains = new Map<number, PadChain>();

  constructor(private ctx: BaseAudioContext, private rack: DrumRackNode, private create: CreateNode) {}

  /**
   * @param sendTarget entrée de la piste de retour (« send-verb-short », « send-delay »)
   * @param trackLevel volume de la piste (0 si muette) : appliqué aux envois des pads
   */
  configure(rows: DrumRow[], sendTarget: (id: string) => AudioNode | undefined, trackLevel: number) {
    rows.forEach((row, i) => {
      const padId = i + 1;
      const plugins = padFxPlugins(row);
      const sends = padSends(row);
      const needsChain = plugins.length > 0 || sends.verb > 0 || sends.delay > 0;
      let chain = this.chains.get(padId);

      if (!needsChain) {
        if (chain) this.teardown(padId, chain);
        return;
      }
      if (!chain) {
        chain = {
          input: this.ctx.createGain(), output: this.ctx.createGain(),
          verb: this.ctx.createGain(), delay: this.ctx.createGain(),
          plugins: new Map(), signature: null,
        };
        chain.output.connect(this.rack.output);
        this.chains.set(padId, chain);
        this.rack.setPadInput(padId, chain.input);
      }

      // Effets : on ne recâble que si la liste change, sinon on met à jour les réglages.
      const signature = plugins.map(p => p.id).join('|');
      if (signature !== chain.signature) {
        try { chain.input.disconnect(); } catch { /* */ }
        chain.plugins.forEach(p => { try { p.output.disconnect(); } catch { /* */ } try { p.node?.dispose?.(); } catch { /* */ } });
        chain.plugins.clear();
        let head: AudioNode = chain.input;
        for (const p of plugins) {
          const n = this.create(p, this.ctx);
          if (!n) continue;
          chain.plugins.set(p.id, n);
          head.connect(n.input);
          head = n.output;
        }
        head.connect(chain.output);
        chain.signature = signature;
      } else {
        for (const p of plugins) chain.plugins.get(p.id)?.node?.updateParams?.(p.params);
      }

      // Envois vers les retours du projet (suivent le volume de la piste).
      this.routeSend(chain.output, chain.verb, sendTarget('send-verb-short'), sends.verb * trackLevel);
      this.routeSend(chain.output, chain.delay, sendTarget('send-delay'), sends.delay * trackLevel);
    });

    // Pads supprimés
    this.chains.forEach((chain, padId) => { if (padId > rows.length) this.teardown(padId, chain); });
  }

  /** Promesses des effets qui se chargent (export offline). */
  readyPromises(): Promise<unknown>[] {
    const out: Promise<unknown>[] = [];
    this.chains.forEach(c => c.plugins.forEach(p => { if (p.node?.ready instanceof Promise) out.push(p.node.ready); }));
    return out;
  }

  private routeSend(from: AudioNode, gain: GainNode, target: AudioNode | undefined, level: number) {
    try { from.disconnect(gain); } catch { /* pas encore relié */ }
    try { gain.disconnect(); } catch { /* */ }
    if (!target || level <= 0) return;
    gain.gain.value = level;
    from.connect(gain);
    gain.connect(target);
  }

  private teardown(padId: number, chain: PadChain) {
    this.rack.setPadInput(padId, null);
    for (const n of [chain.input, chain.output, chain.verb, chain.delay]) { try { n.disconnect(); } catch { /* */ } }
    chain.plugins.forEach(p => { try { p.output.disconnect(); } catch { /* */ } try { p.node?.dispose?.(); } catch { /* */ } });
    this.chains.delete(padId);
  }
}
