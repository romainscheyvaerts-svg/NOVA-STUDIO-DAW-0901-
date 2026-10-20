import React, { useState } from 'react';
import { detectedLowEnd, isLiteFor, PerfChoice, readPerfChoice, setPerfChoice } from '../utils/perfMode';

/**
 * Réglage « Mode léger » (réglages audio) : PC peu puissant → moins d'effets visuels,
 * affichage de la lecture à 30 images/s. L'audio n'est jamais touché.
 */
const CHOIX: { v: PerfChoice; label: string }[] = [
  { v: 'auto', label: 'Auto' },
  { v: 'leger', label: 'Activé' },
  { v: 'complet', label: 'Désactivé' },
];

const PerfModeSetting: React.FC = () => {
  const [choice, setChoice] = useState<PerfChoice>(readPerfChoice);
  const lowEnd = detectedLowEnd();
  const lite = isLiteFor(choice, (navigator as any).hardwareConcurrency, (navigator as any).deviceMemory);
  const pick = (v: PerfChoice) => { setChoice(v); setPerfChoice(v); };
  return (
    <div className="space-y-1.5" data-testid="perf-mode">
      <div className="flex items-center justify-between gap-3 px-1">
        <span className="flex items-center gap-2 font-black text-slate-200 text-sm"><i className="fas fa-feather" aria-hidden="true"></i>Mode léger</span>
        <div role="radiogroup" aria-label="Mode léger" className="flex rounded-lg bg-white/5 p-0.5">
          {CHOIX.map(c => (
            <button key={c.v} type="button" role="radio" aria-checked={choice === c.v} onClick={() => pick(c.v)}
              className={`min-h-9 px-3 rounded-md text-[11px] font-bold ${choice === c.v ? 'bg-cyan-500 text-black' : 'text-slate-300 hover:text-white'}`}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] leading-snug text-slate-400 px-1" role="status">
        {lite
          ? 'Actif : moins d’effets visuels et un affichage plus calme pour laisser toute la puissance au son.'
          : 'Inactif : tous les effets visuels.'}
        {choice === 'auto' && (lowEnd ? ' Ce PC est peu puissant : activé automatiquement.' : ' Ce PC est assez puissant.')}
        {' '}Le son n’est jamais touché.
      </p>
    </div>
  );
};

export default PerfModeSetting;
