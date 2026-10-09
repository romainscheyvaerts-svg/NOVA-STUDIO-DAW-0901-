import { useCallback, useRef, useState } from 'react';
import { recoveryStore, type VersionMeta } from '../utils/recoveryStore';
import { findSavedVersion } from '../utils/revertToSaved';

/**
 * « Revenir à la version enregistrée » (Pro Tools : Revert to Saved) : cherche la
 * dernière sauvegarde voulue du projet, demande confirmation (fenêtre claire),
 * garde l'état actuel dans l'historique, puis rouvre la version enregistrée.
 */
export interface RevertDeps {
  projectId: () => string;
  /** Garde l'état actuel (sauvegarde automatique forcée) avant de revenir. */
  keepCurrent: () => Promise<unknown> | unknown;
  restore: (v: VersionMeta) => Promise<void> | void;
  notify: (text: string) => void;
}

export function useRevertToSaved(deps: RevertDeps) {
  const ref = useRef(deps);
  ref.current = deps;
  const [target, setTarget] = useState<VersionMeta | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = useCallback(async () => {
    try {
      const list = await recoveryStore().listVersions(ref.current.projectId());
      const v = findSavedVersion(list, ref.current.projectId());
      if (!v) { ref.current.notify('Ce projet n’a pas encore de version enregistrée sur cet appareil : sauvegarde-le d’abord (Ctrl+S). Les sauvegardes automatiques sont dans « Versions de la session ».'); return; }
      setTarget(v);
    } catch {
      ref.current.notify('Impossible de lire les versions de ce projet sur cet appareil.');
    }
  }, []);

  const confirm = useCallback(async () => {
    const v = target;
    if (!v) return;
    setBusy(true);
    try {
      await ref.current.keepCurrent();
      await ref.current.restore(v);
    } finally {
      setBusy(false);
      setTarget(null);
    }
  }, [target]);

  const cancel = useCallback(() => setTarget(null), []);
  return { target, busy, ask, confirm, cancel };
}
