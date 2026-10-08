import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ContextMenuItem, PluginInstance, Track, TrackSend, TrackType } from '../types';
import {
  ancestorsOf, busesOf, busListeners, createFolder, createVca, dissolveFolder, folderDescendants, isEffectivelyInactive,
  moveIntoFolder, moveOutOfFolder, outputOf, PLUGIN_STATE_LABEL, pluginClickAction, pluginState, PluginState,
  SEND_SLOT_LETTERS, sendSlots, setFolderOpen, setSendSlot, setTrackInputBus, setTrackOutput, setTracksHidden,
  setTracksInactive, showAndActivate, vcaMembers,
} from '../utils/trackStructure';
import { applyTracks, structureBus } from '../utils/structureBus';
import { gainToDbText, panToText } from '../utils/db';
import { getValidDestinations } from './RoutingManager';
import { trackDisplayName } from '../utils/sendLabels';
import { useKnobInteraction } from '../hooks/useKnobInteraction';

/**
 * Morceaux d'interface de la structure façon Pro Tools (voir utils/trackStructure) :
 * état des effets (actif / bypass / inactif), en-tête de piste (dossier, VCA,
 * piste inactive), sélecteurs d'entrée / sortie avec bus nommés, 10 envois a-j
 * (niveau, pan, mute, pré / post), Send View, tranche VCA, menus.
 */

// ─── Contexte : toutes les pistes (pour les en-têtes, qui ne reçoivent que la leur) ──

export const StructureTracksContext = createContext<Track[] | null>(null);
export const useStructureTracks = () => useContext(StructureTracksContext);

const mapTrack = (id: string, f: (t: Track) => Track) => (tracks: Track[]) => tracks.map(t => (t.id === id ? f(t) : t));
const uid = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ─── Appui long (tablette au doigt) ────────────────────────────────────────────

/** Appui long au doigt (ou au stylet) : ouvre le menu, comme le clic droit à la souris. */
export function useLongPress(onLong: (x: number, y: number) => void, ms = 520) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => { if (timer.current) window.clearTimeout(timer.current); timer.current = null; };
  useEffect(() => clear, []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = window.setTimeout(() => { fired.current = true; onLong(start.current!.x, start.current!.y); }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!start.current || !timer.current) return;
      if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) clear();
    },
    onPointerUp: () => clear(),
    onPointerCancel: () => clear(),
    /** À appeler au début d'un onClick : vrai si l'appui long vient d'ouvrir le menu (le clic est alors ignoré). */
    consumed: () => { const f = fired.current; fired.current = false; return f; },
  };
}

// ─── Effets : actif / bypass / inactif ─────────────────────────────────────────

/** Classes d'une case d'effet selon son état (bypass barré, inactif gris italique comme Pro Tools). */
export const pluginStateClass = (p: PluginInstance): string => {
  const s = pluginState(p);
  if (s === 'inactive') return 'italic opacity-60 !text-slate-500 border-dashed';
  if (s === 'bypass') return '!text-slate-500 line-through';
  return '';
};

export const pluginStateHelp = (p: PluginInstance): string => {
  const s = pluginState(p);
  const base = s === 'inactive'
    ? 'Inactif : retiré du son, ne consomme rien, aucune latence (ses réglages sont gardés).'
    : s === 'bypass' ? 'Bypass : le son passe sans traitement ; l’effet reste chargé et sa latence reste compensée.'
      : 'Actif.';
  return `${base} Ctrl+clic : bypass · Ctrl+Alt+clic : actif / inactif (Pro Tools : Ctrl+Démarrer+clic) · clic droit ou appui long : menu`;
};

/** Ctrl+clic / Ctrl+Alt+clic sur un effet. Renvoie vrai si le clic est traité. */
export const handlePluginModifierClick = (e: React.MouseEvent, trackId: string, p: PluginInstance, onBypass?: () => void): boolean => {
  const a = pluginClickAction(e);
  if (!a) return false;
  e.preventDefault();
  e.stopPropagation();
  if (a === 'inactive') structureBus.emit({ kind: 'pluginState', trackId, pluginId: p.id, state: p.isInactive ? (p.isEnabled ? 'active' : 'bypass') : 'inactive' });
  else if (onBypass) onBypass();
  else structureBus.emit({ kind: 'pluginState', trackId, pluginId: p.id, state: p.isEnabled ? 'bypass' : 'active' });
  return true;
};

/** Menu d'un effet : ouvrir, actif, bypass, inactif. */
export const pluginStateMenuItems = (trackId: string, p: PluginInstance, onOpen?: () => void): ContextMenuItem[] => {
  const cur = pluginState(p);
  const set = (state: PluginState) => () => structureBus.emit({ kind: 'pluginState', trackId, pluginId: p.id, state });
  const items: ContextMenuItem[] = [];
  if (onOpen) items.push({ label: 'Ouvrir l’effet', icon: 'fa-sliders-h', onClick: onOpen, disabled: cur === 'inactive', title: cur === 'inactive' ? 'Rends-le actif pour l’ouvrir' : undefined });
  items.push(
    { label: `${cur === 'active' ? '✓ ' : ''}Actif`, icon: 'fa-power-off', onClick: set('active'), title: 'L’effet traite le son.' },
    { label: `${cur === 'bypass' ? '✓ ' : ''}Bypass`, icon: 'fa-forward', shortcut: 'Ctrl+clic', onClick: set('bypass'), title: 'Pro Tools « Bypass » : le son passe sans traitement, l’effet reste chargé et sa latence reste compensée.' },
    { label: `${cur === 'inactive' ? '✓ ' : ''}Inactif`, icon: 'fa-ban', shortcut: 'Ctrl+Alt+clic', onClick: set('inactive'), title: 'Pro Tools « Make Inactive » (Ctrl+Démarrer+clic) : retiré du son, aucune latence, réglages gardés.' },
  );
  return items;
};

/** Petit menu flottant (clic droit, appui long) : liste d'actions. */
export const FloatingMenu: React.FC<{ x: number; y: number; items: (ContextMenuItem | 'separator')[]; onClose: () => void; title?: string }> = ({ x, y, items, onClose, title }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    setPos({ x: Math.max(8, Math.min(x, window.innerWidth - w - 8)), y: Math.max(8, Math.min(y, window.innerHeight - h - 8)) });
  }, [x, y]);
  useEffect(() => {
    const down = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const t = window.setTimeout(() => { window.addEventListener('mousedown', down); window.addEventListener('touchstart', down); }, 30);
    window.addEventListener('keydown', key, true);
    return () => { window.clearTimeout(t); window.removeEventListener('mousedown', down); window.removeEventListener('touchstart', down); window.removeEventListener('keydown', key, true); };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" data-testid="structure-menu" onClick={e => e.stopPropagation()}
      className="fixed z-[900] min-w-[200px] max-w-[300px] max-h-[calc(100vh-16px)] overflow-y-auto rounded-xl border border-nv-line bg-nv-raised p-1 shadow-2xl"
      style={{ left: pos.x, top: pos.y }}>
      {title && <p className="px-2 pt-1 pb-1 text-[10px] font-bold uppercase tracking-wide text-nv-muted truncate">{title}</p>}
      {items.map((it, i) => it === 'separator'
        ? <div key={`s${i}`} className="my-1 h-px bg-nv-line" />
        : (
          <button key={i} type="button" role="menuitem" disabled={it.disabled} title={it.title}
            onClick={() => { onClose(); it.onClick(); }}
            className={`w-full flex items-center gap-2 rounded-lg px-2 py-1.5 [@media(pointer:coarse)]:py-2.5 text-left text-[12px] font-semibold disabled:opacity-40 ${it.danger ? 'text-red-400 hover:bg-red-500/10' : 'text-nv-ink hover:bg-nv-accent/10'}`}>
            {it.icon && <i className={`fas ${it.icon} w-4 text-center text-[10px] text-nv-muted`} />}
            <span className="flex-1 truncate">{it.label}</span>
            {it.shortcut && <span className="text-[10px] text-nv-muted">{it.shortcut}</span>}
          </button>
        ))}
    </div>
  );
};

// ─── Menus de piste (fenêtre d'édition, console) ───────────────────────────────

/** Actions de structure d'une piste (masquer, inactive, dossiers, VCA). */
export const structureMenuItems = (target: Track | undefined, tracks: Track[]): (ContextMenuItem | 'separator')[] => {
  if (!target || target.id === 'master') return [];
  const id = target.id;
  const items: (ContextMenuItem | 'separator')[] = ['separator'];
  items.push({
    label: target.isInactive ? 'Rendre la piste active' : 'Rendre la piste inactive',
    icon: target.isInactive ? 'fa-play-circle' : 'fa-ban',
    title: 'Pro Tools « Make Inactive / Active » : une piste inactive ne joue rien et ne coûte rien ; son routage est gardé.',
    onClick: () => applyTracks(ts => setTracksInactive(ts, [id], !target.isInactive), target.isInactive ? `« ${target.name} » est active` : `« ${target.name} » est inactive`),
  });
  items.push({
    label: target.isHidden ? 'Afficher la piste' : 'Masquer la piste',
    icon: target.isHidden ? 'fa-eye' : 'fa-eye-slash',
    title: 'Comme la liste des pistes de Pro Tools : une piste masquée continue de jouer si elle est active.',
    onClick: () => applyTracks(ts => setTracksHidden(ts, [id], !target.isHidden), target.isHidden ? undefined : `« ${target.name} » est masquée (Liste des pistes pour la retrouver)`),
  });
  if (target.isHidden || target.isInactive) items.push({ label: 'Afficher et activer', icon: 'fa-bolt', onClick: () => applyTracks(ts => showAndActivate(ts, id), `« ${target.name} » est prête`) });
  if (target.folder) {
    const open = target.folder.isOpen !== false;
    items.push({ label: open ? 'Replier le dossier' : 'Déplier le dossier', icon: open ? 'fa-folder' : 'fa-folder-open', onClick: () => applyTracks(ts => setFolderOpen(ts, id, !open)) });
    items.push({ label: 'Défaire le dossier (garder les pistes)', icon: 'fa-folder-minus', onClick: () => applyTracks(ts => dissolveFolder(ts, id), 'Dossier défait : ses pistes sont gardées') });
  } else {
    items.push({ label: 'Nouveau dossier de routage avec cette piste', icon: 'fa-folder-plus', title: 'Pro Tools « Routing Folder » : un dossier qui est aussi un bus (fader, inserts) ; la piste y est routée.',
      onClick: () => applyTracks(ts => createFolder(ts, { id: uid('folder'), name: `${target.name} DOSSIER`, kind: 'routing', childIds: [id] })) });
    items.push({ label: 'Nouveau dossier simple avec cette piste', icon: 'fa-folder', title: 'Pro Tools « Basic Folder » : range les pistes, sans toucher au son.',
      onClick: () => applyTracks(ts => createFolder(ts, { id: uid('folder'), name: `${target.name} DOSSIER`, kind: 'basic', childIds: [id] })) });
  }
  const parent = target.parentFolderId ? tracks.find(t => t.id === target.parentFolderId) : undefined;
  if (parent) items.push({ label: `Sortir du dossier « ${parent.name} »`, icon: 'fa-sign-out-alt', onClick: () => applyTracks(ts => moveOutOfFolder(ts, id)) });
  const desc = target.folder ? new Set(folderDescendants(id, tracks).map(d => d.id)) : new Set<string>();
  tracks.filter(f => f.folder && f.id !== id && f.id !== target.parentFolderId && !desc.has(f.id)).slice(0, 8).forEach(f => items.push({
    label: `Ranger dans « ${f.name} »`, icon: 'fa-level-down-alt', title: f.folder!.kind === 'routing' ? 'Dossier de routage : la piste y sera routée.' : 'Dossier simple : la sortie ne change pas.',
    onClick: () => applyTracks(ts => moveIntoFolder(ts, id, f.id)),
  }));
  if (!target.isVca && !target.folder) {
    const vcas = tracks.filter(t => t.isVca);
    vcas.slice(0, 6).forEach(v => items.push({
      label: target.vcaId === v.id ? `Retirer du VCA « ${v.name} »` : `Piloter par le VCA « ${v.name} »`, icon: 'fa-sliders-h',
      onClick: () => applyTracks(mapTrack(id, t => { const o = { ...t }; if (t.vcaId === v.id) delete o.vcaId; else o.vcaId = v.id; return o; })),
    }));
  }
  items.push({ label: 'Liste des pistes…', icon: 'fa-list', onClick: () => structureBus.emit({ kind: 'panel', panel: 'tracks' }) });
  return items;
};

// ─── En-tête de piste : dossier, VCA, piste inactive ───────────────────────────

/**
 * Posé dans l'en-tête de piste (fenêtre d'édition) : chevron de dossier,
 * étiquette VCA, retrait des pistes rangées, voile « piste inactive » avec
 * « Activer » en un clic.
 */
export const TrackStructureBadge: React.FC<{ track: Track }> = ({ track }) => {
  const all = useStructureTracks();
  const byId = useMemo(() => new Map((all || []).map(t => [t.id, t])), [all]);
  const anc = useMemo(() => ancestorsOf(track, byId), [track, byId]);
  const inactive = track.isInactive || anc.some(a => a.isInactive);
  const inheritedFrom = !track.isInactive ? anc.find(a => a.isInactive) : undefined;
  return (
    <>
      {anc.length > 0 && (
        <div aria-hidden className="pointer-events-none absolute left-0 top-0 bottom-0 flex" data-testid={`folder-indent-${track.id}`}>
          {anc.slice().reverse().map(a => <span key={a.id} className="w-[3px] h-full opacity-70 mr-[2px]" style={{ backgroundColor: a.color }} />)}
        </div>
      )}
      {inactive && (
        <div data-testid={`inactive-veil-${track.id}`} className="absolute inset-0 z-20 flex items-center justify-center bg-nv-bg/70 backdrop-grayscale"
          onClick={e => e.stopPropagation()}>
          <button type="button" data-testid={`activate-${track.id}`}
            onClick={(e) => { e.stopPropagation(); applyTracks(ts => (inheritedFrom ? setTracksInactive(ts, [inheritedFrom.id], false) : showAndActivate(ts, track.id)), `« ${inheritedFrom?.name || track.name} » est active`); }}
            title="Pro Tools « Make Active » : la piste rejoue (elle ne coûtait rien tant qu'elle était inactive)"
            className="nova-hit-tactile rounded-full border border-nv-line bg-nv-raised px-3 py-1 text-[10px] font-bold text-nv-ink shadow hover:border-nv-accent">
            <i className="fas fa-power-off mr-1 text-[9px] text-nv-muted" />
            {inheritedFrom ? `Dossier « ${inheritedFrom.name} » inactif · Activer` : 'Piste inactive · Activer'}
          </button>
        </div>
      )}
    </>
  );
};

/** Pastille dossier / VCA à côté du nom de la piste (clic : replier / déplier le dossier). */
export const TrackStructureInline: React.FC<{ track: Track }> = ({ track }) => {
  const all = useStructureTracks();
  if (!track.folder && !track.isVca) return null;
  const members = track.isVca && all ? vcaMembers(track, all).length : 0;
  const kids = track.folder && all ? all.filter(t => t.parentFolderId === track.id).length : 0;
  return (
    <span className="shrink-0 flex items-center gap-1">
          {track.folder && (
            <button type="button" data-testid={`folder-toggle-${track.id}`}
              onClick={(e) => { e.stopPropagation(); applyTracks(ts => setFolderOpen(ts, track.id, track.folder!.isOpen === false)); }}
              title={`${track.folder.kind === 'routing' ? 'Dossier de routage (Pro Tools « Routing Folder ») : un bus, ses pistes y sont routées' : 'Dossier simple (Pro Tools « Basic Folder ») : range les pistes'} · ${track.folder.isOpen === false ? 'déplier' : 'replier'}`}
              aria-expanded={track.folder.isOpen !== false}
              className={`nova-hit-tactile h-5 rounded-md border px-1.5 text-[9px] font-black flex items-center gap-1 ${track.folder.kind === 'routing' ? 'border-amber-400/50 bg-amber-500/15 text-amber-300' : 'border-nv-line bg-nv-well text-nv-muted'}`}>
              <i className={`fas ${track.folder.isOpen === false ? 'fa-folder' : 'fa-folder-open'} text-[9px]`} />
              {kids}
              <i className={`fas ${track.folder.isOpen === false ? 'fa-chevron-right' : 'fa-chevron-down'} text-[7px]`} />
            </button>
          )}
          {track.isVca && (
            <span title="VCA Master (Pro Tools) : son fader pilote le volume des pistes membres, sans passer le son"
              className="h-5 rounded-md border border-violet-400/50 bg-violet-500/15 px-1.5 text-[9px] font-black text-violet-300 flex items-center">VCA · {members}</span>
          )}
    </span>
  );
};

// ─── Entrée / sortie (bus nommés) ──────────────────────────────────────────────

const selectCls = 'absolute inset-0 opacity-0 cursor-pointer';

/** Sélecteurs Entrée / Sortie d'une tranche, comme Pro Tools : Master, bus nommés, pistes. */
export const TrackIOSelectors: React.FC<{ track: Track; allTracks: Track[] }> = ({ track, allTracks }) => {
  const buses = busesOf(allTracks);
  const out = outputOf(track);
  const dests = getValidDestinations(track.id, allTracks).filter(d => d.id !== 'master' && !d.isVca && d.folder?.kind !== 'basic');
  const value = out.kind === 'bus' ? `bus:${out.id}` : out.kind === 'track' ? `track:${out.id}` : 'master';
  const outLabel = (() => {
    if (out.kind === 'bus') {
      const b = buses.find(x => x.id === out.id);
      const l = busListeners(allTracks, out.id).filter(x => x.id !== track.id);
      return `${b?.name || '?'}${l.length ? '' : ' (personne n’écoute)'}`;
    }
    if (out.kind === 'track') { const d = allTracks.find(x => x.id === out.id); return d ? trackDisplayName(d, allTracks) : 'Master'; }
    return 'Master';
  })();
  const canListen = track.type === TrackType.BUS || track.type === TrackType.SEND;
  const inBus = track.inputBusId ? buses.find(b => b.id === track.inputBusId) : undefined;
  return (
    <>
      {canListen && !track.isVca && track.id !== 'master' && (
        <div className="relative" data-testid={`input-select-${track.id}`}>
          <div className="h-6 bg-black/60 rounded flex items-center px-2 border border-white/5 cursor-pointer hover:border-white/20">
            <span className="text-[8px] font-black text-slate-500 mr-2" title="Entrée (Pro Tools) : le bus nommé que cette piste écoute">Entrée</span>
            <span className="text-[8px] font-mono text-cyan-400 truncate flex-1">{inBus ? inBus.name : 'Aucune'}</span>
            <i className="fas fa-caret-down text-[8px] text-slate-600" />
          </div>
          <select aria-label={`Entrée de ${track.name}`} className={selectCls} value={track.inputBusId || ''}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__new') { structureBus.emit({ kind: 'panel', panel: 'buses' }); return; }
              applyTracks(ts => setTrackInputBus(ts, track.id, v || null));
            }}>
            <option value="">Aucune entrée</option>
            {buses.map(b => <option key={b.id} value={b.id}>Bus : {b.name}</option>)}
            <option value="__new">Bus nommés… (créer, renommer)</option>
          </select>
        </div>
      )}
      <div className="relative" data-testid={`output-select-${track.id}`}>
        <div className="h-6 bg-black/60 rounded flex items-center px-2 border border-white/5 cursor-pointer hover:border-white/20">
          <span className="text-[8px] font-black text-slate-500 mr-2" title="Sortie (Pro Tools) : le master, un bus nommé ou une piste aux / bus">Sortie</span>
          <span className={`text-[8px] font-mono truncate flex-1 ${out.kind === 'bus' ? 'text-cyan-300' : 'text-amber-400'}`}>{outLabel}</span>
          <i className="fas fa-caret-down text-[8px] text-slate-600" />
        </div>
        <select aria-label={`Sortie de ${track.name}`} className={selectCls} value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__new') { structureBus.emit({ kind: 'panel', panel: 'buses' }); return; }
            const target = v === 'master' ? { kind: 'master' as const } : v.startsWith('bus:') ? { kind: 'bus' as const, id: v.slice(4) } : { kind: 'track' as const, id: v.slice(6) };
            applyTracks(ts => setTrackOutput(ts, track.id, target));
          }}>
          <option value="master">Master (sortie)</option>
          {buses.length > 0 && (
            <optgroup label="Bus nommés">
              {buses.map(b => <option key={b.id} value={`bus:${b.id}`}>{b.name}</option>)}
            </optgroup>
          )}
          {dests.length > 0 && (
            <optgroup label="Pistes (bus, aux, dossiers)">
              {dests.map(d => <option key={d.id} value={`track:${d.id}`}>{trackDisplayName(d, allTracks)}</option>)}
            </optgroup>
          )}
          <option value="__new">Bus nommés… (créer, renommer)</option>
        </select>
      </div>
    </>
  );
};

// ─── Envois a à j ──────────────────────────────────────────────────────────────

/** Destinations possibles d'un envoi : retours d'effet, bus et dossiers de routage (pas soi-même). */
export const sendDestinations = (track: Track, all: Track[]): Track[] =>
  all.filter(t => t.id !== track.id && t.id !== 'master' && !t.isVca && t.folder?.kind !== 'basic' && (t.type === TrackType.SEND || t.type === TrackType.BUS));

const dbOf = (g: number) => (g > 0.0001 ? 20 * Math.log10(g) : -60);
const gOf = (db: number) => (db <= -59.9 ? 0 : Math.pow(10, db / 20));

const updateSends = (trackId: string, f: (sends: TrackSend[]) => TrackSend[]) => applyTracks(mapTrack(trackId, t => ({ ...t, sends: f(t.sends || []) })));

/** Une ligne d'envoi (emplacement a-j) : destination, niveau, pan, mute, pré / post. */
const SendRow: React.FC<{ track: Track; all: Track[]; slot: number; send: TrackSend | null; big?: boolean }> = ({ track, all, slot, send, big }) => {
  const dests = sendDestinations(track, all);
  const letter = SEND_SLOT_LETTERS[slot].toUpperCase();
  const set = (patch: Partial<TrackSend>) => send && updateSends(track.id, ss => ss.map(s => (s.id === send.id ? { ...s, ...patch, slot } : s)));
  return (
    <div className={`flex items-center gap-1 ${big ? 'flex-wrap' : ''}`} data-testid={`send-slot-${track.id}-${SEND_SLOT_LETTERS[slot]}`}>
      <span className={`w-4 shrink-0 text-center text-[10px] font-black ${send ? 'text-cyan-300' : 'text-slate-600'}`}>{letter}</span>
      <select aria-label={`Envoi ${letter} de ${track.name}`} value={send?.id || ''}
        onChange={(e) => {
          const id = e.target.value;
          updateSends(track.id, ss => setSendSlot(ss, slot, id ? { id, level: send?.level ?? gOf(-10), isEnabled: true, ...(send?.preFader ? { preFader: true } : {}) } : null));
        }}
        className="min-w-0 flex-1 h-6 [@media(pointer:coarse)]:h-8 rounded border border-white/10 bg-black/50 px-1 text-[10px] text-white">
        <option value="">— libre —</option>
        {dests.map(d => <option key={d.id} value={d.id}>{trackDisplayName(d, all)}{d.inputBusId ? ` (bus ${busesOf(all).find(b => b.id === d.inputBusId)?.name || ''})` : ''}</option>)}
      </select>
      {send && (
        <>
          <input type="range" min={-60} max={6} step={0.5} value={Math.round(dbOf(send.level) * 2) / 2}
            aria-label={`Niveau de l'envoi ${letter}`} title={`Niveau : ${gainToDbText(send.level)}`}
            onChange={(e) => set({ level: Math.min(1.5, gOf(Number(e.target.value))) })}
            onDoubleClick={() => set({ level: 1 })}
            className={`${big ? 'w-full order-last' : 'w-16'} accent-cyan-400`} />
          <span className="w-12 text-right text-[9px] tabular-nums text-slate-400">{gainToDbText(send.level)}</span>
          <input type="range" min={-1} max={1} step={0.01} value={send.pan ?? 0}
            aria-label={`Pan de l'envoi ${letter}`}
            title={send.pan === undefined ? 'Pan de l’envoi : suit le pan de la piste (Pro Tools « FMP »). Bouge-le pour lui donner son propre pan ; double-clic = suivre la piste.' : `Pan de l’envoi : ${panToText(send.pan)} (double-clic : suivre le pan de la piste)`}
            onChange={(e) => set({ pan: Number(e.target.value) })}
            onDoubleClick={() => send && updateSends(track.id, ss => ss.map(s => { if (s.id !== send.id) return s; const o = { ...s }; delete o.pan; return o; }))}
            className={`w-12 ${send.pan === undefined ? 'opacity-50' : ''} accent-amber-400`} />
          <span className="w-8 text-[9px] text-slate-400">{send.pan === undefined ? 'piste' : panToText(send.pan)}</span>
          <button type="button" onClick={() => set({ isMuted: !send.isMuted })} aria-pressed={!!send.isMuted} aria-label={`Couper l'envoi ${letter}`}
            title="Mute de l’envoi (Pro Tools) : coupé, mais toujours routé"
            className={`nova-hit-tactile h-6 w-6 rounded text-[9px] font-black ${send.isMuted ? 'bg-amber-500 text-black' : 'bg-white/10 text-slate-400'}`}>M</button>
          <button type="button" onClick={() => set({ preFader: !send.preFader })} aria-pressed={!!send.preFader} aria-label={`Envoi ${letter} pré-fader`}
            title="PRE (Pro Tools) : l’envoi part avant le fader de la piste"
            className={`nova-hit-tactile h-6 px-1 rounded text-[8px] font-black ${send.preFader ? 'bg-amber-400 text-black' : 'bg-white/10 text-slate-400'}`}>PRE</button>
        </>
      )}
    </div>
  );
};

/** Les 10 envois d'une piste (a à j), en fenêtre ancrée. */
export const SendSlotsPopover: React.FC<{ track: Track; all: Track[]; anchor: DOMRect; onClose: () => void }> = ({ track, all, anchor, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const live = all.find(t => t.id === track.id) || track;
  const slots = sendSlots(live.sends);
  useEffect(() => {
    const down = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const t = window.setTimeout(() => { window.addEventListener('mousedown', down); window.addEventListener('touchstart', down); }, 30);
    window.addEventListener('keydown', key, true);
    return () => { window.clearTimeout(t); window.removeEventListener('mousedown', down); window.removeEventListener('touchstart', down); window.removeEventListener('keydown', key, true); };
  }, [onClose]);
  const W = Math.min(440, window.innerWidth - 16);
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - 380));
  return (
    <div ref={ref} role="dialog" aria-label={`Envois de ${track.name}`} data-testid={`sends-popover-${track.id}`} onClick={e => e.stopPropagation()}
      className="fixed z-[800] rounded-xl border border-nv-line bg-nv-raised p-2 shadow-2xl max-h-[calc(100vh-16px)] overflow-y-auto" style={{ left, top, width: W }}>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[11px] font-bold text-nv-ink">Envois a à j · {track.name}</p>
        <button type="button" onClick={onClose} aria-label="Fermer" className="nova-hit-tactile h-6 w-6 rounded text-nv-muted hover:text-nv-ink"><i className="fas fa-times text-[10px]" /></button>
      </div>
      <p className="mb-1.5 text-[10px] text-nv-muted">Comme Pro Tools : 10 envois par piste, chacun avec son niveau, son pan, son mute et pré / post-fader.</p>
      <div className="flex flex-col gap-1">
        {slots.map((s, i) => <SendRow key={i} track={live} all={all} slot={i} send={s} />)}
      </div>
    </div>
  );
};

/** Send View (Pro Tools « Expanded Sends ») : l'envoi choisi en grand dans la tranche. */
export const SendViewStrip: React.FC<{ track: Track; all: Track[]; slot: number }> = ({ track, all, slot }) => {
  const send = sendSlots(track.sends)[slot];
  const letter = SEND_SLOT_LETTERS[slot].toUpperCase();
  const dests = sendDestinations(track, all);
  const set = (patch: Partial<TrackSend>) => send && updateSends(track.id, ss => ss.map(s => (s.id === send.id ? { ...s, ...patch, slot } : s)));
  return (
    <div className="h-full flex flex-col gap-1" data-testid={`send-view-${track.id}`}>
      <div className="flex items-center gap-1">
        <span className="shrink-0 text-[9px] font-black uppercase text-cyan-300">Envoi {letter}</span>
        <select aria-label={`Envoi ${letter} de ${track.name}`} value={send?.id || ''}
          onChange={(e) => { const id = e.target.value; updateSends(track.id, ss => setSendSlot(ss, slot, id ? { id, level: send?.level ?? gOf(-10), isEnabled: true, ...(send?.preFader ? { preFader: true } : {}) } : null)); }}
          className="min-w-0 flex-1 h-6 [@media(pointer:coarse)]:h-8 rounded border border-white/10 bg-black/50 px-1 text-[10px] text-white">
          <option value="">— libre —</option>
          {dests.map(d => <option key={d.id} value={d.id}>{trackDisplayName(d, all)}</option>)}
        </select>
      </div>
      {send ? (
        <>
          <div className="flex items-center gap-1">
            <input type="range" min={-60} max={6} step={0.5} value={Math.round(dbOf(send.level) * 2) / 2} aria-label={`Niveau de l'envoi ${letter}`}
              onChange={(e) => set({ level: Math.min(1.5, gOf(Number(e.target.value))) })} onDoubleClick={() => set({ level: 1 })}
              title="Niveau de l'envoi · double-clic : 0 dB" className="min-w-0 flex-1 accent-cyan-400" />
            <span className="w-11 shrink-0 text-right text-[9px] tabular-nums text-slate-300">{gainToDbText(send.level)}</span>
          </div>
          <div className="flex items-center gap-1">
            <input type="range" min={-1} max={1} step={0.01} value={send.pan ?? 0} aria-label={`Pan de l'envoi ${letter}`}
              onChange={(e) => set({ pan: Number(e.target.value) })}
              onDoubleClick={() => updateSends(track.id, ss => ss.map(s => { if (s.id !== send.id) return s; const o = { ...s }; delete o.pan; return o; }))}
              title="Pan de l'envoi (double-clic : suivre le pan de la piste)" className={`min-w-0 flex-1 accent-amber-400 ${send.pan === undefined ? 'opacity-50' : ''}`} />
            <span className="w-8 shrink-0 text-[9px] text-slate-400">{send.pan === undefined ? 'piste' : panToText(send.pan)}</span>
            <button type="button" onClick={() => set({ isMuted: !send.isMuted })} aria-pressed={!!send.isMuted} aria-label={`Couper l'envoi ${letter}`} title="Mute de l'envoi (Pro Tools)"
              className={`nova-hit-tactile h-6 w-6 shrink-0 rounded text-[9px] font-black ${send.isMuted ? 'bg-amber-500 text-black' : 'bg-white/10 text-slate-400'}`}>M</button>
            <button type="button" onClick={() => set({ preFader: !send.preFader })} aria-pressed={!!send.preFader} aria-label={`Envoi ${letter} pré-fader`} title="PRE : avant le fader"
              className={`nova-hit-tactile h-6 px-1 shrink-0 rounded text-[8px] font-black ${send.preFader ? 'bg-amber-400 text-black' : 'bg-white/10 text-slate-400'}`}>PRE</button>
          </div>
        </>
      ) : <p className="text-[9px] text-slate-500">Emplacement libre : choisis un retour.</p>}
    </div>
  );
};

/** Choix de la Send View dans la console : vue normale ou un envoi a-j en grand. */
export const SendViewPicker: React.FC<{ slot: number | null }> = ({ slot }) => (
  <label className="flex flex-col items-center gap-1" title="Send View (Pro Tools) : affiche un envoi (a à j) en grand dans chaque tranche">
    <span className="text-[10px] font-bold text-cyan-300 whitespace-nowrap">Envois</span>
    <select aria-label="Envoi affiché en grand (Send View)" data-testid="send-view-picker" value={slot === null ? '' : String(slot)}
      onChange={(e) => structureBus.emit({ kind: 'sendView', slot: e.target.value === '' ? null : Number(e.target.value) })}
      className="h-8 w-14 rounded-lg border border-cyan-500/30 bg-black/40 text-[11px] font-bold text-cyan-200">
      <option value="">a-j</option>
      {SEND_SLOT_LETTERS.map((l, i) => <option key={l} value={i}>{l.toUpperCase()}</option>)}
    </select>
  </label>
);

// ─── VCA ───────────────────────────────────────────────────────────────────────

/** Tranche VCA : fader (dB relatifs appliqués aux membres), Muet, Solo, membres. */
export const VcaStrip: React.FC<{ vca: Track; all: Track[] }> = ({ vca, all }) => {
  const members = vcaMembers(vca, all);
  const [pick, setPick] = useState<DOMRect | null>(null);
  const db = vca.volume > 0.0001 ? 20 * Math.log10(vca.volume) : -60;
  const set = (patch: Partial<Track>) => applyTracks(mapTrack(vca.id, t => ({ ...t, ...patch })));
  const candidates = all.filter(t => t.id !== vca.id && t.id !== 'master' && !t.folder && !(t.isVca && t.id === vca.id));
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pos = Math.sqrt(Math.max(0, vca.volume) / 1.5);
  const fader = useKnobInteraction(pos, (p) => set({ volume: p * p * 1.5 }), {
    min: 0, max: 1, defaultValue: Math.sqrt(1 / 1.5), wheelStep: 0.005, sensitivity: Math.max(120, trackRef.current?.clientHeight || 300),
  });
  return (
    <div data-strip-id={vca.id} data-testid={`vca-strip-${vca.id}`}
      className={`relative w-36 shrink-0 h-full border-r border-white/5 bg-violet-500/[0.06] p-3 flex flex-col gap-2 ${vca.isInactive ? 'opacity-50 grayscale' : ''}`}>
      <div className="text-[9px] font-black uppercase tracking-wide text-violet-300" title="VCA Master (Pro Tools) : pilote le volume des membres, sans passer le son">VCA</div>
      <button type="button" onClick={(e) => setPick((e.currentTarget as HTMLElement).getBoundingClientRect())}
        className="rounded border border-violet-400/40 bg-violet-500/10 px-2 py-1 text-[10px] font-bold text-violet-200 text-left" data-testid={`vca-members-${vca.id}`}>
        {members.length} membre{members.length > 1 ? 's' : ''} ▾
      </button>
      <div className="flex-1 flex justify-center min-h-[120px]">
        {/* Même fader que les tranches (glisser, Maj = fin, molette, double-clic = 0 dB) ; le curseur natif reste pour le clavier. */}
        <div {...fader.bind} ref={(el) => { trackRef.current = el; fader.wheelRef(el); }} role="presentation"
          title="Fader du VCA : glisser (Maj = fin), molette, double-clic = 0 dB · pilote les membres en dB relatifs"
          className="relative h-full w-7 rounded-full border border-white/5 bg-black/40 cursor-pointer touch-none">
          <div className="absolute left-1/2 -translate-x-1/2 w-9 h-14 rounded border border-violet-300/60 bg-violet-500 shadow-2xl flex items-center justify-center"
            style={{ bottom: `calc(${pos * 100}% - 28px)` }}><div className="w-full h-0.5 bg-black/70" /></div>
        </div>
        <input type="range" min={-60} max={3.5} step={0.1} value={Math.max(-60, Math.round(db * 10) / 10)}
          aria-label={`Fader du VCA ${vca.name}`} data-testid={`vca-fader-${vca.id}`}
          onChange={(e) => set({ volume: Number(e.target.value) <= -59.9 ? 0 : Math.pow(10, Number(e.target.value) / 20) })}
          className="sr-only" />
      </div>
      <div className="text-center text-[11px] font-mono tabular-nums text-violet-200">{db <= -59.9 ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`}</div>
      <div className="flex gap-1.5">
        <button type="button" onClick={() => set({ isMuted: !vca.isMuted })} aria-pressed={!!vca.isMuted} className={`nova-hit-tactile flex-1 h-8 rounded text-[9px] font-black ${vca.isMuted ? 'bg-amber-500 text-black' : 'bg-white/[0.06] text-slate-400'}`} title="Muet du VCA : coupe tous les membres">Muet</button>
        <button type="button" onClick={() => set({ isSolo: !vca.isSolo })} aria-pressed={!!vca.isSolo} className={`nova-hit-tactile flex-1 h-8 rounded text-[9px] font-black ${vca.isSolo ? 'bg-cyan-500 text-black' : 'bg-white/[0.06] text-slate-400'}`} title="Solo du VCA : met tous les membres en solo">Solo</button>
      </div>
      <div className="h-10 rounded-lg bg-violet-500/10 flex items-center px-2 text-[9px] font-black uppercase text-violet-200 truncate">{vca.name}</div>
      {pick && (
        <FloatingMenu x={pick.left} y={pick.bottom + 4} title={`Membres du VCA « ${vca.name} »`} onClose={() => setPick(null)}
          items={candidates.map(t => {
            const on = t.vcaId === vca.id;
            return { label: `${on ? '✓ ' : ''}${t.name}`, onClick: () => applyTracks(mapTrack(t.id, x => { const o = { ...x }; if (on) delete o.vcaId; else o.vcaId = vca.id; return o; })) };
          })} />
      )}
    </div>
  );
};

// ─── Tranche inactive (console) ────────────────────────────────────────────────

export const InactiveStripVeil: React.FC<{ track: Track; all: Track[] }> = ({ track, all }) => {
  if (!isEffectivelyInactive(track, all)) return null;
  const from = !track.isInactive ? ancestorsOf(track, new Map(all.map(t => [t.id, t]))).find(a => a.isInactive) : undefined;
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-nv-bg/75 backdrop-grayscale" data-testid={`strip-inactive-${track.id}`}>
      <span className="text-[10px] font-bold text-nv-muted text-center px-2">{from ? `Dans le dossier inactif « ${from.name} »` : 'Piste inactive'}</span>
      <button type="button" onClick={() => applyTracks(ts => (from ? setTracksInactive(ts, [from.id], false) : setTracksInactive(ts, [track.id], false)))}
        title="Pro Tools « Make Active »" className="nova-hit-tactile rounded-full border border-nv-line bg-nv-raised px-3 py-1.5 text-[11px] font-bold text-nv-ink hover:border-nv-accent">Activer</button>
    </div>
  );
};

/** Bouton « + VCA » et « + Dossier » de la console. */
export const MixerStructureButtons: React.FC<{ tracks: Track[] }> = ({ tracks }) => {
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const add = useCallback((kind: 'vca' | 'routing' | 'basic') => {
    const n = (p: string) => { let i = 1; while (tracks.some(t => t.name === `${p} ${i}`)) i++; return `${p} ${i}`; };
    if (kind === 'vca') applyTracks(ts => createVca(ts, { id: uid('vca'), name: n('VCA') }), 'VCA créé : choisis ses membres (bouton « membres »)');
    else applyTracks(ts => createFolder(ts, { id: uid('folder'), name: n(kind === 'routing' ? 'DOSSIER BUS' : 'DOSSIER'), kind }), 'Dossier créé : glisse des pistes dedans depuis la liste des pistes');
  }, [tracks]);
  return (
    <>
      <button type="button" data-testid="mixer-structure-add" onClick={(e) => setMenu((e.currentTarget as HTMLElement).getBoundingClientRect())}
        className="w-10 h-10 rounded-xl border border-dashed border-violet-500/30 text-violet-300 hover:bg-violet-500/10 flex items-center justify-center" title="Ajouter un VCA ou un dossier (Pro Tools)" aria-label="Ajouter un VCA ou un dossier">
        <i className="fas fa-folder-plus text-[11px]" />
      </button>
      <span className="text-[10px] font-bold text-violet-300 whitespace-nowrap">VCA · Dossier</span>
      <button type="button" data-testid="mixer-open-tracks" onClick={() => structureBus.emit({ kind: 'panel', panel: 'tracks' })}
        className="w-10 h-10 rounded-xl border border-dashed border-white/20 text-slate-300 hover:bg-white/10 flex items-center justify-center" title="Liste des pistes (Pro Tools) : afficher / masquer, activer, dossiers" aria-label="Liste des pistes">
        <i className="fas fa-list text-[11px]" />
      </button>
      <span className="text-[10px] font-bold text-slate-400 whitespace-nowrap">Pistes</span>
      <button type="button" data-testid="mixer-open-buses" onClick={() => structureBus.emit({ kind: 'panel', panel: 'buses' })}
        className="w-10 h-10 rounded-xl border border-dashed border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10 flex items-center justify-center" title="Bus nommés (I/O Setup de Pro Tools) : créer, renommer, voir qui envoie où" aria-label="Bus nommés">
        <i className="fas fa-project-diagram text-[11px]" />
      </button>
      <span className="text-[10px] font-bold text-cyan-300 whitespace-nowrap">Bus</span>
      {menu && (
        <FloatingMenu x={menu.right + 6} y={menu.top} onClose={() => setMenu(null)} items={[
          { label: 'VCA', icon: 'fa-sliders-h', title: 'VCA Master : un fader qui pilote le volume de pistes membres', onClick: () => add('vca') },
          { label: 'Dossier de routage', icon: 'fa-folder-open', title: 'Routing Folder : un dossier qui est un bus (fader, inserts)', onClick: () => add('routing') },
          { label: 'Dossier simple', icon: 'fa-folder', title: 'Basic Folder : range les pistes', onClick: () => add('basic') },
        ]} />
      )}
    </>
  );
};

/** Pistes d'un envoi en grand : utile pour savoir quel emplacement est libre. */
export const sendSlotOfTrack = (t: Track, sendId: string) => sendSlots(t.sends).findIndex(s => s?.id === sendId);
