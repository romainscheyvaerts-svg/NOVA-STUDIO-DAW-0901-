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

// --------------------------------------------------------------------------------------------
// Retraite des worklets (fuite mesurée le 08/10/2026)
//
// Un processeur dont process() renvoie toujours true reste VIVANT et calculé à chaque bloc,
// même déconnecté et oublié (règle Web Audio : un processeur « actif » garde son nœud).
// Chaque effet à worklet retiré d'une piste (compresseur, saturation, lo-fi, filtre DJ,
// gate, harmoniseur, autotune…), chaque prise (enregistreur) et chaque synthé remplacé
// restaient donc en mémoire ET consommaient du processeur : 120 changements d'effet =
// 170 worklets fantômes. Correctif générique : un prélude chargé avant chaque module de
// worklet enveloppe registerProcessor ; un message { __novaRetire: true } sur le port d'un
// nœud fait renvoyer false à son process() : le navigateur peut alors le libérer.
// --------------------------------------------------------------------------------------------

const PRELUDE = `
(() => {
  if (globalThis.__novaRetirePrelude) return;
  globalThis.__novaRetirePrelude = true;
  const reg = globalThis.registerProcessor;
  globalThis.registerProcessor = function (name, Cls) {
    class Retirable extends Cls {
      constructor(...args) {
        super(...args);
        this.__novaAlive = true;
        try {
          this.port.addEventListener('message', (e) => { if (e && e.data && e.data.__novaRetire) this.__novaAlive = false; });
          this.port.start();
        } catch (e) {}
      }
      process(inputs, outputs, params) {
        if (!this.__novaAlive) return false;
        return super.process(inputs, outputs, params);
      }
    }
    return reg.call(globalThis, name, Retirable);
  };
})();
`;

const preludeLoaded = new WeakMap<object, Promise<void>>();
let retirementInstalled = false;

/** Charge le prélude avant tout module de worklet (une fois par contexte audio). */
export function installWorkletRetirement(): boolean {
  if (retirementInstalled) return true;
  const g = globalThis as any;
  const AW = g.AudioWorklet as { prototype: { addModule: (url: string | URL, opts?: any) => Promise<void> } } | undefined;
  if (!AW || typeof AW.prototype?.addModule !== 'function' || typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') return false;
  const orig = AW.prototype.addModule;
  AW.prototype.addModule = function (this: object, url: string | URL, opts?: any) {
    let p = preludeLoaded.get(this);
    if (!p) {
      const blobUrl = URL.createObjectURL(new Blob([PRELUDE], { type: 'application/javascript' }));
      p = orig.call(this, blobUrl).catch(() => { /* sans prélude : le module se charge quand même */ }).finally(() => URL.revokeObjectURL(blobUrl));
      preludeLoaded.set(this, p);
    }
    return p.then(() => orig.call(this, url, opts));
  };
  retirementInstalled = true;
  return true;
}

const retired = new WeakSet<object>();

/** Met un nœud de worklet à la retraite (déconnecté, process() renverra false). */
export function retireWorkletNode(node: AudioWorkletNode): void {
  if (!node || retired.has(node)) return;
  retired.add(node);
  try { node.port.postMessage({ __novaRetire: true }); } catch { /* port fermé */ }
  try { node.disconnect(); } catch { /* déjà déconnecté */ }
  // Un port qui a un écouteur reste vivant (et garde l'effet en mémoire par sa fermeture) :
  // on le ferme une fois le message parti.
  try { node.port.onmessage = null; } catch { /* */ }
  setTimeout(() => { try { node.port.close(); } catch { /* */ } }, 250);
}

/** Tous les nœuds de worklet d'un objet (effet, synthé, enregistreur), mis à la retraite. */
export function retireWorkletsOf(root: unknown, maxDepth = 3): number {
  if (!root || typeof AudioWorkletNode === 'undefined') return 0;
  let n = 0;
  const seen = new Set<unknown>();
  const visit = (v: any, depth: number) => {
    if (!v || typeof v !== 'object' || depth > maxDepth || seen.has(v)) return;
    seen.add(v);
    if (v instanceof AudioWorkletNode) { retireWorkletNode(v); n++; return; }
    if ((typeof AudioNode !== 'undefined' && v instanceof AudioNode) || (typeof BaseAudioContext !== 'undefined' && v instanceof BaseAudioContext)
      || (typeof AudioParam !== 'undefined' && v instanceof AudioParam) || (typeof AudioBuffer !== 'undefined' && v instanceof AudioBuffer)) return;
    if (ArrayBuffer.isView(v)) return;
    if (v instanceof Map) { for (const x of v.values()) visit(x, depth + 1); return; }
    if (v instanceof Set || Array.isArray(v)) { for (const x of v as any) visit(x, depth + 1); return; }
    for (const k of Object.keys(v)) { let x: any; try { x = v[k]; } catch { continue; } visit(x, depth + 1); }
  };
  visit(root, 0);
  return n;
}
