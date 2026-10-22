import { useEffect, type RefObject } from 'react';

/**
 * Fenêtre de travail (piano roll plein écran, batterie) : le focus clavier y entre à l'ouverture et
 * revient à sa place à la fermeture (audit de nuit, 22/10/2026). `open` : fenêtre montée une fois puis
 * cachée (batterie) ; le focus suit chaque ouverture.
 *
 * Avant, le focus restait sur le bouton qui avait ouvert la fenêtre (« Synthé NOVA » de la barre du bas,
 * caché derrière le piano roll) : Entrée dans le piano roll « cliquait » ce bouton invisible et créait
 * une piste de synthé de plus ; et les raccourcis de la batterie (Maj+←/→, Suppr, Ctrl+D, [ ]) ne
 * marchaient qu'après un clic dans le panneau.
 */
export function useFocusOnOpen(ref: RefObject<HTMLElement | null>, open = true) {
  useEffect(() => {
    const el = ref.current;
    if (!open || !el || typeof document === 'undefined') return;
    const before = document.activeElement as HTMLElement | null;
    // Un champ de saisie ouvert ailleurs (nom de piste…) garde son focus.
    const typing = !!before && (before.tagName === 'INPUT' || before.tagName === 'TEXTAREA' || before.isContentEditable);
    if (!typing && !el.contains(before)) {
      try { el.focus({ preventScroll: true }); } catch { /* navigateur ancien */ }
    }
    return () => {
      const now = document.activeElement;
      // Le focus était dans la fenêtre (ou perdu sur la page) : il revient d'où il venait.
      if (before && before.isConnected && before !== document.body && (!now || now === document.body || el.contains(now))) {
        try { before.focus({ preventScroll: true }); } catch { /* */ }
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
