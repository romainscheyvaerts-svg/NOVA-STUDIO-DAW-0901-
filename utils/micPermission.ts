import { useSyncExternalStore } from 'react';

/**
 * Autorisation du micro, expliquée AVANT que le navigateur ne la demande (15/10/2026).
 *
 * Le premier REC ouvre le micro : Chrome, Edge, Safari affichent leur fenêtre « Autoriser le
 * micro ? » sans que l'artiste sache pourquoi. Pendant cette demande, Nova affiche une bulle
 * (components/MicPermissionHint) qui dit quoi cliquer et à quoi sert le micro. Aucun clic en
 * plus : la bulle disparaît toute seule quand le navigateur a répondu.
 *
 * - « granted » (déjà autorisé) : rien n'est affiché ;
 * - « prompt » ou inconnu (Firefox, Safari sans l'API) : bulle « clique Autoriser » ;
 * - « denied » (bloqué) : le navigateur ne demande rien, la prise échoue avec un message qui
 *   explique comment débloquer le micro (cadenas à gauche de l'adresse).
 */
export type MicAsk = null | 'demande';

const OK_KEY = 'nova_mic_ok';
let asking: MicAsk = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export const micAskStore = {
  get: (): MicAsk => asking,
  set(v: MicAsk) { if (v === asking) return; asking = v; emit(); },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};

export const useMicAsk = (): MicAsk => useSyncExternalStore(micAskStore.subscribe, micAskStore.get, micAskStore.get);

/** État de l'autorisation du micro : 'granted' | 'denied' | 'prompt' | 'unknown'. */
export async function micPermissionState(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
  try {
    const perms = (navigator as any)?.permissions;
    if (perms?.query) {
      const st = await Promise.race([
        perms.query({ name: 'microphone' as PermissionName }).then((r: PermissionStatus) => r.state),
        new Promise<string>(resolve => setTimeout(() => resolve('unknown'), 300)),
      ]);
      if (st === 'granted' || st === 'denied' || st === 'prompt') return st;
    }
  } catch { /* API absente (Firefox, Safari) : inconnu */ }
  return 'unknown';
}

/** Laisse le temps à la bulle de s'afficher avant que le navigateur ne pose sa question. */
const nextPaint = () => new Promise<void>(resolve => {
  let done = false;
  const go = () => { if (!done) { done = true; resolve(); } };
  try { requestAnimationFrame(() => setTimeout(go, 0)); } catch { /* */ }
  setTimeout(go, 80);
});

/**
 * Ouvre le micro (fn) en expliquant la demande d'autorisation si le navigateur va la poser.
 * Le résultat de fn est rendu tel quel ; l'autorisation obtenue est mémorisée (navigateurs
 * sans API de permissions : plus de bulle aux prises suivantes).
 */
export async function withMicExplanation<T>(fn: () => Promise<T>, ok: (r: T) => boolean = () => true): Promise<T> {
  const st = await micPermissionState();
  let known = false;
  try { known = localStorage.getItem(OK_KEY) === '1'; } catch { /* stockage indisponible */ }
  const show: MicAsk = st === 'prompt' || (st === 'unknown' && !known) ? 'demande' : null;
  if (show) { micAskStore.set(show); await nextPaint(); }
  try {
    const r = await fn();
    if (ok(r)) { try { localStorage.setItem(OK_KEY, '1'); } catch { /* */ } }
    return r;
  } finally {
    if (show) micAskStore.set(null);
  }
}
