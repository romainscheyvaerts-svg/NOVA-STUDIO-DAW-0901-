/**
 * Compensation de latence des plugins (PDC), comme dans les DAW :
 * chaque piste ou bus X a une latence propre L(X) (sa chaîne d'effets) et des
 * sorties (sortie principale vers un bus / le master, envois vers des bus).
 *
 *   P(X)     = L(X) + aval(X)                latence de X jusqu'au master
 *   aval(X)  = max sur les sorties o de P(destination de o)   (master : 0)
 *   retard(o) = aval(X) − P(destination de o)                  (≥ 0)
 *
 * Les clips de X partent P(X) plus tôt ; chaque sortie plus courte que la plus
 * longue reçoit un retard. Tout ce qui entre dans X à l'instant t arrive au
 * master à t + P(X), donc toutes les pistes, bus et envois restent calés.
 * Exemple : voix → bus voix (compresseur VST 30 ms) + envoi vers une reverb VST
 * (50 ms) : la voix part 50 ms plus tôt, sa sortie vers le bus voix est retardée
 * de 20 ms, la reverb arrive pile avec la voix sèche.
 */
export interface PdcNode {
  /** Latence de la chaîne d'effets de la piste (s). */
  latency: number;
  /** Destinations des sorties (sortie principale + envois). Inconnue ou vide = master. */
  outputs: string[];
  /**
   * Clés de side-chain prises sur cette piste (R7) : chacune part vers l'effet
   * `id` de la piste `target`, après `offset` s de latence des effets qui le
   * précèdent sur cette piste. La clé est traitée comme une sortie : elle peut
   * retarder la piste source (son avance augmente) pour arriver ALIGNÉE avec
   * le son que l'effet traite, en lecture comme à l'export.
   */
  keys?: PdcKey[];
}

export interface PdcKey {
  /** Identifiant de la clé (en pratique : id de l'effet à clé). */
  id: string;
  /** Piste qui porte l'effet à clé. */
  target: string;
  /** Latence des effets placés avant l'effet à clé sur sa piste (s). */
  offset: number;
}

export interface PdcResult {
  /** Latence totale jusqu'au master : avance des clips de la piste (s). */
  total: number;
  /** Latence en aval de la chaîne de la piste (s). */
  down: number;
  /** Retard à appliquer à chaque sortie (s), par destination. */
  delays: Map<string, number>;
  /** Retard à appliquer à chaque clé de side-chain prise sur cette piste (s), par id de clé. */
  keyDelays: Map<string, number>;
}

/** Plafond (s) : au-delà, un plugin annonce sans doute une latence erronée. */
export const PDC_MAX_SECONDS = 4;

export const computePdc = (nodes: Map<string, PdcNode>): Map<string, PdcResult> => {
  const total = new Map<string, number>();
  const visiting = new Set<string>();
  const P = (id: string): number => {
    const node = nodes.get(id);
    if (!node) return 0; // master, ou piste disparue
    const known = total.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // boucle de routage : on la coupe
    visiting.add(id);
    const own = Number.isFinite(node.latency) && node.latency > 0 ? node.latency : 0;
    let down = node.outputs.reduce((m, d) => (d && d !== id ? Math.max(m, P(d)) : m), 0);
    // Clé de side-chain : elle doit arriver à l'effet en même temps que le son qu'il traite.
    for (const k of node.keys || []) if (k.target && k.target !== id) down = Math.max(down, keyArrival(k));
    visiting.delete(id);
    const t = Math.min(PDC_MAX_SECONDS, own + down);
    total.set(id, t);
    return t;
  };
  /** Avance (s) que le son traité par l'effet à clé a sur le master : P(cible) − latence des effets avant lui. */
  function keyArrival(k: PdcKey): number {
    const off = Number.isFinite(k.offset) && k.offset > 0 ? k.offset : 0;
    return Math.max(0, P(k.target) - off);
  }
  const out = new Map<string, PdcResult>();
  nodes.forEach((node, id) => {
    const t = P(id);
    const own = Number.isFinite(node.latency) && node.latency > 0 ? node.latency : 0;
    const down = Math.max(0, t - own);
    const delays = new Map<string, number>();
    node.outputs.forEach(d => {
      if (!d || d === id) return;
      delays.set(d, Math.max(0, Math.min(PDC_MAX_SECONDS, down - P(d))));
    });
    const keyDelays = new Map<string, number>();
    (node.keys || []).forEach(k => {
      if (!k.target || k.target === id) return;
      keyDelays.set(k.id, Math.max(0, Math.min(PDC_MAX_SECONDS, down - keyArrival(k))));
    });
    out.set(id, { total: t, down, delays, keyDelays });
  });
  return out;
};
