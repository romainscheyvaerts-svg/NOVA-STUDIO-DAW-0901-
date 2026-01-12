import { useEffect, useCallback } from 'react';

export interface ShortcutAction {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  action: () => void;
  description: string;
  category: string;
  preventBrowserDefault?: boolean;
}

/**
 * Custom hook for handling keyboard shortcuts in the DAW
 * @param shortcuts Array of shortcut definitions
 * @param enabled Whether shortcuts should be active (disable when modals are open)
 */
export const useKeyboardShortcuts = (shortcuts: ShortcutAction[], enabled: boolean = true) => {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Don't capture shortcuts if we're in an input field
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' || 
      target.tagName === 'TEXTAREA' || 
      target.isContentEditable
    ) {
      return;
    }

    // Find matching shortcut
    const shortcut = shortcuts.find(s => {
      // Handle special keys
      let keyMatch = false;
      if (s.key === ' ') {
        keyMatch = e.key === ' ' || e.code === 'Space';
      } else if (s.key === 'Enter') {
        keyMatch = e.key === 'Enter' || e.code === 'Enter';
      } else if (s.key === 'Escape') {
        keyMatch = e.key === 'Escape' || e.code === 'Escape';
      } else if (s.key === 'Delete' || s.key === 'Backspace') {
        keyMatch = e.key === s.key || e.code === s.key;
      } else if (s.key.startsWith('Arrow')) {
        keyMatch = e.key === s.key || e.code === s.key;
      } else if (s.key === 'Home' || s.key === 'End') {
        keyMatch = e.key === s.key;
      } else if (s.key === 'F2') {
        keyMatch = e.key === 'F2';
      } else {
        // Regular alphanumeric keys
        keyMatch = e.key.toLowerCase() === s.key.toLowerCase();
      }

      // Check modifiers - must match exactly
      const ctrlMatch = s.ctrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
      const shiftMatch = s.shift ? e.shiftKey : !e.shiftKey;
      const altMatch = s.alt ? e.altKey : !e.altKey;

      return keyMatch && ctrlMatch && shiftMatch && altMatch;
    });

    if (shortcut) {
      // Prevent default browser behavior if specified
      if (shortcut.preventBrowserDefault !== false) {
        e.preventDefault();
      }
      e.stopPropagation();
      
      try {
        shortcut.action();
      } catch (error) {
        console.error('Error executing shortcut action:', error);
      }
    }
  }, [shortcuts]);

  useEffect(() => {
    if (!enabled) return;
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown, enabled]);
};
