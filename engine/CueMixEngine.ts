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
 *
 * Talkback local (utils/talkback) : chaque mix = musique → `dim` (baissée pendant que
 * l'ingé parle) → `out`, où la voix du talkback (`talkIn`) s'ajoute. Elle n'est donc
 * que dans les sorties casque : ni dans le master, ni dans l'export, ni dans l'écoute
 * d'un mix sur la sortie principale (prise AVANT la voix : pas de larsen dans la régie).
 */
import type { CueMix, Track } from '../types';
import { cueLevelOf, cuePanPositions } from '../utils/cueMix';
import { NovaPanner } from './panNode';
import { DEFAULT_PAN_LAW, isStereoTrack, type PanLaw } from '../utils/panLaw';

/** Pan de chaque piste dans un mix : même loi que le mix principal (22/10/2026), G / D pour une piste stéréo. */
interface Send { tap: AudioNode | null; gain: GainNode; pan: NovaPanner }
interface Bus { mix: CueMix; sum: GainNode; master: GainNode; dim: GainNode; out: GainNode; click: GainNode; sends: Map<string, Send> }

export class CueMixEngine {
  private buses = new Map<string, Bus>();
  private listenId: string | null = null;
  /** Mix écouté sur la sortie principale (à la place du master). */
  public readonly listenOut: GainNode;
  /** Entrée du clic (le métronome s'y branche) : réparti dans chaque mix à son niveau. */
  public readonly clickIn: GainNode;
  /** Entrée du talkback local : ajoutée à la SORTIE de chaque mix (après le dim). */
  public readonly talkIn: GainNode;
  /** Gain de la musique des mixes (1, ou le dim pendant le talkback). */
  private dimGain = 1;
  /** Loi de pan du projet (utils/panLaw). */
  private panLaw: PanLaw = DEFAULT_PAN_LAW;

  constructor(private ctx: AudioContext) {
    this.listenOut = ctx.createGain();
    this.listenOut.channelCount = 2;
    this.listenOut.channelCountMode = 'explicit';
    this.clickIn = ctx.createGain();
    this.talkIn = ctx.createGain();
  }

  ids() { return [...this.buses.keys()]; }
  outputOf(mixId: string): AudioNode | null { return this.buses.get(mixId)?.out || null; }

  /** Dim du talkback : gain de la musique de tous les mixes (1 = normal). */
  setDim(gain: number) {
    this.dimGain = Math.max(0, Math.min(1, gain));
    const t = this.ctx.currentTime;
    this.buses.forEach(b => b.dim.gain.setTargetAtTime(this.dimGain, t, 0.015));
  }
  getDim() { return this.dimGain; }

  /** Loi de pan du projet : les pans des mixes casque suivent celle du mix principal. */
  setPanLaw(law: PanLaw) {
    if (law === this.panLaw) return;
    this.panLaw = law;
    this.buses.forEach(b => b.sends.forEach(s => s.pan.setFormat(s.pan.mode, law)));
  }
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
          s = { tap: null, gain: this.ctx.createGain(), pan: new NovaPanner(this.ctx, 'mono', this.panLaw, this.ctx.currentTime) };
          s.gain.connect(s.pan.input);
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
        const stereo = isStereoTrack(tr);
        s.pan.setFormat(stereo ? 'stereo' : 'mono', this.panLaw);
        const [pa, pb] = cuePanPositions(mix, tr, stereo);
        s.pan.pan.setTargetAtTime(pa, t, 0.01);
        s.pan.panR.setTargetAtTime(pb, t, 0.01);
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
    // Écoute prise après le dim et AVANT la voix du talkback (sinon l'ingé s'entend dans la régie : larsen).
    this.buses.forEach((b, id) => {
      try { b.dim.disconnect(this.listenOut); } catch { /* */ }
      if (id === this.listenId) b.dim.connect(this.listenOut);
    });
  }

  private addBus(mix: CueMix): Bus {
    const sum = this.ctx.createGain();
    sum.channelCount = 2; sum.channelCountMode = 'explicit';
    const master = this.ctx.createGain();
    const dim = this.ctx.createGain();
    dim.gain.value = this.dimGain;
    const out = this.ctx.createGain();
    out.channelCount = 2; out.channelCountMode = 'explicit';
    const click = this.ctx.createGain();
    click.gain.value = mix.click || 0;
    sum.connect(master);
    master.connect(dim);
    dim.connect(out);
    this.talkIn.connect(out);
    click.connect(sum);
    this.clickIn.connect(click);
    const b: Bus = { mix, sum, master, dim, out, click, sends: new Map() };
    this.buses.set(mix.id, b);
    return b;
  }

  private dropSend(s: Send) {
    if (s.tap) { try { s.tap.disconnect(s.gain); } catch { /* */ } }
    try { s.gain.disconnect(); } catch { /* */ }
    s.pan.dispose();
  }

  private removeBus(id: string) {
    const b = this.buses.get(id);
    if (!b) return;
    b.sends.forEach(s => this.dropSend(s));
    try { this.clickIn.disconnect(b.click); } catch { /* */ }
    try { this.talkIn.disconnect(b.out); } catch { /* */ }
    [b.sum, b.master, b.dim, b.out, b.click].forEach(n => { try { n.disconnect(); } catch { /* */ } });
    this.buses.delete(id);
    if (this.listenId === id) this.listenId = null;
  }

  dispose() { for (const id of [...this.buses.keys()]) this.removeBus(id); }
}
