
import { integratedLufs, normalizeToLufs, truePeakDb } from '../utils/loudness';
import { openCheckout, waitPaid, isExportVoicesUnlocked, markExportVoicesUnlocked, spendExportCredit, billingStatus } from '../services/Billing';
import React, { useState, useEffect } from 'react';
import { DAWState, Track } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { AudioEncoder, BitDepth, AudioFormat } from '../services/AudioEncoder';
import JSZip from 'jszip';
import { saveBlob } from '../utils/saveBlob';
import { openBuyBeat, openProMix } from '../utils/studioLinks';
import { prepareTracksForOffline } from '../services/VstFreeze';
import { track } from '../utils/analytics';

// Compte admin du studio (tout gratuit pour tester) : lu une fois par session.
let adminCache: boolean | null = null;

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectState: DAWState;
  /** Instrumentaux du catalogue achetes par l'utilisateur. */
  ownedInstrumentIds?: (string | number)[];
  /** Démo taguée / extrait à partager (dispo sans licence). */
  onOpenShare?: () => void;
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
  const handleExportRef = React.useRef<(() => Promise<void>) | null>(null);
  const [rangeMode, setRangeMode] = useState<'FULL' | 'LOOP'>('FULL');

  // FORMAT & QUALITÉ
  const [format, setFormat] = useState<AudioFormat>('WAV');
  const [sampleRate, setSampleRate] = useState<number>(44100);
  const [bitDepth, setBitDepth] = useState<BitDepth>('24');
  const [mp3Bitrate, setMp3Bitrate] = useState<string>('320');

  // TRAITEMENT
  // Normalisation : aucune, crête (-0,1 dB) ou loudness (LUFS) comme les plateformes
  const [normalize, setNormalize] = useState<'off' | 'peak' | 'lufs14' | 'lufs16'>('off');
  const [loudnessReport, setLoudnessReport] = useState<string | null>(null);
  const [dither, setDither] = useState(true); // On by default for lower bit depths

  // UI STATE
  const [isRendering, setIsRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');

  useEffect(() => {
    if (isOpen) {
        setFilename(projectState.name || 'Master');
        setProgress(0);
        setStatusText('');
        setIsRendering(false);
    }
  }, [isOpen, projectState.name]);

  if (!isOpen) return null;

  // --- HELPERS ---

  const getDuration = () => {
      if (rangeMode === 'LOOP') {
          return Math.max(1, projectState.loopEnd - projectState.loopStart);
      }
      // Full Project + Tail
      const maxTime = Math.max(...projectState.tracks.flatMap(t => t.clips.map(c => c.start + c.duration)), 0);
      return maxTime + 2; // +2s tail reverb
  };

  const getStartOffset = () => {
      return rangeMode === 'LOOP' ? projectState.loopStart : 0;
  };

  const processAudioBuffer = (buffer: AudioBuffer, isStem = false): AudioBuffer => {
      // 1. Normalisation
      if (isStem) {
          // pas de normalisation par piste
      } else if (normalize === 'peak') {
          setStatusText('Normalisation (-0.1 dB)...');
          AudioEncoder.normalizeBuffer(buffer, -0.1);
          setLoudnessReport(`Mesuré : ${integratedLufs(buffer).toFixed(1)} LUFS · crête vraie ${truePeakDb(buffer).toFixed(1)} dBTP`);
      } else if (normalize === 'lufs14' || normalize === 'lufs16') {
          const target = normalize === 'lufs14' ? -14 : -16;
          setStatusText(`Loudness ${target} LUFS...`);
          const r = normalizeToLufs(buffer, target, -1);
          setLoudnessReport(`Loudness : ${Number.isFinite(r.before) ? r.before.toFixed(1) : '—'} → ${Number.isFinite(r.after) ? r.after.toFixed(1) : '—'} LUFS · crête vraie ${r.truePeak.toFixed(1)} dBTP${r.limitedByPeak ? ' (cible non atteinte : crêtes trop hautes, passe un limiteur sur le master)' : ''}`);
      } else {
          setLoudnessReport(`Mesuré : ${integratedLufs(buffer).toFixed(1)} LUFS · crête vraie ${truePeakDb(buffer).toFixed(1)} dBTP`);
      }
      
      // 2. Dithering (Uniquement si réduction de bits)
      if (dither && format === 'WAV' && bitDepth !== '32') {
          setStatusText('Application du Dithering (TPDF)...');
          AudioEncoder.applyDither(buffer, parseInt(bitDepth));
      }

      return buffer;
  };

  // --- CORE RENDER LOGIC ---

  const renderTrackList = async (tracksToRender: Track[], label: string, opts: { duration?: number; onProgress?: (p: number) => void; isStem?: boolean } = {}): Promise<Blob> => {
      setStatusText(`Rendu Audio : ${label}...`);
      
      const duration = opts.duration ?? getDuration();
      const startOffset = getStartOffset();

      // Rendu Offline via AudioEngine
      const renderedBuffer = await audioEngine.renderProject(
          tracksToRender,
          duration,
          startOffset,
          // Le MP3 ne sait pas encoder au-delà de 48 kHz
          format === 'MP3' ? Math.min(48000, sampleRate) : sampleRate,
          (p) => {
              if (source === 'MASTER') setProgress(p); // Only update main progress bar here if master
              opts.onProgress?.(p);
          }
      );

      // Post-Processing (DSP). Stems : jamais de normalisation par piste (elle
      // casserait l'équilibre entre les pistes) ; le dither reste.
      const processedBuffer = processAudioBuffer(renderedBuffer, !!opts.isStem);

      // Encodage
      if (format === 'MP3') {
        const kbps = parseInt(mp3Bitrate, 10) || 320;
        setStatusText(`Encodage MP3 (${kbps} kbps)...`);
        return await AudioEncoder.encodeMP3(processedBuffer, kbps);
      }
      setStatusText(`Encodage ${format} (${bitDepth}bit)...`);
      return AudioEncoder.encodeWAV(processedBuffer, bitDepth);
  };

  const handleExport = async () => {
    if (needsVoicesPayment) { void payVoices(); return; }
    if (bloque) {
      setStatusText("Achetez l'instrumental pour exporter votre morceau (les voix seules restent exportables).");
      return;
    }
    setIsRendering(true);
    setProgress(0);

    // Effets VST3 du PC : rendus par le pont (ou rendu déjà fait à la
    // sauvegarde). Un OfflineAudioContext ne peut pas attendre le pont.
    const prep = await prepareTracksForOffline(projectState.tracks, msg => setStatusText(msg));
    const exportTracks = prep.tracks;
    try {
        if (prep.missingVst.length > 0) {
            setStatusText(`Effets VST non inclus (pont VST non connecté) : ${prep.missingVst.join(', ')}`);
        }
        if (source === 'MASTER') {
            // --- EXPORT MASTER SIMPLE ---
            const blob = await renderTrackList(exportTracks, "Master Mix");
            downloadBlob(blob, format === 'MP3'
              ? `${filename}_${mp3Bitrate}kbps.mp3`
              : `${filename}_${sampleRate}Hz_${bitDepth}bit.${format.toLowerCase()}`);
        } 
        else if (source === 'VOCALS') {
            // --- VOIX SEULES, PISTE PAR PISTE (ZIP) ---
            const estBeat = (t: typeof exportTracks[number]) => t.id === 'instrumental' || (t.instrumentId !== undefined && t.instrumentId !== null && t.instrumentId !== '');
            // Le beat n'existe plus dans ce rendu.
            const sansBeat = exportTracks.filter(t => !estBeat(t));
            // Les pistes de l'artiste : ses voix et sa batterie (sons Make Music,
            // utilisables librement). La mélodie / le beat du catalogue n'y sont pas.
            const voix = sansBeat.filter(t => (t.type === 'AUDIO' || t.type === 'DRUM_RACK') && !t.isMuted && t.clips.some(c => !c.isMuted));
            if (voix.length === 0) throw new Error('Aucune de tes pistes (voix, batterie) à exporter.');
            // Durée : jusqu'à la fin de la dernière voix + 4 s de queue (reverb),
            // pas la longueur du beat. Tous les fichiers démarrent au même point.
            const finVoix = Math.max(...voix.flatMap(t => t.clips.map(c => c.start + c.duration)));
            const dureeVoix = rangeMode === 'LOOP' ? getDuration() : Math.max(1, finVoix + 4);
            const zip = new JSZip();
            for (let i = 0; i < voix.length; i++) {
                const track = voix[i];
                setStatusText(`Voix ${i + 1}/${voix.length} : ${track.name}`);
                setProgress((i / voix.length) * 100);
                const rendu = vocalsDry
                  // Prise brute : clips seuls, sans effets, départs ni bus.
                  ? [{ ...track, isSolo: false, isFrozen: false, frozenClip: undefined, plugins: [], sends: [], outputTrackId: 'master', automationLanes: [] }, ...sansBeat.filter(t => t.id === 'master')]
                  // Avec effets : la piste en solo à travers son bus et ses envois (reverb…).
                  : sansBeat.map(t => t.id === track.id ? { ...t, isMuted: false, isSolo: true } : { ...t, isSolo: false });
                const blob = await renderTrackList(rendu, track.name, {
                  duration: dureeVoix, isStem: true,
                  onProgress: p => setProgress(((i + p / 100) / voix.length) * 100),
                });
                const ext = format === 'MP3' ? 'mp3' : format.toLowerCase();
                zip.file(`${String(i + 1).padStart(2, '0')} ${track.name.replace(/[^a-z0-9 _-]/gi, '_')}${vocalsDry ? ' (brut)' : ''}.${ext}`, blob);
            }
            setStatusText("Compression ZIP...");
            const zipBlob = await zip.generateAsync({ type: "blob" });
            downloadBlob(zipBlob, `${filename}_Mes_pistes${vocalsDry ? '_brutes' : ''}.zip`);
        }
        else {
            // --- EXPORT STEMS (ZIP) ---
            const zip = new JSZip();
            const tracksToExport = exportTracks.filter(t => 
                !t.isMuted && t.id !== 'master' && (t.clips.length > 0 || t.type === 'BUS' || t.type === 'SEND')
            );
            
            const totalSteps = tracksToExport.length;
            
            for (let i = 0; i < totalSteps; i++) {
                const track = tracksToExport[i];
                const trackName = track.name.replace(/[^a-z0-9]/gi, '_');
                
                // Update UI
                setStatusText(`Export Stem ${i + 1}/${totalSteps} : ${track.name}`);
                setProgress((i / totalSteps) * 100);

                // On soloe la piste : renderProject garde aussi tout ce qui
                // l'alimente (pistes -> bus -> master) et ses departs.
                const isolatedTracks = exportTracks.map(t => {
                   if (t.id === track.id) return { ...t, isMuted: false, isSolo: true };
                   return { ...t, isSolo: false };
                });

                // Render Logic handles Solo implicitly
                const blob = await renderTrackList(isolatedTracks, track.name, { isStem: true });
                zip.file(`${trackName}.wav`, blob);
            }

            setStatusText("Compression ZIP...");
            const zipBlob = await zip.generateAsync({ type: "blob" });
            downloadBlob(zipBlob, `${filename}_Stems.zip`);
        }

        setStatusText('✅ Export Terminé !');
        const kind = source === 'VOCALS' ? 'vocals' : source === 'STEMS' ? 'stems' : 'full';
        track('export_done', { source: kind, paid: paidExport, admin });
        onExported?.({ source: kind, paid: paidExport });
        setTimeout(() => {
            onClose();
            setIsRendering(false);
        }, 1500);

    } catch (e: any) {
        console.error(e);
        setStatusText(`❌ Erreur: ${e.message}`);
        setIsRendering(false);
    } finally {
        prep.cleanup();
    }
  };

  const downloadBlob = (blob: Blob, name: string) => saveBlob(blob, name);
  handleExportRef.current = handleExport;

  return (
    <div className="fixed inset-0 z-[1200] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-2xl max-h-[90dvh] overflow-y-auto bg-[#14161a] border border-white/10 rounded-3xl shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
        
        {/* Header */}
        <div className="p-6 border-b border-white/5 bg-gradient-to-r from-cyan-900/20 to-transparent flex justify-between items-center">
            <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20">
                    <i className="fas fa-file-export text-lg"></i>
                </div>
                <div>
                    <h2 className="text-sm font-black text-white uppercase tracking-widest">Bounce Audio</h2>
                    <p className="text-[10px] text-slate-500 font-mono">Mastering & Export</p>
                </div>
            </div>
            <button aria-label="Fermer" title="Fermer" onClick={onClose} disabled={isRendering} className="w-8 h-8 rounded-full hover:bg-white/10 text-slate-500 hover:text-white flex items-center justify-center transition-colors">
                <i className="fas fa-times"></i>
            </button>
        </div>

        <div className="p-8 flex flex-col space-y-6">
            
            <div className="flex flex-col gap-6 md:flex-row md:gap-8">
                {/* COLUMN 1: CONFIG */}
                <div className="flex-1 space-y-6">
                    
                    {/* SECTION: SOURCE */}
                    <div className="space-y-3">
                        <span className="text-[9px] font-black text-cyan-500 uppercase tracking-widest block border-b border-white/5 pb-1">1. Source & Plage</span>
                        
                        <div className="grid grid-cols-2 gap-3">
                             <div className="space-y-1">
                                <label className="text-[9px] font-bold text-slate-400">Source</label>
                                <select 
                                    value={source} 
                                    onChange={e => { sourceTouched.current = true; setSource(e.target.value as any); }}
                                    disabled={isRendering}
                                    className="w-full h-10 bg-black/40 border border-white/10 rounded-lg px-3 text-[10px] text-white font-bold focus:border-cyan-500 outline-none"
                                >
                                    <option value="MASTER">Mix master (stéréo)</option>
                                    <option value="STEMS">Toutes les pistes (stems .zip)</option>
                                    <option value="VOCALS">Mes pistes seules : voix, batterie (.zip)</option>
                                </select>
                                {source === 'VOCALS' && (
                                  <label className="mt-1.5 flex items-center gap-2 text-[10px] text-slate-300">
                                    <input type="checkbox" checked={vocalsDry} onChange={e => setVocalsDry(e.target.checked)} disabled={isRendering} />
                                    Prises brutes (sans effets ni reverb)
                                  </label>
                                )}
                             </div>
                             <div className="space-y-1">
                                <label className="text-[9px] font-bold text-slate-400">Plage Temporelle</label>
                                <select 
                                    value={rangeMode} 
                                    onChange={e => setRangeMode(e.target.value as any)}
                                    disabled={isRendering}
                                    className="w-full h-10 bg-black/40 border border-white/10 rounded-lg px-3 text-[10px] text-white font-bold focus:border-cyan-500 outline-none"
                                >
                                    <option value="FULL">Projet Entier</option>
                                    <option value="LOOP">Boucle Active ({projectState.loopStart.toFixed(1)}s - {projectState.loopEnd.toFixed(1)}s)</option>
                                </select>
                             </div>
                        </div>
                    </div>

                    {/* SECTION: FORMAT */}
                    <div className="space-y-3">
                        <span className="text-[9px] font-black text-cyan-500 uppercase tracking-widest block border-b border-white/5 pb-1">2. Format & Qualité</span>
                        
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                                <label className="text-[9px] font-bold text-slate-400">Type de fichier</label>
                                <select 
                                    value={format} 
                                    onChange={e => { setFormat(e.target.value as any); if(e.target.value === 'MP3') setBitDepth('16'); }}
                                    disabled={isRendering}
                                    className="w-full h-10 bg-black/40 border border-white/10 rounded-lg px-3 text-[10px] text-white font-bold focus:border-cyan-500 outline-none"
                                >
                                    <option value="WAV">WAV (PCM)</option>
                                    <option value="MP3">MP3 (pour partager)</option>
                                </select>
                            </div>

                            <div className="space-y-1">
                                <label className="text-[9px] font-bold text-slate-400">Fréquence</label>
                                <select 
                                    value={sampleRate} 
                                    onChange={e => setSampleRate(Number(e.target.value))}
                                    disabled={isRendering}
                                    className="w-full h-10 bg-black/40 border border-white/10 rounded-lg px-3 text-[10px] text-white font-bold focus:border-cyan-500 outline-none"
                                >
                                    <option value="44100">44100 Hz (CD)</option>
                                    <option value="48000">48000 Hz (Video)</option>
                                    <option value="88200" disabled={format === 'MP3'}>88200 Hz (Hi-Res)</option>
                                    <option value="96000" disabled={format === 'MP3'}>96000 Hz (Studio)</option>
                                </select>
                            </div>

                            {format === 'WAV' ? (
                                <div className="space-y-1">
                                    <label className="text-[9px] font-bold text-slate-400">Résolution</label>
                                    <select 
                                        value={bitDepth} 
                                        onChange={e => setBitDepth(e.target.value as any)}
                                        disabled={isRendering}
                                        className="w-full h-10 bg-black/40 border border-white/10 rounded-lg px-3 text-[10px] text-white font-bold focus:border-cyan-500 outline-none"
                                    >
                                        <option value="16">16-bit (Standard)</option>
                                        <option value="24">24-bit (Pro)</option>
                                        <option value="32">32-bit Float (Max)</option>
                                    </select>
                                </div>
                            ) : (
                                <div className="space-y-1">
                                    <label className="text-[9px] font-bold text-slate-400">Bitrate</label>
                                    <select 
                                        value={mp3Bitrate} 
                                        onChange={e => setMp3Bitrate(e.target.value)}
                                        disabled={isRendering}
                                        className="w-full h-10 bg-black/40 border border-white/10 rounded-lg px-3 text-[10px] text-white font-bold focus:border-cyan-500 outline-none"
                                    >
                                        <option value="320">320 kbps (Max)</option>
                                        <option value="192">192 kbps (Good)</option>
                                        <option value="128">128 kbps (Fast)</option>
                                    </select>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* SECTION: DSP OPTIONS */}
                    <div className="space-y-3">
                        <span className="text-[9px] font-black text-cyan-500 uppercase tracking-widest block border-b border-white/5 pb-1">3. Traitement du Signal</span>
                        <div className="flex space-x-6">
                            <label className="flex items-center space-x-2 text-[10px] font-bold text-slate-300">
                                <span>Niveau</span>
                                <select value={normalize} onChange={e => setNormalize(e.target.value as typeof normalize)} disabled={isRendering}
                                    className="h-8 bg-black/40 border border-white/10 rounded-lg px-2 text-[10px] text-white font-bold focus:border-cyan-500 outline-none">
                                    <option value="off">Tel quel</option>
                                    <option value="peak">Crête -0,1 dB</option>
                                    <option value="lufs14">-14 LUFS (Spotify, YouTube)</option>
                                    <option value="lufs16">-16 LUFS (Apple Music)</option>
                                </select>
                            </label>

                            <label className="flex items-center space-x-2 cursor-pointer group">
                                <div className={`w-4 h-4 border rounded flex items-center justify-center transition-all ${dither ? 'bg-cyan-500 border-cyan-500 text-black' : 'border-white/20 bg-black/40'}`}>
                                    {dither && <i className="fas fa-check text-[8px]"></i>}
                                </div>
                                <input type="checkbox" checked={dither} onChange={e => setDither(e.target.checked)} className="hidden" disabled={isRendering || bitDepth === '32'} />
                                <span className={`text-[10px] font-bold ${dither ? 'text-white' : 'text-slate-500 group-hover:text-slate-300'} ${bitDepth === '32' ? 'opacity-50' : ''}`}>Dithering (Triangular)</span>
                            </label>
                        </div>
                    </div>
                </div>

                {/* COLUMN 2: SUMMARY & ACTION */}
                <div className="w-full md:w-60 flex flex-col border-t md:border-t-0 md:border-l border-white/5 pt-6 md:pt-0 md:pl-8 justify-between">
                    <div className="space-y-4">
                        <div className="space-y-1">
                             <label className="text-[9px] font-bold text-slate-500">Nom du fichier</label>
                             <input 
                                type="text" 
                                value={filename} 
                                onChange={e => setFilename(e.target.value)} 
                                disabled={isRendering}
                                className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-white focus:border-cyan-500 outline-none"
                             />
                        </div>
                        <div className="bg-white/5 p-3 rounded-lg space-y-2">
                             <div className="flex justify-between text-[9px]">
                                <span className="text-slate-500">Taille estimée</span>
                                <span className="text-white font-mono">~{(format === 'MP3' ? getDuration() * (parseInt(mp3Bitrate, 10) || 320) * 1000 / 8 / 1024 / 1024 : getDuration() * sampleRate * (parseInt(bitDepth)/8) * 2 / 1024 / 1024).toFixed(1)} MB</span>
                             </div>
                             <div className="flex justify-between text-[9px]">
                                <span className="text-slate-500">Durée</span>
                                <span className="text-white font-mono">{getDuration().toFixed(1)}s</span>
                             </div>
                             <div className="flex justify-between text-[9px]">
                                <span className="text-slate-500">Canaux</span>
                                <span className="text-white font-mono">Stéréo L/R</span>
                             </div>
                        </div>
                    </div>

                    <div className="space-y-3">
                        {isRendering && (
                            <div className="space-y-1">
                                <div className="flex justify-between text-[8px] font-black uppercase text-cyan-400">
                                    <span>Exporting...</span>
                                    <span>{Math.round(progress)}%</span>
                                </div>
                                <div className="h-1.5 bg-black/50 rounded-full overflow-hidden">
                                    <div className="h-full bg-cyan-500 transition-all duration-100 ease-linear" style={{ width: `${progress}%` }} />
                                </div>
                                <span className="text-[8px] text-slate-500 block text-center animate-pulse">{statusText}</span>
                            </div>
                        )}
                        {loudnessReport && <p className="text-[10px] text-emerald-300 text-center" role="status">{loudnessReport}</p>}

                        {exportVerrouille && !adminPending && (
                          <div className="mb-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200">
                            <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest">
                              <i className="fas fa-lock"></i>
                              Export verrouillé
                            </div>
                            <p className="mt-1.5 text-[10px] leading-relaxed text-amber-100/80">
                              {beatsNonAchetes.length > 1
                                ? `${beatsNonAchetes.length} instrumentaux du catalogue ne sont pas achetés.`
                                : `L'instrumental « ${beatsNonAchetes[0]?.clips[0]?.name || beatsNonAchetes[0]?.name} » n'est pas acheté.`}
                              {' '}Le studio permet de l'essayer librement ; l'achat débloque l'export du morceau.
                            </p>
                            <button
                              type="button"
                              onClick={() => { sourceTouched.current = true; setSource('VOCALS'); }}
                              className={`mt-2 w-full min-h-10 py-2 leading-tight rounded-lg text-[11px] font-bold ${source === 'VOCALS' ? 'bg-emerald-500/25 text-emerald-100 border border-emerald-400/50' : 'border border-emerald-400/40 text-emerald-200 hover:bg-emerald-500/10'}`}
                            >
                              🎤 {source === 'VOCALS' ? 'Mes pistes seules sélectionnées : export possible' : 'Exporter mes pistes seules (voix, batterie), sans le beat ni la mélodie'}
                            </button>
                            {/* Le moment où l'artiste veut son fichier : on lui donne les deux suites possibles. */}
                            <div className="mt-3 flex flex-col gap-2">
                              <button
                                type="button"
                                onClick={() => openBuyBeat(projectState.tracks)}
                                className="w-full min-h-10 py-2 leading-tight rounded-lg bg-amber-400 text-black text-[11px] font-black uppercase tracking-wide hover:bg-amber-300"
                              >
                                🛒 Acheter cette instru
                              </button>
                              <button
                                type="button"
                                onClick={openProMix}
                                className="w-full min-h-10 py-2 leading-tight rounded-lg bg-white/10 text-white text-[11px] font-bold hover:bg-white/20"
                              >
                                🎚️ Faire mixer par un pro
                              </button>
                            </div>
                            {onOpenShare && (
                              <button
                                type="button"
                                onClick={onOpenShare}
                                className="mt-2 w-full min-h-10 py-2 leading-tight rounded-lg border border-cyan-400/40 text-cyan-200 text-[11px] font-bold hover:bg-cyan-500/10"
                              >
                                📲 Démo gratuite (MP3 tagué) ou extrait 30 s à partager
                              </button>
                            )}
                          </div>
                        )}

                        {admin && (
                          <p className="text-[10px] text-center font-bold text-emerald-300" role="status">
                            <i className="fas fa-user-shield mr-1"></i>Admin : export gratuit
                          </p>
                        )}

                        <button 
                            onClick={bloque ? () => openBuyBeat(projectState.tracks) : handleExport}
                            disabled={isRendering || payWait || (adminPending && (bloque || needsVoicesPayment))}
                            title={bloque ? "Achetez l'instrumental pour exporter (ou choisissez « Voix seules »)" : undefined}
                            className="w-full min-h-12 py-3 whitespace-normal text-center leading-tight bg-cyan-500 hover:bg-cyan-400 text-black rounded-xl text-[10px] font-black uppercase tracking-[0.12em] shadow-lg shadow-cyan-500/20 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2"
                        >
                            {bloque ? <i className="fas fa-lock"></i>
                              : isRendering ? <i className="fas fa-circle-notch fa-spin"></i>
                              : <i className="fas fa-download"></i>}
                            <span>{adminPending && (bloque || needsVoicesPayment) ? 'VÉRIFICATION…' : bloque ? "ACHETER L'INSTRU POUR EXPORTER" : payWait ? 'EN ATTENTE DU PAIEMENT…' : needsVoicesPayment ? (freeLeft !== null && freeLeft > 0 ? `EXPORTER (GRATUIT NOVA PRO · ${freeLeft} RESTANTS)` : 'PAYER 2 € ET EXPORTER') : source === 'VOCALS' ? 'EXPORTER MES PISTES' : 'EXPORTER'}</span>
                        </button>
                    </div>
                </div>
            </div>

        </div>
      </div>
    </div>
  );
};

export default ExportModal;
