/**
 * Veille du moteur audio à l'arrêt (audit de nuit, 22/10/2026).
 *
 * Mesuré (qa/audit_nuit.py, cas « veille », processus du navigateur) : projet « Nouveau beat »
 * transport ARRÊTÉ, rien ne sonne : 33 à 41 % d'un cœur pour calculer du silence (réverbes et écho
 * des envois, chaînes d'effets tenues actives par engine/keepAlive pour que lecture = export) ;
 * le même projet, contexte suspendu : 2,5 %. Un PC portable chauffait et se vidait pour rien.
 *
 * Règle : le contexte n'est suspendu que si, depuis IDLE_MS (page cachée) ou VISIBLE_IDLE_MS (page au
 * premier plan), il n'y a eu AUCUN geste (pointeur,
 * clavier, molette, doigt), AUCUN son (toute source démarrée sur le contexte, même par une fenêtre
 * qui le prend directement : pré-écoute, Master rapide, référence…), et si rien n'a besoin du son en
 * continu (le moteur le dit : lecture, prise, piste armée, écoute de l'entrée, talkback, ASIO, écoute
 * à distance, notes tenues, pré-écoute ; l'appli aussi : collaboration ; un flux micro ou un élément
 * vidéo branchés et vivants ; une fenêtre d'instrument ouverte : batterie, piano roll).
 * Il repart au premier geste, à la première source démarrée (le départ attend la reprise : rien
 * n'est perdu, le son part quelques millisecondes plus tard) et à chaque commande du moteur qui
 * produit du son (lecture, prise, notes, pré-écoute, scrub). Ce qui sortait était déjà du silence :
 * la veille ne change rien à ce qu'on entend, ni à l'export (hors ligne, sans veille).
 *
 * Désactivable : localStorage « nova_veille_moteur » = « 0 ».
 */

/** Calme demandé avant la veille, page CACHÉE (fenêtre réduite, autre onglet) (ms). */
export const IDLE_MS = 20_000;
/**
 * Calme demandé avant la veille, page VISIBLE (ms) : 5 min. Prudence (batterie QA du 22/10/2026) : sous
 * forte charge, Chrome headless a signalé des erreurs du périphérique audio en reprenant un contexte
 * suspendu ; au premier plan, on ne suspend donc qu'après un long moment sans rien faire.
 * Réglable (tests, réglage avancé) : localStorage « nova_veille_moteur_s » = secondes (les deux cas).
 */
export const VISIBLE_IDLE_MS = 300_000;
/** Intervalle de vérification tant que le moteur est éveillé et arrêté (ms). Rien ne tourne en veille. */
export const CHECK_MS = 2_000;

export interface IdleHost {
  /** Raison de rester éveillé côté moteur (lecture, prise, piste armée…), ou null. */
  busy(): string | null;
}

export interface IdleOptions {
  idleMs?: number;
  visibleIdleMs?: number;
  /** Page cachée ? (tests ; par défaut document.hidden). */
  hidden?: () => boolean;
  checkMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => any;
  clearTimeout?: (id: any) => void;
  /** Lecture du réglage (tests). */
  enabled?: () => boolean;
  /** Fenêtre d'instrument ouverte (tests ; par défaut : [data-nova-transport] dans la page). */
  workWindowOpen?: () => boolean;
  /** Écoute des gestes (tests ; par défaut : window). */
  listen?: (onInput: () => void) => void;
}

type Ctx = BaseAudioContext & { suspend?: () => Promise<void>; resume?: () => Promise<void> };

const defaultEnabled = () => { try { return localStorage.getItem('nova_veille_moteur') !== '0'; } catch { return true; } };
const overrideMs = (): number | null => { try { const v = Number(localStorage.getItem('nova_veille_moteur_s')); return v > 0 ? v * 1000 : null; } catch { return null; } };
const defaultWorkWindow = () => typeof document !== 'undefined' && !!document.querySelector('[data-nova-transport]');

export interface IdleStats { enabled: boolean; asleep: boolean; sleeps: number; wakes: number; liveSources: number; reason: string | null; idleForMs: number }

export class IdleSuspender {
  private ctx: Ctx | null = null;
  /** Sources démarrées et pas encore finies (son en cours ou programmé). */
  private live = new Set<AudioNode>();
  /** Flux micro / éléments média branchés sur le contexte (vivants tant qu'actifs). */
  private streams = new Set<MediaStream>();
  private elements = new Set<HTMLMediaElement>();
  private lastActivity: number;
  private timer: any = null;
  private asleep = false;
  /** Suspension demandée et pas encore aboutie. */
  private suspending: Promise<void> | null = null;
  private blockers = new Set<string>();
  private listening = false;
  private readonly o: Required<Omit<IdleOptions, 'listen'>> & { listen?: IdleOptions['listen'] };
  public stats = { sleeps: 0, wakes: 0 };

  constructor(private host: IdleHost, opts: IdleOptions = {}) {
    this.o = {
      idleMs: opts.idleMs ?? IDLE_MS,
      visibleIdleMs: opts.visibleIdleMs ?? VISIBLE_IDLE_MS,
      hidden: opts.hidden ?? (() => typeof document !== 'undefined' && !!document.hidden),
      checkMs: opts.checkMs ?? CHECK_MS,
      now: opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now())),
      setTimeout: opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout: opts.clearTimeout ?? ((id) => clearTimeout(id)),
      enabled: opts.enabled ?? defaultEnabled,
      workWindowOpen: opts.workWindowOpen ?? defaultWorkWindow,
      listen: opts.listen,
    };
    this.lastActivity = this.o.now();
  }

  /** Branche la veille sur un contexte (à chaque nouveau contexte du moteur). */
  attach(ctx: Ctx) {
    this.ctx = ctx;
    this.asleep = false;
    this.live.clear(); this.streams.clear(); this.elements.clear();
    this.wrapSources(ctx);
    try { ctx.addEventListener('statechange', () => this.onState(ctx)); } catch { /* contexte simulé */ }
    this.listenInputs();
    this.activity();
  }

  /** Quelque chose produit (ou va produire) du son, ou l'utilisateur agit : on reste / on repart éveillé. */
  wake() { this.activity(); }

  /** Raison externe de rester éveillé (collaboration…). */
  setBlocker(key: string, on: boolean) {
    if (on) { this.blockers.add(key); this.activity(); } else if (this.blockers.delete(key)) this.activity();
  }

  isAsleep() { return this.asleep; }

  getStats(): IdleStats {
    return { enabled: this.o.enabled(), asleep: this.asleep, sleeps: this.stats.sleeps, wakes: this.stats.wakes, liveSources: this.live.size,
      reason: this.reason(), idleForMs: Math.round(this.o.now() - this.lastActivity) };
  }

  /** Arrête la surveillance (contexte fermé). */
  detach() {
    if (this.timer) this.o.clearTimeout(this.timer);
    this.timer = null;
    this.ctx = null;
    this.asleep = false;
  }

  // ── interne ──────────────────────────────────────────────────────────────

  private activity() {
    this.lastActivity = this.o.now();
    const c = this.ctx;
    if (c && this.asleep) {
      this.asleep = false;
      this.stats.wakes++;
      // Suspension encore en cours (le contexte dit encore « running ») : la reprise se fait dès qu'elle
      // aboutit (voir check). Sinon tout de suite. Avant (batterie QA sous charge) : un réveil pendant la
      // suspension était perdu, la lecture partait sur un contexte suspendu (tête bloquée à 0, aucun son).
      if (c.state === 'suspended' && !this.suspending) c.resume?.().catch(() => { /* attend un geste */ });
    }
    this.schedule();
  }

  private onState(ctx: Ctx) {
    if (ctx !== this.ctx) return;
    if (ctx.state === 'suspended' && !this.asleep && !this.suspending && this.host.busy()) {
      // Suspendu alors que le moteur travaille (lecture, prise…) et que la veille ne dort pas : on repart.
      ctx.resume?.().catch(() => { /* attend un geste */ });
      return;
    }
    if (ctx.state === 'running') {
      // Repris par quelqu'un d'autre (ctx.resume() direct d'une fenêtre, retour sur la page) : réveil normal.
      if (this.asleep) { this.asleep = false; this.lastActivity = this.o.now(); }
      this.schedule();
    } else if (ctx.state === 'closed') {
      this.detach();
    }
  }

  private schedule() {
    if (this.timer || !this.ctx || this.asleep) return;
    this.timer = this.o.setTimeout(() => { this.timer = null; this.check(); }, this.o.checkMs);
  }

  private reason(): string | null {
    if (this.blockers.size) return [...this.blockers][0];
    const h = this.host.busy();
    if (h) return h;
    if (this.live.size) return 'son en cours';
    for (const s of this.streams) { if (s.active) return 'micro branché'; this.streams.delete(s); }
    for (const e of this.elements) { if (!e.paused && !e.ended) return 'vidéo / audio en lecture'; }
    if (this.o.workWindowOpen()) return 'fenêtre d\'instrument ouverte';
    return null;
  }

  private check() {
    const c = this.ctx;
    if (!c || this.asleep || c.state !== 'running') return;
    if (!this.o.enabled() || this.reason()) { this.lastActivity = this.o.now(); this.schedule(); return; }
    const limit = overrideMs() ?? (this.o.hidden() ? this.o.idleMs : this.o.visibleIdleMs);
    if (this.o.now() - this.lastActivity < limit) { this.schedule(); return; }
    if (typeof c.suspend !== 'function') return;
    this.asleep = true;
    this.stats.sleeps++;
    const p = c.suspend()
      .then(() => {
        this.suspending = null;
        // Réveillé pendant la suspension : on repart tout de suite.
        if (!this.asleep && this.ctx === c && c.state === 'suspended') c.resume?.().catch(() => { /* attend un geste */ });
      })
      .catch(() => { this.suspending = null; this.asleep = false; this.schedule(); });
    this.suspending = p;
  }

  /** Toute source démarrée sur le contexte compte comme du son jusqu'à sa fin (évènement « ended »). */
  private wrapSources(ctx: Ctx) {
    const self = this;
    const track = (n: AudioScheduledSourceNode) => {
      const start = n.start.bind(n);
      (n as any).start = (...a: any[]) => {
        self.live.add(n);
        n.addEventListener('ended', () => { self.live.delete(n); self.lastActivity = self.o.now(); self.schedule(); }, { once: true });
        self.activity();
        return (start as any)(...a);
      };
      return n;
    };
    const anyCtx = ctx as any;
    if (typeof anyCtx.createBufferSource === 'function') {
      const orig = anyCtx.createBufferSource.bind(ctx);
      anyCtx.createBufferSource = () => track(orig());
    }
    if (typeof anyCtx.createMediaStreamSource === 'function') {
      const orig = anyCtx.createMediaStreamSource.bind(ctx);
      anyCtx.createMediaStreamSource = (s: MediaStream) => { self.streams.add(s); self.activity(); return orig(s); };
    }
    if (typeof anyCtx.createMediaElementSource === 'function') {
      const orig = anyCtx.createMediaElementSource.bind(ctx);
      anyCtx.createMediaElementSource = (e: HTMLMediaElement) => {
        self.elements.add(e);
        try { e.addEventListener('play', () => self.activity()); } catch { /* élément simulé */ }
        return orig(e);
      };
    }
  }

  private listenInputs() {
    if (this.listening) return;
    this.listening = true;
    const on = () => this.activity();
    if (this.o.listen) { this.o.listen(on); return; }
    if (typeof window === 'undefined') return;
    // Phase de capture : le contexte repart AVANT que le geste ne déclenche un son.
    for (const t of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) window.addEventListener(t, on, { capture: true, passive: true });
    try { document.addEventListener('visibilitychange', () => { if (!document.hidden) on(); }); } catch { /* */ }
  }
}
