import React, { useEffect, useRef, useState } from 'react';
import { automationRecorder } from '../services/AutomationManager';
import { useKnobInteraction } from '../hooks/useKnobInteraction';

interface SmartKnobProps {
  id: string;           // Identifiant unique du potard (ex: 'track-1-pan')
  targetId: string;     // Piste pilotée (ex: 'track-1')
  paramId?: string;     // Paramètre automatisable (ex: 'pan', 'volume', 'send::send-delay')
  label: string;
  value: number;        // Valeur affichée (réglage, ou automation entendue pendant la lecture)
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
  color = '#00f2ff', suffix = '', size = 50, defaultValue, format
}) => {
  // État local visuel (découplé du parent pour un geste fluide)
  const [visualValue, setVisualValue] = useState(value);
  const internalValueRef = useRef(value);
  const [held, setHeld] = useState(false);

  // Synchro avec les props (réglage changé ailleurs, ou automation rejouée)
  useEffect(() => {
    setVisualValue(value);
    internalValueRef.current = value;
  }, [value]);

  // GESTES : glisser, Maj = fin, molette, double-clic = défaut.
  // Pendant la lecture, sur une piste en Touch / Latch / Write / Trim, l'appui
  // et le relâchement bornent l'écriture d'automation (services/AutomationManager).
  const knob = useKnobInteraction(visualValue, (newVal) => {
    setVisualValue(newVal);
    internalValueRef.current = newVal;
    onChange(newVal);
  }, {
    min, max, sensitivity: 150, defaultValue,
    onStart: () => { setHeld(true); if (paramId) automationRecorder.touch(targetId, paramId); },
    onEnd: () => { setHeld(false); if (paramId) automationRecorder.release(targetId, paramId); },
  });

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
        
        {/* Écriture d'automation en cours (point rouge tant que le potard est tenu) */}
        <div data-knob-id={id} className={`absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500 transition-opacity pointer-events-none ${held && paramId && automationRecorder.isCapturing(targetId, paramId) ? 'opacity-100' : 'opacity-0'}`} />
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
