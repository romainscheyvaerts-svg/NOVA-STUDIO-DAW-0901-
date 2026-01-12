import React, { useEffect, useRef } from 'react';

interface TouchInteractionManagerProps {
  children: React.ReactNode;
  onPinchZoom?: (scale: number, centerX: number, centerY: number) => void;
  onSwipe?: (direction: 'left' | 'right' | 'up' | 'down') => void;
}

const TouchInteractionManager: React.FC<TouchInteractionManagerProps> = ({
  children,
  onPinchZoom,
  onSwipe
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number; distance: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const getDistance = (touches: TouchList): number => {
      if (touches.length < 2) return 0;
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        touchStartRef.current = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
          distance: getDistance(e.touches)
        };
      } else if (e.touches.length === 1) {
        touchStartRef.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          distance: 0
        };
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!touchStartRef.current) return;

      if (e.touches.length === 2 && onPinchZoom) {
        const currentDistance = getDistance(e.touches);
        const scale = currentDistance / touchStartRef.current.distance;
        const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        onPinchZoom(scale, centerX, centerY);
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!touchStartRef.current || e.touches.length > 0) return;

      if (touchStartRef.current.distance === 0 && onSwipe) {
        const dx = e.changedTouches[0].clientX - touchStartRef.current.x;
        const dy = e.changedTouches[0].clientY - touchStartRef.current.y;
        const minSwipe = 50;

        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > minSwipe) {
          onSwipe(dx > 0 ? 'right' : 'left');
        } else if (Math.abs(dy) > minSwipe) {
          onSwipe(dy > 0 ? 'down' : 'up');
        }
      }

      touchStartRef.current = null;
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('touchend', handleTouchEnd);

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, [onPinchZoom, onSwipe]);

  return (
    <div ref={containerRef} className="w-full h-full">
      {children}
    </div>
  );
};

export default TouchInteractionManager;
