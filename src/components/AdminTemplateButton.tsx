import React, { useState } from 'react';
import { DAWState, User } from '../types';

interface AdminTemplateButtonProps {
  user: User;
  currentState: DAWState;
}

const ADMIN_EMAIL = 'romain.scheyvaerts@gmail.com';
const TEMPLATE_STORAGE_KEY = 'nova_default_template';

const AdminTemplateButton: React.FC<AdminTemplateButtonProps> = ({ user, currentState }) => {
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Vérifier si l'utilisateur est admin
  if (user.email.toLowerCase() !== ADMIN_EMAIL) {
    return null;
  }

  const handleSaveAsTemplate = () => {
    try {
      setIsSaving(true);

      // Créer une copie du state sans les données sensibles
      const template = {
        ...currentState,
        name: 'Nouveau Projet',
        projectId: undefined,
        lastSavedTimestamp: Date.now()
      };

      // Sauvegarder dans localStorage
      localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(template));

      setMessage('✅ Template sauvegardé!');
      console.log('[ADMIN] Template saved successfully');

      setTimeout(() => setMessage(null), 3000);
    } catch (error) {
      console.error('[ADMIN] Error saving template:', error);
      setMessage('❌ Erreur de sauvegarde');
      setTimeout(() => setMessage(null), 3000);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={handleSaveAsTemplate}
        disabled={isSaving}
        className="px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white text-xs font-black uppercase tracking-wider rounded-lg hover:from-purple-700 hover:to-pink-700 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
        title="[ADMIN ONLY] Sauvegarder l'état actuel comme template par défaut"
      >
        <i className={`fas ${isSaving ? 'fa-spinner fa-spin' : 'fa-crown'}`}></i>
        <span>Save Template</span>
      </button>

      {message && (
        <div className="absolute top-full mt-2 left-0 right-0 text-center text-xs font-bold bg-black/90 text-white px-3 py-2 rounded-lg whitespace-nowrap shadow-xl z-50">
          {message}
        </div>
      )}
    </div>
  );
};

// Fonction utilitaire pour charger le template par défaut
export const loadDefaultTemplate = (): DAWState | null => {
  try {
    const templateStr = localStorage.getItem(TEMPLATE_STORAGE_KEY);
    if (!templateStr) return null;

    const template = JSON.parse(templateStr);
    console.log('[TEMPLATE] Loaded default template');
    return template;
  } catch (error) {
    console.error('[TEMPLATE] Error loading default template:', error);
    return null;
  }
};

export default AdminTemplateButton;
