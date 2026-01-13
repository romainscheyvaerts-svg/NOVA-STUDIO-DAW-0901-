import { useState, useEffect } from 'react';

/**
 * Hook to detect mobile screen size (< 768px)
 * Updates on window resize
 */
export const useMobileDetect = () => {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    
    // Initial check
    check();
    
    // Listen for resize
    window.addEventListener('resize', check);
    
    return () => window.removeEventListener('resize', check);
  }, []);

  return isMobile;
};
