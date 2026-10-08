/**
 * R15 · Mixes casque dans le moteur : un bus stéréo par mix, alimenté par la prise
 * PRÉ-FADER de chaque piste (gain + pan du mix) et par le clic. Le fader et le pan
 * du mix principal n'y touchent pas (Pro Tools : envois pré-fader vers une sortie).
 *
 * La voix EN DIRECT des pistes armées n'y passe pas quand le pont fait le retour
 * direct (sinon elle arriverait deux fois, la 2e en retard) : le pont la mélange
 * lui-même dans chaque paire (utils/cueMix.directMonitorRoutes).
 *
 * Sorties : `outputOf(mixId)` (2 canaux) pour le pont ; `listenOut` = le mix
 * écouté sur la sortie principale (carte à une seule paire, ou navigateur).
 */
import type { CueMix, Track } from '../types';
import { cueLevelOf } from '../utils/cueMix';

interface Send { tap: AudioNode | null; gain: GainNode; pan: StereoPannerNode }
interface Bus { mix: CueMix; sum: GainNode; master: GainNode; click: GainNode; sends: Map<string, Send> }

export class CueMixEngine {
  private buses = new Map<string, Bus>();
  private listenId: string | null = null;
  /** Mix écouté sur la sortie principale (à la place du master). */
  public readonly listenOut: GainNode;
  /** Entrée du clic (le métronome s'y branche) : réparti dans chaque mix à son niveau. */
  public readonly clickIn: GainNode;

  constructor(private ctx: AudioContext) {
    this.listenOut = ctx.createGain();
    this.listenOut.channelCount = 2;
    this.listenOut.channelCountMode = 'explicit';
    this.clickIn = ctx.createGain();
  }

  ids() { return [...this.buses.keys()]; }
  outputOf(mixId: string): AudioNode | null { return this.buses.get(mixId)?.master || null; }
  getListen() { return this.listenId; }

  /**
   * Mixes et pistes à jour. `tapOf(trackId)` : prise pré-fader de la piste (null si la
   * piste n'a pas de son dans le moteur : bus, master, piste inactive).
   */
  sync(mixes: CueMix[], tracks: Track[], tapOf: (trackId: string) => AudioNode | null) {
    const t = this.ctx.currentTime;
    const want = new Set(mixes.map(m => m.id));
    for (const id of [...this.buses.keys()]) if (!want.has(id)) this.removeBus(id);
    for (const mix of mixes) {
      let b = this.buses.get(mix.id);
      if (!b) b = this.addBus(mix);
      b.mix = mix;
      b.master.gain.setTargetAtTime(mix.muted ? 0 : (mix.master ?? 1), t, 0.01);
      b.click.gain.setTargetAtTime(mix.click || 0, t, 0.01);
      const keep = new Set<string>();
      for (const tr of tracks) {
        const tap = tapOf(tr.id);
        if (!tap) continue;
        keep.add(tr.id);
        let s = b.sends.get(tr.id);
        if (!s) {
          s = { tap: null, gain: this.ctx.createGain(), pan: this.ctx.createStereoPanner() };
          s.gain.connect(s.pan);
          s.pan.connect(b.sum);
          b.sends.set(tr.id, s);
        }
        if (s.tap !== tap) {
          if (s.tap) { try { s.tap.disconnect(s.gain); } catch { /* */ } }
          s.tap = tap;
        }
        // Idempotent : un recâblage de la piste a pu couper la prise (disconnect global).
        try { tap.disconnect(s.gain); } catch { /* pas branché */ }
        tap.connect(s.gain);
        const l = cueLevelOf(mix, tr);
        s.gain.gain.setTargetAtTime(l.muted ? 0 : l.level, t, 0.01);
        s.pan.pan.setTargetAtTime(l.pan, t, 0.01);
      }
      for (const [id, s] of [...b.sends]) if (!keep.has(id)) { this.dropSend(s); b.sends.delete(id); }
    }
    this.applyListen();
  }

  /** Recâble la prise pré-fader d'une piste après une reconstruction de son graphe. */
  reconnectTrack(trackId: string, tap: AudioNode | null) {
    this.buses.forEach(b => {
      const s = b.sends.get(trackId);
      if (!s || !tap) return;
      if (s.tap && s.tap !== tap) { try { s.tap.disconnect(s.gain); } catch { /* */ } }
      s.tap = tap;
      try { tap.disconnect(s.gain); } catch { /* */ }
      tap.connect(s.gain);
    });
  }

  /** Écouter un mix casque sur la sortie principale (null = le master, comme d'habitude). */
  setListen(mixId: string | null) {
    this.listenId = mixId && this.buses.has(mixId) ? mixId : null;
    this.applyListen();
  }

  private applyListen() {
    if (this.listenId && !this.buses.has(this.listenId)) this.listenId = null;
    this.buses.forEach((b, id) => {
      try { b.master.disconnect(this.listenOut); } catch { /* */ }
      if (id === this.listenId) b.master.connect(this.listenOut);
    });
  }

  private addBus(mix: CueMix): Bus {
    const sum = this.ctx.createGain();
    sum.channelCount = 2; sum.channelCountMode = 'explicit';
    const master = this.ctx.createGain();
    const click = this.ctx.createGain();
    click.gain.value = mix.click || 0;
    sum.connect(master);
    click.connect(sum);
    this.clickIn.connect(click);
    const b: Bus = { mix, sum, master, click, sends: new Map() };
    this.buses.set(mix.id, b);
    return b;
  }

  private dropSend(s: Send) {
    if (s.tap) { try { s.tap.disconnect(s.gain); } catch { /* */ } }
    try { s.gain.disconnect(); s.pan.disconnect(); } catch { /* */ }
  }

  private removeBus(id: string) {
    const b = this.buses.get(id);
    if (!b) return;
    b.sends.forEach(s => this.dropSend(s));
    try { this.clickIn.disconnect(b.click); } catch { /* */ }
    [b.sum, b.master, b.click].forEach(n => { try { n.disconnect(); } catch { /* */ } });
    this.buses.delete(id);
    if (this.listenId === id) this.listenId = null;
  }

  dispose() { for (const id of [...this.buses.keys()]) this.removeBus(id); }
}
