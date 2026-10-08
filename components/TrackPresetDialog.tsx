/**
 * Track Presets (R4, Pro Tools 2020+ « Track Presets ») : toute la chaîne d'une
 * piste — inserts dans l'ordre avec actif / bypass / inactif, envois, volume,
 * pan, sortie — enregistrée, puis rappelée sur une piste existante ou sur une
 * nouvelle piste. Logic : « Patches » de piste ; Ableton : « Audio Effect
 * Rack » enregistré ; FL : « Mixer track state » (.fst).
 *
 * Rappeler = une seule modification des pistes (une étape d'annulation, un seul
 * envoi en collaboration). Les retours visés par les envois (reverb, délai)
 * sont créés s'ils manquent ; un VST absent du PC est remplacé par l'effet NOVA
 * proche (même règle que les modèles de session).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DAWState, Track } from '../types';
import {
  applyTrackPreset, CHAIN_EXT, createTrackFromPreset, makeTrackPreset, RECALL_ALL, RecallOptions, resolvePresetPlugins,
  TrackPreset, trackPresetSummary,
} from '../utils/presets';
import {
  deletePreset, exportPresetFile, importPresetText, isFavorite, listTrackPresets, renamePreset, savePreset, setFavorite,
} from '../services/PresetStore';
import { novaBridge } from '../services/NovaBridge';
import { syncLiveVstStates } from '../services/VstFreeze';
import { saveBlob } from '../utils/saveBlob';

interface Props {
  open: boolean;
  /** Piste visée (rappel, enregistrement) ; absente : création d'une piste seulement. */
  trackId?: string;
  tracks: Track[];
  setState: (fn: (prev: DAWState) => DAWState) => void;
  onClose: () => void;
}

type Status = { kind: 'ok' | 'error' | 'info'; text: string } | null;

const RECALL_LABELS: { key: keyof RecallOptions; label: string; help: string }[] = [
  { key: 'inserts', label: 'Effets', help: 'Inserts dans l’ordre, avec leur état actif / bypass / inactif' },
  { key: 'sends', label: 'Envois', help: 'Envois a à j (niveau, pan, pré / post) ; les retours manquants sont créés' },
  { key: 'volumePan', label: 'Volume et pan', help: 'Fader et pan de la piste' },
  { key: 'output', label: 'Sortie', help: 'Sortie de la piste (master, bus, dossier)' },
];

const notify = (text: string) => { try { window.dispatchEvent(new CustomEvent('nova:notify', { detail: text })); } catch { /* hors navigateur */ } };

const candidates = async () => {
  if (!novaBridge.isConnected()) return null;
  let list = novaBridge.getCachedPlugins();
  if (!list.length) list = await novaBridge.listPlugins().catch(() => novaBridge.getCachedPlugins());
  return list.map(p => ({ name: p.name, vendor: p.vendor, path: p.path, pluginName: p.pluginName ?? null, isInstrument: p.isInstrument ?? null }));
};

const TrackPresetDialog: React.FC<Props> = ({ open, trackId, tracks, setState, onClose }) => {
  const [list, setList] = useState<TrackPreset[] | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [recall, setRecall] = useState<Required<RecallOptions>>(RECALL_ALL);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const track = useMemo(() => tracks.find(t => t.id === trackId), [tracks, trackId]);
  const simple = typeof window !== 'undefined' && window.innerWidth < 640;

  const refresh = useCallback(async () => {
    try { setList(await listTrackPresets()); } catch (e: any) { setList([]); setStatus({ kind: 'error', text: `Track Presets illisibles : ${e?.message || e}` }); }
  }, []);
  useEffect(() => { if (open) { setStatus(null); void refresh(); } }, [open, refresh]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e: any) { setStatus({ kind: 'error', text: e?.message || String(e) }); } finally { setBusy(false); }
  };

  const recallOn = (p: TrackPreset) => act(async () => {
    if (!track) return;
    const resolved = recall.inserts ? resolvePresetPlugins(p, await candidates()) : null;
    // Rapport lu sur l'état affiché ; la modification part de l'état le plus récent (une étape d'annulation).
    const msgs = applyTrackPreset(tracks, track.id, p, { ...recall, plugins: resolved?.plugins }).report.messages;
    setState(prev => ({ ...prev, tracks: applyTrackPreset(prev.tracks, track.id, p, { ...recall, plugins: resolved?.plugins }).tracks }));
    const extra = [...(resolved?.report.messages || []), ...msgs];
    const text = `✅ « ${p.name} » rappelé sur ${track.name}${extra.length ? ` · ${extra.join(' ')}` : ''} (Ctrl+Z pour revenir).`;
    setStatus({ kind: 'ok', text });
    notify(text);
  });

  const createWith = (p: TrackPreset) => act(async () => {
    const resolved = resolvePresetPlugins(p, await candidates());
    const id = `track-${Date.now()}`;
    const opts = { id, name: p.name, afterId: trackId || null, plugins: resolved.plugins };
    const msgs = createTrackFromPreset(tracks, p, opts).report.messages;
    setState(prev => ({ ...prev, tracks: createTrackFromPreset(prev.tracks, p, opts).tracks, selectedTrackId: id }));
    const extra = [...resolved.report.messages, ...msgs];
    const text = `➕ Nouvelle piste « ${p.name} » créée avec sa chaîne${extra.length ? ` · ${extra.join(' ')}` : ''}.`;
    setStatus({ kind: 'ok', text });
    notify(text);
  });

  const saveCurrent = () => act(async () => {
    if (!track || saveName === null) return;
    const name = saveName.trim();
    if (!name) throw new Error('Donne un nom au Track Preset (par exemple « Voix lead · Romain »).');
    // État des VST relu sur le pont (réglages faits dans leur fenêtre).
    const states = novaBridge.isConnected() ? await syncLiveVstStates().catch(() => new Map<string, string>()) : new Map<string, string>();
    const src: Track = { ...track, plugins: track.plugins.map(pl => (states.has(pl.id) ? { ...pl, params: { ...pl.params, stateB64: states.get(pl.id) } } : pl)) };
    const saved = await savePreset(makeTrackPreset(src, tracks, name));
    setSaveName(null);
    await refresh();
    setStatus({ kind: 'ok', text: `✅ Track Preset « ${saved.name} » enregistré : ${trackPresetSummary(saved)}.` });
  });

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    await act(async () => {
      const p = await importPresetText(await file.text());
      if (p.format !== 'novachain') throw new Error('Ce fichier est un preset d’effet (.novapreset) : ouvre-le depuis la fenêtre de l’effet (bouton Presets).');
      await refresh();
      setStatus({ kind: 'ok', text: `📥 Track Preset « ${p.name} » importé.` });
    });
    if (fileRef.current) fileRef.current.value = '';
  };

  const btn = 'min-h-[36px] [@media(pointer:coarse)]:min-h-[44px] px-3 rounded-lg text-[12px] font-bold transition-colors disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Track Presets" data-testid="track-preset-dialog" onClick={e => e.stopPropagation()}
        className="flex max-h-[92vh] w-full sm:max-w-xl flex-col rounded-t-2xl sm:rounded-2xl border border-nv-line bg-nv-panel text-nv-ink shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-nv-line p-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-black">Track Presets{track ? <span className="font-semibold text-nv-muted"> · {track.name}</span> : null}</h2>
            <p className="text-[11px] text-nv-muted" title="Pro Tools 2020+ : Track Presets · Logic : Patches · Ableton : Rack enregistré · FL : état de piste du mixeur (.fst)">
              Toute la chaîne d’une piste : effets dans l’ordre, envois, volume, pan, sortie. Comme les Track Presets de Pro Tools.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10 hover:text-nv-ink"><i className="fas fa-times" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {status && (
            <p role={status.kind === 'error' ? 'alert' : 'status'} className={`rounded-lg px-3 py-2 text-[12px] ${status.kind === 'error' ? 'bg-red-500/10 text-red-400' : status.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-nv-accent/10'}`}>{status.text}</p>
          )}

          {track && !simple && (
            <fieldset className="flex flex-wrap gap-2 rounded-xl border border-nv-line p-2">
              <legend className="px-1 text-[10px] font-bold uppercase tracking-wide text-nv-muted">Rappeler</legend>
              {RECALL_LABELS.map(r => (
                <label key={r.key} title={r.help} className="flex min-h-[32px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] hover:bg-nv-accent/10">
                  <input type="checkbox" checked={recall[r.key]} onChange={e => setRecall(o => ({ ...o, [r.key]: e.target.checked }))} className="accent-cyan-500" />
                  {r.label}
                </label>
              ))}
            </fieldset>
          )}

          {list === null ? <p className="text-[12px] text-nv-muted">Chargement…</p> : list.length === 0 ? (
            <p className="rounded-lg bg-nv-well p-3 text-[12px] text-nv-muted">Aucun Track Preset. Règle la chaîne d’une piste, puis « Enregistrer la chaîne de cette piste ».</p>
          ) : (
            <ul className="space-y-2" data-testid="track-preset-list">
              {list.map(p => {
                const fav = isFavorite(p.id);
                return (
                  <li key={p.id} className="rounded-xl border border-nv-line bg-nv-surface p-3">
                    <div className="flex items-start gap-2">
                      <button type="button" onClick={() => { setFavorite(p.id, !fav); setTick(x => x + 1); void refresh(); }} aria-pressed={fav}
                        aria-label={fav ? `Retirer « ${p.name} » des favoris` : `Mettre « ${p.name} » en favori`} title={fav ? 'Favori (clic pour retirer)' : 'Mettre en favori : en tête de liste'}
                        className="h-9 w-9 shrink-0 rounded-lg hover:bg-nv-accent/10"><i className={`${fav ? 'fas text-amber-400' : 'far text-nv-muted'} fa-star`} /></button>
                      <div className="min-w-0 flex-1">
                        {renaming?.id === p.id ? (
                          <form className="flex gap-1" onSubmit={e => { e.preventDefault(); void act(async () => { await renamePreset(p.id, renaming.name); setRenaming(null); await refresh(); }); }}>
                            <input autoFocus value={renaming.name} onChange={e => setRenaming({ id: p.id, name: e.target.value })} aria-label="Nouveau nom"
                              className="min-w-0 flex-1 rounded-lg border border-nv-line bg-nv-well px-2 py-1 text-[13px] outline-none focus:border-nv-accent" />
                            <button type="submit" className={`${btn} bg-cyan-500 text-black hover:bg-cyan-400`}>OK</button>
                          </form>
                        ) : (
                          <p className="flex items-center gap-2 text-[13px] font-bold">
                            <span className="truncate">{p.name}</span>
                            {p.bundled && <span className="shrink-0 rounded bg-cyan-500/15 px-1.5 text-[9px] font-black uppercase text-cyan-500">Make Music</span>}
                          </p>
                        )}
                        <p className="text-[11px] text-nv-muted">{trackPresetSummary(p)}</p>
                        {p.description && !simple && <p className="mt-0.5 text-[11px] text-nv-muted">{p.description}</p>}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {track && (
                        <button type="button" disabled={busy} onClick={() => void recallOn(p)} data-testid="track-preset-apply"
                          title={`Remplace la chaîne de « ${track.name} » par celle du preset (une seule étape d’annulation)`}
                          className={`${btn} bg-cyan-500 text-black hover:bg-cyan-400`}><i className="fas fa-wand-magic-sparkles mr-1" />Appliquer à {track.name}</button>
                      )}
                      <button type="button" disabled={busy} onClick={() => void createWith(p)} data-testid="track-preset-new"
                        title="Crée une nouvelle piste avec cette chaîne (Pro Tools : New Track > Track Preset)"
                        className={`${btn} border border-nv-line hover:bg-nv-accent/10`}><i className="fas fa-plus mr-1" />Nouvelle piste</button>
                      {!simple && (
                        <button type="button" disabled={busy} onClick={() => void act(async () => { const f = exportPresetFile(p); await saveBlob(f.blob, f.filename); setStatus({ kind: 'ok', text: `💾 ${f.filename} prêt.` }); })}
                          title={`Exporter en ${CHAIN_EXT} : à envoyer, ou à ouvrir sur un autre poste`} className={`${btn} text-nv-muted hover:bg-nv-accent/10`}><i className="fas fa-file-export" /></button>
                      )}
                      {!simple && !p.bundled && (confirmDelete === p.id ? (
                        <>
                          <button type="button" onClick={() => void act(async () => { await deletePreset(p.id); setConfirmDelete(null); await refresh(); setStatus({ kind: 'ok', text: `« ${p.name} » supprimé.` }); })}
                            className={`${btn} bg-red-500 text-white`}>Supprimer</button>
                          <button type="button" onClick={() => setConfirmDelete(null)} className={`${btn} text-nv-muted`}>Garder</button>
                        </>
                      ) : (
                        <>
                          <button type="button" onClick={() => setRenaming({ id: p.id, name: p.name })} aria-label={`Renommer « ${p.name} »`} title="Renommer" className={`${btn} text-nv-muted hover:bg-nv-accent/10`}><i className="fas fa-pen" /></button>
                          <button type="button" onClick={() => setConfirmDelete(p.id)} aria-label={`Supprimer « ${p.name} »`} title="Supprimer" className={`${btn} text-nv-muted hover:text-red-400`}><i className="fas fa-trash" /></button>
                        </>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="space-y-2 border-t border-nv-line p-4">
          {track && (saveName === null ? (
            <button type="button" disabled={busy} onClick={() => setSaveName(`${track.name} · chaîne`)} data-testid="track-preset-save"
              title="Enregistre effets, envois, volume, pan et sortie de cette piste (Pro Tools : Save Track Preset)"
              className={`${btn} w-full border border-nv-line hover:bg-nv-accent/10`}><i className="fas fa-floppy-disk mr-1" />Enregistrer la chaîne de « {track.name} »</button>
          ) : (
            <form className="flex gap-1" onSubmit={e => { e.preventDefault(); void saveCurrent(); }}>
              <input autoFocus value={saveName} onChange={e => setSaveName(e.target.value)} aria-label="Nom du Track Preset" data-testid="track-preset-name"
                className="min-w-0 flex-1 rounded-lg border border-nv-line bg-nv-well px-3 py-2 text-[13px] outline-none focus:border-nv-accent" />
              <button type="submit" disabled={busy || !saveName.trim()} className={`${btn} bg-cyan-500 text-black hover:bg-cyan-400`}>Enregistrer</button>
              <button type="button" onClick={() => setSaveName(null)} className={`${btn} text-nv-muted`}>Annuler</button>
            </form>
          ))}
          {!simple && (
            <div className="flex justify-between">
              <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className={`${btn} text-nv-muted hover:bg-nv-accent/10`}><i className="fas fa-file-import mr-1" />Importer un {CHAIN_EXT}…</button>
              <span className="self-center text-[10px] text-nv-muted" title="Pas encore de stockage en ligne pour les modèles et les presets : exporte-les pour les emporter.">Rangés sur cet appareil</span>
              <input ref={fileRef} type="file" accept={`${CHAIN_EXT},application/json`} className="hidden" onChange={e => void onImport(e.target.files?.[0])} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TrackPresetDialog;
