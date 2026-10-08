/**
 * Entrée de la carte son reçue par le pont ASIO → signaux audio utilisables comme
 * un micro (retour casque, vumètre, enregistreur).
 *
 * Le pont envoie des blocs d'échantillons entrelacés à SA fréquence
 * d'échantillonnage. Un AudioWorklet les met dans un tampon circulaire, les
 * convertit à la fréquence du DAW (interpolation linéaire) et les ressort.
 *
 * R15 · Multicanal : le nœud a DEUX sorties :
 *  - sortie 0 (historique) : une voix en mono sur 2 canaux — l'entrée choisie dans les
 *    Réglages audio, ou entrées 1+2 additionnées (« mix ») ;
 *  - sortie 1 : TOUTES les entrées de la carte, une par canal (N canaux discrets) ;
 *    chaque piste armée y prend la sienne (engine/InputRouter).
 * Tous les canaux d'un bloc sont rééchantillonnés ensemble : ils restent alignés à
 * l'échantillon. Les blocs v2 portent leur n° d'échantillon : un bloc perdu est
 * remplacé par autant de silence (les prises ne glissent pas), un doublon est retiré.
 *
 * Calage verrouillé : si les blocs arrivent en retard (navigateur occupé), le lecteur
 * joue du silence ET le note (« retard ») ; à l'arrivée des blocs en retard, il saute
 * exactement autant d'échantillons. La correspondance entrée de la carte → horloge du
 * DAW reste la même : une prise ne glisse pas sur la grille après un à-coup (avant, chaque
 * à-coup la décalait de la durée du trou, mesuré : +10,6 ms sous charge).
 */
import { blockJoin } from '../utils/asioProtocol';

const WORKLET = `
const blockJoin = (${blockJoin.toString()});
class AsioInputPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.n = Math.max(1, Math.min(32, o.channels || 2));
    this.size = sampleRate * 2;            // 2 s de tampon
    this.bufs = [];
    for (let c = 0; c < this.n; c++) this.bufs.push(new Float32Array(this.size));
    this.w = 0;                             // index d'écriture (échantillons rééchantillonnés)
    this.r = 0;                             // index de lecture
    this.fill = 0;
    this.started = false;
    this.prebuffer = Math.round(sampleRate * 0.03);   // 30 ms de marge contre la gigue réseau
    this.maxFill = Math.round(sampleRate * 0.25);     // au-delà : on rattrape (latence bornée)
    this.lag = 0;                           // silence joué faute de données (à rattraper)
    this.maxLag = sampleRate;               // au-delà d'1 s sans données : on repart de zéro
    this.caught = 0; this.underruns = 0;
    this.channel = -1;                      // sortie 0 : -1 = mix des entrées 1+2
    this.srcPos = 0;                        // position fractionnaire dans le flux source
    this.last = new Float32Array(this.n);
    this.next = null;                       // n° du prochain échantillon attendu (v2)
    this.gaps = 0; this.gapFrames = 0; this.dups = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'channel') { this.channel = m.channel; return; }
      if (m.type !== 'audio') return;
      const ch = Math.max(1, m.channels);
      let data = m.data, frames = Math.floor(data.length / ch);
      const ratio = (m.rate || sampleRate) / sampleRate;   // pas source par échantillon de sortie
      // Raccord horodaté : bloc perdu → silence ; recouvrement → début retiré.
      let pad = 0, skip = 0;
      if (typeof m.frameIndex === 'number') {
        const j = blockJoin(this.next, m.frameIndex, frames, Math.round((m.rate || sampleRate) * 0.5));
        pad = j.pad; skip = j.skip;
        if (pad) { this.gaps++; this.gapFrames += pad; }
        if (skip) this.dups++;
        this.next = m.frameIndex + frames;
      }
      const n = pad + frames - skip;
      if (n <= 0) return;
      // Rééchantillonnage linéaire vers sampleRate, continu d'un bloc à l'autre
      // (le dernier échantillon du bloc précédent sert de point de départ).
      const src = (c, i) => {
        if (i === 0) return this.last[c];
        const k = i - 1 - pad;              // index dans le bloc reçu (après le silence)
        if (k < 0) return 0;
        const kk = k + skip;
        return c < ch && kk < frames ? data[kk * ch + c] : 0;
      };
      let pos = this.srcPos;
      while (pos < n) {
        const i = Math.floor(pos), f = pos - i;
        for (let c = 0; c < this.n; c++) {
          const a = src(c, i), b = src(c, i + 1);
          this.bufs[c][this.w] = a + (b - a) * f;
        }
        this.w = (this.w + 1) % this.size;
        if (this.fill < this.size) this.fill++;
        else this.r = (this.r + 1) % this.size;
        pos += ratio;
      }
      this.srcPos = pos - n;
      for (let c = 0; c < this.n; c++) this.last[c] = src(c, n);
      // Trop d'avance (onglet en arrière-plan, rafale réseau) : on saute pour garder une latence
      // faible. Ce qui est sauté rembourse d'abord le retard (le calage ne bouge pas) ; seul le
      // reste décale (dérive d'horloge entre la carte et le navigateur).
      if (this.fill > this.maxFill) {
        const drop = this.fill - this.prebuffer;
        this.r = (this.r + drop) % this.size;
        this.fill -= drop;
        const repaid = Math.min(this.lag, drop);
        this.lag -= repaid; this.caught += repaid;
      }
    };
  }
  process(inputs, outputs) {
    const legacy = outputs[0], multi = outputs[1];
    const len = legacy[0].length;
    // Remplissage du tampon (≈ latence ajoutée) envoyé ~5 fois par seconde
    this.tick = (this.tick || 0) + 1;
    if (this.tick % 70 === 0) this.port.postMessage({ type: 'fill', fill: this.fill, gaps: this.gaps, gapFrames: this.gapFrames, dups: this.dups, caught: this.caught, underruns: this.underruns, lag: this.lag });
    if (!this.started) {
      if (this.fill >= this.prebuffer) { this.started = true; this.lag = 0; }
      else { for (const c of legacy) c.fill(0); if (multi) for (const c of multi) c.fill(0); return true; }
    }
    // Blocs arrivés en retard : on saute ce qui aurait dû être joué pendant le silence.
    if (this.lag > 0 && this.fill > len) {
      const k = Math.min(this.lag, this.fill - len);
      this.r = (this.r + k) % this.size;
      this.fill -= k; this.lag -= k; this.caught += k;
    }
    const sel = this.channel;
    for (let i = 0; i < len; i++) {
      let v = 0;
      if (this.fill > 0) {
        const r = this.r;
        if (sel >= 0 && sel < this.n) v = this.bufs[sel][r];
        else { v = this.bufs[0][r]; if (this.n > 1) v += this.bufs[1][r]; }
        if (multi) for (let c = 0; c < multi.length; c++) multi[c][i] = c < this.n ? this.bufs[c][r] : 0;
        this.r = (r + 1) % this.size; this.fill--;
      } else {
        // Tampon vide : silence, compté comme retard (rattrapé à l'arrivée des données).
        this.lag++; this.underruns++;
        if (this.lag > this.maxLag) { this.started = false; this.lag = 0; }
        if (multi) for (let c = 0; c < multi.length; c++) multi[c][i] = 0;
      }
      for (const c of legacy) c[i] = v;
    }
    return true;
  }
}
registerProcessor('asio-input-player-mc', AsioInputPlayer);
`;

const modules = new WeakMap<BaseAudioContext, Promise<void>>();

export class ASIOInput {
  private ctx: AudioContext;
  private node: AudioWorkletNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private ready: Promise<void> | null = null;
  /** Fréquence d'échantillonnage du pont (mise à jour par la config / les stats). */
  public sourceRate: number;
  private channel = -1;
  /** Retard actuellement retenu dans le tampon d'entrée (s). */
  public fillSec = 0.03;
  /** Entrées de la carte transportées (sortie 1 du nœud). */
  public readonly channels: number;
  /** Blocs perdus remplacés par du silence, doublons retirés (diagnostic). */
  public gaps = 0;
  public gapFrames = 0;
  public dups = 0;
  /** Échantillons joués en silence faute de données, puis rattrapés (calage gardé). */
  public underruns = 0;
  public caught = 0;

  /** Nœud du lecteur : sortie 0 = voix mono (historique), sortie 1 = toutes les entrées. */
  public getNode(): AudioNode | null { return this.node; }

  constructor(ctx: AudioContext, sourceRate = 44100, channels = 2) {
    this.ctx = ctx;
    this.sourceRate = sourceRate;
    this.channels = Math.max(1, Math.min(32, Math.floor(channels) || 2));
  }

  private init(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      let p = modules.get(this.ctx);
      if (!p) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        p = this.ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
        modules.set(this.ctx, p);
        p.catch(() => modules.delete(this.ctx));
      }
      await p;
      this.node = new AudioWorkletNode(this.ctx, 'asio-input-player-mc', {
        numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [2, this.channels],
        processorOptions: { channels: this.channels },
      });
      this.node.port.postMessage({ type: 'channel', channel: this.channel });
      this.node.port.onmessage = (e) => {
        const d = e.data;
        if (d?.type !== 'fill') return;
        this.fillSec = d.fill / this.ctx.sampleRate;
        this.gaps = d.gaps || 0; this.gapFrames = d.gapFrames || 0; this.dups = d.dups || 0;
        this.underruns = d.underruns || 0; this.caught = d.caught || 0;
      };
      this.dest = this.ctx.createMediaStreamDestination();
      this.dest.channelCount = 2;
      this.node.connect(this.dest, 0);
    })();
    return this.ready;
  }

  /** Prêt (module chargé, nœud créé). */
  public async whenReady(): Promise<AudioWorkletNode> { await this.init(); return this.node!; }

  /** Flux à utiliser à la place de getUserMedia. Ses pistes ne doivent jamais être stoppées. */
  public async getStream(): Promise<MediaStream> {
    await this.init();
    return this.dest!.stream;
  }

  /** Bloc reçu du pont (échantillons entrelacés ; `frameIndex` en v2). */
  public push(data: Float32Array, channels: number, frameIndex?: number, rate?: number) {
    if (!this.node) return;
    // Copie : le tampon d'origine est une vue sur le message WebSocket.
    const copy = new Float32Array(data);
    this.node.port.postMessage({ type: 'audio', data: copy, channels, rate: rate || this.sourceRate, frameIndex }, [copy.buffer]);
  }

  /** -1 = mix des entrées 1+2 (défaut), 0 = entrée 1, 1 = entrée 2… (sortie 0). */
  public setChannel(channel: number) {
    this.channel = channel;
    this.node?.port.postMessage({ type: 'channel', channel });
  }

  public getChannel() { return this.channel; }

  /** Vrai si ce flux est celui de l'entrée ASIO (à ne pas stopper au désarmement). */
  public owns(stream: MediaStream | null) {
    return !!stream && !!this.dest && stream === this.dest.stream;
  }

  public dispose() {
    try { this.node?.disconnect(); } catch { /* */ }
    try { this.node?.port.close(); } catch { /* */ }
    this.node = null;
    this.ready = null;
  }
}
