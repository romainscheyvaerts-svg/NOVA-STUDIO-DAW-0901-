/**
 * Morceau de référence (V15), comme le Reference Track des DAW ou la
 * comparaison du Mastering Assistant de Logic : on importe un titre du
 * commerce et on bascule mix / référence À LOUDNESS ÉGALE (sinon le plus fort
 * paraît toujours meilleur).
 *
 * La référence est écoutée par la sortie master (après le mix, avant les
 * mesures) : les vumètres la montrent ; elle n'est jamais exportée.
 */
import { audioEngine } from '../engine/AudioEngine';
import { lufsOf, truePeakOf } from '../utils/audioMeasure';
import { referenceMatchGainDb } from '../utils/masterAssistant';

export interface ReferenceInfo { name: string; duration: number; lufs: number; truePeak: number }

type Listener = () => void;

class ReferencePlayer {
  private buffer: AudioBuffer | null = null;
  info: ReferenceInfo | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private startedAt = 0;
  private offset = 0;
  /** Loudness du mix à laquelle la référence est alignée. */
  mixLufs: number | null = null;
  match: { gainDb: number; limited: boolean } = { gainDb: 0, limited: false };
  active = false;
  /** Niveau d'écoute du mix hors référence (A/B à niveau égal du Master Nova). */
  private mixLevel = 1;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { this.listeners.forEach(f => { try { f(); } catch { /* écouteur fautif */ } }); }

  async load(file: File): Promise<ReferenceInfo> {
    await audioEngine.init?.();
    const ctx = audioEngine.getAudioContext();
    if (!ctx) throw new Error('Moteur audio indisponible');
    const data = await file.arrayBuffer();
    const buf = await ctx.decodeAudioData(data);
    const ch = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c));
    this.stop();
    this.buffer = buf;
    this.info = { name: file.name.replace(/\.[^.]+$/, ''), duration: buf.duration, lufs: lufsOf(ch, buf.sampleRate), truePeak: truePeakOf(ch, 4, 48) };
    this.offset = 0;
    this.updateMatch();
    this.emit();
    return this.info;
  }

  setMixLufs(l: number | null) { this.mixLufs = l; this.updateMatch(); this.emit(); }

  private updateMatch() {
    if (!this.info || this.mixLufs === null) { this.match = { gainDb: 0, limited: false }; return; }
    this.match = referenceMatchGainDb(this.info.lufs, this.info.truePeak, this.mixLufs);
    if (this.gain && audioEngine.getAudioContext()) this.gain.gain.setTargetAtTime(Math.pow(10, this.match.gainDb / 20), audioEngine.getAudioContext()!.currentTime, 0.02);
  }

  /** Niveau d'écoute du mix quand la référence est coupée. */
  setMixLevel(g: number) { this.mixLevel = g; if (!this.active) audioEngine.setMixMonitorLevel(g); }

  /** Bascule A/B : true = on entend la référence, le mix est coupé. */
  setActive(on: boolean) {
    if (on === this.active) return;
    if (on && !this.buffer) return;
    this.active = on;
    if (on) {
      const ctx = audioEngine.getAudioContext();
      const dest = audioEngine.getMasterMeterInput();
      if (!ctx || !dest || !this.buffer) { this.active = false; return; }
      void audioEngine.resume();
      // Même endroit que le mix si la lecture tourne, sinon reprise là où on s'était arrêté.
      const pos = audioEngine.getIsPlaying() ? audioEngine.getCurrentTime() % this.buffer.duration : this.offset;
      this.gain = ctx.createGain();
      this.gain.gain.value = Math.pow(10, this.match.gainDb / 20);
      this.gain.connect(dest);
      this.source = ctx.createBufferSource();
      this.source.buffer = this.buffer;
      this.source.loop = true;
      this.source.connect(this.gain);
      this.source.start(0, pos);
      this.startedAt = ctx.currentTime - pos;
      audioEngine.setMixMonitorLevel(0);
    } else {
      this.stopSource();
      audioEngine.setMixMonitorLevel(this.mixLevel);
    }
    this.emit();
  }

  private stopSource() {
    const ctx = audioEngine.getAudioContext();
    if (this.source && ctx && this.buffer) this.offset = (ctx.currentTime - this.startedAt) % this.buffer.duration;
    try { this.source?.stop(); } catch { /* déjà arrêtée */ }
    try { this.source?.disconnect(); this.gain?.disconnect(); } catch { /* idem */ }
    this.source = null; this.gain = null;
  }

  stop() {
    if (this.active) { this.active = false; this.stopSource(); audioEngine.setMixMonitorLevel(this.mixLevel); this.emit(); }
    else this.stopSource();
  }

  clear() { this.stop(); this.buffer = null; this.info = null; this.emit(); }

  /** Remet l'écoute normale (fermeture du panneau). */
  resetMonitoring() { this.stop(); this.mixLevel = 1; audioEngine.setMixMonitorLevel(1); }
}

export const referencePlayer = new ReferencePlayer();
