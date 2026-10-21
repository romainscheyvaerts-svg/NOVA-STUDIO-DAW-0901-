import React, { useEffect, useMemo, useRef } from 'react';
import { cancelUiFrame, requestUiFrame } from '../../utils/uiFrame';

/**
 * Échelle de LED (réduction de gain, crête de sortie…), horizontale ou
 * verticale. Comme le VuMeter, elle s'anime hors React : une boucle rAF
 * allume les segments et écrit la valeur dans l'afficheur, sans redessiner la
 * façade.
 */
export interface SegmentMeterProps {
  /** Lit la mesure à chaque image (unité libre, ex. dB de réduction ≥ 0). */
  read: () => number;
  /** Bornes de l'échelle (la mesure est bornée). */
  min?: number;
  max: number;
  segments?: number;
  orientation?: 'horizontal' | 'vertical';
  /** Couleur d'un segment selon sa valeur (haut de segment). */
  colorAt?: (v: number) => string;
  /** Maximum tenu (ms) affiché comme un segment isolé ; 0 = aucun. */
  holdMs?: number;
  /** Retour lent (dB/s) quand la mesure baisse ; 0 = instantané. */
  fallPerSec?: number;
  /** Repère fixe (ex. plafond) : valeur sur l'échelle. */
  marker?: number;
  /** Graduations sous l'échelle (valeurs). */
  scale?: { v: number; label: string }[];
  /** Afficheur : texte de la valeur (tenue) ; absent = pas d'afficheur. */
  format?: (v: number, hold: number) => string;
  /** Attributs de l'afficheur (ex. { 'data-nova-limiter': 'gr' }). */
  readoutAttrs?: Record<string, string>;
  label?: string;
  hint?: string;
  /** Sens de remplissage : depuis le bas / la gauche (défaut) ou depuis le haut / la droite. */
  reverse?: boolean;
  length?: number | string;
  className?: string;
}

export const SegmentMeter: React.FC<SegmentMeterProps> = ({
  read, min = 0, max, segments = 20, orientation = 'horizontal', colorAt = () => '#ff4b2b', holdMs = 1500, fallPerSec = 0,
  marker, scale, format, readoutAttrs, label, hint, reverse, length, className,
}) => {
  const segRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const readout = useRef<HTMLSpanElement | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const fmtRef = useRef(format);
  fmtRef.current = format;
  const tops = useMemo(() => Array.from({ length: segments }, (_, i) => min + ((i + 1) / segments) * (max - min)), [segments, min, max]);

  useEffect(() => {
    let raf = 0;
    const st = { v: min, t: 0, hold: min, holdAt: 0, lit: -1, holdIdx: -1, txtAt: 0, txt: '' };
    const loop = (t: number) => {
      const dt = st.t ? Math.min(0.1, (t - st.t) / 1000) : 0;
      st.t = t;
      let x = min;
      try { x = +readRef.current(); } catch { x = min; }
      if (!Number.isFinite(x)) x = min;
      x = Math.max(min, Math.min(max, x));
      st.v = fallPerSec > 0 && x < st.v ? Math.max(x, st.v - fallPerSec * dt) : x;
      if (st.v >= st.hold || t - st.holdAt > holdMs) { st.hold = st.v; st.holdAt = t; }
      const lit = tops.findIndex(tp => tp > st.v + 1e-9);
      const n = lit < 0 ? segments : lit;
      const holdIdx = holdMs > 0 ? Math.max(0, (() => { const k = tops.findIndex(tp => tp >= st.hold - 1e-9); return k < 0 ? segments - 1 : k; })()) : -1;
      if (n !== st.lit || holdIdx !== st.holdIdx) {
        segRefs.current.forEach((el, i) => {
          if (!el) return;
          const on = i < n || (holdMs > 0 && i === holdIdx && st.hold > min + 1e-6);
          if ((el.dataset.on === 'true') !== on) el.dataset.on = on ? 'true' : 'false';
        });
        st.lit = n; st.holdIdx = holdIdx;
      }
      if (readout.current && fmtRef.current && t - st.txtAt > 90) {
        st.txtAt = t;
        const txt = fmtRef.current(st.v, st.hold);
        if (txt !== st.txt) { readout.current.textContent = txt; st.txt = txt; }
      }
      raf = requestUiFrame(loop);
    };
    raf = requestUiFrame(loop);
    return () => cancelUiFrame(raf);
  }, [min, max, segments, tops, holdMs, fallPerSec]);

  const vertical = orientation === 'vertical';
  const pos = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  return (
    <div className={`hw-seg${vertical ? ' hw-seg-v' : ''}${className ? ` ${className}` : ''}`} title={hint}>
      {label && <div className="hw-silk">{label}</div>}
      <div className="hw-seg-body">
      <div className="hw-seg-track" style={vertical ? { height: length ?? 160 } : { width: length ?? '100%' }}>
        <div className="hw-seg-cells" style={{ flexDirection: vertical ? (reverse ? 'column' : 'column-reverse') : (reverse ? 'row-reverse' : 'row') }}>
          {tops.map((tp, i) => (
            <span key={i} ref={el => { segRefs.current[i] = el; }} className="hw-seg-cell" data-on="false" style={{ ['--seg' as any]: colorAt(tp) }} />
          ))}
        </div>
        {marker !== undefined && (
          <span className="hw-seg-marker" style={vertical ? { [reverse ? 'top' : 'bottom']: pos(marker) } : { [reverse ? 'right' : 'left']: pos(marker) }} />
        )}
      </div>
      {scale && (
        <div className="hw-seg-scale" style={vertical ? { height: length ?? 160 } : undefined}>
          {scale.map(s => (
            <span key={s.v} style={vertical ? { [reverse ? 'top' : 'bottom']: pos(s.v) } : { [reverse ? 'right' : 'left']: pos(s.v) }}>{s.label}</span>
          ))}
        </div>
      )}
      </div>
      {format && <span className="hw-lcd hw-seg-readout" {...(readoutAttrs || {})}><span ref={readout}>{format(min, min)}</span></span>}
    </div>
  );
};

export default SegmentMeter;
