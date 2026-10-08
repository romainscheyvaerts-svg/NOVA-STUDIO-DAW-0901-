/**
 * Presets d'un effet, dans la barre de sa fenêtre (R4) : Enregistrer, Charger,
 * Favori, Renommer, Supprimer, Exporter / Importer (.novapreset) et Comparer.
 *
 *  - Pro Tools : menu « Librarian » (Save / Save As / Import / Export) et bouton
 *    « Compare » ; Logic : menu « Réglages » et « Comparer » ; Ableton : « Save
 *    Preset » du titre de l'appareil ; FL Studio : menu « Presets » ‹ ›.
 *  - VST3 du PC : l'état est lu par le pont, et au chargement les paramètres
 *    sont relus pour vérifier que le plugin est réglé à l'identique.
 *  - Téléphone (simple) : la liste et « Enregistrer sous », sans le reste.
 *
 * Charger un preset = une seule modification de l'effet (une étape
 * d'annulation, un seul envoi en collaboration).
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PluginInstance } from '../types';
import {
  applyPluginPreset, CompareState, compareInit, compareModified, compareOnEdit, compareToggle, comparing, makePluginPreset,
  matchesPreset, PluginPreset, PRESET_EXT, sameSettings, soundSettingsOf, withSoundSettings,
} from '../utils/presets';
import {
  deletePreset, exportPresetFile, importPresetText, isFavorite, listPluginPresets, renamePreset, savePreset, setFavorite,
} from '../services/PresetStore';
import { applyVstStateVerified, readVstSlot, slotOfPlugin } from '../services/VstPresets';
import { liveVstNodes } from '../engine/VSTPluginNode';
import { saveBlob } from '../utils/saveBlob';

/** Comparer : référence par effet, gardée pendant la session (fenêtre refermée puis rouverte). */
const compareStates = new Map<string, CompareState>();
/** Tests / scénarios : état de Comparer d'un effet. */
export const getCompareState = (pluginId: string) => compareStates.get(pluginId) || null;

type Status = { kind: 'ok' | 'error' | 'info'; text: string } | null;

export interface PresetMenuProps {
  /** L'effet tel qu'il est maintenant (réglages à jour). */
  plugin: PluginInstance;
  /** Pose des réglages sur l'effet : UNE modification (annulation, collaboration). */
  onApply: (patch: Record<string, any>) => void;
  /** Après un chargement : l'interface de l'effet se recharge sur les nouveaux réglages. */
  onReloaded?: () => void;
  /** Téléphone : liste + « Enregistrer sous » seulement. */
  simple?: boolean;
}

const isVst = (p: PluginInstance) => p.type === 'VST3';

const PresetMenu: React.FC<PresetMenuProps> = ({ plugin, onApply, onReloaded, simple }) => {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<PluginPreset[]>([]);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const presetName: string | null = plugin.params?.presetName || null;
  const settings = useMemo(() => soundSettingsOf(plugin), [plugin]);

  // Référence de Comparer : le réglage à l'ouverture (ou le dernier preset chargé / enregistré).
  if (!compareStates.has(plugin.id)) compareStates.set(plugin.id, compareInit(settings, presetName || 'réglage à l’ouverture'));
  let cs = compareStates.get(plugin.id)!;
  // VST : l'état arrive du pont après l'ouverture (chargement) : la référence le prend.
  if (cs.stash === null && !Object.keys(cs.ref).length && Object.keys(settings).length) { cs = compareInit(settings, cs.refLabel); compareStates.set(plugin.id, cs); }
  // Un réglage touché pendant qu'on écoute la référence : on repart de là.
  if (comparing(cs) && !sameSettings(cs.ref, settings)) { cs = compareOnEdit(cs); compareStates.set(plugin.id, cs); }
  const modified = compareModified(cs, settings);
  const listening = comparing(cs);

  const refresh = useCallback(async () => {
    try { setList(await listPluginPresets(plugin)); } catch (e: any) { setStatus({ kind: 'error', text: `Presets illisibles : ${e?.message || e}` }); }
  }, [plugin.type, plugin.params?.localPath, plugin.params?.pluginName, plugin.params?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, [refresh]);

  const current = list.find(p => p.name === presetName && matchesPreset(plugin, p)) || list.find(p => p.name === presetName) || null;
  const idx = current ? list.indexOf(current) : -1;

  // Panneau ancré sous le bouton, gardé dans l'écran (au doigt comme à la souris).
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 16);
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: Math.min(r.bottom + 6, window.innerHeight - 120), width });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: Event) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    const t = window.setTimeout(() => { window.addEventListener('mousedown', down); window.addEventListener('touchstart', down); }, 30);
    window.addEventListener('keydown', key, true);
    return () => { window.clearTimeout(t); window.removeEventListener('mousedown', down); window.removeEventListener('touchstart', down); window.removeEventListener('keydown', key, true); };
  }, [open]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e: any) { setStatus({ kind: 'error', text: e?.message || String(e) }); } finally { setBusy(false); }
  };

  /** Réglages actuels, VST relu sur le pont (sa fenêtre a pu changer l'état). */
  const freshSettings = async (): Promise<Record<string, any>> => {
    if (isVst(plugin)) {
      const st = await liveVstNodes.get(plugin.id)?.syncState().catch(() => null);
      if (st) return { stateB64: st };
    }
    return settings;
  };

  const load = (p: PluginPreset) => act(async () => {
    const { patch } = applyPluginPreset(plugin, p);
    onApply({ ...patch, presetName: p.name });
    compareStates.set(plugin.id, compareInit(p.params, p.name));
    onReloaded?.();
    const slot = isVst(plugin) ? slotOfPlugin(plugin.id) : null;
    if (slot && p.params.stateB64) {
      const r = await applyVstStateVerified(slot, p.params.stateB64, p.readback);
      setStatus({ kind: r.ok ? 'ok' : 'error', text: `« ${p.name} » : ${r.message}` });
    } else if (isVst(plugin)) {
      setStatus({ kind: 'info', text: `« ${p.name} » chargé : il s'appliquera au plugin dès que le pont VST sera connecté.` });
    } else {
      setStatus({ kind: 'ok', text: `Preset « ${p.name} » chargé (Ctrl+Z pour revenir).` });
    }
    setTick(x => x + 1);
  });

  const save = (name: string, overwrite?: PluginPreset) => act(async () => {
    const clean = name.trim();
    if (!clean) throw new Error('Donne un nom au preset (par exemple « Voix rap · 2:1 »).');
    let src = plugin;
    let readback;
    if (isVst(plugin)) {
      const slot = slotOfPlugin(plugin.id);
      if (slot) {
        const r = await readVstSlot(slot);
        if (r.stateB64) src = { ...plugin, params: { ...plugin.params, stateB64: r.stateB64 } };
        readback = r.readback;
      } else if (!plugin.params?.stateB64) {
        throw new Error('Connecte le pont VST (appli Windows Nova Studio) pour lire le réglage de ce plugin.');
      }
    }
    const made = makePluginPreset(src, clean, { readback, ...(overwrite ? { id: overwrite.id } : {}) });
    const saved = await savePreset(overwrite ? { ...made, createdAt: overwrite.createdAt } : made);
    onApply({ presetName: saved.name, ...(isVst(plugin) && src.params.stateB64 !== plugin.params?.stateB64 ? { stateB64: src.params.stateB64 } : {}) });
    compareStates.set(plugin.id, compareInit(saved.params, saved.name));
    setSaveAs(null);
    await refresh();
    setStatus({ kind: 'ok', text: `✅ Preset « ${saved.name} » enregistré${readback?.length ? ` (${readback.length} paramètres relus)` : ''}.` });
  });

  const toggleCompare = () => act(async () => {
    const now = await freshSettings();
    const r = compareToggle(cs, now);
    if (!r) { setStatus({ kind: 'info', text: 'Rien à comparer : le réglage est celui du preset.' }); return; }
    compareStates.set(plugin.id, r.next);
    onApply(withSoundSettings(plugin, r.apply).patch);
    onReloaded?.();
    setStatus({ kind: 'info', text: r.next.stash ? `Tu écoutes « ${r.next.refLabel} ». Re-clique sur Comparer pour retrouver tes modifications.` : 'Tu écoutes tes modifications.' });
    setTick(x => x + 1);
  });

  const step = (d: 1 | -1) => { if (!list.length) return; const i = idx < 0 ? (d > 0 ? 0 : list.length - 1) : (idx + d + list.length) % list.length; void load(list[i]); };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    await act(async () => {
      const p = await importPresetText(await file.text());
      if (p.format !== 'novapreset') throw new Error('Ce fichier est un Track Preset (.novachain) : ouvre-le depuis le menu de la piste (Track Preset…).');
      await refresh();
      setStatus({ kind: 'ok', text: `📥 Preset « ${p.name} » importé.${(await listPluginPresets(plugin)).some(x => x.id === p.id) ? '' : ' (Il est fait pour un autre effet.)'}` });
    });
    if (fileRef.current) fileRef.current.value = '';
  };

  const exportCurrent = () => act(async () => {
    const p = current && matchesPreset(plugin, current) ? current : makePluginPreset(plugin, presetName || `${plugin.params?.name || plugin.name} · réglage`);
    const { blob, filename } = exportPresetFile(p);
    await saveBlob(blob, filename);
    setStatus({ kind: 'ok', text: `💾 ${filename} prêt.` });
  });

  const label = presetName || 'Presets';
  const chip = 'h-8 rounded-full px-3 text-[11px] font-bold transition-colors flex items-center gap-1.5 [@media(pointer:coarse)]:h-10';
  const row = 'w-full flex items-center gap-2 rounded-lg px-2 py-1.5 [@media(pointer:coarse)]:py-2.5 text-left text-[12px]';

  return (
    <div className="flex min-w-0 items-center gap-1" data-testid="preset-menu" onPointerDown={e => e.stopPropagation()}>
      {!simple && (
        <button type="button" onClick={() => step(-1)} disabled={!list.length || busy} aria-label="Preset précédent" title="Preset précédent (Pro Tools : flèche « - » du Librarian · FL : ‹)"
          className="h-8 w-7 rounded-full text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-30 [@media(pointer:coarse)]:h-10"><i className="fas fa-chevron-left text-[10px]" /></button>
      )}
      <button ref={btnRef} type="button" onClick={() => { setOpen(o => !o); setStatus(null); }} aria-haspopup="menu" aria-expanded={open} data-testid="preset-button"
        title="Presets de l'effet : enregistrer, charger, favoris, importer / exporter (Pro Tools : menu Librarian · Logic : menu Réglages · Ableton : Save Preset · FL : menu Presets)"
        className={`${chip} min-w-0 max-w-[200px] bg-white/[0.06] border border-white/10 text-slate-200 hover:bg-white/15`}>
        <i className={`fas ${current && isFavorite(current.id) ? 'fa-star text-amber-300' : 'fa-bookmark text-slate-400'} text-[10px]`} />
        <span className="truncate">{label}</span>
        {modified && !listening && <span className="shrink-0 text-amber-300" title="Modifié depuis le preset (Comparer pour réécouter le preset)" aria-label="modifié">•</span>}
        <i className="fas fa-caret-down text-[10px] text-slate-500" />
      </button>
      {!simple && (
        <button type="button" onClick={() => step(1)} disabled={!list.length || busy} aria-label="Preset suivant" title="Preset suivant (Pro Tools : flèche « + » du Librarian · FL : ›)"
          className="h-8 w-7 rounded-full text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-30 [@media(pointer:coarse)]:h-10"><i className="fas fa-chevron-right text-[10px]" /></button>
      )}
      {!simple && (
        <button type="button" onClick={() => void toggleCompare()} disabled={busy || (!modified && !listening)} aria-pressed={listening} data-testid="preset-compare"
          title={`Comparer (Pro Tools « Compare », Logic « Comparer », bascule A/B d'Ableton) : ${listening ? `tu écoutes « ${cs.refLabel} » ; clic pour retrouver tes modifications.` : modified ? `écoute « ${cs.refLabel} » sans perdre tes modifications.` : 'modifie un réglage pour pouvoir comparer.'}`}
          className={`${chip} shrink-0 border ${listening ? 'bg-amber-400 text-black border-amber-300' : modified ? 'border-amber-400/50 text-amber-300 hover:bg-amber-400/15' : 'border-white/10 text-slate-500'} disabled:opacity-40`}>
          <i className="fas fa-right-left text-[10px]" /><span className="hidden md:inline">Comparer</span>
        </button>
      )}

      {/* Hors de la fenêtre de l'effet (elle est déplaçable : un parent transformé décalait le panneau). */}
      {open && pos && createPortal(
        <div ref={panelRef} role="menu" data-testid="preset-panel" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
          className="fixed z-[950] max-h-[min(70vh,520px)] overflow-y-auto rounded-xl border border-nv-line bg-nv-raised p-2 text-nv-ink shadow-2xl"
          style={{ left: pos.left, top: pos.top, width: pos.width }}>
          <p className="px-1 pb-1 text-[10px] font-bold uppercase tracking-wide text-nv-muted truncate">Presets · {plugin.params?.name || plugin.name}</p>
          {status && (
            <p role={status.kind === 'error' ? 'alert' : 'status'} className={`mb-2 rounded-lg px-2 py-1.5 text-[11px] ${status.kind === 'error' ? 'bg-red-500/10 text-red-400' : status.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-nv-accent/10 text-nv-ink'}`}>{status.text}</p>
          )}

          {/* Enregistrer */}
          <div className="mb-2 flex flex-wrap gap-1">
            {!simple && current && !current.bundled && (
              <button type="button" disabled={busy} onClick={() => void save(current.name, current)} data-testid="preset-save"
                title={`Enregistre le réglage actuel dans « ${current.name} » (Pro Tools : Save Settings, Ctrl+S dans le Librarian)`}
                className="min-h-[34px] rounded-lg bg-cyan-500 px-3 text-[11px] font-bold text-black hover:bg-cyan-400 disabled:opacity-40">
                <i className="fas fa-floppy-disk mr-1" />Enregistrer
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => setSaveAs(s => (s === null ? (presetName && !current?.bundled ? `${presetName} 2` : '') : null))} data-testid="preset-save-as"
              title="Enregistre le réglage actuel comme nouveau preset (Pro Tools : Save Settings As… · Logic : Enregistrer le réglage sous…)"
              className="min-h-[34px] rounded-lg border border-nv-line px-3 text-[11px] font-bold hover:bg-nv-accent/10 disabled:opacity-40">
              <i className="fas fa-plus mr-1" />Enregistrer sous…
            </button>
          </div>
          {saveAs !== null && (
            <form className="mb-2 flex gap-1" onSubmit={e => { e.preventDefault(); void save(saveAs); }}>
              <input autoFocus value={saveAs} onChange={e => setSaveAs(e.target.value)} placeholder="Nom du preset (ex. Voix rap · 2:1)" aria-label="Nom du preset" data-testid="preset-name"
                className="min-w-0 flex-1 rounded-lg border border-nv-line bg-nv-well px-2 py-1.5 text-[12px] text-nv-ink outline-none focus:border-nv-accent" />
              <button type="submit" disabled={busy || !saveAs.trim()} className="rounded-lg bg-cyan-500 px-3 text-[11px] font-bold text-black hover:bg-cyan-400 disabled:opacity-40">OK</button>
            </form>
          )}

          {/* Liste */}
          {list.length === 0 ? (
            <p className="rounded-lg bg-nv-well px-2 py-3 text-[11px] text-nv-muted">Aucun preset pour cet effet. Règle-le à ton goût, puis « Enregistrer sous… » : tu le retrouveras ici sur toutes tes sessions.</p>
          ) : (
            <ul className="space-y-0.5" data-testid="preset-list">
              {list.map(p => {
                const fav = isFavorite(p.id);
                const isCur = current?.id === p.id;
                if (renaming?.id === p.id) return (
                  <li key={p.id}>
                    <form className="flex gap-1" onSubmit={e => { e.preventDefault(); void act(async () => { const n = await renamePreset(p.id, renaming.name); if (isCur) onApply({ presetName: n.name }); setRenaming(null); await refresh(); setStatus({ kind: 'ok', text: `Renommé en « ${n.name} ».` }); }); }}>
                      <input autoFocus value={renaming.name} onChange={e => setRenaming({ id: p.id, name: e.target.value })} aria-label="Nouveau nom"
                        className="min-w-0 flex-1 rounded-lg border border-nv-line bg-nv-well px-2 py-1 text-[12px] text-nv-ink outline-none focus:border-nv-accent" />
                      <button type="submit" className="rounded-lg bg-cyan-500 px-2 text-[11px] font-bold text-black">OK</button>
                      <button type="button" onClick={() => setRenaming(null)} className="rounded-lg px-2 text-[11px] text-nv-muted">Annuler</button>
                    </form>
                  </li>
                );
                return (
                  <li key={p.id} className={`group flex items-center gap-1 rounded-lg ${isCur ? 'bg-nv-accent/15' : 'hover:bg-nv-accent/10'}`}>
                    <button type="button" onClick={() => { setFavorite(p.id, !fav); setTick(x => x + 1); void refresh(); }} aria-pressed={fav}
                      aria-label={fav ? `Retirer « ${p.name} » des favoris` : `Mettre « ${p.name} » en favori`} title={fav ? 'Favori : en tête de liste (clic pour retirer)' : 'Mettre en favori : il passe en tête de liste'}
                      className="h-8 w-8 shrink-0 rounded-lg [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10"><i className={`${fav ? 'fas text-amber-400' : 'far text-nv-muted'} fa-star text-[11px]`} /></button>
                    <button type="button" role="menuitem" disabled={busy} onClick={() => void load(p)} className={`${row} min-w-0 flex-1 px-1`} title={`Charger « ${p.name} »${p.vst ? ' (état du plugin, relu pour vérifier)' : ''}`}>
                      <span className="flex-1 truncate font-semibold">{p.name}</span>
                      {p.bundled && <span className="shrink-0 rounded bg-nv-well px-1 text-[9px] font-bold text-nv-muted">NOVA</span>}
                      {isCur && <i className={`fas ${modified ? 'fa-pen text-amber-400' : 'fa-check text-emerald-500'} shrink-0 text-[10px]`} title={modified ? 'Chargé, puis modifié' : 'Réglage actuel'} />}
                    </button>
                    {!simple && !p.bundled && (
                      confirmDelete === p.id ? (
                        <span className="flex shrink-0 items-center gap-1 pr-1">
                          <button type="button" onClick={() => void act(async () => { await deletePreset(p.id); setConfirmDelete(null); await refresh(); setStatus({ kind: 'ok', text: `Preset « ${p.name} » supprimé.` }); })}
                            className="rounded-md bg-red-500 px-2 py-1 text-[10px] font-bold text-white">Supprimer</button>
                          <button type="button" onClick={() => setConfirmDelete(null)} className="rounded-md px-1 text-[10px] text-nv-muted">Non</button>
                        </span>
                      ) : (
                        <span className="flex shrink-0 opacity-60 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100">
                          <button type="button" onClick={() => setRenaming({ id: p.id, name: p.name })} aria-label={`Renommer « ${p.name} »`} title="Renommer"
                            className="h-8 w-7 rounded-lg text-nv-muted hover:text-nv-ink"><i className="fas fa-pen text-[10px]" /></button>
                          <button type="button" onClick={() => setConfirmDelete(p.id)} aria-label={`Supprimer « ${p.name} »`} title="Supprimer ce preset"
                            className="h-8 w-7 rounded-lg text-nv-muted hover:text-red-400"><i className="fas fa-trash text-[10px]" /></button>
                        </span>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {!simple && (
            <div className="mt-2 flex flex-wrap gap-1 border-t border-nv-line pt-2">
              <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} title={`Importer un fichier ${PRESET_EXT} (Pro Tools : Import Settings)`}
                className="min-h-[32px] rounded-lg px-2 text-[11px] font-semibold text-nv-muted hover:bg-nv-accent/10 hover:text-nv-ink"><i className="fas fa-file-import mr-1" />Importer…</button>
              <button type="button" disabled={busy} onClick={() => void exportCurrent()} title={`Exporter le réglage actuel en ${PRESET_EXT} (Pro Tools : Export Settings) : à envoyer, ou à ouvrir sur un autre poste`}
                className="min-h-[32px] rounded-lg px-2 text-[11px] font-semibold text-nv-muted hover:bg-nv-accent/10 hover:text-nv-ink"><i className="fas fa-file-export mr-1" />Exporter</button>
              <input ref={fileRef} type="file" accept={`${PRESET_EXT},application/json`} className="hidden" onChange={e => void onImport(e.target.files?.[0])} />
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
};

export default PresetMenu;
