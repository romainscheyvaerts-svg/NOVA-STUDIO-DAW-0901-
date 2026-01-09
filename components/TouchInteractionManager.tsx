
import React, { useEffect, useRef } from 'react';

/**
 * TouchInteractionManager
 * 
 * Ce composant invisible gère globalement les interactions tactiles.
 * Il détecte :
 * 1. "Long Press" (600ms) -> Clic Droit
 * 2. "Double Tap" (< 300ms) -> Clic Droit (Nouveau)
 * 
 * Il dispatche artificiellement des événements souris pour déclencher 
 * les menus contextuels existants.
 */
const TouchInteractionManager: React.FC = () => {
  const timerRef = useRef<number | null>(null);
  const startPosRef = useRef<{ x: number, y: number } | null>(null);
  const lastTapRef = useRef<{ time: number, x: number, y: number } | null>(null);
  const isLongPressTriggered = useRef(false);

  useEffect(() => {
    const LONG_PRESS_DURATION = 600;
    const DOUBLE_TAP_DELAY = 300; // ms max entre deux taps
    const TAP_DISTANCE_THRESHOLD = 20; // px max entre deux taps
    const MOVE_THRESHOLD = 15; // px de tolérance pour le tremblement

    // Fonction centrale pour déclencher l'action "Clic Droit"
    const triggerRightClick = (target: HTMLElement, touch: Touch) => {
      // 1. Feedback Haptique (Vibration)
      if (navigator.vibrate) {
        navigator.vibrate(50);
      }

      // 2. Simulation d'événements pour le système existant
      const eventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: touch.clientX,
        clientY: touch.clientY,
        screenX: touch.screenX,
        screenY: touch.screenY,
        button: 2, // Bouton Droit (Magique !)
        buttons: 2,
        pointerType: 'touch'
      };

      // A. Pour le Canvas ArrangementView (qui écoute onMouseDown / handlePointerDown)
      // On simule un mousedown avec le bouton droit
      const mouseDownEvent = new MouseEvent('mousedown', eventOptions);
      target.dispatchEvent(mouseDownEvent);

      // B. Pour les Menus Globaux (App.tsx qui écoute 'contextmenu')
      // On simule le vrai événement contextmenu
      const contextMenuEvent = new MouseEvent('contextmenu', eventOptions);
      target.dispatchEvent(contextMenuEvent);
    };

    const handleTouchStart = (e: TouchEvent) => {
      // On ignore le multitouch pour les interactions contextuelles
      if (e.touches.length > 1) return;

      const touch = e.touches[0];
      const now = Date.now();
      const currentPos = { x: touch.clientX, y: touch.clientY };

      startPosRef.current = currentPos;
      isLongPressTriggered.current = false;

      // --- LOGIQUE DOUBLE TAP ---
      if (lastTapRef.current) {
        const timeDiff = now - lastTapRef.current.time;
        const dist = Math.sqrt(
            Math.pow(currentPos.x - lastTapRef.current.x, 2) + 
            Math.pow(currentPos.y - lastTapRef.current.y, 2)
        );

        if (timeDiff < DOUBLE_TAP_DELAY && dist < TAP_DISTANCE_THRESHOLD) {
            // C'est un Double Tap valide !
            // On empêche le comportement par défaut (zoom, sélection)
            if (e.cancelable) e.preventDefault(); 
            
            triggerRightClick(e.target as HTMLElement, touch);
            
            // Reset complet pour éviter un triple tap confus
            lastTapRef.current = null;
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            return;
        }
      }

      // Enregistrement du tap actuel pour la prochaine fois
      lastTapRef.current = { time: now, x: currentPos.x, y: currentPos.y };

      // --- LOGIQUE LONG PRESS ---
      timerRef.current = window.setTimeout(() => {
        isLongPressTriggered.current = true;
        triggerRightClick(e.target as HTMLElement, touch);
      }, LONG_PRESS_DURATION);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!startPosRef.current) return;

      const touch = e.touches[0];
      const dx = Math.abs(touch.clientX - startPosRef.current.x);
      const dy = Math.abs(touch.clientY - startPosRef.current.y);

      // Si on bouge trop, ce n'est plus un appui long ni un tap statique
      if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
        cancelLongPress();
      }
    };

    const handleTouchEnd = () => {
      cancelLongPress();
    };

    const cancelLongPress = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      startPosRef.current = null;
    };

    // Ajout des écouteurs globaux
    // passive: false est CRITIQUE pour pouvoir faire e.preventDefault() sur le double tap
    document.addEventListener('touchstart', handleTouchStart, { passive: false });
    document.addEventListener('touchmove', handleTouchMove, { passive: true });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });
    document.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, []);

  return null; // Composant logique pure, pas de rendu visuel
};

export default TouchInteractionManager;
