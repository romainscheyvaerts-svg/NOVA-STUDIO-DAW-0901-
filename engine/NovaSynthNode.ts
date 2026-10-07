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
  mixNorm, envValue, glideSource, voicesToCut, voiceToRelease, nextMonoStart,
  MIN_ATTACK, MIN_RELEASE, STEAL_FADE, RELEASE_TAIL,
} from '../utils/novaSynth';

/** Crête d'une voix au volume 1 (proche de l'ancien synthé : 0,5 × vélocité). */
const PEAK = 0.55;

interface Voice extends VoiceSlot {
  vel: number;
  s: NovaSynthSettings;
  amp: GainNode;
  filters: BiquadFilterNode[];
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  envCents: number;
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

export class NovaSynthNode {
  public readonly output: GainNode;
  private readonly ctx: BaseAudioContext;
  private s: NovaSynthSettings;
  private voices: Voice[] = [];
  private nextId = 1;
  private readonly bus: GainNode;
  private readonly dry: GainNode;
  private readonly chorusWet: GainNode;
  private readonly chorusLfoGains: GainNode[] = [];
  private readonly chorusLfos: OscillatorNode[] = [];
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
    const merger = ctx.createChannelMerger(2);
    [0.011, 0.017].forEach((base, ch) => {
      const d = ctx.createDelay(0.05);
      d.delayTime.value = base;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
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
    this.chorusWet.connect(this.output);
    this.fxNodes.push(merger, this.chorusWet);

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
    this.chorusLfos.forEach((l, i) => set(l.frequency, chorus.rate * (i ? 1.13 : 1)));
    this.chorusLfoGains.forEach(g => set(g.gain, chorus.depth * 0.0035));
    set(this.delaySend.gain, delay.mix * 0.7);
    set(this.delay.delayTime, delay.time);
    set(this.delayFb.gain, delay.feedback);
  }

  public triggerAttack(pitch: number, velocity = 0.8, time = 0) {
    const ctx = this.ctx;
    const t = Math.max(time, ctx.currentTime);
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
    let tail: AudioNode = amp;
    nodes.push(mix, amp, ...filters);

    // --- Oscillateurs (+ unisson étalé en stéréo)
    const target = noteFreq(pitch);
    const from = src ? noteFreq(src.pitch) : target;
    const glideEnd = t + Math.max(0.001, s.glide);
    const oscs: OscillatorNode[] = [];
    for (const o of s.osc) {
      if (!o.on || o.level <= 0) continue;
      for (const u of unisonVoices(o.unison, o.detune, o.spread)) {
        const osc = ctx.createOscillator();
        osc.type = o.wave;
        osc.detune.value = oscCents(o) + u.cents;
        osc.frequency.setValueAtTime(from, t);
        if (from !== target) osc.frequency.exponentialRampToValueAtTime(target, glideEnd);
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
        amp.connect(trem);
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
    if (legatoFrom) {
      // Fondu croisé court avec la note précédente, au niveau qu'elle avait atteint.
      const lvl = peak * envValue(ae, t - legatoFrom.start);
      amp.gain.linearRampToValueAtTime(lvl, t + STEAL_FADE);
      amp.gain.setTargetAtTime(peak * ae.s, t + STEAL_FADE, Math.max(1e-3, ae.d / 4));
    } else {
      amp.gain.linearRampToValueAtTime(peak, t + a);
      amp.gain.setTargetAtTime(peak * ae.s, t + a, Math.max(1e-3, ae.d / 4));
    }

    const v: Voice = { id: this.nextId++, pitch, start: t, release: Infinity, end: Infinity, vel, s, amp, filters, sources, nodes, envCents };
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
    const t = Math.max(time, this.ctx.currentTime);
    const v = voiceToRelease(this.voices, pitch, t);
    if (!v) return;
    v.release = t;
    if (v.cutAt !== undefined && v.cutAt <= t) return;
    const r = Math.max(MIN_RELEASE, v.s.ampEnv.r);
    hold(v.amp.gain, t);
    v.amp.gain.setTargetAtTime(0, t, r / 4);
    if (v.envCents !== 0) {
      const fr = Math.max(MIN_RELEASE, v.s.filterEnv.r);
      v.filters.forEach(f => { hold(f.detune, t); f.detune.setTargetAtTime(0, t, fr / 4); });
    }
    v.end = t + r * RELEASE_TAIL;
    this.stopSources(v, v.end);
  }

  /** Coupe une voix avec un fondu très court (voix volée, même touche, mono). */
  private cutVoice(v: Voice, t: number) {
    if (v.cutAt !== undefined && v.cutAt <= t) return;
    if (v.end <= t) return;
    v.cutAt = t;
    const at = Math.max(t, v.start);
    hold(v.amp.gain, at);
    v.amp.gain.linearRampToValueAtTime(0, at + STEAL_FADE);
    v.end = at + STEAL_FADE;
    this.stopSources(v, v.end + 0.002);
  }

  private stopSources(v: Voice, at: number) {
    for (const src of v.sources) { try { src.stop(at); } catch { /* déjà arrêtée */ } }
  }

  private dispose(v: Voice) {
    for (const n of v.nodes) { try { n.disconnect(); } catch { /* */ } }
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
  }

  /** Oublie les voix terminées depuis longtemps (lecture en direct). */
  private prune() {
    const old = this.ctx.currentTime - 1;
    if (this.voices.length < 64) return;
    this.voices = this.voices.filter(v => v.end > old);
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
      hold(v.amp.gain, at);
      v.amp.gain.linearRampToValueAtTime(0, at + 0.03);
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
