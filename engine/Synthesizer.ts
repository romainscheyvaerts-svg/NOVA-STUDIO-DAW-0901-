import { SynthControllers } from './midiControllers';

/** Emplacement de sommation d'une voix (voir Synthesizer.slots). */
interface VoiceSlot { sum: GainNode; busyUntil: number }


/**
 * Simple Polyphonic Synthesizer
 * Uses native Web Audio Oscillators to replace Tone.PolySynth
 */
export class Synthesizer {
  private ctx: AudioContext;
  public output: GainNode;
  
  // FIX: The `activeVoices` map now includes the `filter` node to ensure it can be properly disconnected upon note release, preventing memory leaks.
  private activeVoices: Map<number, { osc: OscillatorNode, env: GainNode, filter: BiquadFilterNode, detach?: () => void, slot: VoiceSlot }> = new Map();
  /**
   * Sommation des voix dans un ordre FIXE. Chrome additionne les entrées d'un noeud dans l'ordre
   * de leurs adresses en mémoire, différent à chaque rendu : dès 3 voix simultanées sur le même
   * noeud, (a + b) + c ≠ (a + c) + b au dernier bit (6e-8 mesurés entre deux exports du même
   * projet). Ici chaque voix entre dans un « emplacement » libre ; emplacement k = voix k + emplacement
   * k + 1 : chaque noeud n'additionne que DEUX signaux non nuls (a + b = b + a, exact), les voix
   * finies valent 0 exact (x + 0 = x). Même son, au bit près, d'un rendu à l'autre et entre
   * lecture et export ; l'attribution ne dépend que des instants programmés (utils/noteTiming).
   */
  private slots: VoiceSlot[] = [];
  /** Contrôleurs MIDI (R16) : pitch bend, modulation, expression. */
  private ctrl: SynthControllers;
  
  private params = {
    attack: 0.01,
    decay: 0.1,
    sustain: 0.5,
    release: 0.2,
    type: 'sawtooth' as OscillatorType,
    filterCutoff: 2000
  };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = 0.5; // Main volume
    this.ctrl = new SynthControllers(ctx, this.output.gain, 0.5);
  }

  /** Emplacement libre à l'instant `t` (toute voix précédente y est à zéro exact), sinon un nouveau en bout de chaîne. */
  private slotAt(t: number): VoiceSlot {
    let slot = this.slots.find(x => x.busyUntil <= t);
    if (!slot) {
      const sum = this.ctx.createGain();
      sum.connect(this.slots.length ? this.slots[this.slots.length - 1].sum : this.output);
      slot = { sum, busyUntil: 0 };
      this.slots.push(slot);
    }
    slot.busyUntil = Infinity; // occupé jusqu'au relâchement (fin connue à ce moment-là)
    return slot;
  }

  public setController(key: string, value: number, time = 0) { this.ctrl.set(key, value, time); }
  public resetControllers(time = 0) { this.ctrl.reset(time); }

  public triggerAttack(pitch: number, velocity: number = 0.8, time: number = 0) {
    // Stop existing voice if any (monophonic per key)
    this.triggerRelease(pitch, time);

    const t = Math.max(time, this.ctx.currentTime);
    const freq = 440 * Math.pow(2, (pitch - 69) / 12);
    
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = this.params.type;
    osc.frequency.setValueAtTime(freq, t);

    // Simple Filter
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(this.params.filterCutoff, t);
    filter.Q.value = 1;

    // Connections
    const slot = this.slotAt(t);
    osc.connect(filter);
    filter.connect(env);
    env.connect(slot.sum);

    // ADSR Envelope
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(velocity, t + this.params.attack);
    env.gain.linearRampToValueAtTime(velocity * this.params.sustain, t + this.params.attack + this.params.decay);

    osc.start(t);

    const detach = this.ctrl.attachVoice([osc.detune], [filter.detune]);
    // Débranchement quand l'oscillateur s'arrête VRAIMENT (temps audio). Avant : setTimeout de
    // 0,4 s en temps réel après le relâchement PROGRAMMÉ. En rendu hors ligne (export) ou pour une
    // note programmée à l'avance, la voix était débranchée avant d'avoir sonné : notes manquantes
    // au hasard selon la vitesse du rendu (clips liés : export ≠ lecture, écart 0,395).
    osc.onended = () => {
      detach();
      try { filter.disconnect(); } catch { /* déjà fait */ }
      try { osc.disconnect(); } catch { /* déjà fait */ }
      try { env.disconnect(); } catch { /* déjà fait */ }
    };
    this.activeVoices.set(pitch, { osc, env, filter, detach, slot });
  }

  /**
   * Fige l'enveloppe a sa valeur COURANTE avant le relachement.
   *
   * Le code lisait env.gain.value, qui renvoie la valeur intrinseque du
   * parametre (1.0 par defaut) et non la valeur automatisee en cours. Au
   * relachement, le gain sautait donc de son niveau de maintien a 1.0 : chaque
   * note se terminait par un clic a pleine echelle, mesure cinq fois plus fort
   * que la note elle-meme.
   *
   * cancelAndHoldAtTime conserve la valeur reellement atteinte par la rampe.
   */
  private figerEnveloppe(gain: AudioParam, t: number) {
    const p = gain as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
    if (typeof p.cancelAndHoldAtTime === 'function') {
      p.cancelAndHoldAtTime(t);
    } else {
      // Repli pour les moteurs sans cancelAndHoldAtTime : on annule seulement
      // les evenements a venir, sans reecrire la valeur courante.
      gain.cancelScheduledValues(t);
    }
  }

  public triggerRelease(pitch: number, time: number = 0) {
    const voice = this.activeVoices.get(pitch);
    if (voice) {
      const t = Math.max(time, this.ctx.currentTime);
      const end = t + this.params.release + 0.1;
      voice.slot.busyUntil = end; // emplacement libre dès que la voix est à zéro (même si la suite échoue)
      // Release envelope
      try {
        this.figerEnveloppe(voice.env.gain, t);
        voice.env.gain.exponentialRampToValueAtTime(0.001, t + this.params.release);
        // Enveloppe à ZÉRO exact quand l'oscillateur s'arrête. Avant : elle restait à 0,001 et
        // le filtre (placé avant elle) sonnait encore quelques ms après l'arrêt ; osc.onended
        // débranche la voix à un moment qui dépend de la vitesse du rendu (temps réel) : cette
        // traîne était coupée au hasard, d'un rendu à l'autre (écarts jusqu'à 1e-4 entre deux
        // exports du même projet). Une voix à zéro se débranche sans rien changer au son.
        voice.env.gain.linearRampToValueAtTime(0, end);
        voice.osc.stop(end);
        // Les noeuds se débranchent à la fin réelle de l'oscillateur (osc.onended, temps audio).

      } catch (e) {
          // Ignore scheduling errors
      }
      this.activeVoices.delete(pitch);
    }
  }

  public releaseAll() {
    const now = this.ctx.currentTime;
    this.activeVoices.forEach((voice) => {
        try {
            this.figerEnveloppe(voice.env.gain, now);
            voice.env.gain.linearRampToValueAtTime(0, now + 0.05);
            voice.osc.stop(now + 0.05); // débranchement par osc.onended
        } catch(e) {}
        voice.slot.busyUntil = now + 0.05;
    });
    this.activeVoices.clear();
  }
}