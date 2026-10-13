/**
 * R24 · Voix par l'IA locale (appli Windows) : « Retirer la réverbe de la pièce… »
 * et « Transcrire les paroles… » (menu du clip).
 *
 * Le calcul tourne sur le PC (pont, module installé à la demande, taille annoncée,
 * barre de progression). Fermer la fenêtre ne l'arrête pas : une pastille en bas à
 * droite garde la progression et le bouton Annuler.
 *  - Réverbe : la voix revient traitée à 100 % ; le dosage (0–100 %) et l'écoute
 *    avant / après se règlent ici, sans recalcul. « Appliquer » = AudioSuite (R6) :
 *    l'original est gardé (menu du clip → Revenir à l'original).
 *  - Paroles : mots horodatés rangés dans le clip, texte dans le prompteur et
 *    l'onglet Paroles (une seule annulation).
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DAWState, Track } from '../types';
import { novaBridge, BridgeState, VoiceError, VoiceFeature, VoiceModuleStatus } from '../services/NovaBridge';
import {
  applyTranscriptions, blendDeverb, CPU_FALLBACK_NOTE, DEFAULT_DEVERB_AMOUNT, DEFAULT_LANGUAGE, DEVERB_TOOLTIP, deverbBlock, deverbPatch, deverbRegion, describeVoiceError,
  formatBytes, installButtonLabel, LANGUAGE_OPTIONS, LyricsMode, progressLabel, sliceChannels, TranscribedClip,
  TranscribeLanguage, transcribeBlock, transcribeRegion, transcriptionSummary, TRANSCRIBE_TOOLTIP, voiceAvailability,
} from '../services/VoiceAI';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { patchClip } from '../utils/clipProcess';
import { DESKTOP_APP_DOWNLOAD_URL, isNovaDesktop } from '../utils/desktopApp';
import { openNovaWindow } from '../utils/novaWindows';

export type VoiceMode = 'deverb' | 'transcribe';
export interface VoiceTarget { trackId: string; clipId: string }

interface DeverbData { trackId: string; clipId: string; clipName: string; from: number; sampleRate: number; orig: Float32Array[]; wet: Float32Array[]; rt60?: number }

interface Job {
  id: string;
  mode: VoiceMode;
  targets: VoiceTarget[];
  label: string;
  phase: 'running' | 'ready' | 'done' | 'error';
  pct: number;
  message: string;
  device?: string;
  startedAt: number;
  seconds?: number;
  error?: string;
  summary?: string;
  deverb?: DeverbData;
}

// --- Calcul en cours (survit à la fermeture de la fenêtre) ---------------------------
let job: Job | null = null;
const jobListeners = new Set<() => void>();
const setJob = (j: Job | null) => { job = j; jobListeners.forEach(cb => cb()); };
const patchJob = (id: string, p: Partial<Job>) => { if (job && job.id === id) setJob({ ...job, ...p }); };
const useJob = () => useSyncExternalStore(cb => { jobListeners.add(cb); return () => { jobListeners.delete(cb); }; }, () => job);

novaBridge.onVoiceEvent(e => {
  if (e.kind === 'install' || !job || e.jobId !== job.id) return;
  if (e.event === 'progress') patchJob(job.id, { pct: Math.max(job.pct, e.pct ?? job.pct), message: e.message || job.message });
  else if (e.event === 'device') patchJob(job.id, { device: e.device });
  else if (e.event === 'fallback') patchJob(job.id, { device: 'cpu', message: e.message || job.message });
});

const useBridge = () => {
  const [s, setS] = useState<BridgeState>(novaBridge.getBridgeState());
  useEffect(() => novaBridge.subscribe(setS), []);
  return s;
};

const notify = (detail: string) => { try { window.dispatchEvent(new CustomEvent('nova:notify', { detail })); } catch { /* hors navigateur */ } };
const openLyrics = () => { try { window.dispatchEvent(new CustomEvent('nova:open-lyrics')); } catch { /* hors navigateur */ } };

const TITLES: Record<VoiceMode, string> = { deverb: 'Retirer la réverbe de la pièce', transcribe: 'Transcrire les paroles' };
const FEATURE: Record<VoiceMode, VoiceFeature> = { deverb: 'deverb', transcribe: 'transcribe' };

const btn = 'min-h-11 px-3 py-2 rounded-xl text-[12px] leading-tight font-black transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const primary = `${btn} bg-cyan-500 text-black hover:bg-cyan-400`;
const secondary = `${btn} border border-nv-line text-nv-ink hover:bg-nv-accent/10 font-bold`;

const ProgressBar: React.FC<{ pct: number; label: string; testid?: string }> = ({ pct, label, testid }) => (
  <div className="space-y-1.5" data-testid={testid}>
    <div className="h-2.5 rounded-full bg-nv-well overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={label}>
      <div className="h-full bg-gradient-to-r from-cyan-500 to-fuchsia-500 transition-all duration-300" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </div>
    <p className="text-[11px] text-nv-muted">{label}</p>
  </div>
);

// --- Écoute avant / après : la voix d'origine et la voix traitée jouent ensemble, le dosage
// change seulement leurs volumes (bascule instantanée, au même endroit). -------------------
class AbPlayer {
  private ctx: AudioContext | null = null;
  private srcs: AudioBufferSourceNode[] = [];
  private gO: GainNode | null = null;
  private gW: GainNode | null = null;
  onEnd: (() => void) | null = null;

  play(d: DeverbData, amount: number, after: boolean) {
    this.stop();
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return;
    if (!this.ctx) this.ctx = new Ctor({ sampleRate: d.sampleRate });
    const ctx = this.ctx!;
    const mk = (chs: Float32Array[]) => {
      const b = ctx.createBuffer(chs.length, chs[0].length, d.sampleRate);
      chs.forEach((c, i) => b.copyToChannel(c, i));
      return b;
    };
    this.gO = ctx.createGain();
    this.gW = ctx.createGain();
    this.gO.connect(ctx.destination);
    this.gW.connect(ctx.destination);
    const so = ctx.createBufferSource(); so.buffer = mk(d.orig); so.connect(this.gO);
    const sw = ctx.createBufferSource(); sw.buffer = mk(d.wet); sw.connect(this.gW);
    this.set(amount, after);
    const t = ctx.currentTime + 0.05;
    so.start(t); sw.start(t);
    so.onended = () => { if (this.srcs[0] === so) { this.srcs = []; this.onEnd?.(); } };
    this.srcs = [so, sw];
    void ctx.resume();
  }

  set(amount: number, after: boolean) {
    if (!this.ctx || !this.gO || !this.gW) return;
    const a = after ? Math.max(0, Math.min(1, amount)) : 0;
    const now = this.ctx.currentTime;
    this.gO.gain.setTargetAtTime(1 - a, now, 0.01);
    this.gW.gain.setTargetAtTime(a, now, 0.01);
  }

  stop() {
    this.srcs.forEach(s => { try { s.onended = null; s.stop(); } catch { /* déjà arrêté */ } });
    this.srcs = [];
  }

  close() { this.stop(); if (this.ctx) { void this.ctx.close().catch(() => undefined); this.ctx = null; } }
}

interface Props {
  request: { mode: VoiceMode; targets: VoiceTarget[] } | null;
  tracks: Track[];
  lyrics: string;
  setState: (fn: (prev: DAWState) => DAWState) => void;
  onClose: () => void;
}

const VoiceAIDialog: React.FC<Props> = ({ request, tracks, lyrics, setState, onClose }) => {
  const bridge = useBridge();
  const current = useJob();
  const [module, setModule] = useState<VoiceModuleStatus | null>(null);
  const [moduleError, setModuleError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [language, setLanguage] = useState<TranscribeLanguage>(DEFAULT_LANGUAGE);
  const [lyricsMode, setLyricsMode] = useState<LyricsMode>('keep');
  const [showOnClip, setShowOnClip] = useState(true);
  const [amount, setAmount] = useState(DEFAULT_DEVERB_AMOUNT);
  const [after, setAfter] = useState(true);
  const [playing, setPlaying] = useState(false);
  const player = useRef<AbPlayer | null>(null);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const availability = voiceAvailability(bridge, isNovaDesktop());
  const mode = request?.mode;
  const feature = mode ? FEATURE[mode] : null;

  // Appli Windows : le pont démarre avec elle, on s'y connecte tout seul (un essai).
  useEffect(() => {
    if (!request || availability !== 'connect') return;
    setConnecting(true);
    novaBridge.connect().finally(() => setConnecting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // État du module à l'ouverture, puis suivi de l'installation.
  useEffect(() => {
    if (!request || availability !== 'ok') return;
    let alive = true;
    novaBridge.voiceStatus().then(s => { if (alive) { setModule(s); setModuleError(null); } })
      .catch(e => { if (alive) setModuleError(describeVoiceError(e)); });
    const off = novaBridge.onVoiceEvent(e => {
      if (e.kind !== 'install') return;
      if (e.event === 'done' || e.event === 'error' || e.event === 'cancelled') {
        novaBridge.voiceStatus().then(s => { if (alive) setModule({ ...s, install: e }); }).catch(() => undefined);
        return;
      }
      setModule(m => (m ? { ...m, installing: true, installFeature: (e.feature as VoiceFeature) || m.installFeature, install: e } : m));
    });
    return () => { alive = false; off(); };
  }, [request, availability]);

  useEffect(() => {
    if (!request) return;
    setLyricsMode(lyrics.trim() ? 'keep' : 'replace');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    if (request) return;
    player.current?.close();
    player.current = null;
    setPlaying(false);
  }, [request]);
  useEffect(() => () => { player.current?.close(); }, []);
  useEffect(() => { player.current?.set(amount, after); }, [amount, after]);
  // Fenêtre fermée, transcription finie : le résumé est déjà parti en notification ; la pastille
  // s'efface seule (elle cachait l'avis suivant, en bas à droite).
  useEffect(() => {
    if (request || !current || current.phase !== 'done') return;
    const done = current;
    const t = window.setTimeout(() => { if (job === done) setJob(null); }, 6000);
    return () => window.clearTimeout(t);
  }, [request, current]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, onClose]);

  const resolve = (t: VoiceTarget) => {
    const tr = tracksRef.current.find(x => x.id === t.trackId);
    const c = tr?.clips.find(x => x.id === t.clipId);
    return tr && c ? { track: tr, clip: c, buffer: c.buffer || (c.bufferId ? audioBufferRegistry.get(c.bufferId) : null) } : null;
  };

  const install = async () => {
    if (!feature) return;
    setModuleError(null);
    try {
      const s = await novaBridge.voiceInstall(feature, 'auto');
      setModule(s);
      if (!s.started && s.installing) setModuleError('Une autre installation est en cours : attends qu’elle finisse.');
    } catch (e) { setModuleError(describeVoiceError(e)); }
  };

  // --- Lancer le calcul -----------------------------------------------------------------
  const startDeverb = async () => {
    if (!request) return;
    const t = request.targets[0];
    const r = resolve(t);
    const block = deverbBlock(r?.clip);
    if (!r || block) { setModuleError(block || 'Clip introuvable.'); return; }
    if (!r.buffer) { setModuleError('Le son de ce clip n’est pas encore chargé.'); return; }
    const reg = deverbRegion(r.clip, r.buffer.duration);
    const orig = sliceChannels(r.buffer, reg.from, reg.to);
    const id = `voice-${Date.now().toString(36)}`;
    setJob({ id, mode: 'deverb', targets: [t], label: r.clip.name, phase: 'running', pct: 0, message: 'Envoi de la voix au PC', startedAt: Date.now() });
    try {
      const res = await novaBridge.deverbVoice({ jobId: id, channels: orig, sampleRate: r.buffer.sampleRate });
      patchJob(id, { phase: 'ready', pct: 100, seconds: res.seconds, device: res.device,
        deverb: { trackId: t.trackId, clipId: t.clipId, clipName: r.clip.name, from: reg.from, sampleRate: res.sampleRate, orig, wet: res.channels, ...(res.rt60 ? { rt60: res.rt60 } : {}) } });
    } catch (e) {
      if ((e as VoiceError)?.code === 'cancelled') { setJob(null); return; }
      patchJob(id, { phase: 'error', error: describeVoiceError(e) });
    }
  };

  const startTranscribe = async () => {
    if (!request) return;
    const items = request.targets.map(t => ({ t, r: resolve(t) }));
    const bad = items.map(({ r }) => transcribeBlock(r?.clip, !!r?.buffer)).find(Boolean);
    if (bad) { setModuleError(bad); return; }
    const id = `voice-${Date.now().toString(36)}`;
    const label = items.length > 1 ? `${items.length} clips` : items[0].r!.clip.name;
    const opts = { mode: lyricsMode, show: showOnClip, language };
    setJob({ id, mode: 'transcribe', targets: request.targets, label, phase: 'running', pct: 0, message: 'Envoi de la voix au PC', startedAt: Date.now() });
    const results: TranscribedClip[] = [];
    let device = 'cpu';
    let seconds = 0;
    try {
      for (let i = 0; i < items.length; i++) {
        const { t, r } = items[i];
        const reg = transcribeRegion(r!.clip, r!.buffer!.duration);
        const sub = `${id}-${i}`;
        // La progression de chaque clip remonte sous l'identifiant du calcul.
        const off = novaBridge.onVoiceEvent(e => {
          if (e.jobId !== sub || !job || job.id !== id) return;
          if (e.event === 'progress') patchJob(id, { pct: Math.round(((i + (e.pct || 0) / 100) / items.length) * 100), message: items.length > 1 ? `Clip ${i + 1}/${items.length} · ${e.message || ''}` : (e.message || '') });
          else if (e.event === 'device') patchJob(id, { device: e.device });
          else if (e.event === 'fallback') patchJob(id, { device: 'cpu', message: e.message || '' });
        });
        try {
          const res = await novaBridge.transcribeVoice({ jobId: sub, channels: sliceChannels(r!.buffer!, reg.from, reg.to), sampleRate: r!.buffer!.sampleRate, language: opts.language });
          results.push({ trackId: t.trackId, clipId: t.clipId, words: res.words, from: reg.from, bufferId: r!.clip.bufferId, language: res.language, model: res.model });
          device = res.device;
          seconds += res.seconds;
        } finally { off(); }
        if (!job || job.id !== id) return; // annulé
      }
      const n = results.reduce((a, x) => a + x.words.length, 0);
      if (!n) throw new VoiceError('Aucune parole reconnue : le clip est-il bien une voix (pas une instru) ?', 'error');
      setState(prev => applyTranscriptions(prev, results, { mode: opts.mode, show: opts.show }));
      const summary = transcriptionSummary(results, seconds, device);
      patchJob(id, { phase: 'done', pct: 100, summary, device, seconds });
      notify(summary);
    } catch (e) {
      if ((e as VoiceError)?.code === 'cancelled') { setJob(null); return; }
      patchJob(id, { phase: 'error', error: describeVoiceError(e) });
    }
  };

  const cancel = () => {
    if (!current) return;
    const ids = current.mode === 'transcribe' ? current.targets.map((_, i) => `${current.id}-${i}`) : [current.id];
    ids.forEach(jobId => novaBridge.voiceCancel({ jobId }).catch(() => undefined));
    if (current.mode === 'transcribe') setJob(null);
  };

  const applyDeverb = () => {
    const d = current?.deverb;
    if (!d) return;
    player.current?.stop();
    setPlaying(false);
    const r = resolve({ trackId: d.trackId, clipId: d.clipId });
    if (!r) { patchJob(current!.id, { phase: 'error', error: 'Le clip a été supprimé : rien n’a été changé.' }); return; }
    const mixed = blendDeverb(d.orig, d.wet, amount);
    const buf = new AudioBuffer({ numberOfChannels: mixed.length, length: mixed[0].length, sampleRate: d.sampleRate });
    mixed.forEach((c, i) => buf.copyToChannel(c, i));
    const id = `dv-${d.clipId}-${Date.now().toString(36)}`;
    audioBufferRegistry.register(buf, id);
    const patch = deverbPatch(r.clip, { newBufferId: id, from: d.from, amount });
    setState(prev => ({ ...prev, tracks: prev.tracks.map(t => (t.id === d.trackId ? { ...t, clips: t.clips.map(c => (c.id === d.clipId ? patchClip(c, patch) : c)) } : t)) }));
    notify(`🎙️ Réverbe de la pièce retirée à ${Math.round(amount * 100)} % sur « ${d.clipName} ». L’original est gardé : menu du clip → « Revenir à l’original ». Ctrl+Z pour annuler.`);
    setJob(null);
    onClose();
  };

  const togglePlay = () => {
    const d = current?.deverb;
    if (!d) return;
    if (!player.current) player.current = new AbPlayer();
    if (playing) { player.current.stop(); setPlaying(false); return; }
    player.current.onEnd = () => setPlaying(false);
    player.current.play(d, amount, after);
    setPlaying(true);
  };

  // --- Pastille (fenêtre fermée, calcul qui continue ou vient de finir) ---------------------
  if (!request) {
    if (!current) return null;
    return (
      <div className="fixed bottom-4 right-4 z-[650] w-72 rounded-2xl border border-cyan-500/30 bg-nv-panel/95 p-3 text-nv-ink shadow-2xl space-y-2" data-testid="voice-pill"
        title={current.mode === 'deverb' ? DEVERB_TOOLTIP : TRANSCRIBE_TOOLTIP}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-black truncate">{current.mode === 'deverb' ? 'Réverbe' : 'Paroles'} · {current.label}</span>
          {current.phase !== 'running' && <button type="button" aria-label="Fermer" onClick={() => setJob(null)} className="text-nv-muted hover:text-nv-ink text-[14px] h-8 w-8">×</button>}
        </div>
        {current.phase === 'running' && <>
          <ProgressBar pct={current.pct} label={`${Math.round(current.pct)} % · ${current.message}`} />
          <button type="button" onClick={cancel} className="text-[11px] font-bold text-rose-500 hover:text-rose-400">Annuler</button>
        </>}
        {current.phase === 'ready' && (
          <button type="button" className={`${primary} w-full`} data-testid="voice-pill-open"
            onClick={() => openNovaWindow('voice-deverb', { targets: current.targets })}>Voix prête : régler le dosage</button>
        )}
        {current.phase === 'done' && <p className="text-[11px] text-emerald-500">✅ {current.summary}</p>}
        {current.phase === 'error' && <p className="text-[11px] text-rose-500">❌ {current.error}</p>}
      </div>
    );
  }

  const m = mode!;
  const f = feature!;
  const same = current && current.mode === m && current.targets[0]?.clipId === request.targets[0]?.clipId ? current : null;
  const running = current?.phase === 'running' ? current : null;
  const featureStatus = module?.features[f];
  const installingThis = !!module?.installing && (module.installFeature === f || !module.installFeature);
  const installingOther = !!module?.installing && !installingThis;
  const installEv = module?.install && (!module.install.feature || module.install.feature === f) ? module.install : null;
  const firstName = (() => { const r = resolve(request.targets[0]); return r?.clip.name || 'clip'; })();

  let body: React.ReactNode;
  if (availability === 'web') {
    body = (
      <div className="space-y-3" data-testid="voice-web">
        <p className="text-[12px] text-nv-ink">
          {m === 'deverb' ? 'Le retrait de la réverbe' : 'La transcription des paroles'} tourne <b>sur ton PC</b>, gratuitement, dans l’appli Windows <b>Nova Studio</b> : rien n’est envoyé sur Internet.
        </p>
        <p className="text-[11px] text-nv-muted">Disponible dans Nova Studio sur PC. Ouvre ton projet dans l’appli, puis clic droit sur le clip voix.</p>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={`${secondary} flex-1`}>Fermer</button>
          <a href={DESKTOP_APP_DOWNLOAD_URL} className={`${primary} flex-[2] flex items-center justify-center`}>Télécharger Nova Studio pour Windows</a>
        </div>
      </div>
    );
  } else if (availability === 'connect') {
    body = (
      <div className="space-y-3" data-testid="voice-connect">
        <p className="text-[12px] text-nv-ink">Le pont de l’appli ne répond pas encore (il démarre avec Nova Studio).</p>
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
      <div className="space-y-3" data-testid="voice-update">
        <p className="text-[12px] text-nv-ink">Ta version de Nova Studio pour Windows n’a pas encore la voix par l’IA. Mets-la à jour (même lien que l’installation) puis relance-la.</p>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={`${secondary} flex-1`}>Fermer</button>
          <a href={DESKTOP_APP_DOWNLOAD_URL} className={`${primary} flex-[2] flex items-center justify-center`}>Mettre à jour Nova Studio</a>
        </div>
      </div>
    );
  } else if (!module && !moduleError) {
    body = <p className="text-[12px] text-nv-muted" data-testid="voice-loading">Vérification du module sur ton PC…</p>;
  } else if (installingThis) {
    body = (
      <div className="space-y-3" data-testid="voice-installing">
        <ProgressBar pct={installEv?.pct ?? 0} label={progressLabel(installEv)} />
        <p className="text-[11px] text-nv-muted">Une seule fois. Tu peux fermer cette fenêtre et continuer à travailler : l’installation se poursuit.</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => novaBridge.voiceCancel({ install: true }).catch(() => undefined)} className={`${secondary} flex-1`}>Annuler l’installation</button>
          <button type="button" onClick={onClose} className={`${primary} flex-[2]`}>Continuer en arrière-plan</button>
        </div>
      </div>
    );
  } else if (module && featureStatus && !featureStatus.installed) {
    const failed = installEv && (installEv.event === 'error' || installEv.event === 'cancelled') ? installEv : null;
    const size = formatBytes(featureStatus.downloadBytes);
    body = (
      <div className="space-y-3" data-testid="voice-not-installed">
        {m === 'deverb' ? (
          <p className="text-[12px] text-nv-ink">Le retrait de réverbe utilise <b>DeepFilterNet 3</b> (IA libre, licences MIT / Apache 2.0) : gratuit, en local, rien n’est envoyé sur Internet. Il faut l’installer une fois sur ce PC.</p>
        ) : (
          <p className="text-[12px] text-nv-ink">La transcription utilise <b>Whisper</b> d’OpenAI (licence MIT) avec faster-whisper : gratuit, en local, rien n’est envoyé sur Internet. Il faut l’installer une fois sur ce PC.</p>
        )}
        <ul className="text-[11px] text-nv-muted list-disc pl-4 space-y-0.5">
          <li>Téléchargement d’environ {size || (m === 'deverb' ? '0,3 Go' : '2 Go')}, rangé dans %LOCALAPPDATA%\NovaStudio\voice (supprimable d’un coup).</li>
          {m === 'transcribe' ? <li>Carte graphique NVIDIA utilisée si elle répond (quelques secondes par minute de voix), sinon le processeur (bien plus lent : environ 1 min 30 par minute de voix).</li>
            : <li>Calcul sur le processeur : environ 6 à 15 s par minute de voix.</li>}
        </ul>
        {installingOther && <p className="text-[11px] text-amber-500">Une autre installation de la voix par l’IA est en cours : attends qu’elle finisse.</p>}
        {(failed || moduleError) && <p className="text-[11px] text-rose-500" role="alert">{failed ? (failed.event === 'cancelled' ? 'Installation annulée.' : failed.message) : moduleError}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={`${secondary} flex-1`}>Plus tard</button>
          <button type="button" onClick={install} disabled={installingOther} className={`${primary} flex-[2]`} data-testid="voice-install"
            title="Installe le module dans un dossier à part (%LOCALAPPDATA%\NovaStudio\voice), supprimable d’un coup.">
            {installButtonLabel(f, featureStatus.downloadBytes)}
          </button>
        </div>
      </div>
    );
  } else if (running) {
    const elapsed = (Date.now() - running.startedAt) / 1000;
    body = (
      <div className="space-y-3" data-testid="voice-running">
        {running.mode !== m || running.targets[0]?.clipId !== request.targets[0]?.clipId ? <p className="text-[11px] text-amber-500">Un calcul est déjà en cours sur « {running.label} ».</p> : null}
        <ProgressBar pct={running.pct} label={`${Math.round(running.pct)} % · ${running.message}`} />
        <p className="text-[11px] text-nv-muted">
          Calcul {running.device === 'cuda' ? 'sur la carte graphique' : 'sur le processeur'} · {Math.round(elapsed)} s écoulées. Tu peux fermer cette fenêtre.
        </p>
        {running.mode === 'transcribe' && running.device === 'cpu' && <p className="text-[11px] text-amber-500" role="status" data-testid="voice-cpu-fallback">⚠️ {CPU_FALLBACK_NOTE}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={cancel} className={`${secondary} flex-1`}>Annuler</button>
          <button type="button" onClick={onClose} className={`${primary} flex-[2]`}>Continuer en arrière-plan</button>
        </div>
      </div>
    );
  } else if (m === 'deverb' && same?.phase === 'ready' && same.deverb) {
    const pct = Math.round(amount * 100);
    body = (
      <div className="space-y-3" data-testid="voice-deverb-ready">
        <p className="text-[12px] text-emerald-500" role="status">✅ Voix analysée en {Math.max(1, Math.round(same.seconds || 0))} s ({same.device === 'cuda' ? 'carte graphique' : 'processeur'}){same.deverb.rt60 ? ` · réverbe de la pièce : environ ${same.deverb.rt60.toFixed(1).replace('.', ',')} s` : ''}. Écoute avant / après, puis règle le dosage.</p>
        <label className="block space-y-1" title="0 % : la voix d’origine ; 100 % : la réverbe de la pièce retirée (environ 13 dB de queue en moins sur nos essais). Si la voix sonne trop sèche ou métallique, baisse vers 80-90 %.">
          <span className="flex items-center justify-between text-[12px] font-bold"><span>Dosage</span><span className="tabular-nums" data-testid="voice-amount-value">{pct} %</span></span>
          <input type="range" min={0} max={100} step={1} value={pct} onChange={e => setAmount(Number(e.target.value) / 100)} className="w-full accent-cyan-500" aria-label="Dosage du retrait de réverbe" data-testid="voice-amount" />
        </label>
        <div className="flex gap-2" role="group" aria-label="Écoute">
          <button type="button" onClick={togglePlay} className={`${secondary} flex-1`} data-testid="voice-play" title="Écoute la voix (avec 0,5 s avant et après le clip)">
            <i className={`fas ${playing ? 'fa-stop' : 'fa-play'} mr-1.5`} />{playing ? 'Stop' : 'Écouter'}
          </button>
          <div role="radiogroup" aria-label="Avant ou après" className="flex flex-[2] gap-1 rounded-xl bg-nv-well p-1">
            {([false, true] as const).map(v => (
              <button key={String(v)} type="button" role="radio" aria-checked={after === v} onClick={() => setAfter(v)} data-testid={v ? 'voice-after' : 'voice-before'}
                className={`flex-1 min-h-9 rounded-lg text-[12px] font-bold ${after === v ? 'bg-cyan-500 text-black' : 'text-nv-muted hover:bg-nv-accent/10'}`}>{v ? 'Après' : 'Avant'}</button>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-nv-muted">« Avant » / « Après » bascule pendant l’écoute, au même endroit. Le souffle et les bruits de fond partent aussi.</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => { setJob(null); onClose(); }} className={`${secondary} flex-1`}>Annuler</button>
          <button type="button" onClick={applyDeverb} className={`${primary} flex-[2]`} data-testid="voice-apply">Appliquer ({pct} %)</button>
        </div>
      </div>
    );
  } else {
    const finished = same && (same.phase === 'done' || same.phase === 'error') ? same : null;
    body = (
      <div className="space-y-3" data-testid="voice-ready">
        {finished?.phase === 'done' && <p className="text-[12px] text-emerald-500" role="status">✅ {finished.summary}</p>}
        {(finished?.phase === 'error' || moduleError) && <p className="text-[12px] text-rose-500" role="alert">❌ {finished?.error || moduleError}</p>}
        {m === 'deverb' ? (
          <p className="text-[12px] text-nv-ink">
            Pour une voix enregistrée dans une pièce (chambre, salon) : la réverbe des murs est retirée, la voix revient sèche et proche, comme en cabine. Tu choisis ensuite le dosage en écoutant avant / après.
          </p>
        ) : (<>
          <fieldset className="space-y-1.5">
            <legend className="text-[12px] font-bold mb-1">Langue</legend>
            <div role="radiogroup" aria-label="Langue" className="grid grid-cols-2 gap-1.5">
              {LANGUAGE_OPTIONS.map(o => (
                <label key={o.id} title={o.hint} className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 text-[12px] cursor-pointer ${language === o.id ? 'border-cyan-400 bg-cyan-500/10' : 'border-nv-line hover:bg-nv-accent/10'}`}>
                  <input type="radio" name="voice-lang" checked={language === o.id} onChange={() => setLanguage(o.id)} />{o.label}
                </label>
              ))}
            </div>
          </fieldset>
          {lyrics.trim() ? (
            <fieldset className="space-y-1.5">
              <legend className="text-[12px] font-bold mb-1">Tes paroles</legend>
              {([
                ['keep', 'Garder mon texte, le caler sur la voix', 'Ton texte ne change pas : chaque ligne défile quand tu la chantes.'],
                ['replace', 'Remplacer par la transcription', 'Le texte transcrit remplace tes paroles (Ctrl+Z pour revenir).'],
                ['append', 'Ajouter à la fin', 'Le texte de ce clip s’ajoute après tes paroles.'],
              ] as [LyricsMode, string, string][]).map(([id, label, hint]) => (
                <label key={id} title={hint} className={`flex items-start gap-2 rounded-xl border px-2.5 py-2 cursor-pointer ${lyricsMode === id ? 'border-cyan-400 bg-cyan-500/10' : 'border-nv-line hover:bg-nv-accent/10'}`}>
                  <input type="radio" name="voice-lyrics" className="mt-0.5" checked={lyricsMode === id} onChange={() => setLyricsMode(id)} />
                  <span><span className="block text-[12px] font-bold">{label}</span><span className="block text-[11px] text-nv-muted">{hint}</span></span>
                </label>
              ))}
            </fieldset>
          ) : <p className="text-[11px] text-nv-muted">Tes paroles sont vides : le texte transcrit les remplit, partie par partie (tes repères deviennent les titres : [Refrain]…).</p>}
          <label className="flex items-center gap-2 text-[12px]" title="Les mots s’affichent sur le clip, à leur place dans le temps">
            <input type="checkbox" checked={showOnClip} onChange={e => setShowOnClip(e.target.checked)} data-testid="voice-show-on-clip" />Afficher le texte au-dessus du clip
          </label>
        </>)}
        <div className="flex gap-2">
          {finished?.phase === 'done' && m === 'transcribe'
            ? <button type="button" onClick={() => { openLyrics(); onClose(); }} className={`${secondary} flex-1`} data-testid="voice-open-prompter">Ouvrir le prompteur</button>
            : <button type="button" onClick={onClose} className={`${secondary} flex-1`}>{finished?.phase === 'done' ? 'Fermer' : 'Annuler'}</button>}
          <button type="button" onClick={m === 'deverb' ? startDeverb : startTranscribe} className={`${primary} flex-[2]`} data-testid="voice-start">
            {finished?.phase === 'error' ? 'Réessayer' : m === 'deverb' ? 'Analyser la voix' : request.targets.length > 1 ? `Transcrire ${request.targets.length} clips` : 'Transcrire'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="voice-title" data-testid="voice-dialog"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-nv-line bg-nv-panel p-5 text-nv-ink shadow-2xl space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="voice-title" className="text-lg font-black" title={m === 'deverb' ? DEVERB_TOOLTIP : TRANSCRIBE_TOOLTIP}>{TITLES[m]}</h2>
            <p className="mt-1 text-[12px] text-nv-muted truncate">« {firstName} »{request.targets.length > 1 ? ` et ${request.targets.length - 1} autre${request.targets.length > 2 ? 's' : ''}` : ''}</p>
            <p className="text-[11px] text-nv-muted">{m === 'deverb' ? 'Comme De-reverb (iZotope RX) · calcul sur ton PC' : 'Paroles calées sur le temps · Whisper sur ton PC'}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10"><i className="fas fa-times" /></button>
        </div>
        {body}
      </div>
    </div>
  );
};

export default VoiceAIDialog;

/** Où en est la voix par l'IA (menu du clip : grisé sur le site). */
export function useVoiceAvailability() {
  return voiceAvailability(useBridge(), isNovaDesktop());
}
