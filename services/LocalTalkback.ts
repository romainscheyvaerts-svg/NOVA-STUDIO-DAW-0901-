/**
 * Talkback LOCAL (au studio, même PC, hors collaboration) : la voix du micro talkback
 * choisi (Réglages audio › Talkback, ex. le micro de l'ordinateur) part dans les mixes
 * casque (engine/CueMixEngine) ou la sortie d'écoute — jamais dans le master, l'export
 * ni les prises (engine/AudioEngine.setTalkback).
 *
 * Léger : le micro n'est demandé qu'au PREMIER appui (autorisation du navigateur à ce
 * moment-là) ; talkback coupé, la piste du micro est coupée (enabled = false) et débranchée
 * du moteur, puis le micro est RENDU au bout de 20 s sans appui (plus d'icône « micro
 * utilisé », plus rien qui tourne). Garder le micro ces 20 s évite de perdre le premier
 * mot quand l'ingé parle plusieurs fois de suite.
 */
import { audioEngine } from '../engine/AudioEngine';

export const TALKBACK_RELEASE_MS = 20000;

export type TalkbackOpenResult = { ok: true } | { ok: false; error: unknown };

class LocalTalkbackService {
  private stream: MediaStream | null = null;
  private deviceId: string | null = null;
  private ctx: AudioContext | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private hp: BiquadFilterNode | null = null;
  private pending: Promise<MediaStream> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private live = false;

  constructor() {
    // Moteur recréé (changement de fréquence du projet) : on se rebranchera au prochain appui.
    try { window.addEventListener('nova:talkback-reset', () => this.unplug()); } catch { /* hors navigateur */ }
  }

  /** Le micro du talkback est ouvert et sa voix part dans le moteur. */
  isLive() { return this.live; }
  /** Un micro est tenu (même coupé, pendant le délai avant de le rendre). */
  holdsMic() { return !!this.stream; }

  /**
   * Ouvre le talkback : micro (demandé au premier appui), branché sur l'entrée talkback
   * du moteur. `deviceId` '' = micro par défaut.
   */
  async open(deviceId: string): Promise<TalkbackOpenResult> {
    this.cancelRelease();
    try {
      if (this.stream && this.deviceId !== deviceId) this.stop();
      if (!this.stream || !this.stream.getAudioTracks().some(t => t.readyState === 'live')) {
        this.stop();
        this.pending = this.pending || navigator.mediaDevices.getUserMedia({
          // Voix parlée : annulation d'écho et réduction de bruit du navigateur (le micro de la régie entend les enceintes).
          audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        try { this.stream = await this.pending; } finally { this.pending = null; }
        this.deviceId = deviceId;
      }
      const ctx = audioEngine.getAudioContext();
      const input = audioEngine.getTalkbackInput();
      if (!ctx || !input) throw Object.assign(new Error('moteur audio pas prêt'), { name: 'EngineNotReady' });
      if (this.ctx !== ctx || !this.src) {
        this.unplug();
        this.ctx = ctx;
        this.src = ctx.createMediaStreamSource(this.stream);
        // Coupe-bas 100 Hz : pas de souffle ni de coups sur la table dans le casque de l'artiste.
        this.hp = ctx.createBiquadFilter();
        this.hp.type = 'highpass';
        this.hp.frequency.value = 100;
        this.src.connect(this.hp);
      }
      this.stream.getAudioTracks().forEach(t => { t.enabled = true; });
      try { this.hp!.disconnect(); } catch { /* */ }
      this.hp!.connect(input);
      this.live = true;
      return { ok: true };
    } catch (error) {
      this.live = false;
      if ((error as { name?: string })?.name !== 'EngineNotReady') this.stop();
      return { ok: false, error };
    }
  }

  /** Coupe : piste du micro coupée, débranchée du moteur ; micro rendu au bout de TALKBACK_RELEASE_MS. */
  close() {
    this.live = false;
    this.stream?.getAudioTracks().forEach(t => { t.enabled = false; });
    try { this.hp?.disconnect(); } catch { /* */ }
    if (this.stream) {
      this.cancelRelease();
      this.releaseTimer = setTimeout(() => { this.releaseTimer = null; if (!this.live) this.stop(); }, TALKBACK_RELEASE_MS);
    }
  }

  /** Rend le micro tout de suite (fin de séance, micro changé dans les réglages). */
  stop() {
    this.cancelRelease();
    this.live = false;
    this.unplug();
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.deviceId = null;
  }

  private unplug() {
    try { this.hp?.disconnect(); } catch { /* */ }
    try { this.src?.disconnect(); } catch { /* */ }
    this.src = null; this.hp = null; this.ctx = null;
  }

  private cancelRelease() {
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
  }
}

export const localTalkback = new LocalTalkbackService();
