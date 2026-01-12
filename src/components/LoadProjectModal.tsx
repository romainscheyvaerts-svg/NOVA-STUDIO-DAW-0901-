import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { User } from '../types';
import { supabaseManager } from '../services/SupabaseManager';

interface LoadProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
  onLoadCloud: (sessionId: string) => Promise<void>;
  onLoadLocal: (file: File) => Promise<void>;
  onOpenAuth: () => void;
}

interface CloudProject {
  id: string;
  name: string;
  updated_at: string;
}

const LoadProjectModal: React.FC<LoadProjectModalProps> = ({
  isOpen,
  onClose,
  user,
  onLoadCloud,
  onLoadLocal,
  onOpenAuth
}) => {
  const [cloudProjects, setCloudProjects] = useState<CloudProject[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && user) {
      loadCloudProjects();
    }
  }, [isOpen, user]);

  const loadCloudProjects = async () => {
    setIsLoading(true);
    try {
      const projects = await supabaseManager.listUserSessions();
      setCloudProjects(projects || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadCloud = async (id: string) => {
    setIsLoading(true);
    setError(null);
    try {
      await onLoadCloud(id);
      onClose();
    } catch (e: any) {
      setError(e.message || 'Erreur de chargement');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setIsLoading(true);
      try {
        await onLoadLocal(file);
        onClose();
      } catch (e: any) {
        setError(e.message);
      } finally {
        setIsLoading(false);
      }
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#14161a] border border-white/10 rounded-2xl w-full max-w-md p-6 relative max-h-[80vh] overflow-hidden flex flex-col">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center bg-white/5 rounded-full text-slate-400 hover:text-white hover:bg-red-500/50 transition-all z-10"
        >
          <i className="fas fa-times"></i>
        </button>

        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-cyan-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <i className="fas fa-folder-open text-2xl text-cyan-500"></i>
          </div>
          <h2 className="text-lg font-black text-white">Charger un Projet</h2>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center text-red-400 text-[10px]">
            <i className="fas fa-exclamation-circle mr-2"></i>
            {error}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.zip"
          onChange={handleFileChange}
          className="hidden"
        />

        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full py-3 mb-4 bg-white/5 hover:bg-white/10 text-white font-bold rounded-xl transition-all text-sm border border-dashed border-white/20"
        >
          <i className="fas fa-upload mr-2"></i>
          Charger depuis l'ordinateur
        </button>

        {user ? (
          <div className="flex-1 overflow-y-auto">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider mb-2 block">
              Projets Cloud
            </label>
            {isLoading ? (
              <div className="flex justify-center py-8">
                <div className="w-6 h-6 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin"></div>
              </div>
            ) : cloudProjects.length === 0 ? (
              <p className="text-center text-slate-500 text-sm py-8">Aucun projet sauvegardé</p>
            ) : (
              <div className="space-y-2">
                {cloudProjects.map(project => (
                  <button
                    key={project.id}
                    onClick={() => handleLoadCloud(project.id)}
                    className="w-full p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-left transition-all group"
                  >
                    <div className="flex justify-between items-center">
                      <div>
                        <h3 className="text-sm font-bold text-white group-hover:text-cyan-400">{project.name}</h3>
                        <p className="text-[10px] text-slate-500">
                          {new Date(project.updated_at).toLocaleDateString('fr-FR', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                        </p>
                      </div>
                      <i className="fas fa-chevron-right text-slate-500 group-hover:text-cyan-400"></i>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-6">
            <p className="text-slate-400 text-sm mb-4">Connectez-vous pour accéder à vos projets cloud</p>
            <button
              onClick={() => { onClose(); onOpenAuth(); }}
              className="px-6 py-2 bg-cyan-500 hover:bg-cyan-400 text-black font-bold rounded-xl transition-all text-sm"
            >
              Se connecter
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

export default LoadProjectModal;
