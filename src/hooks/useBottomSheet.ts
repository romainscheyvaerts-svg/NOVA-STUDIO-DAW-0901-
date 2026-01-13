import { useState, useCallback, useRef, useEffect } from 'react';

export type BottomSheetState = 'closed' | 'half' | 'full';

interface UseBottomSheetOptions {
  onClose?: () => void;
  defaultState?: BottomSheetState;
}

/**
 * Hook to manage bottom sheet state and drag gestures
 */
export const useBottomSheet = (options: UseBottomSheetOptions = {}) => {
  const { onClose, defaultState = 'closed' } = options;
  
  const [state, setState] = useState<BottomSheetState>(defaultState);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  
  const touchStartRef = useRef<{ y: number; initialState: BottomSheetState } | null>(null);

  const open = useCallback((newState: BottomSheetState = 'half') => {
    setState(newState);
  }, []);

  const close = useCallback(() => {
    setState('closed');
    setDragOffset(0);
    if (onClose) onClose();
  }, [onClose]);

  const toggle = useCallback(() => {
    setState((prev) => {
      if (prev === 'closed') return 'half';
      if (prev === 'half') return 'full';
      return 'closed';
    });
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (state === 'closed') return;
    
    const touch = e.touches[0];
    touchStartRef.current = {
      y: touch.clientY,
      initialState: state
    };
    setIsDragging(true);
  }, [state]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current) return;

    const touch = e.touches[0];
    const deltaY = touch.clientY - touchStartRef.current.y;
    
    // Only allow dragging down
    if (deltaY > 0) {
      setDragOffset(deltaY);
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (!touchStartRef.current) return;

    const threshold = 100; // pixels to trigger state change
    
    if (dragOffset > threshold) {
      // Swiped down enough - go to next state
      if (state === 'full') {
        setState('half');
      } else if (state === 'half') {
        close();
      }
    }
    
    // Reset
    setIsDragging(false);
    setDragOffset(0);
    touchStartRef.current = null;
  }, [dragOffset, state, close]);

  const getHeight = useCallback(() => {
    const baseHeight = window.innerHeight;
    
    switch (state) {
      case 'full':
        return baseHeight - dragOffset;
      case 'half':
        return (baseHeight * 0.5) - dragOffset;
      case 'closed':
      default:
        return 0;
    }
  }, [state, dragOffset]);

  return {
    state,
    isOpen: state !== 'closed',
    isDragging,
    open,
    close,
    toggle,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    getHeight,
  };
};
