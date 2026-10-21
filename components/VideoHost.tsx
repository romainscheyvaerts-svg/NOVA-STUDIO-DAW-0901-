import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DAWState, Track, TrackType } from '../types';
import { applyR21 } from '../utils/r21Bus';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { resampleBuffer } from '../utils/hqAudio';
import { projectRateOf } from '../utils/projectRate';
import { applyImport } from '../utils/sessionImport';
import { playheadStore } from '../utils/playheadStore';
import { audioEngine } from '../engine/AudioEngine';
import { saveBlob } from '../utils/saveBlob';
import { exportKeyOf } from '../utils/exportRights';
import { useExportGate } from '../hooks/useExportGate';
import ExportPaywall from './ExportPaywall';
import { openBuyBeat } from '../utils/studioLinks';
import { closePopout, openPopout, usePopout } from '../utils/popoutWindow';
import {
  currentVideo, deleteVideoFile, getVideoFile, isVideoFile, putVideoFile, setVideoMeta, syncAction, useVideoMeta, videoBus, VideoTrackMeta,
} from '../utils/videoTrack';
import { exportVideoWithMix, loadVideoElement } from '../utils/videoExport';

/**
 * Vidéo à l'image (écart 24) : import (fenêtre ou glisser-déposer), image qui suit la
 * tête de lecture (fenêtre flottante, ou sur le 2e écran), export de la vidéo avec le mix.
 * Le couloir de vignettes est components/VideoTrackLane. Fenêtres chargées à la demande.
 */
const btn = 'nova-hit-tactile h-9 rounded-lg border border-nv-line px-3 text-[12px] font-bold text-nv-ink hover:bg-nv-accent/15 disabled:opacity-40';
const btnMain = 'nova-hit-tactile h-10 rounded-lg bg-nv-accent px-4 text-[13px] font-black text-black disabled:opacity-40';
const card = 'w-full rounded-xl border border-nv-line bg-nv-well/40 p-3 text-left hover:bg-nv-accent/10';
const mmss = (t: number) => { const s = Math.max(0, t); const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s - m * 60)).padStart(2, '0')}`; };
const mb = (n: number) => `${(n / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;

const Shell: React.FC<{ title: string; icon: string; testId: string; busy: boolean; onClose: () => void; children: React.ReactNode }> = ({ title, icon, testId, busy, onClose, children }) => (
  <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/60 p-3" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={`${testId}-title`} data-testid={testId}
      className="flex max-h-[92vh] w-full max-w-[560px] flex-col gap-3 overflow-y-auto rounded-2xl border border-nv-line bg-nv-panel p-4 shadow-2xl">
      <div className="flex items-center gap-2">
        <i className={`fas ${icon} text-fuchsia-400`} />
        <h2 id={`${testId}-title`} className="min-w-0 flex-1 truncate text-[15px] font-bold text-nv-ink">{title}</h2>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Fermer" className="nova-hit-tactile h-9 w-9 rounded-lg text-nv-muted hover:text-nv-ink"><i className="fas fa-times" /></button>
      </div>
      {children}
    </div>
  </div>
);

interface Probe { file: File; duration: number; width: number; height: number }

async function probe(file: File): Promise<Probe> {
  const { v, url } = await loadVideoElement(file);
  try {
    if (!Number.isFinite(v.duration) || v.duration <= 0) throw new Error('Durée de la vidéo inconnue.');
    return { file, duration: v.duration, width: v.videoWidth, height: v.videoHeight };
  } finally { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); }
}

/** Son de la vidéo (s'il y en a) décodé par le navigateur. */
async function decodeVideoAudio(file: File): Promise<AudioBuffer | null> {
  try {
    const Ctx = (globalThis as any).OfflineAudioContext;
    const ctx = new Ctx(2, 1, 48000);
    const buf: AudioBuffer = await ctx.decodeAudioData(await file.arrayBuffer());
    return buf.length > 0 ? buf : null;
  } catch { return null; }
}

// ── Import ───────────────────────────────────────────────────────────────────────────────
const ImportDialog: React.FC<{ getState: () => DAWState; initialFiles?: File[]; onClose: () => void; onDone: (t: string) => void }> = ({ getState, initialFiles, onClose, onDone }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [p, setP] = useState<Probe | null>(null);
  const [at, setAt] = useState<'zero' | 'playhead'>('zero');
  const [withSound, setWithSound] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const had = currentVideo();
  const head = playheadStore.get();

  const take = async (files: File[]) => {
    const f = files.find(isVideoFile);
    if (!f) { setError('Choisis un fichier vidéo (MP4, MOV, WebM).'); return; }
    setBusy('Lecture de la vidéo…'); setError(null);
    try { setP(await probe(f)); } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(null); }
  };
  useEffect(() => { if (initialFiles?.length) void take(initialFiles); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const go = async () => {
    if (!p) return;
    const offset = at === 'playhead' ? Math.max(0, Math.round(head * 30) / 30) : 0;
    const id = `vid-${Date.now().toString(36)}`;
    try {
      setBusy('Rangement de la vidéo sur cet appareil…');
      await putVideoFile(id, p.file);
      const meta: VideoTrackMeta = { id, name: p.file.name, offset, duration: p.duration, width: p.width, height: p.height, size: p.file.size, fps: 30, addedAt: Date.now() };
      let msg = `🎬 Vidéo « ${p.file.name} » posée à ${mmss(offset)}`;
      if (withSound) {
        setBusy('Lecture du son de la vidéo…');
        let buf = await decodeVideoAudio(p.file);
        if (buf) {
          const st = getState();
          const rate = projectRateOf(st);
          if (buf.sampleRate !== rate) buf = await resampleBuffer(buf, rate);
          const bid = `${id}-son`;
          audioBufferRegistry.register(buf, bid);
          const color = '#e879f9';
          const src: Track = {
            id: `${id}-piste`, name: 'Son de la vidéo', type: TrackType.AUDIO, color, isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
            volume: 1, pan: 0, outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0,
            clips: [{ id: `${id}-clip`, name: p.file.name.replace(/\.[a-z0-9]+$/i, ''), color, type: TrackType.AUDIO, bufferId: bid, start: offset, duration: buf.duration, offset: 0, fadeIn: 0, fadeOut: 0 }],
          };
          let n = 0;
          let trackId = '', clipId = '';
          applyR21(s => {
            const r = applyImport(s, { tracks: [src], bpm: s.bpm }, [{ sourceId: src.id, parts: ['clips', 'color'] }], { sameName: 'add', matchTempo: false }, base => `${base}-${(n++).toString(36)}`);
            trackId = r.trackIds[0];
            clipId = r.state.tracks.find(t => t.id === trackId)?.clips[0]?.id || '';
            return r.state;
          }, `🎬 Son de la vidéo importé sur une piste. Ctrl+Z pour revenir.`);
          // applyR21 applique tout de suite : identifiants connus.
          if (trackId) { meta.audioTrackId = trackId; meta.audioClipId = clipId; }
          msg += ', son sur la piste « Son de la vidéo »';
        } else msg += ' (pas de son dans cette vidéo)';
      }
      if (had && had.id !== id) void deleteVideoFile(had.id);
      setVideoMeta(meta);
      (window as any).__novaVideoImported = meta;
      onDone(`${msg}. L'image suit la tête de lecture.`);
      onClose();
    } catch (e: any) {
      const quota = /quota/i.test(String(e?.name || e?.message || e));
      setError(quota ? 'Plus de place pour ranger la vidéo sur cet appareil : libère de l’espace (Session › Stockage) ou choisis une vidéo plus légère.' : `Import impossible : ${e?.message || e}`);
    } finally { setBusy(null); }
  };

  return (
    <Shell title={`Importer une vidéo${p ? ` · ${p.file.name}` : ''}`} icon="fa-film" testId="video-import-dialog" busy={!!busy} onClose={onClose}>
      {error && <p role="alert" className="rounded-lg border border-red-400/40 bg-red-500/10 p-2 text-[12px] text-red-300">⚠️ {error}</p>}
      {busy && <p className="p-2 text-center text-[13px] text-nv-muted" role="status"><i className="fas fa-circle-notch fa-spin mr-2" />{busy}</p>}
      {!p && !busy && (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] text-nv-muted">Une vidéo (clip, pub, court-métrage) pour caler ta musique ou poser ta voix à l'image : l'image suit la tête de lecture, son son arrive sur une piste audio.</p>
          <button type="button" className={card} onClick={() => inputRef.current?.click()} data-testid="video-pick">
            <span className="block text-[13px] font-black text-nv-ink">🎬 Choisir la vidéo</span>
            <span className="block text-[11px] text-nv-muted">MP4 (H.264) conseillé ; MOV et WebM si ton navigateur les lit. Tu peux aussi la glisser sur NOVA.</span>
          </button>
          <input ref={inputRef} type="file" accept="video/*,.mp4,.m4v,.mov,.webm" className="hidden" data-testid="video-input"
            onChange={e => { const f = Array.from(e.target.files || []); e.target.value = ''; if (f.length) void take(f); }} />
        </div>
      )}
      {p && !busy && (
        <div className="flex flex-col gap-3" data-testid="video-review">
          <p className="text-[13px] text-nv-ink" data-testid="video-preview"><b>{p.file.name}</b> · {mmss(p.duration)} · {p.width}×{p.height} · {mb(p.file.size)}</p>
          <fieldset className="flex flex-col gap-1.5 text-[12px] text-nv-ink">
            <legend className="mb-1 text-[11px] font-black uppercase tracking-wider text-nv-muted">Début de la vidéo</legend>
            <label className="flex items-center gap-2"><input type="radio" name="video-at" checked={at === 'zero'} onChange={() => setAt('zero')} data-testid="video-at-zero" />Au début du morceau (0:00)</label>
            <label className="flex items-center gap-2"><input type="radio" name="video-at" checked={at === 'playhead'} onChange={() => setAt('playhead')} data-testid="video-at-playhead" />À la tête de lecture ({mmss(head)})</label>
          </fieldset>
          <label className="flex items-center gap-2 text-[12px] text-nv-ink"><input type="checkbox" checked={withSound} onChange={e => setWithSound(e.target.checked)} data-testid="video-with-sound" />Importer le son de la vidéo sur une piste audio</label>
          {had && <p className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-2 text-[12px] text-amber-200">Elle remplace « {had.name} » (une vidéo par projet ; le son déjà importé reste).</p>}
          <p className="text-[11px] text-nv-muted">La vidéo reste sur cet appareil (elle n'alourdit pas le projet). Tu la déplaces ensuite en glissant son couloir, ou d'une image avec ◀ ▶.</p>
          <div className="flex justify-end gap-2">
            <button type="button" className={btn} onClick={onClose}>Annuler</button>
            <button type="button" className={btnMain} onClick={() => void go()} data-testid="video-import-go">Importer la vidéo</button>
          </div>
        </div>
      )}
    </Shell>
  );
};

// ── Export ───────────────────────────────────────────────────────────────────────────────
const ExportDialog: React.FC<{ getState: () => DAWState; getOwned?: () => (string | number)[]; onClose: () => void }> = ({ getState, getOwned, onClose }) => {
  const meta = useVideoMeta();
  const [busy, setBusy] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const state = getState();
  const ownedIds = (getOwned?.() || []).map(String);
  const gate = useExportGate(true, exportKeyOf(state), state.tracks, ownedIds, 'mix');
  const go = async () => {
    if (!meta) return;
    if (!gate.unlocked) { setError("Débloque d'abord l'export de ce projet (ci-dessus)."); return; }
    setError(null); setBusy('Préparation…'); setPct(0);
    abort.current = new AbortController();
    try {
      const file = await getVideoFile(meta.id);
      if (!file) throw new Error('La vidéo n’est plus sur cet appareil : réimporte-la.');
      const r = await exportVideoWithMix({ state: getState(), meta, file, signal: abort.current.signal, onProgress: (p, t) => { setPct(p); setBusy(t); } });
      await saveBlob(r.blob, r.fileName);
      (window as any).__novaVideoExport = { fileName: r.fileName, size: r.blob.size, frames: r.frames, method: r.method, w: r.width, h: r.height };
      setDone(`✅ « ${r.fileName} » : ${r.width}×${r.height}, ${r.frames} images, ${mb(r.blob.size)}.`);
    } catch (e: any) {
      if (e?.name !== 'ClipCancelled') setError(`Export impossible : ${e?.message || e}`);
    } finally { setBusy(null); abort.current = null; }
  };
  return (
    <Shell title="Exporter la vidéo avec le mix" icon="fa-file-video" testId="video-export-dialog" busy={false} onClose={() => { abort.current?.abort(); onClose(); }}>
      {!meta && <p className="text-[12px] text-amber-300">Aucune vidéo dans ce projet : importe-la d'abord.</p>}
      {meta && !done && !busy && !gate.admin && !gate.unlocked && (
        <ExportPaywall access={gate.access} grille={gate.grille} status={gate.status} paying={gate.paying}
          onPayExport={() => { void gate.pay(); }} onCancelPay={gate.cancelPay} onBuyLicence={() => openBuyBeat(state.tracks)}
          onRetry={gate.recheck} onProActive={gate.recheck} showBuy />
      )}
      {error && <p role="alert" className="rounded-lg border border-red-400/40 bg-red-500/10 p-2 text-[12px] text-red-300">⚠️ {error}</p>}
      {meta && !done && (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] text-nv-muted">Un MP4 (H.264 + AAC) : l'image de « {meta.name} » et le mix du morceau de {mmss(meta.offset)} à {mmss(meta.offset + meta.duration)}, calés à l'image près.</p>
          {busy ? (
            <div role="status" data-testid="video-export-progress">
              <p className="text-[12px] text-nv-ink">{busy} {Math.round(pct * 100)} %</p>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-nv-well"><div className="h-full bg-fuchsia-400" style={{ width: `${Math.round(pct * 100)}%` }} /></div>
              <div className="mt-2 flex justify-end"><button type="button" className={btn} onClick={() => abort.current?.abort()}>Annuler</button></div>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <button type="button" className={btn} onClick={onClose}>Fermer</button>
              <button type="button" className={btnMain} disabled={!gate.unlocked} onClick={() => void go()} data-testid="video-export-go">{gate.unlocked ? 'Exporter la vidéo' : (gate.access ? 'Export à débloquer' : 'Vérification…')}</button>
            </div>
          )}
        </div>
      )}
      {done && (
        <div className="flex flex-col gap-2" data-testid="video-export-done">
          <p className="text-[13px] font-bold text-nv-ink">{done}</p>
          <div className="flex justify-end"><button type="button" className={btnMain} onClick={onClose}>Fermer</button></div>
        </div>
      )}
    </Shell>
  );
};

// ── Image qui suit la tête de lecture ────────────────────────────────────────────────────
const SIZES = { S: 240, M: 360, L: 520 } as const;

const Viewer: React.FC<{ meta: VideoTrackMeta; isPlaying: boolean; onHide: () => void }> = ({ meta, isPlaying, onHide }) => {
  const ref = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [size, setSize] = useState<keyof typeof SIZES>(() => { try { return (localStorage.getItem('nova_video_viewer_size') as any) || 'M'; } catch { return 'M'; } });
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const pop = usePopout('video');
  useEffect(() => {
    let u: string | null = null, dead = false;
    void getVideoFile(meta.id).then(f => { if (dead) return; if (!f) { setMissing(true); return; } u = URL.createObjectURL(f); setUrl(u); }).catch(() => setMissing(true));
    return () => { dead = true; if (u) URL.revokeObjectURL(u); };
  }, [meta.id]);
  const playingRef = useRef(isPlaying);
  playingRef.current = isPlaying;
  // Calage : à chaque déplacement de la tête de lecture (ou changement lecture / arrêt).
  useLayoutEffect(() => {
    const sync = () => {
      const v = ref.current;
      if (!v || v.readyState < 1) return;
      // En lecture : l'horloge du moteur audio elle-même (la tête de lecture affichée peut être à 30 i/s).
      const ph = playingRef.current ? audioEngine.getCurrentTime() : playheadStore.get();
      const a = syncAction({ playhead: ph, playing: playingRef.current, videoTime: v.currentTime, videoPaused: v.paused, rate: v.playbackRate, meta });
      if (a.kind === 'seek') { v.currentTime = a.to; v.playbackRate = 1; }
      else if (a.kind === 'rate') v.playbackRate = a.rate;
      else if (a.kind === 'play') { v.playbackRate = 1; v.currentTime = a.from; void v.play().catch(() => {}); }
      else if (a.kind === 'pause') { v.pause(); v.playbackRate = 1; v.currentTime = a.at; }
      v.style.opacity = a.kind === 'hide' ? '0.25' : '1';
      (window as any).__novaVideoSync = { playhead: ph, videoTime: v.currentTime, paused: v.paused, offset: meta.offset, rate: v.playbackRate };
    };
    sync();
    const off = playheadStore.subscribe(sync);
    const iv = window.setInterval(sync, 200);
    return () => { off(); window.clearInterval(iv); };
  }, [meta, isPlaying, url, pop]);
  useEffect(() => { try { localStorage.setItem('nova_video_viewer_size', size); } catch { /* rien */ } }, [size]);

  const w = SIZES[size];
  const h = Math.round(w * (meta.height || 9) / (meta.width || 16));
  const body = (
    <div className="flex h-full w-full flex-col" data-testid="video-viewer" style={{ backgroundColor: '#000' }}>
      {missing ? <p className="m-auto p-3 text-center text-[12px] text-amber-200">La vidéo n'est plus sur cet appareil : réimporte-la.</p>
        : url && <video ref={ref} src={url} muted playsInline preload="auto" className="h-full w-full object-contain" data-testid="video-element" />}
    </div>
  );
  if (pop) {
    return createPortal(
      <div className="flex h-full flex-col" style={{ backgroundColor: '#000' }}>
        <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-[12px]" style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}>
          <i className="fas fa-film text-fuchsia-400" /> <b>{meta.name}</b>
          <button type="button" className="ml-auto h-6 rounded-md border border-nv-line px-2 text-[11px] font-bold" onClick={() => closePopout('video')}>Ramener dans le studio</button>
        </div>
        <div className="min-h-0 flex-1">{body}</div>
      </div>, pop.container);
  }
  return (
    <div className="fixed z-[640] overflow-hidden rounded-xl border border-fuchsia-400/50 shadow-2xl" data-testid="video-viewer-window"
      style={{ width: w, ...(pos ? { left: pos.x, top: pos.y } : { right: 16, top: 176 }), backgroundColor: 'var(--bg-surface)' }}>
      <div className="flex h-8 cursor-move items-center gap-1 px-2 text-[11px] text-nv-ink" title="Glisser pour déplacer"
        onPointerDown={e => {
          if ((e.target as HTMLElement).closest('button')) return;
          const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
          const dx = e.clientX - box.left, dy = e.clientY - box.top;
          const move = (m: PointerEvent) => setPos({ x: Math.max(0, Math.min(window.innerWidth - 80, m.clientX - dx)), y: Math.max(0, Math.min(window.innerHeight - 40, m.clientY - dy)) });
          const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
          window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
        }}>
        <i className="fas fa-film text-fuchsia-400" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-bold">{meta.name}</span>
        {(['S', 'M', 'L'] as const).map(k => (
          <button key={k} type="button" onClick={() => setSize(k)} aria-pressed={size === k} aria-label={`Taille ${k}`}
            className={`h-6 w-6 rounded text-[10px] font-black ${size === k ? 'bg-fuchsia-500 text-white' : 'bg-nv-well text-nv-muted'}`}>{k}</button>
        ))}
        <button type="button" onClick={() => { if (!openPopout('video')) window.dispatchEvent(new CustomEvent('nova:notify', { detail: 'La fenêtre n’a pas pu s’ouvrir : autorise les fenêtres surgissantes pour NOVA.' })); }} aria-label="Image sur le 2e écran" title="Sur le 2e écran (fenêtre à part)" data-testid="video-viewer-popout"
          className="h-6 w-6 rounded bg-nv-well text-[10px] text-nv-muted hover:text-nv-ink"><i className="fas fa-external-link-alt" /></button>
        <button type="button" onClick={onHide} aria-label="Masquer l'image" title="Masquer l'image (le couloir reste)" data-testid="video-viewer-hide"
          className="h-6 w-6 rounded bg-nv-well text-[10px] text-nv-muted hover:text-nv-ink"><i className="fas fa-times" /></button>
      </div>
      <div style={{ height: h }}>{body}</div>
    </div>
  );
};

// ── Hôte ─────────────────────────────────────────────────────────────────────────────────
const VideoHost: React.FC<{ getState: () => DAWState; getOwned?: () => (string | number)[]; isPlaying: boolean; notify: (t: string) => void; enabled: boolean }> = ({ getState, getOwned, isPlaying, notify, enabled }) => {
  const meta = useVideoMeta();
  const [dialog, setDialog] = useState<{ kind: 'import' | 'export'; files?: File[]; key: number } | null>(null);
  const [viewer, setViewer] = useState(true);
  useEffect(() => videoBus.on(c => {
    if (c.kind === 'import') setDialog({ kind: 'import', files: c.files, key: Date.now() });
    else if (c.kind === 'export') setDialog({ kind: 'export', key: Date.now() });
    else if (c.kind === 'viewer') setViewer(v => (c.show ?? !v));
    else if (c.kind === 'remove') {
      const m = currentVideo();
      if (!m) return;
      if (!window.confirm(`Retirer la vidéo « ${m.name} » du projet ? (Le son importé reste sur sa piste.)`)) return;
      closePopout('video');
      setVideoMeta(null); void deleteVideoFile(m.id);
      notify('Vidéo retirée (le son importé reste sur sa piste).');
    }
  }), [notify]);
  useEffect(() => { if (meta) setViewer(true); }, [meta?.id]);
  // Une vidéo glissée n'importe où sur NOVA.
  useEffect(() => {
    if (!enabled) return;
    const onDrop = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.some(isVideoFile)) return;
      e.preventDefault(); e.stopPropagation();
      setDialog({ kind: 'import', files, key: Date.now() });
    };
    window.addEventListener('drop', onDrop, true);
    return () => window.removeEventListener('drop', onDrop, true);
  }, [enabled]);
  if (!enabled) return null;
  return (
    <>
      {meta && viewer && <Viewer meta={meta} isPlaying={isPlaying} onHide={() => { closePopout('video'); setViewer(false); }} />}
      {dialog?.kind === 'import' && <ImportDialog key={dialog.key} getState={getState} initialFiles={dialog.files} onClose={() => setDialog(null)} onDone={notify} />}
      {dialog?.kind === 'export' && <ExportDialog key={dialog.key} getState={getState} getOwned={getOwned} onClose={() => setDialog(null)} />}
    </>
  );
};

export default VideoHost;
