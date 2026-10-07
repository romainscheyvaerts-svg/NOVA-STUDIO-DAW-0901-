import React from 'react';
import type { EditCommands } from '../hooks/useEditCommands';
import { useEditSelection } from '../utils/editSelection';
import { selLength } from '../utils/timeSelection';

/**
 * Barre d'actions de la sélection de plage (Sélecteur / Smart Tool) : tout ce
 * qu'on fait sur une plage dans Pro Tools, à portée de clic, avec le raccourci
 * dans l'infobulle. Au doigt (tablette), les libellés restent courts.
 */
const fmt = (s: number) => (s >= 1 ? `${s.toFixed(2).replace('.', ',')} s` : `${Math.round(s * 1000)} ms`);

const RangeActionsBar: React.FC<{ commands: EditCommands }> = ({ commands }) => {
  const { time } = useEditSelection();
  if (!time) return null;
  const actions: { label: string; icon: string; title: string; run: () => unknown; danger?: boolean }[] = [
    { label: 'Couper', icon: 'fa-cut', title: 'Couper la plage (Ctrl+X, comme dans Pro Tools)', run: commands.cutSelection },
    { label: 'Copier', icon: 'fa-copy', title: 'Copier la plage (Ctrl+C)', run: commands.copySelection },
    { label: 'Dupliquer', icon: 'fa-clone', title: 'Dupliquer la plage juste après (Ctrl+D, « Duplicate » de Pro Tools)', run: commands.duplicateSelection },
    { label: 'Séparer', icon: 'fa-grip-lines-vertical', title: 'Séparer les clips aux bords de la plage (Ctrl+E, « Separate Clip » de Pro Tools)', run: commands.separate },
    { label: 'Consolider', icon: 'fa-layer-group', title: 'Consolider : un seul clip par piste sur la plage, sans effets (Alt+Maj+3, « Consolidate Clip » de Pro Tools)', run: () => { void commands.consolidateSelection(); } },
    { label: 'Fondus', icon: 'fa-bezier-curve', title: 'Créer des fondus sur la plage : entrée, sortie ou crossfade sur une jonction (Ctrl+F, « Fades » de Pro Tools)', run: commands.fadesFromSelection },
    { label: 'Boucler', icon: 'fa-sync-alt', title: 'Boucler la lecture sur la plage (« Loop Playback » sur la sélection)', run: commands.loopSelection },
    { label: 'Punch', icon: 'fa-bullseye', title: 'La plage devient la zone de punch : REC ne remplacera qu\'elle (Punch-in / punch-out de Pro Tools)', run: commands.punchSelection },
    { label: 'Exporter', icon: 'fa-compact-disc', title: 'Exporter seulement la plage (« Bounce » de la sélection dans Pro Tools)', run: commands.exportSelection },
    { label: 'Effacer', icon: 'fa-trash', title: 'Effacer le contenu de la plage, en laissant un blanc (Suppr)', run: commands.deleteSelection, danger: true },
  ];
  return (
    <div role="toolbar" aria-label="Actions sur la sélection de plage" data-nova-target="range-actions"
      className="absolute left-1/2 -translate-x-1/2 top-[52px] z-40 max-w-[calc(100%-24px)] flex flex-wrap items-center justify-center gap-1 px-2 py-1 rounded-xl border border-sky-400/30 bg-[#0d1117]/95 shadow-2xl backdrop-blur">
      <span className="px-2 text-[10px] font-black text-sky-300 whitespace-nowrap" title="Plage sélectionnée (Sélecteur de Pro Tools)">
        Plage {fmt(selLength(time))} · {time.trackIds.length} piste{time.trackIds.length > 1 ? 's' : ''}
      </span>
      {actions.map(a => (
        <button key={a.label} type="button" title={a.title} aria-label={a.label} onClick={() => a.run()}
          className={`h-8 [@media(pointer:coarse)]:h-10 px-2 rounded-lg flex items-center gap-1.5 text-[10px] font-bold border border-white/10 transition-colors ${a.danger ? 'text-red-300 hover:bg-red-500/20' : 'text-slate-200 hover:bg-white/10'}`}>
          <i className={`fas ${a.icon} text-[10px]`}></i>
          <span className="hidden 2xl:inline">{a.label}</span>
        </button>
      ))}
      <button type="button" onClick={commands.clearSelection} aria-label="Désélectionner la plage" title="Désélectionner la plage"
        className="h-8 [@media(pointer:coarse)]:h-10 w-8 rounded-lg text-slate-400 hover:text-white hover:bg-white/10">
        <i className="fas fa-times text-[11px]"></i>
      </button>
    </div>
  );
};

export default RangeActionsBar;
