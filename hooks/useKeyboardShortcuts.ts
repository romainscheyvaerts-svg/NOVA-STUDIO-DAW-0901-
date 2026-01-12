import { useEffect, useCallback } from 'react';

/**
 * Defines a keyboard shortcut action
 */
export interface ShortcutAction {
  /** The key to trigger the shortcut (e.g., 'a', ' ', 'Enter', 'ArrowUp') */
  key: string;
  
  /** Whether Ctrl (Windows/Linux) or Cmd (Mac) key must be pressed */
  ctrl?: boolean;
  
  /** Whether Shift key must be pressed */
  shift?: boolean;
  
  /** Whether Alt key must be pressed */
  alt?: boolean;
  
  /** Reserved for future use - currently equivalent to ctrl */
  meta?: boolean;
  
  /** The function to execute when the shortcut is triggered */
  action: () => void;
  
  /** Human-readable description of what the shortcut does */
  description: string;
  
  /** Category for grouping shortcuts in UI (e.g., 'Transport', 'Editing') */
  category: string;
  
  /** Whether to prevent the browser's default behavior for this key combination. Defaults to true. */
  preventBrowserDefault?: boolean;
}

/**
 * Custom hook for handling keyboard shortcuts in the DAW
 * 
 * Features:
 * - Automatically ignores shortcuts when typing in input/textarea elements
 * - Treats Ctrl and Cmd (Meta) keys as equivalent for cross-platform support
 * - Prevents default browser behavior for registered shortcuts
 * - Can be disabled when modals are open
 * 
 * @param shortcuts Array of shortcut definitions to register
 * @param enabled Whether shortcuts should be active (set to false when modals are open)
 * 
 * @example
 * ```tsx
 * const shortcuts = useMemo(() => [
 *   {
 *     key: ' ',
 *     action: () => handlePlay(),
 *     description: 'Play/Pause',
 *     category: 'Transport'
 *   },
 *   {
 *     key: 's',
 *     ctrl: true,
 *     action: () => handleSave(),
 *     description: 'Save Project',
 *     category: 'Files'
 *   }
 * ], [handlePlay, handleSave]);
 * 
 * useKeyboardShortcuts(shortcuts, !isModalOpen);
 * ```
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
