
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useKnobInteraction } from '../hooks/useKnobInteraction';
import { termHelp } from '../utils/pluginUi';

/** Types de filtre en français, avec ce qu'ils font. */
const FILTER_LABELS: Record<string, { label: string; help: string }> = {
  highpass: { label: 'Coupe-bas', help: 'Coupe-bas (passe-haut) : retire les graves sous la fréquence (souffle, pas, vibrations).' },
  lowshelf: { label: 'Graves', help: 'Plateau grave (low shelf) : monte ou baisse tout ce qui est sous la fréquence.' },
  peaking: { label: 'Cloche', help: 'Cloche (bell) : monte ou baisse une zone autour de la fréquence.' },
  highshelf: { label: 'Aigus', help: 'Plateau aigu (high shelf) : monte ou baisse tout ce qui est au-dessus de la fréquence (brillance, air).' },
  lowpass: { label: 'Coupe-haut', help: 'Coupe-haut (passe-bas) : retire les aigus au-dessus de la fréquence.' },
  notch: { label: 'Encoche', help: 'Encoche (notch) : retire une fréquence très précise (sifflement, larsen).' },
};

/**
 * MODULE FX_01 : PRO-EQ 12 (SURGICAL GRADE)
 */

export type ProEQFilterType = 'peaking' | 'highpass' | 'lowpass' | 'lowshelf' | 'highshelf' | 'notch';

export interface ProEQBand {
  id: number;
  type: ProEQFilterType;
  frequency: number;
  gain: number;
  q: number;
  isEnabled: boolean;
  isSolo: boolean;
  color?: string;
}

export interface ProEQ12Params {
  bands: ProEQBand[];
  isEnabled: boolean;
  masterGain: number;
}

const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const DB_SCALE = 30; 
const MAX_GAIN = DB_SCALE;
const MIN_GAIN = -DB_SCALE; // Added missing constant

/**
 * Une bande toujours cablee : deux filtres en alternance (A/B) et une voie
 * directe, melanges par des gains. Avant, activer/couper une bande, la mettre
 * en solo ou changer son type reconstruisait toute la chaine : les filtres
 * repartaient d'un etat vide et le son claquait (et le moteur repasse
 * isEnabled a chaque mise a jour, donc chaque reglage recablait l'egaliseur).
 *  - bande en cloche / etagere : on la coupe en ramenant son gain a 0 dB, ou
 *    le filtre est strictement neutre (aucun dephasage, aucun fondu) ;
 *  - passe-haut / passe-bas / coupe-bande : fondu enchaine filtre <-> direct ;
 *  - changement de type : le filtre libre prend le nouveau type puis fondu
 *    enchaine de l'ancien vers le nouveau.
 */
interface EqBandVoice {
  input: GainNode;
  out: GainNode;
  filters: [BiquadFilterNode, BiquadFilterNode];
  gains: [GainNode, GainNode];
  dry: GainNode;
  slot: 0 | 1;
  type: ProEQFilterType;
  /** Bande câblée dans la chaîne en série (une bande neutre en est retirée : aucun calcul). */
  inChain: boolean;
  /** Entrées câblées : filtre A, filtre B, voie directe. */
  conn: [boolean, boolean, boolean];
}

const GAIN_TYPES: ProEQFilterType[] = ['peaking', 'lowshelf', 'highshelf'];
const EQ_FADE = 0.012;
/** Fin des fondus (≈ 8 constantes de temps) : on fige alors les réglages et on retire ce qui ne sert plus. */
const SETTLE_MS = 160;

/**
 * Charge processeur (mesurée le 08/10/2026, 20 égaliseurs rendus hors ligne) :
 * 70 ms de calcul par seconde de son et par égaliseur, soit 40 pistes = 2,8 s
 * par seconde : le rendu en direct ne pouvait pas suivre (craquements sans fin).
 * Causes : 24 filtres toujours calculés (deux par bande, même à 0 dB) et des
 * réglages lissés par setTargetAtTime jamais terminés, qui forcent le calcul des
 * coefficients échantillon par échantillon.
 * Maintenant : une bande neutre (cloche / étagère à 0 dB, bande coupée) est
 * retirée de la chaîne ; une bande active n'a qu'un filtre câblé ; une fois les
 * fondus finis, les réglages sont figés (valeurs fixes, calcul par bloc).
 * Le son est identique : une bande neutre est strictement transparente.
 */
export class ProEQ12Node {
  private ctx: BaseAudioContext;
  public input: GainNode;
  public output: GainNode;
  public preAnalyzer: AnalyserNode;
  public postAnalyzer: AnalyserNode;
  private voices: EqBandVoice[] = [];
  private params: ProEQ12Params;
  private readonly createdAt: number;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Valeurs visées par bande (pour figer les réglages à la fin des fondus). */
  private targets: { freq: number; q: number; gain: number; wet: number; dry: number; neutral: boolean }[] = [];

  constructor(ctx: BaseAudioContext, initialParams?: ProEQ12Params) {
    this.ctx = ctx;
    this.createdAt = ctx.currentTime;

    // Default params if not provided
    const defaultBands: ProEQBand[] = [
      { id: 0, type: 'highpass', frequency: 80, gain: 0, q: 1.0, isEnabled: true, isSolo: false },
      { id: 1, type: 'peaking', frequency: 150, gain: 0, q: 1.0, isEnabled: true, isSolo: false },
      { id: 2, type: 'peaking', frequency: 300, gain: 0, q: 1.0, isEnabled: true, isSolo: false },
      { id: 3, type: 'peaking', frequency: 500, gain: 0, q: 1.0, isEnabled: true, isSolo: false },
      { id: 4, type: 'peaking', frequency: 1000, gain: 0, q: 1.0, isEnabled: true, isSolo: false },
      { id: 5, type: 'peaking', frequency: 2000, gain: 0, q: 1.0, isEnabled: true, isSolo: false },
      { id: 6, type: 'peaking', frequency: 4000, gain: 0, q: 1.0, isEnabled: true, isSolo: false },
      { id: 7, type: 'peaking', frequency: 6000, gain: 0, q: 1.0, isEnabled: true, isSolo: false },
      { id: 8, type: 'peaking', frequency: 8000, gain: 0, q: 1.0, isEnabled: true, isSolo: false },
      { id: 9, type: 'peaking', frequency: 10000, gain: 0, q: 1.0, isEnabled: true, isSolo: false },
      { id: 10, type: 'peaking', frequency: 12000, gain: 0, q: 1.0, isEnabled: true, isSolo: false },
      { id: 11, type: 'lowpass', frequency: 18000, gain: 0, q: 1.0, isEnabled: true, isSolo: false }
    ];

    this.params = initialParams && Array.isArray(initialParams.bands) && initialParams.bands.length > 0
      ? { ...initialParams, bands: this.normalizeBands(initialParams.bands, defaultBands) }
      : { isEnabled: true, masterGain: 1.0, bands: defaultBands };

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.preAnalyzer = ctx.createAnalyser();
    this.preAnalyzer.fftSize = 4096;
    this.preAnalyzer.smoothingTimeConstant = 0.85;
    this.postAnalyzer = ctx.createAnalyser();
    this.postAnalyzer.fftSize = 4096;
    this.postAnalyzer.smoothingTimeConstant = 0.85;

    // Cablage : entree -> analyse -> bandes actives en serie -> analyse -> sortie
    this.input.connect(this.preAnalyzer);
    for (let i = 0; i < 12; i++) this.voices.push(this.createVoice(this.params.bands[i].type));
    this.postAnalyzer.connect(this.output);
    this.relink();
    this.applyAll(true);
  }

  /** 12 bandes completes et typees, quelles que soient les donnees recues. */
  private normalizeBands(bands: ProEQBand[], defaults: ProEQBand[]): ProEQBand[] {
    return defaults.map((d, i) => ({ ...d, ...(bands[i] || {}) }));
  }

  private createVoice(type: ProEQFilterType): EqBandVoice {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const out = ctx.createGain();
    const dry = ctx.createGain();
    dry.gain.value = 0;
    const filters: [BiquadFilterNode, BiquadFilterNode] = [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
    const gains: [GainNode, GainNode] = [ctx.createGain(), ctx.createGain()];
    for (let k = 0; k < 2; k++) {
      filters[k].type = type;
      gains[k].gain.value = k === 0 ? 1 : 0;
      // Sorties toujours câblées ; les ENTRÉES (input -> filtre / direct) le sont à la demande.
      filters[k].connect(gains[k]);
      gains[k].connect(out);
    }
    dry.connect(out);
    return { input, out, filters, gains, dry, slot: 0, type, inChain: false, conn: [false, false, false] };
  }

  /** Câble / décâble une entrée de la bande (0, 1 = filtres, 2 = voie directe). */
  private wireInput(v: EqBandVoice, k: 0 | 1 | 2, on: boolean) {
    if (v.conn[k] === on) return;
    const dest = k === 2 ? v.dry : v.filters[k];
    if (on) v.input.connect(dest);
    else { try { v.input.disconnect(dest); } catch (e) { /* déjà décâblée */ } }
    v.conn[k] = on;
  }

  /** Chaîne en série des seules bandes actives. */
  private relink() {
    try { this.preAnalyzer.disconnect(); } catch (e) { /* */ }
    let last: AudioNode = this.preAnalyzer;
    for (const v of this.voices) {
      try { v.out.disconnect(); } catch (e) { /* */ }
      if (!v.inChain) continue;
      last.connect(v.input);
      last = v.out;
    }
    last.connect(this.postAnalyzer);
  }

  private bandActive(i: number): boolean {
    const bands = this.params.bands;
    const soloIdx = bands.findIndex(b => b && b.isSolo && b.isEnabled);
    if (soloIdx !== -1) return i === soloIdx;
    return !!bands[i]?.isEnabled && this.params.isEnabled !== false;
  }

  /** immediate : valeurs posees sans lissage (creation, premier reglage). */
  private applyAll(immediate = false) {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const smooth = !immediate && now > this.createdAt;
    const set = (prm: AudioParam, v: number, tau: number, soft = smooth) => {
      if (!Number.isFinite(v)) return;
      if (soft) prm.setTargetAtTime(v, now, tau);
      else { prm.cancelScheduledValues(now); prm.setValueAtTime(v, now); }
    };
    const nyq = this.ctx.sampleRate / 2;
    const safe = (v: number, def: number) => Number.isFinite(v) ? v : def;
    let relink = false;

    this.params.bands.forEach((band, i) => {
      const v = this.voices[i];
      if (!v || !band) return;
      const type = (band.type || 'peaking') as ProEQFilterType;
      const freq = Math.max(10, Math.min(nyq * 0.99, safe(band.frequency, 1000)));
      const q = Math.max(0.0001, Math.min(1000, safe(band.q, 1)));
      const gain = Math.max(-40, Math.min(40, safe(band.gain, 0)));
      const active = this.bandActive(i);
      const gainType = GAIN_TYPES.includes(type);
      const fGain = gainType && !active ? 0 : gain;
      const wet = gainType ? 1 : (active ? 1 : 0);
      // Bande strictement transparente : cloche / étagère à 0 dB (ou coupée), filtre coupé.
      const neutral = gainType ? Math.abs(fGain) < 1e-6 : !active;
      this.targets[i] = { freq, q, gain: fGain, wet, dry: 1 - wet, neutral };

      if (!v.inChain) {
        const f = v.filters[v.slot];
        f.type = type; v.type = type;
        if (neutral) {
          // Hors chaîne : réglages posés directement (aucun calcul, aucun fondu).
          set(f.frequency, freq, 0, false); set(f.Q, q, 0, false); set(f.gain, fGain, 0, false);
          set(v.gains[v.slot].gain, wet, 0, false); set(v.gains[v.slot === 0 ? 1 : 0].gain, 0, 0, false);
          set(v.dry.gain, 1 - wet, 0, false);
          return;
        }
        // Entrée dans la chaîne à l'état TRANSPARENT (gain 0 dB ou voie directe), puis fondu vers le réglage.
        set(f.frequency, freq, 0, false); set(f.Q, q, 0, false);
        set(f.gain, gainType && smooth ? 0 : fGain, 0, false);
        set(v.gains[v.slot].gain, gainType || !smooth ? wet : 0, 0, false);
        set(v.gains[v.slot === 0 ? 1 : 0].gain, 0, 0, false);
        set(v.dry.gain, gainType || !smooth ? 1 - wet : 1, 0, false);
        this.wireInput(v, v.slot, true);
        if (!gainType && smooth) this.wireInput(v, 2, true);
        v.inChain = true;
        relink = true;
      }

      if (type !== v.type) {
        // Changement de type : le filtre libre est prepare (inaudible), puis fondu.
        const next = (v.slot === 0 ? 1 : 0) as 0 | 1;
        const f = v.filters[next];
        f.type = type;
        f.frequency.cancelScheduledValues(now); f.frequency.setValueAtTime(freq, now);
        f.Q.cancelScheduledValues(now); f.Q.setValueAtTime(q, now);
        f.gain.cancelScheduledValues(now); f.gain.setValueAtTime(fGain, now);
        this.wireInput(v, next, true);
        set(v.gains[v.slot].gain, 0, EQ_FADE);
        v.slot = next;
        v.type = type;
      } else {
        const f = v.filters[v.slot];
        set(f.frequency, freq, 0.03);
        set(f.Q, q, 0.03);
        // Cloche / etagere coupee = gain 0 dB : filtre neutre, sans fondu.
        set(f.gain, fGain, 0.03);
      }
      if (1 - wet > 0) this.wireInput(v, 2, true);
      set(v.gains[v.slot].gain, wet, EQ_FADE);
      set(v.dry.gain, 1 - wet, EQ_FADE);
    });

    const mg = safe(this.params.masterGain, 1.0);
    set(this.output.gain, Math.max(0, mg), 0.01);
    if (relink) this.relink();
    if (!smooth) this.settle();
    else this.scheduleSettle();
  }

  private scheduleSettle() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => { this.settleTimer = null; this.settle(); }, SETTLE_MS);
  }

  /**
   * Fondus terminés : réglages figés (plus de calcul échantillon par échantillon),
   * filtre / voie directe inutiles décâblés, bandes neutres retirées de la chaîne.
   */
  private settle() {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const fix = (prm: AudioParam, v: number) => { prm.cancelScheduledValues(now); prm.setValueAtTime(v, now); };
    let relink = false;
    this.voices.forEach((v, i) => {
      const t = this.targets[i];
      if (!t) return;
      const other = (v.slot === 0 ? 1 : 0) as 0 | 1;
      const f = v.filters[v.slot];
      fix(f.frequency, t.freq); fix(f.Q, t.q); fix(f.gain, t.gain);
      fix(v.gains[v.slot].gain, t.wet); fix(v.gains[other].gain, 0); fix(v.dry.gain, t.dry);
      if (t.neutral) {
        if (v.inChain) { v.inChain = false; relink = true; }
        this.wireInput(v, 0, false); this.wireInput(v, 1, false); this.wireInput(v, 2, false);
        return;
      }
      this.wireInput(v, other, false);
      this.wireInput(v, v.slot, t.wet > 0);
      this.wireInput(v, 2, t.dry > 0);
    });
    const mg = Number.isFinite(this.params.masterGain) ? Math.max(0, this.params.masterGain) : 1;
    fix(this.output.gain, mg);
    if (relink) this.relink();
  }

  public updateParams(p: Partial<ProEQ12Params>) {
    const next = { ...this.params, ...p };
    if (p.bands) next.bands = this.normalizeBands(p.bands, this.params.bands);
    this.params = next;
    this.applyAll();
  }

  /** Bandes réellement calculées (diagnostic, tests). */
  public activeBandCount(): number {
    return this.voices.filter(v => v.inChain).length;
  }

  public getFrequencyResponse(freqs: Float32Array): Float32Array {
    const totalMag = new Float32Array(freqs.length).fill(1.0);
    const mag = new Float32Array(freqs.length);
    const phase = new Float32Array(freqs.length);
    this.voices.forEach((v, i) => {
      if (this.bandActive(i)) {
        v.filters[v.slot].getFrequencyResponse(freqs as any, mag as any, phase as any);
        for (let j = 0; j < freqs.length; j++) totalMag[j] *= mag[j];
      }
    });
    return totalMag;
  }

  public dispose() {
    this.disposed = true;
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    try { this.input.disconnect(); } catch (e) {}
    try { this.preAnalyzer.disconnect(); } catch (e) {}
    try { this.postAnalyzer.disconnect(); } catch (e) {}
    for (const v of this.voices) {
      for (const n of [v.input, v.out, v.dry, ...v.filters, ...v.gains]) {
        try { n.disconnect(); } catch (e) {}
      }
    }
  }
}

const EQKnob: React.FC<{ 
  label: string, value: number, min: number, max: number, onChange: (v: number) => void, 
  suffix: string, color: string, log?: boolean, disabled?: boolean, precision?: number 
}> = ({ label, value, min, max, onChange, suffix, color, log, disabled, precision = 0 }) => {
  const safeValue = Number.isFinite(value) ? value : min;
  const knob = useKnobInteraction(safeValue, onChange, { min, max, log, disabled });
  const norm = log ? (Math.log10(safeValue / min) / Math.log10(max / min)) : (safeValue - min) / (max - min);
  

  const rotation = (norm * 270) - 135;
  return (
    <div title={termHelp(label) || undefined} className={`flex flex-col items-center space-y-2 select-none touch-none ${disabled ? 'opacity-20 grayscale' : ''}`}>
      <div {...knob.bind} className="relative w-12 h-12 rounded-full bg-[#14161a] border border-white/10 flex items-center justify-center cursor-ns-resize shadow-xl hover:border-white/30 transition-all">
        <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40 shadow-inner" />
        <div className="absolute top-1/2 left-1/2 w-1 h-5 -ml-0.5 -mt-5 origin-bottom rounded-full transition-transform duration-75" style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}`, transform: `rotate(${rotation}deg) translateY(2px)` }} />
        <div className="absolute inset-4 rounded-full bg-[#1c1f26] border border-white/5" />
      </div>
      <div className="text-center">
        <span className="block text-[9px] font-bold text-slate-400 mb-1 whitespace-nowrap">{label}</span>
        <div className="bg-black/60 px-1.5 py-0.5 rounded border border-white/5 min-w-[45px]">
          <span className="text-[8px] font-mono font-bold text-white">{safeValue.toFixed(precision)}{suffix}</span>
        </div>
      </div>
    </div>
  );
};

export const ProEQ12UI: React.FC<{ node: ProEQ12Node, initialParams: ProEQ12Params, onParamsChange?: (p: ProEQ12Params) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState(initialParams);
  const [selectedBandIdx, setSelectedBandIdx] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const freqToX = (f: number, w: number) => (Math.log10(f / MIN_FREQ) / Math.log10(MAX_FREQ / MIN_FREQ)) * w;
  const xToFreq = (x: number, w: number) => MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, x / w);
  const dbToY = (db: number, h: number) => h - (Math.max(0, Math.min(1, (db + DB_SCALE) / (DB_SCALE * 2))) * h);
  const yToDb = (y: number, h: number) => ((1 - (y / h)) * (DB_SCALE * 2)) - DB_SCALE;

  const frequencies = useMemo(() => {
    const f = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) f[i] = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, i / 1023);
    return f;
  }, []);

  const updateBand = useCallback((idx: number, updates: Partial<ProEQBand>) => {
    // Refactored to avoid side-effects inside setState
    const newBands = [...params.bands];
    newBands[idx] = { ...newBands[idx], ...updates };
    const newParams = { ...params, bands: newBands };
    
    setParams(newParams);
    node.updateParams(newParams);
    if (onParamsChange) onParamsChange(newParams);
  }, [params, node, onParamsChange]);

  const handleGraphInteraction = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect(); 
    if (!rect) return;
    const x = clientX - rect.left; 
    const y = clientY - rect.top;
    
    // Find band
    let closestIdx = -1; let minDist = 30;
    params.bands.forEach((b, i) => {
      const bx = freqToX(b.frequency, rect.width); 
      const by = b.type.includes('pass') ? rect.height / 2 : dbToY(b.gain, rect.height);
      const dist = Math.sqrt((x - bx) ** 2 + (y - by) ** 2);
      if (dist < minDist) { minDist = dist; closestIdx = i; }
    });

    if (closestIdx !== -1) {
      setSelectedBandIdx(closestIdx);
      return { idx: closestIdx, startX: clientX, startY: clientY, startFreq: params.bands[closestIdx].frequency, startGain: params.bands[closestIdx].gain };
    }
    return null;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const data = handleGraphInteraction(e.clientX, e.clientY);
    if (!data) return;
    const rect = canvasRef.current!.getBoundingClientRect();

    const onMouseMove = (m: MouseEvent) => {
      const dx = m.clientX - data.startX; 
      const dy = data.startY - m.clientY;
      const curX = freqToX(data.startFreq, rect.width) + dx;
      const newFreq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, xToFreq(Math.max(0, Math.min(rect.width, curX)), rect.width)));
      let newGain = data.startGain + (dy / (rect.height / 2)) * MAX_GAIN;
      if (params.bands[data.idx].type.includes('pass')) newGain = 0;
      else newGain = Math.max(-DB_SCALE, Math.min(DB_SCALE, newGain));
      updateBand(data.idx, { frequency: newFreq, gain: newGain });
    };
    const onMouseUp = () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const touch = e.touches[0];
    const data = handleGraphInteraction(touch.clientX, touch.clientY);
    if (!data) return;
    const rect = canvasRef.current!.getBoundingClientRect();

    const onTouchMove = (t: TouchEvent) => {
      if (t.cancelable) t.preventDefault();
      const m = t.touches[0];
      const dx = m.clientX - data.startX; 
      const dy = data.startY - m.clientY;
      const curX = freqToX(data.startFreq, rect.width) + dx;
      const newFreq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, xToFreq(Math.max(0, Math.min(rect.width, curX)), rect.width)));
      let newGain = data.startGain + (dy / (rect.height / 2)) * MAX_GAIN;
      if (params.bands[data.idx].type.includes('pass')) newGain = 0;
      else newGain = Math.max(-DB_SCALE, Math.min(DB_SCALE, newGain));
      updateBand(data.idx, { frequency: newFreq, gain: newGain });
    };
    const onTouchEnd = () => { window.removeEventListener('touchmove', onTouchMove); window.removeEventListener('touchend', onTouchEnd); };
    window.addEventListener('touchmove', onTouchMove, { passive: false }); window.addEventListener('touchend', onTouchEnd);
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect && (canvas.width !== rect.width || canvas.height !== rect.height)) { canvas.width = rect.width; canvas.height = rect.height; }
    const w = canvas.width; const h = canvas.height;

    ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 1; ctx.strokeStyle = '#1e2229'; ctx.beginPath();
    [30, 60, 100, 200, 500, 1000, 2000, 5000, 10000, 15000].forEach(f => { const x = freqToX(f, w); ctx.moveTo(x, 0); ctx.lineTo(x, h); });
    [-18, -12, -6, 0, 6, 12, 18].forEach(db => { const y = dbToY(db, h); ctx.moveTo(0, y); ctx.lineTo(w, y); });
    ctx.stroke();
    
    ctx.strokeStyle = '#334155'; ctx.beginPath(); const zeroY = dbToY(0, h); ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();

    const binCount = node.preAnalyzer.frequencyBinCount;
    const postData = new Uint8Array(binCount);
    node.postAnalyzer.getByteFrequencyData(postData);
    const step = Math.ceil(binCount / w); 
    
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let i = 0; i < binCount; i += step) {
        const freq = i * (node.preAnalyzer.context.sampleRate / 2) / binCount;
        if (freq < MIN_FREQ) continue; if (freq > MAX_FREQ) break;
        const x = freqToX(freq, w);
        const y = h - ((postData[i] / 255) * h); 
        ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.fillStyle = 'rgba(6, 182, 212, 0.2)'; ctx.fill();

    const resp = node.getFrequencyResponse(frequencies);
    ctx.beginPath(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
    for(let i=0; i<frequencies.length; i++) {
        const x = freqToX(frequencies[i], w);
        const db = 20 * Math.log10(Math.max(resp[i], 0.00001));
        const y = dbToY(db, h);
        if (i===0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    params.bands.forEach((b, i) => {
      const x = freqToX(b.frequency, w);
      const y = b.type.includes('pass') ? h / 2 : dbToY(b.gain, h);
      ctx.beginPath(); ctx.arc(x, y, selectedBandIdx === i ? 8 : 5, 0, Math.PI * 2);
      ctx.fillStyle = b.isEnabled ? (selectedBandIdx === i ? '#fff' : 'rgba(255,255,255,0.7)') : '#333';
      ctx.fill();
      if (selectedBandIdx === i) {
        ctx.strokeStyle = '#00f2ff'; ctx.lineWidth = 2; ctx.stroke();
      }
    });
  }, [node, frequencies, params, selectedBandIdx]);

  useEffect(() => {
    let animFrame = 0; const loop = () => { draw(); animFrame = requestAnimationFrame(loop); };
    animFrame = requestAnimationFrame(loop); return () => cancelAnimationFrame(animFrame);
  }, [draw]);

  const currentBand = params.bands[selectedBandIdx];
  
  return (
    <div className="w-[850px] bg-[#0c0d10] border border-white/10 rounded-[40px] overflow-hidden shadow-2xl flex flex-col select-none animate-in fade-in zoom-in duration-300">
      <div className="p-8 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
        <div className="flex items-center space-x-6">
          <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20 shadow-lg shadow-cyan-500/5"><i className="fas fa-wave-square text-2xl"></i></div>
          <div><h2 className="text-2xl font-black text-white tracking-tight leading-none">Égaliseur <span className="text-[11px] ml-2 font-normal text-slate-500">{params.bands.length} bandes</span></h2><p className="text-[12px] text-slate-400 mt-2">Sculpte le son : retire ce qui gêne, ajoute de la présence ou de l'air.</p></div>
        </div>
        
        <div className="flex items-center space-x-4">
           <div className="flex bg-black/40 rounded-xl p-1 border border-white/5">
            {params.bands.map((b, i) => (
              <button 
                key={i} 
 onClick={() => setSelectedBandIdx(i)} title={`Bande ${i + 1} : ${(FILTER_LABELS[b.type] || { label: b.type }).label}, ${Math.round(b.frequency)} Hz`} aria-label={`Bande ${i + 1}`} 
                className={`w-8 h-8 rounded-lg text-[9px] font-black transition-all border ${selectedBandIdx === i ? 'bg-white text-black border-white' : 'bg-transparent text-slate-600 border-transparent hover:text-slate-400'}`}
                style={{ color: selectedBandIdx === i ? '#000' : b.color || '#fff' }}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <button data-plugin-power 
            onClick={() => { const newState = !params.isEnabled; setParams({...params, isEnabled: newState}); node.updateParams({isEnabled: newState}); }}
            className={`w-12 h-12 rounded-full border transition-all flex items-center justify-center ${params.isEnabled ? 'bg-cyan-500 border-cyan-400 text-black shadow-lg shadow-cyan-500/40' : 'bg-white/5 border-white/10 text-slate-600'}`}
          >
            <i className="fas fa-power-off"></i>
          </button>
        </div>
      </div>

      <div ref={containerRef} className="relative h-[320px] bg-black/40 cursor-crosshair border-b border-white/5 overflow-hidden" onWheel={(e) => { const delta = e.deltaY > 0 ? -0.1 : 0.1; updateBand(selectedBandIdx, { q: Math.max(0.1, Math.min(10, currentBand.q + delta)) }); }}>
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,rgba(0,242,255,0.03),transparent)]" />
        <canvas ref={canvasRef} className="w-full h-full touch-none" onMouseDown={handleMouseDown} onTouchStart={handleTouchStart} />
        <div className="absolute bottom-4 right-6 text-[10px] font-bold text-slate-600">Glisse un point pour régler · molette = largeur</div>
      </div>

      <div className="p-10 bg-white/[0.01] flex flex-col space-y-10">
        <div className="flex items-center justify-between">
           <div className="flex items-center space-x-10">
              <div className="space-y-4">
                <label className="text-[11px] font-bold text-slate-400 ml-1">Type de filtre (bande {selectedBandIdx + 1})</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['highpass', 'lowshelf', 'peaking', 'highshelf', 'lowpass', 'notch'] as ProEQFilterType[]).map(t => (
                    <button 
                      key={t} 
                      title={FILTER_LABELS[t].help}
                      onClick={() => updateBand(selectedBandIdx, { type: t, gain: (t.includes('pass') || t === 'notch') ? 0 : currentBand.gain })} 
                      className={`px-3 py-2 rounded-xl text-[10px] font-bold border transition-all ${currentBand.type === t ? 'bg-cyan-500 text-black border-cyan-500 shadow-lg shadow-cyan-500/20' : 'bg-white/5 border-white/10 text-slate-600 hover:text-white'}`}
                    >
                      {FILTER_LABELS[t].label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="h-16 w-px bg-white/5 self-end mb-1" />

              <div className="flex space-x-8">
                <EQKnob label="Fréquence" value={currentBand.frequency} min={MIN_FREQ} max={MAX_FREQ} log suffix="Hz" onChange={v => updateBand(selectedBandIdx, { frequency: v })} color={currentBand.color || '#fff'} />
                <EQKnob label="Gain" value={currentBand.gain} min={MIN_GAIN} max={MAX_GAIN} suffix="dB" onChange={v => updateBand(selectedBandIdx, { gain: v })} color={currentBand.color || '#fff'} disabled={currentBand.type.includes('pass') || currentBand.type === 'notch'} precision={1} />
                <EQKnob label="Largeur" value={currentBand.q} min={0.1} max={10} suffix="" onChange={v => updateBand(selectedBandIdx, { q: v })} color={currentBand.color || '#fff'} precision={2} />
              </div>
           </div>

           <div className="flex flex-col items-end space-y-4">
              <button 
                onClick={() => updateBand(selectedBandIdx, { isEnabled: !currentBand.isEnabled })}
                aria-pressed={currentBand.isEnabled}
                title="Active ou coupe seulement cette bande (l'égaliseur entier se coupe avec le bouton de la barre du haut)"
                className={`h-10 px-6 rounded-xl text-[11px] font-bold border transition-all ${currentBand.isEnabled ? 'bg-white/5 border-white/20 text-white' : 'bg-red-500/20 border-red-500/40 text-red-500'}`}
              >
                {currentBand.isEnabled ? `Bande ${selectedBandIdx + 1} active` : `Bande ${selectedBandIdx + 1} coupée`}
              </button>
           </div>
        </div>
      </div>
    </div>
  );
};