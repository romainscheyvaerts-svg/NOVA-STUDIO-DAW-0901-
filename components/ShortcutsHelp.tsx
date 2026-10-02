import React from 'react';

/** Aide-mémoire des raccourcis clavier (touche « ? »). */
const GROUPS: { title: string; keys: [string, string][] }[] = [
  { title: 'Transport', keys: [
    ['Espace', 'Lecture / pause'],
    ['R', 'Enregistrer (piste armée)'],
    ['Échap', 'Stop'],
    ['Entrée · Début', 'Retour au début'],
    ['Fin', 'Aller à la fin du morceau'],
    [', / .', 'Mesure précédente / suivante'],
    ['Maj + , / .', 'Temps précédent / suivant'],
    ['L', 'Boucle on / off'],
    ['K', 'Poser un repère'],
  ] },
  { title: 'Édition', keys: [
    ['Ctrl + Z / Ctrl + Y', 'Annuler / rétablir'],
    ['Ctrl + C / X / V', 'Copier / couper / coller le clip'],
    ['D', 'Dupliquer le clip'],
    ['Suppr', 'Supprimer le clip'],
    ['M · S', 'Mute / solo du clip'],
    ['1 · 2 · 3', 'Outil sélection / ciseaux / gomme'],
    ['Maj (en glissant)', 'Désactiver la grille'],
    ['Alt (en glissant)', 'Copier le clip'],
    ['Ctrl + molette', 'Zoom'],
  ] },
  { title: 'Projet', keys: [
    ['Ctrl + S', 'Sauvegarder'],
    ['?', 'Afficher / masquer cette aide'],
  ] },
];

const ShortcutsHelp: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
      <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-[#121418] p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center">
          <h2 id="shortcuts-title" className="mr-auto text-lg font-black text-white">⌨️ Raccourcis clavier</h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-9 w-9 rounded-lg bg-white/5 text-slate-300">✕</button>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          {GROUPS.map(g => (
            <div key={g.title}>
              <p className="mb-2 text-[11px] font-black uppercase tracking-widest text-cyan-400">{g.title}</p>
              <ul className="space-y-1.5">
                {g.keys.map(([k, d]) => (
                  <li key={k} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-slate-300">{d}</span>
                    <kbd className="shrink-0 rounded-md border border-white/15 bg-white/5 px-2 py-0.5 font-mono text-[11px] text-white">{k}</kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ShortcutsHelp;
