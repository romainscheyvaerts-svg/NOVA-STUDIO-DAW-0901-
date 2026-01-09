
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Instrument, User, PendingUpload } from '../types';
import { supabaseManager } from '../services/SupabaseManager';
import { generateCoverArt, generateCreativeMetadata } from '../services/AIService';
import { AudioConverter } from '../services/AudioConverter';

interface AdminPanelProps {
  user: User;
  onSuccess: () => void;
  onClose: () => void;
  existingInstruments: Instrument[];
}

const ADMIN_EMAIL = 'romain.scheyvaerts@gmail.com';

const AdminPanel: React.FC<AdminPanelProps> = ({ user, onSuccess, onClose, existingInstruments }) => {
  // Editing State
  const [editingId, setEditingId] = useState<number | null>(null);

  // Metadata Form
  const [name, setName] = useState('');
  const [category, setCategory] = useState<'Trap' | 'Drill' | 'Boombap' | 'Afro' | 'RnB' | 'Pop' | 'Electro'>('Trap');
  const [bpm, setBpm] = useState<number>(140);
  const [musicalKey, setMusicalKey] = useState('C Minor');

  // AI Gen
  const [coverPrompt, setCoverPrompt] = useState('');
  const [isGeneratingImg, setIsGeneratingImg] = useState(false);
  const [isGeneratingMeta, setIsGeneratingMeta] = useState(false);

  // Files
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  
  // PREVIEW (MP3 Converted)
  const [previewFile, setPreviewFile] = useState<Blob | null>(null);
  const [previewFileName, setPreviewFileName] = useState<string>(''); // Nom fichier original
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null); // Pour lecteur audio
  const [isConverting, setIsConverting] = useState(false);

  const [stemsFile, setStemsFile] = useState<File | null>(null);

  // External URLs (From Drive Import - Will be converted)
  const [importedPreviewUrl, setImportedPreviewUrl] = useState<string | null>(null);
  const [importedStemsUrl, setImportedStemsUrl] = useState<string | null>(null);
  const [importSourceIds, setImportSourceIds] = useState<number[]>([]);

  // Pricing
  const [priceBasic, setPriceBasic] = useState(29.99);
  const [pricePremium, setPricePremium] = useState(79.99);
  const [priceExclusive, setPriceExclusive] = useState(299.99);

  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>('');
  
  // Inventory Management State
  const [inventory, setInventory] = useState<Instrument[]>(existingInstruments);

  // Pending Uploads State
  const [pendingUploads, setPendingUploads] = useState<{
    instru: PendingUpload;
    stems?: PendingUpload;
    identifier: string;
    isWavPreview: boolean;
  }[]>([]);

  // Audio Preview State (Global Player)
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Refs for clearing inputs
  const coverInputRef = useRef<HTMLInputElement>(null);
  const previewInputRef = useRef<HTMLInputElement>(null);
  const stemsInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
      setInventory(existingInstruments);
  }, [existingInstruments]);

  // Fetch pending uploads on mount
  useEffect(() => {
      fetchPendingUploads();
      return () => {
          if (audioRef.current) {
              audioRef.current.pause();
              audioRef.current = null;
          }
      };
  }, []);

  const fetchPendingUploads = async () => {
      const data = await supabaseManager.getPendingUploads();
      processPendingUploads(data);
  };

  const processPendingUploads = (uploads: PendingUpload[]) => {
      const groups: Record<string, { instru?: PendingUpload, stems?: PendingUpload }> = {};
      
      uploads.forEach(item => {
          const match = item.filename.match(/(\d+)/);
          if (!match) return; 

          const identifier = match[1];
          const lowerName = item.filename.toLowerCase();
          
          const isStems = lowerName.endsWith('.zip') || lowerName.endsWith('.rar') || lowerName.includes('stem') || lowerName.includes('trackout') || lowerName.includes('ppp');

          if (!groups[identifier]) groups[identifier] = {};

          if (isStems) {
              groups[identifier].stems = item;
          } else {
              if (lowerName.endsWith('.mp3') || lowerName.endsWith('.wav')) {
                  groups[identifier].instru = item;
              }
          }
      });

      const groupedList = Object.entries(groups)
          .filter(([_, grp]) => grp.instru)
          .map(([key, grp]) => ({
              instru: grp.instru!,
              stems: grp.stems,
              identifier: key,
              isWavPreview: grp.instru!.filename.toLowerCase().endsWith('.wav')
          }));
      
      setPendingUploads(groupedList);
  };

  const initialized = useRef(false);
  useEffect(() => {
      if (!initialized.current && !editingId) {
          initialized.current = true;
      }
  }, [editingId]);

  if (!user || user.email.toLowerCase() !== ADMIN_EMAIL) {
    return null;
  }

  // --- AUDIO PREVIEW LOGIC ---
  const togglePreview = (url: string) => {
      // FIX: Utilisation directe de l'URL Supabase
      const fullUrl = supabaseManager.getPublicInstrumentUrl(url);

      if (playingUrl === fullUrl) {
          if (audioRef.current) {
              audioRef.current.pause();
              audioRef.current = null;
          }
          setPlayingUrl(null);
      } else {
          if (audioRef.current) audioRef.current.pause();
          
          const audio = new Audio(fullUrl);
          audio.volume = 0.5;
          audio.onended = () => setPlayingUrl(null);
          audio.onerror = () => setStatus("⚠️ Erreur lecture audio");
          
          audio.play().catch(e => console.error("Preview play error:", e));
          
          audioRef.current = audio;
          setPlayingUrl(fullUrl);
      }
  };

  // --- CONVERSION LOGIC ---
  const handleWavConversion = async (fileOrUrl: File | string, originalName: string) => {
      setIsConverting(true);
      setStatus("🔄 Conversion WAV -> MP3 (128kbps) en cours...");
      
      try {
          let sourceBlob: Blob;

          if (typeof fileOrUrl === 'string') {
              // C'est une URL (Import Drive ou Supabase), on télécharge d'abord
              const fullUrl = supabaseManager.getPublicInstrumentUrl(fileOrUrl);
              const res = await fetch(fullUrl);
              if (!res.ok) throw new Error("Impossible de télécharger le fichier source");
              sourceBlob = await res.blob();
          } else {
              sourceBlob = fileOrUrl;
          }

          // Appel au convertisseur
          const mp3Blob = await AudioConverter.convertToMp3(sourceBlob);
          
          // Mise à jour state
          setPreviewFile(mp3Blob);
          setPreviewFileName(originalName.replace(/\.(wav|mp3)$/i, '') + '.mp3');
          
          // Création URL locale pour écoute immédiate
          const objUrl = URL.createObjectURL(mp3Blob);
          setLocalPreviewUrl(objUrl);
          
          setStatus("✅ Conversion MP3 terminée ! Prêt à uploader.");
          setIsConverting(false);
          return mp3Blob;

      } catch (e: any) {
          console.error("Conversion Error:", e);
          setStatus(`❌ Erreur conversion: ${e.message}`);
          setIsConverting(false);
          return null;
      }
  };

  const resetForm = () => {
      setEditingId(null);
      setName('');
      setCategory('Trap');
      setBpm(140);
      setMusicalKey('C Minor');
      setCoverFile(null);
      setCoverPreviewUrl(null);
      setPreviewFile(null);
      setPreviewFileName('');
      setLocalPreviewUrl(null);
      setStemsFile(null);
      setImportedPreviewUrl(null);
      setImportedStemsUrl(null);
      setImportSourceIds([]);
      setPriceBasic(29.99);
      setPricePremium(79.99);
      setPriceExclusive(299.99);
      setStatus('');
      
      if (coverInputRef.current) coverInputRef.current.value = '';
      if (previewInputRef.current) previewInputRef.current.value = '';
      if (stemsInputRef.current) stemsInputRef.current.value = '';
  };

  const handleImport = async (group: { instru: PendingUpload, stems?: PendingUpload, identifier: string }) => {
      resetForm();
      
      let cleanName = group.instru.filename
          .replace(/\.(mp3|wav|zip|rar)$/i, '')
          .replace(/^\d+\s*[-_]?\s*/, '') 
          .replace(/[-_]/g, ' ')
          .trim();
      
      if (!cleanName) cleanName = `Beat #${group.identifier}`;

      setName(cleanName);
      setImportSourceIds([group.instru.id]);
      
      // Auto-trigger conversion for imported file
      await handleWavConversion(group.instru.download_url, group.instru.filename);
      
      if (group.stems) {
          setImportedStemsUrl(group.stems.download_url);
          setImportSourceIds(prev => [...prev, group.stems!.id]);
          setPriceBasic(10);
          setPricePremium(30);
          setPriceExclusive(150);
      } else {
          setPriceBasic(29.99);
          setPricePremium(79.99);
          setPriceExclusive(299.99);
      }

      handleRegenerateName(cleanName); 
  };

  const handleEditClick = (inst: Instrument) => {
      resetForm(); 
      setEditingId(inst.id);
      setName(inst.name);
      setCategory(inst.category);
      setBpm(inst.bpm);
      setMusicalKey(inst.musical_key);
      setPriceBasic(inst.price_basic);
      setPricePremium(inst.price_premium);
      setPriceExclusive(inst.price_exclusive);
      setCoverPreviewUrl(inst.image_url);
      
      // On load la preview existante pour lecture
      setLocalPreviewUrl(supabaseManager.getPublicInstrumentUrl(inst.preview_url));
      
      setStatus("✏️ Mode Édition activé.");
  };

  const dataURLtoFile = (dataurl: string, filename: string): File => {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)![1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, { type: mime });
  };

  const handleRegenerateName = async (baseContext?: string) => {
      setIsGeneratingMeta(true);
      try {
          const context = baseContext || category;
          const meta = await generateCreativeMetadata(context);
          if (!baseContext) setName(meta.name);
          setCoverPrompt(meta.prompt);
      } catch (e) {
          console.error(e);
      } finally {
          setIsGeneratingMeta(false);
      }
  };

  const handleGenerateCover = async () => {
    if (!name) {
        setStatus("❌ Nom requis pour la cover.");
        return;
    }
    setIsGeneratingImg(true);
    setStatus("🎨 Génération de la cover par IA...");
    try {
        const base64Img = await generateCoverArt(name, category, coverPrompt);
        if (base64Img) {
            setCoverPreviewUrl(base64Img);
            const file = dataURLtoFile(base64Img, `ai-cover-${Date.now()}.png`);
            setCoverFile(file);
            setStatus("✅ Cover générée !");
        } else {
            setStatus("❌ Échec de la génération.");
        }
    } catch (e: any) {
        setStatus(`❌ Erreur IA: ${e.message}`);
    } finally {
        setIsGeneratingImg(false);
    }
  };

  const handleRegenerateAll = async () => {
      if (editingId) return; 
      setStatus("🧠 Brainstorming IA...");
      setIsGeneratingMeta(true);
      try {
          const meta = await generateCreativeMetadata(category);
          setName(meta.name);
          setCoverPrompt(meta.prompt);
          await handleGenerateCover(); 
      } catch (e) {
          console.error(e);
      } finally {
          setIsGeneratingMeta(false);
      }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>, type: 'cover' | 'preview' | 'stems') => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (type === 'cover') {
          setCoverFile(file);
          setCoverPreviewUrl(URL.createObjectURL(file));
      } else if (type === 'preview') {
          // AUTO CONVERT TO MP3
          setImportedPreviewUrl(null); 
          await handleWavConversion(file, file.name);
      } else if (type === 'stems') {
          setStemsFile(file);
          setImportedStemsUrl(null); 
      }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Check if we have audio
    const hasAudio = !!previewFile || !!importedPreviewUrl || (editingId !== null);

    if (!editingId && (!name || !coverFile || !hasAudio)) {
      setStatus("❌ Création : Il manque le nom, la cover ou l'audio converti.");
      return;
    }

    setLoading(true);
    setStatus("🚀 Upload en cours...");

    try {
      let coverUrl = '';
      let previewUrl = '';
      let stemsUrl = '';

      // Upload Cover
      if (coverFile) {
          setStatus("📸 Upload Cover...");
          coverUrl = await supabaseManager.uploadStoreFile(coverFile, 'covers');
      } else if (editingId) {
           const original = inventory.find(i => i.id === editingId);
           if (original) coverUrl = original.image_url;
      }

      // Upload MP3 Preview (Converted Blob)
      if (previewFile) {
          setStatus("🎵 Upload Preview Optimisée (MP3)...");
          const mp3File = new File([previewFile], previewFileName, { type: 'audio/mp3' });
          previewUrl = await supabaseManager.uploadStoreFile(mp3File, 'previews');
      } else if (importedPreviewUrl) {
          previewUrl = importedPreviewUrl; 
      } else if (editingId) {
          const original = inventory.find(i => i.id === editingId);
          if (original) previewUrl = original.preview_url;
      }

      // Upload Stems
      if (stemsFile) {
          setStatus("🗂️ Upload Stems...");
          stemsUrl = await supabaseManager.uploadStoreFile(stemsFile, 'stems');
      } else if (importedStemsUrl) {
          stemsUrl = importedStemsUrl; 
      } else if (editingId) {
          const original = inventory.find(i => i.id === editingId);
          if (original) stemsUrl = original.stems_url || '';
      }

      if (editingId) {
          setStatus("💾 Mise à jour base de données...");
          await supabaseManager.updateInstrument(editingId, {
              name, category, bpm, musical_key: musicalKey,
              image_url: coverUrl, preview_url: previewUrl, stems_url: stemsUrl || null,
              price_basic: priceBasic, price_premium: pricePremium, price_exclusive: priceExclusive
          });
          
          setStatus("✅ Modification réussie !");
          setEditingId(null);
      } else {
          setStatus("💾 Enregistrement dans la base...");
          await supabaseManager.addInstrument({
            name, category, bpm, musical_key: musicalKey,
            image_url: coverUrl, preview_url: previewUrl, stems_url: stemsUrl,
            price_basic: priceBasic, price_premium: pricePremium, price_exclusive: priceExclusive,
            is_visible: true 
          });
          setStatus("✅ Beat ajouté avec succès !");

          if (importSourceIds.length > 0) {
              await supabaseManager.markUploadAsProcessed(importSourceIds);
              await fetchPendingUploads(); 
          }
      }

      resetForm();
      onSuccess(); 
      
    } catch (err: any) {
      console.error(err);
      setStatus(`❌ Erreur: ${err.message || 'Problème inconnu'}`);
    } finally {
      setLoading(false);
    }
  };

  const toggleVisibility = async (id: number, current: boolean) => {
      try {
          await supabaseManager.updateInstrumentVisibility(id, !current);
          onSuccess(); 
      } catch (e) {
          console.error("Failed to toggle visibility", e);
      }
  };

  const deleteInstrument = async (id: number) => {
      if(!window.confirm("Êtes-vous sûr de vouloir supprimer ce beat définitivement ?")) return;
      try {
          await supabaseManager.deleteInstrument(id);
          onSuccess(); 
      } catch (e) {
          console.error("Failed to delete instrument", e);
      }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black/95 backdrop-blur-xl flex justify-center items-center p-6 animate-in fade-in duration-300">
      
      <div className="w-full max-w-7xl h-[90vh] bg-[#14161a] border border-white/10 rounded-3xl flex flex-col overflow-hidden shadow-2xl relative">
        
        {/* HEADER */}
        <div className="h-16 border-b border-white/5 flex items-center justify-between px-8 bg-black/20">
            <div className="flex items-center space-x-3">
                <div className="w-8 h-8 bg-cyan-500 rounded-lg flex items-center justify-center text-black shadow-[0_0_15px_rgba(6,182,212,0.5)]">
                    <i className="fas fa-crown text-sm"></i>
                </div>
                <div>
                    <h2 className="text-sm font-black uppercase tracking-[0.2em] text-white">Admin Dashboard</h2>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Store Manager v2.3 (MP3 Encoder)</p>
                </div>
            </div>
            <button 
                onClick={onClose}
                className="w-8 h-8 rounded-full bg-white/5 hover:bg-red-500 hover:text-white text-slate-500 flex items-center justify-center transition-all"
            >
                <i className="fas fa-times"></i>
            </button>
        </div>

        {/* CONTENT SPLIT VIEW */}
        <div className="flex-1 flex overflow-hidden">
            
            {/* LEFT COLUMN: FORM */}
            <div className="w-1/3 min-w-[400px] border-r border-white/5 flex flex-col bg-[#0c0d10]">
                {/* ... (Form Header) ... */}
                <div className={`p-6 border-b border-white/5 flex justify-between items-center ${editingId ? 'bg-amber-500/10' : ''}`}>
                    <h3 className={`text-xs font-black uppercase tracking-widest ${editingId ? 'text-amber-400' : 'text-cyan-400'}`}>
                        <i className={`fas ${editingId ? 'fa-edit' : 'fa-plus-circle'} mr-2`}></i>
                        {editingId ? 'Modifier le Beat' : 'Ajouter un nouveau Beat'}
                    </h3>
                    
                    {editingId ? (
                        <button 
                            onClick={resetForm}
                            className="text-[9px] bg-white/5 hover:bg-red-500 hover:text-white px-2 py-1 rounded transition-colors text-slate-400"
                        >
                            <i className="fas fa-times mr-1"></i> Annuler
                        </button>
                    ) : (
                        <button 
                            onClick={() => handleRegenerateAll()}
                            disabled={isGeneratingMeta || isGeneratingImg}
                            className="text-[9px] bg-white/5 hover:bg-cyan-500 hover:text-black px-2 py-1 rounded transition-colors text-slate-400"
                            title="Tout régénérer (Nom + Cover)"
                        >
                            <i className={`fas fa-random mr-1 ${isGeneratingMeta ? 'fa-spin' : ''}`}></i> Auto-Gen
                        </button>
                    )}
                </div>
                
                <div className="flex-1 overflow-y-auto p-6 custom-scroll">
                    
                    {/* ... (Pending Uploads) ... */}
                    {!editingId && pendingUploads.length > 0 && (
                        <div className="mb-6 bg-blue-500/5 border border-blue-500/20 rounded-xl overflow-hidden">
                            <div className="px-4 py-2 bg-blue-500/10 border-b border-blue-500/10 flex justify-between items-center">
                                <span className="text-[9px] font-black uppercase text-blue-400 tracking-widest">
                                    <i className="fab fa-google-drive mr-2"></i>Inbox Drive ({pendingUploads.length})
                                </span>
                                <button onClick={fetchPendingUploads} className="text-blue-400 hover:text-white"><i className="fas fa-sync-alt text-[9px]"></i></button>
                            </div>
                            <div className="max-h-40 overflow-y-auto custom-scroll">
                                {pendingUploads.map((group) => (
                                    <div key={group.identifier} className="p-3 border-b border-white/5 flex items-center justify-between hover:bg-white/5 transition-colors group">
                                        <div className="flex flex-col min-w-0 pr-2">
                                            <div className="text-[10px] font-bold text-white truncate" title={group.instru.filename}>{group.instru.filename}</div>
                                            <div className="flex items-center space-x-2 mt-1">
                                                <span className={`text-[8px] font-mono px-1.5 rounded ${group.stems ? 'bg-green-500/20 text-green-400' : 'bg-orange-500/20 text-orange-400'}`}>
                                                    {group.stems ? '✅ STEMS' : '🎵 AUDIO'}
                                                </span>
                                            </div>
                                        </div>
                                        <button 
                                            onClick={() => handleImport(group)}
                                            className="px-3 py-1.5 bg-blue-500 hover:bg-blue-400 text-black text-[9px] font-black uppercase rounded shadow-lg transition-transform active:scale-95"
                                        >
                                            Convertir & Import
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-6">
                        {/* METADATA */}
                        <div className="space-y-4 bg-white/5 p-4 rounded-xl border border-white/5">
                            <label className="text-[9px] font-black text-slate-500 uppercase block">1. Informations de base</label>
                            
                            <div className="relative">
                                <input 
                                    type="text" 
                                    value={name} 
                                    onChange={(e) => setName(e.target.value)} 
                                    className="w-full bg-black/40 border border-white/10 rounded-lg pl-3 pr-8 py-2 text-xs text-white focus:border-cyan-500 outline-none" 
                                    placeholder="Nom du Beat (ex: NIGHT RIDER)" 
                                />
                                <button 
                                    type="button"
                                    onClick={() => handleRegenerateName()}
                                    disabled={isGeneratingMeta}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-cyan-400"
                                    title="Régénérer le nom"
                                >
                                    <i className={`fas fa-dice ${isGeneratingMeta ? 'fa-spin' : ''}`}></i>
                                </button>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-3">
                                <select value={category} onChange={(e) => setCategory(e.target.value as any)} className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white focus:border-cyan-500 outline-none">
                                    {['Trap', 'Drill', 'Boombap', 'Afro', 'RnB', 'Pop', 'Electro'].map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                                <div className="flex space-x-2">
                                    <input type="number" value={bpm} onChange={(e) => setBpm(Number(e.target.value))} className="w-1/2 bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white text-center" placeholder="BPM" />
                                    <input type="text" value={musicalKey} onChange={(e) => setMusicalKey(e.target.value)} className="w-1/2 bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-xs text-white text-center" placeholder="Key" />
                                </div>
                            </div>
                        </div>

                        {/* FILES */}
                        <div className="space-y-4 bg-white/5 p-4 rounded-xl border border-white/5">
                            <label className="text-[9px] font-black text-slate-500 uppercase block">2. Fichiers & Cover</label>
                            
                            <div className="flex space-x-3">
                                <div className="w-20 h-20 bg-black rounded-lg border border-white/10 flex items-center justify-center overflow-hidden shrink-0 relative group">
                                    {coverPreviewUrl ? (
                                        <img src={coverPreviewUrl} className="w-full h-full object-cover" alt="Preview" />
                                    ) : (
                                        <i className={`fas ${isGeneratingImg ? 'fa-spinner fa-spin' : 'fa-image'} text-white/20`}></i>
                                    )}
                                    <button 
                                        type="button" 
                                        onClick={() => handleGenerateCover()} 
                                        className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center text-cyan-400 transition-opacity"
                                        title="Régénérer Cover"
                                    >
                                        <i className="fas fa-sync-alt"></i>
                                    </button>
                                </div>
                                <div className="flex-1 space-y-2">
                                    <input type="file" ref={coverInputRef} accept="image/*" onChange={(e) => handleFileChange(e, 'cover')} className="hidden" id="cover-upload" />
                                    <label htmlFor="cover-upload" className="block w-full py-1.5 bg-white/10 hover:bg-white/20 text-center rounded-lg text-[9px] font-bold text-slate-300 cursor-pointer transition-all">
                                        {coverFile ? "Fichier Sélectionné" : "Changer l'image"}
                                    </label>
                                    <div className="flex space-x-2">
                                        <input type="text" value={coverPrompt} onChange={(e) => setCoverPrompt(e.target.value)} placeholder="Prompt IA" className="flex-1 bg-black/40 border border-white/10 rounded-lg px-2 text-[9px] text-white truncate" />
                                        <button type="button" onClick={() => handleGenerateCover()} disabled={isGeneratingImg} className="px-3 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs"><i className="fas fa-magic"></i></button>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-2">
                                {/* PREVIEW INPUT WITH CONVERSION */}
                                <div className={`flex flex-col p-2 rounded-lg border ${previewFile ? 'bg-green-500/10 border-green-500/30' : 'bg-black/20 border-white/5'}`}>
                                    <div className="flex items-center space-x-2 mb-1">
                                        <i className="fas fa-music text-green-400 text-xs"></i>
                                        <div className="flex-1 min-w-0">
                                            {previewFile ? (
                                                <div className="flex items-center justify-between">
                                                    <span className="text-[9px] font-mono text-green-300 truncate">{previewFileName}</span>
                                                    <span className="text-[7px] bg-green-500 text-black px-1 rounded font-bold">READY (MP3)</span>
                                                </div>
                                            ) : (
                                                <input type="file" ref={previewInputRef} accept="audio/*" onChange={(e) => handleFileChange(e, 'preview')} className="text-[9px] text-slate-400 file:bg-white/10 file:text-white file:border-0 file:rounded-md file:px-2 file:py-0.5 file:mr-2 cursor-pointer w-full" />
                                            )}
                                        </div>
                                    </div>
                                    
                                    {/* PREVIEW PLAYER */}
                                    {localPreviewUrl && (
                                        <div className="mt-2 flex items-center bg-black/40 rounded px-2 py-1">
                                            <button 
                                                type="button" 
                                                onClick={() => togglePreview(localPreviewUrl!)}
                                                className={`mr-2 ${playingUrl === localPreviewUrl ? 'text-green-400' : 'text-slate-400 hover:text-white'}`}
                                            >
                                                <i className={`fas ${playingUrl === localPreviewUrl ? 'fa-stop' : 'fa-play'} text-xs`}></i>
                                            </button>
                                            <div className="h-1 bg-white/10 flex-1 rounded-full overflow-hidden">
                                                <div className={`h-full bg-green-500 ${playingUrl === localPreviewUrl ? 'animate-pulse' : ''}`} style={{width: '100%'}}></div>
                                            </div>
                                            <span className="ml-2 text-[7px] text-slate-500">PRÉ-ÉCOUTE</span>
                                        </div>
                                    )}

                                    {isConverting && (
                                        <div className="mt-1 text-[8px] text-cyan-400 animate-pulse text-center">
                                            <i className="fas fa-cog fa-spin mr-1"></i> Encodage MP3 en cours...
                                        </div>
                                    )}
                                </div>
                                
                                {/* STEMS INPUT */}
                                <div className={`flex items-center space-x-2 p-2 rounded-lg border ${importedStemsUrl ? 'bg-green-500/10 border-green-500/30' : 'bg-black/20 border-white/5'}`}>
                                    <i className="fas fa-file-archive text-amber-400 text-xs"></i>
                                    <div className="flex-1 min-w-0">
                                        {importedStemsUrl ? (
                                            <span className="text-[9px] font-mono text-green-300">🔗 Fichier Drive Lié (STEMS)</span>
                                        ) : (
                                            <input type="file" ref={stemsInputRef} accept=".zip,.rar" onChange={(e) => handleFileChange(e, 'stems')} className="text-[9px] text-slate-400 file:bg-white/10 file:text-white file:border-0 file:rounded-md file:px-2 file:py-0.5 file:mr-2 cursor-pointer w-full" />
                                        )}
                                    </div>
                                    {importedStemsUrl && <button type="button" onClick={() => setImportedStemsUrl(null)} className="text-red-500 hover:text-white"><i className="fas fa-times text-[10px]"></i></button>}
                                </div>
                            </div>
                        </div>

                        {/* PRICES */}
                        <div className="space-y-4 bg-white/5 p-4 rounded-xl border border-white/5">
                            <label className="text-[9px] font-black text-slate-500 uppercase block">3. Tarification ($)</label>
                            <div className="grid grid-cols-3 gap-2">
                                <div><label className="text-[8px] text-slate-500 block mb-1">MP3</label><input type="number" step="0.01" value={priceBasic} onChange={(e) => setPriceBasic(Number(e.target.value))} className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-xs text-white" /></div>
                                <div><label className="text-[8px] text-slate-500 block mb-1">WAV</label><input type="number" step="0.01" value={pricePremium} onChange={(e) => setPricePremium(Number(e.target.value))} className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-xs text-white" /></div>
                                <div><label className="text-[8px] text-slate-500 block mb-1">STEMS</label><input type="number" step="0.01" value={priceExclusive} onChange={(e) => setPriceExclusive(Number(e.target.value))} className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-xs text-white" /></div>
                            </div>
                        </div>

                        <div className="pt-2">
                            <span className="block text-[10px] text-center text-slate-400 mb-2">{status}</span>
                            <button 
                                type="submit" 
                                disabled={loading || isConverting} 
                                className={`w-full h-12 rounded-xl text-[10px] font-black uppercase tracking-[0.2em] shadow-lg transition-all disabled:opacity-50 ${editingId ? 'bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-black shadow-amber-500/20' : 'bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white shadow-cyan-500/20'}`}
                            >
                                {loading || isConverting ? <i className="fas fa-spinner fa-spin"></i> : (editingId ? "Mettre à jour" : "Mettre en ligne")}
                            </button>
                        </div>
                    </form>
                </div>
            </div>

            {/* RIGHT COLUMN: INVENTORY LIST */}
            <div className="flex-1 flex flex-col bg-[#14161a]">
                <div className="p-6 border-b border-white/5 flex justify-between items-center">
                    <h3 className="text-xs font-black uppercase tracking-widest text-slate-300">
                        <i className="fas fa-list mr-2"></i>Inventaire ({inventory.length})
                    </h3>
                </div>

                <div className="flex-1 overflow-y-auto custom-scroll p-6">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="border-b border-white/10 text-[9px] font-black uppercase text-slate-500 tracking-wider">
                                <th className="py-3 pl-2 text-center">Preview</th>
                                <th className="py-3 pl-2">Cover</th>
                                <th className="py-3">Nom</th>
                                <th className="py-3">Prix (MP3)</th>
                                <th className="py-3 text-center">Visible ?</th>
                                <th className="py-3 text-right pr-2">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {inventory.map((inst) => (
                                <tr key={inst.id} className={`hover:bg-white/[0.02] transition-colors ${editingId === inst.id ? 'bg-amber-500/5' : ''}`}>
                                    <td className="py-3 text-center">
                                         <button 
                                            onClick={() => togglePreview(inst.preview_url)}
                                            className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${playingUrl && inst.preview_url.includes(playingUrl) ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/30' : 'bg-white/5 text-slate-400 hover:text-white hover:bg-white/10'}`}
                                         >
                                             <i className={`fas ${playingUrl && inst.preview_url.includes(playingUrl) ? 'fa-pause' : 'fa-play'} text-xs`}></i>
                                         </button>
                                    </td>
                                    <td className="py-3 pl-2">
                                        <img src={inst.image_url} alt="cover" className="w-10 h-10 rounded-md object-cover border border-white/10" />
                                    </td>
                                    <td className="py-3">
                                        <div className="text-xs font-bold text-white">{inst.name}</div>
                                        <div className="text-[9px] text-slate-500">{inst.category}</div>
                                    </td>
                                    <td className="py-3">
                                        <span className="text-xs font-mono text-green-400">${inst.price_basic}</span>
                                    </td>
                                    <td className="py-3 text-center">
                                        <button 
                                            onClick={() => toggleVisibility(inst.id, inst.is_visible)}
                                            className={`w-10 h-5 rounded-full relative transition-colors duration-300 ${inst.is_visible ? 'bg-green-500' : 'bg-slate-700'}`}
                                        >
                                            <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full transition-transform duration-300 ${inst.is_visible ? 'translate-x-5' : 'translate-x-0'}`} />
                                        </button>
                                    </td>
                                    <td className="py-3 text-right pr-2 space-x-2">
                                        <button 
                                            onClick={() => handleEditClick(inst)}
                                            className="w-8 h-8 rounded-lg bg-amber-500/10 hover:bg-amber-500 text-amber-500 hover:text-black transition-all inline-flex items-center justify-center"
                                            title="Modifier"
                                        >
                                            <i className="fas fa-pencil-alt text-xs"></i>
                                        </button>
                                        <button 
                                            onClick={() => deleteInstrument(inst.id)}
                                            className="w-8 h-8 rounded-lg bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white transition-all inline-flex items-center justify-center"
                                            title="Supprimer"
                                        >
                                            <i className="fas fa-trash text-xs"></i>
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default AdminPanel;
