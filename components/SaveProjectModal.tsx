
import React, { useState, useEffect } from 'react';
import { User } from '../types';

interface SaveProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentName: string;
  user: User | null;
  onSaveCloud: (name: string) => void;
  onSaveLocal: (name: string) => void;
  onSaveAsCopy: (name: string) => void;
  onOpenAuth: () => void;
}

const SaveProjectModal: React.FC<SaveProjectModalProps> = ({ 
  isOpen, onClose, currentName, user, onSaveCloud, onSaveLocal, onSaveAsCopy, onOpenAuth
}) => {
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(currentName);
  }, [currentName, isOpen]);

  if (!isOpen) return null;

  const handleLoginRedirect = () => {
      onClose();
      onOpenAuth();
  };

  const validateName = () => {
    if (!name.trim()) { setError("Le nom du projet est requis."); return false; }
    return true;
  };

  const handleCloudSave = () => {
    if (!user) {
        handleLoginRedirect();
        return;
    }
    if (!validateName()) return;
    onSaveCloud(name);
    onClose();
  };

  const handleCloudSaveCopy = () => {
    if (!user) {
        handleLoginRedirect();
        return;
    }
    if (!validateName()) return;
    onSaveAsCopy(name);
    onClose();
  };

  const handleLocal = () => {
    if (!validateName()) return;
    onSaveLocal(name);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[1200] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-lg bg-[#14161a] border border-white/10 rounded-3xl shadow-2xl overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        
        {/* Header */}
        <div className="p-6 border-b border-white/5 bg-gradient-to-r from-cyan-900/20 to-transparent flex justify-between items-center">
            <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20">
                    <i className="fas fa-save text-lg"></i>
                </div>
                <div>
                    <h2 className="text-sm font-black text-white uppercase tracking-widest">Sauvegarder le Projet</h2>
                    <p className="text-[10px] text-slate-500 font-mono">Choisissez une méthode</p>
                </div>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-white/10 text-slate-500 hover:text-white flex items-center justify-center transition-colors">
                <i className="fas fa-times"></i>
            </button>
        </div>

        <div className="p-8 space-y-6">
            {/* Project Name Input */}
            <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Nom du Projet</label>
                <input 
                    type="text" 
                    value={name}
                    onChange={(e) => { setName(e.target.value); setError(null); }}
                    className="w-full h-12 bg-black/40 border border-white/10 rounded-xl px-4 text-white font-bold focus:border-cyan-500 focus:outline-none transition-all placeholder:text-slate-700"
                    placeholder="Mon Super Hit..."
                    autoFocus
                />
                {error && <p className="text-[10px] text-red-500 font-bold ml-1 flex items-center"><i className="fas fa-exclamation-circle mr-1"></i> {error}</p>}
            </div>

            <div className="grid grid-cols-2 gap-4 pt-2">
                {/* CLOUD ACTIONS GROUP */}
                <div className="col-span-2 space-y-2">
                     {!user ? (
                        // NOT LOGGED IN STATE : Invitation à se connecter
                        <button 
                            onClick={handleLoginRedirect}
                            className="w-full relative p-4 rounded-xl border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500 hover:text-black hover:border-cyan-500 text-cyan-400 flex flex-row items-center justify-center space-x-3 transition-all group"
                        >
                            <i className="fas fa-sign-in-alt text-lg group-hover:scale-110 transition-transform"></i>
                            <div className="flex flex-col items-start">
                                <span className="text-[10px] font-black uppercase tracking-widest">Se connecter / Créer un compte</span>
                                <span className="text-[8px] font-normal opacity-80">Requis pour la sauvegarde Cloud</span>
                            </div>
                        </button>
                     ) : (
                        // LOGGED IN STATE
                        <>
                             <div className="flex space-x-2">
                                 <button 
                                    onClick={handleCloudSave}
                                    className="flex-1 relative p-4 rounded-xl border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500 hover:text-black hover:border-cyan-500 text-cyan-400 flex flex-row items-center justify-center space-x-3 transition-all group"
                                >
                                    <i className="fas fa-cloud-upload-alt"></i>
                                    <span className="text-[10px] font-black uppercase tracking-widest">Sauvegarder</span>
                                </button>

                                 <button 
                                    onClick={handleCloudSaveCopy}
                                    className="flex-1 relative p-4 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/30 text-slate-300 hover:text-white flex flex-row items-center justify-center space-x-3 transition-all group"
                                >
                                    <i className="fas fa-copy"></i>
                                    <span className="text-[10px] font-black uppercase tracking-widest">Sauver une copie</span>
                                </button>
                             </div>
                             <p className="text-[9px] text-slate-500 text-center">
                                Synchronisé avec le compte de <span className="text-white font-bold">{user.username}</span>.
                             </p>
                        </>
                     )}
                </div>

                <div className="col-span-2 h-px bg-white/5 my-2"></div>

                {/* LOCAL BUTTON */}
                <button 
                    onClick={handleLocal}
                    className="col-span-2 p-4 rounded-xl border border-purple-500/30 bg-purple-500/5 hover:bg-purple-500/10 hover:border-purple-500 flex flex-row items-center justify-center space-x-3 transition-all group text-purple-400"
                >
                    <i className="fas fa-file-export"></i>
                    <span className="text-[10px] font-black uppercase tracking-widest">Export Local (.zip)</span>
                </button>
            </div>
        </div>

      </div>
    </div>
  );
};

export default SaveProjectModal;
