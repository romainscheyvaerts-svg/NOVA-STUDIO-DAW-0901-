import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { novaBridge, BridgeState, SeparationResult, StemsError, StemsModuleStatus } from '../services/NovaBridge';
import {
  bufferChannels, describeStemsError, formatSeconds, installProgressLabel, StemCount, stemsAvailability,
  STEMS_INSTALL_LABEL, STEMS_TOOLTIP,
} from '../services/StemSeparation';
import { DESKTOP_APP_DOWNLOAD_URL, isNovaDesktop } from '../utils/desktopApp';

/**
 * « Séparer en stems » (menu du clip) : comme Stem Splitter dans Logic ou Stem
 * Separation dans FL Studio. Le calcul tourne sur le PC (appli Windows, module
 * Demucs installé à la demande) ; fermer la fenêtre ne l'arrête pas : une pastille
 * en bas à droite garde la progression et le bouton Annuler.
 */

export interface StemTarget { trackId: string; clipId: string; clipName: string }

interface Job {
  jobId: string;
  target: StemTarget;
  stems: StemCount;
  phase: 'running' | 'done' | 'error';
  pct: number;
  message: string;
  device?: string;
  startedAt: number;
  error?: string;
  summary?: string;
  outdir?: string;
}

// --- Séparation en cours (survit à la fermeture de la fenêtre) -----------------------
let job: Job | null = null;
const jobListeners = new Set<() => void>();
const setJob = (j: Job | null) => { job = j; jobListeners.forEach(cb => cb()); };
const patchJob = (id: string, p: Partial<Job>) => { if (job && job.jobId === id) setJob({ ...job, ...p }); };
const useJob = () => useSyncExternalStore(cb => { jobListeners.add(cb); return () => { jobListeners.delete(cb); }; }, () => job);

novaBridge.onStemsEvent(e => {
  if (e.kind !== 'separate' || !job || e.jobId !== job.jobId) return;
  if (e.event === 'progress') patchJob(job.jobId, { pct: Math.max(job.pct, e.pct ?? job.pct), message: e.message || job.message });
  else if (e.event === 'device') patchJob(job.jobId, { device: e.device });
  else if (e.event === 'fallback') patchJob(job.jobId, { device: 'cpu', message: e.message || job.message });
});

const useBridge = () => {
  const [s, setS] = useState<BridgeState>(novaBridge.getBridgeState());
  useEffect(() => novaBridge.subscribe(setS), []);
  return s;
};

interface Props {
  target: StemTarget | null;
  projectName: string;
  getClipBuffer: (trackId: string, clipId: string) => AudioBuffer | null;
  /** Pose les pistes ; renvoie leurs noms (null si le clip a disparu pendant le calcul). */
  onApply: (target: StemTarget, result: SeparationResult) => string[] | null;
  onClose: () => void;
}

const btn = 'h-11 rounded-xl text-[12px] font-black transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const primary = `${btn} bg-cyan-500 text-black hover:bg-cyan-400`;
const secondary = `${btn} bg-white/5 text-slate-300 hover:bg-white/10 font-bold`;

const ProgressBar: React.FC<{ pct: number; label: string; testid?: string }> = ({ pct, label, testid }) => (
  <div className="space-y-1.5" data-testid={testid}>
    <div className="h-2.5 rounded-full bg-white/10 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={label}>
      <div className="h-full bg-gradient-to-r from-cyan-500 to-fuchsia-500 transition-all duration-300" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </div>
    <p className="text-[11px] text-slate-300">{label}</p>
  </div>
);

const StemSeparationDialog: React.FC<Props> = ({ target, projectName, getClipBuffer, onApply, onClose }) => {
  const bridge = useBridge();
  const current = useJob();
  const [module, setModule] = useState<StemsModuleStatus | null>(null);
  const [moduleError, setModuleError] = useState<string | null>(null);
  const [count, setCount] = useState<StemCount>(2);
  const [connecting, setConnecting] = useState(false);
  const availability = stemsAvailability(bridge, isNovaDesktop());

  // Appli Windows : le pont démarre avec elle, on s'y connecte tout seul (un essai).
  useEffect(() => {
    if (!target || availability !== 'connect') return;
    setConnecting(true);
    novaBridge.connect().finally(() => setConnecting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // État du module à l'ouverture, puis suivi de l'installation.
  useEffect(() => {
    if (!target || availability !== 'ok') return;
    let alive = true;
    novaBridge.stemsStatus().then(s => { if (alive) { setModule(s); setModuleError(null); } })
      .catch(e => { if (alive) setModuleError(describeStemsError(e)); });
    const off = novaBridge.onStemsEvent(e => {
      if (e.kind !== 'install') return;
      setModule(m => {
        const base: StemsModuleStatus = m || { installed: false, installing: true, install: null, variant: null, sizeBytes: null, outputRoot: null };
        if (e.event === 'done') return { ...base, installed: true, installing: false, install: e };
        if (e.event === 'error' || e.event === 'cancelled') return { ...base, installing: false, install: e };
        return { ...base, installing: true, install: e };
      });
    });
    return () => { alive = false; off(); };
  }, [target, availability]);

  const install = async () => {
    setModuleError(null);
    try { setModule(await novaBridge.stemsInstall('cpu')); } catch (e) { setModuleError(describeStemsError(e)); }
  };

  const start = async () => {
    if (!target) return;
    const buffer = getClipBuffer(target.trackId, target.clipId);
    if (!buffer) { setModuleError('Le son de ce clip n’est pas encore chargé.'); return; }
    const jobId = `stems-${Date.now().toString(36)}`;
    const t = target;
    setJob({ jobId, target: t, stems: count, phase: 'running', pct: 0, message: 'Envoi du clip au PC', startedAt: Date.now() });
    try {
      const res = await novaBridge.separateStems({ jobId, channels: bufferChannels(buffer), sampleRate: buffer.sampleRate, stems: count, project: projectName, clip: t.clipName });
      const names = onApply(t, res);
      if (!names) throw new StemsError('Le clip a été supprimé pendant la séparation : rien n’a été ajouté.', 'error');
      patchJob(jobId, { phase: 'done', pct: 100, summary: `${names.length} pistes ajoutées : ${names.join(', ')} (en ${formatSeconds(res.seconds)}${res.device === 'cuda' ? ', carte graphique' : ''})`, outdir: res.outdir });
    } catch (e) {
      if ((e as StemsError)?.code === 'cancelled') { setJob(null); return; }
      patchJob(jobId, { phase: 'error', error: describeStemsError(e) });
      if ((e as StemsError)?.code === 'not_installed') setModule(m => (m ? { ...m, installed: false } : m));
    }
  };

  const cancel = () => { if (current) novaBridge.stemsCancel({ jobId: current.jobId }).catch(() => undefined); };

  // --- Pastille (fenêtre fermée, séparation qui continue ou vient de finir) ---------------
  if (!target) {
    if (!current) return null;
    return (
      <div className="fixed bottom-4 right-4 z-[650] w-72 rounded-2xl border border-cyan-500/30 bg-[#121418]/95 p-3 shadow-2xl space-y-2" data-testid="stems-pill" title={STEMS_TOOLTIP}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-black text-white truncate">Stems · {current.target.clipName}</span>
          {current.phase !== 'running' && <button type="button" aria-label="Fermer" onClick={() => setJob(null)} className="text-slate-400 hover:text-white text-[14px]">×</button>}
        </div>
        {current.phase === 'running' && <>
          <ProgressBar pct={current.pct} label={`${Math.round(current.pct)} % · ${current.message}`} />
          <button type="button" onClick={cancel} className="text-[11px] font-bold text-rose-300 hover:text-rose-200">Annuler</button>
        </>}
        {current.phase === 'done' && <p className="text-[11px] text-emerald-300">✅ {current.summary}</p>}
        {current.phase === 'error' && <p className="text-[11px] text-rose-300">❌ {current.error}</p>}
      </div>
    );
  }

  const running = current?.phase === 'running' ? current : null;
  const finished = current && current.phase !== 'running' && current.target.clipId === target.clipId ? current : null;
  const installing = !!module?.installing;
  const installEv = module?.install;

  let body: React.ReactNode;
  if (availability === 'web') {
    body = (
      <div className="space-y-3" data-testid="stems-web">
        <p className="text-[12px] text-slate-300">
          La séparation de stems tourne <b>sur ton PC</b>, gratuitement, dans l’appli Windows <b>Nova Studio</b> : le navigateur seul n’a pas la puissance de calcul nécessaire.
        </p>
        <p className="text-[11px] text-slate-400">Ouvre ton projet dans l’appli Windows, puis clic droit sur le clip → « Séparer en stems ».</p>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={`${secondary} flex-1`}>Fermer</button>
          <a href={DESKTOP_APP_DOWNLOAD_URL} className={`${primary} flex-[2] flex items-center justify-center`}>Télécharger Nova Studio pour Windows</a>
        </div>
      </div>
    );
  } else if (availability === 'connect') {
    body = (
      <div className="space-y-3" data-testid="stems-connect">
        <p className="text-[12px] text-slate-300">Le pont de l’appli ne répond pas encore (il démarre avec Nova Studio).</p>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={`${secondary} flex-1`}>Fermer</button>
          <button type="button" disabled={connecting} onClick={async () => { setConnecting(true); await novaBridge.connect(); setConnecting(false); }} className={`${primary} flex-[2]`}>
            {connecting ? 'Connexion…' : 'Réessayer la connexion'}
          </button>
        </div>
      </div>
    );
  } else if (availability === 'update') {
    body = (
      <div className="space-y-3" data-testid="stems-update">
        <p className="text-[12px] text-slate-300">Ta version de Nova Studio pour Windows ne sait pas encore séparer les stems. Mets-la à jour (même lien que l’installation) puis relance-la.</p>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={`${secondary} flex-1`}>Fermer</button>
          <a href={DESKTOP_APP_DOWNLOAD_URL} className={`${primary} flex-[2] flex items-center justify-center`}>Mettre à jour Nova Studio</a>
        </div>
      </div>
    );
  } else if (!module && !moduleError) {
    body = <p className="text-[12px] text-slate-400" data-testid="stems-loading">Vérification du module sur ton PC…</p>;
  } else if (installing) {
    body = (
      <div className="space-y-3" data-testid="stems-installing">
        <ProgressBar pct={installEv?.pct ?? 0} label={installProgressLabel(installEv)} />
        <p className="text-[11px] text-slate-400">Une seule fois. Tu peux fermer cette fenêtre et continuer à travailler : l’installation se poursuit.</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => novaBridge.stemsCancel({ install: true }).catch(() => undefined)} className={`${secondary} flex-1`}>Annuler l’installation</button>
          <button type="button" onClick={onClose} className={`${primary} flex-[2]`}>Continuer en arrière-plan</button>
        </div>
      </div>
    );
  } else if (module && !module.installed) {
    const failed = installEv && (installEv.event === 'error' || installEv.event === 'cancelled') ? installEv : null;
    body = (
      <div className="space-y-3" data-testid="stems-not-installed">
        <p className="text-[12px] text-slate-300">
          La séparation utilise <b>Demucs</b> (IA libre de Meta, licence MIT) : gratuit, en local, rien n’est envoyé sur Internet.
          Il faut l’installer une fois sur ce PC.
        </p>
        <ul className="text-[11px] text-slate-400 list-disc pl-4 space-y-0.5">
          <li>Téléchargement d’environ 1 Go (PyTorch + modèle) ; prévois ~4 Go libres pendant l’installation, ~0,7 Go restent ensuite.</li>
          <li>Quelques minutes selon ta connexion. Marche sans carte graphique (processeur).</li>
        </ul>
        {failed && <p className="text-[11px] text-rose-300" role="alert">{failed.event === 'cancelled' ? 'Installation annulée.' : failed.message}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={`${secondary} flex-1`}>Plus tard</button>
          <button type="button" onClick={install} className={`${primary} flex-[2]`} data-testid="stems-install" title="Installe Demucs et PyTorch dans un dossier à part (%LOCALAPPDATA%\NovaStudio\stems), supprimable d’un coup.">
            {STEMS_INSTALL_LABEL}
          </button>
        </div>
      </div>
    );
  } else if (running) {
    const same = running.target.clipId === target.clipId;
    const elapsed = (Date.now() - running.startedAt) / 1000;
    body = (
      <div className="space-y-3" data-testid="stems-running">
        {!same && <p className="text-[11px] text-amber-300">Une séparation est déjà en cours sur « {running.target.clipName} ».</p>}
        <ProgressBar pct={running.pct} label={`Séparation à ${Math.round(running.pct)} % · ${running.message}`} />
        <p className="text-[11px] text-slate-400">
          Calcul {running.device === 'cuda' ? 'sur la carte graphique' : 'sur le processeur'} · {formatSeconds(elapsed)} écoulées.
          Compte environ 20 à 40 s par minute de son sur le processeur. Tu peux fermer cette fenêtre.
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={cancel} className={`${secondary} flex-1`}>Annuler</button>
          <button type="button" onClick={onClose} className={`${primary} flex-[2]`}>Continuer en arrière-plan</button>
        </div>
      </div>
    );
  } else {
    const choice = (n: StemCount, title: string, detail: string, uses: string) => (
      <label className={`flex items-start gap-3 rounded-2xl border p-3 cursor-pointer ${count === n ? 'border-cyan-400 bg-cyan-500/10' : 'border-white/10 hover:bg-white/[0.04]'}`}>
        <input type="radio" name="stems-count" className="mt-1" checked={count === n} onChange={() => setCount(n)} />
        <span>
          <span className="block text-[13px] font-bold text-white">{title}</span>
          <span className="block text-[11px] text-slate-300">{detail}</span>
          <span className="block text-[11px] text-slate-500">{uses}</span>
        </span>
      </label>
    );
    body = (
      <div className="space-y-3" data-testid="stems-ready">
        {finished?.phase === 'done' && <p className="text-[12px] text-emerald-300" role="status">✅ {finished.summary}</p>}
        {(finished?.phase === 'error' || moduleError) && <p className="text-[12px] text-rose-300" role="alert">❌ {finished?.error || moduleError}</p>}
        <div role="radiogroup" aria-label="Nombre de stems" className="space-y-2">
          {choice(2, 'Voix + instru (2 stems)', 'Voix (stem) et Instru (stem).', 'Enlever la voix d’une instru (karaoké, beat), isoler la voix d’un morceau de référence.')}
          {choice(4, 'Voix, batterie, basse, autres (4 stems)', 'Une piste par famille d’instruments.', 'Refaire un sample, récupérer une batterie ou une ligne de basse.')}
        </div>
        <p className="text-[11px] text-slate-500">
          Les stems arrivent en nouvelles pistes calées au même endroit ; le clip d’origine est coupé (M pour le réentendre).
          Les WAV sont aussi rangés dans {module?.outputRoot || 'Documents\\Nova Studio\\Stems'}.
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={`${secondary} flex-1`}>{finished?.phase === 'done' ? 'Fermer' : 'Annuler'}</button>
          <button type="button" onClick={start} className={`${primary} flex-[2]`} data-testid="stems-start">
            {finished?.phase === 'error' ? 'Réessayer' : `Séparer en ${count} stems`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="stems-title" data-testid="stems-dialog"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md rounded-3xl border border-cyan-500/30 bg-[#121418] p-6 shadow-2xl space-y-4">
        <div>
          <h2 id="stems-title" className="text-lg font-black text-white" title={STEMS_TOOLTIP}>Séparer en stems</h2>
          <p className="mt-1 text-[12px] text-slate-400 truncate">« {target.clipName} » · comme Stem Splitter (Logic) et Stem Separation (FL Studio)</p>
        </div>
        {body}
      </div>
    </div>
  );
};

export default StemSeparationDialog;
