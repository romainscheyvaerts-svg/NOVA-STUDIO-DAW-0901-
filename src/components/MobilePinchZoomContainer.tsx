import React, { useRef, useState, useEffect, useCallback } from 'react';

interface MobilePinchZoomContainerProps {
  children: React.ReactNode;
  minScale?: number;
  maxScale?: number;
  className?: string;
}

/**
 * Container that enables pinch-to-zoom and pan gestures on mobile devices
 */
const MobilePinchZoomContainer: React.FC<MobilePinchZoomContainerProps> = ({
  children,
  minScale = 0.5,
  maxScale = 3,
  className = ''
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  // Touch tracking
  const touchStartRef = useRef<{ x: number; y: number; scale: number; distance: number } | null>(null);
  const lastPositionRef = useRef({ x: 0, y: 0 });

  const getDistance = (touch1: Touch, touch2: Touch) => {
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const getCenter = (touch1: Touch, touch2: Touch) => {
    return {
      x: (touch1.clientX + touch2.clientX) / 2,
      y: (touch1.clientY + touch2.clientY) / 2
    };
  };

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (e.touches.length === 2) {
      // Pinch gesture start
      e.preventDefault();
      const distance = getDistance(e.touches[0], e.touches[1]);
      const center = getCenter(e.touches[0], e.touches[1]);
      touchStartRef.current = {
        x: center.x - position.x,
        y: center.y - position.y,
        scale: scale,
        distance: distance
      };
      setIsDragging(true);
    } else if (e.touches.length === 1 && scale > 1) {
      // Pan gesture start (only when zoomed in)
      e.preventDefault();
      touchStartRef.current = {
        x: e.touches[0].clientX - position.x,
        y: e.touches[0].clientY - position.y,
        scale: scale,
        distance: 0
      };
      setIsDragging(true);
    }
  }, [position, scale]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!touchStartRef.current) return;

    if (e.touches.length === 2) {
      // Pinch gesture
      e.preventDefault();
      const distance = getDistance(e.touches[0], e.touches[1]);
      const center = getCenter(e.touches[0], e.touches[1]);

      // Calculate new scale
      const scaleChange = distance / touchStartRef.current.distance;
      let newScale = touchStartRef.current.scale * scaleChange;
      newScale = Math.min(Math.max(newScale, minScale), maxScale);

      // Calculate new position to zoom towards center
      const newX = center.x - touchStartRef.current.x * (newScale / touchStartRef.current.scale);
      const newY = center.y - touchStartRef.current.y * (newScale / touchStartRef.current.scale);

      setScale(newScale);
      setPosition({ x: newX, y: newY });
      lastPositionRef.current = { x: newX, y: newY };
    } else if (e.touches.length === 1 && scale > 1) {
      // Pan gesture
      e.preventDefault();
      const newX = e.touches[0].clientX - touchStartRef.current.x;
      const newY = e.touches[0].clientY - touchStartRef.current.y;

      setPosition({ x: newX, y: newY });
      lastPositionRef.current = { x: newX, y: newY };
    }
  }, [scale, minScale, maxScale]);

  const handleTouchEnd = useCallback(() => {
    touchStartRef.current = null;
    setIsDragging(false);

    // Reset position if scale is 1 or less
    if (scale <= 1) {
      setPosition({ x: 0, y: 0 });
      lastPositionRef.current = { x: 0, y: 0 };
    }
  }, [scale]);

  // Double tap to reset zoom
  const lastTapRef = useRef(0);
  const handleDoubleTap = useCallback((e: TouchEvent) => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      // Double tap detected - toggle between 1x and 2x
      e.preventDefault();
      if (scale > 1.1) {
        setScale(1);
        setPosition({ x: 0, y: 0 });
      } else {
        setScale(2);
        // Zoom towards tap point
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const tapX = e.touches[0]?.clientX ?? e.changedTouches[0]?.clientX ?? rect.width / 2;
          const tapY = e.touches[0]?.clientY ?? e.changedTouches[0]?.clientY ?? rect.height / 2;
          setPosition({
            x: (rect.width / 2 - tapX),
            y: (rect.height / 2 - tapY)
          });
        }
      }
    }
    lastTapRef.current = now;
  }, [scale]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('touchstart', handleTouchStart, { passive: false });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd);
    container.addEventListener('touchend', handleDoubleTap);

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchend', handleDoubleTap);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd, handleDoubleTap]);

  return (
    <div
      ref={containerRef}
      className={`overflow-hidden touch-none ${className}`}
      style={{ touchAction: 'none' }}
    >
      <div
        ref={contentRef}
        className="origin-center transition-transform duration-75"
        style={{
          transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
          transformOrigin: 'center center',
          transition: isDragging ? 'none' : 'transform 0.1s ease-out'
        }}
      >
        {children}
      </div>

      {/* Zoom indicator */}
      {scale !== 1 && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-black/70 text-white px-3 py-1.5 rounded-full text-xs font-bold z-50 backdrop-blur-sm">
          {Math.round(scale * 100)}%
        </div>
      )}
    </div>
  );
};

export default MobilePinchZoomContainer;
