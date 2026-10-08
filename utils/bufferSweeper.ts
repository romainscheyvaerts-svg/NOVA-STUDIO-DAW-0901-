/**
 * Libération des sons qui ne servent plus (fuite mesurée le 08/10/2026 : soak de
 * 60 min, 686 secondes-canal de son en plus en mémoire, ≈ 120 Mo, surtout des
 * rendus de gel / dégel et des prises annulées).
 *
 * Un son n'était libéré qu'au moment précis où son clip était supprimé, et
 * seulement si aucune étape d'annulation ne le citait. Mais l'historique est
 * borné (100 étapes) : quand l'étape qui le citait sortait de l'historique,
 * plus personne ne le libérait. Idem pour les rendus remplacés.
 *
 * Balayage prudent (marquer-balayer) : un son n'est libéré que s'il a DÉJÀ été
 * vu dans le projet ou l'historique, puis n'y est plus cité pendant un délai de
 * grâce. Un son enregistré par une opération en cours (rendu, dialogue) et pas
 * encore posé dans le projet n'est jamais touché.
 */
export class BufferSweeper {
  private seen = new Set<string>();
  private orphanSince = new Map<string, number>();

  constructor(private graceMs = 120_000) {}

  /** Identifiants à libérer maintenant. */
  sweep(allIds: Iterable<string>, used: Set<string>, now: number): string[] {
    const free: string[] = [];
    const present = new Set<string>();
    for (const id of allIds) {
      present.add(id);
      if (used.has(id)) { this.seen.add(id); this.orphanSince.delete(id); continue; }
      if (!this.seen.has(id)) continue;
      const since = this.orphanSince.get(id) ?? now;
      this.orphanSince.set(id, since);
      if (now - since >= this.graceMs) {
        free.push(id);
        this.seen.delete(id);
        this.orphanSince.delete(id);
      }
    }
    // Sons libérés ailleurs : oubliés ici aussi.
    for (const id of [...this.seen]) if (!present.has(id)) { this.seen.delete(id); this.orphanSince.delete(id); }
    return free;
  }
}
