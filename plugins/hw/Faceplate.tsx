import React, { useState } from 'react';
import { HwHelpProvider, InfoBar } from './help';

export type HwFinish = 'cream' | 'black' | 'silver' | 'burgundy' | 'graphite' | 'bronze' | 'steel' | 'slate'
  // Vague 2B
  | 'seafoam' | 'plum' | 'forest' | 'midnight' | 'hammer' | 'labgrey' | 'indigo' | 'vermilion' | 'mustard' | 'concrete' | 'jade' | 'cobalt' | 'avocado';

/** Logo NOVA (étoile à quatre branches + mot), à l'encre de la façade. */
export const NovaLogo: React.FC<{ className?: string; size?: number }> = ({ className, size = 13 }) => (
  <span className={`hw-logo${className ? ` ${className}` : ''}`} aria-label="NOVA">
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 0.8 C10.9 6.4 13.6 9.1 19.2 10 C13.6 10.9 10.9 13.6 10 19.2 C9.1 13.6 6.4 10.9 0.8 10 C6.4 9.1 9.1 6.4 10 0.8 Z" fill="currentColor" />
      <circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" strokeWidth="0.9" opacity="0.55" />
    </svg>
    <span className="hw-logo-word" aria-hidden="true">NOVA</span>
  </span>
);

/** Façade : fond (métal brossé ou peinture), vis aux coins, nom du modèle et logo. */
export const Faceplate: React.FC<{
  finish: HwFinish;
  /** Nom du modèle (titre h2 de la fenêtre). */
  model: string;
  /** Sous-titre sérigraphié (petites capitales). */
  kicker?: string;
  /** Style du nom : sans (défaut), serif (vintage), wide (capitales espacées). */
  modelStyle?: 'sans' | 'serif' | 'wide';
  logoSide?: 'left' | 'right';
  screws?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ finish, model, kicker, modelStyle = 'sans', logoSide = 'right', screws = true, className, style, children }) => {
  const title = (
    <div className="hw-face-title" style={logoSide === 'left' ? { textAlign: 'right' } : undefined}>
      <h2 className={`hw-model${modelStyle === 'serif' ? ' hw-model-serif' : modelStyle === 'wide' ? ' hw-model-wide' : ''}`}>{model}</h2>
      {kicker && <div className="hw-kicker">{kicker}</div>}
    </div>
  );
  return (
    <div className={`hw-face hw-finish-${finish}${className ? ` ${className}` : ''}`} style={style}>
      {screws && (
        <>
          <span className="hw-screw hw-screw-tl" style={{ ['--hw-screw-rot' as any]: '18deg' }} />
          <span className="hw-screw hw-screw-tr" style={{ ['--hw-screw-rot' as any]: '-32deg' }} />
          <span className="hw-screw hw-screw-bl" style={{ ['--hw-screw-rot' as any]: '61deg' }} />
          <span className="hw-screw hw-screw-br" style={{ ['--hw-screw-rot' as any]: '4deg' }} />
        </>
      )}
      <div className="hw-face-head">
        {logoSide === 'left' ? <><NovaLogo />{title}</> : <>{title}<NovaLogo /></>}
      </div>
      {children}
    </div>
  );
};

/** Bloc sérigraphié avec titre entre deux filets (PRÉAMPLI, COMPRESSEUR…). */
export const HwSection: React.FC<{ title?: string; aside?: React.ReactNode; className?: string; style?: React.CSSProperties; children: React.ReactNode }> = ({ title, aside, className, style, children }) => (
  <div className={`hw-section${className ? ` ${className}` : ''}`} style={style}>
    {title && <div className="hw-section-title"><span className="hw-silk">{title}</span>{aside && <span className="hw-section-aside">{aside}</span>}</div>}
    {children}
  </div>
);

/** Préréglages (barre d'outils) : un clic applique ; le dernier choisi reste allumé tant qu'on n'y touche pas. */
export function HwPresets<P extends { id: string; name: string; hint?: string; params: Record<string, any> }>({ presets, current, onApply }: { presets: P[]; current: Record<string, any>; onApply: (p: P) => void }) {
  const matches = (pr: P) => Object.entries(pr.params).every(([k, v]) => typeof v === 'number' ? Math.abs((+current[k] || 0) - v) < 1e-6 : current[k] === v);
  const [lastId, setLastId] = useState<string | null>(() => presets.find(matches)?.id || null);
  return (
    <div className="hw-toolbar-row" data-nova-presets>
      <span className="hw-toolbar-label">Préréglages</span>
      {presets.map(pr => {
        const active = lastId === pr.id && matches(pr);
        return (
          <button key={pr.id} type="button" className="hw-chip" title={pr.hint} aria-pressed={active} data-nova-preset={pr.id}
            onClick={() => { setLastId(pr.id); onApply(pr); }}>
            {pr.name}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Fenêtre d'un effet « matériel » : barre d'outils (préréglages, actions NOVA),
 * façade, puis ligne d'info qui décrit le réglage survolé. Fournit le magasin
 * d'aide aux réglages de la façade.
 */
export const HwWindow: React.FC<{
  /** Type de l'effet (data-nova-plugin). */
  type: string;
  /** Largeur maximale (px) ; bornée à l'écran. */
  width?: number;
  /** Couleur d'accent de la barre d'outils (préréglage actif, bouton d'action). */
  accent?: string;
  accentInk?: string;
  toolbar?: React.ReactNode;
  /** Texte de la ligne d'info quand rien n'est survolé. */
  idleHelp: React.ReactNode;
  /** Latence en ms (ligne d'info, à droite) ; undefined = non affichée. */
  latencyMs?: number;
  fallback?: boolean;
  children: React.ReactNode;
}> = ({ type, width = 600, accent, accentInk, toolbar, idleHelp, latencyMs, fallback, children }) => (
  <HwHelpProvider>
    <div data-nova-plugin={type} className="hw-window"
      style={{ width: `min(${width}px, calc(100vw - 16px))`, ...(accent ? { ['--hw-ui-accent' as any]: accent } : {}), ...(accentInk ? { ['--hw-ui-accent-ink' as any]: accentInk } : {}) }}>
      {toolbar && <div className="hw-toolbar">{toolbar}</div>}
      <div className="hw-window-body">
        {children}
        {fallback && <p style={{ marginTop: 10, fontSize: 11, color: '#fca5a5' }}>Ce navigateur ne peut pas charger l'effet : il est contourné (aucun traitement).</p>}
      </div>
      <InfoBar idle={idleHelp}
        side={latencyMs === undefined ? undefined : <span title="Retard ajouté par l'effet, compensé automatiquement à la lecture et à l'export (PDC)">Latence <b>{latencyMs ? `${latencyMs.toFixed(1).replace('.', ',')} ms` : 'aucune'}</b></span>} />
    </div>
  </HwHelpProvider>
);
