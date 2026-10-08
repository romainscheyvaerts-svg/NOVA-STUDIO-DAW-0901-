import React, { useState } from 'react';
import { Track, TrackType } from '../types';
import { busUsage, createBus, deleteBus, renameBus, SEND_SLOT_LETTERS, setTrackInputBus } from '../utils/trackStructure';
import { applyTracks } from '../utils/structureBus';

/**
 * Bus nommés (I/O Setup de Pro Tools, simplifié) : créer, renommer, supprimer
 * un bus (« LEAD A », « VOX ALL », « RV »…) et voir qui l'écoute (entrée), qui
 * y sort et qui y envoie (envois a-j).
 */
const uid = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const Chip: React.FC<{ children: React.ReactNode; tone?: 'in' | 'out' | 'send' }> = ({ children, tone = 'out' }) => (
  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone === 'in' ? 'bg-cyan-500/15 text-cyan-300' : tone === 'send' ? 'bg-violet-500/15 text-violet-300' : 'bg-amber-500/15 text-amber-300'}`}>{children}</span>
);

const BusPanel: React.FC<{ tracks: Track[]; onClose: () => void; className?: string }> = ({ tracks, onClose, className }) => {
  const [name, setName] = useState('');
  const usage = busUsage(tracks);
  const hasMaster = tracks.some(t => t.id === 'master');
  const add = () => {
    const n = name.trim();
    if (!n) return;
    applyTracks(ts => createBus(ts, n).tracks, `Bus « ${n} » créé`);
    setName('');
  };
  const makeListener = (busId: string, busName: string) => applyTracks(ts => {
    const id = uid('aux');
    const aux: Track = {
      id, name: `${busName} BUS`, type: TrackType.BUS, color: '#22d3ee', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
      volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0,
    };
    const mi = ts.findIndex(t => t.id === 'master');
    const withAux = mi < 0 ? [...ts, aux] : [...ts.slice(0, mi), aux, ...ts.slice(mi)];
    return setTrackInputBus(withAux, id, busId);
  }, `Piste « ${busName} BUS » créée : elle écoute le bus « ${busName} »`);

  return (
    <aside role="dialog" aria-label="Bus nommés" data-testid="bus-panel" className={`flex flex-col rounded-2xl border border-nv-line bg-nv-panel shadow-2xl ${className || ''}`}>
      <div className="flex items-center gap-2 border-b border-nv-line px-3 py-2">
        <i className="fas fa-project-diagram text-nv-accent text-[12px]" />
        <h2 className="flex-1 text-[13px] font-bold text-nv-ink">Bus nommés</h2>
        <button type="button" onClick={onClose} aria-label="Fermer" className="nova-hit-tactile w-8 h-8 rounded-lg text-nv-muted hover:text-nv-ink"><i className="fas fa-times" /></button>
      </div>
      <p className="px-3 pt-2 text-[10px] text-nv-muted">Comme l’I/O Setup de Pro Tools : un bus est un chemin nommé. Une piste y <b>sort</b> (sortie) ou y <b>envoie</b> (envois a-j) ; un aux l’<b>écoute</b> (entrée).</p>
      <form className="flex gap-1.5 px-3 pt-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Nom du bus (LEAD A, VOX ALL, RV…)" aria-label="Nom du nouveau bus" data-testid="bus-new-name"
          className="min-w-0 flex-1 h-9 rounded-lg border border-nv-line bg-nv-well px-2 text-[12px] text-nv-ink outline-none focus:border-nv-accent" />
        <button type="submit" disabled={!name.trim() || !hasMaster} data-testid="bus-create"
          className="nova-hit-tactile h-9 rounded-lg bg-cyan-500 px-3 text-[12px] font-bold text-black disabled:opacity-40">Créer</button>
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-2">
        {usage.length === 0 && <p className="py-6 text-center text-[12px] text-nv-muted">Aucun bus nommé pour l’instant. Crée « LEAD A » puis choisis-le en sortie des pistes lead.</p>}
        {usage.map(u => (
          <div key={u.bus.id} className="rounded-xl border border-nv-line bg-nv-surface p-2" data-testid={`bus-row-${u.bus.id}`}>
            <div className="flex items-center gap-1.5">
              <input defaultValue={u.bus.name} aria-label={`Renommer le bus ${u.bus.name}`}
                onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v && v !== u.bus.name) applyTracks(ts => renameBus(ts, u.bus.id, v), `Bus renommé : « ${v} »`); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
                className="min-w-0 flex-1 h-8 rounded-lg border border-transparent bg-transparent px-1 text-[13px] font-bold text-nv-ink hover:border-nv-line focus:border-nv-accent outline-none" />
              <span className="text-[10px] text-nv-muted">{u.bus.channels === 1 ? 'mono' : 'stéréo'}</span>
              <button type="button" onClick={() => applyTracks(ts => deleteBus(ts, u.bus.id), `Bus « ${u.bus.name} » supprimé`)}
                aria-label={`Supprimer le bus ${u.bus.name}`} title="Supprimer le bus : les pistes qui y sortaient repartent vers le master"
                className="nova-hit-tactile w-8 h-8 rounded-lg text-nv-muted hover:text-red-400"><i className="fas fa-trash text-[10px]" /></button>
            </div>
            <div className="mt-1 grid grid-cols-[70px_1fr] gap-x-2 gap-y-1 text-[10px]">
              <span className="text-nv-muted">Écouté par</span>
              <div className="flex flex-wrap gap-1">
                {u.listeners.length ? u.listeners.map(l => <Chip key={l.id} tone="in">{l.name}</Chip>) : (
                  <>
                    <span className="text-amber-400">personne : le son qui y arrive est perdu</span>
                    <button type="button" onClick={() => makeListener(u.bus.id, u.bus.name)} className="rounded-full bg-nv-accent/15 px-2 py-0.5 font-bold text-nv-accent">Créer la piste qui l’écoute</button>
                  </>
                )}
                {u.listeners.length > 1 && <span className="text-nv-muted">(le son arrive dans chacune)</span>}
              </div>
              <span className="text-nv-muted">Y sortent</span>
              <div className="flex flex-wrap gap-1">{u.outputs.length ? u.outputs.map(o => <Chip key={o.id}>{o.name}</Chip>) : <span className="text-nv-muted">—</span>}</div>
              <span className="text-nv-muted">Y envoient</span>
              <div className="flex flex-wrap gap-1">{u.senders.length ? u.senders.map(s => <Chip key={`${s.track.id}-${s.slot}`} tone="send">{s.track.name} · {SEND_SLOT_LETTERS[s.slot].toUpperCase()}</Chip>) : <span className="text-nv-muted">—</span>}</div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
};

export default BusPanel;
