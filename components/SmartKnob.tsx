
import React, { useEffect, useRef, useState } from 'react';
import { automationManager } from '../services/AutomationManager';
import { useKnobInteraction } from '../hooks/useKnobInteraction';

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
  /** Valeur du double-clic (sinon 0 pour une plage bipolaire, ou la valeur d'ouverture). */
  defaultValue?: number;
  /** Affichage de la valeur (ex. « -3.0 dB », « G 20 »). */
  format?: (v: number) => string;
}

export const SmartKnob: React.FC<SmartKnobProps> = ({
  id, targetId, paramId, label, value, min, max, onChange, 
  isBridged = false, color = '#00f2ff', suffix = '', size = 50, defaultValue, format
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

  // GESTES (WRITE MODE) : glisser, Maj = fin, molette, double-clic = défaut.
  // Le moteur d'automation enregistre pendant que le potard est « touché ».
  const knob = useKnobInteraction(visualValue, (newVal) => {
    setVisualValue(newVal);
    internalValueRef.current = newVal;
    // Envoi au moteur (qui gère le throttling VST et l'enregistrement)
    const currentTime = window.DAW_CONTROL ? window.DAW_CONTROL.getState().currentTime : 0;
    automationManager.setValue(id, newVal, currentTime);
  }, { min, max, sensitivity: 150, defaultValue, onStart: () => automationManager.touch(id), onEnd: () => automationManager.release(id) });

  // RENDER (CANVAS ou SVG simple)
  // On utilise un SVG pour la netteté et la performance CSS
  const norm = (visualValue - min) / (max - min);
  const rotation = (norm * 270) - 135; // -135deg à +135deg

  return (
    <div className="flex flex-col items-center space-y-2 select-none group">
      <div
        {...knob.bind}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(visualValue.toFixed(3))}
        aria-valuetext={format ? format(visualValue) : `${visualValue.toFixed(1)}${suffix}`}
        className="nova-hit-tactile relative rounded-full bg-[#14161a] border-2 border-white/10 flex items-center justify-center cursor-ns-resize hover:border-white/30 transition-colors shadow-lg touch-none"
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
            {format ? format(visualValue) : <>{visualValue.toFixed(1)}{suffix}</>}
          </span>
        </div>
      </div>
    </div>
  );
};
