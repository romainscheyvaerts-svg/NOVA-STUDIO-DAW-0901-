import { useEffect, useRef } from 'react';
import { isShortcut } from '../utils/keymap';
import { isTypingTarget } from '../utils/padKeys';

/**
 * Touche du talkback (N par défaut, table ACTIVE de utils/keymap : remappable dans
 * « Personnaliser les raccourcis »). Appui = `onPress`, relâchement de LA MÊME touche
 * physique = `onRelease` (même si les modificateurs ont été lâchés avant). Les répétitions
 * automatiques du clavier sont ignorées. Fenêtre qui perd le focus pendant l'appui = relâché.
 *
 * Jamais pendant la saisie dans un champ texte ; ni quand la batterie ou le piano roll
 * (data-nova-transport) prennent les lettres pour jouer des pads / des notes.
 */
export function useTalkbackKey(enabled: boolean, onPress: () => void, onRelease: () => void) {
  const cb = useRef({ onPress, onRelease });
  cb.current = { onPress, onRelease };
  useEffect(() => {
    if (!enabled) return;
    let held: string | null = null;
    const down = (e: KeyboardEvent) => {
      if (held) {
        // Touche tenue : ses répétitions ne doivent ni écrire ni déclencher autre chose.
        if (e.code === held) e.preventDefault();
        return;
      }
      if (e.repeat || isTypingTarget(e.target) || e.defaultPrevented) return;
      if (!isShortcut(e, 'nova.talkback')) return;
      if (document.querySelector('[data-nova-transport]')) return;
      e.preventDefault();
      held = e.code || e.key;
      cb.current.onPress();
    };
    const up = (e: KeyboardEvent) => {
      if (!held || (e.code || e.key) !== held) return;
      held = null;
      e.preventDefault();
      cb.current.onRelease();
    };
    const lost = () => { if (held) { held = null; cb.current.onRelease(); } };
    const hidden = () => { if (document.visibilityState === 'hidden') lost(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', lost);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', lost);
      document.removeEventListener('visibilitychange', hidden);
      if (held) { held = null; cb.current.onRelease(); }
    };
  }, [enabled]);
}
