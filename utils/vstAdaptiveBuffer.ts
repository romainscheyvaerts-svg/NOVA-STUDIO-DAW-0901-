/**
 * Tampon adaptatif des effets VST3 du pont (C6, « silence du pont VST »).
 *
 * Un effet VST passe par le pont : chaque bloc de 128 échantillons part au pont et revient
 * traité. Le worklet (public/worklets/vst-bridge-processor-v6.js) garde une avance fixe
 * (pré-tampon) ; un bloc revenu trop tard était rendu en SILENCE, sans rien dire.
 *
 * Désormais :
 *  - le worklet compte les blocs manqués et les coupures (suites de blocs manqués) ;
 *  - un bloc manquant n'est plus perdu : la sortie l'ATTEND, le tampon passe au palier
 *    suivant (2048 → 3072 → 4096 → 6144 → 8192 échantillons, plafond) ; le moteur décale
 *    la compensation de latence (PDC) et le transport d'autant : les pistes restent calées ;
 *  - ici (thread principal) : coupures des 10 dernières secondes (alerte), et descente du
 *    tampon quand tout va bien — seulement transport ARRÊTÉ (rien ne bouge en pleine écoute),
 *    après VST_SHRINK_CALM_S secondes de flux sans coupure, au palier qui couvre l'âge des
 *    retours réellement mesuré (avec une marge).
 */

/** Pré-tampon de base, en échantillons : absorbe les à-coups du pont sans craquement. */
export const VST_PREBUFFER_FRAMES = 2048;
/** Plafond du tampon adaptatif (≈ 171 ms à 48 kHz, 186 ms à 44,1 kHz). */
export const VST_PREBUFFER_MAX_FRAMES = 8192;
/** Paliers, en multiples du pré-tampon de base (même liste dans le worklet). */
export const VST_ADAPT_STEPS = [1, 1.5, 2, 3, 4];
/** Fenêtre de l'alerte « N coupures en 10 s ». */
export const VST_LATE_WINDOW_MS = 10_000;
/** Secondes de flux sans aucune coupure avant de redescendre (transport arrêté). */
export const VST_SHRINK_CALM_S = 15;
/** Marge gardée au-dessus de l'âge maximal mesuré des retours du pont. */
export const VST_SHRINK_MARGIN_FRAMES = 512;
/** Au plus une alerte par effet toutes les… */
export const VST_ALERT_EVERY_MS = 4_000;

const BLOCK = 128;
const toBlocks = (frames: number) => Math.round(frames / BLOCK);

/** Paliers du tampon (échantillons), du pré-tampon de base au plafond. */
export function prebufferSteps(base = VST_PREBUFFER_FRAMES, max = VST_PREBUFFER_MAX_FRAMES): number[] {
  const b = toBlocks(base), m = Math.max(b, toBlocks(max));
  const out: number[] = [];
  for (const k of VST_ADAPT_STEPS) { const s = Math.min(Math.round(b * k), m); if (!out.includes(s)) out.push(s); }
  if (!out.includes(m)) out.push(m);
  return out.map(x => x * BLOCK);
}

/** Palier au-dessus de `cur` (plafonné). */
export function nextPrebufferStep(cur: number, base = VST_PREBUFFER_FRAMES, max = VST_PREBUFFER_MAX_FRAMES): number {
  const steps = prebufferSteps(base, max);
  return steps.find(s => s > cur) ?? steps[steps.length - 1];
}

/**
 * Palier visé pour redescendre : le plus petit qui couvre l'âge maximal des retours mesuré
 * (plus la marge), jamais sous la base, jamais au-dessus du palier actuel.
 */
export function shrinkTarget(cur: number, ageMaxFrames: number, base = VST_PREBUFFER_FRAMES, max = VST_PREBUFFER_MAX_FRAMES): number {
  const need = Math.max(0, ageMaxFrames) + VST_SHRINK_MARGIN_FRAMES;
  const fit = prebufferSteps(base, max).find(s => s >= need) ?? max;
  return Math.max(base, Math.min(cur, fit));
}

/** Statistiques envoyées par le worklet (≈ toutes les secondes). */
export interface VstBridgeStats {
  seq: number;
  underruns: number;
  dropouts: number;
  late: number;
  grows: number;
  delayFrames: number;
  delayId: number;
  ageMaxFrames: number;
  recvPeriod: number;
}

/** Ce que l'interface montre (fenêtre de l'effet, pastille de l'insert, alerte). */
export interface VstLateState {
  /** Coupures des 10 dernières secondes. */
  dropouts10s: number;
  /** Coupures depuis le chargement. */
  dropoutsTotal: number;
  /** Tampon actuel (échantillons). */
  prebufferFrames: number;
  /** Tampon agrandi au-dessus de la base. */
  grown: boolean;
  /** Tampon au plafond (le pont est trop lent même avec la marge maximale). */
  atMax: boolean;
  /** Le tampon s'adapte (sinon : avance fixe). */
  adaptive: boolean;
}

/**
 * Logique du thread principal, sans Web Audio (testée par vitest) : suit le tampon du worklet,
 * compte les coupures sur 10 s, décide de la descente.
 */
export class VstAdaptiveController {
  readonly base: number;
  readonly max: number;
  readonly sampleRate: number;
  prebuffer: number;
  private drops: { t: number; n: number }[] = [];
  private lastDropouts = 0;
  private lastSeq = -1;
  dropoutsTotal = 0;
  /** Secondes de flux (des retours reçus) sans coupure depuis la dernière coupure ou le dernier changement. */
  calmS = 0;
  /** Périodes de flux récentes (durée, âge maximal des retours) : fenêtre glissante de la descente. */
  private recent: { s: number; age: number }[] = [];
  /** Dernier ordre de tampon envoyé au worklet (id) : ses stats ne valent qu'une fois appliqué. */
  private sentId = 0;
  private lastAlertAt = -Infinity;

  constructor(opts: { base?: number; max?: number; sampleRate?: number } = {}) {
    this.base = opts.base ?? VST_PREBUFFER_FRAMES;
    this.max = Math.max(this.base, opts.max ?? VST_PREBUFFER_MAX_FRAMES);
    this.sampleRate = opts.sampleRate || 48000;
    this.prebuffer = this.base;
  }

  get adaptive(): boolean { return this.max > this.base; }

  /** Le worklet a agrandi son tampon ({ type: 'delay', frames }). Renvoie true si ça change la latence. */
  onGrow(frames: number): boolean {
    const f = Math.max(this.base, Math.min(this.max, Math.round(frames)));
    this.resetCalm();
    if (f === this.prebuffer) return false;
    this.prebuffer = f;
    return true;
  }

  /** Statistiques du worklet. Renvoie true si le tampon connu a changé (latence à refaire). */
  onStats(st: Partial<VstBridgeStats>, now: number): boolean {
    const d = Number(st.dropouts) || 0;
    const delta = Math.max(0, d - this.lastDropouts);
    this.lastDropouts = d;
    const seq = Number(st.seq) || 0;
    const periodS = this.lastSeq >= 0 && seq > this.lastSeq ? ((seq - this.lastSeq) * BLOCK) / this.sampleRate : 0;
    this.lastSeq = seq;
    if (delta > 0) {
      this.drops.push({ t: now, n: delta });
      this.dropoutsTotal += delta;
      this.resetCalm();
    } else if ((Number(st.recvPeriod) || 0) > 0 && periodS > 0) {
      this.calmS += periodS;
      this.recent.push({ s: periodS, age: Number(st.ageMaxFrames) || 0 });
      // Seules les VST_SHRINK_CALM_S dernières secondes de flux comptent (pont redevenu rapide).
      let tot = this.recent.reduce((a, x) => a + x.s, 0);
      while (this.recent.length > 1 && tot - this.recent[0].s >= VST_SHRINK_CALM_S) tot -= this.recent.shift()!.s;
    }
    this.prune(now);
    // Le worklet est la référence pour son tampon (une fois notre dernier ordre appliqué).
    const frames = Number(st.delayFrames);
    if (Number(st.delayId ?? 0) === this.sentId && Number.isFinite(frames) && frames > 0) {
      const f = Math.max(2 * BLOCK, Math.min(this.max, Math.round(frames)));
      if (f !== this.prebuffer) { this.prebuffer = f; return true; }
    }
    return false;
  }

  /** Âge maximal des retours sur la fenêtre glissante (échantillons). */
  get calmAgeMax(): number { return this.recent.reduce((m, x) => Math.max(m, x.age), 0); }

  private resetCalm() {
    this.calmS = 0;
    this.recent = [];
  }

  private prune(now: number) {
    while (this.drops.length && now - this.drops[0].t > VST_LATE_WINDOW_MS) this.drops.shift();
  }

  dropouts10s(now: number): number {
    this.prune(now);
    return this.drops.reduce((s, x) => s + x.n, 0);
  }

  /**
   * Descente : transport arrêté, tampon agrandi, VST_SHRINK_CALM_S s de flux sans coupure.
   * Renvoie l'ordre à envoyer au worklet ({ frames, id }) ou null.
   */
  shrink(transportPlaying: boolean): { frames: number; id: number } | null {
    if (transportPlaying || this.prebuffer <= this.base || this.calmS < VST_SHRINK_CALM_S) return null;
    const target = shrinkTarget(this.prebuffer, this.calmAgeMax, this.base, this.max);
    if (target >= this.prebuffer) return null;
    this.prebuffer = target;
    this.resetCalm();
    return { frames: target, id: ++this.sentId };
  }

  /** Retour immédiat à la base (bouton « Revenir au tampon normal »). */
  resetToBase(): { frames: number; id: number } | null {
    if (this.prebuffer === this.base) return null;
    this.prebuffer = this.base;
    this.resetCalm();
    return { frames: this.base, id: ++this.sentId };
  }

  /** Alerte à afficher maintenant ? (coupures récentes, au plus une toutes les VST_ALERT_EVERY_MS). */
  alertDue(now: number, force = false): boolean {
    if (this.dropouts10s(now) <= 0) return false;
    if (!force && now - this.lastAlertAt < VST_ALERT_EVERY_MS) return false;
    this.lastAlertAt = now;
    return true;
  }

  state(now: number): VstLateState {
    return {
      dropouts10s: this.dropouts10s(now), dropoutsTotal: this.dropoutsTotal,
      prebufferFrames: this.prebuffer, grown: this.prebuffer > this.base, atMax: this.adaptive && this.prebuffer >= this.max,
      adaptive: this.adaptive,
    };
  }
}

/** « 12 coupures », « 1 coupure ». */
export const coupures = (n: number) => `${n} coupure${n > 1 ? 's' : ''}`;

/** Message de l'alerte, prêt à afficher. */
export function vstLateMessage(name: string, st: VstLateState, sampleRate: number): string {
  const ms = Math.round((st.prebufferFrames / (sampleRate || 48000)) * 1000);
  const head = `Le plugin ${name} a pris du retard : ${coupures(st.dropouts10s)} en 10 s.`;
  if (!st.adaptive) return `${head} Ferme les programmes inutiles ou gèle la piste.`;
  if (st.atMax) return `${head} Tampon agrandi au maximum (${ms} ms), retard compensé. Si ça coupe encore, gèle la piste.`;
  if (st.grown) return `${head} Tampon agrandi à ${ms} ms, retard compensé : la piste reste calée.`;
  return head;
}

/** Réglage « tampon adaptatif » (activé par défaut ; « 0 » = avance fixe, comportement d'avant). */
const ADAPTIVE_KEY = 'nova.vst.adaptiveBuffer';
export function vstAdaptiveEnabled(): boolean {
  try { return typeof localStorage === 'undefined' || localStorage.getItem(ADAPTIVE_KEY) !== '0'; } catch { return true; }
}
export function setVstAdaptiveEnabled(on: boolean) {
  try { if (on) localStorage.removeItem(ADAPTIVE_KEY); else localStorage.setItem(ADAPTIVE_KEY, '0'); } catch { /* stockage indisponible */ }
}
