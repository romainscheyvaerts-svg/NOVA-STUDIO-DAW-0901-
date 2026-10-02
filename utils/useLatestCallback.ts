import { useCallback, useRef } from 'react';

/**
 * Fonction d'identité stable qui appelle toujours la dernière version de `fn`.
 * Permet de passer des gestionnaires à des composants mémoïsés (React.memo)
 * sans les re-rendre à chaque rendu du parent, et sans risque de fermeture
 * périmée. Une fonction absente (undefined) reste absente.
 */
export function useLatestCallback<T extends ((...args: any[]) => any) | undefined>(fn: T): T {
  const ref = useRef(fn);
  ref.current = fn;
  const stable = useCallback((...args: any[]) => ref.current?.(...args), []);
  return (fn ? stable : undefined) as T;
}
