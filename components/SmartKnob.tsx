
import React, { useEffect, useRef, useState } from 'react';
import { automationManager } from '../services/AutomationManager';

interface SmartKnobProps {
  id: string;           // ID unique pour le registre automation (ex: 'track-1-vol')
  targetId: string;     // ID de l'objet cible (ex: 'track-1')
  paramId?: string;     // ID du paramètre pour le moteur audio (ex: 'pan', 'volume', 'send::delay')
  label: string;
  value: number;        // Valeur initiale (state React parent)
  min: number;
  max: number;
  onChange: (val: number) => void; // Callback "réel" (ex: updateTrack)
  isBridged?: boolean;  // True si VST
  color?: string;
  suffix?: string;
  size?: number;
}

export const SmartKnob: React.FC<SmartKnobProps> = ({
  id, targetId, paramId, label, value, min, max, onChange, 
  isBridged = false, color = '#00f2ff', suffix = '', size = 50
}) => {
  // État local visuel (découplé du parent pour performance 60fps en lecture)
  const [visualValue, setVisualValue] = useState(value);
  const internalValueRef = useRef(value);
  
  // Synchro avec les props (si changement externe hors automation)
  useEffect(() => {
    setVisualValue(value);
    internalValueRef.current = value;
  }, [value]);

  // ENREGISTREMENT AU MANAGER
  useEffect(() => {
    // On enregistre le paramètre dans le cerveau
    automationManager.register(
      id, 
      targetId, 
      (val) => {
        // Callback appelé par le moteur (Read Mode)
        // On ne déclenche PAS onChange ici pour éviter la boucle infinie React
        // On applique directement l'effet si possible ou on laisse le moteur le faire via le callback passé
        // Ici, l'onChange passé en props est souvent une mise à jour d'état React.
        // Pour l'audio pur, on devrait idéalement bypasser React.
        // Mais pour rester compatible avec l'existant :
        onChange(val);
      }, 
      value, 
      isBridged
    );

    // Souscription pour la mise à jour visuelle fluide (bypass React re-render complet)
    automationManager.subscribeUI(id, (val) => {
      setVisualValue(val);
      internalValueRef.current = val;
    });

    return () => {
      automationManager.unregister(id);
      automationManager.unsubscribeUI(id);
    };
  }, [id, targetId, isBridged]); // Dependencies minimales

  // GESTION SOURIS (WRITE MODE)
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    automationManager.touch(id);
    
    const startY = e.clientY;
    const startVal = internalValueRef.current;
    const range = max - min;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaPixel = startY - moveEvent.clientY;
      const deltaVal = (deltaPixel / 150) * range; // Sensibilité
      
      let newVal = Math.max(min, Math.min(max, startVal + deltaVal));
      
      // Mise à jour visuelle locale
      setVisualValue(newVal);
      internalValueRef.current = newVal;

      // Envoi au moteur (qui gère le throttling VST et l'enregistrement)
      // Le moteur appellera ensuite le onChange réel si nécessaire
      const currentTime = window.DAW_CONTROL ? window.DAW_CONTROL.getState().currentTime : 0;
      automationManager.setValue(id, newVal, currentTime);
    };

    const handleMouseUp = () => {
      automationManager.release(id);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // RENDER (CANVAS ou SVG simple)
  // On utilise un SVG pour la netteté et la performance CSS
  const norm = (visualValue - min) / (max - min);
  const rotation = (norm * 270) - 135; // -135deg à +135deg

  return (
    <div className="flex flex-col items-center space-y-2 select-none group">
      <div 
        onMouseDown={handleMouseDown}
        className="relative rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-white/30 transition-colors shadow-lg"
        style={{ width: size, height: size }}
      >
        {/* Fond interne */}
        <div className="absolute inset-1 rounded-full border border-white/5 bg-black/40 shadow-inner pointer-events-none" />
        
        {/* Indicateur (Aiguille) */}
        <div 
          className="absolute top-1/2 left-1/2 w-1 h-[40%] -ml-0.5 -mt-[40%] origin-bottom rounded-full transition-transform duration-75 will-change-transform pointer-events-none"
          style={{ 
            backgroundColor: color, 
            boxShadow: `0 0 10px ${color}`, 
            transform: `rotate(${rotation}deg) translateY(20%)` 
          }}
        />
        
        {/* Status Automation (Point Rouge si Write) */}
        <div className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500 opacity-0 group-active:opacity-100 transition-opacity pointer-events-none" />
      </div>
      
      <div className="text-center">
        <span className="block text-[7px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</span>
        <div className="bg-black/60 px-2 py-0.5 rounded border border-white/5 min-w-[40px]">
          <span className="text-[9px] font-mono font-bold text-white">
            {visualValue.toFixed(1)}{suffix}
          </span>
        </div>
      </div>
    </div>
  );
};
