import React, { useEffect, useRef, useState } from 'react';
import { cachedImageUrl } from '../utils/imageCache';

type Props = Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string | null | undefined;
  /** Visuel affiché tant que la pochette n'est pas là (ou si elle est indisponible). */
  fallback: string;
};

/**
 * Pochette du catalogue : demandée seulement quand la carte approche de l'écran,
 * puis servie depuis le cache durable (utils/imageCache) — plus jamais
 * retéléchargée à chaque visite.
 */
const CachedImage: React.FC<Props> = ({ src, fallback, ...rest }) => {
  const ref = useRef<HTMLImageElement>(null);
  const [shown, setShown] = useState<string>(src && !/^https?:\/\//.test(src) ? src : fallback);

  useEffect(() => {
    if (!src) { setShown(fallback); return; }
    if (!/^https?:\/\//.test(src)) { setShown(src); return; }
    let alive = true;
    const go = () => { void cachedImageUrl(src).then(u => { if (alive) setShown(u || fallback); }); };
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { go(); return () => { alive = false; }; }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { io.disconnect(); go(); }
    }, { rootMargin: '300px' });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [src, fallback]);

  return <img ref={ref} src={shown} decoding="async" onError={() => setShown(fallback)} {...rest} />;
};

export default CachedImage;
