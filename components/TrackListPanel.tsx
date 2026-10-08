import React, { useMemo, useState } from 'react';
import { Track } from '../types';
import {
  ancestorsOf, createFolder, createVca, filterTrackList, isEffectivelyInactive, moveIntoFolder, moveOutOfFolder,
  readyToUseTracks, setAllHidden, setFolderOpen, setTracksHidden, setTracksInactive, showAndActivate, TrackListFilter,
} from '../utils/trackStructure';
import { applyTracks } from '../utils/structureBus';
import { FloatingMenu, structureMenuItems, useLongPress } from './TrackStructure';

/**
 * Liste des pistes (Pro Tools « Track List », à gauche de la fenêtre
 * d'édition) : chaque piste avec son point « affichée / masquée » (Ctrl+clic :
 * tout afficher ou tout masquer), son état actif / inactif, ses dossiers ;
 * « Afficher et activer » en un geste pour les pistes prêtes à servir.
 * Glisser une piste sur un dossier l'y range ; sur « Racine », l'en sort.
 *
 * mode « hidden » (téléphone) : seulement les pistes masquées, pour les révéler.
 */
const FILTERS: { id: TrackListFilter; label: string }[] = [
  { id: 'all', label: 'Toutes' }, { id: 'active', label: 'Actives' }, { id: 'hidden', label: 'Masquées' }, { id: 'inactive', label: 'Inactives' },
];

const uid = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const Row: React.FC<{
  t: Track; depth: number; inactive: boolean; selected: boolean; simple: boolean; all: Track[];
  onSelect: () => void; onMenu: (x: number, y: number) => void;
  dragOver: boolean; setDragOver: (id: string | null) => void;
}> = ({ t, depth, inactive, selected, simple, all, onSelect, onMenu, dragOver, setDragOver }) => {
  const { consumed: lpConsumed, ...lpHandlers } = useLongPress(onMenu);
  const lp = { consumed: lpConsumed };
  const kids = t.folder ? all.filter(x => x.parentFolderId === t.id).length : 0;
  const ready = t.isHidden || t.isInactive;
  return (
    <div role="listitem" data-testid={`tracklist-row-${t.id}`} data-hidden={t.isHidden ? '1' : '0'} data-inactive={inactive ? '1' : '0'}
      draggable={!simple && t.id !== 'master'}
      onDragStart={(e) => { e.dataTransfer.setData('nova/tracklist', t.id); e.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={(e) => { if (t.folder && e.dataTransfer.types.includes('nova/tracklist')) { e.preventDefault(); setDragOver(t.id); } }}
      onDragLeave={() => setDragOver(null)}
      onDrop={(e) => { const id = e.dataTransfer.getData('nova/tracklist'); setDragOver(null); if (id && t.folder) { e.preventDefault(); applyTracks(ts => moveIntoFolder(ts, id, t.id), `Rangée dans « ${t.name} »`); } }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
      {...lpHandlers}
      className={`group flex items-center gap-1.5 rounded-lg pr-1 min-h-[30px] [@media(pointer:coarse)]:min-h-[44px] ${selected ? 'bg-nv-accent/15' : 'hover:bg-nv-well'} ${dragOver ? 'ring-2 ring-amber-400' : ''}`}
      style={{ paddingLeft: 4 + depth * 14 }}>
      {!simple && (
        <button type="button" data-testid={`tracklist-eye-${t.id}`}
          onClick={(e) => {
            e.stopPropagation();
            if (lp.consumed()) return;
            if (e.ctrlKey || e.metaKey) applyTracks(ts => setAllHidden(ts, !t.isHidden), t.isHidden ? 'Toutes les pistes sont affichées' : 'Toutes les pistes sont masquées');
            else applyTracks(ts => setTracksHidden(ts, [t.id], !t.isHidden));
          }}
          disabled={t.id === 'master'}
          aria-label={`${t.isHidden ? 'Afficher' : 'Masquer'} ${t.name}`} aria-pressed={!t.isHidden}
          title={`${t.isHidden ? 'Masquée' : 'Affichée'} · clic : ${t.isHidden ? 'afficher' : 'masquer'} · Ctrl+clic : tout ${t.isHidden ? 'afficher' : 'masquer'} (comme Pro Tools)`}
          className="nova-hit-tactile w-6 h-6 shrink-0 flex items-center justify-center">
          <span className={`block w-2.5 h-2.5 rounded-full border-2 ${t.isHidden ? 'border-nv-muted bg-transparent' : 'border-nv-accent bg-nv-accent'}`} />
        </button>
      )}
      {t.folder ? (
        <button type="button" onClick={(e) => { e.stopPropagation(); applyTracks(ts => setFolderOpen(ts, t.id, t.folder!.isOpen === false)); }}
          aria-label={`${t.folder.isOpen === false ? 'Déplier' : 'Replier'} ${t.name}`} aria-expanded={t.folder.isOpen !== false}
          className="nova-hit-tactile w-5 h-6 shrink-0 text-nv-muted hover:text-nv-ink"><i className={`fas ${t.folder.isOpen === false ? 'fa-chevron-right' : 'fa-chevron-down'} text-[9px]`} /></button>
      ) : <span className="w-5 shrink-0" />}
      <span className="w-2 h-4 shrink-0 rounded-sm" style={{ backgroundColor: t.color }} />
      <button type="button" onClick={(e) => { if (lp.consumed()) { e.preventDefault(); return; } onSelect(); }}
        className={`min-w-0 flex-1 truncate text-left text-[12px] font-semibold ${inactive ? 'italic text-nv-muted' : 'text-nv-ink'}`}
        title={inactive ? `${t.name} : inactive (ne joue rien, ne coûte rien)` : t.name}>
        {t.folder && <i className={`fas ${t.folder.kind === 'routing' ? 'fa-folder-open text-amber-400' : 'fa-folder text-nv-muted'} mr-1 text-[10px]`} />}
        {t.isVca && <span className="mr-1 rounded bg-violet-500/20 px-1 text-[9px] font-black text-violet-300">VCA</span>}
        {t.name}
        {t.folder && <span className="ml-1 text-[10px] font-normal text-nv-muted">({kids})</span>}
      </button>
      {simple ? (
        <>
          <button type="button" onClick={() => applyTracks(ts => setTracksHidden(ts, [t.id], false), `« ${t.name} » est affichée`)}
            className="nova-hit-tactile h-9 rounded-full border border-nv-line px-3 text-[11px] font-bold text-nv-ink">Afficher</button>
          {t.isInactive && (
            <button type="button" onClick={() => applyTracks(ts => showAndActivate(ts, t.id), `« ${t.name} » est prête`)}
              className="nova-hit-tactile h-9 rounded-full bg-cyan-500 px-3 text-[11px] font-bold text-black">Afficher et activer</button>
          )}
        </>
      ) : (
        <>
          {ready && t.id !== 'master' && (
            <button type="button" data-testid={`tracklist-ready-${t.id}`} onClick={(e) => { e.stopPropagation(); applyTracks(ts => showAndActivate(ts, t.id), `« ${t.name} » est affichée et active`); }}
              title="Afficher et activer en un geste (piste prête à servir)"
              className="nova-hit-tactile h-6 rounded-md bg-nv-accent/15 px-1.5 text-[10px] font-bold text-nv-accent opacity-80 hover:opacity-100">
              <i className="fas fa-bolt mr-0.5 text-[9px]" />Prête
            </button>
          )}
          {t.id !== 'master' && (
            <button type="button" data-testid={`tracklist-active-${t.id}`}
              onClick={(e) => { e.stopPropagation(); applyTracks(ts => setTracksInactive(ts, [t.id], !t.isInactive)); }}
              aria-pressed={!t.isInactive} aria-label={`${t.isInactive ? 'Activer' : 'Rendre inactive'} ${t.name}`}
              title={t.isInactive ? 'Inactive · clic : activer (Pro Tools « Make Active »)' : 'Active · clic : rendre inactive (Pro Tools « Make Inactive » : ne joue rien, ne coûte rien, routage gardé)'}
              className={`nova-hit-tactile w-6 h-6 rounded-md flex items-center justify-center ${t.isInactive ? 'text-nv-muted bg-nv-well' : 'text-nv-accent'}`}>
              <i className="fas fa-power-off text-[10px]" />
            </button>
          )}
        </>
      )}
    </div>
  );
};

const TrackListPanel: React.FC<{ tracks: Track[]; mode?: 'full' | 'hidden'; onClose: () => void; className?: string }> = ({ tracks, mode = 'full', onClose, className }) => {
  const simple = mode === 'hidden';
  const [filter, setFilter] = useState<TrackListFilter>(simple ? 'hidden' : 'all');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const byId = useMemo(() => new Map(tracks.map(t => [t.id, t])), [tracks]);
  const rows = useMemo(() => {
    const list = filterTrackList(tracks, filter);
    // Dossier replié : ses pistes ne sont pas listées (sauf filtre).
    return filter === 'all' ? list.filter(t => !ancestorsOf(t, byId).some(a => a.folder?.isOpen === false)) : list;
  }, [tracks, filter, byId]);
  const ready = readyToUseTracks(tracks);
  const selIds = [...sel].filter(id => byId.has(id));
  const toggleSel = (id: string) => setSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const hiddenCount = tracks.filter(t => t.isHidden).length;

  return (
    <aside role="dialog" aria-label={simple ? 'Pistes masquées' : 'Liste des pistes'} data-testid={simple ? 'hidden-tracks-panel' : 'track-list-panel'}
      className={`flex flex-col rounded-2xl border border-nv-line bg-nv-panel shadow-2xl ${className || ''}`}>
      <div className="flex items-center gap-2 border-b border-nv-line px-3 py-2">
        <i className={`fas ${simple ? 'fa-eye-slash' : 'fa-list'} text-nv-accent text-[12px]`} />
        <h2 className="flex-1 text-[13px] font-bold text-nv-ink">{simple ? `Pistes masquées (${hiddenCount})` : 'Pistes'}</h2>
        <button type="button" onClick={onClose} aria-label="Fermer" className="nova-hit-tactile w-8 h-8 rounded-lg text-nv-muted hover:text-nv-ink"><i className="fas fa-times" /></button>
      </div>
      {!simple && (
        <div className="flex flex-wrap items-center gap-1 px-3 pt-2">
          {FILTERS.map(f => (
            <button key={f.id} type="button" onClick={() => setFilter(f.id)} aria-pressed={filter === f.id} data-testid={`tracklist-filter-${f.id}`}
              className={`nova-hit-tactile h-7 rounded-full px-2.5 text-[11px] font-bold ${filter === f.id ? 'bg-cyan-500 text-black' : 'bg-nv-well text-nv-muted hover:text-nv-ink'}`}>{f.label}</button>
          ))}
        </div>
      )}
      {!simple && (
        <p className="px-3 pt-1.5 text-[10px] text-nv-muted">
          Point : affichée / masquée (Ctrl+clic : toutes). <i className="fas fa-power-off text-[9px]" /> : active / inactive. Glisse une piste sur un dossier pour l’y ranger.
          {ready.length > 0 && <> · <b className="text-nv-ink">{ready.length}</b> prête{ready.length > 1 ? 's' : ''} à servir (masquée{ready.length > 1 ? 's' : ''} et inactive{ready.length > 1 ? 's' : ''}).</>}
        </p>
      )}
      <div role="list" className="min-h-0 flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-0.5">
        {rows.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-nv-muted">{simple ? 'Aucune piste masquée : tout est déjà à l’écran.' : filter === 'hidden' ? 'Aucune piste masquée.' : filter === 'inactive' ? 'Aucune piste inactive.' : 'Aucune piste.'}</p>
        )}
        {rows.map(t => (
          <Row key={t.id} t={t} all={tracks} depth={simple ? 0 : ancestorsOf(t, byId).length} inactive={isEffectivelyInactive(t, byId)}
            selected={sel.has(t.id)} simple={simple} onSelect={() => toggleSel(t.id)}
            onMenu={(x, y) => setMenu({ x, y, id: t.id })} dragOver={dragOver === t.id} setDragOver={setDragOver} />
        ))}
        {!simple && (
          <div data-testid="tracklist-root-drop"
            onDragOver={(e) => { if (e.dataTransfer.types.includes('nova/tracklist')) { e.preventDefault(); setDragOver('__root'); } }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => { const id = e.dataTransfer.getData('nova/tracklist'); setDragOver(null); if (!id) return; e.preventDefault(); applyTracks(ts => { let out = ts; let guard = 0; while (out.find(x => x.id === id)?.parentFolderId && guard++ < 10) out = moveOutOfFolder(out, id); return out; }, 'Sortie du dossier'); }}
            className={`mt-1 rounded-lg border border-dashed px-2 py-2 text-center text-[10px] ${dragOver === '__root' ? 'border-amber-400 text-amber-300' : 'border-nv-line text-nv-muted'}`}>
            Racine : dépose ici pour sortir une piste de son dossier
          </div>
        )}
      </div>
      {!simple && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-nv-line px-3 py-2">
          <span className="text-[10px] text-nv-muted">{selIds.length ? `${selIds.length} choisie${selIds.length > 1 ? 's' : ''} :` : 'Touche des noms pour les choisir, puis :'}</span>
          <button type="button" disabled={!selIds.length} data-testid="tracklist-new-routing"
            onClick={() => { applyTracks(ts => createFolder(ts, { id: uid('folder'), name: 'DOSSIER BUS', kind: 'routing', childIds: selIds }), 'Dossier de routage créé'); setSel(new Set()); }}
            title="Routing Folder : un dossier qui est un bus (les pistes y sont routées)"
            className="nova-hit-tactile h-7 rounded-full bg-amber-500/15 px-2.5 text-[11px] font-bold text-amber-300 disabled:opacity-40">+ Dossier de routage</button>
          <button type="button" disabled={!selIds.length}
            onClick={() => { applyTracks(ts => createFolder(ts, { id: uid('folder'), name: 'DOSSIER', kind: 'basic', childIds: selIds }), 'Dossier créé'); setSel(new Set()); }}
            title="Basic Folder : range les pistes, sans toucher au son"
            className="nova-hit-tactile h-7 rounded-full bg-nv-well px-2.5 text-[11px] font-bold text-nv-ink disabled:opacity-40">+ Dossier simple</button>
          <button type="button" disabled={!selIds.length}
            onClick={() => { applyTracks(ts => createVca(ts, { id: uid('vca'), name: 'VCA', memberIds: selIds }), 'VCA créé'); setSel(new Set()); }}
            title="VCA Master : un fader qui pilote le volume de ces pistes"
            className="nova-hit-tactile h-7 rounded-full bg-violet-500/15 px-2.5 text-[11px] font-bold text-violet-300 disabled:opacity-40">+ VCA</button>
          <button type="button" disabled={!selIds.length}
            onClick={() => { applyTracks(ts => setTracksHidden(ts, selIds, true)); setSel(new Set()); }}
            className="nova-hit-tactile h-7 rounded-full bg-nv-well px-2.5 text-[11px] font-bold text-nv-ink disabled:opacity-40">Masquer</button>
        </div>
      )}
      {menu && (
        <FloatingMenu x={menu.x} y={menu.y} title={byId.get(menu.id)?.name} onClose={() => setMenu(null)}
          items={structureMenuItems(byId.get(menu.id), tracks).filter((x, i) => !(i === 0 && x === 'separator'))} />
      )}
    </aside>
  );
};

export default TrackListPanel;
