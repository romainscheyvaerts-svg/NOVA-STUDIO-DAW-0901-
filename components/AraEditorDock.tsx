/**
 * Panneau ARA en bas de la fenêtre Édition (comme Pro Tools) : l'éditeur de Melodyne / VocAlign
 * posé en insert sur une piste s'y ancre.
 *
 * Dans l'appli Windows, la fenêtre native du plugin devient une fenêtre ENFANT de l'appli,
 * posée sur le repère `data-testid="ara-dock-slot"` (pixels physiques = rectangle CSS ×
 * devicePixelRatio) ; elle suit les redimensionnements, se masque quand le panneau se ferme ou
 * qu'on change de vue (console, automation). « Détacher » : fenêtre flottante. Dans le
 * navigateur (pas de fenêtre à laquelle s'accrocher), l'éditeur s'ouvre en fenêtre à part.
 *
 * L'éditeur suit la sélection : les clips choisis de la piste, sinon toute la piste ; un clic
 * sur une autre piste qui a un insert ARA bascule le panneau sur elle.
 * « Valider (Commit) » : rendu des clips à travers le plugin (optionnel, libère le processeur).
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Clip, Track } from '../types';
import { AraInsertNode, liveAraInserts, onAraInsertsChange } from '../engine/AraInsertNode';
import { araArchiveOfState, araInsertKind, araInsertOf, araMissingMessage, effectsBeforeAraInsert } from '../utils/araInsert';
import { ARA_LABEL, araClipPatch, araPersistentId, guessLeadTrack } from '../utils/araEdit';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { desktopHwnd } from '../utils/desktopApp';
import { useEditSelection } from '../utils/editSelection';
import { useBridgeState } from '../hooks/useNovaBridge';

export interface AraCommitChange { trackId: string; clipId: string; patch: Partial<Clip> }

interface Props {
  tracks: Track[];
  selectedTrackId: string | null;
  /** « Valider (Commit) » : clips rendus, insert retiré, en une seule annulation. */
  onCommit: (trackId: string, pluginId: string, changes: AraCommitChange[], message: string) => void;
  /** VocAlign : piste guide choisie dans la barre de l'effet. */
  onSetGuide?: (trackId: string, pluginId: string, guideTrackId: string | null) => void;
}

const HEIGHT_KEY = 'nova.ara.dockHeight';
const readHeight = () => { try { const v = Number(localStorage.getItem(HEIGHT_KEY)); return v >= 160 && v <= 900 ? v : 320; } catch { return 320; } };

/** Ouvre le panneau sur l'insert ARA d'une piste (menu de l'effet, clic sur l'insert, ajout). */
export const openAraDock = (trackId: string, pluginId?: string) => {
  try { window.dispatchEvent(new CustomEvent('nova:ara-dock', { detail: { trackId, pluginId } })); } catch { /* hors navigateur */ }
};

const toBuffer = (channels: Float32Array[], sampleRate: number): AudioBuffer => {
  const b = new AudioBuffer({ length: Math.max(1, channels[0]?.length || 1), numberOfChannels: Math.max(1, channels.length), sampleRate });
  channels.forEach((c, i) => b.copyToChannel(c, i));
  return b;
};

const AraEditorDock: React.FC<Props> = ({ tracks, selectedTrackId, onCommit, onSetGuide }) => {
  const [target, setTarget] = useState<{ trackId: string; pluginId: string } | null>(null);
  const [height, setHeight] = useState(readHeight);
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [floating, setFloating] = useState(false);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const bridge = useBridgeState();
  const sel = useEditSelection();
  const hwnd = desktopHwnd();

  useEffect(() => onAraInsertsChange(() => setTick(t => t + 1)), []);

  // Ouverture demandée (ajout de l'insert, clic sur l'insert dans la piste ou la console).
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      const t = tracks.find(x => x.id === d.trackId);
      const p = d.pluginId ? t?.plugins.find(x => x.id === d.pluginId) : araInsertOf(t);
      if (t && p) { setTarget({ trackId: t.id, pluginId: p.id }); setFloating(false); setError(null); }
    };
    window.addEventListener('nova:ara-dock', on);
    return () => window.removeEventListener('nova:ara-dock', on);
  }, [tracks]);

  // L'éditeur suit la sélection : autre piste avec un insert ARA → le panneau bascule.
  useEffect(() => {
    if (!target || !selectedTrackId || selectedTrackId === target.trackId) return;
    const p = araInsertOf(tracks.find(t => t.id === selectedTrackId));
    if (p) setTarget({ trackId: selectedTrackId, pluginId: p.id });
  }, [selectedTrackId]); // eslint-disable-line react-hooks/exhaustive-deps

  const track = target ? tracks.find(t => t.id === target.trackId) || null : null;
  const plugin = track?.plugins.find(p => p.id === target?.pluginId) || null;
  const kind = araInsertKind(plugin);
  const node: AraInsertNode | null = plugin ? liveAraInserts.get(plugin.id) || null : null;
  const info = node?.getAraInfo();

  // Insert retiré / piste supprimée : panneau fermé.
  useEffect(() => { if (target && (!track || !plugin)) setTarget(null); }, [target, track, plugin]);

  // Repère du panneau → fenêtre enfant du plugin (pixels physiques).
  const rectOf = useCallback(() => {
    const el = slotRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { x: Math.round(r.left * dpr), y: Math.round(r.top * dpr), w: Math.max(1, Math.round(r.width * dpr)), h: Math.max(1, Math.round(r.height * dpr)) };
  }, []);

  const lastRect = useRef('');
  const docked = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!node || !hwnd || floating || !target) return;
    let alive = true;
    const place = (force = false) => {
      const r = rectOf();
      if (!r || !alive) return;
      const key = `${r.x},${r.y},${r.w},${r.h}`;
      if (!force && key === lastRect.current && docked.current === node.getAraInfo().pluginId) return;
      lastRect.current = key;
      if (docked.current !== node.getAraInfo().pluginId) {
        docked.current = node.getAraInfo().pluginId;
        node.dockEditor(hwnd, r, true).catch((e: any) => { if (alive) setError(e?.message || 'Éditeur indisponible'); });
      } else node.setDockBounds(r, true);
    };
    place(true);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => place()) : null;
    if (ro && slotRef.current) ro.observe(slotRef.current);
    const onResize = () => place();
    window.addEventListener('resize', onResize);
    const iv = window.setInterval(() => place(), 400);   // décalages de mise en page (barres, panneaux)
    return () => {
      alive = false;
      ro?.disconnect();
      window.removeEventListener('resize', onResize);
      window.clearInterval(iv);
      // Panneau fermé, autre piste, autre vue : la fenêtre native est masquée.
      docked.current = null;
      lastRect.current = '';
      void node.hideEditor();
    };
  }, [node, hwnd, floating, target, rectOf, height]);

  // Sélection de clips de la piste → l'éditeur montre ces clips (sinon toute la piste).
  useEffect(() => {
    if (!node || !track) return;
    const ids = new Set(track.clips.map(c => c.id));
    node.setSelection(sel.clipIds.filter(id => ids.has(id)));
  }, [node, track, sel.clipIds]);

  const detach = async () => {
    if (!node) return;
    setFloating(true);
    try { await node.floatEditor(); } catch (e: any) { setError(e?.message || 'Fenêtre indisponible'); }
  };
  const attach = () => { setFloating(false); };
  const close = () => { setTarget(null); setFloating(false); };

  // « Valider (Commit) » : chaque clip reçoit le son rendu par le plugin (original et retouches gardés).
  const commit = async () => {
    if (!node || !track || !plugin || !kind) return;
    const clips = track.clips.filter(c => c.bufferId && !c.isMuted && !(c.notes && c.notes.length));
    if (!clips.length) return;
    setBusy('Rendu des clips à travers le plugin…');
    setError(null);
    try {
      const sr = audioBufferRegistry.get(clips[0].bufferId!)?.sampleRate || 48000;
      const start = Math.max(0, Math.min(...clips.map(c => c.start)));
      const end = Math.max(...clips.map(c => c.start + c.duration));
      const ch = await node.renderRange(start, end - start, sr);
      const state = await node.syncState().catch(() => null);
      const changes: AraCommitChange[] = [];
      const t0 = Date.now();
      for (const c of clips) {
        const a = Math.max(0, Math.round((c.start - start) * sr));
        const b = Math.min(ch[0].length, Math.round((c.start + c.duration - start) * sr));
        const part = ch.map(x => x.slice(a, Math.max(a + 1, b)));
        const id = `ara-commit-${c.id}-${t0}`;
        audioBufferRegistry.register(toBuffer(part, sr), id);
        const region = { start: c.offset || 0, end: (c.offset || 0) + c.duration };
        changes.push({ trackId: track.id, clipId: c.id, patch: araClipPatch(c, {
          plugin: kind, mode: kind === 'melodyne' ? 'ara' : 'capture', newBufferId: id, sourceBufferId: c.araEdit?.sourceBufferId || c.bufferId, sourceOffset: c.offset || 0,
          regionStart: c.offset || 0, persistentId: araPersistentId(c.bufferId, c.id, region), archive: araArchiveOfState(state),
          pluginName: plugin.params?.name || ARA_LABEL[kind], at: t0,
        }) });
      }
      onCommit(track.id, plugin.id, changes, `🎛️ ${ARA_LABEL[kind]} : ${changes.length} clip${changes.length > 1 ? 's' : ''} rendu${changes.length > 1 ? 's' : ''} (Commit), insert retiré. L’original et les retouches sont gardés (Ctrl+Z pour revenir).`);
      setTarget(null);
    } catch (e: any) {
      setError(e?.message || 'Rendu impossible');
    } finally {
      setBusy(null);
    }
  };

  const beforeIgnored = useMemo(() => (track ? effectsBeforeAraInsert(track) : []), [track]);
  const leadGuess = useMemo(() => (track && kind === 'vocalign' ? guessLeadTrack(tracks, track.id) : undefined), [tracks, track, kind]);
  const guideId: string | null = plugin?.params?.guideTrackId ?? leadGuess?.id ?? null;

  if (!target || !track || !plugin || !kind) return null;

  const missing = araMissingMessage(kind, { bridgeConnected: bridge.status === 'connected', pluginInstalled: !!bridge.araInsert, frozen: !!track.frozenClip });
  const startDrag = (e: React.PointerEvent) => {
    const y0 = e.clientY, h0 = height;
    const move = (ev: PointerEvent) => setHeight(Math.max(160, Math.min(900, h0 + (y0 - ev.clientY))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setHeight(h => { try { localStorage.setItem(HEIGHT_KEY, String(h)); } catch { /* */ } return h; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <section data-testid="ara-dock" aria-label={`Éditeur ${ARA_LABEL[kind]} de ${track.name}`}
      className="shrink-0 flex flex-col border-t border-fuchsia-500/30 bg-[#0c0e12]" style={{ height: floating ? 44 : height }}>
      {!floating && <div onPointerDown={startDrag} className="h-1.5 cursor-ns-resize bg-white/5 hover:bg-fuchsia-500/40" title="Glisser pour agrandir le panneau" />}
      <header className="h-10 shrink-0 flex items-center gap-3 px-3 text-[11px] text-slate-300">
        <span className="font-black text-white">{ARA_LABEL[kind]}</span>
        <span className="rounded border border-fuchsia-400/50 bg-fuchsia-500/15 px-1.5 py-px text-[9px] font-black tracking-wider text-fuchsia-200">ARA</span>
        <span className="truncate">Piste « {track.name} » · {info?.regions ?? 0} clip{(info?.regions ?? 0) > 1 ? 's' : ''}{sel.clipIds.some(id => track.clips.some(c => c.id === id)) ? ' · sélection' : ' · toute la piste'}</span>
        {info?.syncing && <span className="text-cyan-300" data-testid="ara-dock-sync"><i className="fas fa-circle-notch fa-spin mr-1" />Mise à jour…</span>}
        {kind === 'vocalign' && info?.capture && (
          <span data-testid="ara-dock-capture" className={info.capture.state === 'error' ? 'text-amber-300' : info.capture.state === 'done' ? 'text-emerald-300' : 'text-cyan-300'}
            title="VocAlign 6 Standard (VST3) n’aligne pas par ARA : NOVA lui fait capturer le guide et le double tout seul, puis la piste joue le double calé.">
            {info.capture.state === 'running' ? <><i className="fas fa-circle-notch fa-spin mr-1" />Capture VocAlign…</>
              : info.capture.state === 'done' ? `Double calé (capture ${info.capture.seconds ?? '?'} s)`
              : info.capture.state === 'waiting_guide' ? 'Choisis le guide (la lead)'
              : info.capture.state === 'error' ? `Capture impossible : ${info.capture.error || ''}` : ''}
          </span>
        )}
        {kind === 'vocalign' && (
          <label className="flex items-center gap-1.5">Guide
            <select data-testid="ara-dock-guide" value={guideId || ''} onChange={e => onSetGuide?.(track.id, plugin.id, e.target.value || null)}
              className="h-7 rounded bg-black/40 border border-white/10 px-1 text-[11px] text-white">
              <option value="">— choisir la lead —</option>
              {tracks.filter(t => t.id !== track.id && (t.clips || []).some(c => c.bufferId)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
        {/* Détaché : barre de 44 px tout en bas, sous le bouton flottant de l’assistante Nova (en bas à droite)
            qui recouvrait « Ancrer » et la croix : les boutons suivent alors le titre, à gauche. */}
        <div className={`${floating ? '' : 'ml-auto '}flex items-center gap-2`}>
          {busy && <span className="text-cyan-300"><i className="fas fa-circle-notch fa-spin mr-1" />{busy}</span>}
          <button type="button" data-testid="ara-dock-commit" onClick={commit} disabled={!!busy || !node}
            title="Pro Tools « Commit » : rend les clips à travers le plugin (son figé, processeur libéré). L’original et les retouches restent récupérables."
            className="h-7 rounded-full border border-white/15 px-3 font-bold hover:border-fuchsia-400 disabled:opacity-40">Valider (Commit)</button>
          {hwnd && (floating
            ? <button type="button" data-testid="ara-dock-attach" onClick={attach} className="h-7 rounded-full border border-white/15 px-3 font-bold hover:border-cyan-400">Ancrer</button>
            : <button type="button" data-testid="ara-dock-detach" onClick={detach} className="h-7 rounded-full border border-white/15 px-3 font-bold hover:border-cyan-400">Détacher</button>)}
          <button type="button" aria-label="Fermer le panneau" title="Fermer le panneau (l’insert reste actif)" onClick={close}
            className="h-7 w-7 rounded-full text-slate-400 hover:text-white hover:bg-white/10"><i className="fas fa-times" /></button>
        </div>
      </header>
      {!floating && (
        <div className="relative flex-1 min-h-0 mx-2 mb-2 rounded-lg border border-white/5 bg-black/40 overflow-hidden">
          <div ref={slotRef} data-testid="ara-dock-slot" className="absolute inset-0" />
          {(!hwnd || !node || missing || error || info?.syncError) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-[12px] text-slate-400">
              {missing ? <p data-testid="ara-dock-missing">{missing}</p>
                : error || info?.syncError ? <p className="text-amber-300" role="alert">{error || info?.syncError}</p>
                : !node ? <p>Chargement de {ARA_LABEL[kind]}…</p>
                : <>
                    <p>Dans le navigateur, l’éditeur de {ARA_LABEL[kind]} s’ouvre dans une fenêtre à part (dans l’appli Nova Studio, il s’ancre ici).</p>
                    <button type="button" onClick={detach} className="h-8 rounded-full bg-fuchsia-500/80 px-4 font-bold text-white hover:bg-fuchsia-500">Ouvrir la fenêtre</button>
                  </>}
            </div>
          )}
          {beforeIgnored.length > 0 && (
            <p className="absolute bottom-1 left-2 text-[10px] text-amber-300/80">Effets placés avant {ARA_LABEL[kind]} ignorés (il lit les clips eux-mêmes) : {beforeIgnored.map(p => p.name).join(', ')}</p>
          )}
        </div>
      )}
    </section>
  );
};

export default AraEditorDock;
