import React from 'react';

interface WelcomeStepsProps {
  open: boolean;
  beatLoaded: boolean;
  isMobile: boolean;
  onPickBeat: () => void;
  onClose: () => void;
}

/**
 * Première visite : les 3 gestes à connaître, rien de plus. L'artiste doit
 * comprendre en 5 secondes qu'il peut enregistrer tout de suite.
 */
const WelcomeSteps: React.FC<WelcomeStepsProps> = ({ open, beatLoaded, isMobile, onPickBeat, onClose }) => {
  if (!open) return null;
  const steps = [
    { n: 1, done: beatLoaded, icon: '🎵', title: 'Choisis un beat', text: isMobile ? 'Onglet « Sons » en bas → « Essayer ».' : 'Dans le catalogue à gauche → « Essayer ».' },
    { n: 2, done: false, icon: '🔴', title: 'Appuie sur REC', text: 'Décompte 4-3-2-1, puis chante. Réappuie pour arrêter. Tes paroles peuvent défiler (📝 Paroles).' },
    { n: 3, done: false, icon: '🎚️', title: 'Écoute ta voix mixée', text: 'Je pose un style de mix tout seul après ta prise. Change-le avec « Mix auto », ou demande à Nova.' },
  ];
  return (
    <div className="fixed inset-0 z-[650] flex items-end sm:items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      {/* Téléphone en paysage : la carte dépassait, « C'est parti » était hors écran */}
      <div className="w-full max-w-md max-h-full overflow-y-auto overscroll-contain rounded-3xl border border-white/10 bg-[#121418] p-6 shadow-2xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-cyan-300">Nova Studio · Make Music</p>
        <h2 id="welcome-title" className="mt-2 text-2xl font-black text-white">Ta voix sur nos beats, en 3 gestes</h2>
        <ol className="mt-5 space-y-3">
          {steps.map(s => (
            <li key={s.n} className={`flex gap-3 rounded-2xl border p-3 ${s.done ? 'border-emerald-400/40 bg-emerald-500/10' : 'border-white/10 bg-white/[0.03]'}`}>
              <span className="text-2xl leading-none mt-0.5">{s.done ? '✅' : s.icon}</span>
              <span>
                <span className="block text-[14px] font-bold text-white">{s.n}. {s.title}</span>
                <span className="block text-[12px] text-slate-300 mt-0.5">{s.text}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-[12px] text-slate-400">🎧 Conseil : des écouteurs filaires. Ta session se sauvegarde toute seule sur cet appareil.</p>
        <div className="mt-5 flex flex-col sm:flex-row gap-2">
          {!beatLoaded && (
            <button type="button" onClick={onPickBeat} className="h-12 shrink-0 sm:flex-1 rounded-xl bg-cyan-500 text-black font-black">
              Choisir un beat
            </button>
          )}
          <button type="button" onClick={onClose} className={`h-12 shrink-0 sm:flex-1 rounded-xl font-bold ${beatLoaded ? 'bg-cyan-500 text-black font-black' : 'bg-white/10 text-white'}`}>
            {beatLoaded ? "C'est parti" : 'Plus tard'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default WelcomeSteps;
