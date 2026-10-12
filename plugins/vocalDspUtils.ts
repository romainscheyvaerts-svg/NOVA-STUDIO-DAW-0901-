/**
 * Briques DSP partagees par les plugins voix.
 *
 * Tout est fait avec des noeuds Web Audio natifs ou des AudioWorklet (pas de
 * setInterval ni d'AnalyserNode lu depuis le thread principal) : le
 * comportement est donc identique en lecture temps reel et dans l'export
 * (OfflineAudioContext).
 */

/** Courbe de WaveShaper echantillonnee sur [-1, 1]. */
export function makeCurve(n: number, fn: (x: number) => number): Float32Array {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = fn((i * 2) / (n - 1) - 1);
  return curve;
}

/**
 * Suiveur d'enveloppe : redressement |x| puis passe-bas 2e ordre amorti
 * (Q = -6 dB, soit 0,5 lineaire : pas de depassement).
 * La sortie est un signal lent (~0..1) qui peut piloter un AudioParam.
 */
export function createEnvelopeFollower(ctx: BaseAudioContext, smoothingHz: number) {
  const rectifier = ctx.createWaveShaper();
  rectifier.curve = makeCurve(2049, x => Math.abs(x));
  const smooth = ctx.createBiquadFilter();
  smooth.type = 'lowpass';
  smooth.frequency.value = smoothingHz;
  smooth.Q.value = -6;
  rectifier.connect(smooth);
  return { input: rectifier as AudioNode, output: smooth as AudioNode, nodes: [rectifier, smooth] as AudioNode[] };
}

/**
 * Ducking « a la radio » : baisse un gain quand la voix seche est presente,
 * le remonte entre les phrases. Le gain cible doit avoir une valeur de base
 * de 1 ; le ducker y ajoute une modulation negative bornee :
 *   gain = 1 - amount * 0.9 * (1 - exp(-k * enveloppe))
 */
export class EnvelopeDucker {
  private follower: ReturnType<typeof createEnvelopeFollower>;
  private shaper: WaveShaperNode;
  private depth: GainNode;
  private ctx: BaseAudioContext;
  private source: AudioNode;
  private listening = true;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: BaseAudioContext, source: AudioNode, target: AudioParam, sensitivity = 9, smoothingHz = 6) {
    this.ctx = ctx;
    this.source = source;
    this.follower = createEnvelopeFollower(ctx, smoothingHz);
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = makeCurve(4097, x => (x <= 0 ? 0 : -(1 - Math.exp(-sensitivity * x))));
    this.depth = ctx.createGain();
    this.depth.gain.value = 0;
    source.connect(this.follower.input);
    this.follower.output.connect(this.shaper);
    this.shaper.connect(this.depth);
    this.depth.connect(target);
  }

  /**
   * @param immediate rien n'a encore sonné (création, avant un rendu hors ligne) :
   * à 0, le suiveur d'enveloppe est débranché tout de suite (il ne calcule plus
   * rien ; sa contribution, multipliée par 0, était exactement nulle). En
   * direct, il l'est une fois le retour à 0 terminé.
   */
  public setAmount(amount: number, immediate = false) {
    const a = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (a > 0 && !this.listening) { this.source.connect(this.follower.input); this.listening = true; }
    this.depth.gain.setTargetAtTime(a * 0.9, this.ctx.currentTime, 0.03);
    if (a > 0 || !this.listening) return;
    const offline = typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext;
    if (immediate) this.stopListening();
    else if (!offline) this.idleTimer = setTimeout(() => { this.idleTimer = null; this.stopListening(); }, 400);
  }

  private stopListening() {
    try { this.source.disconnect(this.follower.input); } catch (e) { /* déjà débranché */ }
    this.listening = false;
  }

  public disconnect() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    for (const n of [...this.follower.nodes, this.shaper, this.depth]) {
      try { n.disconnect(); } catch (e) {}
    }
  }
}

/**
 * Charge un module AudioWorklet (code source en chaine) une seule fois par
 * contexte, temps reel ou hors ligne. L'URL d'objet est liberee des que le
 * module est charge ; en cas d'echec, la promesse est oubliee pour permettre
 * un nouvel essai.
 */
const workletLoads = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();
export function loadWorkletModule(ctx: BaseAudioContext, key: string, code: string): Promise<void> {
  let perCtx = workletLoads.get(ctx);
  if (!perCtx) { perCtx = new Map(); workletLoads.set(ctx, perCtx); }
  let p = perCtx.get(key);
  if (!p) {
    if (!ctx.audioWorklet) return Promise.reject(new Error('AudioWorklet indisponible'));
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    perCtx.set(key, p);
    const m = perCtx;
    p.catch(() => m.delete(key));
  }
  return p;
}

/** Vrai pour un contexte de rendu hors ligne (export). */
export function isOfflineContext(ctx: BaseAudioContext): boolean {
  return typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
}

/**
 * Fondu d'apparition d'un effet (anti-clic quand on l'insère pendant la lecture).
 * À l'export (contexte hors ligne), AUCUN fondu : le rendu commence à l'instant 0 avec
 * le son, et un fondu de 20 ms y aurait étouffé le début d'un export lancé au milieu
 * d'un clip (mesuré : −12 dB sur les premiers échantillons, compresseur NOVA).
 */
export function fadeInOnInsert(gain: AudioParam, ctx: BaseAudioContext, seconds = 0.02) {
  if (isOfflineContext(ctx)) { gain.value = 1; return; }
  const t = ctx.currentTime;
  gain.cancelScheduledValues(t);
  gain.setValueAtTime(0, t);
  gain.linearRampToValueAtTime(1, t + seconds);
}

/**
 * Oscillateur de modulation (LFO) calé sur la ligne de temps du morceau.
 *
 * Avant, chaque LFO (reverb, chorus, flanger, doubleur, délai) tournait librement depuis
 * la création de l'effet : sa phase au départ de la lecture dépendait de l'heure, et
 * l'export (nouvel oscillateur à 0) ne retombait jamais dessus (reverb modulée : −41 dB
 * d'écart). Maintenant la phase est une fonction de la POSITION DANS LE MORCEAU :
 *   phase(t) = fréquence × (t − origine) + décalage
 * (origine = instant du contexte où le morceau commence). Identique en lecture, quel que
 * soit le point de départ, et à l'export.
 */
export class TimelineLfo {
  public osc: OscillatorNode;
  private origin: number | null = null;
  private stopped = false;
  constructor(private ctx: BaseAudioContext, public readonly dest: AudioNode | AudioParam, private freq: number,
              private phaseOffset = 0, private shape: 'sine' | 'triangle' = 'sine') {
    this.osc = this.make(this.ctx.currentTime, null);
  }

  /** Forme d'onde avec la phase de départ (en cycles), sans normalisation (amplitude 1 exacte). */
  private wave(cycles: number): PeriodicWave {
    const N = this.shape === 'triangle' ? 32 : 1;
    const re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    const ph = 2 * Math.PI * cycles;
    for (let k = 1; k <= N; k++) {
      // sinus : a = 1 ; triangle : 8/π² · (−1)^((k−1)/2) / k² sur les harmoniques impaires
      const a = this.shape === 'triangle' ? (k % 2 ? (8 / (Math.PI * Math.PI)) * (((k - 1) / 2) % 2 ? -1 : 1) / (k * k) : 0) : 1;
      // a · sin(k(ωt + φ)) = a·sin(kφ)·cos(kωt) + a·cos(kφ)·sin(kωt)
      re[k] = a * Math.sin(k * ph);
      im[k] = a * Math.cos(k * ph);
    }
    return this.ctx.createPeriodicWave(re, im, { disableNormalization: true });
  }

  private make(start: number, cycles: number | null): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (cycles === null) o.type = this.shape;
    else o.setPeriodicWave(this.wave(cycles));
    o.frequency.value = this.freq;
    o.connect(this.dest as any);
    o.start(start);
    return o;
  }

  /** Fréquence (Hz) ; la phase reste calée sur le morceau (reprise immédiate si la lecture est calée). */
  public setFrequency(f: number) {
    if (!Number.isFinite(f) || f === this.freq) return;
    this.freq = f;
    if (this.origin !== null && !isOfflineContext(this.ctx)) this.sync(this.origin);
    else { this.osc.frequency.cancelScheduledValues(0); this.osc.frequency.value = f; }
  }

  public setShape(shape: 'sine' | 'triangle') {
    if (shape === this.shape) return;
    this.shape = shape;
    if (this.origin !== null) this.sync(this.origin);
    else this.osc.type = shape;
  }

  /**
   * Cale la phase : `origin` = instant du contexte où le morceau commence ; `at` = quand
   * basculer (départ de la lecture, bouclage). À l'export : à l'instant 0 du rendu.
   */
  public sync(origin: number, at?: number) {
    if (this.stopped || !Number.isFinite(origin)) return;
    this.origin = origin;
    const offline = isOfflineContext(this.ctx);
    const start = Math.max(at ?? 0, offline ? this.ctx.currentTime : this.ctx.currentTime + 0.003);
    const cycles = this.freq * (start - origin) + this.phaseOffset;
    const old = this.osc;
    try { old.stop(start); } catch { /* déjà arrêté */ }
    old.onended = () => { try { old.disconnect(); } catch { /* */ } };
    this.osc = this.make(start, cycles - Math.floor(cycles));
  }

  public stop() {
    this.stopped = true;
    try { this.osc.stop(); } catch { /* */ }
    try { this.osc.disconnect(); } catch { /* */ }
  }
}

/**
 * Réglage lissé (setTargetAtTime) en direct ; posé tel quel à l'export (contexte hors ligne) :
 * sinon le rendu partait des valeurs par défaut et glissait vers les réglages pendant ses
 * premières dizaines de ms (export lancé au milieu d'un clip ≠ lecture).
 */
export function smoothSet(param: AudioParam, value: number, ctx: BaseAudioContext, tau = 0.02) {
  if (!Number.isFinite(value)) return;
  const now = ctx.currentTime;
  if (isOfflineContext(ctx)) { param.cancelScheduledValues(now); param.setValueAtTime(value, now); }
  else param.setTargetAtTime(value, now, tau);
}

/** Constante de temps pour setTargetAtTime : evite les clics sur les reglages. */
export const SMOOTH = 0.02;

/**
 * Regle un AudioParam : valeur immediate tant que le contexte n'a pas avance
 * depuis la creation du plugin (premier reglage => aucun fondu parasite au
 * debut d'un export ou juste apres l'insertion), lissee ensuite (pas de clic).
 */
export function setParamSmooth(param: AudioParam, value: number, ctx: BaseAudioContext, createdAt: number, tau = SMOOTH) {
  if (!Number.isFinite(value)) return;
  const now = ctx.currentTime;
  if (now <= createdAt) {
    param.cancelScheduledValues(now);
    param.setValueAtTime(value, now);
  } else {
    param.setTargetAtTime(value, now, tau);
  }
}
