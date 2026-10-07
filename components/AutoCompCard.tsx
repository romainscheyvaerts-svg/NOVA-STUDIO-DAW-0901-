import React from 'react';
import { PhraseChoice } from '../utils/autoComp';
import { TakeScore } from '../utils/takeScore';
import { takeColor } from './PlaylistLanes';

/**
 * Proposition de la « Meilleure prise » (IA locale) : le comp est déjà en
 * place (on l'entend), l'artiste le garde ou revient à son comp d'avant.
 */
export interface AutoCompProposal {
  trackId: string;
  trackName: string;
  choices: PhraseChoice[];
  takeScores: Record<number, TakeScore>;
  names: Record<number, string>;
}

const at = (x: number) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, '0').replace('.', ',')}`;

const AutoCompCard: React.FC<{ proposal: AutoCompProposal | null; onKeep: () => void; onRevert: () => void; onListen: (start: number) => void }> =
  ({ proposal, onKeep, onRevert, onListen }) => {
  if (!proposal) return null;
  const ranking = Object.entries(proposal.takeScores).map(([n, s]) => ({ n: Number(n), s })).sort((a, b) => b.s.total - a.s.total);
  return (
    <div data-auto-comp role="dialog" aria-label="Meilleure prise proposée par l'IA"
      className="fixed z-[560] left-1/2 -translate-x-1/2 bottom-24 w-[min(560px,calc(100vw-24px))] rounded-2xl border border-cyan-400/40 bg-[#101318]/95 backdrop-blur shadow-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-black text-white">✨ Meilleure prise — {proposal.trackName}</p>
          <p className="text-[11.5px] text-slate-400 mt-0.5">
            J'ai noté chaque prise phrase par phrase (justesse, calage sur le temps, niveau, bruit), sur ton ordi, sans rien envoyer. Le comp est en place : écoute-le.
          </p>
        </div>
      </div>
      <div className="mt-3 max-h-40 overflow-y-auto space-y-1 pr-1">
        {proposal.choices.map((c, i) => {
          const sc = c.scores[c.n];
          return (
            <button key={i} type="button" onClick={() => onListen(c.start)}
              title="Écouter ce passage"
              className="w-full flex items-center gap-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] px-2 h-9 text-left">
              <span className="w-1.5 h-5 rounded-full shrink-0" style={{ background: takeColor(c.n) }} />
              <span className="text-[11px] text-slate-400 w-28 shrink-0">{at(c.start)} → {at(c.end)}</span>
              <span className="text-[12px] font-bold text-white truncate flex-1">{proposal.names[c.n] || `Prise ${c.n}`}</span>
              <span className="text-[11px] font-black text-cyan-300 shrink-0">{sc.total}/100</span>
            </button>
          );
        })}
      </div>
      {ranking.length > 0 && (
        <p className="mt-2 text-[10.5px] text-slate-500">
          Notes moyennes : {ranking.map(r => `${proposal.names[r.n] || `Prise ${r.n}`} ${r.s.total} (justesse ${r.s.pitch}, calage ${r.s.timing}, niveau ${r.s.level}, bruit ${r.s.noise})`).join(' · ')}
        </p>
      )}
      <div className="mt-3 flex flex-col sm:flex-row gap-2">
        <button type="button" onClick={onKeep} className="h-11 sm:flex-1 rounded-xl bg-cyan-400 text-black text-[13px] font-black">✓ Garder ce comp</button>
        <button type="button" onClick={onRevert} className="h-11 sm:flex-1 rounded-xl border border-white/15 text-white text-[13px] font-bold hover:bg-white/10">↩ Revenir à mon comp d'avant</button>
      </div>
    </div>
  );
};

export default AutoCompCard;
