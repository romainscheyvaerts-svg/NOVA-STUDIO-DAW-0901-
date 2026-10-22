/**
 * Garde de l'horloge audio : le moteur se remet seul d'une sortie audio qui ne répond pas.
 *
 * Constaté le 22/10/2026 (qa/moteur_web.py, plusieurs Chrome headless en parallèle, comme la
 * batterie de QA) : le contexte audio annonce « running » mais son horloge reste à 0 pendant 2 à
 * 11 s (flux de sortie de Windows lent à s'ouvrir), et parfois Chrome lève « The AudioContext
 * encountered an error from the audio device or the WebAudio renderer » : l'horloge s'arrête
 * pour de bon. Pour l'artiste : ▶ ne fait rien, la tête de lecture reste à 0, aucun message.
 *
 * Même principe que le moteur natif (Engine::housekeeping : pilote qui demande une remise à zéro,
 * horloge de l'échantillon comme seule référence) : on regarde l'horloge, pas l'état annoncé.
 *   - démarrage lent : l'horloge n'a pas encore bougé `slowMs` après la création → message
 *     « la sortie audio tarde » ; toujours rien à `restartMs` → contexte recréé (une fois) ;
 *   - arrêt : l'horloge avançait puis se fige `stallMs` (contexte « running », page visible)
 *     → contexte recréé ;
 *   - erreur du périphérique (événement « error » du contexte) → contexte recréé ;
 *   - « suspended » / « interrupted » sans qu'on l'ait demandé pendant la lecture → resume().
 * Jamais pendant une prise (la prise serait coupée) : l'artiste est prévenu, la relance attend
 * la fin de la prise. Au plus `maxRestarts` relances par minute (pas de boucle infinie si
 * aucune sortie ne marche : message clair à la place).
 *
 * Léger : un minuteur de 500 ms seulement quand le moteur a besoin de l'horloge (lecture,
 * prise, piste armée, ou démarrage pas encore confirmé) ; rien à l'arrêt.
 */

export type ClockIssue = 'demarrage-lent' | 'arret' | 'erreur' | 'suspendu';

export interface ClockWatchHost {
  ctx(): (BaseAudioContext & { onerror?: any }) | null;
  /** Le moteur a besoin de l'horloge (lecture, prise, piste armée…). */
  active(): boolean;
  /** Une prise est en cours : aucune relance. */
  recording(): boolean;
  /** Page visible (une page masquée peut voir son horloge ralentie par le système). */
  visible(): boolean;
  /** Recrée le contexte audio (la session est gardée) ; rend false si impossible. */
  restart(reason: ClockIssue): Promise<boolean>;
  resume(): Promise<void>;
  notify(message: string): void;
  /** Journal (QA, Réglages audio). */
  report?(e: ClockWatchEvent): void;
}

export interface ClockWatchEvent { at: number; issue: ClockIssue; action: 'message' | 'relance' | 'reprise' | 'abandon' | 'retabli'; ms?: number }

export interface ClockWatchOptions {
  now?: () => number;
  tickMs?: number;
  slowMs?: number;
  restartMs?: number;
  stallMs?: number;
  maxRestarts?: number;
  setInterval?: (fn: () => void, ms: number) => any;
  clearInterval?: (id: any) => void;
}

export class AudioClockWatch {
  private timer: any = null;
  private readonly now: () => number;
  private readonly o: Required<Omit<ClockWatchOptions, 'now' | 'setInterval' | 'clearInterval'>>;
  private watched: BaseAudioContext | null = null;
  private bornAt = 0;
  private started = false;
  private lastTime = 0;
  private lastMoveAt = 0;
  private slowSaid = false;
  private errorPending = false;
  private restarting = false;
  private restartsAt: number[] = [];
  private incidentAt: number | null = null;
  private incident: ClockIssue | null = null;
  private deferredSaid = false;
  /** Un message a été affiché pour l'incident en cours : « Son rétabli » à la fin. */
  private incidentSaid = false;
  public readonly events: ClockWatchEvent[] = [];
  private onErr = () => { this.errorPending = true; this.ensureTimer(); this.tick(); };

  constructor(private host: ClockWatchHost, opts: ClockWatchOptions = {}) {
    this.now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.o = {
      tickMs: opts.tickMs ?? 500,
      slowMs: opts.slowMs ?? 2000,
      restartMs: opts.restartMs ?? 5000,
      stallMs: opts.stallMs ?? 1500,
      maxRestarts: opts.maxRestarts ?? 3,
    };
    this.si = opts.setInterval || ((fn, ms) => setInterval(fn, ms));
    this.ci = opts.clearInterval || (id => clearInterval(id));
  }
  private si: (fn: () => void, ms: number) => any;
  private ci: (id: any) => void;

  /** Nouveau contexte (création, fréquence changée, relance) : surveillance de son démarrage. */
  attach(ctx: BaseAudioContext | null) {
    if (this.watched && this.watched !== ctx) { try { (this.watched as any).removeEventListener?.('error', this.onErr); } catch { /* */ } }
    this.watched = ctx;
    this.bornAt = this.now();
    this.started = !!ctx && ctx.currentTime > 0;
    this.lastTime = ctx ? ctx.currentTime : 0;
    this.lastMoveAt = this.bornAt;
    this.slowSaid = false;
    this.errorPending = false;
    if (ctx) { try { (ctx as any).addEventListener?.('error', this.onErr); } catch { /* */ } }
    this.ensureTimer();
  }

  /** À appeler quand le moteur commence à avoir besoin de l'horloge (▶, armement, prise). */
  poke() { this.lastMoveAt = Math.max(this.lastMoveAt, this.now() - this.o.tickMs); this.ensureTimer(); }

  private ensureTimer() {
    if (this.timer || !this.watched) return;
    this.timer = this.si(() => this.tick(), this.o.tickMs);
  }

  private stopTimer() { if (this.timer) this.ci(this.timer); this.timer = null; }

  dispose() { this.stopTimer(); this.attach(null); this.stopTimer(); }

  private log(issue: ClockIssue, action: ClockWatchEvent['action'], ms?: number) {
    if (action !== 'reprise' && action !== 'retabli') this.incidentSaid = true;
    const e = { at: Date.now(), issue, action, ...(ms !== undefined ? { ms: Math.round(ms) } : {}) };
    this.events.push(e);
    if (this.events.length > 50) this.events.shift();
    try { this.host.report?.(e); } catch { /* */ }
  }

  /** Une vérification (minuteur ; publique pour les tests). */
  tick() {
    const ctx = this.host.ctx();
    if (!ctx || ctx !== this.watched) { if (ctx) this.attach(ctx); else { this.stopTimer(); return; } }
    const c = this.watched!;
    const t = this.now();
    const time = c.currentTime;
    const state = c.state as string;
    if (state === 'closed') { this.stopTimer(); return; }
    const moved = time > this.lastTime + 1e-4;
    if (moved) {
      if (this.incident && this.incidentAt !== null) {
        this.log(this.incident, 'retabli', t - this.incidentAt);
        if (this.incidentSaid) this.host.notify('🔊 Son rétabli.');
        this.incident = null; this.incidentAt = null; this.deferredSaid = false; this.incidentSaid = false;
      }
      this.started = true;
      this.lastTime = time;
      this.lastMoveAt = t;
    }
    const active = this.host.active();
    if (this.restarting) return;

    let issue: ClockIssue | null = null;
    if (this.errorPending) issue = 'erreur';
    else if (state === 'running' && !moved) {
      if (!this.started && t - this.bornAt >= this.o.slowMs && (active || t - this.bornAt >= this.o.restartMs)) issue = 'demarrage-lent';
      else if (this.started && active && this.host.visible() && t - this.lastMoveAt >= this.o.stallMs) issue = 'arret';
    } else if ((state === 'suspended' || state === 'interrupted') && active) issue = 'suspendu';

    if (!issue) {
      // Démarrage confirmé et plus rien à surveiller : le minuteur s'arrête (rien ne tourne à l'arrêt).
      if (this.started && !active && !this.incident) this.stopTimer();
      return;
    }
    if (!this.incident) { this.incident = issue; this.incidentAt = t; }

    if (issue === 'suspendu') {
      this.log(issue, 'reprise');
      void this.host.resume().catch(() => { /* attend un geste */ });
      return;
    }
    if (issue === 'demarrage-lent' && t - this.bornAt < this.o.restartMs) {
      if (!this.slowSaid && active) {
        this.slowSaid = true;
        this.log(issue, 'message', t - this.bornAt);
        this.host.notify('🔊 La sortie audio de l\'ordinateur tarde à démarrer : NOVA attend qu\'elle réponde…');
      }
      return;
    }
    // Relance du contexte (démarrage trop long, horloge figée, erreur du périphérique).
    if (this.host.recording()) {
      if (!this.deferredSaid) {
        this.deferredSaid = true;
        this.log(issue, 'message');
        this.host.notify('⚠️ La sortie audio ne répond plus. Arrête la prise : ce qui est enregistré est gardé, NOVA relancera le son juste après.');
      }
      return;
    }
    this.restartsAt = this.restartsAt.filter(x => t - x < 60_000);
    if (this.restartsAt.length >= this.o.maxRestarts) {
      if (this.incident !== null && !this.deferredSaid) {
        this.deferredSaid = true;
        this.log(issue, 'abandon');
        this.host.notify('🔇 Aucune sortie audio ne répond. Vérifie le casque ou la carte son (et ferme les autres applis qui l\'utilisent), puis appuie sur ▶.');
      }
      return;
    }
    this.restartsAt.push(t);
    this.restarting = true;
    this.errorPending = false;
    this.log(issue, 'relance', this.incidentAt !== null ? t - this.incidentAt : undefined);
    this.host.notify(issue === 'erreur'
      ? '🔊 La carte son du navigateur a signalé une erreur : NOVA relance le moteur audio (ta séance est gardée)…'
      : '🔊 La sortie audio ne répond pas : NOVA relance le moteur audio (ta séance est gardée)…');
    void this.host.restart(issue).catch(() => false).finally(() => {
      this.restarting = false;
      // Le nouveau contexte est surveillé par attach() (appelé par le moteur) ; l'incident reste
      // ouvert jusqu'à ce que son horloge avance (« Son rétabli »).
      this.ensureTimer();
    });
  }

  /** État pour les Réglages audio et la QA. */
  status() {
    return { started: this.started, incident: this.incident, restarts: this.restartsAt.length, events: [...this.events] };
  }
}
