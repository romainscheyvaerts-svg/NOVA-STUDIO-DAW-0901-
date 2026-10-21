import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QM_STYLES, QM_INTENSITIES, QM_TARGETS, QmCancelled, QmIntensity, QmStyleId, styleOf, intensityOf } from '../utils/quickMaster';
import { fmtDb, PLATFORM_TARGETS } from '../utils/masterAssistant';
import { QuickMasterEngine, decodeAudioFile } from '../services/quickMasterEngine';
import { MasterExportAccess, masterExportAccess, masterFileKey, unlockMasterExport } from '../services/quickMasterBilling';
import { encodeWav } from '../utils/audioFormats';
import { buildDeliveryZip, type PackageFile } from '../utils/distributionPackage';
import { saveBlob } from '../utils/saveBlob';
import { LOUDNESS_TITLE } from '../utils/jargon';
import {
  albumCue, albumLayout, albumManifest, albumTitleFile, assembleAlbum, cleanTitle, concatWavParts, duplicateIsrcs, isrcOf, lufsSpread,
  moveItem, titleFileName, titleSpec, ALBUM_MAX_TITLES, ALBUM_SPREAD_MAX, GAP_CHOICES, OFFSET_CHOICES, XFADE_CHOICES, type AlbumTitleSpec,
} from '../utils/albumMaster';

/**
 * « Masteriser un EP / un album » (écart 22) : plusieurs titres masterisés par le moteur du
 * Master express (même style, même intensité, même cible : niveaux homogènes), dans l'ordre du
 * disque, avec les blancs ou les fondus enchaînés entre titres, puis livrés : un WAV 24 bits par
 * titre + feuille de minutage .cue (avec les ISRC) + fiche, ou l'album d'un seul tenant.
 * Écoute gratuite ; l'export suit la règle d'export de NOVA titre par titre
 * (services/quickMasterBilling.ts : admin, Nova Pro, déjà payé, sinon paiement).
 */
interface Props { onClose: () => void }

interface Title extends AlbumTitleSpec {
  id: string;
  file: File;
  duration: number;
  sampleRate: number;
  key: string | null;
  before?: { lufs: number; truePeak: number };
  after?: { lufs: number; truePeak: number };
  /** Master à la fréquence de l'album (ce qu'on écoute = ce qu'on exporte). */
  master?: Float32Array[];
  error?: string;
}

const PREF_KEY = 'nova.albummaster.prefs';
const readPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; } };
const ACCEPT = 'audio/*,.wav,.mp3,.flac,.aif,.aiff,.m4a,.ogg';
const fmtTime = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
let idSeq = 0;
const newId = () => `al-${Date.now().toString(36)}-${(idSeq++).toString(36)}`;

/** Rééchantillonne (fréquence de l'album) ; rien à faire si elle est déjà la bonne. */
async function toRate(ch: Float32Array[], from: number, to: number): Promise<Float32Array[]> {
  if (from === to) return ch;
  const n = Math.ceil((ch[0].length * to) / from);
  const ctx = new OfflineAudioContext(2, n, to);
  const b = new AudioBuffer({ length: ch[0].length, numberOfChannels: 2, sampleRate: from });
  b.copyToChannel(ch[0] as Float32Array<ArrayBuffer>, 0); b.copyToChannel((ch[1] || ch[0]) as Float32Array<ArrayBuffer>, 1);
  const src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination); src.start();
  const out = await ctx.startRendering();
  return [new Float32Array(out.getChannelData(0)), new Float32Array(out.getChannelData(1))];
}

const transitionValue = (t: AlbumTitleSpec) => (t.xfadeNext > 0 ? `x:${t.xfadeNext}` : `g:${t.gapAfter}`);
const transitionLabel = (v: string) => { const [k, s] = v.split(':'); const n = String(+s).replace('.', ','); return k === 'x' ? `Fondu enchaîné ${n} s` : +s === 0 ? 'Sans blanc (enchaîné)' : `Blanc de ${n} s`; };
const TRANSITIONS = [...GAP_CHOICES.map(g => `g:${g}`), ...XFADE_CHOICES.filter(x => x > 0).map(x => `x:${x}`)];

const AlbumMasterPage: React.FC<Props> = ({ onClose }) => {
  const saved = useMemo(readPrefs, []);
  const [titles, setTitles] = useState<Title[]>([]);
  const titlesRef = useRef(titles);
  titlesRef.current = titles;
  const [album, setAlbum] = useState<string>(saved.album || '');
  const [artist, setArtist] = useState<string>(saved.artist || '');
  const [style, setStyle] = useState<QmStyleId>(saved.style || 'rap');
  const [intensity, setIntensity] = useState<QmIntensity>(saved.intensity || 'moyen');
  const [targetId, setTargetId] = useState<string>(saved.target || 'spotify');
  const [busy, setBusy] = useState<{ label: string; p: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [access, setAccess] = useState<Record<string, MasterExportAccess>>({});
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportMsg, setExportMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const engineRef = useRef<QuickMasterEngine | null>(null);
  if (!engineRef.current) engineRef.current = new QuickMasterEngine();
  const engine = engineRef.current;
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const audioRef = useRef<{ ctx: AudioContext; src: AudioBufferSourceNode | null } | null>(null);

  const target = QM_TARGETS.find(t => t.id === targetId) || QM_TARGETS[0];
  const albumRate = titles[0]?.sampleRate || 48000;
  const mastered = titles.length > 0 && titles.every(t => t.master);
  const spread = mastered ? lufsSpread(titles.map(t => t.after!.lufs), titles.map(t => t.offsetDb)) : null;
  const dupes = duplicateIsrcs(titles);
  const badIsrc = titles.filter(t => isrcOf(t.isrc) === null);
  const total = titles.reduce((s, t) => s + t.duration, 0);

  useEffect(() => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ style, intensity, target: targetId, album, artist })); } catch { /* stockage indisponible */ } }, [style, intensity, targetId, album, artist]);
  useEffect(() => () => { cancelled.current = true; engine.dispose(); try { audioRef.current?.src?.stop(); void audioRef.current?.ctx.close(); } catch { /* */ } }, [engine]);
  // Réglages du master changés : les masters calculés ne correspondent plus (on les relance d'un clic).
  const masterKey = `${style}|${intensity}|${targetId}`;
  const lastKey = useRef(masterKey);
  useEffect(() => {
    if (lastKey.current === masterKey) return;
    lastKey.current = masterKey;
    setTitles(ts => ts.map(t => ({ ...t, master: undefined, after: undefined })));
  }, [masterKey]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);

  // ---------------------------------------------------------------- Titres
  const addFiles = useCallback(async (files: File[]) => {
    setError(null); setExportMsg(null);
    const room = ALBUM_MAX_TITLES - titlesRef.current.length;
    const list = files.slice(0, Math.max(0, room));
    if (files.length > list.length) setError(`${ALBUM_MAX_TITLES} titres au plus : ${files.length - list.length} fichier(s) ignoré(s).`);
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      setBusy({ label: `Lecture de « ${f.name} » (${i + 1}/${list.length})…`, p: i / list.length });
      try {
        const d = await decodeAudioFile(f);
        const key = await masterFileKey(d.bytes).catch(() => null);
        const t: Title = { ...titleSpec(cleanTitle(f.name)), id: newId(), file: f, duration: d.duration, sampleRate: d.sampleRate, key };
        setTitles(ts => [...ts, t]);
      } catch (e: any) {
        setError(`« ${f.name} » : ${e?.message || 'fichier illisible'}`);
      }
    }
    setBusy(null);
  }, []);

  const update = (id: string, patch: Partial<Title>) => setTitles(ts => ts.map(t => (t.id === id ? { ...t, ...patch } : t)));
  const setOffset = (id: string, offsetDb: number) => setTitles(ts => ts.map(t => (t.id === id ? { ...t, offsetDb, master: undefined, after: undefined } : t)));
  const setTransition = (id: string, v: string) => { const [k, s] = v.split(':'); update(id, k === 'x' ? { xfadeNext: +s, gapAfter: 0 } : { gapAfter: +s, xfadeNext: 0 }); };

  // ---------------------------------------------------------------- Mastering
  const masterAll = useCallback(async () => {
    const list = titlesRef.current;
    if (!list.length) return;
    setError(null); setExportMsg(null);
    cancelled.current = false;
    const rate = list[0].sampleRate;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (cancelled.current) break;
      const tag = `Titre ${i + 1}/${list.length} · ${t.name}`;
      try {
        setBusy({ label: `${tag} : lecture…`, p: i / list.length });
        const d = await decodeAudioFile(t.file);
        const ch = await toRate(d.ch, d.sampleRate, rate);
        setBusy({ label: `${tag} : analyse…`, p: i / list.length });
        const before = await engine.load('track', ch, rate, true);
        const r = await engine.render({ style, intensity, target: { ...target, lufs: target.lufs + t.offsetDb } }, false,
          (label, p) => setBusy({ label: `${tag} : ${label}`, p: (i + p) / list.length }));
        setTitles(ts => ts.map(x => (x.id === t.id ? { ...x, before: { lufs: before.lufs, truePeak: before.truePeak }, after: { lufs: r.after.lufs, truePeak: r.after.truePeak }, master: r.out, error: undefined } : x)));
      } catch (e: any) {
        if (e instanceof QmCancelled) break;
        setTitles(ts => ts.map(x => (x.id === t.id ? { ...x, error: e?.message || 'échec du mastering' } : x)));
      }
    }
    setBusy(null);
  }, [engine, style, intensity, target]);

  const cancel = () => { cancelled.current = true; engine.cancelAll(); setBusy(null); };

  // ---------------------------------------------------------------- Écoute
  const stopAudio = () => { try { audioRef.current?.src?.stop(); } catch { /* */ } if (audioRef.current) audioRef.current.src = null; setPlaying(null); };
  const playChannels = async (ch: Float32Array[], what: string) => {
    stopAudio();
    if (!audioRef.current) { const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext; audioRef.current = { ctx: new AC({ latencyHint: 'playback' }), src: null }; }
    const { ctx } = audioRef.current;
    try { await ctx.resume(); } catch { /* */ }
    const b = ctx.createBuffer(2, ch[0].length, albumRate);
    b.copyToChannel(ch[0] as Float32Array<ArrayBuffer>, 0); b.copyToChannel((ch[1] || ch[0]) as Float32Array<ArrayBuffer>, 1);
    const src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination);
    src.onended = () => { if (audioRef.current?.src === src) { audioRef.current.src = null; setPlaying(null); } };
    src.start();
    audioRef.current.src = src;
    setPlaying(what);
  };
  const playTitle = (t: Title) => { if (playing === `t:${t.id}`) { stopAudio(); return; } if (t.master) void playChannels(t.master, `t:${t.id}`); };
  /** Enchaînement i → i+1 : 6 s de fin, le blanc ou le fondu, 6 s de début. */
  const playTransition = (i: number) => {
    const a = titles[i], b = titles[i + 1];
    if (!a?.master || !b?.master) return;
    if (playing === `x:${i}`) { stopAudio(); return; }
    const n = Math.round(6 * albumRate);
    const tail = a.master.map(c => c.subarray(Math.max(0, c.length - Math.max(n, Math.round(a.xfadeNext * albumRate) * 2))));
    const head = b.master.map(c => c.subarray(0, Math.min(c.length, Math.max(n, Math.round(a.xfadeNext * albumRate) * 2))));
    void playChannels(assembleAlbum([tail, head], [a, b], albumRate).ch, `x:${i}`);
  };

  // ---------------------------------------------------------------- Export (règle d'export de NOVA, titre par titre)
  useEffect(() => {
    let live = true;
    const keys = titles.map(t => t.key).filter((k): k is string => !!k && !access[k]);
    keys.forEach(k => { void masterExportAccess(k).then(a => { if (live) setAccess(x => ({ ...x, [k]: a })); }).catch(() => { /* réessayé à l'export */ }); });
    return () => { live = false; };
  }, [titles.map(t => t.key).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const locked = titles.filter(t => !t.key || !access[t.key] || !['admin', 'pro', 'unlocked'].includes(access[t.key].kind));
  const accessKnown = titles.every(t => t.key && access[t.key]);

  const unlock = async (t: Title) => {
    if (!t.key) return;
    setExporting(`Déblocage de « ${t.name} »…`);
    const u = await unlockMasterExport(t.key, { access: access[t.key], onWaiting: () => setExporting('En attente du paiement (onglet Stripe)…') });
    setExporting(null);
    setExportMsg({ text: u.message, ok: u.ok });
    if (u.ok) { try { const a = await masterExportAccess(t.key); setAccess(x => ({ ...x, [t.key!]: a })); } catch { /* */ } }
  };

  const folder = `${(artist || 'Artiste').trim()} - ${(album || 'Album').trim()}`.replace(/[\\/:*?"<>|]+/g, ' ');
  const exportTitles = async () => {
    if (!mastered || locked.length) return;
    setExportMsg(null);
    try {
      const masters = titles.map(t => t.master!);
      const files: PackageFile[] = [];
      const names: string[] = [];
      for (let i = 0; i < titles.length; i++) {
        setExporting(`WAV 24 bits : titre ${i + 1}/${titles.length}…`);
        await new Promise(r => setTimeout(r, 0));
        const name = titleFileName(i, titles[i].name);
        names.push(name);
        files.push({ name, data: encodeWav(albumTitleFile(i, masters, titles, albumRate), { sampleRate: albumRate, bits: 24 }) });
      }
      const lay = albumLayout(masters.map(m => m[0].length), titles, albumRate);
      const albumWav = `${folder}.wav`;
      files.push({ name: 'Minutage (album).cue', data: albumCue({ album: album || 'Album', artist: artist || 'Artiste', file: albumWav, specs: titles, starts: lay.starts, sampleRate: albumRate }) });
      files.push({ name: 'metadonnees_album.json', data: JSON.stringify(albumManifest({ album: album || 'Album', artist: artist || 'Artiste', specs: titles,
        results: titles.map(t => ({ lufs: t.after!.lufs, truePeak: t.after!.truePeak, duration: t.master![0].length / albumRate })), starts: lay.starts, sampleRate: albumRate,
        target: { label: target.label, lufs: target.lufs, ceiling: target.ceiling }, files: names }), null, 2) });
      setExporting('Création du .zip…');
      const zip = await buildDeliveryZip(`${folder} (Album)`, files);
      await saveBlob(zip, `${folder} (Album).zip`);
      setExportMsg({ text: `✅ ${titles.length} titres téléchargés (WAV 24 bits, minutage .cue, fiche).`, ok: true });
    } catch (e: any) {
      setExportMsg({ text: `Export impossible : ${e?.message || e}`, ok: false });
    } finally { setExporting(null); }
  };
  const exportAlbum = async () => {
    if (!mastered || locked.length) return;
    setExportMsg(null);
    try {
      const masters = titles.map(t => t.master!);
      const parts: Uint8Array[] = [];
      for (let i = 0; i < titles.length; i++) {
        setExporting(`Album d’un seul tenant : titre ${i + 1}/${titles.length}…`);
        await new Promise(r => setTimeout(r, 0));
        parts.push(encodeWav(albumTitleFile(i, masters, titles, albumRate), { sampleRate: albumRate, bits: 24 }));
      }
      const lay = albumLayout(masters.map(m => m[0].length), titles, albumRate);
      const wavName = `${folder}.wav`;
      const wav = new Blob(concatWavParts(parts) as BlobPart[], { type: 'audio/wav' });
      const cue = albumCue({ album: album || 'Album', artist: artist || 'Artiste', file: wavName, specs: titles, starts: lay.starts, sampleRate: albumRate });
      setExporting('Création du .zip…');
      const zip = await buildDeliveryZip(`${folder} (Album d'un seul tenant)`, [{ name: wavName, data: wav }, { name: `${folder}.cue`, data: cue }]);
      await saveBlob(zip, `${folder} (Album d'un seul tenant).zip`);
      setExportMsg({ text: '✅ Album d’un seul tenant téléchargé (WAV 24 bits + feuille .cue).', ok: true });
    } catch (e: any) {
      setExportMsg({ text: `Export impossible : ${e?.message || e}`, ok: false });
    } finally { setExporting(null); }
  };

  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); const fs = Array.from(e.dataTransfer.files || []); if (fs.length) void addFiles(fs); };
  const exportBlockedWhy = !mastered ? 'Masterise d’abord tous les titres.' : badIsrc.length ? 'Corrige les ISRC invalides (ou laisse-les vides).' : dupes.length ? 'Deux titres ont le même ISRC.' : !accessKnown ? 'Vérification du compte…' : locked.length ? 'Débloque d’abord les titres ci-dessous.' : null;

  return (
    <div className="fixed inset-0 z-[270] bg-black/70 backdrop-blur-sm flex items-stretch justify-center" role="dialog" aria-modal="true" aria-label="Masteriser un EP ou un album"
      data-nova-album="" onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(false); }} onDrop={onDrop}>
      <div className="w-full lg:max-w-6xl lg:my-4 overflow-y-auto overflow-x-hidden bg-nv-bg lg:rounded-2xl border border-white/10 shadow-2xl text-white">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 sm:px-5 py-3 bg-nv-bg/95 backdrop-blur border-b border-white/10">
          <div className="min-w-0">
            <h2 className="text-base font-black tracking-tight"><span aria-hidden="true" className="mr-1.5">💿</span>Masteriser un EP / un album</h2>
            <p className="text-[11px] text-slate-400 leading-snug truncate">Tous tes titres au même niveau, dans l’ordre, avec leurs blancs ou fondus. Écoute gratuite.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" title="Fermer (Échap)" className="w-10 h-10 shrink-0 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center"><i className="fas fa-times" aria-hidden="true"></i></button>
        </div>

        <div className="p-4 sm:p-5 space-y-5">
          <input ref={input} type="file" accept={ACCEPT} multiple className="hidden" data-album-input="" onChange={e => { const fs = Array.from(e.target.files || []); if (fs.length) void addFiles(fs); e.target.value = ''; }} />

          {/* 1. Titres */}
          <section>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-400"><span className="text-slate-500 mr-1">1 ·</span>Les titres, dans l’ordre</h3>
              {titles.length > 0 && <span className="text-[11px] text-slate-400">{titles.length} titre{titles.length > 1 ? 's' : ''} · {fmtTime(total)}</span>}
            </div>
            {titles.length === 0 ? (
              <button type="button" data-album-drop="" onClick={() => input.current?.click()} disabled={!!busy}
                className={`w-full rounded-2xl border-2 border-dashed px-4 py-8 sm:py-10 text-center transition-colors ${dragOver ? 'border-amber-400 bg-amber-400/10' : 'border-white/15 bg-white/[0.03] hover:bg-white/[0.06]'}`}>
                {busy ? <p className="text-[13px] text-slate-300"><i className="fas fa-circle-notch fa-spin mr-2" aria-hidden="true"></i>{busy.label}</p> : <>
                  <i className="fas fa-compact-disc text-3xl text-amber-400 mb-3" aria-hidden="true"></i>
                  <p className="text-[15px] font-black">Dépose les titres de ton EP ou de ton album</p>
                  <p className="mt-1 text-[12px] text-slate-400">WAV, MP3 ou FLAC · 2 à {ALBUM_MAX_TITLES} titres · ou <span className="underline text-white">choisis les fichiers</span></p>
                  <p className="mt-3 text-[11px] text-slate-500">Les fichiers restent sur ton appareil : tout est calculé ici, rien n’est envoyé.</p>
                </>}
              </button>
            ) : (
              <div className="space-y-2" data-album-list="">
                {titles.map((t, i) => {
                  const isrcBad = isrcOf(t.isrc) === null, isrcDup = !!isrcOf(t.isrc) && dupes.includes(isrcOf(t.isrc)!);
                  return (
                    <React.Fragment key={t.id}>
                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-2.5 sm:p-3" data-album-title={i + 1}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="w-7 h-7 shrink-0 rounded-lg bg-amber-400/15 text-amber-300 text-[12px] font-black flex items-center justify-center">{i + 1}</span>
                          <input value={t.name} onChange={e => update(t.id, { name: e.target.value.slice(0, 80) })} aria-label={`Titre ${i + 1}`} data-album-name={i + 1}
                            className="flex-1 min-w-[140px] h-9 px-2 rounded-lg bg-white/5 border border-white/10 text-[13px] font-bold" />
                          <span className="text-[11px] text-slate-400 font-mono" title={LOUDNESS_TITLE}>{fmtTime(t.duration)}{t.before ? ` · ${fmtDb(t.before.lufs)} → ` : ''}{t.after ? <b className="text-white" data-album-lufs={i + 1}>{fmtDb(t.after.lufs)} LUFS</b> : ''}{t.after ? ` · ${fmtDb(t.after.truePeak)} dBTP` : ''}</span>
                          <div className="flex items-center gap-1 ml-auto">
                            <button type="button" onClick={() => playTitle(t)} disabled={!t.master} aria-label={playing === `t:${t.id}` ? `Arrêter ${t.name}` : `Écouter le master de ${t.name}`} title={t.master ? 'Écouter le master' : 'Masterise d’abord'}
                              className={`w-9 h-9 rounded-lg ${playing === `t:${t.id}` ? 'bg-cyan-400 text-black' : 'bg-white/10 hover:bg-white/15'} disabled:opacity-35`}><i className={`fas ${playing === `t:${t.id}` ? 'fa-stop' : 'fa-play'}`} aria-hidden="true" /></button>
                            <button type="button" onClick={() => setTitles(ts => moveItem(ts, i, i - 1))} disabled={i === 0} aria-label={`Monter ${t.name}`} title="Plus tôt dans le disque" className="w-9 h-9 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-30"><i className="fas fa-arrow-up" aria-hidden="true" /></button>
                            <button type="button" onClick={() => setTitles(ts => moveItem(ts, i, i + 1))} disabled={i === titles.length - 1} aria-label={`Descendre ${t.name}`} title="Plus tard dans le disque" className="w-9 h-9 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-30"><i className="fas fa-arrow-down" aria-hidden="true" /></button>
                            <button type="button" onClick={() => setTitles(ts => ts.filter(x => x.id !== t.id))} aria-label={`Retirer ${t.name}`} title="Retirer du disque" className="w-9 h-9 rounded-lg bg-white/5 hover:bg-rose-500/20 text-rose-300"><i className="fas fa-times" aria-hidden="true" /></button>
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                          <label className="flex items-center gap-2 text-[11px] text-slate-400">ISRC
                            <input value={t.isrc} onChange={e => update(t.id, { isrc: e.target.value.slice(0, 20) })} placeholder="FR-XXX-26-00001" aria-label={`ISRC du titre ${i + 1}`} data-album-isrc={i + 1}
                              aria-invalid={isrcBad || isrcDup} className={`w-40 h-8 px-2 rounded-lg bg-white/5 border text-[12px] font-mono uppercase ${isrcBad || isrcDup ? 'border-rose-400' : 'border-white/10'}`} />
                          </label>
                          {(isrcBad || isrcDup) && <span className="text-[11px] text-rose-300" role="alert">{isrcBad ? 'ISRC invalide (2 lettres, 3 caractères, 7 chiffres).' : 'Même ISRC qu’un autre titre.'}</span>}
                          <label className="flex items-center gap-2 text-[11px] text-slate-400" title="Niveau visé par rapport aux autres titres (un interlude peut être plus doux).">Niveau
                            <select value={t.offsetDb} onChange={e => setOffset(t.id, +e.target.value)} aria-label={`Niveau relatif du titre ${i + 1}`} data-album-offset={i + 1}
                              className="h-8 px-1.5 rounded-lg bg-white/5 border border-white/10 text-[12px]">
                              {OFFSET_CHOICES.map(o => <option key={o} value={o}>{o === 0 ? 'comme les autres' : `${fmtDb(o, 0)} dB (plus doux)`}</option>)}
                            </select>
                          </label>
                          {t.error && <span className="text-[11px] text-rose-300" role="alert">{t.error}</span>}
                        </div>
                      </div>
                      {i < titles.length - 1 && (
                        <div className="flex flex-wrap items-center gap-2 pl-9" data-album-transition={i + 1}>
                          <i className="fas fa-level-down-alt text-slate-500 text-[11px]" aria-hidden="true" />
                          <select value={transitionValue(t)} onChange={e => setTransition(t.id, e.target.value)} aria-label={`Enchaînement entre le titre ${i + 1} et le titre ${i + 2}`}
                            className="h-8 px-1.5 rounded-lg bg-white/5 border border-white/10 text-[12px]">
                            {TRANSITIONS.map(v => <option key={v} value={v}>{transitionLabel(v)}</option>)}
                          </select>
                          <button type="button" onClick={() => playTransition(i)} disabled={!t.master || !titles[i + 1].master} data-album-play-transition={i + 1}
                            className={`h-8 px-3 rounded-lg text-[11px] font-bold ${playing === `x:${i}` ? 'bg-cyan-400 text-black' : 'bg-white/10 hover:bg-white/15'} disabled:opacity-35`}>
                            <i className={`fas ${playing === `x:${i}` ? 'fa-stop' : 'fa-play'} mr-1.5`} aria-hidden="true" />Écouter l’enchaînement
                          </button>
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
                <button type="button" onClick={() => input.current?.click()} disabled={!!busy || titles.length >= ALBUM_MAX_TITLES} data-album-add=""
                  className="h-10 px-4 rounded-xl border border-dashed border-white/20 text-[12px] font-bold text-slate-300 hover:text-white disabled:opacity-40"><i className="fas fa-plus mr-1.5" aria-hidden="true" />Ajouter des titres</button>
              </div>
            )}
            {error && <p className="mt-2 text-[12px] text-rose-300" role="alert">{error}</p>}
          </section>

          {/* 2. Son et cible */}
          <div className="grid lg:grid-cols-3 gap-4">
            <section>
              <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2"><span className="text-slate-500 mr-1">2 ·</span>Style</h3>
              <div className="grid grid-cols-2 gap-2">
                {QM_STYLES.map(s => (
                  <button key={s.id} type="button" data-album-style={s.id} aria-pressed={s.id === style} onClick={() => setStyle(s.id)} title={s.hint}
                    className={`min-h-10 rounded-xl border px-3 py-1.5 text-left text-[12px] font-black ${s.id === style ? 'bg-amber-400 text-black border-amber-300' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}><span aria-hidden="true" className="mr-1">{s.emoji}</span>{s.label}</button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-slate-500">{styleOf(style).hint}</p>
            </section>
            <section>
              <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2"><span className="text-slate-500 mr-1">3 ·</span>Intensité</h3>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Intensité">
                {QM_INTENSITIES.map(x => (
                  <button key={x.id} type="button" role="radio" aria-checked={x.id === intensity} onClick={() => setIntensity(x.id)} title={x.hint}
                    className={`h-10 rounded-xl border text-[12px] font-black ${x.id === intensity ? 'bg-cyan-400 text-black border-cyan-300' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>{x.label}</button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-slate-500">{intensityOf(intensity).hint}</p>
            </section>
            <section>
              <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2"><span className="text-slate-500 mr-1">4 ·</span>Où va ton disque ?</h3>
              <div className="grid grid-cols-2 gap-2">
                {QM_TARGETS.map(t => (
                  <button key={t.id} type="button" data-album-cible={t.id} aria-pressed={t.id === targetId} onClick={() => setTargetId(t.id)} title={PLATFORM_TARGETS.find(p => p.id === t.id)?.hint}
                    className={`rounded-xl border px-2.5 py-1.5 text-left ${t.id === targetId ? 'bg-amber-400 text-black border-amber-300' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
                    <div className="text-[12px] font-black truncate">{t.label}</div>
                    <div className={`text-[10px] font-mono ${t.id === targetId ? 'text-black/70' : 'text-slate-400'}`}>{fmtDb(t.lufs, 0)} LUFS · {fmtDb(t.ceiling, 0)} dBTP</div>
                  </button>
                ))}
              </div>
            </section>
          </div>

          {/* 5. Mastering */}
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4" data-album-mastering="">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => void masterAll()} disabled={!titles.length || !!busy} data-album-master=""
                className="h-11 px-5 rounded-xl bg-amber-400 hover:bg-amber-300 text-black text-[13px] font-black disabled:opacity-40">
                <i className="fas fa-magic mr-2" aria-hidden="true" />{mastered ? 'Remasteriser l’album' : `Masteriser ${titles.length > 1 ? `les ${titles.length} titres` : 'l’album'}`}
              </button>
              {busy && <button type="button" onClick={cancel} className="h-11 px-4 rounded-xl bg-white/10 hover:bg-white/15 text-[12px] font-bold">Annuler</button>}
              {spread !== null && (
                <p className={`text-[12px] font-bold ${spread <= ALBUM_SPREAD_MAX ? 'text-emerald-300' : 'text-amber-300'}`} data-album-spread={spread.toFixed(2)} title={LOUDNESS_TITLE}>
                  {spread <= ALBUM_SPREAD_MAX ? '✓' : '⚠'} Écart de niveau entre les titres : {fmtDb(spread)} LU{spread <= ALBUM_SPREAD_MAX ? ' — disque homogène' : ' — au-dessus de 0,5 LU'}
                </p>
              )}
            </div>
            {busy && titles.length > 0 && (
              <div className="mt-3" data-album-progress="">
                <div className="flex items-center justify-between text-[11px] text-slate-300"><span className="truncate"><i className="fas fa-circle-notch fa-spin mr-1.5" aria-hidden="true"></i>{busy.label}</span><span className="font-mono">{Math.round(busy.p * 100)} %</span></div>
                <div className="mt-1 h-1.5 rounded bg-white/10 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(busy.p * 100)}>
                  <div className="h-full bg-amber-400 transition-all" style={{ width: `${Math.max(3, Math.round(busy.p * 100))}%` }} />
                </div>
              </div>
            )}
            {!busy && !mastered && titles.length > 0 && <p className="mt-2 text-[11px] text-slate-500">Même style, même intensité et même cible pour tous les titres : ils sortent au même niveau. Compte environ 10 à 20 s par titre.</p>}
          </section>

          {/* 6. Livraison */}
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4" data-album-export="">
            <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2"><span className="text-slate-500 mr-1">5 ·</span>Livraison</h3>
            <div className="flex flex-wrap gap-3 mb-3">
              <label className="flex items-center gap-2 text-[11px] text-slate-400">Artiste<input value={artist} onChange={e => setArtist(e.target.value.slice(0, 80))} className="w-44 h-8 px-2 rounded-lg bg-white/5 border border-white/10 text-[12px]" data-album-artist="" /></label>
              <label className="flex items-center gap-2 text-[11px] text-slate-400">Titre du disque<input value={album} onChange={e => setAlbum(e.target.value.slice(0, 80))} className="w-52 h-8 px-2 rounded-lg bg-white/5 border border-white/10 text-[12px]" data-album-name-disque="" /></label>
            </div>
            {mastered && accessKnown && locked.length > 0 && (
              <div className="mb-3 space-y-1.5">
                <p className="text-[11px] text-slate-400">L’export suit la règle de NOVA, titre par titre (gratuit avec Nova Pro) :</p>
                {locked.map(t => (
                  <button key={t.id} type="button" onClick={() => void unlock(t)} disabled={!!exporting}
                    className="mr-2 h-9 px-3 rounded-xl bg-white/10 hover:bg-white/15 text-[12px] font-bold disabled:opacity-40">
                    {t.key && access[t.key]?.loginRequired ? `Se connecter pour « ${t.name} »` : `Débloquer « ${t.name} »${t.key && access[t.key]?.price ? ` · ${access[t.key].price}` : ''}`}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void exportTitles()} disabled={!!exportBlockedWhy || !!exporting} data-album-export-zip=""
                className="h-11 px-4 rounded-xl bg-amber-400 hover:bg-amber-300 text-black text-[13px] font-black disabled:opacity-40"><i className="fas fa-file-archive mr-2" aria-hidden="true" />Un fichier par titre (.zip)</button>
              <button type="button" onClick={() => void exportAlbum()} disabled={!!exportBlockedWhy || !!exporting} data-album-export-wav=""
                className="h-11 px-4 rounded-xl bg-white/10 hover:bg-white/15 text-[13px] font-black disabled:opacity-40"><i className="fas fa-compact-disc mr-2" aria-hidden="true" />Album d’un seul tenant (.wav + .cue)</button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500" data-album-export-hint="">
              {exporting || exportBlockedWhy || 'WAV 24 bits sans métadonnée intégrée (règle des distributeurs) ; les ISRC et le minutage sont dans la feuille .cue et la fiche metadonnees_album.json.'}
            </p>
            {exportMsg && <p className={`mt-1 text-[12px] font-bold ${exportMsg.ok ? 'text-emerald-300' : 'text-rose-300'}`} role="status" data-album-export-msg="">{exportMsg.text}</p>}
          </section>
        </div>
      </div>
    </div>
  );
};

export default AlbumMasterPage;
