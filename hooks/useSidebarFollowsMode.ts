import { useEffect, useRef } from 'react';
import { simpleModeStore } from '../utils/simpleMode';
import { sidebarAfterModeChange } from '../utils/sidebarPref';

/**
 * Le navigateur latéral suit le passage simple ↔ avancé tant que l'utilisateur
 * n'a rien choisi lui-même (utils/sidebarPref). Le mode avancé arrive souvent
 * après l'ouverture (rôle ingé son choisi, mode instru) : sans ça, le store
 * restait ouvert pour l'ingé à la 1re séance.
 */
export function useSidebarFollowsMode(setOpen: (open: boolean) => void, enabled = true) {
  const last = useRef(simpleModeStore.get().simple);
  const set = useRef(setOpen);
  set.current = setOpen;
  useEffect(() => {
    if (!enabled) return;
    return simpleModeStore.subscribe(() => {
      const now = simpleModeStore.get().simple;
      const want = sidebarAfterModeChange(last.current, now, window.innerWidth);
      last.current = now;
      // Rouvrir seulement sur un écran large (sur téléphone / tablette, le store passe par-dessus).
      if (want === false || (want === true && window.innerWidth >= 1280)) set.current(want);
    });
  }, [enabled]);
}
