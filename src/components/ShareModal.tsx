import React, { useState } from 'react';
import { createPortal } from 'react-dom';

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  onShare: (email: string) => Promise<void>;
  projectName: string;
}

const ShareModal: React.FC<ShareModalProps> = ({ isOpen, onClose, onShare, projectName }) => {
  const [email, setEmail] = useState('');
  const [isSharing, setIsSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!isOpen) return null;

  const handleShare = async () => {
    if (!email.trim()) {
      setError('Veuillez entrer un email');
      return;
    }
    setIsSharing(true);
    setError(null);
    try {
      await onShare(email);
      setSuccess(true);
      setTimeout(() => onClose(), 1500);
    } catch (e: any) {
      setError(e.message || 'Erreur de partage');
    } finally {
      setIsSharing(false);
    }
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
            <i className="fas fa-share-alt text-2xl text-cyan-500"></i>
          </div>
          <h2 className="text-lg font-black text-white">Partager le Projet</h2>
          <p className="text-[10px] text-slate-500">{projectName}</p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center text-red-400 text-[10px]">
            <i className="fas fa-exclamation-circle mr-2"></i>
            {error}
          </div>
        )}

        {success ? (
          <div className="text-center py-8">
            <div className="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <i className="fas fa-check text-2xl text-green-500"></i>
            </div>
            <p className="text-green-400 font-bold">Invitation envoyée !</p>
          </div>
        ) : (
          <>
            <div className="mb-6">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2 block">
                Email du collaborateur
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                placeholder="collaborateur@email.com"
              />
            </div>

            <button
              onClick={handleShare}
              disabled={isSharing}
              className="w-full py-3 bg-cyan-500 hover:bg-cyan-400 text-black font-black uppercase tracking-wider rounded-xl transition-all disabled:opacity-50"
            >
              {isSharing ? (
                <><i className="fas fa-spinner fa-spin mr-2"></i>Envoi...</>
              ) : (
                <><i className="fas fa-paper-plane mr-2"></i>Envoyer l'invitation</>
              )}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
};

export default ShareModal;
