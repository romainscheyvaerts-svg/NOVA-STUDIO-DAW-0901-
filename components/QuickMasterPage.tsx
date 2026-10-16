import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  QM_STYLES, QM_INTENSITIES, QM_TARGETS, QmAnalysis, QmIntensity, QmResult, QmStyleId, QmTarget, QmCancelled,
  referenceTarget, listenGainsDb, platformPlayback, masterFileName, styleOf, intensityOf,
} from '../utils/quickMaster';
import { THIRD_OCTAVE_CENTERS, normalizeCurve, matchBandLabel } from '../utils/referenceMatch';
import { fmtDb, PLATFORM_TARGETS } from '../utils/masterAssistant';
import { DecodedFile, QuickMasterEngine, QuickMasterPlayer, Source, decodeAudioFile, masterMp3, masterWav24, waveformPeaks } from '../services/quickMasterEngine';
import { MasterExportAccess, masterExportAccess, masterFileKey, unlockMasterExport } from '../services/quickMasterBilling';
import { saveBlob } from '../utils/saveBlob';
import { canvasTheme } from '../utils/canvasTheme';
import { useTheme } from '../utils/themeStore';
import { encodeWav } from '../utils/audioFormats';

/**
 * « Masteriser un morceau » (lot 4a) : le mastering d'un simple fichier, sans
 * projet, comme le mastering gratuit de BandLab. On dépose un WAV / MP3 /
 * FLAC, on choisit un style et une intensité (et, si on veut, un morceau de
 * référence) ; Nova rend le master tout de suite, on compare au même volume
 * perçu, on lit LUFS, crête vraie et dynamique, puis on télécharge en WAV
 * 24 bits ou MP3. Écoute gratuite et illimitée ; l'export suit la règle
 * d'export de NOVA (services/quickMasterBilling.ts).
 */
interface Props { onClose: () => void }

const PREF_KEY = 'nova.quickmaster.prefs';
const readPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; } };
const ACCEPT = 'audio/*,.wav,.mp3,.flac,.aif,.aiff,.m4a,.ogg';

const fmtTime = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

interface RefTrack { name: string; analysis: QmAnalysis }

const SectionTitle: React.FC<{ n?: string; children: React.ReactNode; right?: React.ReactNode }> = ({ n, children, right }) => (
  <div className="flex items-center justify-between gap-2 mb-2">
    <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-400">{n && <span className="text-slate-500 mr-1">{n} ·</span>}{children}</h3>
    {right}
  </div>
);

const QuickMasterPage: React.FC<Props> = ({ onClose }) => {
  const saved = useMemo(readPrefs, []);
  const { theme } = useTheme();
  const [style, setStyle] = useState<QmStyleId>(saved.style || 'rap');
  const [intensity, setIntensity] = useState<QmIntensity>(saved.intensity || 'moyen');
  const [targetId, setTargetId] = useState<string>(saved.target && saved.target !== 'reference' ? saved.target : 'spotify');
  const [file, setFile] = useState<DecodedFile | null>(null);
  const [before, setBefore] = useState<QmAnalysis | null>(null);
  const [ref, setRef] = useState<RefTrack | null>(null);
  const [useRefEq, setUseRefEq] = useState(true);
  const [result, setResult] = useState<QmResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [step, setStep] = useState<{ label: string; p: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refBusy, setRefBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<'track' | 'ref' | null>(null);
  const [equalLevel, setEqualLevel] = useState(true);
  const [, tick] = useState(0);
  const [fileKey, setFileKey] = useState<string | null>(null);
  const [access, setAccess] = useState<MasterExportAccess | null>(null);
  const [format, setFormat] = useState<'wav' | 'mp3'>(saved.format === 'mp3' ? 'mp3' : 'wav');
  const [exportMsg, setExportMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);

  const engineRef = useRef<QuickMasterEngine | null>(null);
  const playerRef = useRef<QuickMasterPlayer | null>(null);
  if (!engineRef.current) engineRef.current = new QuickMasterEngine();
  if (!playerRef.current) playerRef.current = new QuickMasterPlayer();
  const engine = engineRef.current, player = playerRef.current;
  const trackInput = useRef<HTMLInputElement>(null);
  const refInput = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const payCancelled = useRef(false);
  const renderSeq = useRef(0);

  useEffect(() => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ style, intensity, target: targetId, format })); } catch { /* stockage indisponible */ } }, [style, intensity, targetId, format]);
  useEffect(() => { player.onChange = () => tick(x => x + 1); return () => { player.onChange = undefined; }; }, [player]);
  useEffect(() => () => { payCancelled.current = true; player.dispose(); engine.dispose(); }, [player, engine]);

  // Échap ferme la fenêtre.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); }
      if (e.key === ' ' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); togglePlayRef.current(); }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);

  const target: QmTarget = targetId === 'reference' && ref ? referenceTarget(ref.analysis.lufs) : (QM_TARGETS.find(t => t.id === targetId) || QM_TARGETS[0]);
  useEffect(() => { if (targetId === 'reference' && !ref) setTargetId('spotify'); }, [targetId, ref]);

  // ---------------------------------------------------------------- Chargement
  const loadTrack = useCallback(async (f: File) => {
    setError(null); setResult(null); setBefore(null); setExportMsg(null); setAccess(null); setFileKey(null); setStep(null);
    renderSeq.current++;
    engine.cancelAll();
    player.pause(); player.setBuffer('master', null, 44100); setMasterPeaks(null);
    setBusy('Lecture du fichier…');
    try {
      const d = await decodeAudioFile(f);
      // Mémoire (téléphone) : le lecteur garde sa copie, les canaux partent au Worker sans copie,
      // et les octets du fichier ne servent qu'à l'empreinte d'achat.
      setPeaks(waveformPeaks(d.ch, 600));
      player.setBuffer('original', d.ch, d.sampleRate);
      player.select('original');
      void masterFileKey(d.bytes).then(k => setFileKey(k));
      setFile({ ...d, ch: [], bytes: new Uint8Array(0) });
      setBusy('Analyse : loudness, crête vraie, spectre…');
      const a = await engine.load('track', d.ch, d.sampleRate, true);
      setBefore(a);
    } catch (e: any) {
      setFile(null);
      setError(e?.message || 'Fichier illisible.');
    } finally { setBusy(null); }
  }, [engine, player]);

  const loadRef = useCallback(async (f: File) => {
    setRefBusy('Lecture de la référence…'); setError(null);
    try {
      const d = await decodeAudioFile(f);
      setRefBusy('Analyse de la référence…');
      player.setBuffer('reference', d.ch, d.sampleRate);
      const a = await engine.load('ref', d.ch, d.sampleRate, true);
      setRef({ name: f.name.replace(/\.[^.]+$/, ''), analysis: a });
      setUseRefEq(true);
    } catch (e: any) {
      setError(`Référence illisible : ${e?.message || 'format non pris en charge'}`);
    } finally { setRefBusy(null); }
  }, [engine, player]);

  const removeRef = () => {
    engine.clearReference();
    if (player.selected === 'reference') player.select(result ? 'master' : 'original');
    player.setBuffer('reference', null, 44100);
    setRef(null);
  };

  // ---------------------------------------------------------------- Rendu
  useEffect(() => {
    if (!before || !file) return;
    const seq = ++renderSeq.current;
    const t = window.setTimeout(() => {
      setStep({ label: 'Préparation…', p: 0.01 }); setError(null);
      engine.render({ style, intensity, target }, !!ref && useRefEq, (label, p) => { if (seq === renderSeq.current) setStep({ label, p }); })
        .then(r => {
          if (seq !== renderSeq.current) return;
          // Le lecteur garde le master (c'est aussi lui qu'on exporte) : les canaux rendus sont libérés.
          setMasterPeaks(waveformPeaks(r.out, 600));
          player.setBuffer('master', r.out, file.sampleRate);
          setResult({ ...r, out: [] });
          if (player.selected === 'original' && !player.playing) player.select('master');
          setStep(null);
        })
        .catch(e => {
          if (e instanceof QmCancelled || seq !== renderSeq.current) return;
          setStep(null); setError(e?.message || 'Le master a échoué.');
        });
    }, 200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [before, file, style, intensity, target.id, target.lufs, ref && useRefEq ? ref : null]);

  // Niveaux d'écoute : au même volume perçu (chacun ramené au plus faible), ou bruts.
  const gains = useMemo(() => listenGainsDb({ original: before?.lufs ?? NaN, master: result?.after.lufs ?? null, reference: ref?.analysis.lufs ?? null }), [before, result, ref]);
  useEffect(() => {
    player.setLevelsDb(equalLevel ? { original: gains.original, master: gains.master, reference: gains.reference } : { original: 0, master: 0, reference: 0 });
  }, [gains, equalLevel, player]);

  // Accès à l'export (pour le libellé du bouton), lu d'avance : Stripe s'ouvre pendant le clic.
  useEffect(() => {
    if (!fileKey || !result) return;
    let live = true;
    setAccess(null);
    void masterExportAccess(fileKey).then(a => { if (live) setAccess(a); });
    return () => { live = false; };
  }, [fileKey, !!result]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- Lecture
  const togglePlay = () => { if (!file) return; if (player.playing) player.pause(); else void player.play(); };
  const togglePlayRef = useRef(togglePlay);
  togglePlayRef.current = togglePlay;

  // Tête de lecture + forme d'onde
  const [peaks, setPeaks] = useState<{ min: Float32Array; max: Float32Array } | null>(null);
  const [masterPeaks, setMasterPeaks] = useState<{ min: Float32Array; max: Float32Array } | null>(null);
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d');
    if (!g) return;
    const c = canvasTheme();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const mid = h / 2, cols = peaks.min.length, bw = w / cols;
    const bars = (p: { min: Float32Array; max: Float32Array }, color: string) => {
      g.fillStyle = color;
      for (let i = 0; i < cols; i++) {
        const top = mid - Math.min(1, p.max[i]) * mid * 0.95, bot = mid - Math.max(-1, p.min[i]) * mid * 0.95;
        g.fillRect(i * bw, top, Math.max(1, bw - 0.4), Math.max(1, bot - top));
      }
    };
    const showMaster = masterPeaks && player.selected === 'master';
    bars(peaks, showMaster ? c.ink(0.16) : c.accentFill(0.75));
    if (showMaster && masterPeaks) bars(masterPeaks, c.light ? 'rgba(217, 119, 6, 0.75)' : 'rgba(251, 191, 36, 0.7)');
    if (player.duration) {
      const x = (player.position() / player.duration) * w;
      g.fillStyle = c.ink(0.9);
      g.fillRect(Math.round(x), 0, 2, h);
    }
  }, [peaks, masterPeaks, player]);
  const posRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    // Dessin et position sans re-rendu React (60 images/s).
    const loop = () => { draw(); if (posRef.current) posRef.current.textContent = fmtTime(player.position()); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [draw, player, theme]);

  const seekFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    player.seek(((e.clientX - r.left) / r.width) * player.duration);
  };

  // ---------------------------------------------------------------- Export
  const doExport = async () => {
    if (!result || !file || !fileKey) return;
    setExportMsg(null);
    payCancelled.current = false;
    // Accès en erreur (réseau) : le serveur est réinterrogé au clic.
    const u = await unlockMasterExport(fileKey, { access: access && access.kind !== 'error' ? access : null, isCancelled: () => payCancelled.current, onWaiting: () => setExporting('En attente du paiement (onglet Stripe)…') });
    if (!u.ok) { setExporting(null); setExportMsg({ text: u.message, ok: false }); return; }
    setAccess(a => (!a || a.kind === 'admin' || a.kind === 'pro') ? a : { ...a, kind: 'unlocked' });
    try {
      setExporting(format === 'wav' ? 'Fichier WAV 24 bits…' : 'Encodage MP3 320 kb/s…');
      const name = masterFileName(file.name, result.style, result.target, format);
      // Le tampon ÉCOUTÉ, tel quel : ce qu'on entend est ce qu'on télécharge.
      const played = player.playedChannels('master');
      if (!played) throw new Error('master absent');
      const blob = format === 'wav' ? masterWav24(played, file.sampleRate) : await masterMp3(played, file.sampleRate);
      await saveBlob(blob, name);
      setExportMsg({ text: `${u.via === 'admin' || u.via === 'deja_paye' ? '' : u.message + ' '}« ${name} » téléchargé.`, ok: true });
    } catch (e: any) {
      setExportMsg({ text: `Export impossible : ${e?.message || 'erreur'}`, ok: false });
    } finally { setExporting(null); }
  };

  // Contrôle « écoute = export » (QA) : empreinte du tampon réellement joué, codé comme l'export WAV.
  useEffect(() => {
    (window as any).__novaQuickMaster = {
      async playedWavSha256() {
        const ch = player.playedChannels('master');
        if (!ch || !file) return null;
        const bytes = encodeWav(ch, { sampleRate: file.sampleRate, bits: 24 });
        const d = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
        return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
      },
      state: () => ({ result: result ? { lufs: result.after.lufs, truePeak: result.after.truePeak, plr: result.after.plr, refDistance: result.refDistance, eq: result.eq, target: result.target } : null, before, selected: player.selected, playing: player.playing }),
    };
    return () => { delete (window as any).__novaQuickMaster; };
  }, [player, file, result, before]);

  // ---------------------------------------------------------------- Vue
  const onDrop = (which: 'track' | 'ref') => (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragOver(null);
    const f = e.dataTransfer.files?.[0];
    if (f) void (which === 'track' ? loadTrack(f) : loadRef(f));
  };
  const onDragOver = (which: 'track' | 'ref') => (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(which); };

  const rendering = !!step;
  const state = busy ? 'chargement' : rendering ? 'rendu' : result ? 'pret' : file ? 'analyse' : 'vide';
  const sel = player.selected;
  const playable = !!file && !busy;
  const exportLabel = !access ? 'Vérification du compte…'
    : access.kind === 'admin' ? 'Télécharger · gratuit (admin)'
    : access.kind === 'pro' ? 'Télécharger · inclus dans Nova Pro'
    : access.kind === 'unlocked' ? 'Télécharger'
    : access.kind === 'error' ? 'Télécharger (vérification du compte)'
    : access.price ? `Payer ${access.price} et télécharger` : 'Payer et télécharger';

  const sources: { id: Source; label: string; hint: string; on: string }[] = [
    { id: 'original', label: 'Original', hint: 'Ton fichier tel que tu l’as déposé.', on: 'bg-white text-black' },
    { id: 'master', label: 'Master Nova', hint: 'Le master, exactement le fichier que tu téléchargeras.', on: 'bg-amber-400 text-black' },
    { id: 'reference', label: 'Référence', hint: 'Ton morceau de référence.', on: 'bg-fuchsia-500 text-black' },
  ];
  const levelOf = (s: Source) => (s === 'original' ? gains.original : s === 'master' ? gains.master : gains.reference);

  const Row = ({ label, hint, o, m, r, unit, cible, good }: { label: string; hint: string; o?: number; m?: number; r?: number; unit: string; cible?: string; good?: boolean }) => (
    <tr className="border-t border-white/5" title={hint}>
      <td className="py-1.5 pr-2 text-slate-300">{label}{cible && <div className="text-[10px] text-slate-500">{cible}</div>}</td>
      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-slate-400 whitespace-nowrap">{o !== undefined && Number.isFinite(o) ? `${fmtDb(o)}` : '—'}</td>
      <td className={`py-1.5 px-2 text-right font-mono tabular-nums font-black whitespace-nowrap ${good === false ? 'text-red-300' : 'text-white'}`}>{m !== undefined && Number.isFinite(m) ? `${fmtDb(m)}` : '—'}</td>
      {ref && <td className="py-1.5 pl-2 text-right font-mono tabular-nums text-fuchsia-300 whitespace-nowrap">{r !== undefined && Number.isFinite(r) ? `${fmtDb(r)}` : '—'}</td>}
      <td className="py-1.5 pl-2 text-left text-[10px] text-slate-500">{unit}</td>
    </tr>
  );

  // Spectre (SVG : suit le thème par les classes de couleur)
  const spectrum = useMemo(() => {
    if (!before) return null;
    const curves: { key: string; cls: string; label: string; v: number[] }[] = [{ key: 'o', cls: 'text-slate-400', label: 'Original', v: normalizeCurve(before.curve) }];
    if (result) curves.push({ key: 'm', cls: 'text-amber-500', label: 'Master', v: normalizeCurve(result.after.curve) });
    if (ref) curves.push({ key: 'r', cls: 'text-fuchsia-500', label: 'Référence', v: normalizeCurve(ref.analysis.curve) });
    // Courbes alignées sur les médiums (1 kHz) pour comparer les formes.
    const k1 = THIRD_OCTAVE_CENTERS.indexOf(1000);
    curves.forEach(c => { const o = c.v[k1]; c.v = c.v.map(x => x - o); });
    return curves;
  }, [before, result, ref]);
  const W = 600, H = 150, yOf = (db: number) => H / 2 - Math.max(-24, Math.min(24, db)) * (H / 2 - 6) / 24;

  return (
    <div className="fixed inset-0 z-[270] bg-black/70 backdrop-blur-sm flex items-stretch justify-center" role="dialog" aria-modal="true" aria-label="Masteriser un morceau"
      data-nova-qm="" data-qm-state={state}
      onDragOver={onDragOver('track')} onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(null); }} onDrop={onDrop('track')}>
      <div className="w-full lg:max-w-6xl lg:my-4 overflow-y-auto overflow-x-hidden bg-nv-bg lg:rounded-2xl border border-white/10 shadow-2xl text-white">
        {/* En-tête */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 sm:px-5 py-3 bg-nv-bg/95 backdrop-blur border-b border-white/10">
          <div className="min-w-0">
            <h2 className="text-base font-black tracking-tight"><span aria-hidden="true" className="mr-1.5">🎚️</span>Masteriser un morceau</h2>
            <p className="text-[11px] text-slate-400 leading-snug truncate">Sans projet : dépose ton son, choisis un style, écoute. Écoute gratuite et illimitée.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={togglePlay} disabled={!playable} aria-label={player.playing ? 'Pause' : 'Lecture'} title="Écouter / pause (barre d’espace)" data-qm-play=""
              className={`w-10 h-10 rounded-full flex items-center justify-center disabled:opacity-40 ${player.playing ? 'bg-cyan-400 text-black' : 'bg-white text-black'}`}><i className={`fas ${player.playing ? 'fa-pause' : 'fa-play'}`} aria-hidden="true"></i></button>
            <button type="button" onClick={onClose} aria-label="Fermer" title="Fermer (Échap)" className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center"><i className="fas fa-times" aria-hidden="true"></i></button>
          </div>
        </div>

        <div className="p-4 sm:p-5 space-y-5">
          <input ref={trackInput} type="file" accept={ACCEPT} className="hidden" data-qm-input="" onChange={e => { const f = e.target.files?.[0]; if (f) void loadTrack(f); e.target.value = ''; }} />
          <input ref={refInput} type="file" accept={ACCEPT} className="hidden" data-qm-ref-input="" onChange={e => { const f = e.target.files?.[0]; if (f) void loadRef(f); e.target.value = ''; }} />

          {/* 1. Le morceau */}
          {!file ? (
            <button type="button" data-qm-drop="" onClick={() => trackInput.current?.click()} disabled={!!busy}
              className={`w-full rounded-2xl border-2 border-dashed px-4 py-8 sm:py-10 text-center transition-colors ${dragOver === 'track' ? 'border-amber-400 bg-amber-400/10' : 'border-white/15 bg-white/[0.03] hover:bg-white/[0.06]'}`}>
              {busy ? <p className="text-[13px] text-slate-300"><i className="fas fa-circle-notch fa-spin mr-2" aria-hidden="true"></i>{busy}</p> : <>
                <i className="fas fa-file-audio text-3xl text-amber-400 mb-3" aria-hidden="true"></i>
                <p className="text-[15px] font-black">Dépose ton morceau ici</p>
                <p className="mt-1 text-[12px] text-slate-400">WAV, MP3 ou FLAC · jusqu’à 12 minutes · ou <span className="underline text-white">choisis un fichier</span></p>
                <p className="mt-3 text-[11px] text-slate-500">Le fichier reste sur ton appareil : tout est calculé ici, rien n’est envoyé.</p>
              </>}
            </button>
          ) : (
            <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4" data-qm-morceau="">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-black truncate" title={file.name}>{file.name}</p>
                  <p className="text-[11px] text-slate-400">{fmtTime(file.duration)} · {(file.sampleRate / 1000).toString().replace('.', ',')} kHz{before ? ` · ${fmtDb(before.lufs)} LUFS · crête ${fmtDb(before.truePeak)} dBTP` : ''}</p>
                </div>
                <button type="button" onClick={() => trackInput.current?.click()} className="h-9 px-3 rounded-xl bg-white/10 hover:bg-white/15 text-[12px] font-bold"><i className="fas fa-sync-alt mr-1.5" aria-hidden="true"></i>Changer de fichier</button>
              </div>
              <canvas ref={canvasRef} className="w-full h-16 sm:h-20 cursor-pointer rounded-lg bg-white/[0.03] touch-none" aria-label="Forme d’onde : clique pour te déplacer"
                onPointerDown={seekFromEvent} />
              <div className="mt-1 flex justify-between text-[10px] font-mono text-slate-500"><span ref={posRef}>{fmtTime(player.position())}</span><span>{fmtTime(player.duration)}</span></div>

              {/* Barre de rendu */}
              {(busy || rendering) && (
                <div className="mt-2" data-qm-progress="">
                  <div className="flex items-center justify-between text-[11px] text-slate-300"><span><i className="fas fa-circle-notch fa-spin mr-1.5" aria-hidden="true"></i>{busy || step?.label}</span>{step && <span className="font-mono">{Math.round(step.p * 100)} %</span>}</div>
                  <div className="mt-1 h-1.5 rounded bg-white/10 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((step?.p || 0) * 100)}>
                    <div className="h-full bg-amber-400 transition-all" style={{ width: `${Math.round((step?.p || 0.03) * 100)}%` }} />
                  </div>
                  {result && rendering && <p className="mt-1 text-[10px] text-slate-500">Tu entends encore la version précédente pendant le calcul.</p>}
                </div>
              )}

              {/* A/B */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <div className="flex rounded-xl overflow-hidden border border-white/15" role="radiogroup" aria-label="Que veux-tu entendre ?">
                  {sources.filter(s => s.id !== 'reference' || ref).map(s => {
                    const on = sel === s.id;
                    const dis = s.id === 'master' ? !result : false;
                    return (
                      <button key={s.id} type="button" role="radio" aria-checked={on} disabled={dis} data-qm-ab={s.id} title={s.hint}
                        onClick={() => { player.select(s.id); if (!player.playing) void player.play(); }}
                        className={`h-10 px-3 sm:px-4 text-[12px] font-black disabled:opacity-40 ${on ? s.on : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>{s.label}</button>
                    );
                  })}
                </div>
                <label className="flex items-center gap-2 text-[12px] text-slate-300 min-h-10" title="On ne monte jamais un son : le plus fort est baissé au niveau du plus faible. Sans ça, le plus fort paraît toujours meilleur.">
                  <input type="checkbox" checked={equalLevel} onChange={e => setEqualLevel(e.target.checked)} className="w-4 h-4 accent-amber-400" data-qm-egal="" />
                  Même volume perçu
                </label>
              </div>
              <p className="mt-1 text-[11px] text-slate-500" data-qm-niveau="">
                {equalLevel
                  ? (Math.abs(levelOf(sel)) > 0.05 ? `Comparaison honnête : ${sel === 'master' ? 'le master' : sel === 'reference' ? 'la référence' : 'l’original'} est baissé${sel === 'reference' ? 'e' : ''} de ${fmtDb(Math.abs(levelOf(sel)))} dB pour l’écoute (le fichier téléchargé, lui, n’est pas baissé).` : 'Comparaison honnête : tout est écouté au même volume perçu.')
                  : 'Volumes réels : le master paraît plus fort, donc « meilleur » ; coche « Même volume perçu » pour juger le son.'}
              </p>
            </section>
          )}
          {error && <p className="text-[12px] text-red-300" role="alert" data-qm-erreur="">{error}</p>}

          <div className="grid lg:grid-cols-2 gap-5">
            {/* Réglages */}
            <div className="space-y-5 min-w-0">
              <section>
                <SectionTitle n="1">Style</SectionTitle>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {QM_STYLES.map(s => (
                    <button key={s.id} type="button" data-qm-style={s.id} aria-pressed={s.id === style} onClick={() => setStyle(s.id)} title={s.hint}
                      className={`min-h-11 rounded-xl border px-3 py-2 text-left ${s.id === style ? 'bg-amber-400 text-black border-amber-300' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
                      <span className="text-[13px] font-black"><span aria-hidden="true" className="mr-1">{s.emoji}</span>{s.label}</span>
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-slate-500">{styleOf(style).hint}</p>
              </section>

              <section>
                <SectionTitle n="2">Intensité</SectionTitle>
                <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Intensité">
                  {QM_INTENSITIES.map(i => (
                    <button key={i.id} type="button" role="radio" aria-checked={i.id === intensity} data-qm-intensite={i.id} onClick={() => setIntensity(i.id)} title={i.hint}
                      className={`h-11 rounded-xl border text-[13px] font-black ${i.id === intensity ? 'bg-cyan-400 text-black border-cyan-300' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>{i.label}</button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-slate-500">{intensityOf(intensity).hint}</p>
              </section>

              <section>
                <SectionTitle n="3">Où va ton morceau ?</SectionTitle>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {[...QM_TARGETS, ...(ref ? [referenceTarget(ref.analysis.lufs)] : [])].map(t => (
                    <button key={t.id} type="button" data-qm-cible={t.id} aria-pressed={t.id === targetId} onClick={() => setTargetId(t.id)}
                      title={PLATFORM_TARGETS.find(p => p.id === t.id)?.hint || 'Le même niveau que ton morceau de référence.'}
                      className={`rounded-xl border px-3 py-2 text-left ${t.id === targetId ? 'bg-amber-400 text-black border-amber-300' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
                      <div className="text-[12px] font-black truncate">{t.label}</div>
                      <div className={`text-[11px] font-mono ${t.id === targetId ? 'text-black/70' : 'text-slate-400'}`}>{fmtDb(t.lufs, t.id === 'reference' ? 1 : 0)} LUFS · {fmtDb(t.ceiling, 0)} dBTP</div>
                    </button>
                  ))}
                </div>
              </section>

              <section className={`rounded-2xl border p-3 sm:p-4 ${dragOver === 'ref' ? 'border-fuchsia-400 bg-fuchsia-500/10' : 'border-white/10 bg-white/[0.03]'}`} data-qm-reference=""
                onDragOver={onDragOver('ref')} onDrop={onDrop('ref')}>
                <SectionTitle n="4" right={<span className="text-[10px] text-slate-500">facultatif</span>}>Morceau de référence</SectionTitle>
                {!ref ? (
                  <>
                    <p className="text-[11px] text-slate-400 mb-2">Un son que tu aimes : Nova cale l’équilibre tonal de ton master dessus (EQ douce, ±4 dB au plus) et peut viser son niveau.</p>
                    <button type="button" onClick={() => refInput.current?.click()} disabled={!!refBusy} data-qm-ref-ajout=""
                      className="h-10 px-4 rounded-xl bg-white/10 hover:bg-white/15 text-[12px] font-bold disabled:opacity-50"><i className="fas fa-file-import mr-1.5" aria-hidden="true"></i>{refBusy || 'Ajouter une référence'}</button>
                  </>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[12px] text-slate-300 min-w-0"><b className="text-white">{ref.name}</b> · {fmtDb(ref.analysis.lufs)} LUFS · crête {fmtDb(ref.analysis.truePeak)} dBTP</p>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => refInput.current?.click()} className="h-9 px-3 rounded-xl bg-white/10 hover:bg-white/15 text-[11px] font-bold">Changer</button>
                        <button type="button" onClick={removeRef} className="h-9 px-3 rounded-xl bg-white/5 border border-white/10 text-[11px] font-bold">Retirer</button>
                      </div>
                    </div>
                    <label className="mt-2 flex items-center gap-2 text-[12px] text-slate-300 min-h-10">
                      <input type="checkbox" checked={useRefEq} onChange={e => setUseRefEq(e.target.checked)} className="w-4 h-4 accent-fuchsia-500" data-qm-ref-eq="" />
                      Caler l’équilibre tonal sur la référence (au lieu de la courbe du style)
                    </label>
                  </>
                )}
              </section>
            </div>

            {/* Résultats */}
            <div className="space-y-5 min-w-0">
              <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4" data-qm-mesures="" data-lufs={result ? result.after.lufs.toFixed(2) : ''} data-tp={result ? result.after.truePeak.toFixed(2) : ''}>
                <SectionTitle>Mesures</SectionTitle>
                {!before ? <p className="text-[12px] text-slate-500">Dépose un morceau : sa loudness, sa crête vraie et sa dynamique s’affichent ici, avant et après.</p> : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[12px]">
                        <thead><tr className="text-[10px] uppercase tracking-widest text-slate-500">
                          <th className="text-left font-black">Mesure</th><th className="text-right font-black px-2">Original</th><th className="text-right font-black px-2">Master</th>
                          {ref && <th className="text-right font-black pl-2">Réf.</th>}<th />
                        </tr></thead>
                        <tbody>
                          <Row label="Loudness intégrée" cible={`cible ${fmtDb(target.lufs, target.id === 'reference' ? 1 : 0)} LUFS`} o={before.lufs} m={result?.after.lufs} r={ref?.analysis.lufs} unit="LUFS" good={result ? Math.abs(result.after.lufs - target.lufs) <= 0.5 : undefined}
                            hint="Loudness intégrée BS.1770 : ce que mesurent Spotify, Apple Music, YouTube et TikTok." />
                          <Row label="Crête vraie" cible={`plafond ${fmtDb(target.ceiling, 0)} dBTP`} o={before.truePeak} m={result?.after.truePeak} r={ref?.analysis.truePeak} unit="dBTP" good={result ? result.after.truePeak <= target.ceiling : undefined}
                            hint="Crête entre les échantillons (dBTP) : au-dessus de −1, le MP3 / AAC des plateformes peut saturer." />
                          <Row label="Plage dynamique" cible="crête − loudness (PLR)" o={before.plr} m={result?.after.plr} r={ref?.analysis.plr} unit="dB" hint="Plus c’est bas, plus le son est compressé. Sous 6 dB, ça devient écrasé." />
                          <Row label="Variations de niveau" cible="LRA" o={before.lra} m={result?.after.lra} r={ref?.analysis.lra} unit="LU" hint="Écart entre passages calmes et forts du morceau." />
                        </tbody>
                      </table>
                    </div>
                    {result && (
                      <p className={`mt-2 text-[12px] ${result.reached ? 'text-emerald-300' : 'text-amber-300'}`} data-qm-verdict="">
                        {result.reached ? `✓ Prêt : ${fmtDb(result.after.lufs)} LUFS pour ${fmtDb(target.lufs, target.id === 'reference' ? 1 : 0)} visés, crête vraie ${fmtDb(result.after.truePeak)} dBTP.` : `Cible presque atteinte (${fmtDb(result.after.lufs)} LUFS).`}
                        {result.after.plr < 6 && ' Attention : dynamique faible (son écrasé) — essaie l’intensité Légère ou une cible moins forte.'}
                      </p>
                    )}
                    {result && (
                      <div className="mt-3" data-qm-plateformes="">
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">Sur les plateformes</p>
                        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                          {platformPlayback(result.after.lufs).map(p => (
                            <li key={p.id} className="flex justify-between gap-2"><span className="text-slate-300">{p.label} <span className="text-slate-500">({fmtDb(p.target, 0)})</span></span>
                              <span className={p.changeDb < -0.5 ? 'text-amber-300' : 'text-emerald-300'}>{p.changeDb < -0.5 ? `baissé de ${fmtDb(-p.changeDb)} dB` : 'joué tel quel'}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </section>

              {spectrum && (
                <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4" data-qm-spectre="">
                  <SectionTitle right={<span className="flex gap-3 text-[10px]">{spectrum.map(c => <span key={c.key} className={`${c.cls} font-bold`}>━ {c.label}</span>)}</span>}>Équilibre tonal</SectionTitle>
                  <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Spectre par tiers d’octave de l’original, du master et de la référence">
                    {[-12, 0, 12].map(db => <line key={db} x1={0} x2={W} y1={yOf(db)} y2={yOf(db)} stroke="currentColor" className="text-slate-500" strokeOpacity={db === 0 ? 0.35 : 0.15} strokeWidth={1} />)}
                    {[100, 1000, 10000].map(f => { const i = THIRD_OCTAVE_CENTERS.indexOf(f); const x = (i / (THIRD_OCTAVE_CENTERS.length - 1)) * W; return <g key={f}><line x1={x} x2={x} y1={0} y2={H} stroke="currentColor" className="text-slate-500" strokeOpacity={0.15} strokeWidth={1} /><text x={x + 3} y={H - 4} fontSize={12} fill="currentColor" className="text-slate-500">{f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`}</text></g>; })}
                    {spectrum.map(c => (
                      <polyline key={c.key} fill="none" stroke="currentColor" className={c.cls} strokeWidth={c.key === 'm' ? 2.6 : 1.8} strokeLinejoin="round"
                        points={c.v.map((v, i) => `${((i / (c.v.length - 1)) * W).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ')} />
                    ))}
                  </svg>
                  {result?.refDistance && (
                    <p className="mt-1 text-[12px] text-slate-300" data-qm-ecart="" data-avant={result.refDistance.before.toFixed(2)} data-apres={result.refDistance.after.toFixed(2)}>
                      Écart avec la référence : <b className="text-white">{fmtDb(result.refDistance.tonalBefore)} dB → {fmtDb(result.refDistance.tonalAfter)} dB</b> d’équilibre tonal
                      <span className="text-slate-500"> (tiers d’octave : {fmtDb(result.refDistance.before)} → {fmtDb(result.refDistance.after)} dB)</span>
                    </p>
                  )}
                  {result && (
                    <details className="mt-2 text-[12px] text-slate-300">
                      <summary className="cursor-pointer text-slate-400">Ce que Nova a fait</summary>
                      <ul className="mt-2 space-y-1 list-disc pl-5">
                        <li>EQ {result.eqSource === 'reference' ? 'calée sur la référence' : `vers la courbe ${styleOf(result.style).label}`} : {result.eq.filter(b => Math.abs(b.gainDb) >= 0.1).map(matchBandLabel).join(' · ') || 'aucune correction nécessaire'}</li>
                        <li>Mastering Transient : emphase des attaques {Math.round(result.mt.emphasis)} %, densité +{fmtDb(result.mt.limitGain)} dB</li>
                        <li>Limiteur crête vraie : +{fmtDb(result.limiter.inputGainDb)} dB, plafond {fmtDb(result.target.ceiling)} dBTP, relâchement {result.limiter.releaseMs} ms</li>
                      </ul>
                    </details>
                  )}
                </section>
              )}

              <section className="rounded-2xl border border-amber-400/30 bg-amber-400/[0.06] p-3 sm:p-4" data-qm-export="">
                <SectionTitle>Télécharger le master</SectionTitle>
                <div className="flex rounded-xl overflow-hidden border border-white/15 w-fit mb-2" role="radiogroup" aria-label="Format">
                  {([['wav', 'WAV 24 bits'], ['mp3', 'MP3 320 kb/s']] as const).map(([id, label]) => (
                    <button key={id} type="button" role="radio" aria-checked={format === id} data-qm-format={id} onClick={() => setFormat(id)}
                      className={`h-10 px-4 text-[12px] font-black ${format === id ? 'bg-cyan-400 text-black' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>{label}</button>
                  ))}
                </div>
                <button type="button" data-qm-telecharger="" onClick={() => void doExport()} disabled={!result || rendering || !!exporting || !fileKey || !access}
                  className="w-full h-12 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 text-black font-black text-[14px] disabled:opacity-50">
                  {exporting ? <><i className="fas fa-circle-notch fa-spin mr-2" aria-hidden="true"></i>{exporting}</> : <><i className="fas fa-download mr-2" aria-hidden="true"></i>{result ? exportLabel : 'Dépose un morceau pour commencer'}</>}
                </button>
                {exporting && exporting.startsWith('En attente') && (
                  <button type="button" onClick={() => { payCancelled.current = true; setExporting(null); }} className="mt-2 text-[12px] underline text-slate-300">Annuler l’attente</button>
                )}
                {exportMsg && <p className={`mt-2 text-[12px] ${exportMsg.ok ? 'text-emerald-300' : 'text-amber-300'}`} role="status" data-qm-export-msg="">{exportMsg.text}</p>}
                <p className="mt-2 text-[11px] text-slate-500">L’écoute est gratuite et illimitée. Tu paies une seule fois par morceau : ensuite toutes ses versions (styles, plateformes, formats) se téléchargent librement. Le fichier téléchargé est exactement celui que tu écoutes.</p>
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default QuickMasterPage;
