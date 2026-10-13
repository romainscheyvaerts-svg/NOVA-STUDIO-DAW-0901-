import React, { useId } from 'react';
import { useHwHelp } from './help';

/**
 * Sélecteur à afficheur LCD (ajout vague 2B) : une liste native (clavier,
 * lecteur d'écran, roue du téléphone) habillée en petit écran vert ou ambre,
 * avec sa sérigraphie. Pour les choix longs (tonique, gamme, intervalle) où un
 * bouton à crans aurait trop d'étiquettes. Aide dans la ligne d'info.
 */
export const HwLcdSelect: React.FC<{
  value: string | number;
  options: { v: string | number; label: string }[];
  onChange: (v: string) => void;
  /** Sérigraphie au-dessus (court). */
  label?: string;
  /** Nom complet (lecteur d'écran, ligne d'info). */
  ariaLabel?: string;
  hint?: string;
  paramId?: string;
  amber?: boolean;
  disabled?: boolean;
  /** Largeur de l'afficheur (px ou CSS). */
  width?: number | string;
  className?: string;
  dataAttrs?: Record<string, string>;
}> = ({ value, options, onChange, label, ariaLabel, hint, paramId, amber, disabled, width, className, dataAttrs }) => {
  const uid = useId();
  const name = ariaLabel || label || paramId || 'Sélecteur';
  const cur = options.find(o => String(o.v) === String(value));
  const help = useHwHelp(uid, name, hint, cur?.label);
  return (
    <div className={`hw-lcd-select${amber ? ' hw-lcd-select-amber' : ''}${className ? ` ${className}` : ''}`} data-nova-param={paramId}
      style={width !== undefined ? { width } : undefined} onPointerEnter={help.onPointerEnter} onPointerLeave={help.onPointerLeave}>
      {label && <span className="hw-silk">{label}</span>}
      <span className="hw-lcd-select-box">
        <select value={String(value)} aria-label={name} title={hint ? `${name} : ${hint}` : name} disabled={disabled}
          onChange={e => onChange(e.target.value)} onFocus={help.onFocus} onBlur={help.onBlur} {...(dataAttrs || {})}>
          {options.map(o => <option key={String(o.v)} value={String(o.v)}>{o.label}</option>)}
        </select>
      </span>
    </div>
  );
};
