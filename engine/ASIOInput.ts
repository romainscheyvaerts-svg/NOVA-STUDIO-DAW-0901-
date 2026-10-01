/**
 * Entrée de la carte son reçue par le pont ASIO → flux audio utilisable comme
 * un micro (retour casque, vumètre, MediaRecorder).
 *
 * Le pont envoie des blocs d'échantillons entrelacés à SA fréquence
 * d'échantillonnage. Un AudioWorklet les met dans un tampon circulaire, les
 * convertit à la fréquence du DAW (interpolation linéaire) et les ressort.
 *
 * Canaux : en cabine le micro est en général seul sur l'entrée 1 ; prendre
 * l'entrée en stéréo enregistrerait la voix à gauche uniquement. Par défaut on
 * additionne donc les entrées en mono (« mix »), ou on prend une entrée précise.
 */

const WORKLET = `
class AsioInputPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = sampleRate * 2;            // 2 s de tampon
    this.buf = new Float32Array(this.size);
    this.w = 0;                             // index d'écriture (en échantillons source rééchantillonnés)
    this.r = 0;                             // index de lecture (fractionnaire)
    this.fill = 0;
    this.started = false;
    this.prebuffer = Math.round(sampleRate * 0.03);   // 30 ms de marge contre la gigue réseau
    this.maxFill = Math.round(sampleRate * 0.15);     // au-delà : on rattrape (latence bornée)
    this.channel = -1;                      // -1 = mix des entrées
    this.srcPos = 0;                        // position fractionnaire dans le flux source
    this.last = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'channel') { this.channel = m.channel; return; }
      if (m.type !== 'audio') return;
      const data = m.data, ch = Math.max(1, m.channels), n = Math.floor(data.length / ch);
      const ratio = (m.rate || sampleRate) / sampleRate;   // pas source par échantillon de sortie
      // Signal mono de ce bloc
      const mono = new Float32Array(n);
      if (this.channel >= 0 && this.channel < ch) {
        for (let i = 0; i < n; i++) mono[i] = data[i * ch + this.channel];
      } else {
        const use = Math.min(ch, 2);
        for (let i = 0; i < n; i++) { let v = 0; for (let c = 0; c < use; c++) v += data[i * ch + c]; mono[i] = v; }
      }
      // Rééchantillonnage linéaire vers sampleRate (continu d'un bloc à l'autre)
      // ext[0] = dernier échantillon du bloc précédent : interpolation sans raccord.
      const ext = new Float32Array(n + 1);
      ext[0] = this.last;
      ext.set(mono, 1);
      let pos = this.srcPos;
      while (pos < n) {
        const i = Math.floor(pos), f = pos - i;
        const v = ext[i] + (ext[i + 1] - ext[i]) * f;
        this.buf[this.w] = v;
        this.w = (this.w + 1) % this.size;
        if (this.fill < this.size) this.fill++;
        else this.r = (this.r + 1) % this.size;
        pos += ratio;
      }
      this.srcPos = pos - n;
      this.last = mono[n - 1] || 0;
      // Trop d'avance (onglet en arrière-plan, rafale réseau) : on saute pour garder une latence faible.
      if (this.fill > this.maxFill) {
        const drop = this.fill - this.prebuffer;
        this.r = (this.r + drop) % this.size;
        this.fill -= drop;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const len = out[0].length;
    if (!this.started) {
      if (this.fill >= this.prebuffer) this.started = true;
      else { for (const c of out) c.fill(0); return true; }
    }
    for (let i = 0; i < len; i++) {
      let v = 0;
      if (this.fill > 0) { v = this.buf[this.r]; this.r = (this.r + 1) % this.size; this.fill--; }
      else this.started = false;              // tampon vide : on se remet en pré-remplissage
      for (const c of out) c[i] = v;
    }
    return true;
  }
}
registerProcessor('asio-input-player', AsioInputPlayer);
`;

export class ASIOInput {
  private ctx: AudioContext;
  private node: AudioWorkletNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private ready: Promise<void> | null = null;
  /** Fréquence d'échantillonnage du pont (mise à jour par la config / les stats). */
  public sourceRate: number;
  private channel = -1;

  constructor(ctx: AudioContext, sourceRate = 44100) {
    this.ctx = ctx;
    this.sourceRate = sourceRate;
  }

  private init(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      try { await this.ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      this.node = new AudioWorkletNode(this.ctx, 'asio-input-player', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      });
      this.node.port.postMessage({ type: 'channel', channel: this.channel });
      this.dest = this.ctx.createMediaStreamDestination();
      this.dest.channelCount = 2;
      this.node.connect(this.dest);
    })();
    return this.ready;
  }

  /** Flux à utiliser à la place de getUserMedia. Ses pistes ne doivent jamais être stoppées. */
  public async getStream(): Promise<MediaStream> {
    await this.init();
    return this.dest!.stream;
  }

  /** Bloc reçu du pont (échantillons entrelacés). */
  public push(data: Float32Array, channels: number) {
    if (!this.node) return;
    // Copie : le tampon d'origine est une vue sur le message WebSocket.
    const copy = new Float32Array(data);
    this.node.port.postMessage({ type: 'audio', data: copy, channels, rate: this.sourceRate }, [copy.buffer]);
  }

  /** -1 = mix des entrées 1+2 (défaut), 0 = entrée 1, 1 = entrée 2… */
  public setChannel(channel: number) {
    this.channel = channel;
    this.node?.port.postMessage({ type: 'channel', channel });
  }

  public getChannel() { return this.channel; }

  /** Vrai si ce flux est celui de l'entrée ASIO (à ne pas stopper au désarmement). */
  public owns(stream: MediaStream | null) {
    return !!stream && !!this.dest && stream === this.dest.stream;
  }
}
