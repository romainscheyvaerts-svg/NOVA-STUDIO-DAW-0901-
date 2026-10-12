/**
 * Veille automatique des effets silencieux (chantier 13 : séances de 64 à 128 pistes).
 *
 * Une piste audio dont rien n'entre depuis un moment, et dont la chaîne d'effets a fini
 * de sonner, cesse de calculer ses effets : la chaîne est décâblée de la piste (entrée
 * ET sortie). Chrome ne calcule plus aucun de ses nœuds (filtres, worklets, gains) ;
 * l'état de chaque effet reste figé tel quel, c'est-à-dire AU REPOS.
 * Elle se réveille avant le prochain son : le moteur rebranche la chaîne juste avant de
 * câbler une source (clip, scrub), dans la même tâche. Comme l'état figé est celui du
 * repos, le réveil est sans clic et sans perte.
 *
 * Quand une chaîne est-elle « au repos » ? Toutes les conditions, en même temps :
 *  1. rien n'entre : aucune source en cours ou programmée sur la piste, la dernière est
 *     finie depuis au moins QUIET_S + la latence de la chaîne ;
 *  2. la sortie de la chaîne est muette (sous QUIET_LEVEL, −240 dBFS) depuis aussi longtemps :
 *     sentinelle AudioWorklet (une pour 16 pistes) branchée sur la sortie de chaque chaîne ;
 *     les filtres, retards et réverbérations internes ont donc fini leur queue ;
 *  3. chaque effet à état (compresseur, de-esser, saturation) déclare son cœur au repos
 *     (enveloppes, détecteurs, mémoires à zéro : voir `isAtRest()` de chaque effet) ;
 *  4. la piste est éligible : piste audio non gelée, non armée, sans clé de side-chain,
 *     sans automation d'effet, que des effets de la liste SLEEP_SAFE (pas de LFO calé sur
 *     le morceau, pas de VST), et aucun son n'arrive dans la seconde (clips à venir).
 *
 * Ce qui reste exact : ce qui sort d'une chaîne au repos est le silence (les seuls restes
 * sont des résidus numériques sous −240 dBFS de certains filtres) ; au réveil, chaque
 * cœur reprend depuis l'état de repos qu'il aurait eu sans la veille. Le compresseur
 * rattrape lui-même la décharge de sa « charge » (release dépendant du programme) pour les
 * échantillons sautés (currentFrame). L'export hors ligne n'a pas de veille.
 *
 * Désactivable : localStorage « nova_veille » = « 0 » ou audioEngine.setEffectSleep(false).
 */

/** Effets qui savent dormir : aucun LFO, aucun pont, état « au repos » déclaré ou purement linéaire. */
export const SLEEP_SAFE = new Set(['PROEQ12', 'COMPRESSOR', 'DEESSER', 'VOCALSATURATOR']);
/** Niveau « muet » de la sentinelle (≈ −240 dBFS) : sous ce niveau, aucun format de fichier ne le voit. */
export const QUIET_LEVEL = 1e-12;
/** Silence minimal avant la mise en veille (s), latence de la chaîne en plus. */
export const QUIET_S = 0.15;
/** Pas de mise en veille si un clip commence dans moins de ce délai (s) : évite les va-et-vient. */
export const AHEAD_S = 0.5;
const SLOTS = 16;

export interface SleepChain {
  /** Nœud de tête (entrée de piste ou tranche) et premier nœud de la chaîne. */
  start: AudioNode; first: AudioNode;
  /** Dernier nœud de la chaîne et sortie de chaîne (chainOut). */
  end: AudioNode; out: AudioNode;
  /** Instances d'effets de la chaîne (isAtRest / setSleeping facultatifs). */
  instances: any[];
  /** Latence totale de la chaîne (s). */
  latency: number;
}

export interface SleepHost {
  ctx(): BaseAudioContext | null;
  /** Pistes vivantes candidates (ids). */
  trackIds(): string[];
  /** Chaîne câblée d'une piste, ou null (pas d'effet, piste gelée…). */
  chainOf(trackId: string): SleepChain | null;
  /** Éligibilité (type, gel, armement, side-chain, automation d'effet, routage entrant). */
  eligible(trackId: string): boolean;
  /** Instant (horloge du contexte) jusqu'auquel une source occupe la piste ; +Infinity si une source tourne. */
  inputBusyUntil(trackId: string): number;
  /** Délai (s) avant le prochain clip de la piste (Infinity si aucun / à l'arrêt). */
  nextActivityIn(trackId: string): number;
}

interface TrackSleep {
  asleep: boolean;
  chain: SleepChain | null;
  slot: { bank: number; idx: number } | null;
  /** Sortie muette depuis (horloge du contexte), null si elle sonne. */
  quietSince: number | null;
}

export interface SleepStats { enabled: boolean; eligible: number; asleep: number; tracks: number; sleeps: number; wakes: number; asleepIds: string[] }

const SENTINEL_CODE = `
class NovaVeilleSentinel extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.level = o.level || 1e-12;
    this.minQ = o.minQuiet || 4096;
    this.quiet = new Float64Array(${SLOTS});
    this.flag = new Uint8Array(${SLOTS});
    this.port.onmessage = (e) => { const d = e.data || {}; if (typeof d.reset === 'number') { this.quiet[d.reset] = 0; this.flag[d.reset] = 0; } };
  }
  process(inputs) {
    const L = this.level;
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      let loud = false, n = 128;
      if (inp && inp.length) {
        for (let c = 0; c < inp.length && !loud; c++) {
          const x = inp[c]; n = x.length;
          for (let k = 0; k < x.length; k++) { const v = x[k]; if (v > L || v < -L) { loud = true; break; } }
        }
      }
      if (loud) {
        this.quiet[i] = 0;
        if (this.flag[i]) { this.flag[i] = 0; this.port.postMessage({ s: i, q: 0 }); }
      } else {
        this.quiet[i] += n;
        if (!this.flag[i] && this.quiet[i] >= this.minQ) { this.flag[i] = 1; this.port.postMessage({ s: i, q: 1, t: currentTime + n / sampleRate - this.quiet[i] / sampleRate }); }
      }
    }
    return true;
  }
}
try { registerProcessor('nova-veille-sentinel', NovaVeilleSentinel); } catch (e) {}
`;

export class EffectSleepManager {
  private host: SleepHost;
  private state = new Map<string, TrackSleep>();
  private banks: { node: AudioWorkletNode; used: (string | null)[] }[] = [];
  private moduleReady: Promise<boolean> | null = null;
  private moduleOk = false;
  private timer: any = null;
  private enabled = true;
  private sleeps = 0;
  private wakes = 0;
  private ctxRef: BaseAudioContext | null = null;

  constructor(host: SleepHost) {
    this.host = host;
    try { if (typeof localStorage !== 'undefined' && localStorage.getItem('nova_veille') === '0') this.enabled = false; } catch { /* stockage indisponible */ }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.wakeAll();
  }
  isEnabled() { return this.enabled; }

  /** Démarre la surveillance (après la création du contexte). */
  start() {
    const ctx = this.host.ctx();
    if (!ctx || this.timer) return;
    this.ensureModule(ctx);
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { /* une erreur ne doit jamais bloquer le moteur */ } }, 100);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.wakeAll();
  }

  private ensureModule(ctx: BaseAudioContext): Promise<boolean> {
    if (this.moduleReady && this.ctxRef === ctx) return this.moduleReady;
    this.ctxRef = ctx;
    this.banks = [];
    this.moduleReady = (async () => {
      try {
        const url = URL.createObjectURL(new Blob([SENTINEL_CODE], { type: 'text/javascript' }));
        await ctx.audioWorklet.addModule(url);
        this.moduleOk = true;
      } catch (e) {
        console.warn('[NOVA veille] sentinelle indisponible : veille désactivée', e);
        this.moduleOk = false;
      }
      return this.moduleOk;
    })();
    return this.moduleReady;
  }

  private stateOf(id: string): TrackSleep {
    let s = this.state.get(id);
    if (!s) { s = { asleep: false, chain: null, slot: null, quietSince: null }; this.state.set(id, s); }
    return s;
  }

  /** Sentinelle branchée sur la sortie de chaîne (appelé après chaque câblage de piste). */
  attach(trackId: string, chainOut: AudioNode | null) {
    const ctx = this.host.ctx();
    if (!ctx || !chainOut || !this.moduleOk) return;
    const s = this.stateOf(trackId);
    if (s.slot) return;
    let bi = this.banks.findIndex(b => b.used.some(u => u === null));
    if (bi < 0) {
      try {
        const node = new AudioWorkletNode(ctx, 'nova-veille-sentinel', {
          numberOfInputs: SLOTS, numberOfOutputs: 0,
          processorOptions: { level: QUIET_LEVEL, minQuiet: Math.round(0.1 * ctx.sampleRate) },
        });
        const b = { node, used: new Array(SLOTS).fill(null) as (string | null)[] };
        const index = this.banks.length;
        node.port.onmessage = (e) => this.onSentinel(index, e.data);
        this.banks.push(b);
        bi = index;
      } catch { return; }
    }
    const bank = this.banks[bi];
    const idx = bank.used.indexOf(null);
    bank.used[idx] = trackId;
    bank.node.port.postMessage({ reset: idx });
    try { chainOut.connect(bank.node, 0, idx); } catch { bank.used[idx] = null; return; }
    s.slot = { bank: bi, idx };
    s.quietSince = null;
  }

  private onSentinel(bank: number, d: any) {
    const id = this.banks[bank]?.used[d?.s];
    if (!id) return;
    const s = this.state.get(id);
    if (!s) return;
    s.quietSince = d.q ? (typeof d.t === 'number' ? d.t : null) : null;
  }

  /** Piste supprimée : sentinelle libérée, chaîne rebranchée si elle dormait. */
  detach(trackId: string, chainOut?: AudioNode | null) {
    const s = this.state.get(trackId);
    if (!s) return;
    if (s.asleep) this.wake(trackId);
    if (s.slot) {
      const b = this.banks[s.slot.bank];
      if (b) {
        try { if (chainOut) chainOut.disconnect(b.node); } catch { /* déjà décâblée */ }
        b.used[s.slot.idx] = null;
      }
    }
    this.state.delete(trackId);
  }

  /**
   * Réveil : la chaîne est rebranchée (entrée et sortie). Appelé par le moteur AVANT de
   * câbler une source sur la piste et avant tout recâblage. Sans effet si elle ne dort pas.
   */
  wake(trackId: string): boolean {
    const s = this.state.get(trackId);
    if (!s || !s.asleep) return false;
    const c = s.chain;
    s.asleep = false;
    s.chain = null;
    this.wakes++;
    if (!c) return true;
    for (const inst of c.instances) { try { inst?.setSleeping?.(false); } catch { /* */ } }
    try { c.end.connect(c.out); } catch { /* */ }
    try { c.start.connect(c.first); } catch { /* */ }
    return true;
  }

  isAsleep(trackId: string) { return !!this.state.get(trackId)?.asleep; }

  wakeAll() { for (const id of Array.from(this.state.keys())) this.wake(id); }

  private sleep(trackId: string, c: SleepChain) {
    const s = this.stateOf(trackId);
    // Ordre : tête d'abord (plus rien n'entre), puis la sortie, puis les prises internes.
    try { c.start.disconnect(c.first); } catch { return; }
    try { c.end.disconnect(c.out); } catch { try { c.start.connect(c.first); } catch { /* */ } return; }
    for (const inst of c.instances) { try { inst?.setSleeping?.(true); } catch { /* */ } }
    s.asleep = true;
    s.chain = c;
    this.sleeps++;
  }

  /** Une passe de décision (toutes les 100 ms). Publique pour les tests. */
  tick() {
    const ctx = this.host.ctx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const ids = this.host.trackIds();
    const alive = new Set(ids);
    for (const id of Array.from(this.state.keys())) if (!alive.has(id)) this.detach(id);
    if (!this.enabled || ctx.state !== 'running') return;
    for (const id of ids) {
      const s = this.stateOf(id);
      if (s.asleep) {
        if (!this.host.eligible(id)) this.wake(id);
        continue;
      }
      if (!this.host.eligible(id)) continue;
      const c = this.host.chainOf(id);
      if (!c || !c.instances.length) continue;
      // Sentinelle posée à la première passe où la piste est éligible (module chargé).
      if (!s.slot) { this.attach(id, c.out); continue; }
      if (s.quietSince === null) continue;
      const need = QUIET_S + Math.max(0, c.latency || 0);
      if (now - s.quietSince < need) continue;
      const busy = this.host.inputBusyUntil(id);
      if (now - busy < need) continue;
      if (this.host.nextActivityIn(id) < AHEAD_S) continue;
      if (!c.instances.every(i => typeof i?.isAtRest !== 'function' || i.isAtRest())) continue;
      this.sleep(id, c);
    }
  }

  stats(): SleepStats {
    let eligible = 0, asleep = 0;
    const asleepIds: string[] = [];
    for (const id of this.host.trackIds()) {
      const s = this.state.get(id);
      if (s?.asleep) { asleep++; asleepIds.push(id); }
      try { if (this.host.eligible(id)) eligible++; } catch { /* */ }
    }
    return { enabled: this.enabled, eligible, asleep, tracks: this.host.trackIds().length, sleeps: this.sleeps, wakes: this.wakes, asleepIds };
  }
}
