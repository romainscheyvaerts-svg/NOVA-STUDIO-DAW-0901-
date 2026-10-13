/**
 * Écoute avant / après d'un traitement de voix (réverbe retirée R24, voix nettoyée lot 1) :
 * la voix d'origine et la voix traitée jouent ensemble, la bascule ne change que leurs
 * volumes (instantané, au même endroit, sans clic).
 */
export interface AbSource {
  orig: Float32Array[]; wet: Float32Array[]; sampleRate: number;
  /** Gain de l'original à l'écoute (dB) : « Avant » au même volume que « Après » quand le traitement change le niveau. */
  origGainDb?: number;
}

export class AbPlayer {
  private ctx: AudioContext | null = null;
  private srcs: AudioBufferSourceNode[] = [];
  private gO: GainNode | null = null;
  private gW: GainNode | null = null;
  private origLin = 1;
  onEnd: (() => void) | null = null;

  /** `amount` : part de la voix traitée en « Après » (0 → 1). */
  play(d: AbSource, amount: number, after: boolean) {
    this.stop();
    this.origLin = Math.pow(10, (d.origGainDb || 0) / 20);
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return;
    if (!this.ctx || this.ctx.sampleRate !== d.sampleRate) {
      if (this.ctx) void this.ctx.close().catch(() => undefined);
      this.ctx = new Ctor({ sampleRate: d.sampleRate });
    }
    const ctx = this.ctx!;
    const mk = (chs: Float32Array[]) => {
      const b = ctx.createBuffer(chs.length, chs[0].length, d.sampleRate);
      chs.forEach((c, i) => b.copyToChannel(c, i));
      return b;
    };
    this.gO = ctx.createGain();
    this.gW = ctx.createGain();
    this.gO.connect(ctx.destination);
    this.gW.connect(ctx.destination);
    const so = ctx.createBufferSource(); so.buffer = mk(d.orig); so.connect(this.gO);
    const sw = ctx.createBufferSource(); sw.buffer = mk(d.wet); sw.connect(this.gW);
    this.set(amount, after);
    const t = ctx.currentTime + 0.05;
    so.start(t); sw.start(t);
    so.onended = () => { if (this.srcs[0] === so) { this.srcs = []; this.onEnd?.(); } };
    this.srcs = [so, sw];
    void ctx.resume();
  }

  set(amount: number, after: boolean) {
    if (!this.ctx || !this.gO || !this.gW) return;
    const a = after ? Math.max(0, Math.min(1, amount)) : 0;
    const now = this.ctx.currentTime;
    this.gO.gain.setTargetAtTime((1 - a) * this.origLin, now, 0.01);
    this.gW.gain.setTargetAtTime(a, now, 0.01);
  }

  get playing() { return this.srcs.length > 0; }

  stop() {
    this.srcs.forEach(s => { try { s.onended = null; s.stop(); } catch { /* déjà arrêté */ } });
    this.srcs = [];
  }

  close() { this.stop(); if (this.ctx) { void this.ctx.close().catch(() => undefined); this.ctx = null; } }
}
