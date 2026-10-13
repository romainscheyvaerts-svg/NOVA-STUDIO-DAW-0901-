import React, { useEffect, useId, useMemo, useRef } from 'react';
import { useHwHelp } from './help';

/**
 * VU-mètre à aiguille sur cadran crème (SVG), zone rouge, repère de cible.
 *
 * Balistique VU (reprise de l'ancien GrVuMeter) : 2e ordre amorti critique,
 * constante 45 ms → 99 % en ~300 ms ; maximum tenu 3 s.
 * L'aiguille est animée par une boucle requestAnimationFrame qui écrit
 * directement dans le SVG (aucun rendu React par image : la façade ne bouge pas).
 *
 * Échelle d'un vrai VU : la position suit la tension (10^(dB/20)), 0 VU vers
 * 71 % de la course et +3 VU au bout. En mode « gr » (réduction de gain),
 * l'aiguille repose sur 0 et part vers la gauche de la réduction en dB.
 */
export interface VuMeterProps {
  /** Lit la mesure à chaque image : réduction de gain (dB ≥ 0) en mode « gr », niveau VU (dB) en mode « vu ». */
  read: () => number;
  mode?: 'gr' | 'vu';
  /** Cible du calage (dB de réduction) : petit repère sur l'échelle. */
  target?: number;
  /** Mention sous « VU » (ex. « Réduction de gain »). */
  caption?: string;
  /** Couleur du repère de cible. */
  targetColor?: string;
  /** Petit écran sous le cadran : valeur et maximum tenu. */
  readout?: boolean;
  /** Teinte du cadran : crème chaud (défaut) ou ambre (éclairage plus jaune). */
  tint?: 'cream' | 'amber' | 'white';
  hint?: string;
  /** Attributs de données sur la racine (ex. { 'data-nova-gr-vu': '' }). */
  dataAttrs?: Record<string, string>;
  className?: string;
  style?: React.CSSProperties;
}

const fr = (v: number, d = 1) => v.toFixed(d).replace('.', ',');
const P_MAX = Math.pow(10, 3 / 20);
/** Position 0..1 d'une valeur en dB VU sur l'échelle. */
export const vuPos = (db: number) => Math.max(0, Math.min(1, Math.pow(10, db / 20) / P_MAX));
const SWEEP = 47;
const PIV = { x: 100, y: 132 };
const ang = (p: number) => -SWEEP + p * 2 * SWEEP;
const polar = (deg: number, r: number) => { const a = (deg * Math.PI) / 180; return [PIV.x + Math.sin(a) * r, PIV.y - Math.cos(a) * r] as const; };

const TINTS = {
  cream: ['#fbf3d6', '#efe0b0', '#d9c48d'],
  amber: ['#ffe8b0', '#f6cf7c', '#d9a64e'],
  white: ['#ffffff', '#eef0f2', '#d3d7dc'],
} as const;

export const VuMeter: React.FC<VuMeterProps> = ({ read, mode = 'gr', target, caption, targetColor = '#1e5f8c', readout, tint = 'cream', hint, dataAttrs, className, style }) => {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const needle = useRef<SVGGElement | null>(null);
  const lcd = useRef<HTMLSpanElement | null>(null);
  const lcdMax = useRef<HTMLSpanElement | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const help = useHwHelp(uid, caption || 'VU-mètre', hint, undefined);

  useEffect(() => {
    let raf = 0;
    const s = { v: 0, d: 0, t: 0, hold: 0, holdAt: 0, lastA: 999, lastTxt: 0 };
    const loop = (t: number) => {
      const dt = s.t ? Math.min(0.1, (t - s.t) / 1000) : 0;
      s.t = t;
      let g = 0;
      try { g = +readRef.current() || 0; } catch { g = 0; }
      if (mode === 'gr') g = Math.max(0, g);
      // 2e ordre critique, constante 45 ms : 99 % en ~300 ms (VU)
      if (dt > 0) {
        const tau = 0.045;
        const a = (g - s.v) / (tau * tau) - 2 * s.d / tau;
        s.d += a * dt; s.v += s.d * dt;
        if (mode === 'gr' && s.v < 0) { s.v = 0; s.d = 0; }
      }
      if (s.v > s.hold || t - s.holdAt > 3000) { s.hold = s.v; s.holdAt = t; }
      const p = mode === 'gr' ? vuPos(-s.v) : vuPos(s.v);
      const a = ang(p);
      if (needle.current && Math.abs(a - s.lastA) > 0.04) {
        needle.current.setAttribute('transform', `rotate(${a.toFixed(2)} ${PIV.x} ${PIV.y})`);
        s.lastA = a;
      }
      if (readout && t - s.lastTxt > 100) {
        s.lastTxt = t;
        if (lcd.current) lcd.current.textContent = mode === 'gr' ? `${s.v > 0.05 ? '−' : ''}${fr(Math.max(0, s.v))} dB` : `${fr(s.v)} VU`;
        if (lcdMax.current) lcdMax.current.textContent = mode === 'gr' ? `max ${fr(s.hold)} dB` : `max ${fr(s.hold)}`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mode, readout]);

  const face = useMemo(() => {
    const els: React.ReactNode[] = [];
    const marks: [number, string][] = [[-20, '20'], [-10, '10'], [-7, '7'], [-5, '5'], [-3, '3'], [-2, '2'], [-1, '1'], [0, '0'], [1, '1'], [2, '2'], [3, '3']];
    const minors = [-15, -8, -6, -4, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5];
    // Arc de l'échelle et zone rouge
    const arcD = (p0: number, p1: number, r: number) => {
      const [x0, y0] = polar(ang(p0), r), [x1, y1] = polar(ang(p1), r);
      return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    };
    els.push(<path key="arc" d={arcD(0, vuPos(0), 96)} fill="none" stroke="#1d1814" strokeWidth={1.1} />);
    els.push(<path key="red" d={arcD(vuPos(0), 1, 97.6)} fill="none" stroke="#c0331f" strokeWidth={4.2} />);
    els.push(<path key="redl" d={arcD(vuPos(0), 1, 96)} fill="none" stroke="#c0331f" strokeWidth={1.1} />);
    for (const [db, lab] of marks) {
      const p = vuPos(db), a = ang(p);
      const [x0, y0] = polar(a, 96), [x1, y1] = polar(a, 104);
      const red = db > 0;
      els.push(<line key={`t${db}`} x1={x0} y1={y0} x2={x1} y2={y1} stroke={red ? '#c0331f' : '#1d1814'} strokeWidth={1.3} />);
      const [lx, ly] = polar(a, 112);
      els.push(<text key={`l${db}`} x={lx} y={ly} fontSize={db === 0 ? 9.5 : 8.2} fontWeight={db === 0 ? 800 : 600} fill={red || db === 0 ? '#b12a17' : '#1d1814'}
        textAnchor="middle" dominantBaseline="central" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>{lab}</text>);
    }
    for (const db of minors) {
      const a = ang(vuPos(db));
      const [x0, y0] = polar(a, 96), [x1, y1] = polar(a, 100.5);
      els.push(<line key={`m${db}`} x1={x0} y1={y0} x2={x1} y2={y1} stroke={db > 0 ? '#c0331f' : '#1d1814'} strokeWidth={0.8} />);
    }
    const [mx, my] = polar(ang(0) - 4, 112), [px, py] = polar(ang(1) + 6.5, 109);
    els.push(<text key="minus" x={mx} y={my - 2} fontSize={12} fontWeight={700} fill="#1d1814" textAnchor="middle" dominantBaseline="central">−</text>);
    els.push(<text key="plus" x={px} y={py - 2} fontSize={12} fontWeight={700} fill="#b12a17" textAnchor="middle" dominantBaseline="central">+</text>);
    return els;
  }, []);

  const targetMark = useMemo(() => {
    if (target === undefined || !(target > 0)) return null;
    const a = ang(mode === 'gr' ? vuPos(-target) : vuPos(target));
    const [x0, y0] = polar(a, 86), [x1, y1] = polar(a, 94);
    const [tx, ty] = polar(a, 79);
    return (
      <g>
        <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={targetColor} strokeWidth={2.4} strokeLinecap="round" />
        <circle cx={x0} cy={y0} r={2} fill={targetColor} />
        <text x={tx} y={ty} fontSize={6.4} fontWeight={800} fill={targetColor} textAnchor="middle" dominantBaseline="central"
          style={{ fontFamily: 'Inter, system-ui, sans-serif', letterSpacing: '0.06em' }}>CIBLE</text>
      </g>
    );
  }, [target, mode, targetColor]);

  const tc = TINTS[tint];
  return (
    <div className={`hw-vu${className ? ` ${className}` : ''}`} style={style} {...(dataAttrs || {})} title={hint}
      onPointerEnter={help.onPointerEnter} onPointerLeave={help.onPointerLeave}>
      <div className="hw-vu-bezel">
        <svg viewBox="0 0 200 118" role="img" aria-label={`${caption || 'VU-mètre'}${target ? ` (cible ${fr(target, 0)} dB)` : ''}`}>
          <defs>
            <radialGradient id={`${uid}lamp`} cx="0.5" cy="1.05" r="1.05">
              <stop offset="0" stopColor={tc[0]} />
              <stop offset="0.6" stopColor={tc[1]} />
              <stop offset="1" stopColor={tc[2]} />
            </radialGradient>
            <linearGradient id={`${uid}glass`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0.38" />
              <stop offset="0.45" stopColor="#fff" stopOpacity="0.06" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="200" height="118" fill={`url(#${uid}lamp)`} />
          {face}
          {targetMark}
          <text x="100" y="74" fontSize="17" fontWeight="700" fill="#1d1814" textAnchor="middle" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>VU</text>
          {caption && <text x="100" y="89" fontSize="6.6" fontWeight="800" fill="#4a3f33" textAnchor="middle" style={{ fontFamily: 'Inter, system-ui, sans-serif', letterSpacing: '0.16em' }}>{caption.toUpperCase()}</text>}
          <g ref={needle} transform={`rotate(${ang(mode === 'gr' ? vuPos(0) : vuPos(-20))} ${PIV.x} ${PIV.y})`}>
            <line x1={PIV.x + 2.2} y1={PIV.y + 2} x2={PIV.x + 2.2} y2={PIV.y - 104} stroke="#000" strokeOpacity="0.16" strokeWidth="1.6" />
            <line x1={PIV.x} y1={PIV.y} x2={PIV.x} y2={PIV.y - 106} stroke="#151210" strokeWidth="1.25" strokeLinecap="round" />
          </g>
          <path d="M 64 118 C 70 101 84 96 100 96 C 116 96 130 101 136 118 Z" fill="#231f1b" />
          <path d="M 70 118 C 76 104 88 100 100 100 C 112 100 124 104 130 118" fill="none" stroke="#fff" strokeOpacity="0.08" strokeWidth="1" />
          <rect x="0" y="0" width="200" height="118" fill={`url(#${uid}glass)`} />
          <path d="M 0 0 L 200 0 L 200 9 C 140 15 60 15 0 9 Z" fill="#fff" opacity="0.07" />
        </svg>
      </div>
      {readout && (
        <div className="hw-vu-readout">
          <span className="hw-lcd hw-lcd-amber" aria-hidden="true"><span ref={lcd}>{mode === 'gr' ? '0,0 dB' : '0,0 VU'}</span><small ref={lcdMax}>max 0,0 dB</small></span>
        </div>
      )}
    </div>
  );
};

export default VuMeter;
