
import { openCheckout, waitPaid, isExportVoicesUnlocked, markExportVoicesUnlocked, spendExportCredit, billingStatus } from '../services/Billing';
import React, { useState, useEffect } from 'react';
import { DAWState, Track } from '../types';
import { openBuyBeat, openProMix } from '../utils/studioLinks';
import { prepareTracksForOffline } from '../services/VstFreeze';
import { track } from '../utils/analytics';
import { consumeSelectionExport, editSelectionStore } from '../utils/editSelection';
import { simpleModeStore } from '../utils/simpleMode';
import { MidiExportRow } from './MidiFileMenu';
import { runExport, outputBits, outputRate, type ExportSettings, type ExportFormat, type ExportSource } from '../services/ExportPipeline';
import { exportQueue } from '../services/ExportQueue';
import { reportLine } from './ExportQueueToast';
import { keyToId3, type ChannelLayout } from '../utils/audioFormats';
import { keyForFile } from '../utils/exportNaming';
import { nomTonaliteCourt } from '../utils/musicKey';
import { PLATFORM_TARGETS } from '../utils/masterAssistant';
import type { StemGrouping, ReturnsMode } from '../utils/stemPlan';
import type { TailMode, RangeMode } from '../utils/exportTail';

// Compte admin du studio (tout gratuit pour tester) : lu une fois par session.
let adminCache: boolean | null = null;

/** Réglages d'export retenus d'une fois sur l'autre (format, stems, queue, artiste…). */
const PREFS_KEY = 'nova_export_prefs';
interface ExportPrefs {
  format?: ExportFormat; bits?: '16' | '24' | '32'; mp3?: string; sr?: number; layout?: ChannelLayout; dither?: boolean;
  normalize?: string; tailMode?: TailMode; tailSec?: number; grouping?: StemGrouping; returns?: ReturnsMode; masterFx?: boolean; artist?: string;
}
const readPrefs = (): ExportPrefs => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; } };
const writePrefs = (p: ExportPrefs) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* stockage indisponible */ } };

/** ISRC : 2 lettres pays, 3 caractères, 7 chiffres (tirets tolérés). */
export const normalizeIsrc = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const isValidIsrc = (s: string): boolean => /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalizeIsrc(s));


interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectState: DAWState;
  /** Instrumentaux du catalogue achetes par l'utilisateur. */
  ownedInstrumentIds?: (string | number)[];
  /** Démo taguée / extrait à partager (dispo sans licence). */
  /** Fenêtre « Fais écouter ton son » ; 'demo' y lance directement la démo MP3. */
  onOpenShare?: (auto?: 'demo') => void;
  /** Identifiant stable du projet (achat « mes pistes seules » rattaché au projet). */
  projectKey?: string;
  /** Export terminé (carte « Et maintenant ? »). */
  onExported?: (info: { source: 'vocals' | 'full' | 'stems'; paid: boolean }) => void;
}

const ExportModal: React.FC<ExportModalProps> = ({ isOpen, onClose, projectState, ownedInstrumentIds = [], onOpenShare, projectKey, onExported }) => {
  // Admin (patron, admins du studio) : export complet gratuit, sans licence ni
  // paiement (le serveur le confirme aussi). null : vérification en cours.
  const [isAdmin, setIsAdmin] = useState<boolean | null>(adminCache);
  useEffect(() => {
    if (!isOpen || adminCache !== null) return;
    let live = true;
    const timeout = new Promise<null>(r => setTimeout(() => r(null), 4000));
    void Promise.race([billingStatus(), timeout]).then(st => {
      if (st) adminCache = !!st.admin;
      if (live) setIsAdmin(st ? !!st.admin : false);
    });
    return () => { live = false; };
  }, [isOpen]);
  const admin = isAdmin === true;
  const adminPending = isAdmin === null;

  // Verrou de licence. Le DAW sert a essayer les instrumentaux : on ne peut
  // sortir un fichier audio que si le beat du catalogue present dans le projet
  // a ete achete. Ce controle n'existait pas du tout, l'export rendait le mix
  // complet sans rien verifier.
  const possedes = React.useMemo(() => ownedInstrumentIds.map(id => String(id)), [ownedInstrumentIds]);
  const beatsNonAchetes = React.useMemo(
    () => projectState.tracks.filter(
      t => t.instrumentId !== undefined && !possedes.includes(String(t.instrumentId))
    ),
    [projectState.tracks, possedes]
  );
  const exportVerrouille = !admin && beatsNonAchetes.length > 0;
  // --- STATE ---
  const [filename, setFilename] = useState(projectState.name || 'Master');
  
  // SOURCE & PLAGE
  // VOCALS : les voix seules, piste par piste. Toujours permis, même sans avoir
  // acheté le beat : les pistes du beat sont retirées du rendu (jamais mutées
  // seulement), l'instrumental ne peut donc pas sortir par là.
  const [source, setSource] = useState<'MASTER' | 'STEMS' | 'VOCALS'>(exportVerrouille ? 'VOCALS' : 'MASTER');
  const [vocalsDry, setVocalsDry] = useState(false);
  // Admin confirmé après l'ouverture : mix complet proposé (sauf choix déjà fait).
  const sourceTouched = React.useRef(false);
  useEffect(() => {
    if (admin && !sourceTouched.current) setSource('MASTER');
  }, [admin]);
  const bloque = exportVerrouille && source !== 'VOCALS';
  // Mes pistes seules sans avoir acheté le beat / la mélodie : 2 € par projet.
  const [voicesUnlocked, setVoicesUnlocked] = useState<boolean | null>(null);
  const [payWait, setPayWait] = useState(false);
  const payCancelled = React.useRef(false);
  // Export payant (2 €, ou un des 10 exports gratuits de Nova Pro) : mes pistes
  // seules sans le beat acheté, ou tout projet sans instru du catalogue (instru importée).
  const hasCatalogBeat = projectState.tracks.some(t => t.instrumentId !== undefined && t.instrumentId !== null && t.instrumentId !== '');
  const paidExport = !admin && ((source === 'VOCALS' && exportVerrouille) || !hasCatalogBeat);
  const needsVoicesPayment = paidExport && voicesUnlocked !== true;
  const [freeLeft, setFreeLeft] = useState<number | null>(null);
  React.useEffect(() => {
    if (!isOpen || !projectKey || !paidExport) return;
    let live = true;
    void isExportVoicesUnlocked(projectKey).then(u => { if (live) setVoicesUnlocked(u); });
    void billingStatus().then(st => { if (live && (st.plans.some(p => p.plan === 'collab') || st.admin)) setFreeLeft(st.free_exports_left ?? 0); });
    return () => { live = false; payCancelled.current = true; };
  }, [isOpen, projectKey, paidExport]);
  const payVoices = async () => {
    if (!projectKey) return;
    payCancelled.current = false;
    setStatusText('');
    // Abonné Nova Pro : un export gratuit du mois d'abord.
    if (freeLeft !== null && freeLeft > 0) {
      const r = await spendExportCredit(projectKey);
      if (r.unlocked) {
        markExportVoicesUnlocked(projectKey);
        setVoicesUnlocked(true);
        setFreeLeft(r.remaining);
        setLoudnessReport(`⭐ Export gratuit Nova Pro utilisé (il t'en reste ${r.remaining} ce mois-ci).`);
        setTimeout(() => { void handleExportRef.current?.(); }, 300);
        return;
      }
    }
    try {
      const sid = await openCheckout('export_voices', { project_key: projectKey });
      setPayWait(true);
      const ok = await waitPaid(sid, () => payCancelled.current);
      setPayWait(false);
      if (ok) {
        markExportVoicesUnlocked(projectKey);
        setVoicesUnlocked(true);
        setLoudnessReport('✅ Paiement reçu : tes pistes s\'exportent.');
        setTimeout(() => { void handleExportRef.current?.(); }, 300);
      }
    } catch (e: any) {
      setPayWait(false);
      setLoudnessReport(`⚠️ Paiement impossible : ${e?.message || 'erreur'}`);
    }
  };
  const handleExportRef = React.useRef<((queueOnly?: boolean) => Promise<void>) | null>(null);
  // SELECTION : la plage choisie au Sélecteur / Smart Tool (comme l'export d'une sélection dans Pro Tools).
  const [rangeMode, setRangeMode] = useState<RangeMode>('FULL');
  const selRange = editSelectionStore.get().time;
  const markers = React.useMemo(() => [...(projectState.markers || [])].sort((a, b) => a.time - b.time), [projectState.markers]);
  const [markerA, setMarkerA] = useState<string>('');
  const [markerB, setMarkerB] = useState<string>('');

  const prefs0 = React.useMemo(readPrefs, []);
  // FORMAT & QUALITÉ
  const [format, setFormat] = useState<ExportFormat>(prefs0.format || 'WAV');
  const [sampleRate, setSampleRate] = useState<number>(prefs0.sr || 44100);
  const [bitDepth, setBitDepth] = useState<'16' | '24' | '32'>(prefs0.bits || '24');
  const [mp3Bitrate, setMp3Bitrate] = useState<string>(prefs0.mp3 || '320');
  const [layout, setLayout] = useState<ChannelLayout>(prefs0.layout || 'stereo');
  // Queue (réverbe) : auto, réglée, coupée, bouclée.
  const [tailMode, setTailMode] = useState<TailMode>(prefs0.tailMode || 'auto');
  const [tailSec, setTailSec] = useState<number>(prefs0.tailSec ?? 4);
  // Stems
  const [grouping, setGrouping] = useState<StemGrouping>(prefs0.grouping || 'tracks');
  const [returns, setReturns] = useState<ReturnsMode>(prefs0.returns || 'in-stems');
  const [masterFx, setMasterFx] = useState<boolean>(prefs0.masterFx ?? false);

  // TRAITEMENT
  // Volume final : tel quel, crête −1 dBTP, ou une cible du Master Nova (Spotify −14 LUFS…).
  const [normalize, setNormalize] = useState<string>(prefs0.normalize || 'off');
  const [loudnessReport, setLoudnessReport] = useState<string | null>(null);
  const [dither, setDither] = useState(prefs0.dither ?? true);

  // MÉTADONNÉES
  const keyLabel = nomTonaliteCourt(projectState.projectKey, projectState.projectScale);
  const [metaTitle, setMetaTitle] = useState(projectState.name || '');
  const [metaArtist, setMetaArtist] = useState(prefs0.artist || '');
  const [metaBpm, setMetaBpm] = useState<string>(String(Math.round((projectState.bpm || 120) * 100) / 100));
  const [metaKey, setMetaKey] = useState(keyLabel);
  const [metaIsrc, setMetaIsrc] = useState('');
  const [cover, setCover] = useState<{ mime: string; data: Uint8Array; url: string } | null>(null);

  // UI STATE
  // Par défaut, deux choix simples (extrait réseaux / morceau complet) ; le
  // format, la qualité, le niveau et les pistes séparées sont derrière
  // « Réglages avancés ». Le moteur d'export est le même dans les deux vues.
  const [advanced, setAdvanced] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');

  useEffect(() => {
    if (isOpen) {
        setFilename(projectState.name || 'Master');
        setMetaTitle(projectState.name || '');
        setProgress(0);
        setStatusText('');
        setIsRendering(false);
        // Mode avancé (ingé) : on arrive directement sur Mix / Stems / Voix seules (audit G19).
        // Téléphone : toujours la version simple d'abord (« Réglages avancés » reste à un toucher).
        const phone = typeof window !== 'undefined' && window.innerWidth < 640;
        if (!simpleModeStore.get().simple && !phone) setAdvanced(true);
        if (consumeSelectionExport() && editSelectionStore.get().time) { setRangeMode('SELECTION'); setAdvanced(true); }
        else if (rangeMode === 'SELECTION' && !editSelectionStore.get().time) setRangeMode('FULL');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, projectState.name]);

  // Repères par défaut : le premier et le suivant.
  useEffect(() => {
    if (!markers.length) return;
    if (!markers.some(m => m.id === markerA)) setMarkerA(markers[0].id);
    if (!markers.some(m => m.id === markerB) && markerB !== '__end') setMarkerB(markers[1]?.id || '__end');
  }, [markers, markerA, markerB]);

  // Pochette : aperçu libéré à la fermeture.
  useEffect(() => () => { if (cover) URL.revokeObjectURL(cover.url); }, [cover]);

  if (!isOpen) return null;

  // --- HELPERS ---

  /** Fin du morceau : dernière fin de clip (les pistes guides ne comptent pas). */
  const songEnd = () => Math.max(0, ...projectState.tracks.filter(t => !t.isGuide).flatMap(t => t.clips.map(c => c.start + c.duration)));

  /** Plage musicale [début, fin] (sans la queue). */
  const getRange = (): { start: number; end: number } => {
    if (rangeMode === 'LOOP') return { start: projectState.loopStart, end: Math.max(projectState.loopStart + 0.05, projectState.loopEnd) };
    if (rangeMode === 'SELECTION' && selRange) return { start: selRange.start, end: Math.max(selRange.start + 0.05, selRange.end) };
    if (rangeMode === 'MARKERS' && markers.length) {
      const a = markers.find(m => m.id === markerA) || markers[0];
      const b = markerB === '__end' ? null : markers.find(m => m.id === markerB);
      const end = b ? b.time : Math.max(songEnd(), a.time + 0.05);
      return { start: Math.min(a.time, end), end: Math.max(a.time, end) };
    }
    return { start: 0, end: Math.max(0.05, songEnd()) };
  };
  const getDuration = () => {
    const r = getRange();
    const tail = tailMode === 'manual' ? tailSec : tailMode === 'auto' ? 2 : 0;
    return Math.max(0.05, r.end - r.start + tail);
  };

  const effBits = outputBits({ format, bits: Number(bitDepth) as 16 | 24 | 32 });
  const effRate = outputRate({ format, sampleRate });
  const bpmNum = Number(String(metaBpm).replace(',', '.'));
  const isrcOk = !metaIsrc || isValidIsrc(metaIsrc);

  const buildSettings = (src: ExportSource): ExportSettings => {
    const r = getRange();
    const bpm = Number.isFinite(bpmNum) && bpmNum > 0 ? bpmNum : projectState.bpm;
    return {
      source: src, vocalsDry,
      stems: { grouping, returns, withMasterFx: masterFx },
      start: r.start, end: r.end,
      tail: { mode: tailMode, seconds: tailSec },
      format, bits: Number(bitDepth) as 16 | 24 | 32, mp3Kbps: parseInt(mp3Bitrate, 10) || 320, sampleRate, layout, dither, normalize,
      meta: {
        title: metaTitle || projectState.name, artist: metaArtist || undefined, bpm,
        key: metaKey || undefined,
        keyId3: metaKey && metaKey === keyLabel ? keyToId3(projectState.projectKey, projectState.projectScale) : undefined,
        isrc: metaIsrc && isValidIsrc(metaIsrc) ? normalizeIsrc(metaIsrc) : undefined,
        timeSignature: projectState.timeSignature,
        cover: cover ? { mime: cover.mime, data: cover.data } : undefined,
      },
      naming: { title: metaTitle || projectState.name || 'Morceau', bpm, key: metaKey === keyLabel ? keyForFile(projectState.projectKey, projectState.projectScale) : '' },
      baseName: (filename || 'Master').replace(/[\\/:*?"<>|]+/g, '_'),
    };
  };

  const jobLabel = (s: ExportSettings) => {
    const what = s.source === 'MASTER' ? 'Mix' : s.source === 'STEMS' ? 'Stems' : 'Mes pistes';
    const fmt = s.format === 'MP3' ? `MP3 ${s.mp3Kbps}` : `${s.format} ${outputBits(s) === 32 ? '32f' : outputBits(s)}`;
    return `${what} · ${fmt} · ${outputRate(s) / 1000} kHz — ${s.meta.title || 'Morceau'}`;
  };

  // --- EXPORT (par la file : un ou plusieurs exports à la suite) ---

  const handleExport = async (queueOnly = false) => {
    if (needsVoicesPayment) { void payVoices(); return; }
    if (bloque) {
      setStatusText("Achète l'instrumental pour exporter ton morceau (les voix seules restent exportables).");
      return;
    }
    if (!isrcOk) { setStatusText('ISRC invalide : 12 caractères, par exemple FR-Z03-26-00001. Laisse vide si tu n\'en as pas.'); return; }
    writePrefs({ format, bits: bitDepth, mp3: mp3Bitrate, sr: sampleRate, layout, dither, normalize, tailMode, tailSec, grouping, returns, masterFx, artist: metaArtist });
    const settings = buildSettings(source);
    const snapshot = projectState.tracks;
    const projMarkers = markers.map(m => ({ name: m.name, time: m.time }));
    const kind = source === 'VOCALS' ? 'vocals' : source === 'STEMS' ? 'stems' : 'full';
    const id = exportQueue.enqueue(jobLabel(settings), async (onP) => {
      // Effets VST3 du PC : rendus par le pont (ou rendu déjà fait à la sauvegarde).
      const prep = await prepareTracksForOffline(snapshot, msg => onP(0, msg));
      try {
        if (prep.missingVst.length) onP(1, `Effets VST non inclus (pont VST non connecté) : ${prep.missingVst.join(', ')}`);
        return await runExport(prep.tracks, settings, projMarkers, onP);
      } finally { prep.cleanup(); }
    });
    track('export_queued', { source: kind, format: settings.format, queued: queueOnly });
    if (queueOnly) {
      setStatusText('➕ Ajouté à la file : tu peux continuer, une notification te prévient à la fin.');
      setTimeout(onClose, 900);
      return;
    }
    // Export direct : la fenêtre suit l'avancement, puis se ferme.
    setIsRendering(true);
    setProgress(0);
    const off = exportQueue.subscribe(jobs => {
      const j = jobs.find(x => x.id === id);
      if (!j) return;
      setProgress(j.progress);
      if (j.status === 'running' || j.status === 'waiting') setStatusText(j.text);
    });
    const done = await exportQueue.wait(id);
    off();
    if (done.status === 'done') {
      setLoudnessReport(reportLine(done));
      setStatusText(done.saved ? '✅ Export terminé !' : '✅ Export prêt : touche « Télécharger » dans la notification.');
      track('export_done', { source: kind, paid: paidExport, admin, format: settings.format });
      onExported?.({ source: kind, paid: paidExport });
      setTimeout(() => { onClose(); setIsRendering(false); }, 1500);
    } else {
      setStatusText(`❌ Export impossible : ${done.error || 'erreur'}`);
      setIsRendering(false);
    }
  };

  handleExportRef.current = handleExport;

  const onCoverFile = async (f: File | undefined) => {
    if (!f) return;
    if (!/^image\/(jpeg|png)$/.test(f.type)) { setStatusText('Pochette : JPEG ou PNG seulement.'); return; }
    if (f.size > 5 * 1024 * 1024) { setStatusText('Pochette trop lourde (5 Mo au plus).'); return; }
    const data = new Uint8Array(await f.arrayBuffer());
    if (cover) URL.revokeObjectURL(cover.url);
    setCover({ mime: f.type, data, url: URL.createObjectURL(f) });
  };

  // Taille estimée (Mo)
  const estimateMb = () => {
    const d = getDuration();
    const ch = layout === 'mono-sum' || layout === 'mono' ? 1 : 2;
    if (format === 'MP3') return d * (parseInt(mp3Bitrate, 10) || 320) * 1000 / 8 / 1024 / 1024;
    const raw = d * effRate * (effBits / 8) * ch / 1024 / 1024;
    return format === 'FLAC' ? raw * 0.6 : raw;
  };


  // Styles communs (jetons de thème nv-* : clair et sombre)
  const sec = 'text-[10px] font-black text-nv-accent uppercase tracking-widest block border-b border-nv-line/15 pb-1';
  const lab = 'text-[11px] font-bold text-nv-muted';
  const sel = 'w-full min-h-10 bg-nv-well/40 border border-nv-line/15 rounded-lg px-3 text-[12px] text-nv-ink font-bold focus:border-nv-accent outline-none';
  const fmtS = (t: number) => `${(Math.round(t * 10) / 10).toFixed(1).replace('.', ',')} s`;
  const stemsSumToMixHint = returns === 'none'
    ? 'Stems secs : la réverbe et le delay ne sont dans aucun fichier.'
    : masterFx
      ? 'Avec le master : chaque stem est limité à part, leur somme sera plus forte que ton mix.'
      : 'Posés à 0 dans une autre session, ces stems redonnent exactement ton mix.';

  // Vue simple : « Mon morceau complet » = le mix entier, avec les réglages
  // en cours (WAV qualité studio par défaut), par le même export.
  const exportComplet = () => {
    sourceTouched.current = true;
    setSource('MASTER');
    setRangeMode('FULL');
    setTimeout(() => { void handleExportRef.current?.(); }, 50);
  };
  // Vue simple, instru pas achetée : mes voix seules (sans le beat), 2 € par
  // projet ou un export Nova Pro offert — même paiement que la vue avancée.
  const exportVoix = () => {
    sourceTouched.current = true;
    setSource('VOCALS');
    setTimeout(() => { void handleExportRef.current?.(); }, 50);
  };
  // Prix du morceau complet (instru importée : 2 €, ou export Nova Pro offert).
  const completPaye = !admin && !hasCatalogBeat && voicesUnlocked !== true;
  const choix = 'w-full flex items-center gap-3 rounded-2xl border p-4 text-left transition-all active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed';
  const statusBlock = (
    <>
      {isRendering && (
        <div className="space-y-1">
          <div className="flex justify-between text-[10px] font-black uppercase text-cyan-400">
            <span>Export en cours…</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="h-1.5 bg-black/50 rounded-full overflow-hidden">
            <div className="h-full bg-cyan-500 transition-all duration-100 ease-linear" style={{ width: `${progress}%` }} />
          </div>
          <span className="text-[11px] text-slate-400 block text-center animate-pulse">{statusText}</span>
        </div>
      )}
      {!isRendering && statusText && <p className="text-[12px] text-slate-300 text-center" role="status">{statusText}</p>}
      {loudnessReport && <p className="text-[11px] text-emerald-300 text-center" role="status">{loudnessReport}</p>}
    </>
  );

  return (
    <div className="fixed inset-0 z-[1200] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className={`w-full ${advanced ? 'max-w-3xl' : 'max-w-lg'} max-h-[90dvh] overflow-y-auto bg-[#14161a] border border-white/10 rounded-3xl shadow-2xl flex flex-col`} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="export-title">
        
        {/* Header */}
        <div className="p-6 border-b border-white/5 bg-gradient-to-r from-cyan-900/20 to-transparent flex justify-between items-center">
            <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20">
                    <i className="fas fa-file-export text-lg"></i>
                </div>
                <div>
                    <h2 id="export-title" className="text-sm font-black text-white uppercase tracking-widest">Exporter ton morceau</h2>
                    <p className="text-[11px] text-slate-400">{advanced ? 'Réglages avancés : format, qualité, pistes séparées' : 'Choisis ce que tu veux faire de ton son'}</p>
                </div>
            </div>
            <button aria-label="Fermer" title="Fermer" onClick={onClose} disabled={isRendering} className="nova-hit w-8 h-8 rounded-full hover:bg-white/10 text-slate-500 hover:text-white flex items-center justify-center transition-colors">
                <i className="fas fa-times"></i>
            </button>
        </div>

        <div className={`${advanced ? 'p-8' : 'p-6'} flex flex-col space-y-6`}>

            {!advanced && (
              <div className="space-y-3" data-export-vue="simple">
                {admin && (
                  <p className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-[12px] text-center font-bold text-emerald-300" role="status">
                    <i className="fas fa-user-shield mr-1"></i>Admin : export gratuit
                  </p>
                )}
                {onOpenShare && (
                  <button type="button" onClick={() => onOpenShare()} disabled={isRendering} className={`${choix} border-cyan-400/40 bg-cyan-500/10 hover:bg-cyan-500/15`}>
                    <span className="text-2xl leading-none" aria-hidden="true">📲</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-black text-white">Extrait 30 s pour les réseaux</span>
                      <span className="block text-[12px] text-slate-300 mt-0.5">Vidéo ou MP3 avec le tag Make Music, pour Insta, TikTok ou WhatsApp. Gratuit.</span>
                    </span>
                    <i className="fas fa-chevron-right text-slate-500" aria-hidden="true"></i>
                  </button>
                )}

                {adminPending && beatsNonAchetes.length > 0 ? (
                  <div className={`${choix} border-white/10 bg-white/[0.03]`} role="status">
                    <span className="text-2xl leading-none" aria-hidden="true">💿</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-black text-white">Mon morceau complet</span>
                      <span className="block text-[12px] text-slate-400 mt-0.5"><i className="fas fa-circle-notch fa-spin mr-1"></i>Vérification de ta licence…</span>
                    </span>
                  </div>
                ) : exportVerrouille ? (
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-2.5">
                    <div className="flex items-start gap-3">
                      <span className="text-2xl leading-none" aria-hidden="true">💿</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[15px] font-black text-white">Mon morceau complet</p>
                        <p className="text-[12px] text-slate-300 mt-0.5">
                          {beatsNonAchetes.length > 1
                            ? `${beatsNonAchetes.length} instrus de ton projet ne sont pas encore achetées.`
                            : `L'instru « ${beatsNonAchetes[0]?.clips[0]?.name || beatsNonAchetes[0]?.name} » n'est pas encore achetée.`}
                          {' '}Tu peux déjà récupérer une démo gratuite.
                        </p>
                      </div>
                    </div>
                    {onOpenShare && (
                      <button type="button" onClick={() => onOpenShare('demo')} disabled={isRendering}
                        className="w-full min-h-11 rounded-xl border border-cyan-400/40 bg-cyan-500/10 px-3 py-2 text-left text-[13px] font-bold text-cyan-100 hover:bg-cyan-500/20">
                        ⬇️ Démo gratuite du morceau complet <span className="font-normal text-cyan-200">(MP3 avec le tag)</span>
                      </button>
                    )}
                    <button type="button" onClick={() => openBuyBeat(projectState.tracks)}
                      className="w-full min-h-11 rounded-xl bg-amber-400 px-3 py-2 text-left text-[13px] font-black text-black hover:bg-amber-300">
                      🛒 Acheter l'instru <span className="font-bold text-black/70">: fichier propre, sans tag</span>
                    </button>
                    <button type="button" onClick={exportVoix} disabled={isRendering || payWait}
                      className="w-full min-h-11 rounded-xl border border-emerald-400/40 bg-emerald-500/10 px-3 py-2 text-left text-[13px] font-bold text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-50">
                      🎤 Mes voix seules, sans le beat{' '}
                      <span className="font-black text-emerald-300">
                        {payWait ? '· En attente du paiement…'
                          : voicesUnlocked === true ? '· Exporter'
                          : freeLeft !== null && freeLeft > 0 ? `· Exporter (gratuit Nova Pro · ${freeLeft} restants)`
                          : '· Payer 2 € et exporter'}
                      </span>
                    </button>
                    <button type="button" onClick={openProMix}
                      className="w-full min-h-10 rounded-xl bg-white/5 px-3 py-2 text-left text-[12px] font-bold text-slate-200 hover:bg-white/10">
                      🎚️ Le faire mixer par un ingé son pro
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={exportComplet} disabled={isRendering || payWait} className={`${choix} border-emerald-400/40 bg-emerald-500/10 hover:bg-emerald-500/15`}>
                    <span className="text-2xl leading-none" aria-hidden="true">💿</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-black text-white">Mon morceau complet</span>
                      <span className="block text-[12px] text-slate-300 mt-0.5">
                        {format === 'MP3' ? 'Fichier MP3' : format === 'WAV' ? 'Fichier WAV qualité studio' : `Fichier ${format}`}, sans tag, prêt pour Spotify ou YouTube.
                        {completPaye && (freeLeft !== null && freeLeft > 0 ? ` Gratuit avec Nova Pro (${freeLeft} restants).` : ' 2 €.')}
                      </span>
                    </span>
                    {payWait ? <span className="text-[11px] text-slate-300">Paiement…</span> : <i className="fas fa-download text-emerald-300" aria-hidden="true"></i>}
                  </button>
                )}

                {statusBlock}

                <button type="button" onClick={() => setAdvanced(true)} disabled={isRendering} aria-expanded={false}
                  className="w-full pt-1 text-center text-[12px] font-bold text-slate-400 hover:text-white">
                  ⚙️ Réglages avancés <span className="font-normal">(format, qualité, voix seules, pistes séparées…)</span>
                </button>
              </div>
            )}

            {advanced && (
            <button type="button" onClick={() => setAdvanced(false)} disabled={isRendering} aria-expanded={true}
              className="self-start -mt-2 text-[12px] font-bold text-slate-400 hover:text-white">
              ← Retour aux choix simples
            </button>
            )}

            {advanced && (
            <div className="flex flex-col gap-6 md:flex-row md:gap-8" data-export-vue="avancee">
                {/* COLONNE 1 : RÉGLAGES */}
                <div className="flex-1 min-w-0 space-y-6">

                    {/* 1. QUOI ET QUELLE DURÉE */}
                    <div className="space-y-3">
                        <span className={sec}>1. Quoi et quelle durée</span>
                        <div className="space-y-1">
                            <span className={lab}>Quoi</span>
                            {/* Choix visibles d'un coup d'œil (avant : caché dans une liste) : Mix / Stems / Voix seules. */}
                            <div role="radiogroup" aria-label="Quoi exporter" className="grid grid-cols-3 gap-1 rounded-lg border border-nv-line/15 bg-nv-well/40 p-1">
                              {([['MASTER', 'Mix', 'Le morceau mixé (Pro Tools : Bounce Mix ; Logic : Bounce ; Ableton : Export Audio ; FL : Export)'], ['STEMS', 'Stems', 'Les pistes séparées, alignées au début, même longueur (Pro Tools : Track Bounce ; Ableton : Export individual tracks ; FL : Split mixer tracks)'], ['VOCALS', 'Voix seules', 'Tes pistes sans le beat : voix, batterie (.zip)']] as const).map(([v, l, h]) => (
                                <button key={v} type="button" role="radio" aria-checked={source === v} title={h} disabled={isRendering}
                                  data-testid={`export-source-${v}`}
                                  onClick={() => { sourceTouched.current = true; setSource(v); }}
                                  className={`min-h-9 rounded-md text-[12px] font-bold transition-colors ${source === v ? 'bg-cyan-500 text-black' : 'text-nv-muted hover:bg-nv-raised'}`}>
                                  {l}
                                </button>
                              ))}
                            </div>
                            <p className="text-[11px] text-nv-muted">{source === 'MASTER' ? 'Le morceau mixé, en un fichier.' : source === 'STEMS' ? 'Les pistes séparées (.zip), toutes à 0 et de la même longueur, nommées Titre_BPM_Ton_Piste.' : 'Tes pistes sans le beat (.zip).'}</p>
                            {source === 'VOCALS' && (
                              <label className="mt-1.5 flex items-center gap-2 text-[12px] text-nv-ink">
                                <input type="checkbox" checked={vocalsDry} onChange={e => setVocalsDry(e.target.checked)} disabled={isRendering} />
                                Prises brutes (sans effets ni reverb)
                              </label>
                            )}
                        </div>

                        {source === 'STEMS' && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-xl border border-nv-line/15 bg-nv-well/30 p-3" data-export-stems="">
                            <label className="space-y-1 block">
                              <span className={lab}>Découpage</span>
                              <select value={grouping} onChange={e => setGrouping(e.target.value as StemGrouping)} disabled={isRendering} className={sel}
                                title="Par piste (Pro Tools : Track Bounce), par bus (Logic : Bounce des Track Stacks ; FL : Split mixer tracks), par dossier (Pro Tools : Routing Folders) ou instru / voix (ce que demande l'ingé)">
                                <option value="tracks">Une piste = un fichier</option>
                                <option value="buses">Par bus (bus voix, bus batterie…)</option>
                                <option value="folders">Par dossier</option>
                                <option value="instru-voix">Instru et voix séparés (pour l'ingé)</option>
                              </select>
                            </label>
                            <label className="space-y-1 block">
                              <span className={lab}>Réverbes et delays (retours)</span>
                              <select value={returns} onChange={e => setReturns(e.target.value as ReturnsMode)} disabled={isRendering} className={sel}
                                title="Dans chaque stem : chaque fichier garde sa réverbe. En fichiers séparés : stems secs + un fichier par retour, comme les « FX returns » qu'on livre à un mixeur. Sans : stems secs.">
                                <option value="in-stems">Dans chaque stem</option>
                                <option value="separate">En fichiers séparés</option>
                                <option value="none">Sans (stems secs)</option>
                              </select>
                            </label>
                            <label className="sm:col-span-2 flex items-center gap-2 text-[12px] text-nv-ink" title="Avec : chaque stem passe par les effets du master (limiteur, Master Nova). Sans : le master est contourné, la somme des stems redonne exactement le mix — ce qu'attend un ingé de mix (Pro Tools : stems « pre-master »).">
                              <input type="checkbox" checked={masterFx} onChange={e => setMasterFx(e.target.checked)} disabled={isRendering} />
                              Avec les effets du master (limiteur, Master Nova)
                            </label>
                            <p className="sm:col-span-2 text-[11px] text-nv-muted">
                              {stemsSumToMixHint}
                            </p>
                          </div>
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <label className="space-y-1 block">
                            <span className={lab}>Durée</span>
                            <select value={rangeMode} onChange={e => setRangeMode(e.target.value as RangeMode)} disabled={isRendering} className={sel}
                              title="Tout, la boucle, ta sélection ou d'un repère à l'autre (Pro Tools : Bounce de la sélection ; Logic : entre les localisateurs)">
                              <option value="FULL">Tout le morceau</option>
                              <option value="LOOP">Zone de boucle ({fmtS(projectState.loopStart)} → {fmtS(projectState.loopEnd)})</option>
                              {selRange && <option value="SELECTION">Ta sélection ({fmtS(selRange.start)} → {fmtS(selRange.end)})</option>}
                              {markers.length > 0 && <option value="MARKERS">D'un repère à l'autre</option>}
                            </select>
                          </label>
                          <label className="space-y-1 block">
                            <span className={lab}>Queue (réverbe après la fin)</span>
                            <div className="flex gap-2">
                              <select value={tailMode} onChange={e => setTailMode(e.target.value as TailMode)} disabled={isRendering} className={sel}
                                title="Auto : NOVA attend que la réverbe retombe (−80 dBFS, 10 s au plus). Réglée : durée fixe. Coupée : rien après la fin (FL : Cut remainder). Bouclée : la queue revient au début, pour une boucle sans trou (FL : Wrap remainder).">
                                <option value="auto">Auto (fin de la réverbe)</option>
                                <option value="manual">Réglée</option>
                                <option value="cut">Coupée net</option>
                                <option value="wrap">Bouclée (boucle sans trou)</option>
                              </select>
                              {tailMode === 'manual' && (
                                <input type="number" min={0} max={60} step={0.5} value={tailSec} onChange={e => setTailSec(Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
                                  aria-label="Durée de la queue en secondes" className={`${sel} w-20`} disabled={isRendering} />
                              )}
                            </div>
                          </label>
                          {rangeMode === 'MARKERS' && markers.length > 0 && (
                            <div className="sm:col-span-2 grid grid-cols-2 gap-3">
                              <label className="space-y-1 block">
                                <span className={lab}>De</span>
                                <select value={markerA} onChange={e => setMarkerA(e.target.value)} className={sel} disabled={isRendering} aria-label="Repère de début">
                                  {markers.map(m => <option key={m.id} value={m.id}>{m.name} ({fmtS(m.time)})</option>)}
                                </select>
                              </label>
                              <label className="space-y-1 block">
                                <span className={lab}>À</span>
                                <select value={markerB} onChange={e => setMarkerB(e.target.value)} className={sel} disabled={isRendering} aria-label="Repère de fin">
                                  {markers.map(m => <option key={m.id} value={m.id}>{m.name} ({fmtS(m.time)})</option>)}
                                  <option value="__end">Fin du morceau</option>
                                </select>
                              </label>
                            </div>
                          )}
                        </div>
                    </div>

                    {/* 2. FORMAT ET QUALITÉ */}
                    <div className="space-y-3">
                        <span className={sec}>2. Format et qualité</span>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <label className="space-y-1 block">
                                <span className={lab}>Type de fichier</span>
                                <select value={format} onChange={e => setFormat(e.target.value as ExportFormat)} disabled={isRendering} className={sel}
                                  title="WAV : le standard des studios (Pro Tools, Ableton, FL). AIFF : le standard Mac (Logic). FLAC : sans perte et 40 % plus léger. MP3 : pour partager.">
                                    <option value="WAV">WAV (qualité studio)</option>
                                    <option value="AIFF">AIFF (Mac, Logic)</option>
                                    <option value="FLAC">FLAC (sans perte, plus léger)</option>
                                    <option value="MP3">MP3 (pour partager)</option>
                                </select>
                            </label>
                            <label className="space-y-1 block">
                                <span className={lab}>Fréquence d'échantillonnage</span>
                                <select value={sampleRate} onChange={e => setSampleRate(Number(e.target.value))} disabled={isRendering} className={sel}
                                  title="Conversion de qualité studio (filtre anti-repliement), comme le SRC de Pro Tools ou de Logic à l'export">
                                    <option value="44100">44,1 kHz (CD, streaming)</option>
                                    <option value="48000">48 kHz (vidéo)</option>
                                    <option value="88200" disabled={format === 'MP3'}>88,2 kHz (Hi-Res)</option>
                                    <option value="96000" disabled={format === 'MP3'}>96 kHz (studio)</option>
                                </select>
                            </label>
                            {format !== 'MP3' ? (
                                <label className="space-y-1 block">
                                    <span className={lab}>Résolution</span>
                                    <select value={bitDepth} onChange={e => setBitDepth(e.target.value as '16' | '24' | '32')} disabled={isRendering} className={sel}>
                                        <option value="16">16 bits (CD)</option>
                                        <option value="24">24 bits (pro)</option>
                                        <option value="32" disabled={format === 'FLAC'}>32 bits flottant (max){format === 'FLAC' ? ' : pas en FLAC' : ''}</option>
                                    </select>
                                </label>
                            ) : (
                                <label className="space-y-1 block">
                                    <span className={lab}>Qualité MP3</span>
                                    <select value={mp3Bitrate} onChange={e => setMp3Bitrate(e.target.value)} disabled={isRendering} className={sel}>
                                        <option value="320">320 kbps (max)</option>
                                        <option value="192">192 kbps (bonne)</option>
                                        <option value="128">128 kbps (léger)</option>
                                    </select>
                                </label>
                            )}
                            <label className="space-y-1 block">
                                <span className={lab}>Canaux</span>
                                <select value={layout} onChange={e => setLayout(e.target.value as ChannelLayout)} disabled={isRendering} className={sel}
                                  title="Stéréo. Mono : le canal gauche seul (une voix mono enregistrée en stéréo). Mono (somme) : gauche + droite en un canal (Pro Tools : Mono Summed ; radio, contrôle de compatibilité). Double mono : un fichier gauche et un droit (Pro Tools : Multiple Mono).">
                                    <option value="stereo">Stéréo</option>
                                    <option value="mono">Mono (canal gauche)</option>
                                    <option value="mono-sum">Mono (somme G + D)</option>
                                    <option value="dual-mono">Double mono (G et D séparés)</option>
                                </select>
                            </label>
                        </div>
                        {format !== 'MP3' && effBits < 32 && (
                          <label className="flex items-center gap-2 text-[12px] text-nv-ink" title="Dither TPDF : un bruit infime qui évite la distorsion de quantification en passant à 16 bits (Pro Tools : POW-r ; Logic : Dither ; Ableton : Triangular)">
                            <input type="checkbox" checked={dither} onChange={e => setDither(e.target.checked)} disabled={isRendering} />
                            Dither (adoucit le passage en {effBits} bits{effBits === 16 ? ', conseillé' : ''})
                          </label>
                        )}
                        {format === 'MP3' && sampleRate > 48000 && <p className="text-[11px] text-nv-muted">Le MP3 s'arrête à 48 kHz : ton fichier sortira en 48 kHz.</p>}
                    </div>

                    {/* 3. VOLUME FINAL */}
                    <div className="space-y-3">
                        <span className={sec}>3. Volume final</span>
                        {source === 'MASTER' ? (
                          <label className="space-y-1 block">
                            <span className={lab}>Volume</span>
                            <select value={normalize} onChange={e => setNormalize(e.target.value)} disabled={isRendering} className={sel}
                              title="Les mêmes cibles que le Master Nova. NOVA monte ou baisse le volume sans jamais dépasser la crête vraie de la plateforme (pas de limiteur caché) et te donne le résultat mesuré.">
                              <option value="off">Tel quel{format === 'MP3' ? ' (MP3 : plafonné vers −1 dB)' : ''}</option>
                              <option value="peak">Au plus fort sans saturer (crête −1 dBTP)</option>
                              {PLATFORM_TARGETS.map(t => <option key={t.id} value={t.id}>{t.label} ({String(t.lufs).replace('-', '−')} LUFS, crête {String(t.ceiling).replace('-', '−').replace('.', ',')} dBTP)</option>)}
                            </select>
                          </label>
                        ) : (
                          <p className="text-[11px] text-nv-muted">Les stems gardent leur volume du mix (jamais normalisés) : posés à 0 dans une autre session, ils redonnent ton mix.</p>
                        )}
                        <p className="text-[11px] text-nv-muted">À la fin, NOVA mesure le fichier : LUFS intégrés, crête vraie (dBTP) et LRA.</p>
                    </div>

                    {/* 4. INFOS DU FICHIER */}
                    <div className="space-y-3">
                        <span className={sec}>4. Infos du fichier</span>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <label className="space-y-1 block"><span className={lab}>Titre</span>
                            <input value={metaTitle} onChange={e => setMetaTitle(e.target.value)} disabled={isRendering} className={sel} placeholder="Titre du morceau" /></label>
                          <label className="space-y-1 block"><span className={lab}>Artiste</span>
                            <input value={metaArtist} onChange={e => setMetaArtist(e.target.value)} disabled={isRendering} className={sel} placeholder="Ton nom d'artiste" /></label>
                          <label className="space-y-1 block"><span className={lab}>BPM</span>
                            <input value={metaBpm} onChange={e => setMetaBpm(e.target.value)} inputMode="decimal" disabled={isRendering} className={sel} /></label>
                          <label className="space-y-1 block"><span className={lab}>Tonalité</span>
                            <input value={metaKey} onChange={e => setMetaKey(e.target.value)} disabled={isRendering} className={sel} placeholder="ex. Do mineur" /></label>
                          <label className="space-y-1 block sm:col-span-2"><span className={lab}>ISRC (facultatif)</span>
                            <input value={metaIsrc} onChange={e => setMetaIsrc(e.target.value)} disabled={isRendering} className={`${sel} ${isrcOk ? '' : 'border-red-500'}`} placeholder="FR-Z03-26-00001 : donné par ton distributeur" aria-invalid={!isrcOk} />
                            {!isrcOk && <span className="text-[11px] text-red-400">12 caractères : 2 lettres de pays, 3 lettres ou chiffres, l'année et 5 chiffres.</span>}
                          </label>
                          <div className="sm:col-span-2 flex items-center gap-3">
                            {cover ? <img src={cover.url} alt="Pochette choisie" className="w-12 h-12 rounded-lg object-cover border border-nv-line/15" /> : <span className="w-12 h-12 rounded-lg border border-dashed border-nv-line/15 flex items-center justify-center text-nv-muted" aria-hidden="true"><i className="fas fa-image"></i></span>}
                            <label className="nova-hit min-h-9 px-3 rounded-lg border border-nv-line/15 text-[12px] font-bold text-nv-ink cursor-pointer flex items-center" title="Image dans le MP3 (ID3) et le FLAC : elle s'affiche dans le téléphone, l'ordinateur et les lecteurs">
                              <input type="file" accept="image/jpeg,image/png" className="sr-only" onChange={e => { void onCoverFile(e.target.files?.[0]); e.target.value = ''; }} disabled={isRendering} />
                              {cover ? 'Changer la pochette' : 'Ajouter une pochette'}
                            </label>
                            {cover && <button type="button" onClick={() => setCover(null)} className="text-[12px] text-nv-muted hover:text-nv-ink">Retirer</button>}
                          </div>
                          <p className="sm:col-span-2 text-[11px] text-nv-muted">
                            {format === 'MP3' ? 'Dans le MP3 : titre, artiste, BPM, tonalité, ISRC et pochette (ID3).'
                              : format === 'FLAC' ? 'Dans le FLAC : titre, artiste, BPM, tonalité, ISRC et pochette.'
                              : `Dans le ${format} : titre, artiste, BPM et mesure, tonalité, ISRC, repères et loudness (BWF), lus par Pro Tools, Logic, Ableton et FL.`}
                          </p>
                        </div>
                    </div>
                </div>

                {/* COLONNE 2 : RÉSUMÉ ET ACTION */}
                <div className="w-full md:w-64 flex flex-col border-t md:border-t-0 md:border-l border-nv-line/15 pt-6 md:pt-0 md:pl-8 justify-between gap-4">
                    <div className="space-y-4">
                        <label className="space-y-1 block">
                             <span className={lab}>Nom du fichier</span>
                             <input type="text" value={filename} onChange={e => setFilename(e.target.value)} disabled={isRendering} className={sel} />
                        </label>
                        <div className="bg-nv-well/40 p-3 rounded-lg space-y-2 text-[11px]">
                             <div className="flex justify-between gap-2"><span className="text-nv-muted">Taille estimée</span><span className="font-mono">~{estimateMb().toFixed(1).replace('.', ',')} Mo{source !== 'MASTER' ? ' / piste' : ''}</span></div>
                             <div className="flex justify-between gap-2"><span className="text-nv-muted">Durée</span><span className="font-mono">{Math.floor(getDuration() / 60)} min {String(Math.round(getDuration() % 60)).padStart(2, '0')} s{tailMode === 'auto' ? ' env.' : ''}</span></div>
                             <div className="flex justify-between gap-2"><span className="text-nv-muted">Fichier</span><span className="font-mono text-right">{format === 'MP3' ? `MP3 ${mp3Bitrate}` : `${format} ${effBits === 32 ? '32f' : effBits}`} · {effRate / 1000} kHz</span></div>
                             <div className="flex justify-between gap-2"><span className="text-nv-muted">Canaux</span><span className="font-mono">{layout === 'stereo' ? 'Stéréo' : layout === 'dual-mono' ? '2 × mono' : 'Mono'}</span></div>
                        </div>
                    </div>

                    <div className="space-y-3">
                        {statusBlock}

                        {exportVerrouille && !adminPending && (
                          <div className="mb-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200">
                            <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest">
                              <i className="fas fa-lock"></i>
                              Export verrouillé
                            </div>
                            <p className="mt-1.5 text-[11px] leading-relaxed text-amber-100/80">
                              {beatsNonAchetes.length > 1
                                ? `${beatsNonAchetes.length} instrumentaux du catalogue ne sont pas achetés.`
                                : `L'instrumental « ${beatsNonAchetes[0]?.clips[0]?.name || beatsNonAchetes[0]?.name} » n'est pas acheté.`}
                              {' '}Le studio permet de l'essayer librement ; l'achat débloque l'export du morceau.
                            </p>
                            <button type="button" onClick={() => { sourceTouched.current = true; setSource('VOCALS'); }}
                              className={`mt-2 w-full min-h-10 py-2 leading-tight rounded-lg text-[11px] font-bold ${source === 'VOCALS' ? 'bg-emerald-500/25 text-emerald-100 border border-emerald-400/50' : 'border border-emerald-400/40 text-emerald-200 hover:bg-emerald-500/10'}`}>
                              🎤 {source === 'VOCALS' ? 'Mes pistes seules sélectionnées : export possible' : 'Exporter mes pistes seules (voix, batterie), sans le beat ni la mélodie'}
                            </button>
                            {/* Le moment où l'artiste veut son fichier : on lui donne les deux suites possibles. */}
                            <div className="mt-3 flex flex-col gap-2">
                              <button type="button" onClick={() => openBuyBeat(projectState.tracks)}
                                className="w-full min-h-10 py-2 leading-tight rounded-lg bg-amber-400 text-black text-[11px] font-black uppercase tracking-wide hover:bg-amber-300">
                                🛒 Acheter cette instru
                              </button>
                              <button type="button" onClick={openProMix}
                                className="w-full min-h-10 py-2 leading-tight rounded-lg bg-white/10 text-white text-[11px] font-bold hover:bg-white/20">
                                🎚️ Faire mixer par un pro
                              </button>
                            </div>
                            {onOpenShare && (
                              <button type="button" onClick={() => onOpenShare()}
                                className="mt-2 w-full min-h-10 py-2 leading-tight rounded-lg border border-cyan-400/40 text-cyan-200 text-[11px] font-bold hover:bg-cyan-500/10">
                                📲 Démo gratuite (MP3 tagué) ou extrait 30 s à partager
                              </button>
                            )}
                          </div>
                        )}

                        {admin && (
                          <p className="text-[11px] text-center font-bold text-emerald-400" role="status">
                            <i className="fas fa-user-shield mr-1"></i>Admin : export gratuit
                          </p>
                        )}

                        <button
                            onClick={bloque ? () => openBuyBeat(projectState.tracks) : () => void handleExport(false)}
                            disabled={isRendering || payWait || (adminPending && (bloque || needsVoicesPayment))}
                            data-testid="export-go"
                            title={bloque ? "Achète l'instrumental pour exporter (ou choisis « Voix seules »)" : undefined}
                            className="w-full min-h-12 py-3 whitespace-normal text-center leading-tight bg-cyan-500 hover:bg-cyan-400 text-black rounded-xl text-[11px] font-black uppercase tracking-[0.12em] shadow-lg shadow-cyan-500/20 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2"
                        >
                            {bloque ? <i className="fas fa-lock"></i>
                              : isRendering ? <i className="fas fa-circle-notch fa-spin"></i>
                              : <i className="fas fa-download"></i>}
                            <span>{adminPending && (bloque || needsVoicesPayment) ? 'VÉRIFICATION…' : bloque ? "ACHETER L'INSTRU POUR EXPORTER" : payWait ? 'EN ATTENTE DU PAIEMENT…' : needsVoicesPayment ? (freeLeft !== null && freeLeft > 0 ? `EXPORTER (GRATUIT NOVA PRO · ${freeLeft} RESTANTS)` : 'PAYER 2 € ET EXPORTER') : source === 'VOCALS' ? 'EXPORTER MES PISTES' : 'EXPORTER'}</span>
                        </button>
                        {!bloque && !needsVoicesPayment && (
                          <button type="button" onClick={() => void handleExport(true)} disabled={isRendering || payWait} data-testid="export-queue"
                            title="Lance cet export en arrière-plan et garde la fenêtre libre : ajoute ensuite un MP3, les stems… (Pro Tools : Bounce en arrière-plan ; Logic : file de bounce). Une notification te prévient à la fin."
                            className="w-full min-h-10 rounded-xl border border-nv-line/15 text-[12px] font-bold text-nv-ink hover:bg-nv-raised disabled:opacity-50">
                            <i className="fas fa-layer-group mr-1.5" aria-hidden="true"></i>Ajouter à la file d'exports
                          </button>
                        )}
                    </div>
                </div>
            </div>
            )}


            {/* Notes MIDI en .mid (V25) */}
            <MidiExportRow tracks={projectState.tracks} />
        </div>
      </div>
    </div>
  );
};

export default ExportModal;
