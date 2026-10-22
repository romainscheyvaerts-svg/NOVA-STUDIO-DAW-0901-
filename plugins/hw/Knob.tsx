import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { angleOf, fromNorm, nudge, quantize, toNorm, type KnobRange } from './knobMath';
import { useHwHelp } from './help';

/**
 * Bouton rotatif « matériel » (SVG) :
 *  - glisser vertical (souris, doigt, stylet : pointer events), Maj = réglage fin ;
 *  - double-clic / double tape = valeur par défaut ; molette ; flèches, Page, Début / Fin ;
 *  - course linéaire ou logarithmique, crans pour les choix discrets ;
 *  - tailles S / M / L / XL, capuchons chicken-head, argent, noir, crème, rouge, graphite ;
 *  - bulle de valeur pendant qu'on tourne, aide dans la ligne d'info ;
 *  - role="slider" + aria-valuemin / max / now / valuetext.
 */
export type KnobSize = 'S' | 'M' | 'L' | 'XL';
export type KnobCap = 'chicken' | 'silver' | 'black' | 'cream' | 'red' | 'graphite';

export interface KnobProps {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  curve?: 'lin' | 'log';
  /** Sélecteur à crans : la valeur ne prend que ces positions (étiquettes autour si `label`). */
  detents?: { v: number; label?: string }[];
  size?: KnobSize;
  cap?: KnobCap;
  /** Nom sérigraphié (au-dessus par défaut). */
  label?: string;
  labelPos?: 'top' | 'bottom' | 'none';
  /** Petite mention sous le bouton (unité…). */
  sub?: string;
  /** Graduations chiffrées autour du bouton. */
  scale?: { v: number; label: string }[];
  /** Graduations simples (sans chiffres), réparties sur la course ; 0 = aucune. */
  ticks?: number;
  /** Texte de la valeur (bulle, ligne d'info, aria-valuetext). */
  format?: (v: number) => string;
  /** Rôle du réglage (infobulle + ligne d'info). */
  hint?: string;
  /** Identifiant du réglage (data-nova-param). */
  paramId?: string;
  /** Arc de valeur depuis le centre (pan, gain ±). */
  bipolar?: boolean;
  /** Couleur de l'arc de valeur (style moderne) ; absent = pas d'arc. */
  arc?: string;
  /** Course totale en degrés (270 par défaut). */
  sweep?: number;
  disabled?: boolean;
  ariaLabel?: string;
  /** Champ natif masqué et synchronisé (accroche des scripts qui pilotent un input range). */
  nativeInput?: boolean;
  className?: string;
}

const CAPS: Record<KnobCap, { face: [string, string, string]; skirt?: [string, string]; line: string; knurl?: boolean }> = {
  chicken: { face: ['#4a4a4a', '#1c1c1c', '#050505'], line: '#f5f1e6' },
  silver: { face: ['#fbfbfb', '#c3c6ca', '#8b9095'], skirt: ['#a2a6ab', '#3a3d41'], line: '#141414', knurl: true },
  black: { face: ['#55585c', '#1e1f21', '#0a0a0b'], skirt: ['#333436', '#050505'], line: '#f4f4f2', knurl: true },
  cream: { face: ['#fffaf0', '#e6dcc2', '#b9ab88'], skirt: ['#c9bb98', '#6a5d44'], line: '#231d15' },
  red: { face: ['#ff8a76', '#c8392a', '#6e170e'], skirt: ['#7a1c12', '#2b0805'], line: '#ffffff' },
  graphite: { face: ['#6b7079', '#3a3e45', '#1f2226'], skirt: ['#2b2e33', '#0b0c0e'], line: '#f8fafc', knurl: true },
};

const fmtDefault = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');

const KnobImpl: React.FC<KnobProps> = (props) => {
  const {
    value, min, max, step, defaultValue, curve, detents, size = 'M', cap = 'black', label, labelPos = 'top', sub,
    scale, ticks, format = fmtDefault, hint, paramId, bipolar, arc, sweep = 270, disabled, ariaLabel, nativeInput, className,
  } = props;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const range: KnobRange = useMemo(() => ({ min, max, step, curve, detents }), [min, max, step, curve, detents]);
  const latest = useRef({ props, range });
  latest.current = { props, range };

  const v = Number.isFinite(value) ? value : (defaultValue ?? min);
  const norm = toNorm(range, v);
  const angle = angleOf(norm, sweep);
  const text = format(v);
  const name = ariaLabel || label || paramId || 'Réglage';

  const help = useHwHelp(uid, name, hint, text);

  // Bulle : visible pendant le glissement, et un instant après molette / clavier.
  const [active, setActive] = useState(false);
  const linger = useRef<number | undefined>(undefined);
  const flash = useCallback(() => {
    setActive(true);
    window.clearTimeout(linger.current);
    linger.current = window.setTimeout(() => setActive(false), 900);
  }, []);
  useEffect(() => () => window.clearTimeout(linger.current), []);

  const emit = useCallback((nv: number) => {
    const { props: p } = latest.current;
    if (!Number.isFinite(nv) || p.disabled) return;
    if (nv !== p.value) p.onChange(nv);
  }, []);

  const reset = useCallback(() => {
    const { props: p, range: r } = latest.current;
    if (p.disabled || p.defaultValue === undefined) return;
    emit(r.detents?.length ? fromNorm(r, toNorm(r, p.defaultValue)) : quantize(r, p.defaultValue));
    flash();
  }, [emit, flash]);

  // ── Glisser (pointer events : souris, doigt, stylet) ──
  const drag = useRef<{ id: number; y: number; n: number } | null>(null);
  const lastTap = useRef(0);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (latest.current.props.disabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    boxRef.current?.focus({ preventScroll: true });
    help.show();
    // Alt+clic : valeur d'origine (comme dans les DAW), sans glissement.
    if (e.altKey) { reset(); return; }
    if (e.pointerType !== 'mouse') {
      const now = performance.now();
      if (now - lastTap.current < 320) { lastTap.current = 0; reset(); return; }
      lastTap.current = now;
    }
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointeur déjà relâché */ }
    drag.current = { id: e.pointerId, y: e.clientY, n: toNorm(latest.current.range, latest.current.props.value) };
    setActive(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = d.y - e.clientY;
    d.y = e.clientY;
    const r = latest.current.range;
    const travel = e.pointerType === 'mouse' ? 200 : 240;
    // Crans : course plus courte par position (un cran tous les ~28 px).
    const span = r.detents && r.detents.length > 1 ? Math.min(travel, 28 * (r.detents.length - 1)) : travel;
    d.n = Math.max(0, Math.min(1, d.n + (dy / span) * (e.shiftKey || e.ctrlKey || e.metaKey ? 0.1 : 1)));
    emit(fromNorm(r, d.n));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
    window.clearTimeout(linger.current);
    linger.current = window.setTimeout(() => setActive(false), 350);
  };

  // ── Molette (écouteur natif non passif : la page ne défile pas en même temps) ──
  const onWheel = useRef((w: WheelEvent) => {
    const { props: p, range: r } = latest.current;
    if (p.disabled || w.deltaY === 0) return;
    w.preventDefault();
    w.stopPropagation();
    emit(nudge(r, p.value, w.deltaY < 0 ? 1 : -1, { fine: w.shiftKey || w.ctrlKey || w.metaKey }));
    flash();
  });
  const setBox = useCallback((el: HTMLDivElement | null) => {
    if (boxRef.current) boxRef.current.removeEventListener('wheel', onWheel.current);
    boxRef.current = el;
    if (el) el.addEventListener('wheel', onWheel.current, { passive: false });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const { props: p, range: r } = latest.current;
    if (p.disabled) return;
    let next: number | null = null;
    const big = e.key === 'PageUp' || e.key === 'PageDown';
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'PageUp') next = nudge(r, p.value, 1, { fine: e.shiftKey, big });
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'PageDown') next = nudge(r, p.value, -1, { fine: e.shiftKey, big });
    else if (e.key === 'Home') next = r.detents?.length ? r.detents[0].v : r.min;
    else if (e.key === 'End') next = r.detents?.length ? r.detents[r.detents.length - 1].v : r.max;
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); reset(); return; }
    if (next === null) return;
    // La touche règle le bouton : elle ne déplace ni le curseur ni la sélection de piste.
    e.preventDefault();
    e.stopPropagation();
    emit(next);
    flash();
  };

  const labeled = !!(scale && scale.length) || !!(detents && detents.some(d => d.label));
  // Avec un arc de valeur, le capuchon rétrécit un peu pour laisser l'arc visible entre lui et les graduations.
  const g = labeled ? { rc: arc ? 26 : 28, t0: 31.5, t1: 34.5, t1M: 36.5, lab: 44 } : { rc: arc ? 33 : 36, t0: 39.5, t1: 42.5, t1M: 45 };
  // Chiffres de l'échelle : même taille à l'écran quelle que soit la taille du bouton.
  const labFont = size === 'XL' ? 7.4 : size === 'L' ? 8.8 : 10;

  // Graduations et chiffres : ne dépendent que de la géométrie (mémoïsés).
  const dial = useMemo(() => {
    const out: React.ReactNode[] = [];
    const pt = (deg: number, r: number) => { const a = (deg * Math.PI) / 180; return [Math.sin(a) * r, -Math.cos(a) * r]; };
    const majors = new Set<number>();
    const labels: { n: number; text: string }[] = [];
    if (detents && detents.length > 1) detents.forEach((d, i) => { const n = i / (detents.length - 1); majors.add(Math.round(n * 1000)); if (d.label) labels.push({ n, text: d.label }); });
    if (scale) scale.forEach(s => { const n = toNorm(range, s.v); majors.add(Math.round(n * 1000)); labels.push({ n, text: s.label }); });
    const count = detents && detents.length > 1 ? 0 : (ticks ?? 11);
    const minor: number[] = [];
    for (let i = 0; i < count; i++) minor.push(count === 1 ? 0.5 : i / (count - 1));
    for (const n of minor) {
      if (majors.has(Math.round(n * 1000))) continue;
      const a = angleOf(n, sweep);
      const [x0, y0] = pt(a, g.t0), [x1, y1] = pt(a, g.t1);
      out.push(<line key={`m${n}`} x1={x0} y1={y0} x2={x1} y2={y1} stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" opacity={0.75} />);
    }
    for (const k of majors) {
      const a = angleOf(k / 1000, sweep);
      const [x0, y0] = pt(a, g.t0), [x1, y1] = pt(a, g.t1M);
      out.push(<line key={`M${k}`} x1={x0} y1={y0} x2={x1} y2={y1} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />);
    }
    if ('lab' in g) {
      for (const l of labels) {
        const a = angleOf(l.n, sweep);
        const [x, y] = pt(a, (g as any).lab);
        const anchor = Math.abs(a) < 20 || Math.abs(Math.abs(a) - 180) < 20 ? 'middle' : a < 0 ? 'end' : 'start';
        const dx = anchor === 'end' ? 3.2 : anchor === 'start' ? -3.2 : 0;
        out.push(<text key={`t${l.n}${l.text}`} x={x + dx} y={y} fontSize={l.text.length > 3 ? labFont * 0.88 : labFont} fontWeight={700} fill="currentColor"
          textAnchor={anchor} dominantBaseline="central" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>{l.text}</text>);
      }
    }
    return out;
  }, [detents, scale, range, ticks, sweep, labeled, labFont]); // eslint-disable-line react-hooks/exhaustive-deps

  const c = CAPS[cap] || CAPS.black;
  const rc = g.rc;
  const arcPath = useMemo(() => {
    if (!arc) return null;
    const r = g.t0 - 2.4;
    const from = bipolar ? 0 : -sweep / 2;
    const to = angle;
    if (Math.abs(to - from) < 0.5) return null;
    const p = (deg: number) => { const a = (deg * Math.PI) / 180; return `${(Math.sin(a) * r).toFixed(2)} ${(-Math.cos(a) * r).toFixed(2)}`; };
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    const sweepFlag = to > from ? 1 : 0;
    return `M ${p(from)} A ${r} ${r} 0 ${large} ${sweepFlag} ${p(to)}`;
  }, [arc, bipolar, sweep, angle, g.t0]);

  const capSvg = cap === 'chicken' ? (
    <>
      <circle cx={1.2} cy={3} r={rc * 0.98} fill={`url(#${uid}sh)`} />
      <circle r={rc * 0.62} fill={`url(#${uid}fc)`} stroke="#000" strokeOpacity={0.6} strokeWidth={0.6} />
      <g transform={`rotate(${angle})`}>
        <path d={chickenPath(rc)} fill={`url(#${uid}fc)`} stroke="#000" strokeOpacity={0.7} strokeWidth={0.7} />
        <path d={chickenPath(rc * 0.9)} fill="none" stroke="#fff" strokeOpacity={0.08} strokeWidth={1} transform={`translate(0 ${-rc * 0.03})`} />
        <line x1={0} y1={-rc * 0.93} x2={0} y2={-rc * 0.2} stroke={c.line} strokeWidth={rc * 0.075} strokeLinecap="round" />
      </g>
      <ellipse cx={-rc * 0.12} cy={-rc * 0.2} rx={rc * 0.28} ry={rc * 0.16} fill="#fff" opacity={0.06} />
    </>
  ) : (
    <>
      <circle cx={1.4} cy={3.2} r={rc * 1.02} fill={`url(#${uid}sh)`} />
      <circle r={rc} fill={`url(#${uid}sk)`} stroke="#000" strokeOpacity={0.55} strokeWidth={0.7} />
      <g transform={`rotate(${angle})`}>
        {c.knurl && <g stroke="#000" strokeOpacity={0.3} strokeWidth={0.9}>
          {Array.from({ length: 40 }, (_, i) => { const a = (i / 40) * Math.PI * 2; return <line key={i} x1={Math.sin(a) * rc * 0.84} y1={Math.cos(a) * rc * 0.84} x2={Math.sin(a) * rc * 0.985} y2={Math.cos(a) * rc * 0.985} />; })}
        </g>}
        <line x1={0} y1={-rc * 0.98} x2={0} y2={-rc * 0.8} stroke={c.line} strokeWidth={rc * 0.09} strokeLinecap="round" />
      </g>
      <circle r={rc * 0.78} fill={`url(#${uid}fc)`} stroke="#000" strokeOpacity={0.25} strokeWidth={0.6} />
      <circle r={rc * 0.78} fill={`url(#${uid}gl)`} />
      <g transform={`rotate(${angle})`}>
        <line x1={0} y1={-rc * 0.74} x2={0} y2={-rc * 0.3} stroke={c.line} strokeWidth={rc * 0.085} strokeLinecap="round" />
      </g>
    </>
  );

  const labelEl = label && labelPos !== 'none' ? <div className="hw-silk hw-knob-label">{label}</div> : null;
  return (
    <div className={`hw-knob hw-ks-${size}${labeled ? ' hw-kscale' : ''}${className ? ` ${className}` : ''}`} data-nova-param={paramId} data-disabled={disabled ? 'true' : undefined}
      title={`${hint ? `${name} : ${hint}` : name}
(glisser pour régler · Maj : réglage fin · molette · double-clic : valeur d'origine)`}>
      {labelPos === 'top' && labelEl}
      <div ref={setBox} className="hw-knob-box" role="slider" tabIndex={disabled ? -1 : 0}
        aria-label={name} aria-valuemin={detents?.length ? detents[0].v : min} aria-valuemax={detents?.length ? detents[detents.length - 1].v : max}
        aria-valuenow={v} aria-valuetext={text} aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
        onDoubleClick={e => { e.preventDefault(); reset(); }} onKeyDown={onKeyDown}
        onPointerEnter={help.onPointerEnter} onPointerLeave={help.onPointerLeave} onFocus={help.onFocus} onBlur={help.onBlur}>
        <svg viewBox="-50 -50 100 100" aria-hidden="true" focusable="false">
          <defs>
            <radialGradient id={`${uid}sh`}><stop offset="0.55" stopColor="#000" stopOpacity="0.55" /><stop offset="1" stopColor="#000" stopOpacity="0" /></radialGradient>
            <radialGradient id={`${uid}fc`} cx="0.38" cy="0.3" r="0.8"><stop offset="0" stopColor={c.face[0]} /><stop offset="0.55" stopColor={c.face[1]} /><stop offset="1" stopColor={c.face[2]} /></radialGradient>
            {c.skirt && <linearGradient id={`${uid}sk`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={c.skirt[0]} /><stop offset="1" stopColor={c.skirt[1]} /></linearGradient>}
            <linearGradient id={`${uid}gl`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity="0.28" /><stop offset="0.5" stopColor="#fff" stopOpacity="0" /></linearGradient>
          </defs>
          <g style={{ color: 'var(--hw-ink)' }}>{dial}</g>
          {arcPath && <path d={arcPath} fill="none" stroke={arc} strokeWidth={2.8} strokeLinecap="round" />}
          {capSvg}
        </svg>
        {active && <div className="hw-bubble" aria-hidden="true">{text}</div>}
      </div>
      {labelPos === 'bottom' && labelEl}
      {sub && <div className="hw-knob-sub">{sub}</div>}
      {nativeInput && (
        <input type="range" className="hw-sr-only" tabIndex={-1} aria-hidden="true"
          min={detents?.length ? detents[0].v : min} max={detents?.length ? detents[detents.length - 1].v : max} step={detents?.length ? 'any' : (step || 'any')}
          value={v} onChange={e => emit(detents?.length ? fromNorm(range, toNorm(range, parseFloat(e.target.value))) : quantize(range, parseFloat(e.target.value)))} />
      )}
    </div>
  );
};

/** Pointeur « chicken-head » : pointe en haut, talon arrondi. */
function chickenPath(rc: number) {
  const s = (x: number) => (x * rc).toFixed(2);
  return `M 0 ${s(-1)} C ${s(0.13)} ${s(-1)} ${s(0.34)} ${s(-0.38)} ${s(0.4)} ${s(0.02)} A ${s(0.42)} ${s(0.42)} 0 1 1 ${s(-0.4)} ${s(0.02)} C ${s(-0.34)} ${s(-0.38)} ${s(-0.13)} ${s(-1)} 0 ${s(-1)} Z`;
}

export const Knob = React.memo(KnobImpl);
export default Knob;
