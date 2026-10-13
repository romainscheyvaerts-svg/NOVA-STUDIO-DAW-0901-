/**
 * Lot 1 · « ✨ Nettoyer la voix » (le Voice Cleaner de BandLab, partout) :
 * bruit de fond, réverbe de la pièce (appli Windows) et niveau, sur un clip voix.
 *
 * Ouvert depuis le menu du clip (Voix), la palette Ctrl+K et la barre du clip au
 * téléphone (openNovaWindow('voice-clean')). Le calcul tourne hors de l'interface
 * (services/VoiceClean) ; on écoute avant / après, on choisit Léger / Moyen / Fort
 * (sans refaire le gros du calcul), puis « Appliquer » = AudioSuite : l'original
 * est gardé (menu du clip → Revenir à l'original), Ctrl+Z annule.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { DAWState, Track } from '../types';
import { novaBridge, BridgeState, VoiceModuleStatus } from '../services/NovaBridge';
import { cancelVoiceClean, cleanEngineFor, runVoiceClean, type CleanJobOutput } from '../services/VoiceClean';
import { sliceChannels, formatBytes } from '../services/VoiceAI';
import {
  CLEAN_TOOLTIP, cleanBlock, cleanPatch, cleanRegion, cleanSummary, DEFAULT_CLEAN_OPTIONS, describeCleanError, ENGINE_LABELS,
  estimateCleanSeconds, STRENGTH_ORDER, STRENGTHS, type CleanOptions, type CleanStrength,
} from '../utils/voiceClean';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { patchClip } from '../utils/clipProcess';
import { AbPlayer } from '../utils/abPlayer';
import { DESKTOP_APP_DOWNLOAD_URL, isNovaDesktop } from '../utils/desktopApp';
import { openNovaWindow } from '../utils/novaWindows';

export interface VoiceCleanRequest { targets: { trackId: string; clipId: string }[] }

interface Props {
  request: VoiceCleanRequest | null;
  tracks: Track[];
  setState: (fn: (prev: DAWState) => DAWState) => void;
  onClose: () => void;
}

interface Ready {
  trackId: string; clipId: string; clipName: string; from: number; sampleRate: number;
  orig: Float32Array[]; out: CleanJobOutput; options: CleanOptions; key: string;
}

const PREF_KEY = 'nova_voice_clean_options';
const loadPrefs = (): CleanOptions => {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
    if (p && typeof p === 'object') return { ...DEFAULT_CLEAN_OPTIONS, ...p, strength: STRENGTH_ORDER.includes(p.strength) ? p.strength : 'medium' };
  } catch { /* stockage indisponible */ }
  return DEFAULT_CLEAN_OPTIONS;
};
const savePrefs = (o: CleanOptions) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(o)); } catch { /* stockage indisponible */ } };

const notify = (detail: string) => { try { window.dispatchEvent(new CustomEvent('nova:notify', { detail })); } catch { /* hors navigateur */ } };

const btn = 'min-h-11 px-3 py-2 rounded-xl text-[12px] leading-tight font-black transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const primary = `${btn} bg-cyan-500 text-black hover:bg-cyan-400`;
const secondary = `${btn} border border-nv-line text-nv-ink hover:bg-nv-accent/10 font-bold`;

const useBridge = () => {
  const [s, setS] = useState<BridgeState>(novaBridge.getBridgeState());
  useEffect(() => novaBridge.subscribe(setS), []);
  return s;
};

const VoiceCleanDialog: React.FC<Props> = ({ request, tracks, setState, onClose }) => {
  const bridge = useBridge();
  const [options, setOptions] = useState<CleanOptions>(loadPrefs);
  const [module, setModule] = useState<VoiceModuleStatus | null>(null);
  const [installMsg, setInstallMsg] = useState<string | null>(null);
  const [phase, setPhase] = useState<'setup' | 'running' | 'ready' | 'error'>('setup');
  const [pct, setPct] = useState(0);
  const [message, setMessage] = useState('');
  const [startedAt, setStartedAt] = useState(0);
  const [, tick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [restrength, setRestrength] = useState(false);
  const [after, setAfter] = useState(true);
  const [playing, setPlaying] = useState(false);
  const player = useRef<AbPlayer | null>(null);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const runId = useRef(0);

  const target = request?.targets[0] || null;
  const resolve = () => {
    if (!target) return null;
    const tr = tracksRef.current.find(x => x.id === target.trackId);
    const c = tr?.clips.find(x => x.id === target.clipId);
    return tr && c ? { track: tr, clip: c, buffer: c.buffer || (c.bufferId ? audioBufferRegistry.get(c.bufferId) : null) } : null;
  };

  // Module voix de l'appli Windows : DeepFilterNet 3 installé ?
  useEffect(() => {
    if (!request || bridge.status !== 'connected' || !bridge.voice) { setModule(null); return; }
    let alive = true;
    novaBridge.voiceStatus().then(s => { if (alive) setModule(s); }).catch(() => undefined);
    const off = novaBridge.onVoiceEvent(e => {
      if (e.kind !== 'install') return;
      if (e.event === 'done' || e.event === 'error' || e.event === 'cancelled') {
        novaBridge.voiceStatus().then(s => { if (alive) setModule(s); }).catch(() => undefined);
        setInstallMsg(e.event === 'done' ? '✅ DeepFilterNet 3 est installé : il servira au prochain nettoyage.' : e.event === 'cancelled' ? 'Installation annulée.' : `Installation impossible : ${e.message || 'réessaie plus tard'}.`);
      } else if (e.event === 'progress') setInstallMsg(`Installation de DeepFilterNet 3 : ${Math.round(e.pct || 0)} % (tu peux nettoyer pendant ce temps).`);
    });
    return () => { alive = false; off(); };
  }, [request, bridge.status, bridge.voice]);

  // Nouvelle demande : on repart de zéro.
  useEffect(() => {
    if (!request) return;
    setPhase('setup'); setReady(null); setError(null); setPct(0); setAfter(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.targets[0]?.clipId]);

  useEffect(() => {
    if (request) return;
    player.current?.close(); player.current = null; setPlaying(false);
  }, [request]);
  useEffect(() => () => { player.current?.close(); }, []);
  useEffect(() => { player.current?.set(1, after); }, [after]);
  useEffect(() => {
    if (phase !== 'running') return;
    const t = window.setInterval(() => tick(x => x + 1), 500);
    return () => window.clearInterval(t);
  }, [phase]);

  const engine = cleanEngineFor(bridge, module?.features?.deverb?.installed);
  const desktop = isNovaDesktop();
  const reverbAvailable = engine === 'deepfilter';

  const close = () => {
    if (phase === 'running') { runId.current++; cancelVoiceClean(); }
    player.current?.stop(); setPlaying(false);
    onClose();
  };

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const setOpt = (p: Partial<CleanOptions>) => setOptions(o => { const n = { ...o, ...p }; savePrefs(n); return n; });

  const start = async (opts: CleanOptions = options, reuse?: Ready) => {
    const r = resolve();
    const block = cleanBlock(r?.clip);
    if (!r || block) { setError(block || 'Clip introuvable.'); setPhase('error'); return; }
    if (!r.buffer) { setError('Le son de ce clip n’est pas encore chargé : attends la fin du chargement du projet, puis réessaie.'); setPhase('error'); return; }
    if (!opts.noise && !opts.level && !(opts.reverb && reverbAvailable)) { setError('Coche au moins une case : bruit, réverbe ou niveau.'); setPhase('error'); return; }
    const reg = cleanRegion(r.clip, r.buffer.duration);
    const orig = reuse?.orig || sliceChannels(r.buffer, reg.from, reg.to);
    const id = ++runId.current;
    player.current?.stop(); setPlaying(false);
    setError(null);
    if (reuse) setRestrength(true); else { setPhase('running'); setPct(0); setMessage('Préparation…'); setStartedAt(Date.now()); }
    const key = reuse?.key || `${r.clip.id}|${r.clip.bufferId || ''}|${reg.from.toFixed(4)}|${reg.to.toFixed(4)}`;
    try {
      const out = await runVoiceClean({ key, channels: orig, sampleRate: r.buffer.sampleRate, options: { ...opts, reverb: opts.reverb && reverbAvailable }, engine },
        (p, m) => { if (runId.current === id && !reuse) { setPct(p); setMessage(m); } });
      if (runId.current !== id) return;
      setReady({ trackId: r.track.id, clipId: r.clip.id, clipName: r.clip.name, from: reg.from, sampleRate: r.buffer.sampleRate, orig, out, options: opts, key });
      setPhase('ready');
    } catch (e) {
      if (runId.current !== id) return;
      if ((e as { code?: string })?.code === 'cancelled') { setPhase('setup'); return; }
      setError(describeCleanError(e));
      setPhase('error');
    } finally {
      if (runId.current === id) setRestrength(false);
    }
  };

  const changeStrength = (s: CleanStrength) => {
    setOpt({ strength: s });
    if (phase === 'ready' && ready && ready.options.strength !== s) void start({ ...ready.options, strength: s }, ready);
  };

  const togglePlay = () => {
    if (!ready) return;
    if (!player.current) player.current = new AbPlayer();
    if (playing) { player.current.stop(); setPlaying(false); return; }
    player.current.onEnd = () => setPlaying(false);
    // « Avant » au volume d'« Après » (le niveau égalisé ne fausse pas la comparaison), sans saturer.
    let peak = 0;
    for (const c of ready.orig) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > peak) peak = v; }
    const room = peak > 0 ? -20 * Math.log10(peak) - 0.5 : 0;
    const origGainDb = Math.min(ready.out.stats.levelGainDb ?? 0, room);
    player.current.play({ orig: ready.orig, wet: ready.out.channels, sampleRate: ready.sampleRate, origGainDb }, 1, after);
    setPlaying(true);
  };

  const apply = () => {
    if (!ready) return;
    player.current?.stop(); setPlaying(false);
    const r = resolve();
    if (!r || r.clip.id !== ready.clipId) { setError('Le clip a été supprimé : rien n’a été changé.'); setPhase('error'); return; }
    const chs = ready.out.channels;
    const buf = new AudioBuffer({ numberOfChannels: chs.length, length: chs[0].length, sampleRate: ready.sampleRate });
    chs.forEach((c, i) => buf.copyToChannel(c, i));
    const id = `vc-${ready.clipId}-${Date.now().toString(36)}`;
    audioBufferRegistry.register(buf, id);
    const patch = cleanPatch(r.clip, { newBufferId: id, from: ready.from, options: ready.options });
    setState(prev => ({ ...prev, tracks: prev.tracks.map(t => (t.id === ready.trackId ? { ...t, clips: t.clips.map(c => (c.id === ready.clipId ? patchClip(c, patch) : c)) } : t)) }));
    notify(`✨ Voix nettoyée (${STRENGTHS[ready.options.strength].label}) sur « ${ready.clipName} » : ${(s => s.charAt(0).toLowerCase() + s.slice(1))(cleanSummary(ready.out.stats, ready.options))}. L’original est gardé : menu du clip → « Revenir à l’original ». Ctrl+Z pour annuler.`);
    onClose();
  };

  const install = async () => {
    setInstallMsg('Installation de DeepFilterNet 3 lancée…');
    try {
      const s = await novaBridge.voiceInstall('deverb', 'auto');
      setModule(s);
      if (!s.started && s.installing) setInstallMsg('Une autre installation est en cours : attends qu’elle finisse.');
    } catch (e) { setInstallMsg(`Installation impossible : ${(e as Error)?.message || 'réessaie'}`); }
  };

  if (!request) return null;
  const r = resolve();
  const duration = r?.clip.duration || 0;
  const eta = estimateCleanSeconds(duration + 1, engine, r?.buffer?.sampleRate);
  const alreadyCleaned = !!r?.clip.audioSuite?.steps.some(s => s.type === 'AI_VOICE_CLEAN');
  const deverbStatus = module?.features?.deverb;

  const strengthPicker = (
    <fieldset className="space-y-1.5">
      <legend className="text-[12px] font-bold mb-1">Force</legend>
      <div role="radiogroup" aria-label="Force du nettoyage" className="grid grid-cols-3 gap-1 rounded-xl bg-nv-well p-1">
        {STRENGTH_ORDER.map(s => (
          <button key={s} type="button" role="radio" aria-checked={options.strength === s} onClick={() => changeStrength(s)} title={STRENGTHS[s].hint}
            data-testid={`voice-clean-strength-${s}`} disabled={restrength}
            className={`min-h-11 rounded-lg text-[12px] font-bold transition-colors ${options.strength === s ? 'bg-cyan-500 text-black' : 'text-nv-muted hover:bg-nv-accent/10'}`}>
            {STRENGTHS[s].label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-nv-muted" aria-live="polite">{STRENGTHS[options.strength].hint}</p>
    </fieldset>
  );

  let body: React.ReactNode;
  if (phase === 'running') {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    body = (
      <div className="space-y-3" data-testid="voice-clean-running">
        <div className="space-y-1.5">
          <div className="h-2.5 rounded-full bg-nv-well overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Progression du nettoyage">
            <div className="h-full bg-gradient-to-r from-cyan-500 to-fuchsia-500 transition-all duration-300" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
          </div>
          <p className="text-[11px] text-nv-muted">{Math.round(pct)} % · {message}</p>
        </div>
        <p className="text-[11px] text-nv-muted">{elapsed} s écoulées · environ {eta} s en tout · {ENGINE_LABELS[engine]}</p>
        <button type="button" onClick={() => { runId.current++; cancelVoiceClean(); setPhase('setup'); }} className={`${secondary} w-full`} data-testid="voice-clean-cancel">Annuler</button>
      </div>
    );
  } else if (phase === 'ready' && ready) {
    const st = ready.out.stats;
    body = (
      <div className="space-y-3" data-testid="voice-clean-ready">
        <p className="text-[12px] text-emerald-500" role="status" data-testid="voice-clean-summary">
          ✅ {cleanSummary(st, ready.options)}. Calcul : {Math.max(1, Math.round((st.seconds || 0)))} s ({st.engine === 'deepfilter' ? 'DeepFilterNet 3 sur ton PC' : 'RNNoise dans ton navigateur'}).
        </p>
        {ready.out.fellBack && <p className="text-[11px] text-amber-500" role="status">⚠️ {ready.out.fellBack}</p>}
        {strengthPicker}
        <div className="flex gap-2" role="group" aria-label="Écoute">
          <button type="button" onClick={togglePlay} disabled={restrength} className={`${secondary} flex-1`} data-testid="voice-clean-play" title="Écoute la voix (avec une demi-seconde avant et après le clip)">
            <i className={`fas ${playing ? 'fa-stop' : 'fa-play'} mr-1.5`} aria-hidden />{playing ? 'Stop' : 'Écouter'}
          </button>
          <div role="radiogroup" aria-label="Avant ou après" className="flex flex-[2] gap-1 rounded-xl bg-nv-well p-1">
            {([false, true] as const).map(v => (
              <button key={String(v)} type="button" role="radio" aria-checked={after === v} onClick={() => setAfter(v)} data-testid={v ? 'voice-clean-after' : 'voice-clean-before'}
                className={`flex-1 min-h-9 rounded-lg text-[12px] font-bold ${after === v ? 'bg-cyan-500 text-black' : 'text-nv-muted hover:bg-nv-accent/10'}`}>{v ? 'Après' : 'Avant'}</button>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-nv-muted" data-testid="voice-clean-ab-hint">
          {restrength ? 'Nouveau réglage en cours…' : `« Avant » / « Après » bascule pendant l’écoute, au même endroit${st.levelGainDb !== null && Math.abs(st.levelGainDb) >= 1 ? ', au même volume : tu compares la propreté, pas le niveau' : ''}.`}
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={close} className={`${secondary} flex-1`}>Annuler</button>
          <button type="button" onClick={apply} disabled={restrength} className={`${primary} flex-[2]`} data-testid="voice-clean-apply">Appliquer ({STRENGTHS[ready.options.strength].label})</button>
        </div>
      </div>
    );
  } else {
    const check = (k: 'noise' | 'reverb' | 'level', label: string, hint: string, disabled = false, extra?: React.ReactNode) => (
      <label className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 ${disabled ? 'border-nv-line opacity-60' : options[k] ? 'border-cyan-400 bg-cyan-500/10 cursor-pointer' : 'border-nv-line hover:bg-nv-accent/10 cursor-pointer'}`}>
        <input type="checkbox" className="mt-0.5 h-4 w-4" checked={!disabled && options[k]} disabled={disabled} onChange={e => setOpt({ [k]: e.target.checked } as Partial<CleanOptions>)} data-testid={`voice-clean-${k}`} />
        <span className="min-w-0"><span className="block text-[12px] font-bold">{label}</span><span className="block text-[11px] text-nv-muted">{hint}</span>{extra}</span>
      </label>
    );
    body = (
      <div className="space-y-3" data-testid="voice-clean-setup">
        {phase === 'error' && error && <p className="text-[12px] text-rose-500" role="alert" data-testid="voice-clean-error">❌ {error}</p>}
        {alreadyCleaned && (
          <p className="text-[11px] text-amber-500" role="status">
            Ce clip est déjà nettoyé. Pour repartir de la prise d’origine :{' '}
            <button type="button" className="underline font-bold" onClick={() => { openNovaWindow('audiosuite', { revert: true, targets: request.targets }); onClose(); }}>Revenir à l’original</button>.
          </p>
        )}
        <div className="space-y-1.5">
          {check('noise', 'Bruit de fond', 'Ventilo, clim, souffle du micro ou du téléphone, rue.')}
          {check('reverb', 'Réverbe de la pièce', reverbAvailable ? 'La voix revient sèche et proche, comme en cabine.' : 'Dans Nova Studio pour Windows (IA DeepFilterNet 3, sur ton PC).', !reverbAvailable,
            !reverbAvailable && !desktop ? <a href={DESKTOP_APP_DOWNLOAD_URL} className="mt-1 inline-block text-[11px] font-bold text-cyan-500 underline" data-testid="voice-clean-get-desktop">Télécharger Nova Studio pour Windows</a> : null)}
          {check('level', 'Niveau égalisé', 'Phrases trop basses remontées, trop fortes adoucies (vers −18 LUFS), sans remonter le bruit.')}
        </div>
        {strengthPicker}
        <p className="text-[11px] text-nv-muted" data-testid="voice-clean-engine">
          Moteur : {ENGINE_LABELS[engine]} · environ {eta} s · rien n’est envoyé sur Internet.
        </p>
        {bridge.status === 'connected' && bridge.voice && deverbStatus && !deverbStatus.installed && (
          <div className="rounded-xl border border-nv-line p-2.5 space-y-1.5">
            <p className="text-[11px] text-nv-ink">Encore mieux sur ce PC, et la réverbe en plus : <b>DeepFilterNet 3</b> (IA libre, MIT / Apache 2.0), installé une fois{deverbStatus.downloadBytes ? ` (~${formatBytes(deverbStatus.downloadBytes)})` : ''}.</p>
            {installMsg ? <p className="text-[11px] text-nv-muted" role="status">{installMsg}</p>
              : <button type="button" onClick={install} className={`${secondary} w-full`} data-testid="voice-clean-install">Installer DeepFilterNet 3</button>}
          </div>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={close} className={`${secondary} flex-1`}>Annuler</button>
          <button type="button" onClick={() => void start()} className={`${primary} flex-[2]`} data-testid="voice-clean-start">
            {phase === 'error' ? 'Réessayer' : '✨ Nettoyer la voix'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="voice-clean-title" data-testid="voice-clean-dialog"
      onMouseDown={e => { if (e.target === e.currentTarget && phase !== 'running') close(); }}>
      <div className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-nv-line bg-nv-panel p-5 text-nv-ink shadow-2xl space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="voice-clean-title" className="text-lg font-black" title={CLEAN_TOOLTIP}>✨ Nettoyer la voix</h2>
            <p className="mt-1 text-[12px] text-nv-muted truncate">« {r?.clip.name || 'clip'} »{duration ? ` · ${duration.toFixed(1).replace('.', ',')} s` : ''}</p>
            <p className="text-[11px] text-nv-muted">Bruit, réverbe, niveau · l’original est gardé</p>
          </div>
          <button type="button" onClick={close} aria-label="Fermer" className="h-11 w-11 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10"><i className="fas fa-times" aria-hidden /></button>
        </div>
        {body}
      </div>
    </div>
  );
};

export default VoiceCleanDialog;
