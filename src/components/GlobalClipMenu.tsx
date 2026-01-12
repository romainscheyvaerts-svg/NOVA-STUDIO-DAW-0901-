import React from 'react';
import { Clip } from '../types';

interface GlobalClipMenuProps {
  selectedClip: Clip | null;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  canPaste: boolean;
}

const GlobalClipMenu: React.FC<GlobalClipMenuProps> = ({
  selectedClip,
  onCut,
  onCopy,
  onPaste,
  onDelete,
  onDuplicate,
  canPaste
}) => {
  if (!selectedClip) return null;

  return (
    <div className="fixed bottom-20 left-1/2 transform -translate-x-1/2 z-[100] bg-[#14161a]/95 backdrop-blur-xl border border-white/10 rounded-2xl px-2 py-2 flex items-center space-x-1 shadow-2xl animate-in slide-in-from-bottom-4">
      <button
        onClick={onCut}
        className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-all"
        title="Couper"
      >
        <i className="fas fa-cut text-sm"></i>
      </button>
      <button
        onClick={onCopy}
        className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-all"
        title="Copier"
      >
        <i className="fas fa-copy text-sm"></i>
      </button>
      <button
        onClick={onPaste}
        disabled={!canPaste}
        className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
          canPaste
            ? 'text-slate-400 hover:text-white hover:bg-white/10'
            : 'text-slate-700 cursor-not-allowed'
        }`}
        title="Coller"
      >
        <i className="fas fa-paste text-sm"></i>
      </button>
      <div className="w-px h-6 bg-white/10"></div>
      <button
        onClick={onDuplicate}
        className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-400 hover:text-cyan-400 hover:bg-cyan-500/10 transition-all"
        title="Dupliquer"
      >
        <i className="fas fa-clone text-sm"></i>
      </button>
      <button
        onClick={onDelete}
        className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-all"
        title="Supprimer"
      >
        <i className="fas fa-trash text-sm"></i>
      </button>
    </div>
  );
};

export default GlobalClipMenu;
