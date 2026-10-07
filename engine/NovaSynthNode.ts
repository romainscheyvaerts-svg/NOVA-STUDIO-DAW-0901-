/**
 * Synthé NOVA (V24) : 3 oscillateurs avec unisson stéréo, bruit, filtre
 * 12/24 dB (passe-bas, passe-haut, passe-bande) avec enveloppe et LFO,
 * enveloppes ADSR, mono / legato / glissé, chorus et delay intégrés.
 *
 * Construit avec les nœuds natifs du Web Audio (rapides, sans AudioWorklet à
 * charger) : le même code tourne dans l'AudioContext de lecture et dans
 * l'OfflineAudioContext de l'export, d'où un rendu identique. Tout ce qui
 * pourrait dépendre de l'ordre des appels (voix volées, mono, glissé) est
 * décidé d'après l'INSTANT des notes (utils/novaSynth.ts), pas d'après l'ordre
 * dans lequel la lecture ou l'export les programment.
 *
 * Interface identique à l'ancien Synthesizer (output, triggerAttack,
 * triggerRelease, releaseAll) : le moteur l'utilise à sa place sans autre
 * changement.
 */
import {
  NovaSynthSettings, VoiceSlot, normalizeSynth, noteFreq, unisonVoices, oscCents, velocityGain, cutoffFor,
  mixNorm, ampEnvAt, glideSource, voicesToCut, voiceToRelease, nextMonoStart,
  MIN_ATTACK, MIN_RELEASE, STEAL_FADE, RELEASE_TAIL,
} from '../utils/novaSynth';

/** Crête d'une voix au volume 1 (les sons de la banque sont calibrés autour de -18 dB RMS). */
const PEAK = 0.715;

interface Voice extends VoiceSlot {
  vel: number;
  s: NovaSynthSettings;
  amp: GainNode;
  /** Gain de relâchement / coupure, séparé de l'enveloppe : on n'annule jamais la rampe d'attaque. */
  rel: GainNode;
  filters: BiquadFilterNode[];
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  envCents: number;
  peak: number;
  legatoLvl: number | null;
}

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
/** Bruit blanc DÉTERMINISTE (même graine partout) : lecture et export identiques. */
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (b) return b;
  const len = Math.floor(ctx.sampleRate * 2);
  b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  let a = 0x9e3779b9;
  for (let i = 0; i < len; i++) {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    d[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  noiseCache.set(ctx, b);
  return b;
}

/** Fige un paramètre à sa valeur réellement atteinte à `t` (sinon clic au relâchement). */
function hold(p: AudioParam, t: number) {
  const q = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
  if (typeof q.cancelAndHoldAtTime === 'function') q.cancelAndHoldAtTime(t);
  else p.cancelScheduledValues(t);
}

/**
 * Chorus en AudioWorklet : l'ondulation est calculée d'après le TEMPS DU MORCEAU
 * (instant de l'échantillon - origine), donc identique en lecture et à l'export.
 * (Avec des DelayNode modulés par un OscillatorNode, Chrome ne rendait pas la
 * même chose d'une lecture à l'autre : mesuré dans qa/synth_v24_preuve.py.)
 */
const CHORUS_PROCESSOR = `
class NovaSynthChorus extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [
    { name: 'rate', defaultValue: 0.6, minValue: 0, maxValue: 20, automationRate: 'k-rate' },
    { name: 'depth', defaultValue: 0.4, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    { name: 'originHi', defaultValue: 0, minValue: -1e9, maxValue: 1e9, automationRate: 'k-rate' },
    { name: 'originLo', defaultValue: 0, minValue: -2, maxValue: 2, automationRate: 'k-rate' },
  ]; }
  constructor() {
    super();
    let size = 1; while (size < sampleRate * 0.05) size <<= 1;
    this.buf = new Float32Array(size); this.mask = size - 1; this.w = 0;
  }
  read(pos) { const i = Math.floor(pos), f = pos - i, m = this.mask; return this.buf[i & m] * (1 - f) + this.buf[(i + 1) & m] * f; }
  process(inputs, outputs, p) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
    const inp = inputs[0], a = inp && inp[0], b = inp && inp[1];
    const sr = sampleRate, depth = p.depth[0] * 0.0035, oh = p.originHi[0], ol = p.originLo[0];
    const w0 = 2 * Math.PI * p.rate[0], w1 = w0 * 1.13;
    for (let i = 0; i < n; i++) {
      this.buf[this.w & this.mask] = a ? (b ? (a[i] + b[i]) * 0.5 : a[i]) : 0;
      const t = ((currentFrame + i) / sr - oh) - ol;
      L[i] = this.read(this.w - (0.011 + depth * Math.sin(w0 * t)) * sr);
      R[i] = this.read(this.w - (0.017 + depth * Math.sin(w1 * t)) * sr);
      this.w++;
    }
    return true;
  }
}
registerProcessor('nova-synth-chorus', NovaSynthChorus);
`;
const chorusModules = new WeakMap<BaseAudioContext, Promise<void>>();
function loadChorus(ctx: BaseAudioContext): Promise<void> {
  let p = chorusModules.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([CHORUS_PROCESSOR], { type: 'application/javascript' }));
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    chorusModules.set(ctx, p);
  }
  return p;
}

export class NovaSynthNode {
  public readonly output: GainNode;
  private readonly ctx: BaseAudioContext;
  private s: NovaSynthSettings;
  private voices: Voice[] = [];
  private nextId = 1;
  private readonly bus: GainNode;
  private readonly dry: GainNode;
  private readonly chorusWet: GainNode;
  private chorusNode: AudioWorkletNode | null = null;
  private chorusOrigin = 0;
  /** Repli sans AudioWorklet : lignes à retard modulées. */
  private readonly chorusLfoGains: GainNode[] = [];
  private chorusLfos: OscillatorNode[] = [];
  /** Prêt à jouer (chorus chargé) : l'export l'attend avant de rendre. */
  public readonly ready: Promise<void>;
  private readonly delay: DelayNode;
  private readonly delaySend: GainNode;
  private readonly delayFb: GainNode;
  private readonly fxNodes: AudioNode[] = [];

  constructor(ctx: BaseAudioContext, settings?: unknown) {
    this.ctx = ctx;
    this.s = normalizeSynth(settings);
    this.output = ctx.createGain();
    this.bus = ctx.createGain();
    this.dry = ctx.createGain();
    this.bus.connect(this.dry);
    this.dry.connect(this.output);

    // Chorus : deux lignes à retard modulées (gauche / droite), comme un Juno.
    this.chorusWet = ctx.createGain();
    this.chorusWet.connect(this.output);
    this.fxNodes.push(this.chorusWet);
    this.ready = this.buildChorus();

    // Delay avec réinjection filtrée (répétitions plus sombres, comme un delay à bande).
    this.delaySend = ctx.createGain();
    this.delay = ctx.createDelay(2);
    this.delayFb = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4500;
    this.bus.connect(this.delaySend);
    this.delaySend.connect(this.delay);
    this.delay.connect(lp);
    lp.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    lp.connect(this.output);
    this.fxNodes.push(this.delaySend, this.delay, this.delayFb, lp);

    this.applyFx(true);
  }

  public getSettings(): NovaSynthSettings { return this.s; }

  private async buildChorus(): Promise<void> {
    const ctx = this.ctx;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        await loadChorus(ctx);
        const node = new AudioWorkletNode(ctx, 'nova-synth-chorus', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        this.bus.connect(node);
        node.connect(this.chorusWet);
        this.chorusNode = node;
        this.fxNodes.push(node);
        this.applyChorusTimeline();
        this.applyFx(true);
        return;
      } catch { /* repli ci-dessous */ }
    }
    const merger = ctx.createChannelMerger(2);
    [0.011, 0.017].forEach((base, ch) => {
      const d = ctx.createDelay(0.05);
      d.delayTime.value = base;
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.connect(lg);
      lg.connect(d.delayTime);
      this.bus.connect(d);
      d.connect(merger, 0, ch);
      lfo.start(0);
      this.chorusLfos.push(lfo);
      this.chorusLfoGains.push(lg);
      this.fxNodes.push(d, lfo, lg);
    });
    merger.connect(this.chorusWet);
    this.fxNodes.push(merger);
    this.applyFx(true);
  }

  private applyChorusTimeline() {
    const n = this.chorusNode;
    if (!n) return;
    const hi = Math.floor(this.chorusOrigin);
    n.parameters.get('originHi')!.value = hi;
    n.parameters.get('originLo')!.value = this.chorusOrigin - hi;
  }

  /**
   * Cale l'ondulation du chorus sur la ligne de temps du projet : `origin` = instant
   * du contexte qui correspond au début du morceau, `at` = quand repartir. Appelé au
   * départ de la lecture et au début de l'export, pour que les deux ondulent pareil.
   */
  public syncTimeline(origin: number, at: number) {
    this.chorusOrigin = origin;
    this.applyChorusTimeline();
    if (this.chorusNode || !this.chorusLfoGains.length) return;
    const ctx = this.ctx;
    const start = Math.max(at, ctx.currentTime);
    this.chorusLfos.forEach(l => { try { l.stop(start); } catch { /* */ } });
    const rate = this.s.fx.chorus.rate;
    this.chorusLfos = this.chorusLfoGains.map((g, i) => {
      const f = rate * (i ? 1.13 : 1);
      const phase = 2 * Math.PI * ((f * (start - origin)) % 1);
      const lfo = ctx.createOscillator();
      // sin(ωt + φ) = sin φ · cos ωt + cos φ · sin ωt
      lfo.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, Math.sin(phase)]), new Float32Array([0, Math.cos(phase)]), { disableNormalization: true }));
      lfo.frequency.value = f;
      lfo.connect(g);
      lfo.start(start);
      return lfo;
    });
  }

  /** Nouveaux réglages : effets tout de suite, filtre des notes tenues aussi, le reste aux notes suivantes. */
  public setSettings(settings: unknown) {
    this.s = normalizeSynth(settings);
    this.applyFx(false);
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      if (v.end <= now) continue;
      v.filters.forEach((f, i) => {
        f.frequency.setTargetAtTime(cutoffFor(this.s, v.pitch, v.vel), now, 0.02);
        if (i === 0) f.Q.setTargetAtTime(this.s.filter.reso, now, 0.02);
      });
    }
  }

  private applyFx(immediate: boolean) {
    const { chorus, delay } = this.s.fx;
    const now = this.ctx.currentTime;
    const set = (p: AudioParam, v: number) => { if (immediate) p.value = v; else p.setTargetAtTime(v, now, 0.02); };
    set(this.dry.gain, 1 - chorus.mix * 0.4);
    set(this.chorusWet.gain, chorus.mix * 0.8);
    if (this.chorusNode) {
      // Valeurs directes (paramètres k-rate) : mêmes valeurs en lecture et à l'export.
      this.chorusNode.parameters.get('rate')!.value = chorus.rate;
      this.chorusNode.parameters.get('depth')!.value = chorus.depth;
    }
    this.chorusLfos.forEach((l, i) => set(l.frequency, chorus.rate * (i ? 1.13 : 1)));
    this.chorusLfoGains.forEach(g => set(g.gain, chorus.depth * 0.0035));
    set(this.delaySend.gain, delay.mix * 0.7);
    // Temps arrondi à l'échantillon : sinon l'interpolation de la boucle de
    // réinjection décalait les échos d'un échantillon entre lecture et export.
    const sr = this.ctx.sampleRate;
    set(this.delay.delayTime, Math.round(delay.time * sr) / sr);
    set(this.delayFb.gain, delay.feedback);
  }

  public triggerAttack(pitch: number, velocity = 0.8, time = 0) {
    const ctx = this.ctx;
    const t = this.onGrid(Math.max(time, ctx.currentTime));
    const s = this.s;
    this.prune();

    const src = s.glide > 0 ? glideSource(this.voices, t, !s.mono) : null;
    const cut = voicesToCut(this.voices, t, pitch, s.mono);
    // Mono legato : la note précédente est encore tenue → pas de nouvelle attaque.
    const legatoFrom = s.mono && s.legato ? cut.find(v => v.release > t) : undefined;
    cut.forEach(v => this.cutVoice(v, t));

    const vel = Math.min(1, Math.max(0, velocity));
    const peak = s.level * velocityGain(vel, s.velToAmp) * PEAK;
    const norm = mixNorm(s);
    const nodes: AudioNode[] = [];
    const sources: AudioScheduledSourceNode[] = [];

    const mix = ctx.createGain();
    const amp = ctx.createGain();
    amp.gain.value = 0;
    const filters: BiquadFilterNode[] = [];
    const nf = s.filter.steep ? 2 : 1;
    for (let i = 0; i < nf; i++) {
      const f = ctx.createBiquadFilter();
      f.type = s.filter.type;
      f.frequency.value = cutoffFor(s, pitch, vel);
      f.Q.value = i === 0 ? s.filter.reso : (s.filter.type === 'bandpass' ? 0.7 : 0.707);
      filters.push(f);
    }
    let head: AudioNode = mix;
    for (const f of filters) { head.connect(f); head = f; }
    head.connect(amp);
    const rel = ctx.createGain();
    amp.connect(rel);
    let tail: AudioNode = rel;
    nodes.push(mix, amp, rel, ...filters);

    // --- Oscillateurs (+ unisson étalé en stéréo)
    const target = noteFreq(pitch);
    // Glissé : rampe linéaire en cents sur detune (= exponentielle en fréquence).
    // (Mesuré : -38 dB d'écart entre lecture et export sur les notes glissées, dû aux
    // calculs d'automatisation de Chrome ; essais par tampon audio : pire.)
    const glideCents = src ? (src.pitch - pitch) * 100 : 0;
    const glideEnd = this.onGrid(t + Math.max(0.001, s.glide));
    const oscs: OscillatorNode[] = [];
    for (const o of s.osc) {
      if (!o.on || o.level <= 0) continue;
      for (const u of unisonVoices(o.unison, o.detune, o.spread)) {
        const osc = ctx.createOscillator();
        osc.type = o.wave;
        const cents = oscCents(o) + u.cents;
        // Valeurs intrinsèques (pas d'événement sur frequency) : avec setValueAtTime
        // seul, Chrome ne jouait pas la même onde en lecture et à l'export (mesuré).
        osc.frequency.value = target;
        osc.detune.value = cents + glideCents;
        if (glideCents !== 0) {
          osc.detune.setValueAtTime(cents + glideCents, t);
          osc.detune.linearRampToValueAtTime(cents, glideEnd);
        }
        const g = ctx.createGain();
        g.gain.value = o.level * norm;
        osc.connect(g);
        if (u.pan !== 0) {
          const p = ctx.createStereoPanner();
          p.pan.value = u.pan;
          g.connect(p);
          p.connect(mix);
          nodes.push(p);
        } else g.connect(mix);
        osc.start(t);
        oscs.push(osc);
        sources.push(osc);
        nodes.push(osc, g);
      }
    }
    // --- Bruit (même départ pour une même touche : déterministe)
    if (s.noise.level > 0) {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx);
      n.loop = true;
      const g = ctx.createGain();
      g.gain.value = s.noise.level * norm * 0.7;
      n.connect(g);
      g.connect(mix);
      n.start(t, (pitch * 0.0731) % 1.9);
      sources.push(n);
      nodes.push(n, g);
    }

    // --- LFO (relancé à chaque note : même phase en lecture et à l'export)
    if (s.lfo.dest !== 'off' && s.lfo.amount > 0) {
      const lfo = ctx.createOscillator();
      lfo.type = s.lfo.wave;
      lfo.frequency.value = s.lfo.rate;
      const lg = ctx.createGain();
      lfo.connect(lg);
      if (s.lfo.dest === 'filter') {
        lg.gain.value = s.lfo.amount * 2400; // ± 2 octaves
        filters.forEach(f => lg.connect(f.detune));
      } else if (s.lfo.dest === 'pitch') {
        lg.gain.value = s.lfo.amount * 100; // ± 1 demi-ton
        oscs.forEach(o => lg.connect(o.detune));
      } else {
        const trem = ctx.createGain();
        trem.gain.value = 1 - s.lfo.amount / 2;
        lg.gain.value = s.lfo.amount / 2;
        lg.connect(trem.gain);
        rel.connect(trem);
        tail = trem;
        nodes.push(trem);
      }
      lfo.start(t);
      sources.push(lfo);
      nodes.push(lfo, lg);
    }
    tail.connect(this.bus);

    // --- Enveloppe de filtre (en cents sur detune : musicale, sans dépasser Nyquist)
    const envCents = s.filter.envAmount * 1200;
    const fe = s.filterEnv;
    if (envCents !== 0) {
      const fa = Math.max(MIN_ATTACK, fe.a);
      for (const f of filters) {
        if (legatoFrom) f.detune.setValueAtTime(envCents * fe.s, t);
        else {
          f.detune.setValueAtTime(0, t);
          f.detune.linearRampToValueAtTime(envCents, t + fa);
          f.detune.setTargetAtTime(envCents * fe.s, t + fa, Math.max(1e-3, fe.d / 4));
        }
      }
    }

    // --- Enveloppe d'amplitude
    const ae = s.ampEnv;
    const a = Math.max(MIN_ATTACK, ae.a);
    amp.gain.setValueAtTime(0, t);
    let legatoLvl: number | null = null;
    if (legatoFrom) {
      // Fondu croisé court avec la note précédente, au niveau qu'elle avait atteint.
      const lvl = ampEnvAt(legatoFrom.s.ampEnv, legatoFrom.peak, legatoFrom.start, t, legatoFrom.legatoLvl, legatoFrom.release);
      legatoLvl = lvl;
      amp.gain.linearRampToValueAtTime(lvl, t + STEAL_FADE);
      amp.gain.setTargetAtTime(peak * ae.s, t + STEAL_FADE, Math.max(1e-3, ae.d / 4));
    } else {
      amp.gain.linearRampToValueAtTime(peak, t + a);
      amp.gain.setTargetAtTime(peak * ae.s, t + a, Math.max(1e-3, ae.d / 4));
    }

    const v: Voice = { id: this.nextId++, pitch, start: t, release: Infinity, end: Infinity, vel, s, amp, rel, filters, sources, nodes, envCents, peak, legatoLvl };
    // Nettoyage quand la voix s'est tue (marche aussi à l'export, sans minuterie).
    if (sources[0]) sources[0].onended = () => this.dispose(v);
    else { this.dispose(v); return; }
    this.voices.push(v);

    // Mono : une note plus tardive déjà programmée (ordre quelconque) coupe celle-ci.
    if (s.mono) {
      const next = nextMonoStart(this.voices, v, Infinity);
      if (next !== null) this.cutVoice(v, next);
    }
  }

  public triggerRelease(pitch: number, time = 0) {
    const t = this.onGrid(Math.max(time, this.ctx.currentTime));
    const v = voiceToRelease(this.voices, pitch, t);
    if (!v) return;
    v.release = t;
    // Voix déjà coupée (ou dont la coupure est programmée) : la coupure l'emporte.
    if (v.cutAt !== undefined) return;
    const r = Math.max(MIN_RELEASE, v.s.ampEnv.r);
    // Le relâchement agit sur un gain à part (rel = 1 jusque-là) : l'attaque en
    // cours continue sans saut, quel que soit l'ordre de programmation.
    v.rel.gain.cancelScheduledValues(t);
    v.rel.gain.setValueAtTime(1, t);
    v.rel.gain.setTargetAtTime(0, t, r / 4);
    if (v.envCents !== 0) {
      const fr = Math.max(MIN_RELEASE, v.s.filterEnv.r);
      v.filters.forEach(f => { hold(f.detune, t); f.detune.setTargetAtTime(0, t, fr / 4); });
    }
    v.end = t + r * RELEASE_TAIL;
    this.stopSources(v, v.end);
  }

  /**
   * Instant calé sur un échantillon. Chrome arrondit un départ « à l'échantillon
   * supérieur » : 0,3 s × 44 100 = 13 230,000000000002 tombait sur 13 231, et la
   * lecture (temps calculés autrement) sur l'un ou l'autre au hasard. Un décalage
   * d'un échantillon entre les notes suffisait à rendre lecture et export différents.
   */
  private onGrid(t: number): number {
    const sr = this.ctx.sampleRate;
    const n = Math.round(t * sr);
    // Un millième d'échantillon AVANT n : l'arrondi supérieur de Chrome tombe
    // toujours sur n (mesuré : bien plus stable que n / sr tout court).
    return n <= 0 ? 0 : (n - 1e-3) / sr;
  }

  /** Coupe une voix avec un fondu très court (voix volée, même touche, mono). */
  private cutVoice(v: Voice, t: number) {
    if (v.cutAt !== undefined && v.cutAt <= t) return;
    if (v.end <= t) return;
    v.cutAt = t;
    const at = Math.max(t, v.start);
    this.fadeRel(v, at, STEAL_FADE);
    v.end = at + STEAL_FADE;
    this.stopSources(v, v.end + 0.002);
  }

  /**
   * Fondu à 0 sur le gain de relâchement, depuis sa valeur exacte à `at` (1, ou la
   * courbe de relâchement déjà commencée). Pas de cancelAndHoldAtTime : il renvoyait
   * une valeur fausse quand le relâchement était déjà programmé (clic mesuré).
   */
  private fadeRel(v: Voice, at: number, fade: number) {
    const r = Math.max(MIN_RELEASE, v.s.ampEnv.r);
    const lvl = at > v.release ? Math.exp(-(at - v.release) / (r / 4)) : 1;
    v.rel.gain.cancelScheduledValues(at);
    v.rel.gain.setValueAtTime(lvl, at);
    v.rel.gain.linearRampToValueAtTime(0, at + fade);
  }

  private stopSources(v: Voice, at: number) {
    for (const src of v.sources) { try { src.stop(at); } catch { /* déjà arrêtée */ } }
  }

  /**
   * Voix tue : on libère ses nœuds, mais on GARDE sa fiche (instants, touche) tant
   * que son « note off » n'est pas arrivé. Sinon, en lecture, le note off d'une note
   * coupée relâchait la note suivante de la même touche (à l'export, l'ordre des
   * appels est différent) : lecture et export divergeaient au hasard (mesuré).
   */
  private dispose(v: Voice) {
    for (const n of v.nodes) { try { n.disconnect(); } catch { /* */ } }
    v.nodes = [];
  }

  /** Oublie les voix finies depuis longtemps et déjà relâchées (garde la dernière jouée, pour le glissé). */
  private prune() {
    if (this.voices.length < 64) return;
    const old = this.ctx.currentTime - 2;
    let latest: Voice | null = null;
    for (const v of this.voices) if (!latest || v.start > latest.start) latest = v;
    this.voices = this.voices.filter(v => v.end > old || v.release === Infinity || v === latest);
  }

  /** Arrêt de la lecture : tout se tait en 30 ms, y compris les notes déjà programmées. */
  public releaseAll() {
    const now = this.ctx.currentTime;
    for (const v of [...this.voices]) {
      if (v.end <= now) continue;
      const at = Math.max(now, v.start);
      if (v.start > now) {
        // Pas encore commencée : elle ne doit jamais sonner.
        v.amp.gain.cancelScheduledValues(0);
        v.amp.gain.setValueAtTime(0, 0);
        v.cutAt = v.start;
        v.end = v.start;
        this.stopSources(v, v.start);
        continue;
      }
      this.fadeRel(v, at, 0.03);
      v.cutAt = at;
      v.end = at + 0.03;
      this.stopSources(v, v.end + 0.002);
    }
    this.voices = [];
  }

  public stopAll() { this.releaseAll(); }

  /** Nombre de voix qui sonnent (mesures, tests). */
  public activeVoiceCount(): number {
    const now = this.ctx.currentTime;
    return this.voices.filter(v => v.start <= now && v.end > now).length;
  }

  public destroy() {
    this.releaseAll();
    for (const l of this.chorusLfos) { try { l.stop(); } catch { /* */ } }
    for (const n of this.fxNodes) { try { n.disconnect(); } catch { /* */ } }
    try { this.bus.disconnect(); this.dry.disconnect(); this.output.disconnect(); } catch { /* */ }
  }
}
