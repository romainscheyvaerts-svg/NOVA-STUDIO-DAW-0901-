import React, { useEffect, useMemo, useState } from 'react';
import { Track, TrackGroup } from '../types';
import {
  ALL_GROUP_ID, createGroup, deleteGroup, GROUP_COLORS, GROUP_KIND_HINT, GROUP_KIND_LABEL, GroupKind, groupKind, groupable, hasAttr,
  attrPatch, isGroupOn, linksMix, listGroups, newGroupId, MIX_ATTR_LABEL, MIX_ATTRS, setSuspended, toggleGroup, updateGroup, useEditGroups,
} from '../utils/editGroups';
import { applyGroups } from '../utils/r12Bus';

/**
 * Liste des groupes (Pro Tools : Groups List, à gauche de la fenêtre
 * d'édition) : groupe <TOUT>, groupes du projet, actif / inactif d'un clic,
 * « Suspendre tous les groupes », création (Ctrl+G) et réglages : nom, type
 * (Édition / Mix / les deux), attributs liés, membres, couleur.
 *
 * readOnly (téléphone) : la liste et les membres, sans rien modifier.
 */
const KIND_SHORT: Record<GroupKind, string> = { edit: 'É', mix: 'M', both: 'É+M' };

const GroupEditor: React.FC<{ g: TrackGroup; tracks: Track[]; onDone: () => void; fresh?: boolean }> = ({ g, tracks, onDone, fresh }) => {
  const [name, setName] = useState(g.name);
  useEffect(() => setName(g.name), [g.name]);
  const set = (patch: Partial<TrackGroup>, label?: string) => applyGroups(s => updateGroup(s, g.id, patch), label);
  const kind = groupKind(g);
  const candidates = tracks.filter(groupable);
  const members = new Set(g.trackIds);
  return (
    <div data-testid={`group-editor-${g.id}`} className="mx-1 mb-2 rounded-xl border border-nv-line bg-nv-well/60 p-2.5 flex flex-col gap-2">
      <label className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-[10px] font-bold text-nv-muted">Nom</span>
        <input value={name} autoFocus={fresh} aria-label="Nom du groupe" data-testid="group-name-input"
          onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name !== g.name && set({ name: name.trim() })}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          className="min-w-0 flex-1 h-8 rounded-lg border border-nv-line bg-nv-bg px-2 text-[12px] font-bold text-nv-ink" />
      </label>
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-[10px] font-bold text-nv-muted">Type</span>
        <div role="radiogroup" aria-label="Type de groupe" className="flex flex-1 gap-1">
          {(['edit', 'mix', 'both'] as GroupKind[]).map(k => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} data-testid={`group-kind-${k}`} title={GROUP_KIND_HINT[k]}
              onClick={() => set({ kind: k })}
              className={`nova-hit-tactile flex-1 h-8 rounded-lg text-[11px] font-bold ${kind === k ? 'bg-nv-accent text-black' : 'bg-nv-bg text-nv-muted hover:text-nv-ink'}`}>{GROUP_KIND_LABEL[k]}</button>
          ))}
        </div>
      </div>
      {linksMix(g) && (
        <div className="flex items-start gap-2">
          <span className="w-14 shrink-0 pt-1 text-[10px] font-bold text-nv-muted">Liés</span>
          <div className="flex flex-1 flex-wrap gap-1">
            {MIX_ATTRS.map(a => (
              <button key={a} type="button" aria-pressed={hasAttr(g, a)} data-testid={`group-attr-${a}`}
                title={`${MIX_ATTR_LABEL[a].label} · Pro Tools : ${MIX_ATTR_LABEL[a].pt}`}
                onClick={() => set(attrPatch(a, !hasAttr(g, a)))}
                className={`nova-hit-tactile h-7 rounded-full px-2.5 text-[11px] font-bold ${hasAttr(g, a) ? 'text-black' : 'bg-nv-bg text-nv-muted'}`}
                style={hasAttr(g, a) ? { backgroundColor: g.color } : undefined}>{MIX_ATTR_LABEL[a].label}</button>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-[10px] font-bold text-nv-muted">REC</span>
        <button type="button" aria-pressed={!!g.linkedRecord} data-testid="group-attr-record"
          title="Armement lié (Pro Tools : Record Enable) : armer une piste du groupe arme tout le groupe"
          onClick={() => set({ linkedRecord: !g.linkedRecord })}
          className={`nova-hit-tactile h-7 rounded-full px-2.5 text-[11px] font-bold ${g.linkedRecord ? 'text-black' : 'bg-nv-bg text-nv-muted'}`}
          style={g.linkedRecord ? { backgroundColor: g.color } : undefined}>Armement lié</button>
        <span className="text-[10px] text-nv-muted leading-snug">armer une piste arme le groupe</span>
      </div>
      {kind !== 'mix' && (
        <p className="text-[10px] text-nv-muted leading-snug">
          Édition liée : sélection, coupe, rognage, fondus, nudge, déplacement, Shuffle, gain de clip et Consolider se font sur toutes les pistes du groupe.
          <b className="text-nv-ink"> Maj+Ctrl</b> pendant le geste : la piste seule.
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-[10px] font-bold text-nv-muted">Couleur</span>
        <div className="flex flex-wrap gap-1">
          {GROUP_COLORS.map(c => (
            <button key={c} type="button" onClick={() => set({ color: c })} aria-label={`Couleur ${c}`} aria-pressed={g.color === c}
              className={`nova-hit-tactile w-5 h-5 rounded-full ${g.color === c ? 'ring-2 ring-nv-ink ring-offset-1 ring-offset-nv-well' : ''}`} style={{ backgroundColor: c }} />
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[10px] font-bold text-nv-muted">Membres ({g.trackIds.length})</span>
          {g.deduced && <span className="rounded bg-amber-500/15 px-1.5 text-[9px] font-bold text-amber-300" title="La fenêtre des groupes de Pro Tools n'a pas été relevée : membres déduits des noms, à vérifier">déduits : à vérifier</span>}
        </div>
        <div className="max-h-44 overflow-y-auto rounded-lg border border-nv-line bg-nv-bg p-1 flex flex-col gap-0.5">
          {candidates.map(t => (
            <label key={t.id} className="flex items-center gap-2 rounded px-1.5 min-h-[26px] [@media(pointer:coarse)]:min-h-[40px] hover:bg-nv-well cursor-pointer">
              <input type="checkbox" checked={members.has(t.id)} data-testid={`group-member-${t.id}`}
                onChange={() => set({ trackIds: members.has(t.id) ? g.trackIds.filter(x => x !== t.id) : [...g.trackIds, t.id] })}
                className="accent-cyan-500 w-4 h-4" />
              <span className="w-1.5 h-3.5 rounded-sm shrink-0" style={{ backgroundColor: t.color }} />
              <span className={`truncate text-[11px] ${t.isHidden || t.isInactive ? 'italic text-nv-muted' : 'text-nv-ink'}`}>{t.name}{t.isHidden ? ' (masquée)' : ''}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => { applyGroups(s => deleteGroup(s, g.id), `Groupe « ${g.name} » supprimé`); onDone(); }}
          className="nova-hit-tactile h-8 rounded-lg px-3 text-[11px] font-bold text-red-400 hover:bg-red-500/10">Supprimer le groupe</button>
        <button type="button" onClick={onDone} className="nova-hit-tactile ml-auto h-8 rounded-lg bg-nv-accent px-4 text-[11px] font-bold text-black">OK</button>
      </div>
    </div>
  );
};

const GroupsListPanel: React.FC<{ readOnly?: boolean; onClose: () => void; className?: string; newGroup?: boolean; selectedTrackIds?: string[] }> = ({ readOnly, onClose, className, newGroup, selectedTrackIds }) => {
  const ctx = useEditGroups();
  const groups = useMemo(() => listGroups(ctx), [ctx]);
  const [open, setOpen] = useState<string | null>(null);
  const suspended = !!ctx.settings?.suspended;
  const byId = useMemo(() => new Map(ctx.tracks.map(t => [t.id, t])), [ctx.tracks]);

  const create = () => {
    const ids = (selectedTrackIds || []).filter(id => { const t = byId.get(id); return !!t && groupable(t); });
    const created = newGroupId();
    applyGroups(s => createGroup(s, { id: created, trackIds: ids, kind: 'both' }),
      ids.length ? `Groupe créé avec ${ids.length} piste${ids.length > 1 ? 's' : ''} : coche ou décoche les membres` : 'Groupe créé : coche ses membres');
    setOpen(created);
  };
  // Ctrl+G : la fenêtre s'ouvre avec un nouveau groupe des pistes sélectionnées.
  useEffect(() => { if (newGroup && !readOnly) create(); }, [newGroup]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside role="dialog" aria-label="Groupes" data-testid="groups-panel"
      className={`flex flex-col rounded-2xl border border-nv-line bg-nv-panel shadow-2xl ${className || ''}`}>
      <div className="flex items-center gap-2 border-b border-nv-line px-3 py-2">
        <i className="fas fa-object-group text-nv-accent text-[12px]" />
        <h2 className="flex-1 text-[13px] font-bold text-nv-ink" title="Pro Tools : Groups List">Groupes{readOnly ? ' (lecture seule)' : ''}</h2>
        <button type="button" onClick={onClose} aria-label="Fermer" className="nova-hit-tactile w-8 h-8 rounded-lg text-nv-muted hover:text-nv-ink"><i className="fas fa-times" /></button>
      </div>
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2">
          <button type="button" onClick={create} data-testid="group-new"
            title={`Nouveau groupe avec ${selectedTrackIds?.length ? `les ${selectedTrackIds.length} pistes sélectionnées` : 'les pistes sélectionnées'} (Pro Tools : Ctrl+G)`}
            className="nova-hit-tactile h-8 rounded-full bg-nv-accent px-3 text-[11px] font-bold text-black"><i className="fas fa-plus mr-1 text-[9px]" />Nouveau groupe</button>
          <button type="button" aria-pressed={suspended} data-testid="groups-suspend"
            onClick={() => applyGroups(s => setSuspended(s, !suspended), suspended ? 'Groupes repris' : 'Tous les groupes sont suspendus')}
            title="Suspendre tous les groupes (Pro Tools : Suspend All Groups, Ctrl+Maj+G)"
            className={`nova-hit-tactile h-8 rounded-full px-3 text-[11px] font-bold ${suspended ? 'bg-amber-500 text-black' : 'bg-nv-well text-nv-muted hover:text-nv-ink'}`}>
            <i className={`fas ${suspended ? 'fa-play' : 'fa-pause'} mr-1 text-[9px]`} />{suspended ? 'Reprendre les groupes' : 'Suspendre tous'}</button>
        </div>
      )}
      <p className="px-3 pt-1.5 text-[10px] leading-snug text-nv-muted">
        {readOnly
          ? 'Les groupes se règlent sur l’ordinateur ou la tablette.'
          : <>Clic sur un nom : groupe actif / inactif. <b className="text-nv-ink">Maj+Ctrl</b> pendant un geste inverse le groupe (Pro Tools). {suspended && <b className="text-amber-300">Groupes suspendus.</b>}</>}
      </p>
      <div role="list" className="min-h-0 flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-0.5">
        {groups.length === 1 && (
          <p className="px-2 py-4 text-center text-[12px] text-nv-muted">
            Pas encore de groupe. {readOnly ? '' : 'Sélectionne LEAD, DOUBLE et BACKS (plage ou clips), puis « Nouveau groupe » (Ctrl+G) : ils se couperont ensemble.'}
          </p>
        )}
        {groups.map(g => {
          const on = isGroupOn(g) && !suspended;
          const isAll = g.id === ALL_GROUP_ID;
          const names = g.trackIds.map(id => byId.get(id)?.name).filter(Boolean) as string[];
          return (
            <React.Fragment key={g.id}>
              <div role="listitem" data-testid={`group-row-${g.id}`} data-active={on ? '1' : '0'}
                className={`flex items-center gap-1.5 rounded-lg pr-1 min-h-[34px] [@media(pointer:coarse)]:min-h-[44px] ${open === g.id ? 'bg-nv-accent/10' : 'hover:bg-nv-well'}`}>
                <button type="button" disabled={readOnly} data-testid={`group-toggle-${g.id}`} aria-pressed={isGroupOn(g)}
                  onClick={() => applyGroups(s => toggleGroup(s, g.id))}
                  title={`${isGroupOn(g) ? 'Actif' : 'Inactif'} · clic : ${isGroupOn(g) ? 'désactiver' : 'activer'} (Pro Tools : clic dans la Groups List)${isAll ? '. <TOUT> lie toutes les pistes, inactif par défaut' : ''}`}
                  className="nova-hit-tactile flex min-w-0 flex-1 items-center gap-2 pl-1.5 text-left disabled:cursor-default">
                  <span className={`w-3 h-3 shrink-0 rounded-full border-2 ${on ? '' : 'opacity-40'}`} style={{ borderColor: g.color, backgroundColor: isGroupOn(g) ? g.color : 'transparent' }} />
                  <span className={`min-w-0 truncate text-[12px] font-bold ${on ? 'text-nv-ink' : 'text-nv-muted'}`}>{g.name}</span>
                  <span className="shrink-0 rounded bg-nv-well px-1 text-[9px] font-black text-nv-muted" title={GROUP_KIND_HINT[groupKind(g)]}>{KIND_SHORT[groupKind(g)]}</span>
                  <span className="min-w-0 truncate text-[10px] text-nv-muted" title={names.join(', ')}>{isAll ? 'toutes les pistes' : names.length ? names.join(' · ') : 'aucune piste'}</span>
                </button>
                {!readOnly && !isAll && (
                  <button type="button" onClick={() => setOpen(o => (o === g.id ? null : g.id))} aria-expanded={open === g.id} aria-label={`Régler le groupe ${g.name}`} data-testid={`group-edit-${g.id}`}
                    title="Nom, type, attributs liés, membres" className="nova-hit-tactile w-7 h-7 shrink-0 rounded-md text-nv-muted hover:text-nv-ink"><i className="fas fa-sliders-h text-[10px]" /></button>
                )}
              </div>
              {open === g.id && !readOnly && !isAll && <GroupEditor g={g} tracks={ctx.tracks} onDone={() => setOpen(null)} fresh={!!newGroup} />}
            </React.Fragment>
          );
        })}
      </div>
    </aside>
  );
};

export default GroupsListPanel;
