
import React from 'react';

const FXRack: React.FC = () => {
  return (
    <div className="h-full flex items-center justify-center p-8 text-center bg-[#0c0d10] opacity-10">
      <div className="flex flex-col items-center space-y-3">
        <i className="fas fa-lock text-3xl"></i>
        <span className="text-[9px] font-bold uppercase tracking-[0.4em]">FX Rack Désactivé</span>
      </div>
    </div>
  );
};
export default FXRack;
