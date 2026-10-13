
import { AutomationSet, MappedParam, parseEqKey } from '../engine/automationParams';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { gainDbFr } from '../utils/pluginUi';
import { Faceplate, HwSection, HwWindow, Knob, Led, PushButton, useHwHelp } from './hw';
import { fmtHzFr, frNum, useHwCanvas } from './hw/screens';
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
  /** Réglages automatisables (R8) : fréquence, gain et Q de chaque bande, gain de sortie. */
  private auto = new AutomationSet();
  private firstApply = true;
  /**
   * Réglages qu'une voie d'automation a programmés (R8) : le moteur les tient,
   * `settle` ne les fige pas (il effacerait la courbe programmée d'avance) et une
   * bande dont le GAIN est automatisé reste dans la chaîne même à 0 dB fixe.
   */
  private automated = new Set<string>();

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
    // Chaque réglage d'une bande pilote ses DEUX filtres (A/B) : le changement de type reste sans clic.
    const nyq = ctx.sampleRate / 2;
    this.voices.forEach((v, i) => {
      const b = this.params.bands[i];
      const both = (k: 'frequency' | 'Q' | 'gain') => v.filters.map(f => ({ param: f[k] }));
      this.auto.add(`b${i + 1}Freq`, new MappedParam(ctx, both('frequency'), { min: 10, max: Math.min(22000, nyq * 0.99), value: Number.isFinite(b?.frequency) ? b.frequency : 1000, affine: true }));
      this.auto.add(`b${i + 1}Gain`, new MappedParam(ctx, both('gain'), { min: -40, max: 40, value: 0, affine: true }));
      this.auto.add(`b${i + 1}Q`, new MappedParam(ctx, both('Q'), { min: 0.0001, max: 1000, value: Number.isFinite(b?.q) ? b.q : 1, affine: true }));
    });
    this.auto.add('masterGain', new MappedParam(ctx, [{ param: this.output.gain }], { min: 0, max: 4, value: 1, affine: true }));
    this.relink();
    this.applyAll(true);
  }

  /**
   * AudioParam d'un réglage automatisable (R8) : « b3Freq », « b3Gain », « b3Q », « masterGain » ; sinon null.
   * Le moteur ne le demande que pour y programmer une voie : le réglage est alors tenu
   * (bande gardée dans la chaîne si son gain est automatisé, jamais figé par `settle`).
   */
  public automationParam(key: string): MappedParam | null {
    const mp = this.auto.get(key);
    if (mp && !this.automated.has(key)) {
      this.automated.add(key);
      // Gain d'une bande automatisé : elle rentre dans la chaîne tout de suite (même à 0 dB fixe).
      if (/^b\d+Gain$/.test(key)) this.applyAll();
    }
    return mp;
  }

  /** Lecture arrêtée : les réglages automatisés reviennent à leur valeur fixe. */
  public restoreStatic() {
    if (!this.automated.size) return;
    this.automated.clear();
    this.auto.restoreStatic();
    // Bandes redevenues neutres retirées, réglages figés après le fondu.
    this.applyAll();
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

    const force = this.firstApply;
    this.firstApply = false;
    const st = (tau: number) => ({ immediate: !smooth, force, tau });
    /** Réglage d'une bande posé SANS fondu, sauf s'il est tenu par une voie d'automation. */
    const put = (key: string, val: number) => { if (!this.automated.has(key)) this.auto.get(key)!.setStatic(val, { immediate: true, force: true }); };

    this.params.bands.forEach((band, i) => {
      const v = this.voices[i];
      if (!v || !band) return;
      const kF = `b${i + 1}Freq`, kQ = `b${i + 1}Q`, kG = `b${i + 1}Gain`;
      const type = (band.type || 'peaking') as ProEQFilterType;
      const freq = Math.max(10, Math.min(nyq * 0.99, safe(band.frequency, 1000)));
      const q = Math.max(0.0001, Math.min(1000, safe(band.q, 1)));
      const gain = Math.max(-40, Math.min(40, safe(band.gain, 0)));
      const active = this.bandActive(i);
      const gainType = GAIN_TYPES.includes(type);
      const fGain = gainType && !active ? 0 : gain;
      const wet = gainType ? 1 : (active ? 1 : 0);
      // Bande strictement transparente : cloche / étagère à 0 dB (ou coupée), filtre coupé.
      // Gain automatisé (R8) : la bande active reste calculée, la courbe peut quitter 0 dB.
      const neutral = gainType ? (!active || (Math.abs(fGain) < 1e-6 && !this.automated.has(kG))) : !active;
      this.targets[i] = { freq, q, gain: fGain, wet, dry: 1 - wet, neutral };

      if (!v.inChain) {
        const f = v.filters[v.slot];
        f.type = type; v.type = type;
        if (neutral) {
          // Hors chaîne : réglages posés directement (aucun calcul, aucun fondu).
          put(kF, freq); put(kQ, q); put(kG, fGain);
          set(v.gains[v.slot].gain, wet, 0, false); set(v.gains[v.slot === 0 ? 1 : 0].gain, 0, 0, false);
          set(v.dry.gain, 1 - wet, 0, false);
          return;
        }
        // Entrée dans la chaîne à l'état TRANSPARENT (gain 0 dB ou voie directe), puis fondu vers le réglage.
        put(kF, freq); put(kQ, q);
        put(kG, gainType && smooth ? 0 : fGain);
        set(v.gains[v.slot].gain, gainType || !smooth ? wet : 0, 0, false);
        set(v.gains[v.slot === 0 ? 1 : 0].gain, 0, 0, false);
        set(v.dry.gain, gainType || !smooth ? 1 - wet : 1, 0, false);
        this.wireInput(v, v.slot, true);
        if (!gainType && smooth) this.wireInput(v, 2, true);
        v.inChain = true;
        relink = true;
      }

      if (type !== v.type) {
        // Changement de type : le filtre libre (déjà réglé, inaudible : les deux filtres
        // suivent les mêmes réglages) prend le type, puis fondu.
        const next = (v.slot === 0 ? 1 : 0) as 0 | 1;
        v.filters[next].type = type;
        this.wireInput(v, next, true);
        set(v.gains[v.slot].gain, 0, EQ_FADE);
        v.slot = next;
        v.type = type;
      }
      // Fréquence, Q et gain : posés seulement s'ils ont changé (une voie d'automation garde la main).
      this.auto.get(kF)!.setStatic(freq, st(0.03));
      this.auto.get(kQ)!.setStatic(q, st(0.03));
      // Cloche / etagere coupee = gain 0 dB : filtre neutre, sans fondu.
      this.auto.get(kG)!.setStatic(fGain, st(0.03));
      if (1 - wet > 0) this.wireInput(v, 2, true);
      set(v.gains[v.slot].gain, wet, EQ_FADE);
      set(v.dry.gain, 1 - wet, EQ_FADE);
    });

    const mg = safe(this.params.masterGain, 1.0);
    this.auto.get('masterGain')!.setStatic(Math.max(0, mg), st(0.01));
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
   * Un réglage tenu par une voie d'automation (R8) n'est jamais figé.
   */
  private settle() {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const fix = (prm: AudioParam, v: number) => { prm.cancelScheduledValues(now); prm.setValueAtTime(v, now); };
    const fixKey = (key: string, v: number) => { if (!this.automated.has(key)) this.auto.get(key)!.setStatic(v, { immediate: true, force: true }); };
    let relink = false;
    this.voices.forEach((v, i) => {
      const t = this.targets[i];
      if (!t) return;
      const other = (v.slot === 0 ? 1 : 0) as 0 | 1;
      fixKey(`b${i + 1}Freq`, t.freq); fixKey(`b${i + 1}Q`, t.q); fixKey(`b${i + 1}Gain`, t.gain);
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
    fixKey('masterGain', mg);
    if (relink) this.relink();
  }

  public updateParams(p: Partial<ProEQ12Params> & Record<string, any>) {
    const next = { ...this.params, ...p };
    if (p.bands) next.bands = this.normalizeBands(p.bands, this.params.bands);
    // Réglage d'automation à plat (« b3Freq ») : rangé dans sa bande.
    for (const [k, v] of Object.entries(p || {})) {
      const e = parseEqKey(k);
      if (!e || typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (next.bands === this.params.bands) next.bands = next.bands.map(b => ({ ...b }));
      (next.bands[e.band] as any)[e.field] = v;
      delete (next as any)[k];
    }
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

// ── Fenêtre ─────────────────────────────────────────────────────────────────

const EQ_ACCENT = '#7dd3fc';
/** Couleur de chaque bande (points de l'écran, LED, arcs des boutons). */
const BAND_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#a3e635', '#4ade80', '#2dd4bf', '#22d3ee', '#60a5fa', '#818cf8', '#a78bfa', '#e879f9', '#f472b6'];
const DEFAULT_FREQS = [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000];
const TYPE_ORDER: ProEQFilterType[] = ['highpass', 'lowshelf', 'peaking', 'highshelf', 'lowpass', 'notch'];
/** Bande sans gain : coupe-bas, coupe-haut, encoche (le gain n'y fait rien). */
const noGain = (t: ProEQFilterType) => t.includes('pass') || t === 'notch';
const bandColor = (b: ProEQBand | undefined, i: number) => b?.color || BAND_COLORS[i % BAND_COLORS.length];
const fmtGain = (g: number) => `${g > 0.05 ? '+' : g < -0.05 ? '−' : ''}${frNum(Math.abs(g), 1)} dB`;
const shortHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toLocaleString('fr-FR', { maximumFractionDigits: hz >= 10000 ? 0 : 1 })}k` : String(Math.round(hz)));
const DEFAULT_EQ: ProEQ12Params = {
  isEnabled: true, masterGain: 1,
  bands: DEFAULT_FREQS.map((f, i) => ({ id: i, type: (i === 0 ? 'highpass' : i === 11 ? 'lowpass' : 'peaking') as ProEQFilterType, frequency: f, gain: 0, q: 1, isEnabled: true, isSolo: false })),
};

/** Forme du filtre (petite icône sur les boutons de type). */
const FILTER_ICON: Record<ProEQFilterType, string> = {
  highpass: 'M1 13 C 5 13, 7 3, 11 3 L 25 3',
  lowshelf: 'M1 4 L 8 4 C 12 4, 13 10, 17 10 L 25 10',
  peaking: 'M1 10 L 7 10 C 10 10, 11 2, 13 2 C 15 2, 16 10, 19 10 L 25 10',
  highshelf: 'M1 10 L 9 10 C 13 10, 14 4, 18 4 L 25 4',
  lowpass: 'M1 3 L 15 3 C 19 3, 21 13, 25 13',
  notch: 'M1 4 L 10 4 C 12 4, 12.4 13, 13 13 C 13.6 13, 14 4, 16 4 L 25 4',
};
const FilterIcon: React.FC<{ type: ProEQFilterType }> = ({ type }) => (
  <svg width="26" height="14" viewBox="0 0 26 14" aria-hidden="true"><path d={FILTER_ICON[type]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

/**
 * Réponse (dB) d'une bande seule à la fréquence f, formules des filtres
 * biquad du Web Audio (affichage de la bande choisie, en couleur).
 */
function bandResponseDb(b: ProEQBand, f: number, sr: number): number {
  const f0 = Math.max(10, Math.min(sr * 0.495, b.frequency || 1000));
  const w0 = (2 * Math.PI * f0) / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  const Q = Math.max(0.0001, b.q || 1);
  const A = Math.pow(10, (b.gain || 0) / 40);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (b.type) {
    case 'lowpass': case 'highpass': {
      const al = sw / (2 * Math.pow(10, Q / 20));
      const lp = b.type === 'lowpass';
      b0 = lp ? (1 - cw) / 2 : (1 + cw) / 2; b1 = lp ? 1 - cw : -(1 + cw); b2 = b0;
      a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    }
    case 'notch': { const al = sw / (2 * Q); b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break; }
    case 'lowshelf': case 'highshelf': {
      const al = (sw / 2) * Math.SQRT2, sA = 2 * Math.sqrt(A) * al;
      if (b.type === 'lowshelf') {
        b0 = A * ((A + 1) - (A - 1) * cw + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sA);
        a0 = (A + 1) + (A - 1) * cw + sA; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sA;
      } else {
        b0 = A * ((A + 1) + (A - 1) * cw + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sA);
        a0 = (A + 1) - (A - 1) * cw + sA; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sA;
      }
      break;
    }
    default: { const al = sw / (2 * Q); b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
  }
  const w = (2 * Math.PI * f) / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) + 1e-30);
}

const fToX = (f: number, w: number) => (Math.log10(Math.max(MIN_FREQ, f) / MIN_FREQ) / Math.log10(MAX_FREQ / MIN_FREQ)) * w;
const xToF = (x: number, w: number) => MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, Math.max(0, Math.min(w, x)) / w);

/**
 * Écran de l'égaliseur : grille, spectre (après égalisation), courbe totale,
 * bande choisie en couleur, points des 12 bandes à glisser. Dessiné hors React :
 * fond et courbes sont préparés une fois (et recalculés quand les réglages ou
 * l'automation changent), seul le spectre suit le son à chaque image.
 */
const EqScreen: React.FC<{
  node: ProEQ12Node;
  params: ProEQ12Params;
  selected: number;
  range: number;
  onSelect: (i: number) => void;
  onBand: (i: number, patch: Partial<ProEQBand>) => void;
}> = ({ node, params, selected, range, onSelect, onBand }) => {
  const { wrapRef, canvasRef, size } = useHwCanvas();
  const latest = useRef({ params, selected, range, onSelect, onBand });
  latest.current = { params, selected, range, onSelect, onBand };
  const version = useRef(0);
  // Réglages changés : courbes à refaire (et pendant 300 ms, le temps des fondus du moteur).
  const dirtyUntil = useRef(0);
  useEffect(() => { version.current++; dirtyUntil.current = performance.now() + 320; }, [params, selected, range]);
  const help = useHwHelp('eq-screen', 'Écran de l’égaliseur', 'Glisse un point : gauche-droite = fréquence, haut-bas = gain (Maj = fin). Molette = largeur de la bande choisie. Double-clic sur un point = gain à 0 dB.', undefined);

  const geo = (h: number) => { const top = 10, bottom = h - 20; return { top, bottom, mid: (top + bottom) / 2 }; };
  const pointOf = (b: ProEQBand, w: number, h: number) => {
    const { top, mid } = geo(h);
    const r = latest.current.range;
    const g = b.type.includes('pass') ? 0 : Math.max(-r, Math.min(r, b.gain || 0));
    return { x: fToX(b.frequency, w), y: mid - (g / r) * (mid - top) };
  };

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !size.w || !node) return;
    const { w, h, dpr } = size;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    const bg = mk(), fg = mk();
    const { top, bottom, mid } = geo(h);
    const sr = node.postAnalyzer?.context?.sampleRate || 48000;
    const cols = Math.max(2, Math.floor(w / 2));
    const freqs = new Float32Array(cols);
    for (let i = 0; i < cols; i++) freqs[i] = xToF((i / (cols - 1)) * w, w);
    const bins = node.postAnalyzer?.frequencyBinCount || 2048;
    const spec = new Uint8Array(bins);
    const binHz = sr / 2 / bins;
    const binLo = new Int32Array(cols), binHi = new Int32Array(cols);
    for (let i = 0; i < cols; i++) {
      const f0 = xToF(((i - 0.5) / (cols - 1)) * w, w), f1 = xToF(((i + 0.5) / (cols - 1)) * w, w);
      binLo[i] = Math.max(1, Math.floor(f0 / binHz)); binHi[i] = Math.max(binLo[i], Math.min(bins - 1, Math.ceil(f1 / binHz)));
    }
    let bgRange = -1;
    let respPrev: Float32Array | null = null;
    let specSum = -1;
    let lastResp = 0;
    let drawnVersion = -1;

    const drawBg = (r: number) => {
      const c = bg.getContext('2d')!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);
      c.lineWidth = 1;
      c.font = '600 9.5px Inter, system-ui, sans-serif';
      c.textBaseline = 'alphabetic';
      for (const f of [30, 40, 50, 60, 70, 80, 90, 300, 400, 600, 700, 800, 900, 3000, 4000, 6000, 7000, 8000, 9000]) {
        const x = Math.round(fToX(f, w)) + 0.5;
        c.strokeStyle = 'rgba(255,255,255,0.035)'; c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
      }
      c.fillStyle = 'rgba(203,213,225,0.78)';
      for (const [f, t] of [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']] as [number, string][]) {
        const x = Math.round(fToX(f, w)) + 0.5;
        c.strokeStyle = 'rgba(255,255,255,0.08)'; c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
        c.textAlign = 'center'; c.fillText(t, x, h - 6);
      }
      const step = r <= 12 ? 3 : r <= 24 ? 6 : 10;
      c.textAlign = 'left';
      for (let d = -r; d <= r + 1e-6; d += step) {
        const y = Math.round(mid - (d / r) * (mid - top)) + 0.5;
        c.strokeStyle = d === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.06)';
        c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
        if (d !== 0 && Math.abs(d) < r) { c.fillStyle = 'rgba(203,213,225,0.7)'; c.fillText(`${d > 0 ? '+' : ''}${d}`, 4, y - 3); }
      }
      bgRange = r;
    };

    const drawFg = (resp: Float32Array) => {
      const { params: p, selected: sel, range: r } = latest.current;
      const c = fg.getContext('2d')!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);
      const yOf = (db: number) => mid - (Math.max(-r * 1.05, Math.min(r * 1.05, db)) / r) * (mid - top);
      // Bande choisie : sa propre courbe, remplie de sa couleur.
      const b = p.bands[sel];
      if (b && b.isEnabled !== false) {
        const col = bandColor(b, sel);
        c.beginPath(); c.moveTo(0, mid);
        for (let i = 0; i < cols; i++) c.lineTo((i / (cols - 1)) * w, yOf(bandResponseDb(b, freqs[i], sr)));
        c.lineTo(w, mid); c.closePath();
        c.globalAlpha = 0.22; c.fillStyle = col; c.fill(); c.globalAlpha = 1;
      }
      // Courbe totale (filtres réels du moteur : suit aussi l'automation).
      c.beginPath();
      for (let i = 0; i < cols; i++) {
        const y = yOf(20 * Math.log10(Math.max(resp[i], 1e-5)));
        if (i === 0) c.moveTo(0, y); else c.lineTo((i / (cols - 1)) * w, y);
      }
      c.strokeStyle = '#f8fafc'; c.lineWidth = 2.2; c.shadowColor = 'rgba(125,211,252,0.6)'; c.shadowBlur = 6; c.stroke(); c.shadowBlur = 0;
      // Points des bandes (la bande choisie au-dessus, plus grande).
      const order = p.bands.map((_, i) => i).filter(i => i !== sel).concat(sel);
      c.font = '800 9px Inter, system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      for (const i of order) {
        const bb = p.bands[i];
        if (!bb) continue;
        const { x, y } = pointOf(bb, w, h);
        const on = bb.isEnabled !== false;
        const col = bandColor(bb, i);
        const rad = i === sel ? 9.5 : 7.5;
        c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2);
        c.fillStyle = on ? col : '#3b4250'; c.fill();
        c.lineWidth = i === sel ? 2.5 : 1.2; c.strokeStyle = i === sel ? '#ffffff' : 'rgba(0,0,0,0.65)'; c.stroke();
        c.fillStyle = on ? '#0b0f17' : '#cbd5e1'; c.fillText(String(i + 1), x, y + 0.5);
      }
    };

    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const r = latest.current.range;
      let dirty = false;
      if (bgRange !== r) { drawBg(r); dirty = true; }
      const v = version.current;
      // Réponse réelle du moteur : à chaque réglage, pendant les fondus, puis 4 fois par seconde (automation).
      if (v !== drawnVersion || t < dirtyUntil.current || t - lastResp > 250) {
        lastResp = t;
        let resp: Float32Array;
        try { resp = node.getFrequencyResponse(freqs); } catch { resp = new Float32Array(cols).fill(1); }
        let same = !!respPrev && v === drawnVersion;
        if (same && respPrev) for (let i = 0; i < cols; i += 3) if (Math.abs(resp[i] - respPrev[i]) > 1e-4) { same = false; break; }
        if (!same) { drawFg(resp); respPrev = resp; dirty = true; }
        drawnVersion = v;
      }
      // Spectre : redessiné seulement s'il a bougé (silence = rien à faire).
      try { node.postAnalyzer.getByteFrequencyData(spec); } catch { spec.fill(0); }
      let sum = 0;
      for (let i = 1; i < bins; i += 7) sum += spec[i];
      if (sum !== specSum) { specSum = sum; dirty = true; }
      if (!dirty) return;
      const c = cv.getContext('2d');
      if (!c) return;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, W, H);
      c.drawImage(bg, 0, 0);
      if (sum > 0) {
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Spectre : −90 dB en bas, −10 dB en haut (son propre repère).
        const yS = (byte: number) => { const db = (byte / 255) * 70 - 100; return bottom - Math.max(0, Math.min(1, (db + 90) / 80)) * (bottom - top); };
        c.beginPath(); c.moveTo(0, bottom);
        for (let i = 0; i < cols; i++) {
          let m = 0;
          for (let k = binLo[i]; k <= binHi[i]; k++) if (spec[k] > m) m = spec[k];
          c.lineTo((i / (cols - 1)) * w, yS(m));
        }
        c.lineTo(w, bottom); c.closePath();
        const g = c.createLinearGradient(0, top, 0, bottom);
        g.addColorStop(0, 'rgba(125,211,252,0.32)'); g.addColorStop(1, 'rgba(125,211,252,0.04)');
        c.fillStyle = g; c.fill();
        c.strokeStyle = 'rgba(125,211,252,0.5)'; c.lineWidth = 1; c.stroke();
        c.setTransform(1, 0, 0, 1, 0, 0);
      }
      c.drawImage(fg, 0, 0);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [node, size]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Glisser un point (souris, doigt, stylet) ──
  const drag = useRef<{ id: number; idx: number; x: number; y: number; f: number; g: number } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };
  const nearest = (x: number, y: number, w: number, h: number, maxD: number) => {
    let best = -1, bd = maxD;
    latest.current.params.bands.forEach((b, i) => {
      const pt = pointOf(b, w, h);
      const d = Math.hypot(x - pt.x, y - pt.y);
      // À égalité, la bande choisie passe devant.
      if (d < bd || (d === bd && i === latest.current.selected)) { bd = d; best = i; }
    });
    return best;
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const { x, y, w, h } = local(e);
    const idx = nearest(x, y, w, h, e.pointerType === 'mouse' ? 22 : 32);
    help.show();
    if (idx < 0) return;
    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* déjà relâché */ }
    const b = latest.current.params.bands[idx];
    latest.current.onSelect(idx);
    drag.current = { id: e.pointerId, idx, x: e.clientX, y: e.clientY, f: b.frequency, g: b.gain || 0 };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    const { x, y, w, h } = local(e);
    if (!d || d.id !== e.pointerId) {
      if (e.pointerType === 'mouse') e.currentTarget.style.cursor = nearest(x, y, w, h, 22) >= 0 ? 'grab' : 'crosshair';
      return;
    }
    e.currentTarget.style.cursor = 'grabbing';
    const fine = e.shiftKey ? 0.2 : 1;
    const { top, mid } = geo(h);
    const r = latest.current.range;
    const frequency = Math.max(MIN_FREQ, Math.min(MAX_FREQ, xToF(fToX(d.f, w) + (e.clientX - d.x) * fine, w)));
    const band = latest.current.params.bands[d.idx];
    let gain = d.g + (((d.y - e.clientY) * fine) / (mid - top)) * r;
    gain = band.type.includes('pass') ? 0 : Math.max(MIN_GAIN, Math.min(MAX_GAIN, Math.round(gain * 10) / 10));
    if (e.shiftKey) { d.f = frequency; d.g = gain; d.x = e.clientX; d.y = e.clientY; }
    latest.current.onBand(d.idx, { frequency, gain });
  };
  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
    e.currentTarget.style.cursor = '';
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y, w, h } = local(e);
    const idx = nearest(x, y, w, h, 22);
    if (idx < 0) return;
    const b = latest.current.params.bands[idx];
    if (!noGain(b.type)) latest.current.onBand(idx, { gain: 0 });
  };
  // Molette : largeur (Q) de la bande choisie ; écouteur natif non passif (la page ne défile pas).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (w: WheelEvent) => {
      if (w.deltaY === 0) return;
      w.preventDefault();
      const { params: p, selected: s } = latest.current;
      const b = p.bands[s];
      if (!b) return;
      const k = w.shiftKey ? 1.03 : 1.12;
      const q = Math.max(0.1, Math.min(10, Math.round((w.deltaY < 0 ? b.q * k : b.q / k) * 100) / 100));
      if (q !== b.q) latest.current.onBand(s, { q });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [wrapRef]);

  const b = params.bands[selected];
  return (
    <div ref={wrapRef} className="relative h-full w-full" onPointerEnter={help.onPointerEnter} onPointerLeave={help.onPointerLeave}>
      <canvas ref={canvasRef} className="hw-screen-canvas touch-none" style={{ cursor: 'crosshair' }} data-nova-eq-screen
        aria-label="Courbe de l’égaliseur : glisse les points numérotés pour régler les bandes"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onDoubleClick={onDoubleClick} />
      {b && (
        <span className="hw-screen-label" style={{ left: 8, top: 7 }} aria-live="polite">
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 9, background: bandColor(b, selected), marginRight: 6 }} />
          Bande {selected + 1} · {(FILTER_LABELS[b.type] || { label: b.type }).label} · <b>{fmtHzFr(b.frequency)}</b>
          {!noGain(b.type) && <> · <b>{fmtGain(b.gain || 0)}</b></>}
          {b.isEnabled === false && <span style={{ color: '#fca5a5' }}> · coupée</span>}
        </span>
      )}
    </div>
  );
};

export const ProEQ12UI: React.FC<{ node: ProEQ12Node, initialParams: ProEQ12Params, onParamsChange?: (p: ProEQ12Params) => void }> = ({ node, initialParams, onParamsChange }) => {
  const [params, setParams] = useState<ProEQ12Params>(() => (initialParams && Array.isArray(initialParams.bands) && initialParams.bands.length
    ? initialParams : { ...DEFAULT_EQ, ...(initialParams || {}), bands: DEFAULT_EQ.bands.map(b => ({ ...b })) }));
  const paramsRef = useRef(params);
  const [sel, setSel] = useState(0);
  const [range, setRange] = useState(12);
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640;

  const commit = useCallback((next: ProEQ12Params) => {
    paramsRef.current = next;
    setParams(next);
    node.updateParams(next);
    onParamsChange?.(next);
  }, [node, onParamsChange]);

  const updateBand = useCallback((idx: number, updates: Partial<ProEQBand>) => {
    const cur = paramsRef.current;
    const bands = [...cur.bands];
    bands[idx] = { ...bands[idx], ...updates };
    commit({ ...cur, bands });
  }, [commit]);

  const band = params.bands[sel] || params.bands[0];
  const col = bandColor(band, sel);
  const gainless = noGain(band.type);
  const help = (label: string, h: string) => [h, termHelp(label)].filter(Boolean).join(' · ');
  const master = Number.isFinite(params.masterGain) ? params.masterGain : 1;

  return (
    <HwWindow type="PROEQ12" width={880} accent={EQ_ACCENT} accentInk="#04131c"
      idleHelp={<>Égaliseur paramétrique 12 bandes : retire ce qui gêne, ajoute de la présence ou de l’air. Glisse les points de l’écran, ou choisis une bande dessous et tourne ses boutons. <span style={{ color: '#7d8696' }}>Survole ou touche un réglage : son rôle s’affiche ici.</span></>}>
      <Faceplate finish="black" className="hw-finish-midnight" model="Égaliseur" kicker="Paramétrique · 12 bandes" modelStyle="wide" style={{ ['--hw-accent' as any]: EQ_ACCENT }}>
        <div className="hw-screen-tabs justify-end" role="group" aria-label="Échelle de l’écran">
          <span className="hw-silk hw-silk-soft mr-auto" style={{ textAlign: 'left' }}>Échelle</span>
          {[12, 30].map(r => (
            <button key={r} type="button" className="hw-screen-tab" aria-pressed={range === r} onClick={() => setRange(r)}
              title={r === 12 ? 'Écran zoomé : ±12 dB (corrections fines)' : 'Écran entier : ±30 dB'}>±{r} dB</button>
          ))}
        </div>
        <div className="hw-screen">
          <div className="hw-screen-glass" style={{ height: narrow ? 210 : 280 }}>
            <EqScreen node={node} params={params} selected={sel} range={range} onSelect={setSel} onBand={updateBand} />
          </div>
        </div>

        <div className="hw-bands mt-2.5" role="group" aria-label="Bandes">
          {params.bands.map((b, i) => (
            <button key={i} type="button" className="hw-band" aria-pressed={sel === i} data-off={b.isEnabled === false ? 'true' : undefined}
              style={{ ['--band' as any]: bandColor(b, i) }} onClick={() => setSel(i)}
              title={`Bande ${i + 1} : ${(FILTER_LABELS[b.type] || { label: b.type }).label}, ${Math.round(b.frequency)} Hz${b.isEnabled === false ? ' (coupée)' : ''}`} aria-label={`Bande ${i + 1}`}>
              <span className="flex items-center gap-1"><Led on={b.isEnabled !== false} color={bandColor(b, i)} />{i + 1}</span>
              <small>{shortHz(b.frequency)}</small>
            </button>
          ))}
        </div>

        <div className="hw-rule" style={{ margin: '12px 0 10px' }} />
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <HwSection title={`Bande ${sel + 1}`} className="flex-[4_1_460px] min-w-0"
            aside={<PushButton active={band.isEnabled !== false} onClick={() => updateBand(sel, { isEnabled: band.isEnabled === false })} text="Active" led={col} dark
              className="hw-push-sm" ariaLabel={`Bande ${sel + 1} active`} valueText={band.isEnabled !== false ? 'active' : 'coupée'}
              hint="Active ou coupe seulement cette bande (l’égaliseur entier se coupe avec le bouton de la barre du haut)." />}>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5" role="radiogroup" aria-label={`Type de filtre (bande ${sel + 1})`}>
              {TYPE_ORDER.map(t => (
                <PushButton key={t} role="radio" active={band.type === t} dark led={col} className="hw-push-icon" hint={FILTER_LABELS[t].help}
                  ariaLabel={FILTER_LABELS[t].label} valueText={band.type === t ? 'choisi' : undefined}
                  onClick={() => updateBand(sel, { type: t, gain: (t.includes('pass') || t === 'notch') ? 0 : band.gain })}>
                  <FilterIcon type={t} /><span>{FILTER_LABELS[t].label}</span>
                </PushButton>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-start justify-around gap-x-2 gap-y-2">
              <Knob key={`f${sel}`} paramId="frequency" label="Fréquence" size="L" cap="black" arc={col} min={MIN_FREQ} max={MAX_FREQ} curve="log" value={band.frequency}
                defaultValue={DEFAULT_FREQS[sel] ?? 1000} onChange={v => updateBand(sel, { frequency: v })} format={fmtHzFr}
                scale={[{ v: 20, label: '20' }, { v: 200, label: '200' }, { v: 2000, label: '2k' }, { v: 20000, label: '20k' }]}
                hint={help('Fréquence', 'Centre (ou point de coupure) de la bande.')} />
              <Knob key={`g${sel}`} paramId="gain" label="Gain" size="L" cap="black" arc={col} bipolar min={MIN_GAIN} max={MAX_GAIN} step={0.1} value={gainless ? 0 : band.gain}
                defaultValue={0} disabled={gainless} onChange={v => updateBand(sel, { gain: v })} format={v => (gainless ? '—' : fmtGain(v))}
                scale={[{ v: -30, label: '−30' }, { v: 0, label: '0' }, { v: 30, label: '+30' }]}
                hint={gainless ? 'Sans effet pour ce type de filtre (coupe-bas, coupe-haut, encoche).' : help('Gain', 'Monte (+) ou baisse (−) la zone de la bande.')} />
              <Knob key={`q${sel}`} paramId="q" label={band.type.includes('pass') ? 'Résonance' : 'Largeur'} size="M" cap="black" arc={col} min={0.1} max={10} curve="log" step={0.01}
                value={band.q} defaultValue={1} onChange={v => updateBand(sel, { q: v })} format={v => `Q ${frNum(v, 2)}`} ticks={11}
                hint={band.type.includes('pass') ? 'Bosse au point de coupure : plus la valeur est haute, plus la coupure résonne.' : help('Largeur', 'Petite valeur = zone large et douce, grande valeur = zone étroite et précise.')} />
            </div>
          </HwSection>
          <HwSection title="Sortie" className="flex-[1_1_140px] min-w-0">
            <div className="flex justify-center pt-1">
              <Knob paramId="masterGain" label="Volume" ariaLabel="Volume de sortie" size="M" cap="black" arc={EQ_ACCENT} bipolar min={0.25} max={4} curve="log"
                value={Math.max(0.25, Math.min(4, master))} defaultValue={1} onChange={v => commit({ ...paramsRef.current, masterGain: v })}
                format={v => gainDbFr(v)} scale={[{ v: 0.25, label: '−12' }, { v: 1, label: '0' }, { v: 4, label: '+12' }]}
                hint="Volume après l’égaliseur, pour comparer à volume égal (en dB)." />
            </div>
          </HwSection>
        </div>
      </Faceplate>
    </HwWindow>
  );
};
