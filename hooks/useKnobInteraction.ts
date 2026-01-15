import { useCallback } from 'react';

/**
 * Hook pour gérer les interactions souris ET tactiles sur les potards (knobs)
 * Supporte drag vertical pour changer la valeur
 */
export const useKnobInteraction = (
  value: number,
  onChange: (newValue: number) => void,
  options: {
    min?: number;
    max?: number;
    sensitivity?: number; // pixels pour parcourir toute la plage
    disabled?: boolean;
  } = {}
) => {
  const {
    min = 0,
    max = 1,
    sensitivity = 200,
    disabled = false
  } = options;

  // Gestion souris
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();

    const startY = e.clientY;
    const startValue = value;
    const range = max - min;

    const onMouseMove = (m: MouseEvent) => {
      const deltaY = (startY - m.clientY) / sensitivity;
      const newValue = Math.max(min, Math.min(max, startValue + deltaY * range));
      onChange(newValue);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'default';
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'ns-resize';
  }, [value, onChange, min, max, sensitivity, disabled]);

  // Gestion tactile
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();

    const startY = e.touches[0].clientY;
    const startValue = value;
    const range = max - min;

    const onTouchMove = (t: TouchEvent) => {
      if (t.touches.length === 0) return;
      const deltaY = (startY - t.touches[0].clientY) / sensitivity;
      const newValue = Math.max(min, Math.min(max, startValue + deltaY * range));
      onChange(newValue);
    };

    const onTouchEnd = () => {
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };

    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);
  }, [value, onChange, min, max, sensitivity, disabled]);

  return {
    handleMouseDown,
    handleTouchStart
  };
};
