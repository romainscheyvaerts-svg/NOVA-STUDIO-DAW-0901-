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
      // Largeur naturelle mesurée sans zoom : selon le navigateur, scrollWidth
      // est déjà corrigé du zoom ou non ; diviser par le zoom faisait boucler la
      // mesure (zoom 1e-12, éditeur d'effet invisible sur téléphone, 07/10/2026).
      const prev = el.style.zoom;
      el.style.zoom = '1';
      const natural = el.scrollWidth;
      el.style.zoom = prev;
      if (!natural) return;
      const next = Math.max(0.2, Math.min(1, (window.innerWidth - padding) / natural));
      setZoom(z => (Math.abs(z - next) < 0.001 ? z : next));
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
