import React, { useEffect } from 'react';
import { BottomSheetState } from '../../hooks/useBottomSheet';

interface MobileBottomSheetProps {
  isOpen: boolean;
  state: BottomSheetState;
  onClose: () => void;
  onTouchStart?: (e: React.TouchEvent) => void;
  onTouchMove?: (e: React.TouchEvent) => void;
  onTouchEnd?: (e: React.TouchEvent) => void;
  height: number;
  isDragging?: boolean;
  children: React.ReactNode;
  title?: string;
}

/**
 * Generic reusable bottom sheet component with drag gestures
 * Supports 3 states: closed, half (50%), full screen
 */
const MobileBottomSheet: React.FC<MobileBottomSheetProps> = ({
  isOpen,
  state,
  onClose,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  height,
  isDragging,
  children,
  title,
}) => {
  // Prevent body scroll when sheet is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop overlay */}
      <div
        className={`fixed inset-0 bg-black/60 backdrop-blur-sm z-[150] transition-opacity duration-300 ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
      />

      {/* Bottom Sheet */}
      <div
        className="fixed bottom-0 left-0 right-0 bg-[#0c0d10] rounded-t-3xl shadow-2xl z-[200] flex flex-col"
        style={{
          height: `${height}px`,
          transform: isDragging ? 'none' : undefined,
          transition: isDragging ? 'none' : 'height 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
          willChange: 'height, transform',
        }}
      >
        {/* Drag Handle */}
        <div
          className="flex-shrink-0 py-3 flex flex-col items-center cursor-grab active:cursor-grabbing touch-none"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <div className="w-12 h-1.5 bg-white/20 rounded-full" />
          
          {title && (
            <h2 className="text-white font-bold text-lg mt-3">{title}</h2>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>

        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors z-10"
        >
          <i className="fas fa-times text-white text-sm"></i>
        </button>
      </div>
    </>
  );
};

export default MobileBottomSheet;
