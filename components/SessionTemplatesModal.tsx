/**
 * Modèles de session : liste (créer un projet, renommer, dupliquer, exporter,
 * supprimer, importer un .novatemplate) et « Enregistrer la session comme modèle ».
 * Ouvert depuis l'accueil (« Nouveau projet depuis un modèle ») et depuis les
 * fenêtres Sauvegarder / Ouvrir du studio. Les modèles « privé : romain » ne
 * s'affichent que pour les comptes autorisés (config/templateAccess.ts).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DAWState } from '../types';
import {
  accessGroupsOf, createTemplateFromState, instantiateTemplate, InstantiateOptions, MissingVstMode, SessionTemplate,
  templateBadge, templateInfo, TemplateLoadReport,
} from '../utils/sessionTemplate';
import {
  deleteTemplate, duplicateTemplate, exportTemplateFile, importTemplateText, listTemplates, renameTemplate, saveTemplate,
} from '../services/TemplateStore';
import { resolveAccountEmail } from '../services/templateAccount';
import { novaBridge } from '../services/NovaBridge';
import { saveBlob } from '../utils/saveBlob';
import { formatAgo } from '../utils/sessionStore';
import { privateLabel } from '../config/templateAccess';

export interface SessionTemplatesModalProps {
  initialMode?: 'browse' | 'save';
  onClose: () => void;
  /** Session à enregistrer comme modèle (studio seulement). */
  getState?: () => Promise<DAWState> | DAWState;
  /** Projet créé depuis un modèle. */
  onCreateProject?: (state: DAWState, report: TemplateLoadReport, tpl: SessionTemplate) => void;
  makeBuiltin?: InstantiateOptions['makeBuiltin'];
  /** Le studio est ouvert : le projet en cours sera remplacé. */
  inStudio?: boolean;
}

type Status = { kind: 'ok' | 'error' | 'info'; text: string } | null;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

const SessionTemplatesModal: React.FC<SessionTemplatesModalProps> = ({ initialMode = 'browse', onClose, getState, onCreateProject, makeBuiltin, inStudio }) => {
  const [mode, setMode] = useState<'browse' | 'save'>(getState ? initialMode : 'browse');
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  const [list, setList] = useState<SessionTemplate[] | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [missingMode, setMissingMode] = useState<MissingVstMode>('replace');
  const [enableAll, setEnableAll] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Formulaire « Enregistrer la session »
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [keepClips, setKeepClips] = useState(false);
  const [keepTempoKey, setKeepTempoKey] = useState(true);
  const groups = useMemo(() => accessGroupsOf(email), [email]);
  const [privateTo, setPrivateTo] = useState<string | null>(null);
  useEffect(() => { setPrivateTo(groups[0] || null); }, [groups]);

  const bridgeOn = novaBridge.isConnected();

  const refresh = useCallback(async (e: string | null) => {
    try { setList(await listTemplates(e)); } catch (err: any) { setList([]); setStatus({ kind: 'error', text: `Les modèles n'ont pas pu être lus : ${err?.message || err}` }); }
  }, []);

  useEffect(() => {
    let alive = true;
    resolveAccountEmail().then(e => { if (!alive) return; setEmail(e); void refresh(e); }).catch(() => { if (alive) { setEmail(null); void refresh(null); } });
    return () => { alive = false; };
  }, [refresh]);

  useEffect(() => {
    if (mode !== 'save' || !getState) return;
    Promise.resolve(getState()).then(s => setName(n => n || `${(s.name || 'Session').replace(/_/g, ' ')} (modèle)`)).catch(() => {});
  }, [mode, getState]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setStatus(null);
    try { await fn(); } catch (err: any) { setStatus({ kind: 'error', text: err?.message || String(err) }); } finally { setBusy(false); }
  };

  const create = (t: SessionTemplate) => act(async () => {
    let plugins = null as Awaited<ReturnType<typeof novaBridge.listPlugins>> | null;
    if (novaBridge.isConnected()) {
      plugins = novaBridge.getCachedPlugins();
      if (!plugins.length) plugins = await novaBridge.listPlugins().catch(() => novaBridge.getCachedPlugins());
    }
    const { state, report } = instantiateTemplate(t, {
      plugins: plugins ? plugins.map(p => ({ name: p.name, vendor: p.vendor, path: p.path, pluginName: p.pluginName ?? null, isInstrument: p.isInstrument ?? null })) : null,
      missingVst: missingMode, enableAll, makeBuiltin,
    });
    onCreateProject?.(state, report, t);
    onClose();
  });

  const doSave = () => act(async () => {
    if (!getState) return;
    const clean = name.trim();
    if (!clean) throw new Error('Donne un nom au modèle (par exemple « Voix rap · 2 étages »).');
    const s = await getState();
    const tpl = createTemplateFromState(s, { name: clean, description: description.trim() || undefined, keepClips, keepTempoKey, privateTo: privateTo || undefined });
    const saved = await saveTemplate(tpl);
    await refresh(email ?? null);
    setMode('browse');
    setOpenId(saved.id);
    const info = templateInfo(saved);
    setStatus({ kind: 'ok', text: `✅ Modèle « ${saved.name} » enregistré : ${plural(info.tracks, 'piste')}, ${plural(info.buses + info.sends, 'bus / retour', 'bus / retours')}, ${plural(info.plugins, 'effet')}${keepClips ? ', avec les clips' : ', sans audio'}.` });
  });

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    await act(async () => {
      const t = await importTemplateText(await file.text(), email ?? null);
      await refresh(email ?? null);
      setOpenId(t.id);
      setStatus({ kind: 'ok', text: `📥 Modèle « ${t.name} » importé.` });
    });
    if (fileRef.current) fileRef.current.value = '';
  };

  const btn = 'min-h-[40px] px-3 rounded-lg text-[12px] font-bold transition-colors disabled:opacity-40';
  const ghost = `${btn} bg-white/[0.04] border border-white/10 text-slate-300 hover:bg-white/10 hover:text-white`;
  const primary = `${btn} bg-cyan-500 text-black hover:bg-cyan-400`;

  return (
    <div className="fixed inset-0 z-[1200] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm sm:p-4" role="dialog" aria-modal="true" aria-labelledby="tpl-title" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full sm:max-w-2xl max-h-[92dvh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-white/10 bg-[#121418] text-white shadow-2xl" data-testid="templates-modal">
        <header className="flex items-start gap-3 px-4 sm:px-5 pt-4 pb-3 border-b border-white/5">
          <div className="w-10 h-10 shrink-0 rounded-xl bg-cyan-500/15 flex items-center justify-center"><i className="fas fa-layer-group text-cyan-300" aria-hidden="true"></i></div>
          <div className="min-w-0 flex-1">
            <h2 id="tpl-title" className="text-[15px] font-black">Modèles de session</h2>
            <p className="text-[11px] text-slate-400" data-testid="tpl-account">
              {email === undefined ? 'Vérification du compte…' : email ? <>Connecté : <span className="text-slate-200">{email}</span>{groups.length ? <> · tu vois aussi les modèles {groups.map(privateLabel).join(', ')}</> : null}</> : 'Invité : les modèles privés ne s’affichent pas. Connecte-toi pour les voir.'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" className="w-10 h-10 shrink-0 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white">✕</button>
        </header>

        {getState && (
          <div className="flex gap-2 px-4 sm:px-5 pt-3" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'browse'} onClick={() => setMode('browse')} className={`${btn} ${mode === 'browse' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}>Mes modèles</button>
            <button type="button" role="tab" aria-selected={mode === 'save'} onClick={() => setMode('save')} className={`${btn} ${mode === 'save' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`} data-testid="tpl-tab-save">Enregistrer la session comme modèle</button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-3 space-y-3">
          {status && (
            <div role="status" aria-live="polite" className={`rounded-xl border px-3 py-2 text-[12px] ${status.kind === 'error' ? 'border-red-400/40 bg-red-500/10 text-red-100' : status.kind === 'ok' ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100' : 'border-white/10 bg-white/5 text-slate-200'}`}>{status.text}</div>
          )}

          {mode === 'save' && getState ? (
            <form className="space-y-3" onSubmit={e => { e.preventDefault(); void doSave(); }}>
              <p className="text-[12px] text-slate-400">Le modèle garde tes pistes (noms, couleurs, ordre), les bus et les envois, les sorties, chaque effet avec ses réglages (VST compris), le master. Jamais tes prises audio.</p>
              <label className="block">
                <span className="text-[11px] font-bold text-slate-300">Nom du modèle</span>
                <input value={name} onChange={e => setName(e.target.value)} maxLength={80} required autoFocus className="mt-1 w-full h-11 rounded-lg bg-black/40 border border-white/10 px-3 text-[14px] focus:border-cyan-400 outline-none" data-testid="tpl-name" />
              </label>
              <label className="block">
                <span className="text-[11px] font-bold text-slate-300">Description (facultatif)</span>
                <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} maxLength={400} placeholder="Pour quoi tu l'utilises : rap, chant, 2 étages de compression…" className="mt-1 w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2 text-[13px] focus:border-cyan-400 outline-none" />
              </label>
              <label className="flex items-start gap-3 min-h-[40px]">
                <input type="checkbox" checked={keepTempoKey} onChange={e => setKeepTempoKey(e.target.checked)} className="mt-1 w-5 h-5 accent-cyan-400" />
                <span className="text-[13px]">Garder le tempo, la mesure et la tonalité<span className="block text-[11px] text-slate-500">Sinon le projet créé garde ses réglages par défaut.</span></span>
              </label>
              <label className="flex items-start gap-3 min-h-[40px]">
                <input type="checkbox" checked={keepClips} onChange={e => setKeepClips(e.target.checked)} className="mt-1 w-5 h-5 accent-cyan-400" />
                <span className="text-[13px]">Garder les clips<span className="block text-[11px] text-slate-500">Clips MIDI, repères et sons en ligne seulement : tes prises audio ne vont jamais dans un modèle.</span></span>
              </label>
              {groups.length > 0 && (
                <label className="flex items-start gap-3 min-h-[40px]">
                  <input type="checkbox" checked={!!privateTo} onChange={e => setPrivateTo(e.target.checked ? groups[0] : null)} className="mt-1 w-5 h-5 accent-amber-400" data-testid="tpl-private" />
                  <span className="text-[13px]">Modèle {privateLabel(groups[0])}<span className="block text-[11px] text-slate-500">Visible et chargeable seulement quand ton compte est connecté.</span></span>
                </label>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <button type="submit" disabled={busy} className={primary} data-testid="tpl-save">{busy ? 'Enregistrement…' : 'Enregistrer le modèle'}</button>
                <button type="button" onClick={() => setMode('browse')} className={ghost}>Annuler</button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => fileRef.current?.click()} className={ghost} disabled={busy}><i className="fas fa-file-import mr-2" aria-hidden="true"></i>Importer un fichier .novatemplate</button>
                <input ref={fileRef} type="file" accept=".novatemplate,application/json" className="hidden" onChange={e => void onImport(e.target.files?.[0])} aria-label="Fichier de modèle à importer" />
                <span className="text-[11px] text-slate-500">{bridgeOn ? '🟢 Pont VST connecté : tes plugins seront vérifiés.' : '⚪ Pont VST absent : les effets VST se chargeront quand il sera connecté (appli Windows).'}</span>
              </div>

              {list === null ? (
                <p className="text-[13px] text-slate-400 py-6 text-center">Chargement des modèles…</p>
              ) : list.length === 0 ? (
                <div className="rounded-xl border border-dashed border-white/10 p-5 text-center" data-testid="tpl-empty">
                  <p className="text-[14px] font-bold">Aucun modèle pour l'instant</p>
                  <p className="text-[12px] text-slate-400 mt-1">{getState ? 'Règle une session comme tu aimes, puis « Enregistrer la session comme modèle » : pistes, bus, envois et effets seront prêts pour tes prochains projets.' : 'Ouvre le studio, règle ta session, puis Sauvegarder › « Enregistrer comme modèle ». Tu peux aussi importer un fichier .novatemplate.'}</p>
                </div>
              ) : (
                <ul className="space-y-2" data-testid="tpl-list">
                  {list.map(t => {
                    const info = templateInfo(t);
                    const badge = templateBadge(t);
                    const open = openId === t.id;
                    return (
                      <li key={t.id} className={`rounded-xl border ${open ? 'border-cyan-400/50 bg-cyan-500/[0.06]' : 'border-white/10 bg-white/[0.02]'} p-3`} data-testid="tpl-item" data-template-id={t.id}>
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            {renaming?.id === t.id ? (
                              <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void act(async () => { await renameTemplate(t.id, renaming.name, email ?? null); setRenaming(null); await refresh(email ?? null); }); }}>
                                <input value={renaming.name} onChange={e => setRenaming({ id: t.id, name: e.target.value })} autoFocus maxLength={80} aria-label="Nouveau nom" className="flex-1 min-w-0 h-10 rounded-lg bg-black/40 border border-white/10 px-3 text-[13px]" />
                                <button type="submit" className={primary}>OK</button>
                                <button type="button" onClick={() => setRenaming(null)} className={ghost}>Annuler</button>
                              </form>
                            ) : (
                              <p className="text-[14px] font-bold break-words">{t.name}</p>
                            )}
                            <div className="flex flex-wrap gap-1.5 mt-1">
                              {badge && <span className="rounded-full bg-amber-400/15 border border-amber-400/40 px-2 py-0.5 text-[10px] font-black text-amber-200" data-testid="tpl-private-badge">🔒 {badge}</span>}
                              {t.bundled && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold text-slate-300">Livré avec NOVA</span>}
                              {t.source?.kind === 'spec' && <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-bold text-violet-200">Depuis une fiche</span>}
                            </div>
                            <p className="text-[11px] text-slate-400 mt-1">
                              {plural(info.tracks, 'piste')} · {plural(info.buses, 'bus', 'bus')} · {plural(info.sends, 'retour')} · {plural(info.plugins, 'effet')}{info.vst ? ` (${info.vst} VST)` : ''}{info.inactive ? ` · ${plural(info.inactive, 'effet inactif', 'effets inactifs')}` : ''}
                              {t.session.bpm ? ` · ${t.session.bpm} BPM` : ''}{!t.bundled ? ` · ${formatAgo(t.updatedAt)}` : ''}
                            </p>
                            {t.description && <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">{t.description}</p>}
                          </div>
                        </div>

                        {open ? (
                          <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
                            <fieldset className="space-y-1">
                              <legend className="text-[11px] font-bold text-slate-300 mb-1">Si un plugin VST manque sur ce PC</legend>
                              <label className="flex items-center gap-3 min-h-[36px] text-[13px]"><input type="radio" name={`miss-${t.id}`} checked={missingMode === 'replace'} onChange={() => setMissingMode('replace')} className="w-5 h-5 accent-cyan-400" />Le remplacer par l'effet NOVA équivalent</label>
                              <label className="flex items-center gap-3 min-h-[36px] text-[13px]"><input type="radio" name={`miss-${t.id}`} checked={missingMode === 'disable'} onChange={() => setMissingMode('disable')} className="w-5 h-5 accent-cyan-400" />Le laisser dans la chaîne, inactif</label>
                            </fieldset>
                            <label className="flex items-start gap-3 min-h-[36px] text-[13px]">
                              <input type="checkbox" checked={enableAll} onChange={e => setEnableAll(e.target.checked)} className="mt-0.5 w-5 h-5 accent-cyan-400" data-testid="tpl-enable-all" />
                              <span>Activer tous les effets{info.inactive ? ` (${plural(info.inactive, 'effet désactivé', 'effets désactivés')} dans le modèle)` : ''}<span className="block text-[11px] text-slate-500">Pour les effets coupés dans la session d'origine mais qui servent au mix.</span></span>
                            </label>
                            {inStudio && <p className="text-[11px] text-amber-200">Ton projet en cours sera remplacé : sauvegarde-le avant si tu veux le garder.</p>}
                            <div className="flex flex-wrap gap-2">
                              <button type="button" disabled={busy} onClick={() => void create(t)} className={primary} data-testid="tpl-create">{busy ? 'Création…' : 'Créer le projet'}</button>
                              <button type="button" onClick={() => setOpenId(null)} className={ghost}>Fermer</button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button type="button" onClick={() => { setOpenId(t.id); setConfirmDelete(null); }} className={primary} data-testid="tpl-use">Utiliser ce modèle</button>
                            {!t.bundled && <button type="button" onClick={() => setRenaming({ id: t.id, name: t.name })} className={ghost}>Renommer</button>}
                            <button type="button" disabled={busy} onClick={() => void act(async () => { const c = await duplicateTemplate(t.id, email ?? null); await refresh(email ?? null); setStatus({ kind: 'ok', text: `Copie créée : « ${c.name} ».` }); })} className={ghost}>Dupliquer</button>
                            <button type="button" onClick={() => { const { blob, filename } = exportTemplateFile(t); void saveBlob(blob, filename); setStatus({ kind: 'info', text: `📤 ${filename} exporté.${t.privateTo ? ` Il reste ${privateLabel(t.privateTo)} une fois importé ailleurs.` : ''}` }); }} className={ghost}>Exporter</button>
                            {!t.bundled && (confirmDelete === t.id ? (
                              <>
                                <button type="button" disabled={busy} onClick={() => void act(async () => { await deleteTemplate(t.id, email ?? null); setConfirmDelete(null); await refresh(email ?? null); setStatus({ kind: 'info', text: `Modèle « ${t.name} » supprimé.` }); })} className={`${btn} bg-red-500 text-white hover:bg-red-400`}>Oui, supprimer</button>
                                <button type="button" onClick={() => setConfirmDelete(null)} className={ghost}>Non</button>
                              </>
                            ) : <button type="button" onClick={() => setConfirmDelete(t.id)} className={`${ghost} hover:text-red-300`}>Supprimer</button>)}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SessionTemplatesModal;
