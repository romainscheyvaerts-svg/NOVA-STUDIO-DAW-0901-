import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { User } from '../types';

interface SaveProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentName: string;
  user: User | null;
  onSaveCloud: (name: string) => Promise<void>;
  onSaveLocal: (name: string) => void;
  onSaveAsCopy: (name: string) => Promise<void>;
  onOpenAuth: () => void;
}

const SaveProjectModal: React.FC<SaveProjectModalProps> = ({
  isOpen,
  onClose,
  currentName,
  user,
  onSaveCloud,
  onSaveLocal,
  onSaveAsCopy,
  onOpenAuth
}) => {
  const [projectName, setProjectName] = useState(currentName || 'Sans titre');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSaveCloud = async () => {
    if (!user) {
      onOpenAuth();
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onSaveCloud(projectName);
      onClose();
    } catch (e: any) {
      setError(e.message || 'Erreur de sauvegarde');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveLocal = () => {
    onSaveLocal(projectName);
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#14161a] border border-white/10 rounded-2xl w-full max-w-md p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center bg-white/5 rounded-full text-slate-400 hover:text-white hover:bg-red-500/50 transition-all"
        >
          <i className="fas fa-times"></i>
        </button>

        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-cyan-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <i className="fas fa-save text-2xl text-cyan-500"></i>
          </div>
          <h2 className="text-lg font-black text-white">Sauvegarder le Projet</h2>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center text-red-400 text-[10px]">
            <i className="fas fa-exclamation-circle mr-2"></i>
            {error}
          </div>
        )}

        <div className="mb-6">
          <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2 block">
            Nom du projet
          </label>
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500/50"
            placeholder="Mon projet..."
          />
        </div>

        <div className="space-y-2">
          <button
            onClick={handleSaveCloud}
            disabled={isSaving}
            className="w-full py-3 bg-cyan-500 hover:bg-cyan-400 text-black font-black uppercase tracking-wider rounded-xl transition-all disabled:opacity-50"
          >
            {isSaving ? (
              <><i className="fas fa-spinner fa-spin mr-2"></i>Sauvegarde...</>
            ) : (
              <><i className="fas fa-cloud mr-2"></i>{user ? 'Sauvegarder dans le Cloud' : 'Se connecter pour sauvegarder'}</>
            )}
          </button>

          <button
            onClick={handleSaveLocal}
            className="w-full py-3 bg-white/5 hover:bg-white/10 text-white font-bold rounded-xl transition-all text-sm"
          >
            <i className="fas fa-download mr-2"></i>
            Télécharger en local (JSON)
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default SaveProjectModal;
