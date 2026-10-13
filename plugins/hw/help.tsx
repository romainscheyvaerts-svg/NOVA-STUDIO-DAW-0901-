import React, { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Aide « hors façade » : chaque réglage survolé (ou touché, ou focalisé au
 * clavier) publie son nom, sa valeur et son rôle dans un petit magasin ; seule
 * la ligne d'info (InfoBar) s'y abonne. La façade ne se redessine donc pas
 * quand la souris passe d'un bouton à l'autre.
 */
export interface HwHelpEntry { id: string; label: string; value?: string; hint?: string }

export interface HwHelpStore {
  get: () => HwHelpEntry | null;
  subscribe: (fn: () => void) => () => void;
  show: (e: HwHelpEntry) => void;
  /** Met à jour la valeur affichée si ce réglage est celui de la ligne d'info. */
  update: (id: string, value: string) => void;
  clear: (id: string) => void;
}

export function createHwHelpStore(): HwHelpStore {
  let cur: HwHelpEntry | null = null;
  const subs = new Set<() => void>();
  const emit = () => subs.forEach(f => f());
  return {
    get: () => cur,
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    show: (e) => { cur = e; emit(); },
    update: (id, value) => { if (cur && cur.id === id && cur.value !== value) { cur = { ...cur, value }; emit(); } },
    clear: (id) => { if (cur && cur.id === id) { cur = null; emit(); } },
  };
}

const HwHelpContext = createContext<HwHelpStore | null>(null);

export const HwHelpProvider: React.FC<{ store?: HwHelpStore; children: React.ReactNode }> = ({ store, children }) => {
  const own = useRef<HwHelpStore | null>(null);
  if (!own.current) own.current = store || createHwHelpStore();
  return <HwHelpContext.Provider value={own.current}>{children}</HwHelpContext.Provider>;
};

export const useHwHelpStore = () => useContext(HwHelpContext);

/**
 * Gestionnaires à étaler sur un réglage : survol, toucher et focus publient son
 * aide ; sortie et perte du focus la retirent.
 */
export function useHwHelp(id: string, label: string, hint: string | undefined, value: string | undefined) {
  const store = useHwHelpStore();
  const latest = useRef({ label, hint, value });
  latest.current = { label, hint, value };
  // Valeur qui change pendant qu'on tourne : la ligne d'info suit (après le rendu).
  useEffect(() => { if (store && value !== undefined) store.update(id, value); }, [store, id, value]);
  const show = () => store?.show({ id, ...latest.current });
  const clear = () => store?.clear(id);
  return {
    onPointerEnter: show,
    onPointerLeave: (e: React.PointerEvent) => { if (e.pointerType === 'mouse') clear(); },
    onFocus: show,
    onBlur: clear,
    show,
  };
}

/** Ligne d'info en bas de la fenêtre : décrit le réglage survolé. */
export const InfoBar: React.FC<{ idle: React.ReactNode; side?: React.ReactNode }> = ({ idle, side }) => {
  const store = useHwHelpStore();
  const cur = useSyncExternalStore(store ? store.subscribe : noopSub, store ? store.get : nullGet, nullGet);
  return (
    <div className="hw-infobar" data-nova-infobar>
      <i className="fas fa-circle-info hw-infobar-icon" aria-hidden="true" />
      <div className="hw-infobar-text">
        {cur ? (
          <>
            <b>{cur.label}</b>
            {cur.value ? <span className="hw-infobar-value">{cur.value}</span> : ' '}
            {cur.hint ? <span>— {cur.hint}</span> : null}
          </>
        ) : idle}
      </div>
      {side ? <div className="hw-infobar-side">{side}</div> : null}
    </div>
  );
};

const noopSub = () => () => {};
const nullGet = () => null;
