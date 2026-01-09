
import React, { useState } from 'react';

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  onShare: (email: string) => void;
  projectName: string;
}

const ShareModal: React.FC<ShareModalProps> = ({ isOpen, onClose, onShare, projectName }) => {
  const [email, setEmail] = useState('');
  const [isSending, setIsSending] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setIsSending(true);
    await onShare(email);
    setIsSending(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[1000] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-md bg-[#14161a] border border-white/10 rounded-2xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        
        {/* Header */}
        <div className="p-6 border-b border-white/5 bg-gradient-to-r from-cyan-900/20 to-transparent">
          <div className="flex items-center space-x-3 mb-1">
            <div className="w-8 h-8 rounded-full bg-cyan-500/10 flex items-center justify-center text-cyan-400">
               <i className="fas fa-share-alt text-sm"></i>
            </div>
            <h2 className="text-lg font-black text-white uppercase tracking-wider">Partager le Projet</h2>
          </div>
          <p className="text-[10px] text-slate-400 font-mono ml-11">PROJET : <span className="text-white">{projectName}</span></p>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          
          {/* Email Input */}
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1">Email du collaborateur</label>
            <div className="relative">
                <i className="fas fa-envelope absolute left-4 top-1/2 -translate-y-1/2 text-slate-600 text-xs"></i>
                <input 
                    type="email" 
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="collaborateur@studio.com"
                    className="w-full h-12 bg-black/40 border border-white/10 rounded-xl pl-10 pr-4 text-sm text-white focus:border-cyan-500 focus:outline-none transition-colors"
                />
            </div>
          </div>

          {/* RETENTION WARNING */}
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-start space-x-3">
             <i className="fas fa-exclamation-triangle text-amber-500 text-lg mt-0.5"></i>
             <div className="space-y-1">
                <h4 className="text-[10px] font-black text-amber-500 uppercase tracking-widest">Politique de Sauvegarde Cloud</h4>
                <p className="text-[10px] text-slate-300 leading-relaxed">
                   Ce projet sera accessible par le destinataire via le Cloud.
                   <br/>
                   <strong className="text-white">Attention :</strong> Les projets inactifs ou non modifiés depuis <span className="text-amber-400">3 jours</span> sont automatiquement supprimés du Cloud pour libérer de l'espace.
                </p>
                <div className="pt-2">
                    <span className="text-[9px] font-bold text-cyan-400 flex items-center">
                        <i className="fas fa-download mr-1.5"></i>
                        Conseil : Téléchargez toujours une copie locale (.zip)
                    </span>
                </div>
             </div>
          </div>

          {/* Actions */}
          <div className="flex space-x-3 pt-2">
            <button 
                type="button" 
                onClick={onClose}
                className="flex-1 h-12 rounded-xl bg-white/5 hover:bg-white/10 text-slate-400 text-[10px] font-black uppercase tracking-widest transition-colors"
            >
                Annuler
            </button>
            <button 
                type="submit" 
                disabled={isSending}
                className="flex-1 h-12 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black text-[10px] font-black uppercase tracking-widest transition-colors shadow-lg shadow-cyan-500/20 flex items-center justify-center space-x-2"
            >
                {isSending ? <i className="fas fa-spinner fa-spin"></i> : <><i className="fas fa-paper-plane"></i><span>Envoyer</span></>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ShareModal;
