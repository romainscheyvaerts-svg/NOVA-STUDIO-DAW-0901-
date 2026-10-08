/**
 * R15 · Envoi du son vers la carte (pont ASIO) par un AudioWorklet : le master et les
 * mixes casque (K canaux) sont pris dans le fil audio, par blocs de 256 échantillons
 * entrelacés, et remis au fil principal qui les envoie au pont.
 *
 * Avant, un ScriptProcessor (déprécié) tournait sur le fil principal : dès que
 * l'interface était occupée (fenêtre ouverte, gros projet), des blocs étaient sautés et
 * la sortie de la carte craquait. Ici aucun bloc n'est perdu : s'il est en retard, il
 * attend dans la file des messages (le pont borne la latence de son côté).
 */
import { retireWorkletNode } from './workletGuard';

const CODE = `
class NovaAsioOut extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.k = Math.max(1, Math.min(32, o.channels || 2));
    this.size = Math.max(128, o.block || 256);
    this.buf = new Float32Array(this.size * this.k);
    this.n = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    const len = inp && inp[0] ? inp[0].length : 128;
    const k = this.k;
    for (let i = 0; i < len; i++) {
      const o = this.n * k;
      for (let c = 0; c < k; c++) this.buf[o + c] = inp && inp[c] ? inp[c][i] : 0;
      if (++this.n === this.size) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.size * k);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('nova-asio-out', NovaAsioOut);
`;

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

function ensureModule(ctx: AudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([CODE], { type: 'application/javascript' }));
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    loaded.set(ctx, p);
    p.catch(() => loaded.delete(ctx));
  }
  return p;
}

export interface AsioOutputTap {
  /** Entrée du nœud (K canaux discrets) : y brancher le merger master + mixes. */
  node: AudioWorkletNode;
  dispose: () => void;
}

/** Nœud d'envoi : chaque bloc (images × `channels`, entrelacé) est passé à `onBlock`. */
export async function createAsioOutputTap(ctx: AudioContext, channels: number, onBlock: (interleaved: Float32Array) => void, block = 256): Promise<AsioOutputTap> {
  await ensureModule(ctx);
  const node = new AudioWorkletNode(ctx, 'nova-asio-out', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'discrete',
    processorOptions: { channels, block },
  });
  node.port.onmessage = (e) => { if (e.data instanceof Float32Array) onBlock(e.data); };
  // Relié à la sortie (gain nul) pour être cadencé par le moteur audio.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(ctx.destination);
  return {
    node,
    dispose: () => {
      node.port.onmessage = null;
      try { node.disconnect(); sink.disconnect(); } catch { /* */ }
      retireWorkletNode(node);
    },
  };
}
