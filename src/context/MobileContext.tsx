import React, { createContext, useContext, ReactNode } from 'react';
import { useMobileDetect } from '../hooks/useMobileDetect';

interface MobileContextValue {
  isMobile: boolean;
}

const MobileContext = createContext<MobileContextValue | undefined>(undefined);

export const useMobile = () => {
  const context = useContext(MobileContext);
  if (!context) {
    throw new Error('useMobile must be used within MobileProvider');
  }
  return context;
};

interface MobileProviderProps {
  children: ReactNode;
}

/**
 * Mobile context provider that detects screen size
 * and provides mobile state to children
 */
export const MobileProvider: React.FC<MobileProviderProps> = ({ children }) => {
  const isMobile = useMobileDetect();

  return (
    <MobileContext.Provider value={{ isMobile }}>
      {children}
    </MobileContext.Provider>
  );
};
