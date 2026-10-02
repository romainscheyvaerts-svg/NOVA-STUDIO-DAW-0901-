import React, { useEffect, useRef, useState } from 'react';
import { CollabRole } from '../types';
import { CollabMember, ROLE_LABEL } from '../services/Collab';

/**
 * Collaboration à distance : inviter un ingé son / un beatmaker / un artiste
 * (lien par rôle), voir qui est connecté, discuter. Qui fait quoi :
 * l'artiste enregistre et édite ses voix, l'ingé son règle le mix (effets
 * Nova, ou ses VST en gelant la piste), le beatmaker ajoute ses pistes.
 */
export interface CollabMessage { id: string; from: string; role: CollabRole; text: string; at: number; mine?: boolean }

interface Props {
  open: boolean;
  onClose: () => void;
  active: boolean;
  role: CollabRole | null;
  name: string;
  members: CollabMember[];
  messages: CollabMessage[];
  inviteUrl: (role: CollabRole) => string | null;
  onStart: (role: CollabRole, name: string) => void;
  onLeave: () => void;
  onSend: (text: string) => void;
  busy?: string | null;
}

const ROLE_HELP: Record<CollabRole, string> = {
  artist: 'enregistre et édite ses voix ; peut verrouiller le volume d\'une piste',
  engineer: 'règle volumes, effets Nova et envois (ou ses VST : la piste est gelée puis envoyée)',
  beatmaker: 'ajoute batterie, basse et ses propres pistes',
};
const ROLE_COLOR: Record<CollabRole, string> = { artist: 'text-cyan-300', engineer: 'text-amber-300', beatmaker: 'text-violet-300' };

const CollabPanel: React.FC<Props> = (p) => {
  const [text, setText] = useState('');
  const [startRole, setStartRole] = useState<CollabRole>('artist');
  const [startName, setStartName] = useState('');
  const [copied, setCopied] = useState<CollabRole | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [p.messages.length, p.open]);
  if (!p.open) return null;

  const copy = async (r: CollabRole) => {
    const url = p.inviteUrl(r);
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setCopied(r); setTimeout(() => setCopied(null), 1600); } catch { /* */ }
  };
  const send = () => { const t = text.trim(); if (t) { p.onSend(t); setText(''); } };
  const btn = 'h-10 rounded-xl px-3 text-[12px] font-black transition-colors disabled:opacity-40';

  return (
    <div className="fixed right-3 bottom-20 md:bottom-4 z-[640] w-[min(380px,calc(100vw-24px))] max-h-[min(640px,calc(100vh-110px))] flex flex-col rounded-3xl border border-white/10 bg-[#121418]/97 shadow-2xl backdrop-blur" role="dialog" aria-labelledby="collab-title">
      <div className="flex items-center gap-2 p-4 border-b border-white/5">
        <h2 id="collab-title" className="flex-1 text-[14px] font-black text-white">👥 Collaboration</h2>
        {p.active && p.role && <span className={`text-[11px] font-black ${ROLE_COLOR[p.role]}`}>{ROLE_LABEL[p.role]}</span>}
        <button type="button" onClick={p.onClose} aria-label="Fermer" className="w-9 h-9 rounded-xl bg-white/5 text-slate-300">✕</button>
      </div>

      {!p.active ? (
        <div className="p-4 space-y-3 overflow-y-auto">
          <p className="text-[12px] text-slate-300">Travaille à distance sur cette session : l'artiste, l'ingé son et le beatmaker voient les changements des autres en direct.</p>
          <label className="block text-[11px] text-slate-400">Ton rôle
            <select value={startRole} onChange={e => setStartRole(e.target.value as CollabRole)}
              className="mt-1 h-11 w-full rounded-xl border border-white/10 bg-black/40 px-2 text-[13px] font-bold text-white">
              {(['artist', 'engineer', 'beatmaker'] as CollabRole[]).map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <p className="text-[11px] text-slate-500">{ROLE_LABEL[startRole]} : {ROLE_HELP[startRole]}.</p>
          <input value={startName} onChange={e => setStartName(e.target.value)} placeholder="Ton nom (affiché aux autres)"
            className="h-11 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-[13px] text-white" />
          <button type="button" disabled={!!p.busy} onClick={() => p.onStart(startRole, startName.trim() || ROLE_LABEL[startRole])}
            className={`${btn} w-full bg-cyan-500 text-black`}>{p.busy || 'Démarrer la collaboration'}</button>
          <p className="text-[10px] text-slate-500">La session est mise en ligne (audio des voix compris, jamais le beat non acheté).</p>
        </div>
      ) : (
        <>
          <div className="p-4 space-y-2 border-b border-white/5">
            <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">Inviter</p>
            <div className="grid grid-cols-3 gap-1.5">
              {(['artist', 'engineer', 'beatmaker'] as CollabRole[]).map(r => (
                <button key={r} type="button" onClick={() => copy(r)} className={`${btn} bg-white/5 text-white hover:bg-white/10 text-[11px]`} title={`Copier le lien d'invitation ${ROLE_LABEL[r]}`}>
                  {copied === r ? 'Copié ✓' : `+ ${ROLE_LABEL[r]}`}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1" aria-label="Connectés">
              {p.members.map(m => (
                <span key={m.member_key} className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-[11px] text-slate-200">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />{m.display_name} <span className={ROLE_COLOR[m.role] || ''}>· {ROLE_LABEL[m.role] || m.role}</span>
                </span>
              ))}
            </div>
          </div>
          <div ref={listRef} className="flex-1 min-h-[160px] overflow-y-auto p-4 space-y-2" aria-live="polite">
            {p.messages.length === 0 && <p className="text-[12px] text-slate-500">Pas encore de message. Dis bonjour !</p>}
            {p.messages.map(m => (
              <div key={m.id} className={`max-w-[85%] rounded-2xl px-3 py-2 text-[13px] ${m.mine ? 'ml-auto bg-cyan-500/20 text-white' : 'bg-white/5 text-slate-100'}`}>
                {!m.mine && <p className={`text-[10px] font-black ${ROLE_COLOR[m.role] || 'text-slate-400'}`}>{m.from} · {ROLE_LABEL[m.role] || m.role}</p>}
                <p className="whitespace-pre-wrap break-words">{m.text}</p>
              </div>
            ))}
          </div>
          <div className="flex gap-2 p-3 border-t border-white/5">
            <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') send(); }}
              placeholder="Message…" aria-label="Message" className="h-11 flex-1 min-w-0 rounded-xl border border-white/10 bg-black/40 px-3 text-[13px] text-white" />
            <button type="button" onClick={send} className={`${btn} bg-cyan-500 text-black`} aria-label="Envoyer">➤</button>
          </div>
          <button type="button" onClick={p.onLeave} className="pb-3 text-[11px] text-slate-500 underline">Quitter la collaboration</button>
        </>
      )}
    </div>
  );
};

export default CollabPanel;
