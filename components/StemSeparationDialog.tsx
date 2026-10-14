import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { novaBridge, BridgeState, SeparationResult, StemsError, StemsModuleStatus } from '../services/NovaBridge';
import {
  bufferChannels, catalogueStemsAllowed, CATALOGUE_STEMS_REFUSAL, describeStemsError, formatSeconds, installProgressLabel,
  LEADBACK_CREDIT, StemSet, STEM_SET_CHOICES, STEM_SET_ORDER, stemMidiConversion, stemSetDownload, stemsAvailability,
  StemsRights, STEMS_INSTALL_LABEL, STEMS_TOOLTIP,
} from '../services/StemSeparation';
import { billingStatus, exportAccess } from '../services/Billing';
import { DESKTOP_APP_DOWNLOAD_URL, isNovaDesktop } from '../utils/desktopApp';
import { openNovaWindow } from '../utils/novaWindows';

/**
 * « Séparer en stems » (menu du clip) : comme Stem Splitter dans Logic, Stem Separation
 * dans FL Studio ou Splitter dans BandLab. 2, 4 ou 6 stems, ou voix lead / chœurs. Le calcul
 * tourne sur le PC (appli Windows, module Demucs installé à la demande ; modèles 6 stems et
 * voix lead / chœurs téléchargés à la première séparation qui les demande) ; fermer la
 * fenêtre ne l'arrête pas : une pastille en bas à droite garde la progression et Annuler.
 * Après la séparation : « Basse → MIDI », « Piano → MIDI »… (fenêtre Audio → MIDI).
 */

export interface StemTarget { trackId: string; clipId: string; clipName: string }

/** Piste de stem posée dans le projet (pour l'enchaîner sur « Audio → MIDI »). */
export interface AppliedStem { key: string; name: string; trackId: string; clipId: string }

interface Job {
  jobId: string;
  target: StemTarget;
  stems: StemSet;
  phase: 'running' | 'done' | 'error';
  pct: number;
  message: string;
  device?: string;
  download?: boolean;
  startedAt: number;
  error?: string;
  summary?: string;
  outdir?: string;
  applied?: AppliedStem[];
}

// --- Séparation en cours (survit à la fermeture de la fenêtre) -----------------------
let job: Job | null = null;
const jobListeners = new Set<() => void>();
const setJob = (j: Job | null) => { job = j; jobListeners.forEach(cb => cb()); };
const patchJob = (id: string, p: Partial<Job>) => { if (job && job.jobId === id) setJob({ ...job, ...p }); };
// Séparations annulées par l'utilisateur : si le PC finit quand même (clic « Annuler » pendant
// l'écriture des WAV, ~3 s en tout sur la carte graphique), le résultat est ignoré, aucune
// piste n'est ajoutée (avant : « Annuler » à 96 % ajoutait quand même les 4 pistes).
const cancelledJobs = new Set<string>();
const useJob = () => useSyncExternalStore(cb => { jobListeners.add(cb); return () => { jobListeners.delete(cb); }; }, () => job);

novaBridge.onStemsEvent(e => {
  if (e.kind !== 'separate' || !job || e.jobId !== job.jobId) return;
  if (e.event === 'progress') patchJob(job.jobId, { pct: Math.max(job.pct, e.pct ?? job.pct), message: e.message || job.message, download: e.phase === 'download' });
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
  /** Pose les pistes ; renvoie les pistes posées (null si le clip a disparu pendant le calcul). */
  onApply: (target: StemTarget, result: SeparationResult, set: StemSet) => AppliedStem[] | null;
  onClose: () => void;
  /** D'où vient le clip (fichier à soi, piste BEAT, beat du catalogue) : règles de licence. */
  rights?: StemsRights;
  /** Clé d'export du projet (vérification de la licence par le serveur, comme l'export). */
  projectKey?: string;
  /** Fiche d'achat du beat (même bouton que l'export). */
  onBuyBeat?: () => void;
}

const btn = 'min-h-11 px-3 py-2 rounded-xl text-[12px] leading-tight font-black transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
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

/** Ordre de grandeur du temps de calcul (mesuré le 14/10/2026 sur un morceau de 3 min 10 : RTX 5090
 *  5 à 8 s ; processeur du PC du studio 35 à 43 s, voix lead / chœurs 84 s). */
const timeHint = (set: StemSet, device?: string) => {
  if (device === 'cuda') return 'Compte 2 à 3 s par minute de son sur la carte graphique.';
  if (set === 'leadback') return 'Compte environ 30 s par minute de son sur un processeur récent (jusqu’à 1 min 20 sur un PC plus ancien).';
  return 'Compte environ 15 s par minute de son sur un processeur récent (jusqu’à 40 s sur un PC plus ancien).';
};

const setLabel = (s: StemSet) => (s === 'leadback' ? 'voix lead / chœurs' : `${s} stems`);

const StemSeparationDialog: React.FC<Props> = ({ target, projectName, getClipBuffer, onApply, onClose, rights = { kind: 'own' }, projectKey, onBuyBeat }) => {
  const bridge = useBridge();
  const current = useJob();
  const [module, setModule] = useState<StemsModuleStatus | null>(null);
  const [moduleError, setModuleError] = useState<string | null>(null);
  const [count, setCount] = useState<StemSet>(2);
  const [connecting, setConnecting] = useState(false);
  const [cancelledNote, setCancelledNote] = useState(false);
  // Beat du catalogue : la licence est vérifiée par le serveur (comme l'export du mix).
  const [licence, setLicence] = useState<'checking' | 'ok' | 'refused' | 'error' | null>(null);
  const [licenceTick, setLicenceTick] = useState(0);
  const availability = stemsAvailability(bridge, isNovaDesktop());
  const catalogId = rights.kind === 'catalogue' ? rights.catalogId : null;

  // Appli Windows : le pont démarre avec elle, on s'y connecte tout seul (un essai).
  useEffect(() => {
    if (!target || availability !== 'connect') return;
    setConnecting(true);
    novaBridge.connect().finally(() => setConnecting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  useEffect(() => {
    if (!target || !catalogId) { setLicence(null); return; }
    let alive = true;
    setLicence('checking');
    Promise.all([
      exportAccess({ projectKey: projectKey || 'stems', catalogIds: [catalogId], kits: false, scope: 'mix' }),
      billingStatus(),
    ]).then(([a, st]) => {
      if (!alive) return;
      if (a.reason === 'erreur' && !st.admin) setLicence('error');
      else setLicence(catalogueStemsAllowed(a, catalogId, !!st.admin) ? 'ok' : 'refused');
    }).catch(() => { if (alive) setLicence('error'); });
    return () => { alive = false; };
  }, [target, catalogId, projectKey, licenceTick]);

  // État du module à l'ouverture, puis suivi de l'installation.
  useEffect(() => {
    if (!target || availability !== 'ok') return;
    let alive = true;
    novaBridge.stemsStatus().then(s => { if (alive) { setModule(s); setModuleError(null); } })
      .catch(e => { if (alive) setModuleError(describeStemsError(e)); });
    const off = novaBridge.onStemsEvent(e => {
      if (e.kind !== 'install') return;
      setModule(m => {
        const base: StemsModuleStatus = m || { installed: false, installing: true, install: null, variant: null, sizeBytes: null, outputRoot: null, sets: null };
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
    setCancelledNote(false);
    const jobId = `stems-${Date.now().toString(36)}`;
    const t = target;
    const set = count;
    setJob({ jobId, target: t, stems: set, phase: 'running', pct: 0, message: 'Envoi du clip au PC', startedAt: Date.now() });
    try {
      const res = await novaBridge.separateStems({
        jobId, channels: bufferChannels(buffer), sampleRate: buffer.sampleRate, stems: set, project: projectName, clip: t.clipName,
        // Beat (piste BEAT ou catalogue) : aucun WAV gardé sur le PC, comme le gel refuse de le rendre en fichier.
        keepFiles: rights.kind === 'own',
      });
      if (cancelledJobs.delete(jobId)) return;
      const applied = onApply(t, res, set);
      if (!applied) throw new StemsError('Le clip a été supprimé pendant la séparation : rien n’a été ajouté.', 'error');
      patchJob(jobId, {
        phase: 'done', pct: 100, applied, outdir: res.outdir,
        summary: `${applied.length} pistes ajoutées : ${applied.map(a => a.name).join(', ')} (en ${formatSeconds(res.seconds)}${res.device === 'cuda' ? ', carte graphique' : ''})`,
      });
      // Les tailles « à télécharger » ne valent plus rien après un premier usage.
      novaBridge.stemsStatus().then(setModule).catch(() => undefined);
    } catch (e) {
      if (cancelledJobs.delete(jobId)) return;
      if ((e as StemsError)?.code === 'cancelled') { if (job?.jobId === jobId) setJob(null); return; }
      patchJob(jobId, { phase: 'error', error: describeStemsError(e) });
      if ((e as StemsError)?.code === 'not_installed') setModule(m => (m ? { ...m, installed: false } : m));
    }
  };

  const cancel = () => {
    if (!current || current.phase !== 'running') return;
    cancelledJobs.add(current.jobId);
    novaBridge.stemsCancel({ jobId: current.jobId }).catch(() => undefined);
    setJob(null);
    setCancelledNote(true);
  };

  const toMidi = (a: AppliedStem) => {
    const conv = stemMidiConversion(a.key);
    if (!conv) return;
    onClose();
    openNovaWindow('audio-to-midi', { targets: [{ trackId: a.trackId, clipId: a.clipId }], convert: { mode: conv.mode, ...(conv.instrument ? { instrument: conv.instrument } : {}) } });
  };

  const MidiButtons: React.FC<{ applied?: AppliedStem[]; compact?: boolean }> = ({ applied, compact }) => {
    const list = (applied || []).filter(a => stemMidiConversion(a.key));
    if (!list.length) return null;
    return (
      <div className="space-y-1.5" data-testid="stems-midi">
        {!compact && <p className="text-[11px] text-slate-400">Transformer un stem en piste MIDI (aperçu avant de valider, Ctrl+Z pour revenir) :</p>}
        <div className="flex flex-wrap gap-1.5">
          {list.map(a => {
            const conv = stemMidiConversion(a.key)!;
            return (
              <button key={a.trackId} type="button" onClick={() => toMidi(a)} title={conv.tip}
                className="min-h-9 px-2.5 py-1.5 rounded-lg border border-fuchsia-400/40 bg-fuchsia-500/10 text-[11px] font-bold text-fuchsia-100 hover:bg-fuchsia-500/20">
                🎹 {conv.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  // --- Pastille (fenêtre fermée, séparation qui continue ou vient de finir) ---------------
  if (!target) {
    if (!current) return null;
    return (
      <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[650] sm:w-80 rounded-2xl border border-cyan-500/30 bg-nv-surface/95 p-3 shadow-2xl space-y-2" data-testid="stems-pill" title={STEMS_TOOLTIP}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-black text-white truncate">Stems ({setLabel(current.stems)}) · {current.target.clipName}</span>
          {current.phase !== 'running' && <button type="button" aria-label="Fermer" onClick={() => setJob(null)} className="min-h-9 min-w-9 text-slate-400 hover:text-white text-[16px]">×</button>}
        </div>
        {current.phase === 'running' && <>
          <ProgressBar pct={current.pct} label={`${Math.round(current.pct)} % · ${current.message}`} />
          <button type="button" onClick={cancel} className="min-h-9 text-[11px] font-bold text-rose-300 hover:text-rose-200">Annuler</button>
        </>}
        {current.phase === 'done' && <><p className="text-[11px] text-emerald-300">✅ {current.summary}</p><MidiButtons applied={current.applied} compact /></>}
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
          La séparation de stems (2, 4 ou 6 stems, voix lead / chœurs) tourne <b>sur ton PC</b>, gratuitement, dans l’appli Windows <b>Nova Studio</b> :
          le site seul (ordinateur ou téléphone) n’a pas la puissance de calcul nécessaire.
        </p>
        <p className="text-[11px] text-slate-400">Ouvre ton projet dans l’appli Windows (il est dans ton compte), puis clic droit sur le clip → « Séparer en stems ».</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <button type="button" onClick={onClose} className={`${secondary} sm:flex-1`}>Fermer</button>
          <a href={DESKTOP_APP_DOWNLOAD_URL} className={`${primary} sm:flex-[2] flex items-center justify-center`}>Télécharger Nova Studio pour Windows</a>
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
  } else if (licence === 'checking') {
    body = <p className="text-[12px] text-slate-400" data-testid="stems-licence-checking">Vérification de ta licence pour ce beat…</p>;
  } else if (licence === 'refused') {
    body = (
      <div className="space-y-3" data-testid="stems-licence-refused">
        <p className="text-[12px] text-amber-200" role="alert">🔒 {CATALOGUE_STEMS_REFUSAL}</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <button type="button" onClick={onClose} className={`${secondary} sm:flex-1`}>Fermer</button>
          {onBuyBeat && <button type="button" onClick={onBuyBeat} className={`${btn} sm:flex-[2] bg-amber-400 text-black hover:bg-amber-300`}>🛒 Acheter cette instru</button>}
        </div>
      </div>
    );
  } else if (licence === 'error') {
    body = (
      <div className="space-y-3" data-testid="stems-licence-error">
        <p className="text-[12px] text-rose-300" role="alert">Impossible de vérifier la licence de ce beat (connexion ?). Réessaie dans un instant.</p>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={`${secondary} flex-1`}>Fermer</button>
          <button type="button" onClick={() => setLicenceTick(x => x + 1)} className={`${primary} flex-[2]`}>Réessayer</button>
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
          <li>6 stems et voix lead / chœurs : petit modèle en plus (55 à 270 Mo), téléchargé la première fois que tu les choisis.</li>
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
        <ProgressBar pct={running.pct} label={`${running.download ? 'Téléchargement' : 'Séparation'} à ${Math.round(running.pct)} % · ${running.message}`} />
        <p className="text-[11px] text-slate-400">
          {running.download
            ? 'Premier usage de ce choix : le modèle se télécharge une seule fois, puis la séparation démarre.'
            : `Calcul ${running.device === 'cuda' ? 'sur la carte graphique' : 'sur le processeur'} · ${formatSeconds(elapsed)} écoulées. ${timeHint(running.stems, running.device)}`}
          {' '}Tu peux fermer cette fenêtre.
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={cancel} className={`${secondary} flex-1`}>Annuler</button>
          <button type="button" onClick={onClose} className={`${primary} flex-[2]`}>Continuer en arrière-plan</button>
        </div>
      </div>
    );
  } else {
    const supported = (s: StemSet) => novaBridge.supportsStemSet(s);
    const choice = (n: StemSet) => {
      const c = STEM_SET_CHOICES[String(n)];
      const ok = supported(n);
      const dl = ok ? stemSetDownload(n, module) : null;
      return (
        <label key={String(n)} className={`flex items-start gap-3 rounded-2xl border p-3 ${ok ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'} ${count === n ? 'border-cyan-400 bg-cyan-500/10' : 'border-white/10 hover:bg-white/[0.04]'}`}
          data-testid={`stems-choice-${n}`}>
          <input type="radio" name="stems-count" className="mt-1" checked={count === n} disabled={!ok} onChange={() => setCount(n)} aria-describedby={`stems-choice-${n}-uses`} />
          <span className="min-w-0">
            <span className="block text-[13px] font-bold text-white">{c.title}</span>
            <span className="block text-[11px] text-slate-300">{c.detail}</span>
            <span id={`stems-choice-${n}-uses`} className="block text-[11px] text-slate-500">{c.uses}</span>
            {c.note && <span className="block text-[11px] text-slate-500">{c.note}</span>}
            {dl && <span className="mt-0.5 inline-block rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] font-bold text-cyan-200" data-testid={`stems-download-${n}`}>⬇ {dl}</span>}
            {!ok && <span className="block text-[11px] text-amber-300">Mets à jour Nova Studio pour Windows pour ce choix.</span>}
          </span>
        </label>
      );
    };
    const dlNow = stemSetDownload(count, module);
    body = (
      <div className="space-y-3" data-testid="stems-ready">
        {finished?.phase === 'done' && <p className="text-[12px] text-emerald-300" role="status">✅ {finished.summary}</p>}
        {finished?.phase === 'done' && <MidiButtons applied={finished.applied} />}
        {cancelledNote && !finished && <p className="text-[12px] text-slate-300" role="status" data-testid="stems-cancelled">Séparation annulée : aucune piste ajoutée.</p>}
        {(finished?.phase === 'error' || moduleError) && <p className="text-[12px] text-rose-300" role="alert" data-testid="stems-error">❌ {finished?.error || moduleError}</p>}
        <div role="radiogroup" aria-label="Choix des stems" className="space-y-2">
          {STEM_SET_ORDER.map(choice)}
        </div>
        {rights.kind !== 'own' && (
          <p className="text-[11px] text-amber-200/90" data-testid="stems-beat-note">
            🔒 Stems du beat : ils gardent la licence du beat (jamais gelés en fichier, samplés ni envoyés à l’ingé ; export selon ta licence) et aucun WAV n’est gardé sur ton PC.
          </p>
        )}
        <p className="text-[11px] text-slate-500">
          Les stems arrivent en nouvelles pistes calées au même endroit ; le clip d’origine est coupé (M pour le réentendre).
          {rights.kind === 'own' && <> Les WAV sont aussi rangés dans {module?.outputRoot || 'Documents\\Nova Studio\\Stems'}.</>}
        </p>
        {count === 'leadback' && <p className="text-[10px] text-slate-500" data-testid="stems-credit">{LEADBACK_CREDIT}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={`${secondary} flex-1`}>{finished?.phase === 'done' ? 'Fermer' : 'Annuler'}</button>
          <button type="button" onClick={start} disabled={!supported(count)} className={`${primary} flex-[2]`} data-testid="stems-start">
            {finished?.phase === 'error' ? 'Réessayer' : count === 'leadback' ? 'Séparer voix lead / chœurs' : `Séparer en ${count} stems`}
            {dlNow && <span className="block text-[10px] font-bold text-black/70">{dlNow.replace('+', 'téléchargement : ')}</span>}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/70 p-2 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="stems-title" data-testid="stems-dialog"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md max-h-[92vh] overflow-y-auto rounded-3xl border border-cyan-500/30 bg-nv-surface p-4 sm:p-6 shadow-2xl space-y-4">
        <div>
          <h2 id="stems-title" className="text-lg font-black text-white" title={STEMS_TOOLTIP}>Séparer en stems</h2>
          <p className="mt-1 text-[12px] text-slate-300 truncate">« {target.clipName} »</p>
          <p className="text-[11px] text-slate-500">Comme Stem Splitter (Logic), Stem Separation (FL Studio) et Splitter (BandLab)</p>
        </div>
        {body}
      </div>
    </div>
  );
};

export default StemSeparationDialog;
