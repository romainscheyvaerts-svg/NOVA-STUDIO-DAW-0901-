/**
 * Garde des AudioWorklets : un processeur qui lève une exception (bug d'un
 * effet, valeur inattendue) déclenche « processorerror » sur son nœud, qui ne
 * produit plus que du silence. Personne n'écoutait cet événement : la piste
 * devenait muette sans aucun message.
 *
 * installWorkletGuard() remplace (une fois) le constructeur global
 * AudioWorkletNode par une sous-classe qui écoute « processorerror » et prévient
 * les abonnés (le moteur retrouve l'effet propriétaire et le contourne). Les
 * modules qui font `new AudioWorkletNode(...)` passent tous par là, sans
 * modification. `instanceof AudioWorkletNode` reste vrai.
 */

export type WorkletCrashListener = (node: AudioWorkletNode, processor: string, event: Event) => void;

const listeners = new Set<WorkletCrashListener>();
let installed = false;

export function onWorkletCrash(cb: WorkletCrashListener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

const reported = new WeakSet<object>();

/** Prévient les abonnés (exporté pour les tests et les nœuds qui détectent eux-mêmes une panne). */
export function reportWorkletCrash(node: AudioWorkletNode, processor: string, event?: Event): void {
  // Un nœud ne plante qu'une fois (gestionnaire et écouteur peuvent tous deux être appelés).
  if (reported.has(node)) return;
  reported.add(node);
  const ev = event || (typeof Event !== 'undefined' ? new Event('processorerror') : ({} as Event));
  listeners.forEach(cb => { try { cb(node, processor, ev); } catch (e) { console.error('[WorkletGuard] écouteur', e); } });
}

export function installWorkletGuard(): boolean {
  if (installed) return true;
  const g = globalThis as any;
  const Orig = g.AudioWorkletNode as (typeof AudioWorkletNode) | undefined;
  if (typeof Orig !== 'function') return false;
  if ((Orig as any).__novaGuarded) { installed = true; return true; }
  // Chrome (vérifié le 08/10/2026, Chromium 153) ne prévient QUE le gestionnaire
  // « onprocessorerror » : un addEventListener('processorerror') ne reçoit rien.
  // On pose donc notre gestionnaire natif, et l'éventuel gestionnaire de l'appli
  // (node.onprocessorerror = …) est gardé à part et appelé aussi.
  const nativeHandler = Object.getOwnPropertyDescriptor(Orig.prototype, 'onprocessorerror');
  class GuardedAudioWorkletNode extends Orig {
    constructor(ctx: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
      super(ctx, name, options);
      const self = this as unknown as AudioWorkletNode & { __novaUserPE?: ((ev: Event) => any) | null };
      let fired = false;
      const onError = (ev: Event) => {
        if (fired) return;
        fired = true;
        console.error(`[WorkletGuard] Le processeur audio « ${name} » s'est arrêté (exception).`);
        reportWorkletCrash(self, name, ev);
        try { self.__novaUserPE?.call(self, ev); } catch (e) { console.error(e); }
      };
      if (nativeHandler?.set) nativeHandler.set.call(this, onError);
      // Autres navigateurs : l'événement passe (aussi) par les écouteurs ; doublon filtré par reportWorkletCrash.
      this.addEventListener('processorerror', onError as EventListener);
    }
  }
  if (nativeHandler?.set) {
    Object.defineProperty(GuardedAudioWorkletNode.prototype, 'onprocessorerror', {
      configurable: true,
      get(this: any) { return this.__novaUserPE ?? null; },
      set(this: any, v: any) { this.__novaUserPE = typeof v === 'function' ? v : null; },
    });
  }
  (GuardedAudioWorkletNode as any).__novaGuarded = true;
  try {
    g.AudioWorkletNode = GuardedAudioWorkletNode;
    installed = true;
  } catch {
    return false;
  }
  return true;
}

/**
 * Le nœud `target` appartient-il à `root` (effet, synthé, enregistreur) ?
 * Parcours des propriétés propres (objets, tableaux, Map, Set) sur quelques
 * niveaux, sans descendre dans les nœuds audio ni dans le contexte.
 */
export function ownsNode(root: unknown, target: unknown, maxDepth = 3): boolean {
  if (!root || !target) return false;
  const seen = new Set<unknown>();
  const isAudioThing = (v: any) =>
    (typeof AudioNode !== 'undefined' && v instanceof AudioNode)
    || (typeof BaseAudioContext !== 'undefined' && v instanceof BaseAudioContext)
    || (typeof AudioParam !== 'undefined' && v instanceof AudioParam)
    || (typeof AudioBuffer !== 'undefined' && v instanceof AudioBuffer);
  const visit = (v: any, depth: number): boolean => {
    if (v === target) return true;
    if (!v || typeof v !== 'object' || depth > maxDepth || seen.has(v)) return false;
    seen.add(v);
    if (isAudioThing(v)) return false;
    if (typeof (v as any).ownsNode === 'function') {
      try { if ((v as any).ownsNode(target)) return true; } catch { /* */ }
    }
    if (v instanceof Map) { for (const x of v.values()) if (visit(x, depth + 1)) return true; return false; }
    if (v instanceof Set || Array.isArray(v)) { for (const x of v as any) if (visit(x, depth + 1)) return true; return false; }
    if (ArrayBuffer.isView(v)) return false;
    for (const k of Object.keys(v)) {
      let x: any;
      try { x = (v as any)[k]; } catch { continue; }
      if (visit(x, depth + 1)) return true;
    }
    return false;
  };
  return visit(root, 0);
}
