import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DAWState, Track } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { billingStatus, isExportVoicesUnlocked } from '../services/Billing';
import { loadCover, renderClipMix } from '../utils/demoExport';
import { saveBlob } from '../utils/saveBlob';
import { openNovaWindow } from '../utils/novaWindows';
import { useVoiceAvailability } from './VoiceAIDialog';
import {
  CLIP_DURATIONS, CLIP_H, CLIP_W, ClipSpectrum, clampRange, clipFileName, clipLyricLines, clipRights, energyEnvelope, fmtTime,
  linesInRange, nearestVoiceRange, projectWords, rangeProblem, songEnd, suggestRanges, voiceSpans, type ClipLine, type ClipRange,
} from '../utils/lyricVideo';
import {
  CLIP_BACKGROUNDS, CLIP_PALETTES, CLIP_STYLES, drawClipFrame, prepareBackdrop, prepareCover, type ClipBackground, type ClipLook, type ClipStyle,
} from '../utils/lyricVideoDraw';
import { ClipCancelled, clipVideoSupport, encodeClip } from '../utils/clipVideoEncode';

/**
 * Lot 2a · « 🎬 Clip pour TikTok / Reels » : vidéo verticale 1080 × 1920 (15 à 60 s) avec
 * les paroles synchronisées mot par mot, le son du mix, un fond au choix, le titre et
 * l'artiste. Export MP4 (H.264 + AAC) dans le navigateur, sans serveur.
 * Règles de l'extrait et de l'export inchangées (utils/lyricVideo · clipRights) ; aucun tag audio.
 */
interface LyricClipModalProps {
  open: boolean;
  onClose: () => void;
  state: DAWState;
  ownedInstrumentIds?: (string | number)[];
  onLyricsChange: (text: string) => void;
  onBuyBeat: () => void;
  /** Ouvre la fenêtre Exporter (payer l'export d'un projet sans instru du catalogue). */
  onOpenExport?: () => void;
}

const LOOK_KEY = 'nova_clip_look';
const readLook = (): Partial<ClipLook> => { try { return JSON.parse(localStorage.getItem(LOOK_KEY) || '{}') || {}; } catch { return {}; } };
const defaultArtist = (): string => { try { return (JSON.parse(localStorage.getItem('nova_export_prefs') || '{}') || {}).artist || ''; } catch { return ''; } };

let adminCache: boolean | null = null;

const canShareFile = (blob: Blob, name: string): boolean => {
  try { return typeof navigator !== 'undefined' && !!navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: blob.type })] }); } catch { return false; }
};
async function shareFile(blob: Blob, name: string): Promise<void> {
  try { await navigator.share({ files: [new File([blob], name, { type: blob.type })], title: name }); }
  catch (e: any) { if (e?.name !== 'AbortError') throw e; }
}

type Img = CanvasImageSource & { width: number; height: number };
interface Prepared { backdrop: Img; cover: Img }

const isVoice = (t: Track) => t.type === 'AUDIO' && t.id !== 'instrumental' && !t.instrumentId;

const PREVIEW_W = 360, PREVIEW_H = 640;

const LyricClipModal: React.FC<LyricClipModalProps> = ({ open, onClose, state, ownedInstrumentIds = [], onLyricsChange, onBuyBeat, onOpenExport }) => {
  const saved = useMemo(readLook, []);
  const [style, setStyle] = useState<ClipStyle>((saved.style as ClipStyle) || 'tiktok');
  const [background, setBackground] = useState<ClipBackground>((saved.background as ClipBackground) || 'degrade');
  const [palette, setPalette] = useState<number>(typeof saved.palette === 'number' ? saved.palette : 0);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [duration, setDuration] = useState(30);
  const [start, setStart] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [beatCover, setBeatCover] = useState<Prepared | null>(null);
  const [userImage, setUserImage] = useState<Prepared | null>(null);
  const [admin, setAdmin] = useState<boolean | null>(adminCache);
  const [exportPaid, setExportPaid] = useState<boolean | null>(null);
  const [support, setSupport] = useState<{ ok: boolean; method: string | null; ext: string | null } | null>(null);
  const [busy, setBusy] = useState<null | 'render' | 'encode' | 'preview'>(null);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState<{ name: string; secs: number; method: string; mb: number; blob: Blob } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [previewPos, setPreviewPos] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCache = useRef<{ key: string; buffer: AudioBuffer } | null>(null);
  const playRef = useRef<{ src: AudioBufferSourceNode; t0: number; spectrum: ClipSpectrum } | null>(null);
  const clockRef = useRef<{ wall: number; pos: number }>({ wall: 0, pos: 0 });
  const voice = useVoiceAvailability();

  // ── Données du projet ──
  const end = useMemo(() => songEnd(state.tracks), [state.tracks]);
  const words = useMemo(() => projectWords(state.tracks), [state.tracks]);
  const lyr = useMemo(() => clipLyricLines({
    lyrics: state.lyrics, words, markers: state.markers, lyricsRegions: state.lyricsRegions,
    lyricsStart: state.lyricsStart, lyricsSpeed: state.lyricsSpeed, end,
  }), [state.lyrics, words, state.markers, state.lyricsRegions, state.lyricsStart, state.lyricsSpeed, end]);
  const lines: ClipLine[] = useMemo(() => (offset ? lyr.lines.map(l => ({ ...l, t: l.t + offset, e: l.e + offset, words: l.words.map(w => ({ ...w, t: w.t + offset, e: w.e + offset })) })) : lyr.lines), [lyr.lines, offset]);
  const spans = useMemo(() => voiceSpans(state.tracks), [state.tracks]);
  const hasVoice = spans.length > 0;
  const voiceTakes = useMemo(() => state.tracks.filter(isVoice).flatMap(t => t.clips.filter(c => !c.isMuted && c.type !== 'MIDI' && (c.bufferId || c.buffer)).map(c => ({ trackId: t.id, clipId: c.id }))), [state.tracks]);

  // ── Droits : mêmes règles que la fenêtre Exporter ──
  const owned = useMemo(() => ownedInstrumentIds.map(String), [ownedInstrumentIds]);
  const unbought = useMemo(() => state.tracks.filter(t => t.instrumentId !== undefined && !owned.includes(String(t.instrumentId))).length, [state.tracks, owned]);
  const hasCatalogBeat = state.tracks.some(t => t.instrumentId !== undefined && t.instrumentId !== null && t.instrumentId !== '');
  useEffect(() => {
    if (!open) return;
    let live = true;
    if (adminCache === null) {
      const timeout = new Promise<null>(r => setTimeout(() => r(null), 4000));
      void Promise.race([billingStatus(), timeout]).then(st => { if (st) adminCache = !!st.admin; if (live) setAdmin(st ? !!st.admin : false); });
    } else setAdmin(adminCache);
    if (!hasCatalogBeat && state.id) void isExportVoicesUnlocked(state.id).then(u => { if (live) setExportPaid(u); });
    else setExportPaid(null);
    return () => { live = false; };
  }, [open, hasCatalogBeat, state.id]);
  const checking = admin === null || (!hasCatalogBeat && admin !== true && exportPaid === null);
  const rights = useMemo(() => clipRights({ admin: admin === true, unboughtCatalog: unbought, hasCatalogBeat, exportPaid }), [admin, unbought, hasCatalogBeat, exportPaid]);

  // ── À l'ouverture : titre, artiste, pochette, support vidéo ──
  useEffect(() => {
    if (!open) return;
    setDone(null); setError(null); setTyping(false); setOffset(0); setStart(null);
    setTitle((state.name || '').trim() && !/^(nouveau projet|untitled|sans titre)/i.test(state.name || '') ? state.name : (state.beatTitle ? '' : 'Mon son'));
    setArtist(a => a || defaultArtist());
    void clipVideoSupport().then(setSupport).catch(() => setSupport({ ok: false, method: null, ext: null }));
    let live = true;
    void loadCover(state).then(img => {
      if (!live || !img) return;
      setBeatCover({ backdrop: prepareBackdrop(img as Img), cover: prepareCover(img as Img) });
    }).catch(() => { /* pas de pochette */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => { try { localStorage.setItem(LOOK_KEY, JSON.stringify({ style, background, palette })); } catch { /* */ } }, [style, background, palette]);

  // ── Plage ──
  const maxDur = Math.max(1, Math.min(rights.maxDuration, Math.floor(end)));
  const dur = Math.min(duration, maxDur);
  const env = useMemo(() => (open ? energyEnvelope(state.tracks, c => (c.bufferId ? audioBufferRegistry.get(c.bufferId) : undefined) || c.buffer, end) : new Float32Array(0)), [open, state.tracks, end]);
  // Recalculé seulement quand les pistes, les repères ou la boucle changent (pas à chaque image de lecture).
  const { tracks, markers, isLoopActive, loopStart, loopEnd } = state;
  const suggestions = useMemo(() => suggestRanges({ state: { tracks, markers, isLoopActive, loopStart, loopEnd }, lines: lyr.lines, duration: dur, env, bin: 0.5 }),
    [tracks, markers, isLoopActive, loopStart, loopEnd, lyr.lines, dur, env]);
  const autoRange = useMemo((): ClipRange => {
    const first = suggestions[0] || { start: 0, duration: dur };
    const r = clampRange({ start: first.start, duration: dur }, end, maxDur);
    return rights.needsVoice ? (nearestVoiceRange(r, spans, end) || r) : r;
  }, [suggestions, dur, end, maxDur, rights.needsVoice, spans]);
  const range = useMemo(() => clampRange({ start: start ?? autoRange.start, duration: dur }, end, maxDur), [start, autoRange, dur, end, maxDur]);
  const problem = end < 1 ? 'Le projet est vide' : rangeProblem(range, rights, spans);
  const inRange = useMemo(() => linesInRange(lines, range.start, range.duration), [lines, range]);
  const imgSet = userImage || beatCover;
  const look: ClipLook = useMemo(() => ({ style, background, palette, title, artist }), [style, background, palette, title, artist]);
  const rangeKey = `${range.start.toFixed(2)}|${range.duration.toFixed(2)}`;

  // ── Aperçu en direct ──
  const stopPreview = useCallback(() => {
    const p = playRef.current;
    if (p) { try { p.src.stop(); } catch { /* */ } try { p.src.disconnect(); } catch { /* */ } }
    playRef.current = null;
    setPlaying(false);
  }, []);
  useEffect(() => { if (!open) stopPreview(); }, [open, stopPreview]);
  // Nouvelle plage : l'aperçu se place sur la 1re ligne chantée (on voit tout de suite les paroles).
  const firstInRange = inRange.find(l => l.t >= range.start) || inRange[0];
  const previewHome = firstInRange ? Math.max(0, Math.min(range.duration - 0.1, firstInRange.words[0].t - range.start + 0.3)) : 0;
  useEffect(() => { stopPreview(); setPreviewPos(previewHome); clockRef.current = { wall: performance.now(), pos: previewHome }; }, [rangeKey, stopPreview, previewHome]);
  useEffect(() => () => stopPreview(), [stopPreview]);

  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const cv = canvasRef.current;
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    const draw = () => {
      let ct = previewPos;
      let spectrum: { bands: Float32Array; level: number } | null = null;
      const p = playRef.current;
      if (p && audioEngine.ctx) {
        ct = audioEngine.ctx.currentTime - p.t0;
        if (ct >= range.duration) { stopPreview(); ct = 0; }
        spectrum = p.spectrum.at(Math.max(0, ct));
        if (Math.abs(ct - previewPos) > 0.25) setPreviewPos(Math.max(0, ct));
      } else if (playing) {
        ct = (clockRef.current.pos + (performance.now() - clockRef.current.wall) / 1000) % range.duration;
      }
      g.setTransform(PREVIEW_W / CLIP_W, 0, 0, PREVIEW_H / CLIP_H, 0, 0);
      drawClipFrame(g, look, { t: range.start + ct, clipT: ct, duration: range.duration, lines, spectrum, backdrop: imgSet?.backdrop || null, cover: imgSet?.cover || null });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [open, look, lines, range, imgSet, playing, previewPos, stopPreview]);

  const renderAudio = async (onP: (p: number) => void): Promise<AudioBuffer> => {
    if (audioCache.current?.key === rangeKey) return audioCache.current.buffer;
    const buffer = await renderClipMix(state, range.start, range.duration, onP);
    audioCache.current = { key: rangeKey, buffer };
    return buffer;
  };
  useEffect(() => { audioCache.current = null; }, [state.tracks]);

  const togglePreview = async () => {
    if (playRef.current) { stopPreview(); return; }
    setError(null);
    try {
      setBusy('preview'); setProgress(0);
      const buffer = await renderAudio(setProgress);
      if (!audioEngine.ctx) await audioEngine.init();
      const ctx = audioEngine.ctx!;
      if (ctx.state !== 'running') await ctx.resume().catch(() => { /* */ });
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const from = previewPos < range.duration - 0.5 ? previewPos : 0;
      const t0 = ctx.currentTime + 0.05 - from;
      src.start(ctx.currentTime + 0.05, from);
      const chs = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
      playRef.current = { src, t0, spectrum: ClipSpectrum.fromChannels(chs, buffer.sampleRate) };
      src.onended = () => { if (playRef.current?.src === src) stopPreview(); };
      setPlaying(true);
    } catch (e: any) {
      setError(`Aperçu du son impossible${e?.message ? ` (${e.message})` : ''}. L'aperçu muet reste disponible ; réessaie dans un instant.`);
    } finally { setBusy(null); }
  };

  // ── Export ──
  const exportClip = async () => {
    if (busy || problem) return;
    stopPreview();
    setDone(null); setError(null); setProgress(0);
    const abort = new AbortController();
    abortRef.current = abort;
    const t0 = performance.now();
    try {
      setBusy('render');
      const audio = await renderAudio(p => setProgress(p * 0.3));
      if (abort.signal.aborted) throw new ClipCancelled();
      try { await Promise.all(['900', '800', '700', '600'].map(w => (document as any).fonts?.load?.(`${w} 64px Inter`))); } catch { /* police système */ }
      const chs = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
      const spectrum = ClipSpectrum.fromChannels(chs, audio.sampleRate);
      const lookNow = look, linesNow = lines, r = range, img = imgSet;
      setBusy('encode');
      const res = await encodeClip({
        audio, duration: r.duration, signal: abort.signal,
        drawFrame: (g, ct) => {
          g.setTransform(1, 0, 0, 1, 0, 0);
          drawClipFrame(g, lookNow, { t: r.start + ct, clipT: ct, duration: r.duration, lines: linesNow, spectrum: spectrum.at(ct), backdrop: img?.backdrop || null, cover: img?.cover || null });
        },
        onProgress: p => setProgress(0.3 + 0.7 * p),
        getAudioContext: async () => { if (!audioEngine.ctx) await audioEngine.init(); return audioEngine.ctx!; },
      });
      const secs = Math.round((performance.now() - t0) / 100) / 10;
      const name = clipFileName(title || state.name || 'mon son', res.ext);
      if (import.meta.env.DEV) {
        (window as any).__novaClipTest = { blob: res.blob, name, method: res.method, videoCodec: res.videoCodec, audioCodec: res.audioCodec, frames: res.frames, encodeMs: res.encodeMs, drawMs: res.drawMs, totalMs: Math.round(performance.now() - t0), range: r, rights, firstWord: linesNow.find(l => l.t >= r.start)?.words[0] || null };
      }
      // Ordinateur : téléchargement direct ; téléphone : feuille de partage (« Enregistrer », TikTok…) si
      // le navigateur la propose encore après le calcul, sinon téléchargement. Les boutons sous le
      // message refont l'un ou l'autre d'un geste neuf (la feuille de partage exige un geste récent).
      await saveBlob(res.blob, name);
      setDone({ name, secs, method: res.method, mb: Math.round(res.blob.size / 1e5) / 10, blob: res.blob });
    } catch (e: any) {
      if (e instanceof ClipCancelled || e?.name === 'ClipCancelled') setError('Création annulée. Rien n\'a été enregistré.');
      else setError(`Le clip n'a pas pu être créé${e?.message ? ` (${e.message})` : ''}. Réessaie ; si ça recommence, essaie une durée plus courte ou recharge la page (ta session est sauvegardée).`);
    } finally {
      setBusy(null); abortRef.current = null;
    }
  };

  // Échap : ferme (sauf pendant la création), sans déclencher les raccourcis du studio.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); e.preventDefault();
      if (typing) { setTyping(false); return; }
      if (busy === 'render' || busy === 'encode') return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, busy, typing, onClose]);

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      setUserImage({ backdrop: prepareBackdrop(bmp as Img), cover: prepareCover(bmp as Img) });
      setBackground('image');
    } catch { setError('Cette image ne s\'ouvre pas. Choisis un JPG ou un PNG.'); }
  };

  if (!open) return null;

  const working = busy === 'render' || busy === 'encode';
  const chip = (on: boolean) => `min-h-[40px] px-3 rounded-xl border text-[12px] font-bold transition-colors ${on ? 'border-cyan-400 bg-cyan-500/15 text-nv-ink' : 'border-nv-line text-nv-muted hover:bg-nv-accent/10'}`;
  const noLyrics = lyr.source === 'aucune' || lyr.lines.length === 0;
  const canTranscribe = voice !== 'web' && voiceTakes.length > 0;
  const firstLineAfter = lyr.lines.find(l => l.t >= 0);

  return (
    <div className="fixed inset-0 z-[645] flex items-end sm:items-center justify-center bg-black/70 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="lyric-clip-title" data-testid="lyric-clip"
      onMouseDown={e => { if (e.target === e.currentTarget && !working) onClose(); }}>
      <div className="w-full sm:max-w-4xl max-h-[96vh] sm:max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-nv-line bg-nv-panel text-nv-ink shadow-2xl p-4 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="lyric-clip-title" className="text-lg font-black">🎬 Clip pour TikTok / Reels</h2>
            <p className="text-[12px] text-nv-muted mt-0.5">Vidéo verticale 1080 × 1920 avec tes paroles en karaoké, le son de ton mix, ton titre. Sans tag audio.</p>
          </div>
          <button type="button" onClick={onClose} disabled={working} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10 disabled:opacity-40"><i className="fas fa-times" /></button>
        </div>

        {end < 1 ? (
          <p className="mt-5 text-sm text-nv-muted" data-testid="clip-empty-project">Ton projet est vide : enregistre d'abord une prise ou pose un beat, puis reviens ici.</p>
        ) : (
          <div className="mt-4 grid gap-5 sm:grid-cols-[minmax(0,300px)_1fr]">
            {/* Aperçu */}
            {/* Téléphone : l'aperçu reste en haut pendant qu'on règle le style (les réglages défilent dessous). */}
            <div className="sticky -top-4 z-10 -mx-4 bg-nv-panel px-4 pb-2 pt-1 sm:mx-0 sm:bg-transparent sm:px-0 sm:pb-0 sm:pt-0 sm:top-0 flex flex-col items-center gap-2 self-start w-[calc(100%+2rem)] sm:w-full">
              <canvas ref={canvasRef} width={PREVIEW_W} height={PREVIEW_H} data-testid="clip-preview" aria-label="Aperçu du clip"
                className="h-[32vh] sm:h-[min(46vh,480px)] rounded-2xl border border-nv-line bg-black shadow-xl" style={{ aspectRatio: '9 / 16', width: 'auto', maxWidth: '100%' }} />
              <div className="flex w-full max-w-[300px] items-center gap-2">
                <button type="button" onClick={togglePreview} disabled={working || busy === 'preview'} data-testid="clip-preview-play"
                  className="h-10 shrink-0 rounded-xl bg-nv-accent/15 px-3 text-[12px] font-bold text-nv-ink hover:bg-nv-accent/25 disabled:opacity-50">
                  {busy === 'preview' ? `Son… ${Math.round(progress * 100)} %` : playRef.current ? '⏸ Pause' : '▶ Écouter'}
                </button>
                <input type="range" min={0} max={Math.max(0.1, range.duration)} step={0.05} value={Math.min(previewPos, range.duration)} aria-label="Position dans l'aperçu"
                  onChange={e => { stopPreview(); const v = Number(e.target.value); setPreviewPos(v); clockRef.current = { wall: performance.now(), pos: v }; }}
                  className="min-w-0 flex-1 accent-cyan-400" />
                <button type="button" onClick={() => { if (playRef.current) return; clockRef.current = { wall: performance.now(), pos: previewPos }; setPlaying(p => !p); }}
                  title="Faire défiler l'aperçu sans le son" aria-label={playing ? 'Arrêter le défilement muet' : 'Défilement muet'} className="h-10 w-10 shrink-0 rounded-xl border border-nv-line text-[12px] text-nv-muted hover:bg-nv-accent/10">
                  {playing && !playRef.current ? '■' : '🔇'}
                </button>
              </div>
              <p className="text-[11px] text-nv-muted">{fmtTime(range.start)} → {fmtTime(range.start + range.duration)} · {Math.round(range.duration)} s</p>
            </div>

            {/* Réglages */}
            <div className="min-w-0 space-y-4">
              {/* Paroles */}
              <section aria-label="Paroles" className="rounded-2xl border border-nv-line p-3">
                {typing ? (
                  <div className="space-y-2">
                    <label htmlFor="clip-lyrics" className="block text-[13px] font-bold">Tes paroles</label>
                    <textarea id="clip-lyrics" value={draft} onChange={e => setDraft(e.target.value)} rows={7} data-testid="clip-lyrics-input"
                      onKeyDown={e => e.stopPropagation()}
                      placeholder={'Une ligne par phrase.\nUne ligne vide entre deux parties.\n[Refrain] pour nommer une partie.'}
                      className="w-full rounded-xl border border-nv-line bg-black/20 p-2.5 text-[13px] text-nv-ink outline-none focus:border-cyan-400" />
                    <p className="text-[11px] text-nv-muted">Le calage suit le prompteur (régions ou vitesse). Règle-le ensuite avec « Décaler les paroles ».</p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => { onLyricsChange(draft); setTyping(false); }} disabled={!draft.trim()} data-testid="clip-lyrics-save"
                        className="h-10 flex-1 rounded-xl bg-cyan-500 text-[13px] font-black text-black disabled:opacity-40">Enregistrer les paroles</button>
                      <button type="button" onClick={() => setTyping(false)} className="h-10 rounded-xl border border-nv-line px-3 text-[12px] font-bold">Annuler</button>
                    </div>
                  </div>
                ) : noLyrics ? (
                  <div data-testid="clip-empty-lyrics" className="space-y-2">
                    <p className="text-[13px] font-bold">Pas encore de paroles dans ce projet</p>
                    <p className="text-[12px] text-nv-muted">
                      {canTranscribe ? 'Transcris ta prise : les mots se calent tout seuls sur ta voix. Ou tape-les.' : voice === 'web' ? 'Tape tes paroles (la transcription automatique se fait dans l\'appli Windows).' : 'Tape tes paroles.'}
                      {' '}Tu peux aussi créer le clip sans paroles.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {canTranscribe && (
                        <button type="button" data-testid="clip-transcribe" onClick={() => openNovaWindow('voice-transcribe', { targets: voiceTakes })}
                          className="h-10 rounded-xl bg-cyan-500 px-4 text-[13px] font-black text-black">Transcrire les paroles</button>
                      )}
                      <button type="button" data-testid="clip-type-lyrics" onClick={() => { setDraft(state.lyrics || ''); setTyping(true); }}
                        className={`h-10 rounded-xl px-4 text-[13px] font-black ${canTranscribe ? 'border border-nv-line text-nv-ink' : 'bg-cyan-500 text-black'}`}>Taper les paroles</button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[13px] font-bold flex-1 min-w-0" data-testid="clip-lyrics-source">
                        {lyr.source === 'voix' ? '✓ Paroles calées mot par mot sur ta voix' : '✓ Paroles calées comme le prompteur'}
                        <span className="font-normal text-nv-muted"> · {inRange.length} ligne{inRange.length > 1 ? 's' : ''} dans ce passage</span>
                      </p>
                      <button type="button" onClick={() => { setDraft(state.lyrics || lyr.text); setTyping(true); }} className="h-9 rounded-lg border border-nv-line px-2.5 text-[12px] font-bold">Modifier</button>
                      {lyr.source !== 'voix' && canTranscribe && (
                        <button type="button" onClick={() => openNovaWindow('voice-transcribe', { targets: voiceTakes })} className="h-9 rounded-lg border border-cyan-400/50 px-2.5 text-[12px] font-bold">Transcrire (calage exact)</button>
                      )}
                    </div>
                    {lyr.source !== 'voix' && <p className="text-[11px] text-nv-muted">Calage approximatif{voice === 'web' ? ' : la transcription mot par mot se fait dans l\'appli Windows.' : '.'}</p>}
                    {inRange.length === 0 && <p className="text-[12px] text-amber-400" role="status">Aucune parole dans ce passage : choisis un autre passage ou décale les paroles.</p>}
                    <div className="flex items-center gap-2">
                      <label htmlFor="clip-offset" className="shrink-0 text-[12px] text-nv-muted">Décaler les paroles</label>
                      <input id="clip-offset" type="range" min={-10} max={10} step={0.1} value={offset} onChange={e => setOffset(Number(e.target.value))} className="min-w-0 flex-1 accent-cyan-400" />
                      <span className="w-14 text-right text-[12px] tabular-nums">{offset > 0 ? '+' : ''}{offset.toFixed(1)} s</span>
                      {offset !== 0 && <button type="button" onClick={() => setOffset(0)} className="text-[11px] underline text-nv-muted">0</button>}
                    </div>
                    {lyr.source !== 'voix' && firstLineAfter && (
                      <button type="button" onClick={() => setOffset(Math.round((range.start + 0.6 - firstLineAfter.t) * 10) / 10)} className="text-[12px] font-bold text-cyan-500 underline">
                        Faire commencer les paroles au début du clip
                      </button>
                    )}
                  </div>
                )}
              </section>

              {/* Passage */}
              <section aria-label="Passage" className="space-y-2">
                <h3 className="text-[13px] font-bold">Passage</h3>
                <div className="flex flex-wrap gap-2">
                  {suggestions.map(s => (
                    <button key={s.id} type="button" data-testid={`clip-range-${s.id}`} onClick={() => setStart(s.start)}
                      className={chip(Math.abs(range.start - s.start) < 0.3)}>{s.label} · {fmtTime(s.start)}</button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Durée">
                  {CLIP_DURATIONS.map(d => {
                    const locked = d > rights.maxDuration;
                    // Morceau plus court que la durée : la 1re durée au-delà devient « Tout le morceau ».
                    const whole = d > end && d === CLIP_DURATIONS.find(x => x >= end);
                    const tooLong = d > end && !whole;
                    return (
                      <button key={d} type="button" data-testid={`clip-dur-${d}`} disabled={locked || tooLong}
                        title={locked ? 'Jusqu\'à 60 s avec la licence de l\'instru ou l\'export payé' : tooLong ? `Ton morceau dure ${Math.round(end)} s` : undefined}
                        onClick={() => setDuration(d)} className={`${chip(Math.round(dur) === d || (whole && duration >= d))} disabled:opacity-40`}>
                        {locked ? '🔒 ' : ''}{whole && !locked ? `Tout (${Math.floor(end)} s)` : `${d} s`}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="clip-start" className="shrink-0 text-[12px] text-nv-muted">Début</label>
                  <input id="clip-start" type="range" min={0} max={Math.max(0, end - range.duration)} step={0.5} value={range.start}
                    onChange={e => setStart(Number(e.target.value))} className="min-w-0 flex-1 accent-cyan-400" />
                  <span className="w-12 text-right text-[12px] tabular-nums">{fmtTime(range.start)}</span>
                </div>
                {problem && (
                  <div className="text-[12px] text-amber-400" role="status" data-testid="clip-range-problem">
                    {problem}
                    {rights.needsVoice && hasVoice && /voix/.test(problem) && (
                      <button type="button" className="ml-2 underline font-bold" onClick={() => { const r = nearestVoiceRange(range, spans, end); if (r) setStart(r.start); }}>Aller au passage chanté le plus proche</button>
                    )}
                  </div>
                )}
                {rights.needsVoice && !hasVoice && <p className="text-[12px] text-amber-400" role="status">Sans licence, le clip se fait sur ta voix : enregistre d'abord une prise.</p>}
              </section>

              {/* Style */}
              <section aria-label="Style des paroles" className="space-y-2">
                <h3 className="text-[13px] font-bold">Style des paroles</h3>
                <div className="grid grid-cols-2 gap-2">
                  {CLIP_STYLES.map(s => (
                    <button key={s.id} type="button" data-testid={`clip-style-${s.id}`} onClick={() => setStyle(s.id)} aria-pressed={style === s.id}
                      className={`${chip(style === s.id)} text-left py-2`}>
                      <span className="block">{s.label}</span>
                      <span className="block text-[11px] font-normal text-nv-muted">{s.hint}</span>
                    </button>
                  ))}
                </div>
              </section>

              {/* Fond */}
              <section aria-label="Fond" className="space-y-2">
                <h3 className="text-[13px] font-bold">Fond</h3>
                <div className="flex flex-wrap gap-2">
                  {CLIP_BACKGROUNDS.map(b => (
                    <button key={b.id} type="button" data-testid={`clip-bg-${b.id}`} onClick={() => setBackground(b.id)} aria-pressed={background === b.id} className={chip(background === b.id)}>{b.label}</button>
                  ))}
                </div>
                {background !== 'image' && (
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Couleurs">
                    {CLIP_PALETTES.map((p, i) => (
                      <button key={p.name} type="button" onClick={() => setPalette(i)} title={p.name} aria-label={`Couleurs ${p.name}`} aria-pressed={palette === i}
                        className={`h-9 w-9 rounded-full border-2 ${palette === i ? 'border-cyan-400' : 'border-transparent'}`}
                        style={{ background: `linear-gradient(135deg, ${p.a}, ${p.b})`, boxShadow: `inset 0 0 0 3px ${p.accent}55` }} />
                    ))}
                  </div>
                )}
                {(background === 'image' || background === 'visualiseur') && (
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="h-10 inline-flex cursor-pointer items-center rounded-xl border border-nv-line px-3 text-[12px] font-bold hover:bg-nv-accent/10">
                      🖼 {userImage ? 'Changer d\'image' : 'Importer une image'}
                      <input type="file" accept="image/*" className="sr-only" data-testid="clip-image-input" onChange={e => void pickImage(e.target.files?.[0])} />
                    </label>
                    {userImage && <button type="button" onClick={() => setUserImage(null)} className="text-[12px] underline text-nv-muted">{beatCover ? 'Revenir à la pochette du beat' : 'Retirer l\'image'}</button>}
                    {!imgSet && background === 'image' && <span className="text-[12px] text-nv-muted">Pas de pochette pour ce beat : importe une image (sinon dégradé).</span>}
                  </div>
                )}
              </section>

              {/* Titre / artiste */}
              <section aria-label="Titre et artiste" className="grid gap-2 sm:grid-cols-2">
                <label className="block text-[12px] text-nv-muted">Titre
                  <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.stopPropagation()} maxLength={60} data-testid="clip-title"
                    className="mt-1 block h-10 w-full rounded-xl border border-nv-line bg-black/20 px-3 text-[13px] text-nv-ink outline-none focus:border-cyan-400" />
                </label>
                <label className="block text-[12px] text-nv-muted">Artiste
                  <input value={artist} onChange={e => setArtist(e.target.value)} onKeyDown={e => e.stopPropagation()} maxLength={40} placeholder="Ton nom d'artiste" data-testid="clip-artist"
                    className="mt-1 block h-10 w-full rounded-xl border border-nv-line bg-black/20 px-3 text-[13px] text-nv-ink outline-none focus:border-cyan-400" />
                </label>
              </section>

              {/* Droits */}
              <div data-testid="clip-rights" data-full={rights.full ? '1' : '0'} className={`rounded-2xl border p-3 text-[12px] ${rights.full ? 'border-emerald-400/40' : 'border-amber-400/40'}`}>
                {checking ? <span className="text-nv-muted">Vérification de ta licence…</span>
                  : rights.full ? <span>✓ Clip complet : jusqu'à 60 s, le passage de ton choix.</span>
                    : (
                      <div className="space-y-2">
                        <p><b>{rights.reason}</b> : clip limité comme l'extrait à partager (30 s au plus, sur un passage où tu chantes).</p>
                        {unbought > 0
                          ? <button type="button" onClick={onBuyBeat} className="h-9 rounded-lg bg-amber-400 px-3 text-[12px] font-black text-black">🛒 Acheter l'instru : clip jusqu'à 60 s</button>
                          : onOpenExport && <button type="button" onClick={onOpenExport} className="h-9 rounded-lg bg-amber-400 px-3 text-[12px] font-black text-black">Débloquer l'export du projet</button>}
                      </div>
                    )}
              </div>

              {/* Créer */}
              {support && !support.ok ? (
                <p className="text-[13px] text-red-400" role="alert" data-testid="clip-unsupported">Ce navigateur ne sait pas créer de vidéo. Ouvre NOVA dans Chrome ou Edge (ordinateur ou Android), ou dans l'appli Windows.</p>
              ) : (
                <div className="space-y-2">
                  {working ? (
                    <div>
                      <div className="h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-gradient-to-r from-cyan-400 to-violet-500 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                      <div className="mt-2 flex items-center gap-2">
                        <p className="flex-1 text-[12px] text-nv-muted" role="status" data-testid="clip-progress">
                          {busy === 'render' ? 'Mix du passage…' : 'Création de la vidéo…'} {Math.round(progress * 100)} %{support?.method === 'mediarecorder' && busy === 'encode' ? ' (en temps réel sur ce navigateur : laisse la page ouverte)' : ''}
                        </p>
                        <button type="button" onClick={() => abortRef.current?.abort()} className="h-9 rounded-lg border border-nv-line px-3 text-[12px] font-bold">Annuler</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" onClick={exportClip} disabled={!!problem || checking || !support || (rights.needsVoice && !hasVoice)} data-testid="clip-export"
                      className="h-12 w-full rounded-2xl bg-gradient-to-r from-cyan-400 to-violet-500 text-[14px] font-black text-black disabled:opacity-40">
                      🎬 Créer le clip ({Math.round(range.duration)} s, {support?.ext === 'webm' ? 'WebM' : 'MP4'})
                    </button>
                  )}
                  {noLyrics && !working && <p className="text-[11px] text-nv-muted">Sans paroles, le clip montre le titre, l'artiste et le fond.</p>}
                </div>
              )}
              {done && (
                <div className="space-y-2" data-testid="clip-done" data-secs={done.secs} data-method={done.method}>
                  <p className="text-[13px] font-bold text-emerald-400" role="status">
                    Clip prêt ✓ {done.name} ({done.mb} Mo, créé en {done.secs} s). Publie-le sur TikTok ou en Reel.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {canShareFile(done.blob, done.name) && (
                      <button type="button" onClick={() => void shareFile(done.blob, done.name).catch(() => setError('Partage impossible : utilise « Enregistrer » puis publie le fichier.'))}
                        className="h-10 rounded-xl bg-cyan-500 px-4 text-[13px] font-black text-black">📤 Partager…</button>
                    )}
                    <button type="button" onClick={() => void saveBlob(done.blob, done.name)} className="h-10 rounded-xl border border-nv-line px-4 text-[13px] font-bold">⬇️ Enregistrer à nouveau</button>
                  </div>
                </div>
              )}
              {error && <p className="text-[13px] text-red-400" role="alert" data-testid="clip-error">{error}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default LyricClipModal;
