import React, { useLayoutEffect, useRef, useState } from 'react';

/**
 * Réduit son contenu pour qu'il tienne dans la largeur de l'écran (téléphone).
 *
 * Les interfaces de plugins et d'instruments ont des largeurs fixes (480 à
 * 900 px). Un `transform: scale()` ne réduit pas la boîte de mise en page : le
 * contenu centré débordait des deux côtés et ses bords étaient inatteignables.
 * `zoom` réduit aussi la boîte (Safari, Chrome, Firefox ≥ 126).
 */
const FitToWidth: React.FC<{ children: React.ReactNode; padding?: number }> = ({ children, padding = 16 }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      // Largeur naturelle = largeur affichée / zoom courant
      const natural = el.scrollWidth / (parseFloat(el.style.zoom || '1') || 1);
      if (!natural) return;
      setZoom(Math.min(1, (window.innerWidth - padding) / natural));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [padding]);

  return (
    <div ref={ref} className="mx-auto w-max" style={{ zoom }}>
      {children}
    </div>
  );
};

export default FitToWidth;
