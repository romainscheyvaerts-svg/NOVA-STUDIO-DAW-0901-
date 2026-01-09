
import React from 'react';
import { User } from '../types';

// On garde l'interface pour ne pas casser la compilation dans App.tsx
interface SideBrowserProps {
  onLocalImport?: (file: File) => void;
  activeTab: 'local' | 'fx' | 'nova' | 'store';
  onTabChange: (tab: 'local' | 'fx' | 'nova' | 'store') => void;
  onAddPlugin?: (type: string, metadata?: any) => void;
  shouldFocusSearch?: boolean;
  onSearchFocused?: () => void;
  user?: User | null;
  onBuyLicense?: (instId: number) => void; 
}

const SideBrowser: React.FC<SideBrowserProps> = () => {
  return (
    <div className="w-full h-full bg-[#08090b] border-r border-white/5 flex flex-col items-center justify-center p-8 text-center opacity-50">
       <div className="w-16 h-16 border-2 border-dashed border-white/20 rounded-xl flex items-center justify-center mb-4">
         <i className="fas fa-hammer text-white/20 text-xl"></i>
       </div>
       <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">Browser Reset</h3>
       <p className="text-[9px] font-mono text-slate-600 mt-2">En attente de reconstruction...</p>
    </div>
  );
};

export default SideBrowser;
