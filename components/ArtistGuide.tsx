
import React from 'react';
import { GuideStep } from '../types';

interface ArtistGuideProps {
  step: GuideStep;
  isVisible: boolean;
  onClose: () => void;
  onNext: () => void;
}

const ArtistGuide: React.FC<ArtistGuideProps> = ({ step, isVisible, onClose, onNext }) => {
  if (!isVisible) return null;

  const content = {
    [GuideStep.WELCOME]: {
      title: "Bienvenue au Studio ! 🎤",
      text: "Prêt à enregistrer ton prochain hit ? Je vais te guider étape par étape pour que tout soit parfait.",
      button: "C'est parti !",
    },
    [GuideStep.IMPORT_INSTRUMENTAL]: {
      title: "Étape 1 : Ton Instru 🎹",
      text: "Commence par importer ta production. Appuie sur le gros bouton bleu 'IMPORTER MON INSTRU' au milieu de l'écran ou sur le côté.",
      button: "Compris",
    },
    [GuideStep.PREPARE_VOCAL]: {
      title: "Étape 2 : Ta Voix 🎙️",
      text: "Appuie sur le bouton 'R' rouge sur la piste 'MA VOIX' pour activer ton micro. Tu devrais voir le métronome s'afficher !",
      button: "C'est fait !",
    },
    [GuideStep.RECORDING]: {
      title: "Étape 3 : On enregistre ! 🔴",
      text: "Appuie sur le gros bouton 'ENREGISTRER' en haut. Chante sur le rythme du métronome. Appuie sur STOP quand tu as fini.",
      button: "Je suis prêt",
    },
    [GuideStep.REVIEW]: {
      title: "Étape 4 : Écoute 🎧",
      text: "Bravo ! Appuie sur Play pour écouter. Si le métronome te dérange pour l'écoute, désactive-le avec le bouton 'Clic' en haut.",
      button: "Génial",
    },
    [GuideStep.EXPORT]: {
      title: "Terminé ! 🚀",
      text: "Ton morceau est prêt. Tu peux l'exporter pour le partager au monde entier.",
      button: "Terminer le guide",
    }
  };

  const current = content[step];

  return (
    <div className="fixed bottom-8 right-8 w-80 bg-[#1e2229] border-2 border-cyan-500 shadow-[0_0_30px_rgba(6,182,212,0.3)] rounded-2xl p-6 z-[100] animate-in slide-in-from-bottom-4 fade-in">
      <div className="flex justify-between items-start mb-4">
        <h3 className="text-cyan-400 font-black uppercase tracking-widest text-sm">{current.title}</h3>
        <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
          <i className="fas fa-times"></i>
        </button>
      </div>
      <p className="text-slate-300 text-xs leading-relaxed mb-6">
        {current.text}
      </p>
      <div className="flex justify-between items-center">
        <span className="text-[10px] text-slate-600 font-bold uppercase">Guide Interactif</span>
        <button 
          onClick={onNext}
          className="bg-cyan-500 hover:bg-cyan-400 text-[#0f1115] px-4 py-2 rounded-lg text-[10px] font-black uppercase transition-all transform active:scale-95"
        >
          {current.button}
        </button>
      </div>
      
      {step === GuideStep.IMPORT_INSTRUMENTAL && (
        <div className="absolute -left-12 top-1/2 transform -translate-y-1/2 animate-bounce text-cyan-500">
           <i className="fas fa-arrow-left fa-2x"></i>
        </div>
      )}
    </div>
  );
};

export default ArtistGuide;
