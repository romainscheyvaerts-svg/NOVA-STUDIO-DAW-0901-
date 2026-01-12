import React from 'react';

interface MobileSafeAreaProps {
  children: React.ReactNode;
}

const MobileSafeArea: React.FC<MobileSafeAreaProps> = ({ children }) => {
  return (
    <div 
      className="w-full h-full"
      style={{
        paddingLeft: 'max(20px, env(safe-area-inset-left))',
        paddingRight: 'max(20px, env(safe-area-inset-right))',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {children}
    </div>
  );
};

export default MobileSafeArea;
