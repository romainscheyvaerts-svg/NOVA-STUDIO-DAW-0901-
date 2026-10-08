import React, { useCallback, useEffect, useState } from 'react';
import { OPEN_FEEDBACK_EVENT, OpenFeedbackOptions } from '../services/feedback';
import { recordAction } from '../utils/feedbackLog';
import { isFeedbackShortcut } from '../utils/feedbackShortcut';
import { MountWhenOpened } from '../utils/lazyPreload';

// La fenêtre (formulaire, historique, contexte) n'est chargée qu'à la 1re ouverture :
// elle sortait du paquet principal de chaque démarrage pour un usage rare.
const FeedbackModal = React.lazy(() => import('./FeedbackModal'));

/**
 * Hôte de « Signaler un bug / proposer une idée », monté une seule fois à la racine
 * (index.tsx) : écoute le menu, l'écran d'erreur et Ctrl+Maj+B.
 */
export const FeedbackHost: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [initial, setInitial] = useState<OpenFeedbackOptions | undefined>(undefined);
  useEffect(() => {
    const onOpen = (e: Event) => {
      setInitial({ ...((e as CustomEvent).detail || {}) });
      setOpen(true);
      recordAction('feedback:ouvrir');
    };
    const onKey = (e: KeyboardEvent) => {
      if (!isFeedbackShortcut(e)) return;
      // Éditeur de raccourcis en train de capturer une touche : ce n'est pas un signalement.
      if ((e.target as HTMLElement | null)?.closest?.('[data-keymap-capture]')) return;
      e.preventDefault(); e.stopPropagation();
      setOpen(o => { if (!o) { setInitial({}); recordAction('raccourci:nova.feedback'); } return !o; });
    };
    window.addEventListener(OPEN_FEEDBACK_EVENT, onOpen);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener(OPEN_FEEDBACK_EVENT, onOpen); window.removeEventListener('keydown', onKey, true); };
  }, []);
  const close = useCallback(() => setOpen(false), []);
  return <MountWhenOpened when={open}><FeedbackModal open={open} initial={initial} onClose={close} /></MountWhenOpened>;
};
