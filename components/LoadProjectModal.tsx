
import React, { useState, useEffect, useRef } from 'react';
import { User } from '../types';
import { supabaseManager } from '../services/SupabaseManager';

interface LoadProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
  onLoadCloud: (sessionId: string) => void;
  onLoadLocal: (file: File) => void;
  onOpenAuth: () => void;
}

const LoadProjectModal: React.FC<LoadProjectModalProps> = ({ 
  isOpen, onClose, user, onLoadCloud, onLoadLocal, onOpenAuth
}) => {
  const [activeTab, setActiveTab] = useState<'CLOUD' | 'LOCAL'>('CLOUD');
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && user && activeTab === 'CLOUD') {
      fetchSessions();
    }
  }, [isOpen, user, activeTab]);

  const fetchSessions = async () => {
    setLoading(true);
    try {
      const data = await supabaseManager.listUserSessions();
      setSessions(data || []);
    } catch (e) {
      console.error("Error fetching sessions", e);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const handleLocalFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onLoadLocal(e.target.files[0]);
      onClose();
    }
  };

  const formatDate = (dateStr: string) => {
      return new Date(dateStr).toLocaleDateString(undefined, { 
          day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' 
      });
  };

  return (
    <div className="fixed inset-0 z-[1200] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-2xl h-[600px] bg-[#14161a] border border-white/10 rounded-3xl shadow-2xl overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        
        {/* Header */}
        <div className="p-6 border-b border-white/5 bg-gradient-to-r from-blue-900/20 to-transparent flex justify-between items-center shrink-0">
            <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-400 border border-blue-500/20">
                    <i className="fas fa-folder-open text-lg"></i>
                </div>
                <div>
                    <h2 className="text-sm font-black text-white uppercase tracking-widest">Ouvrir un Projet</h2>
                    <p className="text-[10px] text-slate-500 font-mono">Bibliothèque de projets</p>
                </div>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-white/10 text-slate-500 hover:text-white flex items-center justify-center transition-colors">
                <i className="fas fa-times"></i>
            </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/5 bg-black/20 shrink-0">
            <button 
                onClick={() => setActiveTab('CLOUD')}
                className={`flex-1 py-4 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'CLOUD' ? 'bg-white/5 text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
            >
                <i className="fas fa-cloud mr-2"></i> Cloud (Compte)
            </button>
            <button 
                onClick={() => setActiveTab('LOCAL')}
                className={`flex-1 py-4 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'LOCAL' ? 'bg-white/5 text-purple-400 border-b-2 border-purple-400' : 'text-slate-500 hover:text-slate-300'}`}
            >
                <i className="fas fa-hdd mr-2"></i> Local (Fichier)
            </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden relative">
            
            {/* --- CLOUD TAB --- */}
            {activeTab === 'CLOUD' && (
                <div className="h-full flex flex-col">
                    {!user ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-4">
                            <i className="fas fa-lock text-4xl text-slate-700"></i>
                            <p className="text-xs text-slate-400">Connectez-vous pour accéder à vos sauvegardes Cloud.</p>
                            <button onClick={() => { onClose(); onOpenAuth(); }} className="px-6 py-2 bg-cyan-500 hover:bg-cyan-400 text-black text-xs font-bold rounded-lg uppercase tracking-wide transition-colors">
                                Se connecter
                            </button>
                        </div>
                    ) : loading ? (
                        <div className="flex-1 flex items-center justify-center">
                            <div className="w-8 h-8 border-4 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin"></div>
                        </div>
                    ) : sessions.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-center p-8 opacity-50">
                            <i className="fas fa-ghost text-3xl text-slate-600 mb-2"></i>
                            <p className="text-[10px] uppercase font-bold text-slate-500">Aucun projet trouvé</p>
                        </div>
                    ) : (
                        <div className="flex-1 overflow-y-auto custom-scroll p-4 space-y-2">
                            {sessions.map((session) => (
                                <div key={session.id} className="group flex items-center justify-between p-4 bg-white/[0.02] hover:bg-white/[0.06] border border-white/5 rounded-xl transition-all">
                                    <div className="flex items-center space-x-4">
                                        <div className="w-10 h-10 rounded-lg bg-cyan-900/30 text-cyan-500 flex items-center justify-center font-bold text-lg">
                                            {(session.name || 'U').charAt(0).toUpperCase()}
                                        </div>
                                        <div>
                                            <h4 className="text-xs font-bold text-white group-hover:text-cyan-400 transition-colors">{session.name || 'Projet Sans Nom'}</h4>
                                            <p className="text-[9px] text-slate-500 mt-0.5">
                                                <i className="far fa-clock mr-1"></i> {formatDate(session.updated_at)}
                                            </p>
                                        </div>
                                    </div>
                                    <button 
                                        onClick={() => { onLoadCloud(session.id); onClose(); }}
                                        className="px-4 py-2 bg-white/5 hover:bg-cyan-500 hover:text-black text-slate-300 text-[9px] font-black uppercase rounded-lg transition-all"
                                    >
                                        Ouvrir
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* --- LOCAL TAB --- */}
            {activeTab === 'LOCAL' && (
                <div className="h-full flex flex-col items-center justify-center p-8 text-center space-y-6">
                    <div 
                        className="w-full max-w-sm h-48 border-2 border-dashed border-white/10 rounded-3xl flex flex-col items-center justify-center hover:border-purple-500/50 hover:bg-purple-500/5 transition-all cursor-pointer group"
                        onClick={() => fileInputRef.current?.click()}
                    >
                        <div className="w-16 h-16 rounded-full bg-purple-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                            <i className="fas fa-file-import text-2xl text-purple-400"></i>
                        </div>
                        <h3 className="text-xs font-bold text-white uppercase">Importer un fichier .ZIP</h3>
                        <p className="text-[9px] text-slate-500 mt-2">Cliquez pour parcourir</p>
                    </div>
                    <input 
                        type="file" 
                        ref={fileInputRef} 
                        className="hidden" 
                        accept=".zip,.json" 
                        onChange={handleLocalFile} 
                    />
                </div>
            )}
        </div>

      </div>
    </div>
  );
};

export default LoadProjectModal;
