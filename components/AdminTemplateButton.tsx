import React, { useState } from 'react';
import { Track, User } from '../types';
import { supabaseManager } from '../services/SupabaseManager';

interface AdminTemplateButtonProps {
  user: User | null;
  tracks: Track[];
  bpm: number;
}

const ADMIN_EMAIL = 'romain.scheyvaerts@gmail.com';

const AdminTemplateButton: React.FC<AdminTemplateButtonProps> = ({ user, tracks, bpm }) => {
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Vérifier si l'utilisateur est admin
  if (!user || user.email.toLowerCase() !== ADMIN_EMAIL) {
    return null;
  }

  const handleSaveAsTemplate = async () => {
    try {
      setIsSaving(true);
      setMessage('⏳ Sauvegarde du template...');

      // Créer le template avec les données du projet
      const template = {
        tracks: tracks.map(t => ({
          ...t,
          // Ne pas inclure les buffers audio
          clips: t.clips.map(c => ({
            ...c,
            bufferId: undefined // Le buffer sera rechargé
          }))
        })),
        bpm,
        savedAt: Date.now()
      };

      // Sauvegarder dans Supabase
      await supabaseManager.saveDefaultTemplate(template);

      setMessage('✅ Template sauvegardé pour tous les utilisateurs!');
      console.log('[ADMIN] Default template saved to Supabase');

      setTimeout(() => setMessage(null), 4000);
    } catch (error) {
      console.error('[ADMIN] Error saving template:', error);
      setMessage('❌ Erreur de sauvegarde');
      setTimeout(() => setMessage(null), 3000);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <button
      onClick={handleSaveAsTemplate}
      disabled={isSaving}
      className="px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white text-xs font-black uppercase tracking-wider rounded-lg hover:from-purple-700 hover:to-pink-700 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
      title="[ADMIN] Sauvegarder comme template par défaut pour tous les utilisateurs"
    >
      <i className={`fas ${isSaving ? 'fa-spinner fa-spin' : 'fa-crown'}`}></i>
      <span>{message || 'Save Template'}</span>
    </button>
  );
};

export default AdminTemplateButton;
