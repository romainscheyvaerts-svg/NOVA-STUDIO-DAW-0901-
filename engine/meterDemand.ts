/**
 * Mesures d'un effet (réduction de gain, niveaux) envoyées par son worklet SEULEMENT pendant
 * qu'on les lit : vumètre de la piste à l'écran, fenêtre de l'effet ouverte.
 *
 * Avant, chaque compresseur et chaque de-esser postait 43 à 57 messages par seconde, même
 * hors de l'écran, même pendant l'export : à 96 pistes, ~5 000 messages/s (≈ 20 ms/s sur le fil
 * audio, autant sur l'interface). Le son n'en dépend pas : seul l'affichage les lit.
 *
 * `read()` à chaque lecture : la mesure est demandée (message au worklet) si elle ne l'était pas,
 * puis coupée `idleMs` après la dernière lecture. Un seul minuteur pour toutes les instances,
 * actif seulement tant qu'une mesure est demandée.
 */
export class MeterDemand {
  private on = false;
  private lastRead = 0;
  constructor(private readonly send: (on: boolean) => void, private readonly idleMs = 1500) {}

  /** À appeler à chaque lecture de la mesure. */
  read(now = Date.now()) {
    this.lastRead = now;
    if (this.on) return;
    this.on = true;
    this.send(true);
    MeterDemand.watch(this);
  }

  get active() { return this.on; }

  /** Coupe la mesure si personne ne l'a lue depuis `idleMs` (appelé par le minuteur partagé). */
  check(now = Date.now()): boolean {
    if (!this.on) return false;
    if (now - this.lastRead < this.idleMs) return true;
    this.on = false;
    this.send(false);
    return false;
  }

  private static live = new Set<MeterDemand>();
  private static timer: ReturnType<typeof setInterval> | null = null;
  private static watch(d: MeterDemand) {
    MeterDemand.live.add(d);
    if (MeterDemand.timer || typeof setInterval === 'undefined') return;
    MeterDemand.timer = setInterval(() => {
      const now = Date.now();
      MeterDemand.live.forEach(x => { if (!x.check(now)) MeterDemand.live.delete(x); });
      if (!MeterDemand.live.size && MeterDemand.timer) { clearInterval(MeterDemand.timer); MeterDemand.timer = null; }
    }, 500);
  }
}
