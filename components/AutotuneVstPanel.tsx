import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { novaBridge } from '../services/NovaBridge';
import { autotuneLive, autotunePrefs, effectiveAutotune } from '../services/AutotuneVst';
import { liveAutotuneNodes } from '../engine/HybridAutoTuneNode';
import { AutotuneCandidate, recommendedAutotune } from '../utils/autotuneVst';
import { Track } from '../types';

/**
 * Autotune du PC : fenêtre de choix (une seule fois), réglages (onglet VST),
 * badge des pistes voix et note dans la fenêtre de l'autotune.
 */

const usePrefs = () => useSyncExternalStore(autotunePrefs.subscribe, () => autotunePrefs.get());
const useDetected = () => useSyncExternalStore(autotunePrefs.subscribe, () => autotunePrefs.detected());

const FAMILY_NOTE: Record<string, string> = {
  antares: 'La référence en studio : correction franche ou naturelle.',
  metatune: 'Autotune moderne de Slate, très réactif.',
  'waves-tune': 'Waves Tune Real-Time : correction en temps réel.',
  graillon: 'Auburn Sounds Graillon.',
  other: 'Correction de justesse.',
  'little-alterboy': 'Ne suit pas la gamme du beat (demi-tons seulement).',
};

/** Liste des plugins du pont → détection (à chaque connexion / nouvelle lecture). */
const useBridgeScan = () => {
  useEffect(() => {
    let alive = true;
    const feed = () => {
      const list = novaBridge.getCachedPlugins();
      if (list.length) autotunePrefs.setScanned(list);
    };
    let lastCount = -1;
    const unsub = novaBridge.subscribe(s => {
      if (!alive) return;
      if (s.status === 'connected' && s.pluginCount !== lastCount) {
        lastCount = s.pluginCount;
        if (s.pluginCount > 0) feed();
        else novaBridge.listPlugins().then(() => alive && feed()).catch(() => { /* réessayé à la prochaine connexion */ });
      }
      if (s.status !== 'connected') lastCount = -1;
    });
    return () => { alive = false; unsub(); };
  }, []);
};

/**
 * Monté une fois dans l'appli : détecte les autotunes à la connexion du pont et
 * pose la question une seule fois (« Utiliser ton autotune à la place de celui de NOVA ? »).
 */
export const AutotuneVstManager: React.FC = () => {
  useBridgeScan();
  const prefs = usePrefs();
  const detected = useDetected();
  const [dismissed, setDismissed] = useState(false);
  const open = !dismissed && prefs.choice === null && detected.some(c => !c.unavailable && c.followsKey);
  if (!open) return null;
  return <AutotuneChoiceModal candidates={detected} onClose={() => setDismissed(true)} />;
};

export const AutotuneChoiceModal: React.FC<{ candidates: AutotuneCandidate[]; onClose: () => void }> = ({ candidates, onClose }) => {
  const usable = candidates.filter(c => !c.unavailable && c.followsKey);
  const rec = recommendedAutotune(candidates);
  const [sel, setSel] = useState<string>(rec?.key || usable[0]?.key || 'nova');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const chosen = usable.find(c => c.key === sel) || null;
  const confirm = () => {
    if (chosen) autotunePrefs.setChoice({ mode: 'vst', key: chosen.key, name: chosen.name, vendor: chosen.vendor, decidedAt: Date.now() });
    else autotunePrefs.setChoice({ mode: 'nova', decidedAt: Date.now() });
    onClose();
  };
  const single = usable.length === 1;
  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="autotune-choice-title" data-testid="autotune-choice">
      <div className="w-full max-w-md rounded-3xl border border-cyan-500/30 bg-[#121418] p-6 shadow-2xl space-y-4">
        <div>
          <h2 id="autotune-choice-title" className="text-lg font-black text-white">🎤 Utiliser ton autotune à la place de celui de NOVA ?</h2>
          <p className="mt-1 text-[12px] text-slate-300">
            {single
              ? <>NOVA a trouvé <b>{usable[0].name}</b> ({usable[0].vendor || 'éditeur inconnu'}) sur ce PC. </>
              : <>NOVA a trouvé {usable.length} autotunes sur ce PC. </>}
            Il sera posé tout seul sur ta voix, réglé dans la gamme du beat. Si le pont VST est fermé, NOVA reprend avec son propre autotune, sans rien couper.
          </p>
        </div>
        <div role="radiogroup" aria-label="Autotune à utiliser" className="space-y-2">
          {candidates.map(c => {
            const disabled = !!c.unavailable || !c.followsKey;
            return (
              <label key={c.key} className={`flex items-start gap-3 rounded-2xl border p-3 ${disabled ? 'border-white/5 opacity-50' : sel === c.key ? 'border-cyan-400 bg-cyan-500/10' : 'border-white/10 hover:bg-white/[0.04] cursor-pointer'}`}>
                <input type="radio" name="autotune" className="mt-1" disabled={disabled} checked={sel === c.key} onChange={() => setSel(c.key)} />
                <span className="min-w-0">
                  <span className="block text-[13px] font-bold text-white">
                    {c.name}
                    {rec?.key === c.key && <span className="ml-2 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-black uppercase text-emerald-300">Recommandé</span>}
                  </span>
                  <span className="block text-[11px] text-slate-400">{c.vendor || 'Éditeur inconnu'} · {c.unavailable || (!c.followsKey ? FAMILY_NOTE['little-alterboy'] : FAMILY_NOTE[c.family])}</span>
                </span>
              </label>
            );
          })}
          <label className={`flex items-start gap-3 rounded-2xl border p-3 cursor-pointer ${sel === 'nova' ? 'border-cyan-400 bg-cyan-500/10' : 'border-white/10 hover:bg-white/[0.04]'}`}>
            <input type="radio" name="autotune" className="mt-1" checked={sel === 'nova'} onChange={() => setSel('nova')} />
            <span>
              <span className="block text-[13px] font-bold text-white">Autotune de NOVA</span>
              <span className="block text-[11px] text-slate-400">Intégré, marche aussi sur téléphone.</span>
            </span>
          </label>
        </div>
        <p className="text-[11px] text-slate-500">Tu pourras changer d'avis dans l'onglet VST (« Autotune »).</p>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="h-11 flex-1 rounded-xl bg-white/5 text-[12px] font-bold text-slate-300 hover:bg-white/10">Plus tard</button>
          <button type="button" onClick={confirm} className="h-11 flex-[2] rounded-xl bg-cyan-500 text-[12px] font-black text-black hover:bg-cyan-400">
            {chosen ? `Utiliser ${chosen.name}` : "Garder l'autotune de NOVA"}
          </button>
        </div>
      </div>
    </div>
  );
};

const chip = 'inline-flex items-center gap-1 rounded-full bg-white/5 border border-white/10 px-2 py-0.5 text-[10px] text-slate-300';

/** Réglages (onglet VST) : choix, qualité, plugins non disponibles, exclusions. */
export const AutotuneVstSettings: React.FC = () => {
  const prefs = usePrefs();
  const detected = useDetected();
  const eff = effectiveAutotune();
  const [newVendor, setNewVendor] = useState('');
  const [newAllow, setNewAllow] = useState('');
  const value = prefs.choice?.mode === 'vst' ? prefs.choice.key || '' : prefs.choice?.mode === 'nova' ? 'nova' : '';
  const unavailable = detected.filter(c => c.unavailable);
  const ex = prefs.exclusions;
  const setEx = (patch: Partial<typeof ex>) => autotunePrefs.setExclusions({ ...ex, ...patch });
  return (
    <section className="space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-3" aria-label="Autotune" data-testid="autotune-settings">
      <h4 className="text-[11px] font-black uppercase tracking-widest text-white">🎤 Autotune</h4>
      {detected.length === 0 ? (
        <p className="text-[11px] text-slate-400">Aucun autotune trouvé sur ce PC : NOVA utilise le sien.</p>
      ) : (
        <>
          <select
            aria-label="Autotune à utiliser"
            value={value}
            onChange={e => {
              const v = e.target.value;
              const c = detected.find(x => x.key === v);
              autotunePrefs.setChoice(c ? { mode: 'vst', key: c.key, name: c.name, vendor: c.vendor, decidedAt: Date.now() } : { mode: 'nova', decidedAt: Date.now() });
            }}
            className="w-full h-9 rounded-lg bg-black/40 border border-white/10 px-2 text-xs text-white"
          >
            {value === '' && <option value="">À choisir…</option>}
            {detected.map(c => (
              <option key={c.key} value={c.key} disabled={!!c.unavailable || !c.followsKey}>
                {c.name} ({c.vendor || '?'}){c.unavailable ? ` : non disponible` : ''}
              </option>
            ))}
            <option value="nova">Autotune de NOVA</option>
          </select>
          <p className="text-[10px] text-slate-500">
            {eff ? <>En service : <b className="text-slate-300">{eff.name}</b> ({eff.vendor}){prefs.choice?.key && eff.key !== prefs.choice.key ? ' (ton choix est indisponible : bascule automatique)' : ''}.</> : 'En service : autotune de NOVA.'}
          </p>
          <div role="radiogroup" aria-label="Latence de l'autotune" className="grid grid-cols-2 gap-1">
            {([['low-latency', 'Faible latence', 'Recommandé pour enregistrer'], ['max-quality', 'Qualité maximale', 'Pour le mix (plus de latence)']] as const).map(([q, label, sub]) => (
              <button key={q} type="button" role="radio" aria-checked={prefs.quality === q} onClick={() => autotunePrefs.setQuality(q)}
                className={`rounded-lg border px-2 py-1.5 text-left ${prefs.quality === q ? 'border-cyan-400 bg-cyan-500/10 text-white' : 'border-white/10 text-slate-400 hover:bg-white/5'}`}>
                <span className="block text-[11px] font-bold">{label}</span>
                <span className="block text-[9px] text-slate-500">{sub}</span>
              </button>
            ))}
          </div>
          <p className="text-[10px] text-slate-500">Pendant une prise, tu t'entends avec l'autotune de NOVA (réglé pareil, sans décalage) ; l'autotune du PC reprend à la lecture.</p>
          {unavailable.length > 0 && (
            <div className="space-y-1">
              {unavailable.map(c => (
                <div key={c.key} className="flex items-center justify-between gap-2 text-[10px] text-amber-300">
                  <span className="truncate">{c.name} : {c.unavailable}</span>
                  <button type="button" onClick={() => autotunePrefs.clearUnavailable(c.key)} className="shrink-0 rounded bg-white/5 px-2 py-0.5 text-slate-200 hover:bg-white/10">Réessayer</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <details className="text-[10px] text-slate-400">
        <summary className="cursor-pointer select-none">Plugins exclus (licences)</summary>
        <p className="mt-1">NOVA ne charge jamais les plugins de ces éditeurs (sauf les exceptions).</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {ex.vendors.map(v => (
            <span key={v} className={chip}>{v}<button type="button" aria-label={`Ne plus exclure ${v}`} onClick={() => setEx({ vendors: ex.vendors.filter(x => x !== v) })}>✕</button></span>
          ))}
        </div>
        <form className="mt-1 flex gap-1" onSubmit={e => { e.preventDefault(); const v = newVendor.trim(); if (v && !ex.vendors.includes(v)) setEx({ vendors: [...ex.vendors, v] }); setNewVendor(''); }}>
          <input value={newVendor} onChange={e => setNewVendor(e.target.value)} placeholder="Éditeur à exclure" aria-label="Éditeur à exclure" className="h-7 flex-1 rounded bg-black/40 border border-white/10 px-2 text-white" />
          <button type="submit" className="rounded bg-white/5 px-2 text-slate-200">Ajouter</button>
        </form>
        <p className="mt-2">Exceptions (autorisés quand même) :</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {ex.allow.map(v => (
            <span key={v} className={chip}>{v}<button type="button" aria-label={`Retirer l'exception ${v}`} onClick={() => setEx({ allow: ex.allow.filter(x => x !== v) })}>✕</button></span>
          ))}
        </div>
        <form className="mt-1 flex gap-1" onSubmit={e => { e.preventDefault(); const v = newAllow.trim(); if (v && !ex.allow.includes(v)) setEx({ allow: [...ex.allow, v] }); setNewAllow(''); }}>
          <input value={newAllow} onChange={e => setNewAllow(e.target.value)} placeholder="Plugin autorisé" aria-label="Plugin autorisé malgré l'exclusion" className="h-7 flex-1 rounded bg-black/40 border border-white/10 px-2 text-white" />
          <button type="submit" className="rounded bg-white/5 px-2 text-slate-200">Ajouter</button>
        </form>
      </details>
    </section>
  );
};

const useLive = (pluginId: string | null) =>
  useSyncExternalStore(autotuneLive.subscribe, () => (pluginId ? autotuneLive.get(pluginId) : null));

/** État en direct d'un autotune (plugin du PC ou NOVA) : nom affiché partout. */
export const useAutotuneLive = useLive;

/** Ouvre la fenêtre du plugin du PC qui traite la voix ; renvoie un message d'erreur clair sinon. */
export const openAutotuneWindow = async (pluginId: string): Promise<string | null> => {
  const node = liveAutotuneNodes.get(pluginId);
  if (!node) return "L'autotune n'est pas encore démarré : lance la lecture ou ouvre le projet sur ton PC.";
  try { await node.openVstEditor(); return null; }
  catch (e: any) { return e?.message || "La fenêtre de l'autotune n'a pas pu s'ouvrir."; }
};

/** Badge de la piste voix : « Auto-Tune Pro · F# mineur » (ou l'autotune de NOVA). */
export const AutotuneBadge: React.FC<{ track: Track; onOpen?: (e: React.MouseEvent) => void }> = ({ track, onOpen }) => {
  const at = useMemo(() => track.plugins.find(p => p.type === 'AUTOTUNE' && p.isEnabled), [track.plugins]);
  const info = useLive(at?.id || null);
  if (!at || !info || !info.pluginName) return null;
  const vst = info.engine === 'vst';
  const label = vst ? info.pluginName : 'Autotune NOVA';
  const title = vst
    ? `${info.pluginName} (${info.vendor}) traite ta voix en ${info.keyText}${info.latencyMs ? ` · latence compensée ${info.latencyMs} ms` : ''}`
    : info.loading ? `${info.pluginName} se prépare… (autotune de NOVA en attendant)`
      : `Autotune de NOVA en ${info.keyText}${info.fallback ? ` (${info.pluginName} : ${info.fallback})` : ''}`;
  return (
    <div className="-mt-1 mb-0.5 flex min-w-0 relative z-10">
      <button
        type="button"
        data-testid="autotune-badge"
        title={`${title} — clic pour l'ouvrir`}
        aria-label={`${title}. Ouvrir l'autotune`}
        onClick={(e) => { e.stopPropagation(); onOpen?.(e); }}
        disabled={!onOpen}
        className={`min-w-0 max-w-full truncate px-1.5 h-5 rounded text-[10px] font-bold leading-5 transition-colors ${vst ? 'bg-fuchsia-500/15 text-fuchsia-200 hover:bg-fuchsia-500/30' : 'bg-white/5 text-slate-300 hover:bg-white/10'} ${onOpen ? 'cursor-pointer' : ''}`}
      >
        {info.loading && !vst ? <i className="fas fa-circle-notch fa-spin mr-1 text-[7px]" /> : <i className={`fas fa-microphone-alt mr-1 text-[7px] ${vst ? 'text-fuchsia-300' : 'text-slate-500'}`} />}
        {label}{info.keyText ? ` · ${info.keyText}` : ''}
      </button>
    </div>
  );
};

/** Dans la fenêtre de l'autotune : qui traite vraiment le son. */
export const AutotuneEngineNote: React.FC<{ pluginId: string }> = ({ pluginId }) => {
  const info = useLive(pluginId);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  if (!info || !info.pluginName) return null;
  const vst = info.engine === 'vst';
  const open = async () => { setOpening(true); setOpenError(await openAutotuneWindow(pluginId)); setOpening(false); };
  return (
    <div role="status" className={`mb-2 rounded-lg px-3 py-2 text-[11px] ${vst ? 'bg-fuchsia-500/10 text-fuchsia-100' : 'bg-white/5 text-slate-300'}`}>
      {vst && (
        <button type="button" onClick={open} disabled={opening} data-testid="autotune-open-window"
          className="float-right ml-2 rounded-md bg-fuchsia-500/25 px-2 py-1 text-[11px] font-bold text-white hover:bg-fuchsia-500/40 disabled:opacity-60">
          <i className={`fas ${opening ? 'fa-circle-notch fa-spin' : 'fa-external-link-alt'} mr-1`} />Ouvrir {info.pluginName}
        </button>
      )}
      {openError && <p className="mb-1 text-amber-300"><i className="fas fa-exclamation-triangle mr-1" />{openError}</p>}
      {vst
        ? <>Ta voix passe par <b>{info.pluginName}</b> ({info.vendor}), réglé en <b>{info.keyText}</b>. Les réglages ci-dessous (vitesse, naturel, dosage) lui sont recopiés.</>
        : <>Autotune de NOVA en service{info.fallback ? <> : {info.pluginName} reprendra dès que possible ({info.fallback})</> : info.loading ? <> : {info.pluginName} se prépare</> : null}.</>}
    </div>
  );
};
