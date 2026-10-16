import React, { useCallback, useEffect, useState } from 'react';
import { call } from '../services/SessionCloud';
import { messageClair } from '../utils/friendlyError';
import { onlineSessionInfo, type OnlineSession } from '../utils/cloudAccount';

/**
 * Projets en ligne d'un compte Make Music (séances en ligne, « Emporter la session ») : « Ouvrir un
 * projet » les liste pour un compte Make Music sans compte de l'ancien projet (utils/cloudAccount).
 * Avant : « Connecte-toi pour retrouver tes projets », alors que la personne était connectée.
 */
interface Props {
  email: string;
  onOpen: (link: string) => void;
  testid?: string;
}

const OnlineSessionsList: React.FC<Props> = ({ email, onOpen, testid = 'online-sessions' }) => {
  const [rows, setRows] = useState<OnlineSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null); setRows(null);
    try {
      const r = await call<{ sessions: OnlineSession[] }>('list_mine');
      setRows(r?.sessions || []);
    } catch (e) {
      setError(messageClair(e, 'Tes projets en ligne n’ont pas pu être lus : réessaie dans un instant.'));
    }
  }, []);
  useEffect(() => { void load(); }, [load, email]);

  if (error) return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 p-6 text-center" data-testid={`${testid}-error`}>
      <p className="max-w-xs text-[13px] text-slate-300">{error}</p>
      <button type="button" onClick={() => void load()} className="min-h-11 rounded-lg bg-white/10 px-5 text-xs font-bold text-white hover:bg-white/15">Réessayer</button>
    </div>
  );
  if (!rows) return (
    <div className="flex items-center justify-center p-6" role="status" aria-label="Chargement de tes projets en ligne">
      <div className="h-7 w-7 animate-spin rounded-full border-4 border-cyan-500/30 border-t-cyan-500" />
    </div>
  );
  const usable = rows.filter(r => r.link && !r.expired);
  return (
    <div className="space-y-2 p-4" data-testid={testid}>
      <p className="text-[11px] text-slate-400">Compte Make Music <span className="font-bold text-white break-all">{email}</span> · tes séances en ligne (audio compris)</p>
      {usable.length === 0 ? (
        <div className="space-y-1 py-6 text-center" data-testid={`${testid}-empty`}>
          <p className="text-[13px] font-bold text-white">Pas encore de projet en ligne</p>
          <p className="mx-auto max-w-xs text-[12px] text-slate-400">Dans le studio : « Sauvegarder » → « Emporter la session (en ligne) ». Ton projet apparaîtra ici, et sur studiomakemusic.com.</p>
        </div>
      ) : usable.map(s => (
        <button key={s.id} type="button" onClick={() => onOpen(s.link!)} data-testid={`${testid}-item`}
          className="flex w-full min-h-14 items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-left transition-all hover:border-cyan-500/40 hover:bg-white/[0.05]">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-300" aria-hidden="true">☁️</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-bold text-white">{s.name || 'Sans nom'}</span>
            <span className="block text-[11px] text-slate-400">{onlineSessionInfo(s)}</span>
          </span>
          <span className="text-[12px] font-bold text-cyan-300">Ouvrir</span>
        </button>
      ))}
    </div>
  );
};

export default OnlineSessionsList;
