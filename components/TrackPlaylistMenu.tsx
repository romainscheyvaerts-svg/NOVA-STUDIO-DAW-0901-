import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Track } from '../types';
import { runEditCommand } from '../utils/editCommands';
import { canHavePlaylists, hasPlaylists, playlistsOf, playlistSummary } from '../utils/trackPlaylists';
import { chordLabel, keysOf } from '../utils/keymap';

/**
 * Playlists d'une piste (Pro Tools : sélecteur de playlist de l'en-tête) :
 * pastille « ▤ LEAD A.01 » dans l'en-tête quand la piste a plusieurs versions,
 * menu pour basculer, créer, dupliquer, renommer, supprimer. Au doigt :
 * lignes de 44 px, rien au survol seul. La logique est dans utils/trackPlaylists
 * (commandes du bus utils/editCommands : une étape d'annulation par geste).
 */

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const keyHint = (id: string) => { const k = keysOf(id)[0]; return k ? chordLabel(k) : ''; };

export const PlaylistMenu: React.FC<{ track: Track; anchor: { x: number; y: number }; onClose: () => void }> = ({ track, anchor, onClose }) => {
  const { list, activeId } = playlistsOf(track);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent | TouchEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const t = window.setTimeout(() => { window.addEventListener('mousedown', close); window.addEventListener('touchstart', close); }, 0);
    window.addEventListener('keydown', onKey, true);
    return () => { window.clearTimeout(t); window.removeEventListener('mousedown', close); window.removeEventListener('touchstart', close); window.removeEventListener('keydown', onKey, true); };
  }, [onClose]);
  const run = (cmd: Parameters<typeof runEditCommand>[0], arg: any) => { runEditCommand(cmd, arg); };
  const W = 300;
  const style: React.CSSProperties = { left: Math.max(8, Math.min(anchor.x, window.innerWidth - W - 8)), top: Math.max(8, Math.min(anchor.y, window.innerHeight - 380)), width: W };
  const row = 'w-full flex items-center gap-2 rounded-lg px-2 min-h-[34px] [@media(pointer:coarse)]:min-h-[44px] text-left text-[12px]';
  return createPortal(
    <div ref={ref} role="menu" aria-label={`Playlists de ${track.name}`} data-testid={`playlist-menu-${track.id}`} style={style}
      className="fixed z-[900] rounded-xl border border-nv-line bg-nv-panel p-1.5 text-nv-ink shadow-2xl"
      onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
      <p className="px-2 pt-1 pb-1 text-[10px] font-bold uppercase tracking-wide text-nv-muted">Playlists · {track.name}</p>
      <div className="max-h-[220px] overflow-y-auto">
        {list.map(p => {
          const active = p.id === activeId;
          const sum = playlistSummary(track, p.id);
          if (renaming === p.id) return (
            <form key={p.id} className="flex items-center gap-1 px-1 py-1" onSubmit={e => { e.preventDefault(); run('playlistRename', { trackId: track.id, id: p.id, name: draft }); setRenaming(null); }}>
              <input autoFocus value={draft} onChange={e => setDraft(e.target.value)} aria-label="Nom de la playlist" maxLength={60}
                className="flex-1 min-w-0 rounded-md border border-nv-line bg-nv-well px-2 py-1 text-[12px]" />
              <button type="submit" className="h-8 px-2 rounded-md bg-cyan-500 text-black text-[11px] font-bold">OK</button>
            </form>
          );
          return (
            <div key={p.id} className="flex items-center gap-1">
              <button type="button" role="menuitemradio" aria-checked={active} data-playlist-id={p.id}
                onClick={() => { if (!active) run('playlistSwitch', { trackId: track.id, id: p.id }); onClose(); }}
                title={active ? 'Version qu’on entend' : 'Écouter cette version (l’autre est gardée)'}
                className={`${row} flex-1 ${active ? 'bg-cyan-500/15 text-cyan-300 font-bold' : 'hover:bg-nv-accent/10'}`}>
                <i className={`fas ${active ? 'fa-volume-up' : 'fa-list'} w-4 text-center text-[10px]`} />
                <span className="flex-1 truncate">{p.name}</span>
                <span className="text-[10px] text-nv-muted">{sum.clips} clip{sum.clips > 1 ? 's' : ''}{sum.end ? ` · ${fmt(sum.end)}` : ''}</span>
              </button>
              <button type="button" aria-label={`Renommer ${p.name}`} title="Renommer" onClick={() => { setRenaming(p.id); setDraft(p.name); }}
                className="h-8 w-8 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 shrink-0 rounded-md text-nv-muted hover:text-nv-ink hover:bg-nv-accent/10"><i className="fas fa-pen text-[10px]" /></button>
              <button type="button" aria-label={`Supprimer ${p.name}`} disabled={active} title={active ? 'On ne supprime pas la version qu’on entend' : 'Supprimer cette version (Ctrl+Z pour la retrouver)'}
                onClick={() => run('playlistDelete', { trackId: track.id, id: p.id })}
                className="h-8 w-8 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 shrink-0 rounded-md text-nv-muted hover:text-red-400 hover:bg-red-500/10 disabled:opacity-30"><i className="fas fa-trash text-[10px]" /></button>
            </div>
          );
        })}
      </div>
      <div className="my-1 h-px bg-nv-line" />
      <button type="button" role="menuitem" data-testid="playlist-new" className={`${row} hover:bg-nv-accent/10`}
        onClick={() => { run('playlistNew', { trackIds: [track.id] }); onClose(); }}
        title="Pro Tools « New Playlist » : une piste vide pour une nouvelle version ; l’actuelle est gardée">
        <i className="fas fa-plus w-4 text-center text-[10px] text-nv-muted" /><span className="flex-1">Nouvelle playlist (vide)</span><span className="text-[10px] text-nv-muted">{keyHint('pt.playlistNew')}</span>
      </button>
      <button type="button" role="menuitem" data-testid="playlist-duplicate" className={`${row} hover:bg-nv-accent/10`}
        onClick={() => { run('playlistNew', { trackIds: [track.id], duplicate: true }); onClose(); }}
        title="Pro Tools « Duplicate Playlist » : copie de travail avant un nettoyage, une version clean, un autre comp">
        <i className="fas fa-clone w-4 text-center text-[10px] text-nv-muted" /><span className="flex-1">Dupliquer la playlist</span><span className="text-[10px] text-nv-muted">{keyHint('pt.playlistDuplicate')}</span>
      </button>
    </div>,
    document.body,
  );
};

/** Pastille de l'en-tête : nom de la playlist qu'on entend (visible dès qu'il y en a plusieurs). */
export const PlaylistChip: React.FC<{ track: Track }> = ({ track }) => {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!canHavePlaylists(track) || !hasPlaylists(track)) return null;
  const { list, activeId } = playlistsOf(track);
  const name = list.find(p => p.id === activeId)?.name || track.name;
  const i = list.findIndex(p => p.id === activeId);
  return (
    <>
      <button type="button" data-testid={`playlist-chip-${track.id}`}
        onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }); }}
        onMouseDown={e => e.stopPropagation()}
        title={`Playlist « ${name} » (${i + 1} / ${list.length}) : clic pour changer de version, en créer ou en dupliquer (Pro Tools : sélecteur de playlist)`}
        aria-label={`Playlist ${name}, ${i + 1} sur ${list.length}`}
        className="nova-hit-tactile h-5 max-w-[110px] rounded-md border border-cyan-400/50 bg-cyan-500/10 px-1.5 text-[9px] font-black text-cyan-300 flex items-center gap-1">
        <i className="fas fa-list text-[8px]" /><span className="truncate">{name}</span><i className="fas fa-caret-down text-[8px]" />
      </button>
      {menu && <PlaylistMenu track={track} anchor={menu} onClose={() => setMenu(null)} />}
    </>
  );
};
