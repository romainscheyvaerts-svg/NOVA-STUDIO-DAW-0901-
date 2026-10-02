import React from 'react';
import { simpleModeStore, useSimpleMode } from '../utils/simpleMode';

/**
 * Interrupteur « Mode avancé » (menu ☰ et réglages audio). En mode instru ou
 * en ingé son / beatmaker, tous les outils sont déjà affichés.
 */
const SimpleModeToggle: React.FC<{ onDone?: () => void }> = ({ onDone }) => {
  const { simple, forced } = useSimpleMode();
  const advanced = !simple;
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        role="switch"
        aria-checked={advanced}
        disabled={forced}
        onClick={() => { simpleModeStore.setPref(advanced); onDone?.(); }}
        className={`w-full min-h-12 px-4 py-2 rounded-lg flex items-center justify-between gap-3 font-black transition-all ${advanced ? 'bg-cyan-500/20 text-cyan-300' : 'bg-white/5 text-slate-200'} ${forced ? 'opacity-60 cursor-not-allowed' : ''}`}
      >
        <span className="flex items-center gap-2 text-left">
          <i className="fas fa-sliders-h"></i>
          <span>Mode avancé</span>
        </span>
        <span className={`relative w-11 h-6 rounded-full shrink-0 transition-colors ${advanced ? 'bg-cyan-500' : 'bg-white/15'}`} aria-hidden="true">
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${advanced ? 'left-[22px]' : 'left-0.5'}`} />
        </span>
      </button>
      <p className="text-[11px] leading-snug text-slate-400 px-1">
        {forced
          ? 'Mode instru / ingé son : tous les outils sont affichés.'
          : advanced
            ? 'Console, effets, VST, automation et routage affichés.'
            : 'Mode simple : beat, REC, prises, Mix auto, paroles et Nova. Active le mode avancé pour la console et les effets (rien n\'est perdu).'}
      </p>
    </div>
  );
};

export default SimpleModeToggle;
