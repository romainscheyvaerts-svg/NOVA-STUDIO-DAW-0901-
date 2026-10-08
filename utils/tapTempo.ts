/**
 * Tap tempo (R2) : taper le tempo d'une prod (touche T comme dans le champ
 * tempo de Pro Tools, bouton TAP de Logic, d'Ableton et de FL, ou au doigt).
 *
 * Moyenne des derniers intervalles (8 au plus), en écartant les tapes ratées
 * (plus de 30 % d'écart avec la médiane) ; une pause de 2 s recommence.
 */
export const TAP_RESET_MS = 2000;
export const TAP_MAX = 8;

export class TapTempo {
  private taps: number[] = [];

  /** Enregistre une tape (horodatage en ms). Renvoie le tempo (BPM, 0,1 près) dès la 2e tape. */
  tap(nowMs: number): number | null {
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && (nowMs - last > TAP_RESET_MS || nowMs <= last)) this.taps = [];
    this.taps.push(nowMs);
    if (this.taps.length > TAP_MAX + 1) this.taps = this.taps.slice(-(TAP_MAX + 1));
    return this.bpm();
  }

  bpm(): number | null {
    if (this.taps.length < 2) return null;
    const iv: number[] = [];
    for (let i = 1; i < this.taps.length; i++) iv.push(this.taps[i] - this.taps[i - 1]);
    const sorted = [...iv].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const kept = iv.filter(x => Math.abs(x - med) <= med * 0.3);
    const avg = (kept.length ? kept : iv).reduce((a, b) => a + b, 0) / (kept.length || iv.length);
    const bpm = 60000 / avg;
    if (!(bpm >= 30 && bpm <= 300)) return null;
    return Math.round(bpm * 10) / 10;
  }

  /** Nombre de tapes en cours (pour l'affichage « tape encore »). */
  count(): number { return this.taps.length; }
  reset() { this.taps = []; }
}

/** Tempo proposé à l'arrondi : entier si la tape tombe à ±0,15 d'un entier. */
export const roundTapped = (bpm: number): number => (Math.abs(bpm - Math.round(bpm)) <= 0.15 ? Math.round(bpm) : bpm);

/** Instance partagée (touche T, bouton TAP de la barre, fenêtre Tempo). */
export const sharedTap = new TapTempo();
