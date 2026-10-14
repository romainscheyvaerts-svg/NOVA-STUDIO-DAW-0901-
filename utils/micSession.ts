/**
 * Micro de l'accordeur et de l'échauffement (lot 11). Un contexte audio À PART
 * du moteur (le moteur, la carte ASIO et le pont ne sont jamais touchés) :
 * ouvert seulement pendant l'utilisation, fermé à la sortie (le voyant du
 * micro s'éteint, rien ne reste capté).
 *
 * - lecture en direct : `frame()` (dernier morceau du signal) et `pitch()` ;
 * - prise calée à l'échantillon : enregistreur de NOVA (engine/NovaRecorder) ;
 * - clic et notes guides joués sur la même horloge que la capture ;
 * - latence : sortie (baseLatency + outputLatency) + entrée (réglage du
 *   micro) + « décalage de prise » de NOVA (nova_rec_offset_ms), comme une prise.
 */
import { ensureRecorderModule, NovaRecorderSession } from '../engine/NovaRecorder';
import { pitchOfFrame, type FramePitch } from './pitchAnalysis';

export class MicError extends Error {
  constructor(public code: 'refuse' | 'absent' | 'occupe' | 'indisponible', message: string) { super(message); }
}

export async function listInputs(): Promise<{ deviceId: string; label: string }[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Entrée ${i + 1}` }));
  } catch { return []; }
}

export class MicSession {
  readonly ctx: AudioContext;
  readonly stream: MediaStream;
  private src: MediaStreamAudioSourceNode;
  private analyser: AnalyserNode;
  private buf: Float32Array;
  private out: GainNode;
  private rec: NovaRecorderSession | null = null;
  private closed = false;
  readonly deviceLabel: string;

  private constructor(ctx: AudioContext, stream: MediaStream) {
    this.ctx = ctx;
    this.stream = stream;
    this.src = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0;
    this.src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.out = ctx.createGain();
    this.out.gain.value = 0.8;
    this.out.connect(ctx.destination);
    this.deviceLabel = stream.getAudioTracks()[0]?.label || '';
  }

  /** Ouvre le micro (traitements du navigateur coupés : la hauteur et les attaques restent intactes). */
  static async open(deviceId?: string | null): Promise<MicSession> {
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError('indisponible', 'Ce navigateur ne donne pas accès au micro (ouvre NOVA en https ou dans l’appli).');
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    let stream: MediaStream;
    try {
      const audio: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(deviceId ? { deviceId: { ideal: deviceId } } : {}) };
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (e: any) {
      try { await ctx.close(); } catch { /* */ }
      const n = e?.name || '';
      if (n === 'NotAllowedError' || n === 'SecurityError') throw new MicError('refuse', 'Micro refusé. Autorise le micro pour NOVA (icône 🔒 ou 🎤 dans la barre d’adresse), puis réessaie.');
      if (n === 'NotFoundError' || n === 'OverconstrainedError') throw new MicError('absent', 'Aucun micro trouvé. Branche un micro ou une carte son, puis réessaie.');
      if (n === 'NotReadableError' || n === 'AbortError') throw new MicError('occupe', 'Le micro est déjà pris par une autre appli. Ferme-la, puis réessaie.');
      throw new MicError('indisponible', 'Micro indisponible : ' + (e?.message || n || 'erreur inconnue'));
    }
    try { await ctx.resume(); } catch { /* reprise au prochain geste */ }
    const session = new MicSession(ctx, stream);
    // Démarrage du contexte : les premiers blocs du périphérique arrivent par paquets (mesuré :
    // une prise lancée dans les 30 premières ms pouvait glisser de 512 échantillons). On charge
    // l'enregistreur et on laisse l'horloge se stabiliser avant tout exercice.
    try { await ensureRecorderModule(ctx); } catch { /* chargé au départ de la prise */ }
    const t0 = performance.now();
    while (ctx.state === 'running' && ctx.currentTime < 0.25 && performance.now() - t0 < 600) await new Promise(r => setTimeout(r, 20));
    return session;
  }

  get sampleRate() { return this.ctx.sampleRate; }
  get now() { return this.ctx.currentTime; }
  get isClosed() { return this.closed; }

  /** Les `n` derniers échantillons du micro. */
  frame(n = 4096): Float32Array {
    this.analyser.getFloatTimeDomainData(this.buf as Float32Array<ArrayBuffer>);
    return n >= this.buf.length ? this.buf : this.buf.subarray(this.buf.length - n);
  }

  /** Hauteur en direct. Basse (fmin < 45 Hz) : 8192 échantillons, sinon 4096 (plus réactif). */
  pitch(fmin = 60, fmax = 1100): FramePitch | null {
    const n = fmin < 45 ? 8192 : this.sampleRate > 60000 ? 8192 : 4096;
    return pitchOfFrame(this.frame(n), this.sampleRate, { fmin, fmax, threshold: 0.2, minDb: -58 });
  }

  /** Niveau (dBFS) des 50 dernières ms. */
  level(): number {
    const x = this.frame(Math.round(this.sampleRate * 0.05));
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    const r = Math.sqrt(s / Math.max(1, x.length));
    return r > 1e-9 ? 20 * Math.log10(r) : -120;
  }

  /** Retard (s) entre le moment où un son part et celui où la réponse de l'artiste arrive dans la capture. */
  latency(): number {
    const out = (this.ctx.baseLatency || 0) + ((this.ctx as any).outputLatency || 0);
    let inp = 0.01;
    try { const s = this.stream.getAudioTracks()[0]?.getSettings() as any; if (s && typeof s.latency === 'number' && s.latency > 0) inp = s.latency; } catch { /* */ }
    let off = 0;
    try { const v = parseFloat(localStorage.getItem('nova_rec_offset_ms') || ''); if (Number.isFinite(v)) off = Math.max(-100, Math.min(100, v)) / 1000; } catch { /* */ }
    return Math.max(0, Math.min(0.5, out + inp + off));
  }

  /** Clic de métronome (accent = 1er temps, plus aigu). */
  click(at: number, accent = false, volume = 1) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.5 * volume, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
    o.connect(g); g.connect(this.out);
    o.start(at); o.stop(at + 0.06);
  }

  /** Note guide (son doux : fondamentale + 2 harmoniques). */
  tone(midi: number, at: number, dur: number, volume = 0.35) {
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(volume, at + 0.02);
    g.gain.setValueAtTime(volume, Math.max(at + 0.02, at + dur - 0.05));
    g.gain.linearRampToValueAtTime(0, at + dur);
    g.connect(this.out);
    [1, 2, 3].forEach((h, i) => {
      const o = this.ctx.createOscillator(), a = this.ctx.createGain();
      o.frequency.value = f * h;
      a.gain.value = [1, 0.35, 0.15][i];
      o.connect(a); a.connect(g);
      o.start(at); o.stop(at + dur + 0.01);
    });
  }

  /** Démarre une prise calée (enregistreur de NOVA). */
  async startCapture(): Promise<void> {
    await ensureRecorderModule(this.ctx);
    // keepClock : aucun bloc sauté, les attaques restent à leur place sur l'horloge des clics.
    this.rec = new NovaRecorderSession(this.ctx, this.src, { keepClock: true });
  }

  /** Arrête la prise : échantillons mono et instant (horloge du contexte) du 1er. */
  async stopCapture(): Promise<{ samples: Float32Array; firstTime: number } | null> {
    const r = this.rec;
    this.rec = null;
    if (!r) return null;
    const { samples, firstFrame } = await r.stop(this.src);
    return { samples, firstTime: firstFrame >= 0 ? firstFrame / this.sampleRate : 0 };
  }

  /** Coupe tout : micro rendu (voyant éteint), contexte fermé. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    try { if (this.rec) await this.stopCapture(); } catch { /* */ }
    this.stream.getTracks().forEach(t => { try { t.stop(); } catch { /* */ } });
    try { this.src.disconnect(); this.analyser.disconnect(); this.out.disconnect(); } catch { /* */ }
    try { await this.ctx.close(); } catch { /* */ }
  }
}
