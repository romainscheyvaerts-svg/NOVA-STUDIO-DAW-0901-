import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DAWState } from '../types';
import { billingStatus, isExportVoicesUnlocked } from '../services/Billing';
import { saveBlob } from '../utils/saveBlob';
import { LIMITED_MAX, clipLyricLines, clipRights, fmtTime, projectWords, songEnd, voiceSpans, type ClipRange } from '../utils/lyricVideo';
import { CLIP_STYLES, type ClipLook, type ClipStyle } from '../utils/lyricVideoDraw';
import { ClipCancelled } from '../utils/clipVideoEncode';
import { defaultPass, filmedSpan, passList, performanceProblem } from '../utils/videoTake';
import { getMeta, type VideoTakeMeta } from '../utils/videoTakeStore';
import { videoTake } from '../utils/videoTakeRecorder';
import { drawPerformanceFrame, exportPerformance, frameAt, performanceFileName } from '../utils/videoTakeExport';

/**
 * Lot 2b · « 🎬 Exporter la vidéo de la prise » : l'image filmée + le MIX du morceau, calés sur
 * le temps du projet, avec les paroles en karaoké (lot 2a) en option. MP4 H.264 + AAC.
 * Mêmes règles que le clip et l'export : sans licence d'instru ou sans export payé, 30 s au
 * plus sur un passage chanté (utils/lyricVideo · clipRights).
 */
interface Props {
  takeId: string;
  onClose: () => void;
  state: DAWState;
  ownedInstrumentIds?: (string | number)[];
  onBuyBeat: () => void;
  onOpenExport?: () => void;
  onLyricsChange: (text: string) => void;
}

let adminCache: boolean | null = null;
const canShareFile = (blob: Blob, name: string): boolean => {
  try { return !!navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: blob.type })] }); } catch { return false; }
};

type Dur = 'all' | 15 | 30 | 60;

const VideoTakeExportModal: React.FC<Props> = ({ takeId, onClose, state, ownedInstrumentIds = [], onBuyBeat, onOpenExport, onLyricsChange }) => {
  const [meta, setMeta] = useState<VideoTakeMeta | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pass, setPass] = useState<number | undefined>(undefined);
  const [dur, setDur] = useState<Dur>('all');
  const [start, setStart] = useState<number | null>(null);
  const [withLyrics, setWithLyrics] = useState(true);
  const [style, setStyle] = useState<ClipStyle>('tiktok');
  const [offset, setOffset] = useState(0);
  const [measuring, setMeasuring] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [admin, setAdmin] = useState<boolean | null>(adminCache);
  const [exportPaid, setExportPaid] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<null | 'mix' | 'video'>(null);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState<{ name: string; secs: number; mb: number; blob: Blob } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [previewT, setPreviewT] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<ImageBitmap | null>(null);

  const load = useCallback(async () => {
    try {
      const m = await getMeta(takeId);
      if (!m || !m.times) { setLoadErr('Cette vidéo est introuvable sur cet appareil.'); return; }
      setMeta(m); setOffset(m.offsetMs);
      setPass(p => (p !== undefined ? p : m.passes && passList(m.passes).length > 1 ? defaultPass(m.passes) : undefined));
    } catch (e: any) { setLoadErr(`Vidéo illisible (${e?.message || e}).`); }
  }, [takeId]);
  useEffect(() => { void load(); }, [load]);

  // ── Droits : mêmes règles que le clip et la fenêtre Exporter ──
  const owned = useMemo(() => ownedInstrumentIds.map(String), [ownedInstrumentIds]);
  const unbought = useMemo(() => state.tracks.filter(t => t.instrumentId !== undefined && !owned.includes(String(t.instrumentId))).length, [state.tracks, owned]);
  const hasCatalogBeat = state.tracks.some(t => t.instrumentId !== undefined && t.instrumentId !== null && t.instrumentId !== '');
  useEffect(() => {
    let live = true;
    if (adminCache === null) {
      const timeout = new Promise<null>(r => setTimeout(() => r(null), 4000));
      void Promise.race([billingStatus(), timeout]).then(st => { if (st) adminCache = !!st.admin; if (live) setAdmin(st ? !!st.admin : false); });
    } else setAdmin(adminCache);
    if (!hasCatalogBeat && state.id) void isExportVoicesUnlocked(state.id).then(u => { if (live) setExportPaid(u); });
    return () => { live = false; };
  }, [hasCatalogBeat, state.id]);
  const checking = admin === null || (!hasCatalogBeat && admin !== true && exportPaid === null);
  const rights = useMemo(() => clipRights({ admin: admin === true, unboughtCatalog: unbought, hasCatalogBeat, exportPaid }), [admin, unbought, hasCatalogBeat, exportPaid]);
  const spans = useMemo(() => voiceSpans(state.tracks), [state.tracks]);

  // ── Plage filmée ──
  const end = useMemo(() => songEnd(state.tracks), [state.tracks]);
  const span = useMemo(() => (meta?.times ? filmedSpan(meta.times, meta.passes, pass) : null), [meta, pass]);
  const s0 = span ? Math.max(0, span.start) : 0;
  const s1 = span ? Math.max(s0, span.end) : 0;
  const whole = s1 - s0;
  const maxDur = rights.full ? whole : Math.min(whole, LIMITED_MAX);
  const wanted = dur === 'all' ? whole : dur;
  const d = Math.max(0.5, Math.min(wanted, maxDur));
  const range: ClipRange = useMemo(() => {
    const st = Math.min(Math.max(s0, start ?? s0), Math.max(s0, s1 - d));
    return { start: st, duration: d };
  }, [s0, s1, d, start]);
  const problem = !span ? 'Rien n\'est filmé dans cette vidéo.' : performanceProblem(range, rights, spans);
  // Sans licence : on part sur le passage chanté le plus proche du début de la prise.
  useEffect(() => { setStart(null); }, [pass]);

  // ── Paroles (lot 2a) ──
  const words = useMemo(() => projectWords(state.tracks), [state.tracks]);
  const lyr = useMemo(() => clipLyricLines({ lyrics: state.lyrics, words, markers: state.markers, lyricsRegions: state.lyricsRegions, lyricsStart: state.lyricsStart, lyricsSpeed: state.lyricsSpeed, end }),
    [state.lyrics, words, state.markers, state.lyricsRegions, state.lyricsStart, state.lyricsSpeed, end]);
  const noLyrics = lyr.source === 'aucune' || !lyr.lines.length;
  const look: ClipLook = useMemo(() => ({ style, background: 'degrade', palette: 0, title: state.name || '', artist: '' }), [style, state.name]);
  const lyrArg = withLyrics && !noLyrics ? { look, lines: lyr.lines } : null;

  // ── Aperçu : l'image filmée à l'instant choisi, avec les paroles ──
  useEffect(() => { setPreviewT(range.start + Math.min(range.duration / 2, 2)); }, [range.start, range.duration]);
  const redraw = useCallback(() => {
    const cv = canvasRef.current; const g = cv?.getContext('2d');
    if (!cv || !g) return;
    drawPerformanceFrame(g, cv.width, cv.height, imgRef.current, lyrArg, previewT, range);
  }, [lyrArg, previewT, range]);
  useEffect(() => {
    if (!meta) return;
    let live = true;
    const id = setTimeout(() => {
      void frameAt(meta, previewT, pass).then(bmp => {
        if (!live) { bmp?.close(); return; }
        imgRef.current?.close(); imgRef.current = bmp; redraw();
      });
    }, 120);
    return () => { live = false; clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, previewT, pass]);
  useEffect(() => { redraw(); }, [redraw]);
  useEffect(() => () => { imgRef.current?.close(); imgRef.current = null; }, []);

  // ── Calage ──
  const applyOffset = async (v: number) => {
    const m = await videoTake.setTakeOffset(takeId, v);
    if (m) { setMeta(m); setSyncMsg(null); }
  };
  const measure = async () => {
    setMeasuring(true); setSyncMsg(null);
    try {
      const r = await videoTake.measureOn(takeId);
      if (!('why' in r)) {
        const ms = Math.round(Math.abs(r.measure.offsetMs));
        const sens = ms < 1 ? 'image et son déjà calés' : `l'image était en ${r.measure.offsetMs > 0 ? 'retard' : 'avance'} de ${ms} ms`;
        setSyncMsg({ ok: true, text: `✓ Mesuré sur ${r.measure.pairs} ${r.measure.kind === 'flash' ? 'flash' : 'clap'}${r.measure.pairs > 1 ? 's' : ''} : ${sens} (écart entre les mesures : ${Math.round(r.measure.spreadMs)} ms). Corrigé pour cette vidéo et les prochaines avec cette caméra.` });
        await load();
      } else setSyncMsg({ ok: false, text: r.why });
    } finally { setMeasuring(false); }
  };

  // ── Export ──
  const run = async () => {
    if (!meta || busy || problem) return;
    setDone(null); setError(null); setProgress(0);
    const abort = new AbortController();
    abortRef.current = abort;
    const t0 = performance.now();
    try {
      try { await Promise.all(['900', '800', '600'].map(w => (document as any).fonts?.load?.(`${w} 64px Inter`))); } catch { /* police système */ }
      setBusy('mix');
      const res = await exportPerformance({
        meta, state, range, pass, lyrics: lyrArg, signal: abort.signal,
        onProgress: (p, phase) => { setProgress(p); setBusy(phase); },
      });
      const name = performanceFileName(state.name || 'ma performance', res.ext);
      const secs = Math.round((performance.now() - t0) / 100) / 10;
      if (import.meta.env.DEV) (window as any).__novaPerfTest = { blob: res.blob, name, range, pass, plan: res.plan, frames: res.frames, filmed: res.filmedFrames, offsetMs: meta.offsetMs, takeId, totalMs: Math.round(performance.now() - t0), rights };
      await saveBlob(res.blob, name);
      setDone({ name, secs, mb: Math.round(res.blob.size / 1e5) / 10, blob: res.blob });
    } catch (e: any) {
      if (e instanceof ClipCancelled || e?.name === 'ClipCancelled') setError('Création annulée. Rien n\'a été enregistré.');
      else setError(`La vidéo n'a pas pu être créée${e?.message ? ` (${e.message})` : ''}. Réessaie ; si ça recommence, choisis un passage plus court ou recharge la page (ta session est sauvegardée).`);
    } finally { setBusy(null); abortRef.current = null; }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); e.preventDefault();
      if (typing) { setTyping(false); return; }
      if (busy) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, typing, onClose]);

  const chip = (on: boolean) => `min-h-[40px] px-3 rounded-xl border text-[12px] font-bold transition-colors disabled:opacity-40 ${on ? 'border-cyan-400 bg-cyan-500/15 text-nv-ink' : 'border-nv-line text-nv-muted hover:bg-nv-accent/10'}`;
  const vertical = meta ? meta.height > meta.width : true;
  const passes = meta?.passes ? passList(meta.passes) : [];

  return (
    <div className="fixed inset-0 z-[660] flex items-end sm:items-center justify-center bg-black/70 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="perf-title" data-testid="video-export"
      onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="w-full sm:max-w-3xl max-h-[96vh] sm:max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-nv-line bg-nv-panel text-nv-ink shadow-2xl p-4 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="perf-title" className="text-lg font-black">🎬 Vidéo de ta prise</h2>
            <p className="text-[12px] text-nv-muted mt-0.5">Ton image filmée + le mix de ton morceau, calés sur le projet. MP4 prêt pour TikTok, Reels, Shorts ou YouTube.</p>
          </div>
          <button type="button" onClick={onClose} disabled={!!busy} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10 disabled:opacity-40"><i className="fas fa-times" /></button>
        </div>

        {loadErr ? <p className="mt-4 text-[13px] text-red-400" role="alert">{loadErr}</p> : !meta ? <p className="mt-4 text-[13px] text-nv-muted">Ouverture de la vidéo…</p> : (
          <div className="mt-4 grid gap-5 sm:grid-cols-[minmax(0,260px)_1fr]">
            <div className="sticky -top-4 z-10 -mx-4 bg-nv-panel px-4 pb-2 pt-1 sm:mx-0 sm:px-0 sm:pb-0 sm:pt-0 sm:top-0 flex flex-col items-center gap-2 self-start w-[calc(100%+2rem)] sm:w-full">
              <canvas ref={canvasRef} width={meta.width / 2} height={meta.height / 2} data-testid="video-export-preview" aria-label="Aperçu de la vidéo"
                className={`${vertical ? 'h-[30vh] sm:h-[min(44vh,440px)]' : 'w-full'} rounded-2xl border border-nv-line bg-black shadow-xl`} style={{ aspectRatio: vertical ? '9 / 16' : '16 / 9', maxWidth: '100%' }} />
              <input type="range" min={range.start} max={range.start + range.duration} step={0.05} value={Math.min(Math.max(previewT, range.start), range.start + range.duration)}
                onChange={e => setPreviewT(Number(e.target.value))} aria-label="Position dans l'aperçu" className="w-full max-w-[260px] accent-cyan-400" />
              <p className="text-[11px] text-nv-muted">{fmtTime(range.start)} → {fmtTime(range.start + range.duration)} · {Math.round(range.duration)} s</p>
            </div>

            <div className="min-w-0 space-y-4">
              {passes.length > 1 && (
                <section aria-label="Tour de boucle" className="space-y-2">
                  <h3 className="text-[13px] font-bold">Tour de boucle filmé</h3>
                  <div className="flex flex-wrap gap-2">
                    {passes.map(p => <button key={p.pass} type="button" onClick={() => setPass(p.pass)} aria-pressed={pass === p.pass} className={chip(pass === p.pass)}>Tour {p.pass + 1}</button>)}
                  </div>
                </section>
              )}

              <section aria-label="Passage" className="space-y-2">
                <h3 className="text-[13px] font-bold">Passage</h3>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Durée">
                  {(['all', 60, 30, 15] as Dur[]).filter(x => x === 'all' || x < whole).map(x => {
                    const len = x === 'all' ? whole : x;
                    const locked = len > maxDur + 0.01;
                    return (
                      <button key={String(x)} type="button" disabled={locked} data-testid={`video-dur-${x}`} onClick={() => setDur(x)}
                        title={locked ? 'Plus de 30 s avec la licence de l\'instru ou l\'export payé' : undefined} className={chip(dur === x)}>
                        {locked ? '🔒 ' : ''}{x === 'all' ? `Toute la prise (${fmtTime(whole)})` : `${x} s`}
                      </button>
                    );
                  })}
                </div>
                {whole - d > 0.5 && (
                  <div className="flex items-center gap-2">
                    <label htmlFor="video-start" className="shrink-0 text-[12px] text-nv-muted">Début</label>
                    <input id="video-start" type="range" min={s0} max={Math.max(s0, s1 - d)} step={0.5} value={range.start} onChange={e => setStart(Number(e.target.value))} className="min-w-0 flex-1 accent-cyan-400" />
                    <span className="w-12 text-right text-[12px] tabular-nums">{fmtTime(range.start)}</span>
                  </div>
                )}
                {problem && <p className="text-[12px] text-amber-500" role="status" data-testid="video-range-problem">{problem}</p>}
              </section>

              <section aria-label="Paroles" className="space-y-2 rounded-2xl border border-nv-line p-3">
                {typing ? (
                  <div className="space-y-2">
                    <label htmlFor="perf-lyrics" className="block text-[13px] font-bold">Tes paroles</label>
                    <textarea id="perf-lyrics" value={draft} onChange={e => setDraft(e.target.value)} rows={6} onKeyDown={e => e.stopPropagation()}
                      placeholder={'Une ligne par phrase.\nUne ligne vide entre deux parties.'} className="w-full rounded-xl border border-nv-line bg-black/20 p-2.5 text-[13px] text-nv-ink outline-none focus:border-cyan-400" />
                    <div className="flex gap-2">
                      <button type="button" onClick={() => { onLyricsChange(draft); setTyping(false); }} disabled={!draft.trim()} className="h-10 flex-1 rounded-xl bg-cyan-500 text-[13px] font-black text-black disabled:opacity-40">Enregistrer les paroles</button>
                      <button type="button" onClick={() => setTyping(false)} className="h-10 rounded-xl border border-nv-line px-3 text-[12px] font-bold">Annuler</button>
                    </div>
                  </div>
                ) : noLyrics ? (
                  <div className="space-y-2" data-testid="video-no-lyrics">
                    <p className="text-[13px] font-bold">Paroles en karaoké</p>
                    <p className="text-[12px] text-nv-muted">Ajoute tes paroles dans le prompteur ou transcris la prise pour les voir s'afficher sur la vidéo. Sans paroles, la vidéo montre ton image seule.</p>
                    <button type="button" onClick={() => { setDraft(state.lyrics || ''); setTyping(true); }} className="h-10 rounded-xl border border-nv-line px-4 text-[13px] font-bold">Taper les paroles</button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-[13px] font-bold">
                      <input type="checkbox" checked={withLyrics} onChange={e => setWithLyrics(e.target.checked)} className="h-4 w-4 accent-cyan-400" data-testid="video-lyrics-toggle" />
                      Paroles en karaoké sur la vidéo
                      <span className="font-normal text-nv-muted">({lyr.source === 'voix' ? 'calées mot par mot sur ta voix' : 'calées comme le prompteur'})</span>
                    </label>
                    {withLyrics && (
                      <div className="grid grid-cols-2 gap-2">
                        {CLIP_STYLES.map(s => (
                          <button key={s.id} type="button" onClick={() => setStyle(s.id)} aria-pressed={style === s.id} data-testid={`video-style-${s.id}`} className={`${chip(style === s.id)} text-left py-2`}>{s.label}</button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section aria-label="Calage image et son" className="space-y-2">
                <h3 className="text-[13px] font-bold">Calage image ↔ son</h3>
                <p className="text-[12px] text-nv-muted">Automatique : chaque image est placée sur le temps du morceau comme ta prise audio. Si les lèvres semblent décalées, mesure avec un clap ou règle à la main.</p>
                <div className="flex items-center gap-2">
                  <label htmlFor="video-offset" className="shrink-0 text-[12px] text-nv-muted">Image</label>
                  <input id="video-offset" type="range" min={-300} max={300} step={5} value={offset} onChange={e => setOffset(Number(e.target.value))}
                    onPointerUp={() => void applyOffset(offset)} onKeyUp={() => void applyOffset(offset)} onBlur={() => { if (meta && offset !== meta.offsetMs) void applyOffset(offset); }}
                    className="min-w-0 flex-1 accent-cyan-400" data-testid="video-offset" />
                  <span className="w-20 text-right text-[12px] tabular-nums">{offset === 0 ? 'calée' : `${offset > 0 ? '+' : ''}${Math.round(offset)} ms`}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => void measure()} disabled={measuring || !!busy} data-testid="video-measure" className="h-10 rounded-xl border border-cyan-400/60 px-3 text-[12px] font-bold disabled:opacity-40">
                    {measuring ? 'Mesure…' : '🎯 Mesurer avec un clap'}
                  </button>
                  <span className="text-[11px] text-nv-muted">Filme une prise où tu tapes 3 fois dans tes mains face à la caméra, puis mesure.</span>
                </div>
                {syncMsg && <p className={`text-[12px] ${syncMsg.ok ? 'text-emerald-500' : 'text-amber-500'}`} role="status" data-testid="video-measure-result">{syncMsg.text}</p>}
              </section>

              <div data-testid="video-rights" data-full={rights.full ? '1' : '0'} className={`rounded-2xl border p-3 text-[12px] ${rights.full ? 'border-emerald-400/40' : 'border-amber-400/40'}`}>
                {checking ? <span className="text-nv-muted">Vérification de ta licence…</span>
                  : rights.full ? <span>✓ Vidéo complète : toute la prise, avec le mix.</span>
                    : (
                      <div className="space-y-2">
                        <p><b>{rights.reason}</b> : vidéo limitée comme l'extrait à partager (30 s au plus, sur un passage où tu chantes).</p>
                        {unbought > 0
                          ? <button type="button" onClick={onBuyBeat} className="h-9 rounded-lg bg-amber-400 px-3 text-[12px] font-black text-black">🛒 Acheter l'instru : toute la prise</button>
                          : onOpenExport && <button type="button" onClick={onOpenExport} className="h-9 rounded-lg bg-amber-400 px-3 text-[12px] font-black text-black">Débloquer l'export du projet</button>}
                      </div>
                    )}
              </div>

              {busy ? (
                <div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-gradient-to-r from-cyan-400 to-violet-500 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                  <div className="mt-2 flex items-center gap-2">
                    <p className="flex-1 text-[12px] text-nv-muted" role="status" data-testid="video-progress">{busy === 'mix' ? 'Mix du morceau…' : 'Création de la vidéo…'} {Math.round(progress * 100)} %</p>
                    <button type="button" onClick={() => abortRef.current?.abort()} className="h-9 rounded-lg border border-nv-line px-3 text-[12px] font-bold">Annuler</button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => void run()} disabled={!!problem || checking} data-testid="video-export-run"
                  className="h-12 w-full rounded-2xl bg-gradient-to-r from-cyan-400 to-violet-500 text-[14px] font-black text-black disabled:opacity-40">
                  🎬 Créer la vidéo ({fmtTime(range.duration)}, MP4 {meta.width} × {meta.height})
                </button>
              )}
              {done && (
                <div className="space-y-2" data-testid="video-export-done" data-secs={done.secs}>
                  <p className="text-[13px] font-bold text-emerald-500" role="status">Vidéo prête ✓ {done.name} ({done.mb} Mo, créée en {done.secs} s).</p>
                  <div className="flex flex-wrap gap-2">
                    {canShareFile(done.blob, done.name) && (
                      <button type="button" onClick={() => void navigator.share({ files: [new File([done.blob], done.name, { type: done.blob.type })], title: done.name }).catch(() => { /* fermé */ })}
                        className="h-10 rounded-xl bg-cyan-500 px-4 text-[13px] font-black text-black">📤 Partager…</button>
                    )}
                    <button type="button" onClick={() => void saveBlob(done.blob, done.name)} className="h-10 rounded-xl border border-nv-line px-4 text-[13px] font-bold">⬇️ Enregistrer à nouveau</button>
                  </div>
                </div>
              )}
              {error && <p className="text-[13px] text-red-400" role="alert" data-testid="video-export-error">{error}</p>}
              <p className="text-[11px] text-nv-muted">🔒 La vidéo est fabriquée sur cet appareil. Rien n'est envoyé en collaboration ni dans le cloud.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default VideoTakeExportModal;
