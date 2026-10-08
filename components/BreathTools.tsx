import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { BreathEdit, Clip, DAWState, Track } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { BREATH_EVENT, BreathRequest, requestBreaths } from '../utils/breathBus';
import { breathGainAt, BREATH_REMOVE_DB } from '../utils/breathEnvelope';
import {
  applyBreathPlan, BREATH_KIND_LABELS, BREATH_SENSITIVITIES, breathDoseLabel, breathEditsFor, breathGainFor, BreathKind, BreathPrefs, BreathRegion,
  BreathSettings, BreathTrackPlan, breathTotal, canTreatBreaths, DEFAULT_BREATH_SETTINGS, detectClipBreaths, guessBreathKind, loadBreathPrefs,
  planBreaths, saveBreathPrefs, summarizeBreathPlan,
} from '../utils/breaths';
import { isVoiceTrack } from '../utils/vocalRoles';
import { isTrackFrozen } from '../utils/freeze';

/**
 * Respirations (comme Breath Control de Waves / De-breath de RX) :
 *  - BreathHost : écoute les demandes (utils/breathBus), ouvre la fenêtre,
 *    traite en un clic (une seule étape d'annulation) et affiche le
 *    récapitulatif avec « Annuler » ;
 *  - BreathPanelTools / BreathMixOption : le bloc du panneau voix (Mix auto).
 * La logique est dans utils/breaths (détection, plan, application).
 */

// ------------------------------------------------------------------ préférences partagées

let prefs: BreathPrefs = loadBreathPrefs();
const listeners = new Set<() => void>();
export const getBreathPrefs = () => prefs;
export function setBreathPrefs(patch: Partial<Omit<BreathPrefs, 'settings'>> & { settings?: Partial<BreathSettings> }) {
  prefs = { ...prefs, ...patch, settings: { ...prefs.settings, ...(patch.settings || {}) } };
  saveBreathPrefs(prefs);
  listeners.forEach(l => l());
}
export const useBreathPrefs = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, getBreathPrefs, getBreathPrefs);

const bufferOf = (c: Clip) => (c.bufferId ? audioBufferRegistry.get(c.bufferId) : undefined) || c.buffer;
const voicesOf = (tracks: Track[]) => tracks.filter(t => isVoiceTrack(t) && t.clips.some(canTreatBreaths));
const yieldUi = () => new Promise<void>(r => setTimeout(r, 0));

/** Détection de tous les clips visés, sans bloquer l'interface (un clip à la fois). */
async function detectAll(tracks: Track[], settings: BreathSettings, trackIds: string[], clipIds: string[] | undefined, onProgress?: (done: number, total: number) => void) {
  const jobs: Clip[] = [];
  for (const t of tracks) if (trackIds.includes(t.id)) for (const c of t.clips) {
    if (clipIds ? clipIds.includes(c.id) : !c.isMuted) if (canTreatBreaths(c)) jobs.push(c);
  }
  for (let i = 0; i < jobs.length; i++) {
    onProgress?.(i, jobs.length);
    const b = bufferOf(jobs[i]);
    if (b) detectClipBreaths(jobs[i], b, settings.sensitivity);
    await yieldUi();
  }
  onProgress?.(jobs.length, jobs.length);
}

const dbLabel = (db: number) => `${Math.round(db)} dB`.replace('-', '−');

// ------------------------------------------------------------------ hôte

interface HostProps {
  tracks: Track[];
  setState: (fn: (prev: DAWState) => DAWState) => void;
  undo: () => void;
  breakHistory: () => void;
  /** Réglage « auto après chaque prise » du projet (absent : préférence de l'appareil). */
  projectAuto?: boolean;
  isMobile?: boolean;
  /**
   * Pistes gelées traitées : le rendu contient l'ancienne version. L'hôte les
   * regèle si c'est sûr (pas de VST, ou pont connecté) ; « blocked » = à
   * dégeler pour entendre le traitement (VST sans le pont).
   */
  onFrozenTreated?: (trackIds: string[]) => Promise<{ refrozen: string[]; blocked: string[] }>;
  onUnfreeze?: (trackId: string) => void;
}

interface Toast { id: number; text: string; canUndo: boolean; busy?: boolean; action?: { label: string; run: () => void } }

export const BreathHost: React.FC<HostProps> = ({ tracks, setState, undo, breakHistory, projectAuto, isMobile, onFrozenTreated, onUnfreeze }) => {
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const autoRef = useRef(projectAuto);
  autoRef.current = projectAuto;
  const [dialog, setDialog] = useState<BreathRequest | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((text: string, canUndo: boolean, busy = false, action?: Toast['action']) => {
    window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, canUndo, busy, action });
    if (!busy) toastTimer.current = window.setTimeout(() => setToast(null), action ? 16000 : canUndo ? 10000 : 5000);
  }, []);

  /**
   * Pistes gelées : le rendu contient encore l'ancienne version. Regel
   * automatique quand c'est sûr ; sinon, un bouton pour dégeler.
   */
  const frozenRef = useRef(onFrozenTreated);
  frozenRef.current = onFrozenTreated;
  const unfreezeRef = useRef(onUnfreeze);
  unfreezeRef.current = onUnfreeze;
  const afterFrozen = useCallback(async (trackIds: string[], text: string) => {
    const nameOf = (id: string) => tracksRef.current.find(t => t.id === id)?.name || 'piste';
    const frozen = trackIds.filter(id => { const t = tracksRef.current.find(x => x.id === id); return !!t && isTrackFrozen(t); });
    const run = frozenRef.current;
    if (!frozen.length || !run) return;
    const names = (ids: string[]) => ids.map(id => `« ${nameOf(id)} »`).join(', ');
    showToast(`${text} · ❄️ ${names(frozen)} ${frozen.length > 1 ? 'sont gelées' : 'est gelée'} : je ${frozen.length > 1 ? 'les' : 'la'} regèle pour que tu entendes le traitement…`, true, true);
    let res: { refrozen: string[]; blocked: string[] };
    try { res = await run(frozen); } catch { res = { refrozen: [], blocked: [] }; }
    const parts = [text];
    if (res.refrozen.length) parts.push(`❄️ ${names(res.refrozen)} ${res.refrozen.length > 1 ? 'regelées' : 'regelée'} : tu entends le traitement.`);
    if (res.blocked.length) {
      parts.push(`❄️ Piste gelée ${names(res.blocked)} : dégèle-la pour entendre le traitement.`);
      const id = res.blocked[0];
      showToast(parts.join(' · '), true, false, unfreezeRef.current ? { label: 'Dégeler', run: () => unfreezeRef.current?.(id) } : undefined);
      return;
    }
    showToast(parts.join(' · '), true);
  }, [showToast]);

  /** Pistes visées par une demande (voix seulement ; aucune → toutes les voix). */
  const targetTracks = useCallback((r: BreathRequest): string[] => {
    const all = tracksRef.current;
    const voices = voicesOf(all);
    let ids = r.trackIds?.filter(id => voices.some(v => v.id === id)) || [];
    if (r.clipIds?.length) ids = Array.from(new Set([...ids, ...voices.filter(t => t.clips.some(c => r.clipIds!.includes(c.id))).map(t => t.id)]));
    if (!ids.length) ids = voices.map(t => t.id);
    if (r.only) ids = ids.filter(id => guessBreathKind(all.find(t => t.id === id)!) === r.only);
    return ids;
  }, []);

  const applyNow = useCallback(async (r: BreathRequest) => {
    const p = getBreathPrefs();
    const ids = targetTracks(r);
    if (!ids.length) { if (r.mode !== 'auto' && r.reason !== 'mix') showToast(r.only === 'extra' ? 'Aucune piste de backs / doubles / ad-libs à traiter.' : 'Aucune piste voix à traiter (enregistre d’abord une prise).', false); return; }
    let settings = p.settings;
    if (r.remove) settings = { ...settings, leadRemove: r.only !== 'extra' ? true : settings.leadRemove, extraRemove: true };
    // Après un style de Mix auto, pas de « Je cherche… » : la notification de la prise (ou du style) reste visible.
    const quiet = r.reason === 'mix';
    if (!quiet) showToast('🌬️ Je cherche les respirations…', false, true);
    await detectAll(tracksRef.current, settings, ids, r.clipIds);
    const plans = planBreaths(tracksRef.current, bufferOf, settings, { trackIds: ids, clipIds: r.clipIds });
    const total = breathTotal(plans);
    if (!total) {
      if (r.mode === 'auto') setToast(null);
      else if (!quiet) showToast('🌬️ Aucune respiration nette trouvée (essaie la sensibilité « forte » dans Respirations…).', false);
      return;
    }
    // Déjà traité exactement ainsi (Mix auto juste après le traitement de fin de prise) : rien à refaire.
    const cur = tracksRef.current;
    if (applyBreathPlan(cur, plans).every((t, i) => t === cur[i])) {
      if (r.mode === 'auto') setToast(null);
      else if (!quiet) showToast(`🌬️ ${summarizeBreathPlan(plans.filter(pl => pl.count > 0))} (déjà fait)`, false);
      return;
    }
    // Fin de prise : étape d'annulation à part (Annuler retire le traitement, pas la prise).
    if (r.mode === 'auto' || r.reason === 'mix') breakHistory();
    setState(prev => ({ ...prev, tracks: applyBreathPlan(prev.tracks, plans) }));
    const text = `🌬️ ${summarizeBreathPlan(plans.filter(pl => pl.count > 0))}`;
    showToast(text, true);
    void afterFrozen(plans.filter(pl => pl.clips.length).map(pl => pl.trackId), text);
  }, [afterFrozen, breakHistory, setState, showToast, targetTracks]);

  useEffect(() => {
    const on = (e: Event) => {
      const r = (e as CustomEvent<BreathRequest>).detail;
      if (!r) return;
      if (r.mode === 'dialog') { setDialog(r); return; }
      if (r.mode === 'auto') {
        const on = autoRef.current ?? getBreathPrefs().auto;
        if (!on) return;
      }
      void applyNow(r);
    };
    window.addEventListener(BREATH_EVENT, on);
    return () => window.removeEventListener(BREATH_EVENT, on);
  }, [applyNow]);

  const applyDialog = useCallback((plans: BreathTrackPlan[], kinds: Record<string, BreathKind>) => {
    setState(prev => {
      let next = applyBreathPlan(prev.tracks, plans);
      // Type choisi à la main différent de la devinette : retenu sur la piste.
      next = next.map(t => {
        const k = kinds[t.id];
        if (!k) return t;
        const guessed = guessBreathKind({ ...t, breathKind: undefined });
        if (k === guessed && !t.breathKind) return t;
        return k === guessed ? { ...t, breathKind: undefined } : { ...t, breathKind: k };
      });
      return { ...prev, tracks: next };
    });
    const touched = plans.filter(pl => pl.count > 0 || pl.kind === 'skip');
    const text = `🌬️ ${summarizeBreathPlan(touched.length ? touched : plans)}`;
    showToast(text, true);
    setDialog(null);
    void afterFrozen(plans.filter(pl => pl.clips.length).map(pl => pl.trackId), text);
  }, [afterFrozen, setState, showToast]);

  return (
    <>
      {dialog && (
        <BreathDialog request={dialog} tracks={tracks} targetIds={targetTracks(dialog)} isMobile={!!isMobile && window.innerWidth < 700 || window.innerWidth < 600}
          onApply={applyDialog} onClose={() => setDialog(null)} />
      )}
      {toast && (
        <div role="status" aria-live="polite" data-testid="breath-toast"
          className="fixed bottom-24 left-1/2 z-[720] flex w-[92vw] sm:w-auto sm:max-w-[640px] -translate-x-1/2 items-center gap-3 rounded-2xl border border-violet-400/40 bg-[#17131f]/95 px-4 py-3 text-[12.5px] text-violet-50 shadow-2xl">
          {toast.busy && <i className="fas fa-circle-notch fa-spin text-violet-300" aria-hidden />}
          <span className="min-w-0 leading-snug">{toast.text}</span>
          {toast.action && (
            <button type="button" onClick={() => { toast.action!.run(); setToast(null); }} data-testid="breath-toast-action"
              className="shrink-0 rounded-lg bg-cyan-500/20 px-3 py-2 text-[12px] font-black text-cyan-200 hover:bg-cyan-500/30">{toast.action.label}</button>
          )}
          {toast.canUndo && (
            <button type="button" onClick={() => { undo(); setToast(null); }} data-testid="breath-undo"
              className="shrink-0 rounded-lg bg-violet-500/20 px-3 py-2 text-[12px] font-black text-violet-200 hover:bg-violet-500/30">Annuler</button>
          )}
          {!toast.busy && <button type="button" aria-label="Fermer" onClick={() => setToast(null)} className="shrink-0 h-8 w-8 rounded-lg text-violet-300/70 hover:text-white">✕</button>}
        </div>
      )}
    </>
  );
};

// ------------------------------------------------------------------ fenêtre

interface DialogProps {
  request: BreathRequest;
  tracks: Track[];
  targetIds: string[];
  isMobile: boolean;
  onApply: (plans: BreathTrackPlan[], kinds: Record<string, BreathKind>) => void;
  onClose: () => void;
}

type Span = { start: number; end: number };

let audioCtx: AudioContext | null = null;
const getCtx = () => {
  if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  return audioCtx;
};

const BreathDialog: React.FC<DialogProps> = ({ request, tracks, targetIds, isMobile, onApply, onClose }) => {
  const p = useBreathPrefs();
  const s = p.settings;
  const setS = (patch: Partial<BreathSettings>) => setBreathPrefs({ settings: patch });
  const targets = useMemo(() => tracks.filter(t => targetIds.includes(t.id)), [tracks, targetIds]);
  const [kinds, setKinds] = useState<Record<string, BreathKind>>(() => Object.fromEntries(targets.map(t => [t.id, guessBreathKind(t)])));
  const [excluded, setExcluded] = useState<Record<string, Span[]>>({});
  const [added, setAdded] = useState<Record<string, Span[]>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>({ done: 0, total: 1 });
  const [ready, setReady] = useState(0);

  // Analyse (asynchrone, en cache) à l'ouverture et à chaque changement de sensibilité.
  useEffect(() => {
    let alive = true;
    setProgress({ done: 0, total: 1 });
    void detectAll(tracks, s, targetIds, request.clipIds, (done, total) => alive && setProgress({ done, total })).then(() => {
      if (!alive) return;
      setProgress(null);
      setReady(n => n + 1);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.sensitivity, targetIds.join(','), (request.clipIds || []).join(',')]);

  const plans = useMemo(() => (progress ? [] : planBreaths(tracks, bufferOf, s, { trackIds: targetIds, clipIds: request.clipIds, kinds, excluded, added })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, progress, tracks, s, kinds, excluded, added, targetIds.join(',')]);
  const total = breathTotal(plans);

  // Clip montré dans l'aperçu.
  const clipChoices = useMemo(() => plans.flatMap(pl => pl.clips.map(c => ({ trackId: pl.trackId, plan: c, kind: pl.kind, gainDb: pl.gainDb, track: tracks.find(t => t.id === pl.trackId)!, clip: tracks.find(t => t.id === pl.trackId)!.clips.find(x => x.id === c.clipId)! }))).filter(c => c.clip), [plans, tracks]);
  const [pick, setPick] = useState(0);
  const cur = clipChoices[Math.min(pick, Math.max(0, clipChoices.length - 1))];

  const doseFor = (k: BreathKind) => breathDoseLabel(breathGainFor(k, s));
  const kindSelect = (t: Track) => (
    <select value={kinds[t.id] || 'lead'} aria-label={`Type de voix de ${t.name}`} onChange={e => setKinds(prev => ({ ...prev, [t.id]: e.target.value as BreathKind }))}
      className="h-10 rounded-lg border border-white/10 bg-black/40 px-2 text-[12px] font-bold text-white">
      {(['lead', 'extra', 'skip'] as BreathKind[]).map(k => <option key={k} value={k}>{BREATH_KIND_LABELS[k]}</option>)}
    </select>
  );

  const header = (
    <div className="mb-3 flex items-start gap-3">
      <div className="mr-auto min-w-0">
        <h2 id="breath-title" className="text-[16px] font-black text-white" title="Comme Breath Control de Waves ou De-breath d’iZotope RX"><i className="fas fa-wind mr-2 text-violet-300" aria-hidden />Respirations</h2>
        <p className="mt-0.5 text-[11.5px] text-slate-400">Voix principale : baissées. Backs, doubles, ad-libs : supprimées. Rien n’est effacé, Ctrl+Z revient en arrière.</p>
      </div>
      <button type="button" onClick={onClose} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-lg bg-white/5 text-slate-300">✕</button>
    </div>
  );

  const doses = (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
        <div className="flex items-center justify-between text-[12px] font-bold text-slate-200">
          <span>Voix principale (lead)</span>
          <span className="font-mono text-violet-300" data-testid="breath-lead-dose">{s.leadRemove ? 'supprimées' : dbLabel(-s.leadDb)}</span>
        </div>
        <input type="range" min={0} max={40} step={1} value={s.leadDb} disabled={s.leadRemove} aria-label="Baisse des respirations de la voix principale (dB)"
          title="Baisse des respirations de la lead : 15 dB par défaut, comme le réglage « Reduction » de Breath Control"
          onChange={e => setS({ leadDb: Number(e.target.value) })} className="mt-2 w-full accent-violet-500 disabled:opacity-40" />
        <label className="mt-1 flex min-h-10 items-center gap-2 text-[12px] text-slate-300">
          <input type="checkbox" checked={s.leadRemove} onChange={e => setS({ leadRemove: e.target.checked })} className="h-4 w-4 accent-violet-500" /> Supprimer (au lieu de baisser)
        </label>
      </div>
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
        <div className="flex items-center justify-between text-[12px] font-bold text-slate-200">
          <span>Voix additionnelles</span>
          <span className="font-mono text-violet-300">{s.extraRemove ? 'supprimées' : dbLabel(-s.extraDb)}</span>
        </div>
        <input type="range" min={0} max={40} step={1} value={s.extraDb} disabled={s.extraRemove} aria-label="Baisse des respirations des voix additionnelles (dB)"
          onChange={e => setS({ extraDb: Number(e.target.value) })} className="mt-2 w-full accent-violet-500 disabled:opacity-40" />
        <label className="mt-1 flex min-h-10 items-center gap-2 text-[12px] text-slate-300">
          <input type="checkbox" checked={s.extraRemove} onChange={e => setS({ extraRemove: e.target.checked })} className="h-4 w-4 accent-violet-500" /> Supprimer (conseillé sur les backs)
        </label>
      </div>
    </div>
  );

  const sensitivity = (
    <div className="mt-3 flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Sensibilité">
      <span className="text-[12px] font-bold text-slate-300">Sensibilité</span>
      {BREATH_SENSITIVITIES.map(o => (
        <button key={o.id} type="button" role="radio" aria-checked={s.sensitivity === o.id} title={o.hint} onClick={() => setS({ sensitivity: o.id })}
          className={`h-10 rounded-lg px-3 text-[12px] font-bold ${s.sensitivity === o.id ? 'bg-violet-500 text-white' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>{o.label}</button>
      ))}
      {!isMobile && (
        <label className="ml-auto flex items-center gap-2 text-[11.5px] text-slate-400" title="Fondus d’entrée et de sortie de chaque respiration, dans la zone : jamais de clic, jamais sur le mot">
          Fondus <input type="range" min={5} max={15} step={1} value={s.fadeMs} onChange={e => setS({ fadeMs: Number(e.target.value) })} className="w-20 accent-violet-500" aria-label="Durée des fondus (ms)" />
          <span className="w-10 font-mono text-violet-300">{s.fadeMs} ms</span>
        </label>
      )}
    </div>
  );

  const status = (
    <div className="mt-3 rounded-lg bg-black/30 px-3 py-2 text-[12px] text-slate-300" role="status" data-testid="breath-summary">
      {progress ? <span><i className="fas fa-circle-notch fa-spin mr-2 text-violet-300" />Je cherche les respirations… {progress.total > 1 ? `${progress.done}/${progress.total}` : ''}</span>
        : targets.length === 0 ? 'Aucune piste voix ici : enregistre d’abord une prise.'
        : total === 0 ? 'Aucune respiration nette trouvée. Essaie la sensibilité « Forte », ou ajoute-en une à la main sur la forme d’onde.'
        : <span>{summarizeBreathPlan(plans)}</span>}
    </div>
  );

  const footer = (
    <div className="sticky -bottom-5 -mx-5 mt-4 flex flex-wrap justify-end gap-2 border-t border-white/5 bg-[#121418] px-5 py-3">
      <button type="button" onClick={() => setBreathPrefs({ settings: DEFAULT_BREATH_SETTINGS })} className="mr-auto h-11 rounded-lg px-3 text-[12px] font-bold text-slate-400 hover:text-white">Réglages par défaut</button>
      <button type="button" onClick={onClose} className="h-11 rounded-lg bg-white/5 px-4 text-[12px] font-bold text-slate-300">Annuler</button>
      <button type="button" disabled={!!progress || !plans.length} data-testid="breath-apply" onClick={() => onApply(plans, kinds)}
        className="h-11 rounded-lg bg-violet-500 px-4 text-[12px] font-black text-white disabled:cursor-not-allowed disabled:opacity-40">
        {plans.length > 1 ? `Traiter ${plans.length} voix` : 'Appliquer'}
      </button>
    </div>
  );

  // Téléphone : version simple, une ligne (un bouton) par piste avec son dosage.
  if (isMobile) {
    return (
      <div className="fixed inset-0 z-[700] flex items-end justify-center bg-black/60" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="breath-title">
        <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-white/10 bg-[#121418] p-4" onClick={e => e.stopPropagation()} data-testid="breath-dialog">
          {header}
          <div className="space-y-2">
            {targets.map(t => {
              const pl = plans.find(x => x.trackId === t.id);
              const k = kinds[t.id] || 'lead';
              return (
                <div key={t.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <div className="flex items-center gap-2">
                    <span className="mr-auto min-w-0 truncate text-[13px] font-bold text-white">{t.name}</span>
                    {kindSelect(t)}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="mr-auto text-[12px] text-slate-400">{progress ? '…' : `${pl?.count ?? 0} respiration${(pl?.count ?? 0) > 1 ? 's' : ''}`} · <b className="text-violet-300">{doseFor(k)}</b></span>
                    {k === 'lead' && !s.leadRemove && <>
                      <button type="button" aria-label="Baisser moins" onClick={() => setS({ leadDb: Math.max(0, s.leadDb - 5) })} className="h-11 w-11 rounded-lg bg-white/5 text-white">−</button>
                      <button type="button" aria-label="Baisser plus" onClick={() => setS({ leadDb: Math.min(40, s.leadDb + 5) })} className="h-11 w-11 rounded-lg bg-white/5 text-white">+</button>
                    </>}
                    <button type="button" disabled={!pl || !!progress} onClick={() => pl && onApply([pl], { [t.id]: k })}
                      className="h-11 rounded-lg bg-violet-500 px-4 text-[12px] font-black text-white disabled:opacity-40">Appliquer</button>
                  </div>
                </div>
              );
            })}
          </div>
          {sensitivity}
          {status}
          <button type="button" disabled={!!progress || !plans.length} onClick={() => onApply(plans, kinds)} data-testid="breath-apply"
            className="mt-3 h-12 w-full rounded-xl bg-violet-500 text-[13px] font-black text-white disabled:opacity-40">Toutes les voix ({total})</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="breath-title">
      <div className="max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-[#121418] p-5 shadow-2xl" onClick={e => e.stopPropagation()} data-testid="breath-dialog">
        {header}
        {/* Pistes : type deviné, modifiable */}
        <div className="mb-3 space-y-1.5">
          {targets.map(t => {
            const pl = plans.find(x => x.trackId === t.id);
            return (
              <div key={t.id} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-1.5" data-testid="breath-track">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: t.color }} />
                <span className="mr-auto min-w-0 truncate text-[13px] font-bold text-white">{t.name}</span>
                <span className="text-[11.5px] text-slate-400">{progress ? '…' : `${pl?.count ?? 0} · ${doseFor(kinds[t.id] || 'lead')}`}</span>
                {kindSelect(t)}
              </div>
            );
          })}
        </div>
        {doses}
        {sensitivity}
        {cur && !progress && (
          <BreathPreview key={`${cur.trackId}:${cur.clip.id}`} clip={cur.clip} regions={cur.plan.regions} gainDb={cur.gainDb} fadeMs={s.fadeMs}
            excluded={excluded[cur.clip.id] || []} detected={detectedOf(cur.clip, s)}
            onToggle={(r) => {
              const det = detectedOf(cur.clip, s).some(d => d.start === r.start && d.end === r.end);
              if (det) setExcluded(prev => {
                const list = prev[cur.clip.id] || [];
                const on = list.some(e => e.start === r.start);
                return { ...prev, [cur.clip.id]: on ? list.filter(e => e.start !== r.start) : [...list, { start: r.start, end: r.end }] };
              });
              else setAdded(prev => ({ ...prev, [cur.clip.id]: (prev[cur.clip.id] || []).filter(a => a.start !== r.start) }));
            }}
            onAdd={(span) => setAdded(prev => ({ ...prev, [cur.clip.id]: [...(prev[cur.clip.id] || []), span] }))}
            header={clipChoices.length > 1 ? (
              <select value={pick} onChange={e => setPick(Number(e.target.value))} aria-label="Clip montré dans l’aperçu"
                className="h-9 max-w-[60%] rounded-lg border border-white/10 bg-black/40 px-2 text-[12px] text-white">
                {clipChoices.map((c, i) => <option key={c.clip.id} value={i}>{c.track.name} · {c.clip.name} ({c.plan.regions.length})</option>)}
              </select>
            ) : <span className="text-[12px] text-slate-400">{cur.track.name} · {cur.clip.name}</span>} />
        )}
        {status}
        {footer}
      </div>
    </div>
  );
};

const detectedOf = (clip: Clip, s: BreathSettings): BreathRegion[] => {
  const b = bufferOf(clip);
  return b ? detectClipBreaths(clip, b, s.sensitivity) : [];
};

// ------------------------------------------------------------------ aperçu (forme d'onde)

interface PreviewProps {
  clip: Clip;
  /** Zones qui seront traitées (détectées non exclues + ajoutées). */
  regions: Span[];
  detected: Span[];
  excluded: Span[];
  gainDb: number | null;
  fadeMs: number;
  onToggle: (r: Span) => void;
  onAdd: (r: Span) => void;
  header: React.ReactNode;
}

const VIEW_SEC = 8;

const BreathPreview: React.FC<PreviewProps> = ({ clip, regions, detected, excluded, gainDb, fadeMs, onToggle, onAdd, header }) => {
  const buffer = bufferOf(clip);
  const from = clip.offset || 0;
  const to = buffer ? Math.min(buffer.duration, from + clip.duration) : from;
  const span = Math.min(VIEW_SEC, to - from);
  const [view, setView] = useState(() => Math.max(from, Math.min(to - span, (regions[0]?.start ?? from) - span / 3)));
  const [focus, setFocus] = useState(0);
  const cv = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x0: number; t0: number; moved: boolean } | null>(null);
  const [dragSpan, setDragSpan] = useState<Span | null>(null);
  const playing = useRef<AudioBufferSourceNode | null>(null);
  const [playMode, setPlayMode] = useState<'avant' | 'apres' | null>(null);
  const all = useMemo(() => [...detected.map(d => ({ ...d, kind: excluded.some(e => e.start === d.start) ? 'off' : 'on' })), ...regions.filter(r => !detected.some(d => d.start === r.start)).map(r => ({ ...r, kind: 'add' }))].sort((a, b) => a.start - b.start), [detected, excluded, regions]);

  const tOfX = (x: number, w: number) => view + (x / w) * span;

  useEffect(() => {
    const c = cv.current;
    if (!c || !buffer) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (c.width = Math.round(c.clientWidth * dpr)), h = (c.height = Math.round(c.clientHeight * dpr));
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#0b0d10'; ctx.fillRect(0, 0, w, h);
    const xOf = (t: number) => ((t - view) / span) * w;
    for (const r of all) {
      const x0 = xOf(r.start), x1 = xOf(r.end);
      if (x1 < 0 || x0 > w) continue;
      ctx.fillStyle = r.kind === 'off' ? 'rgba(148,163,184,0.12)' : 'rgba(167,139,250,0.28)';
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);
      ctx.fillStyle = r.kind === 'off' ? '#64748b' : r.kind === 'add' ? '#f0abfc' : '#a78bfa';
      ctx.fillRect(x0, h - 4 * dpr, Math.max(2, x1 - x0), 4 * dpr);
    }
    if (dragSpan) { ctx.fillStyle = 'rgba(240,171,252,0.25)'; ctx.fillRect(xOf(dragSpan.start), 0, xOf(dragSpan.end) - xOf(dragSpan.start), h); }
    const sr = buffer.sampleRate, data = buffer.getChannelData(0);
    let pk = 1e-4;
    for (let i = Math.floor(from * sr); i < Math.floor(to * sr); i += 16) pk = Math.max(pk, Math.abs(data[i] || 0));
    const scale = 0.95 / pk;
    const edits = gainDb == null ? [] : breathEditsFor(regions, gainDb, fadeMs);
    for (let x = 0; x < w; x++) {
      const t0 = tOfX(x, w), t1 = tOfX(x + 1, w);
      let m = 0;
      for (let i = Math.floor(t0 * sr); i < Math.floor(t1 * sr); i += 2) m = Math.max(m, Math.abs(data[i] || 0));
      const g = breathGainAt(edits, (t0 + t1) / 2);
      const hh = Math.max(1, Math.min(1, m * scale) * h * 0.9);
      ctx.fillStyle = '#334155';
      ctx.fillRect(x, h / 2 - hh / 2, 1, hh);
      if (g < 0.999) { const hg = Math.max(1, hh * g); ctx.fillStyle = '#c4b5fd'; ctx.fillRect(x, h / 2 - hg / 2, 1, hg); }
      else { ctx.fillStyle = '#22d3ee'; ctx.fillRect(x, h / 2 - hh / 2, 1, hh); }
    }
  }, [all, buffer, dragSpan, fadeMs, from, gainDb, regions, span, to, view]);

  const stop = () => { try { playing.current?.stop(); } catch { /* déjà arrêté */ } playing.current = null; setPlayMode(null); };
  useEffect(() => stop, []);

  const play = (mode: 'avant' | 'apres') => {
    if (!buffer) return;
    stop();
    const ctx = getCtx();
    void ctx.resume();
    const sr = buffer.sampleRate;
    const a = Math.floor(view * sr), n = Math.max(1, Math.floor(span * sr));
    const out = ctx.createBuffer(buffer.numberOfChannels, n, sr);
    const edits = mode === 'apres' && gainDb != null ? breathEditsFor(regions, gainDb, fadeMs) : [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const src = buffer.getChannelData(c), dst = out.getChannelData(c);
      for (let i = 0; i < n; i++) dst[i] = (src[a + i] || 0) * (edits.length ? breathGainAt(edits, (a + i) / sr) : 1) * (clip.gain ?? 1);
    }
    const node = ctx.createBufferSource();
    node.buffer = out; node.connect(ctx.destination);
    node.onended = () => { if (playing.current === node) { playing.current = null; setPlayMode(null); } };
    node.start();
    playing.current = node;
    setPlayMode(mode);
  };

  const goTo = (i: number) => {
    const on = all;
    if (!on.length) return;
    const k = (i + on.length) % on.length;
    setFocus(k);
    const r = on[k];
    setView(Math.max(from, Math.min(to - span, (r.start + r.end) / 2 - span / 2)));
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = tOfX(e.clientX - rect.left, rect.width);
    const hit = all.find(r => t >= r.start - 0.01 && t <= r.end + 0.01);
    if (hit) { onToggle({ start: hit.start, end: hit.end }); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x0: e.clientX, t0: t, moved: false };
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = tOfX(e.clientX - rect.left, rect.width);
    drag.current.moved = Math.abs(e.clientX - drag.current.x0) > 4;
    setDragSpan({ start: Math.min(drag.current.t0, t), end: Math.max(drag.current.t0, t) });
  };
  const onUp = () => {
    const d = dragSpan;
    drag.current = null;
    setDragSpan(null);
    if (d && d.end - d.start >= 0.06) onAdd({ start: Math.max(from, d.start), end: Math.min(to, d.end) });
  };

  if (!buffer) return null;
  const n = regions.length;
  return (
    <div className="mt-4" data-testid="breath-preview">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {header}
        <span className="ml-auto text-[12px] font-bold text-violet-200" data-testid="breath-count">
          {n} respiration{n > 1 ? 's' : ''} trouvée{n > 1 ? 's' : ''}, {breathDoseLabel(gainDb)}
        </span>
      </div>
      <canvas ref={cv} className="h-28 w-full touch-none rounded-lg border border-white/5" data-testid="breath-wave"
        aria-label="Aperçu : en violet, les respirations traitées ; touche une respiration pour l’exclure ou la remettre, glisse pour en ajouter une"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => goTo(focus - 1)} className="h-10 rounded-lg bg-white/5 px-3 text-[12px] font-bold text-slate-200" aria-label="Respiration précédente">◀</button>
        <button type="button" onClick={() => goTo(focus + 1)} className="h-10 rounded-lg bg-white/5 px-3 text-[12px] font-bold text-slate-200" aria-label="Respiration suivante">▶</button>
        <button type="button" onClick={() => (playMode === 'avant' ? stop() : play('avant'))} data-testid="breath-play-before"
          className={`h-10 rounded-lg px-3 text-[12px] font-bold ${playMode === 'avant' ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-200'}`}>{playMode === 'avant' ? '■ Stop' : '▶ Avant'}</button>
        <button type="button" onClick={() => (playMode === 'apres' ? stop() : play('apres'))} data-testid="breath-play-after"
          className={`h-10 rounded-lg px-3 text-[12px] font-bold ${playMode === 'apres' ? 'bg-violet-500 text-white' : 'bg-white/5 text-slate-200'}`}>{playMode === 'apres' ? '■ Stop' : '▶ Après'}</button>
        <span className="text-[11px] text-slate-500">Touche une zone pour l’exclure ou la remettre · glisse pour en ajouter une.</span>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ panneau voix (Mix auto)

interface PanelProps {
  canTreat: boolean;
  /** Réglage du projet (absent : préférence de l'appareil). */
  projectAuto?: boolean;
  onProjectAutoChange?: (on: boolean) => void;
}

/** Bloc « Respirations » du panneau voix : un clic pour toute la session, mode auto, réglages. */
export const BreathPanelTools: React.FC<PanelProps> = ({ canTreat, projectAuto, onProjectAutoChange }) => {
  const p = useBreathPrefs();
  const auto = projectAuto ?? p.auto;
  const s = p.settings;
  return (
    <div className="mt-3 rounded-xl border border-violet-400/25 bg-violet-500/[0.06] p-3" data-testid="breath-panel">
      <button type="button" disabled={!canTreat} onClick={() => requestBreaths({ mode: 'apply', reason: 'panel' })} data-testid="breath-all"
        title="Comme Breath Control de Waves / De-breath de RX : la lead est baissée, les backs, doubles et ad-libs sont nettoyés. Une seule annulation."
        className="w-full h-11 rounded-xl bg-violet-500 text-white font-black text-[13px] disabled:opacity-40 hover:bg-violet-400">
        🌬️ Traiter les respirations de toutes les voix
      </button>
      <p className="mt-1.5 text-[11px] text-slate-400">
        Lead : {s.leadRemove ? 'supprimées' : `−${s.leadDb} dB`} · Backs / ad-libs : {s.extraRemove ? 'supprimées' : `−${s.extraDb} dB`} · Sensibilité {BREATH_SENSITIVITIES.find(o => o.id === s.sensitivity)?.label.toLowerCase()}
        {' · '}<button type="button" className="font-bold text-violet-300 underline-offset-2 hover:underline" onClick={() => requestBreaths({ mode: 'dialog', reason: 'panel' })}>Réglages et aperçu…</button>
      </p>
      <label className="mt-2 flex min-h-10 cursor-pointer items-start gap-2 text-[12.5px] text-white">
        <input type="checkbox" checked={auto} onChange={e => { setBreathPrefs({ auto: e.target.checked }); onProjectAutoChange?.(e.target.checked); }}
          data-testid="breath-auto" className="mt-0.5 h-4 w-4 accent-violet-500" />
        <span><b>Traiter les respirations automatiquement après chaque prise</b>
          <span className="block text-[11px] text-slate-400">Seul le passage que tu viens d’enregistrer est traité (comp, boucle et punch compris), selon le type de la piste. « Annuler » sur la notification revient en arrière.</span></span>
      </label>
    </div>
  );
};

/** Case du Mix auto : traiter aussi les respirations en appliquant un style (cochée par défaut). */
export const BreathMixOption: React.FC = () => {
  const p = useBreathPrefs();
  return (
    <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[12.5px] text-white"
      title="La lead garde ses respirations baissées (−15 dB par défaut), les backs les perdent : comme Breath Control de Waves">
      <input type="checkbox" checked={p.withMix} onChange={e => setBreathPrefs({ withMix: e.target.checked })} data-testid="breath-with-mix" className="h-4 w-4 accent-violet-500" />
      🌬️ Traiter les respirations en même temps <span className="text-[11px] text-slate-400">(lead {p.settings.leadRemove ? 'supprimées' : `−${p.settings.leadDb} dB`}, backs supprimées)</span>
    </label>
  );
};

/**
 * Après un style de Mix auto : respirations aussi, si la case est cochée.
 * `scope` : seulement ces pistes / clips (style mis tout seul après une prise :
 * seule la prise qui vient d'être enregistrée est traitée).
 */
export const breathsAfterMixStyle = (scope?: { trackIds?: string[]; clipIds?: string[] }) => {
  if (getBreathPrefs().withMix) requestBreaths({ mode: 'apply', reason: 'mix', ...(scope || {}) });
};

export { BREATH_REMOVE_DB };
export type { BreathEdit };
