import React from 'react';

interface MobileContainerProps {
  children: React.ReactNode;
  title?: string;
  headerAction?: React.ReactNode;
}

/**
 * Container mobile qui centre le contenu sans éléments sur les côtés
 * Inspiré de Logic Pro sur iPad
 * (Plus de padding-top : MobileTransport n'est pas rendu, la TransportBar est
 * dans le flux au-dessus — 64 px étaient perdus sur chaque onglet.)
 */
const MobileContainer: React.FC<MobileContainerProps> = ({ children, title, headerAction }) => {
  return (
    // pb : la barre d'onglets du bas est fixe (64 px + barre d'accueil de l'iPhone ; 0 quand elle est en colonne
    // à gauche, téléphone couché) : la zone qui défile s'arrête au-dessus, plus rien ne passe dessous (avant,
    // le dernier effet / le dernier son restait sous les onglets, impossible à toucher).
    <div className="h-full w-full flex flex-col bg-nv-bg overflow-hidden safe-area-inset pb-[var(--nv-nav-h,4rem)]">
      {/* Header centré */}
      {title && (
        <div className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-white/10 bg-nv-surface safe-area-inset-left safe-area-inset-right">
          <h1 className="text-base font-bold text-white tracking-tight">{title}</h1>
          {headerAction}
        </div>
      )}

      {/* Contenu principal centré, scrollable - padding plus large pour éviter les coupures */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain safe-area-inset-left safe-area-inset-right">
        <div className="w-full max-w-full px-4 py-3">
          {children}
        </div>
      </div>
    </div>
  );
};

export default MobileContainer;
