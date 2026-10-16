import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DAWState, Track } from '../types';
import { useExportGate } from '../hooks/useExportGate';
import ExportPaywall from './ExportPaywall';
import { exportKeyOf } from '../utils/exportRights';
import { catalogIdsOf } from '../utils/exportProject';
import { openBuyBeat } from '../utils/studioLinks';
import { saveBlob } from '../utils/saveBlob';
import { prepareTracksForOffline } from '../services/VstFreeze';
import { renderMixChannels } from '../services/ExportPipeline';
import { AudioEncoder } from '../services/AudioEncoder';
import { encodeWav, applyTpdfDither, buildId3v2, makeRng, keyToId3, type AudioMeta } from '../utils/audioFormats';
import { resampleChannels } from '../utils/resample';
import { projectRateOf } from '../utils/projectRate';
import { nomTonaliteCourt } from '../utils/musicKey';
import { isVoiceTrack } from '../utils/vocalRoles';
import { isStemSource } from '../utils/stemPlan';
import { projectTimedWords, lyricLineTimes, lyricsFromWords } from '../utils/voiceLyrics';
import { track as trackEvent } from '../utils/analytics';
import {
  DIST_PLATFORMS, platformOf, analyzeAudio, runChecks, summarize, ceilingFor, gainForPeak, gainToward, applyGainDb, removeDc,
  trimPoints, applyTrim, cloneChannels, splitTitle, sentenceCase, stripEmoji, isValidIsrc, normalizeIsrc, num,
  type AudioStats, type Check, type DistMeta, type CoverInfo, type Trim, type Level, type FixId,
} from '../utils/distributionCheck';
import { levelWithLimiter, limitWithGain } from '../utils/distributionLevel';
import { imageInfo, lyricsText, lyricsLrc, deliveryNames, creditsJson, creditsText, buildDeliveryZip, type PackageFile } from '../utils/distributionPackage';

/**
 * Lot 12 BandLab · « Prêt pour Spotify / Apple / TikTok ? »
 *
 * Ouverte depuis la fenêtre Exporter (bouton, utils/distributionBus.ts). Elle :
 *  1. rend le mix comme l'export (services/ExportPipeline.renderMixChannels) et le mesure ;
 *  2. affiche un feu vert / orange / rouge par contrôle (utils/distributionCheck.ts), avec
 *     « Corriger » quand NOVA sait le faire (crête, blanc, DC, niveau, titre, pochette…) ;
 *  3. produit le paquet .zip « Livraison » (utils/distributionPackage.ts).
 *
 * Droits : le paquet suit l'export payant (useExportGate, portée « mix », décidé par le
 * serveur). Instru du catalogue non achetée : feu rouge, « Acheter la licence », aucun fichier.
 */

type Op = { kind: 'trim'; trim: Trim } | { kind: 'dc' } | { kind: 'gain'; db: number } | { kind: 'limit'; gainDb: number; ceiling: number };

const PREFS = 'nova_distribution_prefs';
interface Prefs { platform?: string; artist?: string; composers?: string; producers?: string; bits?: 16 | 24 }
const readPrefs = (): Prefs => {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || '{}') || {};
    if (!p.artist) { const e = JSON.parse(localStorage.getItem('nova_export_prefs') || '{}') || {}; if (e.artist) p.artist = e.artist; }
    return p;
  } catch { return {}; }
};
const writePrefs = (p: Prefs) => { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* stockage indisponible */ } };

const songEnd = (st: DAWState) => Math.max(0.05, ...st.tracks.filter(t => !t.isGuide).flatMap(t => t.clips.map(c => c.start + c.duration)));
const pause = (): Promise<void> => new Promise(r => setTimeout(r, 20));

/** Pistes de voix (lead, backs, ad-libs) qui sonnent, et le reste des sources (instru, batterie…). */
export function splitVoices(tracks: Track[]): { voices: Set<string>; others: Set<string> } {
  const voices = new Set<string>(), others = new Set<string>();
  for (const t of tracks) {
    if (!isStemSource(t)) continue;
    if (isVoiceTrack(t) && !/\b(beat|instru|prod|loop|sample)/i.test(t.name || '')) voices.add(t.id);
    else others.add(t.id);
  }
  return { voices, others };
}

const DOT: Record<Level, { cls: string; icon: string; word: string }> = {
  ok: { cls: 'bg-emerald-500', icon: 'fa-check', word: 'vert' },
  warn: { cls: 'bg-amber-500', icon: 'fa-exclamation', word: 'orange' },
  error: { cls: 'bg-red-500', icon: 'fa-times', word: 'rouge' },
};
const GROUPS: { id: Check['group']; label: string }[] = [
  { id: 'licence', label: 'Licence' }, { id: 'audio', label: 'Son' }, { id: 'format', label: 'Fichier et pochette' }, { id: 'infos', label: 'Infos du morceau' },
];
const input = 'w-full min-h-10 rounded-lg border border-nv-line bg-nv-well/40 px-3 text-[13px] text-nv-ink outline-none focus:border-nv-accent';
const lab = 'block text-[11px] font-bold text-nv-muted mb-1';
const btnMain = 'nova-hit-tactile min-h-11 rounded-xl bg-nv-accent px-4 text-[13px] font-black text-black disabled:opacity-40';
const btn = 'nova-hit-tactile min-h-10 rounded-lg border border-nv-line px-3 text-[12px] font-bold text-nv-ink hover:bg-nv-accent/15 disabled:opacity-40';

const DistributionPanel: React.FC<{ getState: () => DAWState; getOwned?: () => (string | number)[]; onClose: () => void }> = ({ getState, getOwned, onClose }) => {
  const state = useMemo(getState, []); // eslint-disable-line react-hooks/exhaustive-deps
  const prefs0 = useMemo(readPrefs, []);
  const owned = useMemo(() => (getOwned?.() || []).map(String), []); // eslint-disable-line react-hooks/exhaustive-deps
  const gate = useExportGate(true, exportKeyOf(state), state.tracks, owned, 'mix');
  const projectRate = projectRateOf(state);
  const keyLabel = nomTonaliteCourt(state.projectKey, state.projectScale);

  const [platformId, setPlatformId] = useState(prefs0.platform && DIST_PLATFORMS.some(p => p.id === prefs0.platform) ? prefs0.platform : 'spotify');
  const platform = platformOf(platformId);
  const [meta, setMeta] = useState<DistMeta>({
    title: state.name || '', artist: prefs0.artist || '', featuring: '', composers: prefs0.composers || '', producers: prefs0.producers || '',
    year: String(new Date().getFullYear()), isrc: '', explicit: null,
  });
  const setM = (p: Partial<DistMeta>) => setMeta(m => ({ ...m, ...p }));
  const [rate, setRate] = useState<number>(projectRate === 48000 ? 48000 : 44100);
  const [bits, setBits] = useState<16 | 24>(prefs0.bits === 16 ? 16 : 24);
  const [cover, setCover] = useState<{ data: Uint8Array; url: string; info: CoverInfo } | null>(null);
  useEffect(() => () => { if (cover) URL.revokeObjectURL(cover.url); }, [cover]);

  // Mix rendu, corrections, mesures
  const orig = useRef<{ ch: Float32Array[]; sr: number; renderFrames: number } | null>(null);
  const work = useRef<Float32Array[] | null>(null);
  const [ops, setOps] = useState<Op[]>([]);
  const [fixes, setFixes] = useState<string[]>([]);
  const [stats, setStats] = useState<AudioStats | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string; files: string[]; size: number } | null>(null);
  const paywallRef = useRef<HTMLDivElement>(null);

  // Paquet : instrumental, a cappella, paroles
  const split = useMemo(() => splitVoices(state.tracks), [state.tracks]);
  const canSplit = split.voices.size > 0 && split.others.size > 0;
  const [withInstru, setWithInstru] = useState(true);
  const [withAcap, setWithAcap] = useState(true);
  const lyrics = useMemo(() => {
    const words = projectTimedWords(state.tracks);
    const text = (state.lyrics || '').trim() || (words.length ? lyricsFromWords(words) : '');
    return text ? { text, times: lyricLineTimes(text, words), timed: words.length > 0 } : null;
  }, [state]);
  const [withLyrics, setWithLyrics] = useState(true);

  useEffect(() => { writePrefs({ platform: platformId, artist: meta.artist, composers: meta.composers, producers: meta.producers, bits }); }, [platformId, meta.artist, meta.composers, meta.producers, bits]);

  const licence = { admin: gate.admin, access: gate.access, hasCatalog: catalogIdsOf(state.tracks).length > 0 };
  const checks = useMemo(() => runChecks({
    stats, platform, format: { sampleRate: rate, bits, channels: stats?.channels ?? 2, projectRate }, meta, cover: cover?.info ?? null, licence,
  }), [stats, platform, rate, bits, projectRate, meta, cover, gate.admin, gate.access]); // eslint-disable-line react-hooks/exhaustive-deps
  const sum = summarize(checks);

  // Crochet de test (scénarios QA) : mêmes données que l'écran.
  useEffect(() => {
    (window as any).__novaDistribution = { ...(window as any).__novaDistribution, stats, checks: checks.map(c => ({ id: c.id, level: c.level, value: c.value, fix: c.fix?.id || null })), ops, fixes };
  }, [stats, checks, ops, fixes]);

  // --- Rendu et mesure ---------------------------------------------------------------
  const analyze = async (sr = rate) => {
    setError(null); setDone(null);
    setBusy('Préparation des pistes…'); setPct(2);
    const st = getState();
    try {
      const prep = await prepareTracksForOffline(st.tracks, msg => setBusy(msg));
      try {
        const r = await renderMixChannels(prep.tracks, { start: 0, end: songEnd(st), tail: { mode: 'auto', seconds: 4 }, sampleRate: sr, format: 'WAV' },
          (p, t) => { setPct(5 + p * 0.85); setBusy(t); });
        orig.current = r.sampleRate === sr ? { ch: r.ch, sr, renderFrames: r.renderFrames } : null;
        work.current = cloneChannels(r.ch);
      } finally { prep.cleanup(); }
      setBusy('Mesure du morceau…'); setPct(93);
      await pause();
      setOps([]); setFixes([]);
      setStats(analyzeAudio(work.current!, sr));
      trackEvent('distribution_check', { platform: platformId });
    } catch (e: any) {
      setError(`Vérification impossible : ${e?.message || e}`);
    } finally { setBusy(null); setPct(0); }
  };

  const remeasure = async (label: string) => {
    setBusy(label); await pause();
    setStats(analyzeAudio(work.current!, orig.current!.sr));
    setBusy(null);
  };
  const addOp = (op: Op, text: string) => { setOps(o => [...o, op]); setFixes(f => [...f, text]); setDone(null); };

  const undoAll = async () => {
    if (!orig.current) return;
    work.current = cloneChannels(orig.current.ch);
    setOps([]); setFixes([]); setDone(null);
    await remeasure('Retour au mix d\'origine…');
  };

  // --- Corrections -------------------------------------------------------------------
  const coverToSquare = async () => {
    if (!cover) return;
    setBusy('Pochette : recadrage…');
    try {
      const bmp = await createImageBitmap(new Blob([cover.data as BlobPart], { type: cover.info.mime }));
      const side = Math.min(bmp.width, bmp.height);
      // Jamais agrandie (refusé par Apple et Spotify) : 3000 px au plus.
      const out = Math.min(3000, side);
      const cv = document.createElement('canvas');
      cv.width = cv.height = out;
      const g = cv.getContext('2d')!;
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, out, out);
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
      const blob: Blob = await new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('encodage JPEG'))), 'image/jpeg', 0.92));
      const data = new Uint8Array(await blob.arrayBuffer());
      setCover({ data, url: URL.createObjectURL(blob), info: { width: out, height: out, mime: 'image/jpeg', bytes: data.length } });
      setFixes(f => [...f, `Pochette recadrée en ${out} × ${out} px (depuis ${cover.info.width} × ${cover.info.height})`]);
    } catch (e: any) { setError(`Pochette : ${e?.message || e}`); } finally { setBusy(null); }
  };

  const fix = async (c: Check) => {
    const id = c.fix?.id as FixId;
    const w = work.current, sr = orig.current?.sr || rate;
    setError(null);
    try {
      switch (id) {
        case 'peak': {
          if (!w || !stats) return;
          const g = gainForPeak(stats, ceilingFor(stats, platform));
          if (g >= 0) return;
          applyGainDb(w, g);
          addOp({ kind: 'gain', db: g }, `Volume baissé de ${num(-g)} dB (crête vraie sous ${num(ceilingFor(stats, platform), 0)} dBTP)`);
          return remeasure('Mesure après correction…');
        }
        case 'loudness_up': {
          if (!w || !stats) return;
          const r = gainToward(stats, platform.lufs, platform.ceiling);
          if (!r.limitedByPeak) {
            applyGainDb(w, r.gainDb);
            addOp({ kind: 'gain', db: r.gainDb }, `Volume monté de ${num(r.gainDb)} dB (vers ${num(platform.lufs, 0)} LUFS)`);
            return remeasure('Mesure après correction…');
          }
          setBusy('Limiteur NOVA : montée du volume sans saturer…');
          const res = await levelWithLimiter(w, sr, platform.lufs, platform.ceiling, { yieldNow: pause, onProgress: (l) => setBusy(l) });
          work.current = res.out;
          addOp({ kind: 'limit', gainDb: res.inputGainDb, ceiling: platform.ceiling }, `Volume monté au limiteur NOVA (+${num(res.inputGainDb)} dB d'entrée) : ${num(res.lufs)} LUFS, crête ${num(res.truePeak)} dBTP`);
          return remeasure('Mesure après correction…');
        }
        case 'trim_start': case 'trim_end': {
          if (!w || !stats) return;
          const t = trimPoints(stats, sr, w[0].length, { start: id === 'trim_start', end: id === 'trim_end' });
          work.current = applyTrim(w, t, sr);
          addOp({ kind: 'trim', trim: t }, id === 'trim_start' ? `Blanc du début coupé (${num(t.start / sr, 2)} s)` : `Blanc de la fin coupé (${num((w[0].length - t.end) / sr, 2)} s)`);
          return remeasure('Mesure après correction…');
        }
        case 'dc': {
          if (!w) return;
          const m = removeDc(w);
          addOp({ kind: 'dc' }, `Décalage continu retiré (${m.map(v => num(v * 100, 3)).join(' / ')} %)`);
          return remeasure('Mesure après correction…');
        }
        case 'rate': setRate(44100); if (stats) await analyze(44100); return;
        case 'bits': setBits(24); return;
        case 'title_feat': { const [t, f] = splitTitle(meta.title, 'feat'); setM({ title: t, featuring: [meta.featuring, f].filter(Boolean).join(', ') }); return; }
        case 'title_prod': { const [t, p] = splitTitle(meta.title, 'prod'); setM({ title: t, producers: [meta.producers, p].filter(Boolean).join(', ') }); return; }
        case 'title_caps': setM({ title: sentenceCase(meta.title) }); return;
        case 'title_emoji': setM({ title: stripEmoji(meta.title) }); return;
        case 'artist_feat': { const [a, f] = splitTitle(meta.artist, 'feat'); setM({ artist: a, featuring: [meta.featuring, f].filter(Boolean).join(', ') }); return; }
        case 'year': setM({ year: String(new Date().getFullYear()) }); return;
        case 'cover_square': return coverToSquare();
        case 'buy_licence': openBuyBeat(state.tracks); return;
        case 'unlock_export': paywallRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return;
        case 'retry_licence': case 'login': gate.recheck(); return;
      }
    } catch (e: any) {
      setBusy(null);
      setError(`Correction impossible : ${e?.message || e}`);
    }
  };

  const onCoverFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    if (f.size > 20 * 1024 * 1024) { setError('Pochette trop lourde (20 Mo au plus).'); return; }
    const data = new Uint8Array(await f.arrayBuffer());
    const info = imageInfo(data);
    if (!info) { setError('Pochette : JPG ou PNG seulement.'); return; }
    setCover({ data, url: URL.createObjectURL(f), info: { ...info, bytes: data.length } });
  };

  // --- Paquet -----------------------------------------------------------------------
  const replay = async (ch: Float32Array[], sr: number) => {
    let c = ch;
    for (const op of ops) {
      if (op.kind === 'trim') c = applyTrim(c, op.trim, sr);
      else if (op.kind === 'dc') removeDc(c);
      else if (op.kind === 'gain') applyGainDb(c, op.db);
      else c = await limitWithGain(c, sr, op.gainDb, op.ceiling, { yieldNow: pause });
    }
    // Jamais au-dessus du plafond de la plateforme (on baisse seulement).
    const s = analyzeAudio(c, sr);
    const g = gainForPeak(s, platform.ceiling);
    if (g < 0) applyGainDb(c, g);
    return c;
  };

  // WAV PCM sans métadonnées intégrées (TuneCore : « Embedding any metadata may cause issues in delivery »).
  const wavOf = (ch: Float32Array[], sr: number) => {
    const d = cloneChannels(ch);
    applyTpdfDither(d, bits, makeRng(0x5eed + d[0].length));
    return encodeWav(d, { sampleRate: sr, bits });
  };

  const buildPackage = async () => {
    if (!gate.unlocked || !work.current || !orig.current || !stats) return;
    setError(null); setDone(null);
    const sr = orig.current.sr;
    const names = deliveryNames(meta);
    const isrc = meta.isrc.trim() && isValidIsrc(meta.isrc) ? normalizeIsrc(meta.isrc) : undefined;
    const year = Number(meta.year) || new Date().getFullYear();
    const bpm = state.bpm;
    const audioMeta: AudioMeta = {
      title: meta.featuring.trim() ? `${meta.title.trim()} (feat. ${meta.featuring.trim()})` : meta.title.trim(), artist: meta.artist.trim(), bpm,
      key: keyLabel || undefined, keyId3: keyToId3(state.projectKey, state.projectScale), isrc,
      loudness: { lufs: stats.lufs, truePeak: stats.truePeak }, date: new Date(year, 0, 1),
      comment: [meta.composers.trim() && `Auteurs-compositeurs : ${meta.composers.trim()}`, meta.producers.trim() && `Producteurs : ${meta.producers.trim()}`, meta.explicit ? 'Explicite' : ''].filter(Boolean).join(' · ') || undefined,
    };
    const files: PackageFile[] = [];
    try {
      setBusy(`Master WAV ${bits} bits…`); setPct(5); await pause();
      files.push({ name: bits === 24 ? names.wav : names.wav16, data: wavOf(work.current, sr) });

      setBusy('Master MP3 320 kbps…'); setPct(15); await pause();
      const mp3Rate = sr > 48000 ? 44100 : sr;
      const mp3Ch = mp3Rate === sr ? cloneChannels(work.current) : resampleChannels(work.current, sr, mp3Rate);
      const buf = new AudioBuffer({ numberOfChannels: mp3Ch.length, length: Math.max(1, mp3Ch[0].length), sampleRate: mp3Rate });
      mp3Ch.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
      const mp3 = await AudioEncoder.encodeMP3Plafonne(buf, 320);
      const tag = buildId3v2({ ...audioMeta, cover: cover ? { mime: cover.info.mime, data: cover.data } : undefined });
      files.push({ name: names.mp3, data: new Blob([tag as BlobPart, mp3]) });

      const wantInstru = canSplit && withInstru, wantAcap = canSplit && withAcap;
      if (wantInstru || wantAcap) {
        const st = getState();
        setBusy('Préparation des pistes…'); setPct(30);
        const prep = await prepareTracksForOffline(st.tracks, msg => setBusy(msg));
        try {
          const variants: { name: string; mute: Set<string>; label: string }[] = [];
          if (wantInstru) variants.push({ name: names.instru, mute: split.voices, label: 'Instrumental' });
          if (wantAcap) variants.push({ name: names.acapella, mute: split.others, label: 'A cappella' });
          for (let i = 0; i < variants.length; i++) {
            const v = variants[i];
            const p0 = 30 + i * 30;
            setBusy(`${v.label}…`); setPct(p0);
            const tracks = prep.tracks.map(t => (v.mute.has(t.id) ? { ...t, isMuted: true } : t));
            const r = await renderMixChannels(tracks, { start: 0, end: songEnd(st), tail: { mode: 'auto', seconds: 4 }, sampleRate: sr, format: 'WAV' },
              (p) => setPct(p0 + p * 0.25), orig.current.renderFrames);
            const ch = await replay(r.ch, sr);
            files.push({ name: v.name, data: wavOf(ch, sr) });
          }
        } finally { prep.cleanup(); }
      }

      setBusy('Pochette, paroles et crédits…'); setPct(92); await pause();
      if (cover) files.push({ name: names.cover(cover.info.mime), data: cover.data });
      if (lyrics && withLyrics) {
        files.push({ name: names.lyricsTxt, data: lyricsText(lyrics.text) });
        const offset = ops.reduce((s, o) => s + (o.kind === 'trim' ? o.trim.start / sr : 0), 0);
        const lrc = lyricsLrc(lyrics.text, lyrics.times, { title: meta.title, artist: meta.artist, offset, duration: stats.duration });
        if (lrc) files.push({ name: names.lyricsLrc, data: lrc });
      }
      const listed = [...files.map(f => f.name), names.creditsTxt, names.creditsJson];
      const catalog = (gate.access?.items || []).map(x => ({ title: x.title, owned: x.owned || gate.admin }));
      const credits = { meta, platform, stats, sampleRate: sr, bits, bpm, key: keyLabel, catalog, checks, fixes, files: listed };
      files.push({ name: names.creditsTxt, data: creditsText(credits) });
      files.push({ name: names.creditsJson, data: JSON.stringify(creditsJson(credits), null, 2) });

      setBusy('Création du .zip…'); setPct(96);
      const zip = await buildDeliveryZip(names.folder, files);
      (window as any).__novaDistribution = { ...(window as any).__novaDistribution, lastZip: { name: names.zip, size: zip.size, files: listed } };
      await saveBlob(zip, names.zip);
      setDone({ name: names.zip, files: listed, size: zip.size });
      trackEvent('distribution_package', { platform: platformId, instru: wantInstru, acapella: wantAcap, lyrics: !!(lyrics && withLyrics), cover: !!cover });
    } catch (e: any) {
      setError(`Paquet impossible : ${e?.message || e}`);
    } finally { setBusy(null); setPct(0); }
  };

  // --- Affichage --------------------------------------------------------------------
  const unlocked = gate.unlocked;
  const reds = checks.filter(c => c.level === 'error' && !c.blocking).length;
  const headline = !stats ? null
    : sum.blocking.length ? { level: 'error' as Level, text: `${sum.blocking.length} point${sum.blocking.length > 1 ? 's' : ''} à régler avant d'envoyer` }
    : sum.error ? { level: 'error' as Level, text: `${sum.error} problème${sum.error > 1 ? 's' : ''} à corriger (conseillé)` }
    : sum.warn ? { level: 'warn' as Level, text: `Presque prêt : ${sum.warn} conseil${sum.warn > 1 ? 's' : ''}` }
    : { level: 'ok' as Level, text: `Prêt pour ${platform.label} !` };

  const row = (c: Check) => {
    const d = DOT[c.level];
    const isBuy = c.fix?.id === 'buy_licence' || c.fix?.id === 'unlock_export' || c.fix?.id === 'retry_licence' || c.fix?.id === 'login';
    const needsAudio = ['peak', 'loudness_up', 'trim_start', 'trim_end', 'dc'].includes(c.fix?.id || '');
    return (
      <li key={c.id} className="flex gap-3 rounded-xl border border-nv-line bg-nv-well/30 p-3" data-testid={`dist-check-${c.id}`} data-level={c.level}>
        <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white ${d.cls}`} role="img" aria-label={`Feu ${d.word}`}>
          <i className={`fas ${d.icon} text-[11px]`} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className="text-[13px] font-bold text-nv-ink">{c.label}</span>
            {c.value && <span className="font-mono text-[11px] text-nv-muted break-all">{c.value}</span>}
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-nv-muted">{c.message}</p>
          {c.fix && (
            <button type="button" className={`mt-2 ${isBuy && c.fix.id === 'buy_licence' ? 'nova-hit-tactile min-h-10 rounded-lg bg-amber-400 px-3 text-[12px] font-black text-black hover:bg-amber-300' : btn}`}
              onClick={() => void fix(c)} disabled={!!busy || (needsAudio && !work.current)} data-testid={`dist-fix-${c.id}`}>
              {isBuy ? <>{c.fix.id === 'buy_licence' ? '🛒 ' : ''}{c.fix.label}</> : <><i className="fas fa-wrench mr-1.5" aria-hidden="true" />Corriger : {c.fix.label.charAt(0).toLowerCase() + c.fix.label.slice(1)}</>}
            </button>
          )}
        </div>
      </li>
    );
  };

  const groupChecks = (g: Check['group']) => checks.filter(c => c.group === g);

  return (
    <div className="fixed inset-0 z-[1300] flex items-stretch justify-center bg-black/60 sm:items-center sm:p-3" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="dist-title" data-testid="distribution-panel"
        className="flex h-[100dvh] w-full flex-col bg-nv-panel shadow-2xl sm:h-auto sm:max-h-[94vh] sm:max-w-[760px] sm:rounded-2xl sm:border sm:border-nv-line"
        onKeyDown={e => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } }}>
        {/* En-tête */}
        <div className="flex items-start gap-3 border-b border-nv-line px-4 py-3">
          <span className="mt-0.5 text-2xl leading-none" aria-hidden="true">🚀</span>
          <div className="min-w-0 flex-1">
            <h2 id="dist-title" className="text-[16px] font-black text-nv-ink">Prêt pour Spotify / Apple / TikTok&nbsp;?</h2>
            <p className="text-[12px] text-nv-muted">NOVA contrôle ton morceau comme un distributeur, corrige ce qu'il peut, puis prépare le paquet à envoyer.</p>
          </div>
          <button type="button" onClick={onClose} disabled={!!busy} aria-label="Fermer" className="nova-hit-tactile h-10 w-10 shrink-0 rounded-lg text-nv-muted hover:text-nv-ink"><i className="fas fa-times" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {/* Plateforme */}
          <div>
            <span className={lab}>Où vas-tu le publier ?</span>
            <div role="radiogroup" aria-label="Plateforme" className="flex flex-wrap gap-1.5">
              {DIST_PLATFORMS.map(p => (
                <button key={p.id} type="button" role="radio" aria-checked={platformId === p.id} onClick={() => setPlatformId(p.id)} data-testid={`dist-platform-${p.id}`}
                  className={`nova-hit-tactile min-h-10 rounded-full border px-3 text-[12px] font-bold ${platformId === p.id ? 'border-nv-accent bg-nv-accent text-black' : 'border-nv-line text-nv-ink hover:bg-nv-accent/15'}`}>
                  {p.label} <span className={platformId === p.id ? 'font-normal text-black/70' : 'font-normal text-nv-muted'}>{num(p.lufs, 0)} LUFS</span>
                </button>
              ))}
            </div>
          </div>

          {/* Export pas débloqué : même bandeau que la fenêtre Exporter */}
          {!gate.admin && !unlocked && (
            <div ref={paywallRef}>
              <ExportPaywall access={gate.access} grille={gate.grille} status={gate.status} paying={gate.paying}
                onPayExport={() => { void gate.pay(); }} onCancelPay={gate.cancelPay} onBuyLicence={() => openBuyBeat(state.tracks)}
                onRetry={gate.recheck} onProActive={gate.recheck} showBuy />
              {gate.message && <p role="status" className="mt-1 text-[12px] text-amber-300">{gate.message}</p>}
            </div>
          )}

          {/* Vérifier / résumé */}
          <div className="rounded-2xl border border-nv-line bg-nv-well/40 p-3" data-testid="dist-summary" data-level={headline?.level || 'idle'}>
            {busy ? (
              <div role="status" className="space-y-1.5">
                <p className="text-[13px] font-bold text-nv-ink"><i className="fas fa-circle-notch fa-spin mr-2" />{busy}</p>
                {pct > 0 && <div className="h-1.5 overflow-hidden rounded-full bg-nv-line/40"><div className="h-full bg-nv-accent transition-all" style={{ width: `${Math.round(pct)}%` }} /></div>}
              </div>
            ) : !stats ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <p className="flex-1 text-[12px] text-nv-muted">NOVA calcule ton mix complet (comme l'export) et le mesure : volume, crête, écrêtage, blancs, phase. Quelques secondes.</p>
                <button type="button" className={btnMain} onClick={() => void analyze()} data-testid="dist-analyze"><i className="fas fa-stethoscope mr-2" aria-hidden="true" />Vérifier mon morceau</button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <p className="flex-1 text-[14px] font-black text-nv-ink" role="status">
                  <span className={`mr-2 inline-block h-3 w-3 rounded-full align-middle ${DOT[headline!.level].cls}`} aria-hidden="true" />{headline!.text}
                  <span className="block text-[11px] font-normal text-nv-muted">{sum.ok} vert{sum.ok > 1 ? 's' : ''} · {sum.warn} orange{sum.warn > 1 ? 's' : ''} · {sum.error} rouge{sum.error > 1 ? 's' : ''}{reds && !sum.blocking.length ? ' : le paquet reste téléchargeable, mais corrige d\'abord si tu peux.' : ''}</span>
                </p>
                <div className="flex gap-2">
                  {ops.length > 0 && <button type="button" className={btn} onClick={() => void undoAll()} data-testid="dist-undo">Annuler les corrections</button>}
                  <button type="button" className={btn} onClick={() => void analyze()} data-testid="dist-reanalyze">Revérifier</button>
                </div>
              </div>
            )}
            {error && <p role="alert" className="mt-2 rounded-lg border border-red-400/40 bg-red-500/10 p-2 text-[12px] text-red-300">⚠️ {error}</p>}
          </div>

          {/* Feux */}
          {GROUPS.map(g => {
            const list = groupChecks(g.id);
            return (
              <section key={g.id} aria-label={g.label}>
                <h3 className="mb-1.5 text-[11px] font-black uppercase tracking-widest text-nv-accent">{g.label}</h3>
                {g.id === 'audio' && !stats ? (
                  <p className="rounded-xl border border-dashed border-nv-line p-3 text-[12px] text-nv-muted">Volume, crête vraie, écrêtage, blancs au début et à la fin, décalage continu, compatibilité mono : touche « Vérifier mon morceau ».</p>
                ) : (
                  <ul className="space-y-1.5">{list.map(row)}</ul>
                )}
                {g.id === 'format' && (
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <label><span className={lab}>Fréquence</span>
                      <select className={input} value={rate} data-testid="dist-rate" onChange={e => { const r = Number(e.target.value); setRate(r); if (stats) void analyze(r); }} disabled={!!busy}>
                        {[44100, 48000, 88200, 96000].map(r => <option key={r} value={r}>{num(r / 1000, r % 1000 ? 1 : 0)} kHz{r === projectRate ? ' (projet)' : ''}</option>)}
                      </select></label>
                    <label><span className={lab}>Résolution du WAV</span>
                      <select className={input} value={bits} data-testid="dist-bits" onChange={e => setBits(Number(e.target.value) === 16 ? 16 : 24)} disabled={!!busy}>
                        <option value={24}>24 bits (conseillé)</option><option value={16}>16 bits (CD)</option>
                      </select></label>
                    <div className="col-span-2 flex items-end gap-2 sm:col-span-1">
                      {cover ? <img src={cover.url} alt="Pochette" className="h-10 w-10 rounded-lg border border-nv-line object-cover" /> : <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-nv-line text-nv-muted" aria-hidden="true"><i className="fas fa-image" /></span>}
                      <label className={`${btn} flex flex-1 cursor-pointer items-center justify-center`}>
                        <input type="file" accept="image/jpeg,image/png" className="sr-only" data-testid="dist-cover-input" onChange={e => { void onCoverFile(e.target.files?.[0]); e.target.value = ''; }} disabled={!!busy} />
                        {cover ? 'Changer' : 'Ajouter la pochette'}
                      </label>
                      {cover && <button type="button" className="text-[12px] text-nv-muted hover:text-nv-ink" onClick={() => setCover(null)}>Retirer</button>}
                    </div>
                  </div>
                )}
                {g.id === 'infos' && (
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="dist-form">
                    <label><span className={lab}>Titre</span><input className={input} value={meta.title} onChange={e => setM({ title: e.target.value })} data-testid="dist-title" placeholder="Titre du morceau" /></label>
                    <label><span className={lab}>Artiste principal</span><input className={input} value={meta.artist} onChange={e => setM({ artist: e.target.value })} data-testid="dist-artist" placeholder="Ton nom d'artiste" /></label>
                    <label><span className={lab}>Invités (feat.)</span><input className={input} value={meta.featuring} onChange={e => setM({ featuring: e.target.value })} data-testid="dist-feat" placeholder="Facultatif, séparés par des virgules" /></label>
                    <label><span className={lab}>Auteurs-compositeurs (prénom et nom)</span><input className={input} value={meta.composers} onChange={e => setM({ composers: e.target.value })} data-testid="dist-composers" placeholder="Ex. Romain Dupont, Lina Haddad" /></label>
                    <label><span className={lab}>Producteurs</span><input className={input} value={meta.producers} onChange={e => setM({ producers: e.target.value })} data-testid="dist-producers" placeholder="Facultatif (le beatmaker)" /></label>
                    <div className="grid grid-cols-2 gap-2">
                      <label><span className={lab}>Année</span><input className={input} value={meta.year} inputMode="numeric" maxLength={4} onChange={e => setM({ year: e.target.value })} data-testid="dist-year" /></label>
                      <label><span className={lab}>ISRC (facultatif)</span><input className={input} value={meta.isrc} onChange={e => setM({ isrc: e.target.value })} data-testid="dist-isrc" placeholder="FR-Z03-26-00001" /></label>
                    </div>
                    <fieldset className="sm:col-span-2">
                      <legend className={lab}>Paroles explicites (gros mots, violence, drogue) ?</legend>
                      <div className="flex gap-2" role="radiogroup">
                        {([[false, 'Non, tous publics'], [true, 'Oui (badge E)']] as const).map(([v, l]) => (
                          <button key={String(v)} type="button" role="radio" aria-checked={meta.explicit === v} onClick={() => setM({ explicit: v })} data-testid={`dist-explicit-${v ? 'oui' : 'non'}`}
                            className={`nova-hit-tactile min-h-10 flex-1 rounded-lg border px-3 text-[12px] font-bold ${meta.explicit === v ? 'border-nv-accent bg-nv-accent text-black' : 'border-nv-line text-nv-ink hover:bg-nv-accent/15'}`}>{l}</button>
                        ))}
                      </div>
                    </fieldset>
                  </div>
                )}
              </section>
            );
          })}

          {/* Contenu du paquet */}
          <section aria-label="Contenu du paquet">
            <h3 className="mb-1.5 text-[11px] font-black uppercase tracking-widest text-nv-accent">Paquet « Livraison » (.zip)</h3>
            <ul className="space-y-1 text-[12px] text-nv-ink" data-testid="dist-contents">
              <li>✅ Master WAV {bits} bits, {num(rate / 1000, rate % 1000 ? 1 : 0)} kHz, et MP3 320 kbps</li>
              <li>
                <label className="flex items-start gap-2"><input type="checkbox" checked={canSplit && withInstru} disabled={!canSplit} onChange={e => setWithInstru(e.target.checked)} data-testid="dist-with-instru" />
                  <span>Instrumental {!canSplit && <span className="text-nv-muted">: il faut au moins une piste de voix et une autre piste</span>}</span></label>
              </li>
              <li>
                <label className="flex items-start gap-2"><input type="checkbox" checked={canSplit && withAcap} disabled={!canSplit} onChange={e => setWithAcap(e.target.checked)} data-testid="dist-with-acap" />
                  <span>A cappella (voix seules, avec leurs effets) {!canSplit && <span className="text-nv-muted">: pas de piste de voix séparée</span>}</span></label>
              </li>
              <li>
                <label className="flex items-start gap-2"><input type="checkbox" checked={!!lyrics && withLyrics} disabled={!lyrics} onChange={e => setWithLyrics(e.target.checked)} data-testid="dist-with-lyrics" />
                  <span>Paroles (.txt{lyrics?.timed ? ' et .lrc synchronisé' : ''}) {!lyrics && <span className="text-nv-muted">: aucune parole dans le projet (onglet Paroles ou transcription de la voix)</span>}</span></label>
              </li>
              <li>{cover ? '✅' : '➖'} Pochette {cover ? `(${cover.info.width} × ${cover.info.height} px)` : ': ajoute-la ci-dessus'}</li>
              <li>✅ Fiche des crédits et des métadonnées (.txt et .json)</li>
            </ul>
            {canSplit && (withInstru || withAcap) && <p className="mt-1 text-[11px] text-nv-muted">L'instrumental et l'a cappella reçoivent les mêmes corrections que le master, calés au même échantillon. Une instru en licence ne se publie pas seule : ces fichiers servent au live, à la radio ou à la synchro.</p>}
          </section>

        </div>

        {/* Pied fixe : l'action principale toujours visible (téléphone compris) */}
        <div className="border-t border-nv-line px-4 py-3" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          {done && (
            <div role="status" className="mb-2 rounded-xl border border-emerald-400/40 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-200" data-testid="dist-done">
              <p className="font-black">✅ Paquet prêt : {done.name} ({num(done.size / 1024 / 1024, 1)} Mo)</p>
              <p className="mt-0.5" data-testid="dist-done-neutre">Tes fichiers sont prêts pour n'importe quel distributeur : envoie le WAV, recopie les infos de « Credits_et_metadonnees.txt » et joins la pochette.</p>
            </div>
          )}
          {!stats ? (
            <button type="button" className={`${btnMain} w-full`} onClick={() => void analyze()} disabled={!!busy} data-testid="dist-analyze-foot">Vérifier mon morceau</button>
          ) : (
            <button type="button" className={`${btnMain} w-full`} disabled={!!busy || !unlocked || sum.blocking.length > 0} onClick={() => void buildPackage()} data-testid="dist-package"
              title={!unlocked ? 'Débloque d\'abord l\'export de ce projet (licence ou paiement)' : sum.blocking.length ? sum.blocking.map(c => c.label).join(', ') : undefined}>
              <i className="fas fa-file-zipper mr-2" aria-hidden="true" />
              {!unlocked ? (gate.access ? 'Licence ou export à débloquer' : 'Vérification de la licence…')
                : sum.blocking.length ? `À régler : ${sum.blocking.map(c => c.label.toLowerCase()).join(', ')}`
                : reds ? 'Télécharger quand même le paquet (.zip)' : 'Télécharger le paquet Livraison (.zip)'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default DistributionPanel;
