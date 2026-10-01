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
    <div className="h-full w-full flex flex-col bg-[#0c0d10] overflow-hidden safe-area-inset">
      {/* Header centré */}
      {title && (
        <div className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-white/10 bg-[#14161a] safe-area-inset-left safe-area-inset-right">
          <h1 className="text-lg font-bold text-white tracking-tight">{title}</h1>
          {headerAction}
        </div>
      )}

      {/* Contenu principal centré, scrollable - padding plus large pour éviter les coupures */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden safe-area-inset-left safe-area-inset-right">
        <div className="w-full max-w-full px-6 py-4">
          {children}
        </div>
      </div>
    </div>
  );
};

export default MobileContainer;
