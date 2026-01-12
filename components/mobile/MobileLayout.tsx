import React from 'react';

interface MobileLayoutProps {
  children: React.ReactNode;
}

const MobileLayout: React.FC<MobileLayoutProps> = ({ children }) => {
  return (
    <div 
      className="fixed inset-0 bg-[#0a0b0d] flex flex-col"
      style={{
        // Marges de sécurité pour les écrans avec notch/bords arrondis
        paddingLeft: 'max(16px, env(safe-area-inset-left))',
        paddingRight: 'max(16px, env(safe-area-inset-right))',
      }}
    >
      {children}
    </div>
  );
};

export default MobileLayout;
