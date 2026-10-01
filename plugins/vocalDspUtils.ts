/**
 * Briques DSP partagees par les plugins voix.
 *
 * Tout est fait avec des noeuds Web Audio natifs (pas de setInterval ni
 * d'AnalyserNode lu depuis le thread principal) : le comportement est donc
 * identique en lecture temps reel et dans l'export (OfflineAudioContext).
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

  constructor(ctx: BaseAudioContext, source: AudioNode, target: AudioParam, sensitivity = 9, smoothingHz = 6) {
    this.ctx = ctx;
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

  public setAmount(amount: number) {
    const a = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.depth.gain.setTargetAtTime(a * 0.9, this.ctx.currentTime, 0.03);
  }

  public disconnect() {
    for (const n of [...this.follower.nodes, this.shaper, this.depth]) {
      try { n.disconnect(); } catch (e) {}
    }
  }
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
