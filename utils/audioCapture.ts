/**
 * Capture audio après coup (R3) — Flashback Capture de Logic (« Capture as
 * Recording »), la capture de Pro Tools 2023 et d'Ableton pour le MIDI, ici
 * pour la VOIX : quand une piste est armée et que la lecture tourne, NOVA garde
 * en mémoire les N dernières minutes du micro. « Capturer la dernière prise »
 * récupère ce qui vient d'être chanté sans avoir appuyé sur REC (un freestyle)
 * et le pose au bon endroit, latence compensée comme une prise normale.
 *
 * Ce module est pur (testable) : l'anneau d'échantillons (aussi utilisé dans
 * l'AudioWorklet, voir captureWorkletSource) et le choix du passage à capturer.
 */

/**
 * Anneau d'échantillons mono horodatés en n° d'échantillon du contexte audio.
 * L'écriture peut s'interrompre (lecture arrêtée) : chaque reprise ouvre un
 * segment, et une lecture ne renvoie jamais un mélange de deux segments.
 */
export class CaptureRing {
  buf: Float32Array;
  /** Échantillons écrits depuis le début (index absolu). */
  written = 0;
  /** Segments : premier n° d'échantillon du contexte et index absolu correspondant. */
  segs: { frame: number; k: number }[] = [];
  constructor(public capacity: number) { this.buf = new Float32Array(Math.max(128, capacity | 0)); this.capacity = this.buf.length; }

  write(x: Float32Array, frame: number) {
    const last = this.segs[this.segs.length - 1];
    if (!last || last.frame + (this.written - last.k) !== frame) this.segs.push({ frame, k: this.written });
    const cap = this.capacity;
    let p = this.written % cap;
    for (let i = 0; i < x.length; i++) { this.buf[p] = x[i]; p = p + 1 === cap ? 0 : p + 1; }
    this.written += x.length;
    // Segments entièrement écrasés : oubliés.
    const oldest = this.written - cap;
    while (this.segs.length > 1 && this.segs[1].k <= oldest) this.segs.shift();
    if (this.segs.length > 512) this.segs.splice(0, this.segs.length - 512);
  }

  /** Plus ancien n° d'échantillon encore en mémoire (ou null si vide). */
  oldestFrame(): number | null {
    if (!this.segs.length) return null;
    const oldest = Math.max(0, this.written - this.capacity);
    const s = this.segs[0];
    return s.frame + Math.max(0, oldest - s.k);
  }

  /** Dernier n° d'échantillon écrit + 1 (ou null). */
  endFrame(): number | null {
    const s = this.segs[this.segs.length - 1];
    return s ? s.frame + (this.written - s.k) : null;
  }

  /**
   * Échantillons de [fromFrame, toFrame[ du segment le plus récent qui touche la
   * plage, limités à ce qui est encore en mémoire. Null si rien.
   */
  read(fromFrame: number, toFrame: number): { samples: Float32Array; firstFrame: number } | null {
    const oldestK = Math.max(0, this.written - this.capacity);
    for (let i = this.segs.length - 1; i >= 0; i--) {
      const s = this.segs[i];
      const segEndK = i + 1 < this.segs.length ? this.segs[i + 1].k : this.written;
      const segStartK = Math.max(s.k, oldestK);
      const segStartF = s.frame + (segStartK - s.k);
      const segEndF = s.frame + (segEndK - s.k);
      const a = Math.max(fromFrame, segStartF), b = Math.min(toFrame, segEndF);
      if (b <= a) continue;
      const n = b - a;
      const out = new Float32Array(n);
      const cap = this.capacity;
      let p = (s.k + (a - s.frame)) % cap;
      for (let j = 0; j < n; j++) { out[j] = this.buf[p]; p = p + 1 === cap ? 0 : p + 1; }
      return { samples: out, firstFrame: a };
    }
    return null;
  }
}

/** Un passage de lecture : du contexte `from` à `to` (null = en cours), le morceau commençant à `startTime`. */
export interface PlayRun {
  from: number; to: number | null; startTime: number;
  /** Latences mesurées pendant le passage (s) : la capture est recalée comme une prise (moyenne). */
  lat?: number[];
}

/**
 * Passage à capturer : le dernier passage d'au moins `minSec` (un tour de
 * boucle trop court juste avant l'arrêt est ignoré), limité à ce que l'anneau
 * garde encore. Renvoie la plage en temps du contexte et le début dans le morceau.
 */
export function chooseCapture(runs: PlayRun[], now: number, oldestCtx: number | null, minSec = 0.5): { from: number; to: number; songTime: number } | null {
  if (oldestCtx === null) return null;
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    const to = r.to ?? now;
    const from = Math.max(r.from, oldestCtx);
    if (to - from < minSec) continue;
    return { from, to, songTime: from - r.startTime };
  }
  return null;
}

/** Durée gardée (minutes) : réglage de l'appareil, 5 par défaut, 2 au plus sur téléphone (mémoire). */
export const CAPTURE_MINUTES_KEY = 'nova_flashback_min';
export function captureMinutes(): number {
  let v = 5;
  try { const s = Number(localStorage.getItem(CAPTURE_MINUTES_KEY)); if (s > 0) v = s; } catch { /* défaut */ }
  const phone = typeof window !== 'undefined' && (window.innerWidth < 640 || /iPhone|Android.+Mobile/i.test(navigator.userAgent || ''));
  return Math.max(0.5, Math.min(phone ? 2 : 10, v));
}

/** Code de l'AudioWorklet : le même anneau que ci-dessus (une seule implémentation, testée). */
export function captureWorkletSource(): string {
  return `const CaptureRing = (${CaptureRing.toString()});
class NovaFlashback extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.ring = new CaptureRing(Math.max(128, (opts.processorOptions && opts.processorOptions.capacity) || 48000 * 300));
    this.on = false;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'on') this.on = true;
      else if (m.type === 'off') this.on = false;
      else if (m.type === 'read') {
        const r = this.ring.read(m.from, m.to);
        this.port.postMessage({ type: 'data', id: m.id, samples: r ? r.samples : null, firstFrame: r ? r.firstFrame : -1, oldest: this.ring.oldestFrame() }, r ? [r.samples.buffer] : []);
      } else if (m.type === 'info') this.port.postMessage({ type: 'info', id: m.id, oldest: this.ring.oldestFrame(), end: this.ring.endFrame() });
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0];
    if (this.on && inp && inp.length) {
      const len = inp[0].length;
      const x = new Float32Array(len);
      for (let i = 0; i < len; i++) { let v = 0; for (let c = 0; c < inp.length; c++) v += inp[c][i]; x[i] = inp.length > 1 ? v / inp.length : v; }
      this.ring.write(x, currentFrame);
    }
    const out = outputs[0];
    if (out) for (const c of out) c.fill(0);
    return true;
  }
}
registerProcessor('nova-flashback', NovaFlashback);
`;
}
