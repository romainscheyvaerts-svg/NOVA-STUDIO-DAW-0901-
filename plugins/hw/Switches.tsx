import React, { useId } from 'react';
import { useHwHelp } from './help';

/** Voyant LED (allumé / éteint), couleur libre. */
export const Led: React.FC<{ on: boolean; color?: string; large?: boolean; className?: string; title?: string }> = ({ on, color = '#ff3b30', large, className, title }) => (
  <span className={`hw-led${large ? ' hw-led-lg' : ''}${className ? ` ${className}` : ''}`} data-on={on ? 'true' : 'false'} style={{ ['--led' as any]: color }} title={title} aria-hidden="true" />
);

/**
 * Bouton-poussoir à LED. Par défaut un interrupteur (aria-pressed) ; dans un
 * groupe exclusif, passer role="radio" (aria-checked).
 */
export const PushButton: React.FC<{
  active: boolean;
  onClick: () => void;
  /** Texte sur le capuchon. */
  text?: string;
  /** Sérigraphie sous le bouton. */
  label?: string;
  led?: string | false;
  hint?: string;
  dark?: boolean;
  role?: 'button' | 'radio';
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
  dataAttrs?: Record<string, string>;
  /** État lisible pour la ligne d'info (défaut : « enfoncé » / « relevé »). */
  valueText?: string;
}> = ({ active, onClick, text, label, led = '#ff3b30', hint, dark, role = 'button', ariaLabel, disabled, className, children, dataAttrs, valueText }) => {
  const uid = useId();
  const name = ariaLabel || label || text || '';
  const help = useHwHelp(uid, name, hint, valueText ?? (active ? 'enfoncé' : 'relevé'));
  return (
    <button type="button" className={`hw-push${dark ? ' hw-push-dark' : ''}${className ? ` ${className}` : ''}`} onClick={onClick} disabled={disabled}
      role={role === 'radio' ? 'radio' : undefined} aria-checked={role === 'radio' ? active : undefined} aria-pressed={role === 'button' ? active : undefined}
      aria-label={ariaLabel} title={hint ? `${name} : ${hint}` : name || undefined} {...(dataAttrs || {})}
      onPointerEnter={help.onPointerEnter} onPointerLeave={help.onPointerLeave} onFocus={help.onFocus} onBlur={help.onBlur}>
      {led !== false && <Led on={active} color={led || undefined} />}
      <span className="hw-push-cap">{children ?? text}</span>
      {label && <span className="hw-push-label">{label}</span>}
    </button>
  );
};

/**
 * Interrupteur à levier (2 ou 3 positions). Les positions sont listées à côté du
 * levier, de haut en bas : on clique une position, ou le levier pour passer à la
 * suivante. Accessibilité : groupe de boutons radio (flèches du clavier).
 */
export const ToggleSwitch: React.FC<{
  value: number;
  options: { v: number; label: string; hint?: string }[];
  onChange: (v: number) => void;
  label?: string;
  hint?: string;
  paramId?: string;
  /** Formulation lisible de la valeur (ligne d'info) ; par défaut l'étiquette de la position. */
  className?: string;
}> = ({ value, options, onChange, label, hint, paramId, className }) => {
  const uid = useId();
  const gid = uid.replace(/[^a-zA-Z0-9_-]/g, '');
  const idx = Math.max(0, options.findIndex(o => o.v === value));
  const cur = options[idx] || options[0];
  const help = useHwHelp(uid, label || 'Interrupteur', cur?.hint || hint, cur?.label);
  const n = options.length;
  // Position du levier : haut (0), milieu, bas (n-1).
  const pos = n <= 1 ? 0 : idx / (n - 1);
  const tipY = 30 - 22 * Math.cos(pos * Math.PI); // 8 (haut) … 52 (bas)
  const mid = n === 3 && idx === 1;
  const cycle = () => onChange(options[(idx + 1) % n].v);
  const onKey = (e: React.KeyboardEvent) => {
    let j = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') j = Math.min(n - 1, idx + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') j = Math.max(0, idx - 1);
    if (j < 0) return;
    e.preventDefault();
    onChange(options[j].v);
    (e.currentTarget.parentElement?.children[j] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className={`hw-toggle${className ? ` ${className}` : ''}`} data-nova-param={paramId} title={hint ? `${label} : ${hint}` : label}
      onPointerEnter={help.onPointerEnter} onPointerLeave={help.onPointerLeave}>
      {label && <div className="hw-silk">{label}</div>}
      <div className="hw-toggle-body">
        <button type="button" className="hw-toggle-lever" onClick={cycle} tabIndex={-1} aria-hidden="true" onPointerDown={help.show}>
          <svg viewBox="0 0 34 60">
            <defs>
              <radialGradient id={`${gid}n`} cx="0.4" cy="0.35" r="0.75"><stop offset="0" stopColor="#f6f6f4" /><stop offset="0.5" stopColor="#a9abae" /><stop offset="1" stopColor="#4a4c50" /></radialGradient>
              <linearGradient id={`${gid}l`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#8c8f93" /><stop offset="0.45" stopColor="#fafafa" /><stop offset="1" stopColor="#6b6e72" /></linearGradient>
            </defs>
            <ellipse cx="18" cy="33" rx="13" ry="13" fill="#000" opacity="0.35" />
            <polygon points="17,18.5 28.5,24.5 28.5,36.5 17,42.5 5.5,36.5 5.5,24.5" fill={`url(#${gid}n)`} stroke="#000" strokeOpacity="0.5" strokeWidth="0.6" />
            <circle cx="17" cy="30.5" r="6.2" fill="#2c2e31" stroke="#000" strokeOpacity="0.6" strokeWidth="0.5" />
            {mid ? (
              <circle cx="17" cy="30.5" r="5.4" fill={`url(#${gid}l)`} stroke="#000" strokeOpacity="0.5" strokeWidth="0.5" />
            ) : (
              <g>
                <path d={`M 14.6 30.5 L ${15.4} ${tipY} L ${18.6} ${tipY} L 19.4 30.5 Z`} fill={`url(#${gid}l)`} stroke="#000" strokeOpacity="0.45" strokeWidth="0.5" />
                <ellipse cx="17" cy={tipY} rx="4.1" ry="3.4" fill={`url(#${gid}l)`} stroke="#000" strokeOpacity="0.5" strokeWidth="0.5" />
              </g>
            )}
          </svg>
        </button>
        <div className="hw-toggle-opts" role="radiogroup" aria-label={label}>
          {options.map((o, i) => (
            <button key={o.v} type="button" role="radio" aria-checked={i === idx} tabIndex={i === idx ? 0 : -1} className="hw-toggle-opt"
              onClick={() => onChange(o.v)} onKeyDown={onKey} title={o.hint || hint} onFocus={help.onFocus} onBlur={help.onBlur}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
