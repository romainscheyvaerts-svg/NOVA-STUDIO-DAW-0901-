
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Instrument, Instrumental, User } from '../types';
import { supabaseManager } from '../services/SupabaseManager';
import { generateCoverArt, generateCreativeMetadata } from '../services/AIService';
import { audioEngine } from '../engine/AudioEngine';

interface AdminPanelProps {
  user: User;
  onSuccess: () => void;
  onClose: () => void;
  existingInstruments: Instrument[];
}

const ADMIN_EMAIL = 'romain.scheyvaerts@gmail.com';

const AdminPanel: React.FC<AdminPanelProps> = ({ user, onSuccess, onClose, existingInstruments }) => {
  // Editing State (for old instruments table)
  const [editingId, setEditingId] = useState<number | string | null>(null);
  
  // Editing Instrumental State (for new instrumentals table)
  const [editingInstrumental, setEditingInstrumental] = useState<Instrumental | null>(null);

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
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [stemsFile, setStemsFile] = useState<File | null>(null);

  // External URLs (From Drive Import)
  const [importedPreviewUrl, setImportedPreviewUrl] = useState<string | null>(null);
  const [importedStemsUrl, setImportedStemsUrl] = useState<string | null>(null);
  const [importSourceIds, setImportSourceIds] = useState<number[]>([]);

  // Pricing
  const [priceBasic, setPriceBasic] = useState(29.99);
  const [pricePremium, setPricePremium] = useState(79.99);
  const [priceExclusive, setPriceExclusive] = useState(299.99);

  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>('');
  
  // Inventory Management State (old instruments table)
  const [inventory, setInventory] = useState<Instrument[]>(existingInstruments);
  
  // NEW: Instrumentals from "instrumentals" table (Google Drive catalog)
  const [instrumentals, setInstrumentals] = useState<Instrumental[]>([]);
  const [loadingInstrumentals, setLoadingInstrumentals] = useState(true);
  
  // Audio Preview State
  const [playingId, setPlayingId] = useState<number | string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Refs for clearing inputs
  const coverInputRef = useRef<HTMLInputElement>(null);
  const previewInputRef = useRef<HTMLInputElement>(null);
  const stemsInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
      setInventory(existingInstruments);
  }, [existingInstruments]);

  // Fetch instrumentals from the new table on mount
  const fetchInstrumentals = async () => {
    setLoadingInstrumentals(true);
    try {
      const data = await supabaseManager.getInstrumentals();
      setInstrumentals(data);
    } catch (err) {
      console.error("Error fetching instrumentals:", err);
    } finally {
      setLoadingInstrumentals(false);
    }
  };

  useEffect(() => {
    fetchInstrumentals();
  }, []);

  // Security Check
  if (!user || user.email.toLowerCase() !== ADMIN_EMAIL) {
    return null;
  }

  // --- RESET FORM ---
  const resetForm = () => {
      setEditingId(null);
      setName('');
      setCategory('Trap');
      setBpm(140);
      setMusicalKey('C Minor');
      setCoverFile(null);
      setCoverPreviewUrl(null);
      setPreviewFile(null);
      setStemsFile(null);
      setImportedPreviewUrl(null);
      setImportedStemsUrl(null);
      setImportSourceIds([]);
      setPriceBasic(29.99);
      setPricePremium(79.99);
      setPriceExclusive(299.99);
      setStatus('');
      
      // Clear file inputs
      if (coverInputRef.current) coverInputRef.current.value = '';
      if (previewInputRef.current) previewInputRef.current.value = '';
      if (stemsInputRef.current) stemsInputRef.current.value = '';
  };

  // --- START EDIT ---
  const handleEditClick = (inst: Instrument) => {
      resetForm(); // Clear everything first
      setEditingId(inst.id);
      setName(inst.name);
      setCategory(inst.category);
      setBpm(inst.bpm);
      setMusicalKey(inst.musical_key);
      setPriceBasic(inst.price_basic);
      setPricePremium(inst.price_premium);
      setPriceExclusive(inst.price_exclusive);
      
      setCoverPreviewUrl(inst.image_url);
      
      setStatus("✏️ Mode Édition activé. Modifiez les champs et cliquez sur Mettre à jour.");
  };

  // --- HELPERS ---
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
          // If importing, use the existing name as context for the prompt
          const context = baseContext || category;
          const meta = await generateCreativeMetadata(context);
          if (!baseContext) setName(meta.name); // Only overwrite name if not importing specific file
          setCoverPrompt(meta.prompt);
      } catch (e) {
          console.error(e);
      } finally {
          setIsGeneratingMeta(false);
      }
  };

  const handleGenerateCover = async (forcedPrompt?: string, forcedName?: string) => {
    const currentName = forcedName || name;
    const currentPrompt = forcedPrompt || coverPrompt;

    if (!currentName) {
        setStatus("❌ Nom requis pour la cover.");
        return;
    }
    setIsGeneratingImg(true);
    setStatus("🎨 Génération de la cover par IA...");
    try {
        const base64Img = await generateCoverArt(currentName, category, currentPrompt);
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
      if (editingId) return; // Don't auto-gen in edit mode
      setStatus("🧠 Brainstorming IA...");
      setIsGeneratingMeta(true);
      try {
          const meta = await generateCreativeMetadata(category);
          setName(meta.name);
          setCoverPrompt(meta.prompt);
          // Chain cover generation
          await handleGenerateCover(meta.prompt, meta.name);
      } catch (e) {
          console.error(e);
      } finally {
          setIsGeneratingMeta(false);
      }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: 'cover' | 'preview' | 'stems') => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (type === 'cover') {
          setCoverFile(file);
          setCoverPreviewUrl(URL.createObjectURL(file));
      } else if (type === 'preview') {
          setPreviewFile(file);
          setImportedPreviewUrl(null); // Clear imported URL if manual file selected
      } else if (type === 'stems') {
          setStemsFile(file);
          setImportedStemsUrl(null); // Clear imported URL if manual file selected
      }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validation
    // For creation: need name + cover + (file OR importedUrl)
    if (!editingId && (!name || !coverFile || (!previewFile && !importedPreviewUrl))) {
      setStatus("❌ Création : Il manque le nom, la cover ou l'audio.");
      return;
    }
    if (editingId && !name) {
        setStatus("❌ Édition : Le nom est obligatoire.");
        return;
    }

    setLoading(true);
    setStatus("🚀 Traitement en cours...");

    try {
      let coverUrl = '';
      let previewUrl = '';
      let stemsUrl = '';

      // 1. Handle Uploads or Imported URLs
      if (coverFile) {
          setStatus("📸 Upload Cover...");
          coverUrl = await supabaseManager.uploadStoreFile(coverFile, 'covers');
      } else if (editingId) {
          // In edit mode, keep existing unless changed
           const original = inventory.find(i => i.id === editingId);
           if (original) coverUrl = original.image_url;
      }

      if (previewFile) {
          setStatus("🎵 Upload Preview...");
          previewUrl = await supabaseManager.uploadStoreFile(previewFile, 'previews');
      } else if (importedPreviewUrl) {
          previewUrl = importedPreviewUrl; // Use Drive URL
      } else if (editingId) {
          const original = inventory.find(i => i.id === editingId);
          if (original) previewUrl = original.preview_url;
      }

      if (stemsFile) {
          setStatus("🗂️ Upload Stems...");
          stemsUrl = await supabaseManager.uploadStoreFile(stemsFile, 'stems');
      } else if (importedStemsUrl) {
          stemsUrl = importedStemsUrl; // Use Drive URL
      } else if (editingId) {
          const original = inventory.find(i => i.id === editingId);
          if (original) stemsUrl = original.stems_url || '';
      }

      // --- EDIT MODE LOGIC ---
      if (editingId) {
          setStatus("💾 Mise à jour base de données...");
          await supabaseManager.updateInstrument(editingId, {
              name, category, bpm, musical_key: musicalKey,
              image_url: coverUrl, preview_url: previewUrl, stems_url: stemsUrl || null,
              price_basic: priceBasic, price_premium: pricePremium, price_exclusive: priceExclusive
          });
          
          setStatus("✅ Modification réussie !");
          setEditingId(null);
      } 
      // --- CREATE MODE LOGIC ---
      else {
          setStatus("💾 Enregistrement dans la base...");
          await supabaseManager.addInstrument({
            name, category, bpm, musical_key: musicalKey,
            image_url: coverUrl, preview_url: previewUrl, stems_url: stemsUrl,
            price_basic: priceBasic, price_premium: pricePremium, price_exclusive: priceExclusive,
            is_visible: true 
          });
          setStatus("✅ Beat ajouté avec succès !");

          // IMPORTANT: Mark imported files as processed
          if (importSourceIds.length > 0) {
              await supabaseManager.markUploadAsProcessed(importSourceIds);
          }
      }

      // Reset Form
      resetForm();
      onSuccess(); 
      
    } catch (err: any) {
      console.error(err);
      setStatus(`❌ Erreur: ${err.message || 'Problème inconnu'}`);
    } finally {
      setLoading(false);
    }
  };

  // --- AUDIO PREVIEW ---
  const stopPreview = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    audioEngine.stopPreview();
    setPlayingId(null);
  };

  const togglePreview = async (inst: Instrument) => {
    if (playingId === inst.id) {
      stopPreview();
      return;
    }
    
    stopPreview();
    
    if (!inst.preview_url) {
      setStatus("❌ Pas d'URL de preview pour cet instrument");
      return;
    }
    
    const url = supabaseManager.getPublicInstrumentUrl(inst.preview_url);
    setPlayingId(inst.id);
    
    try {
      const audio = new Audio(url);
      audio.volume = 0.8;
      audio.crossOrigin = "anonymous";
      audioRef.current = audio;
      audio.onended = () => setPlayingId(null);
      audio.onerror = () => {
        setStatus("❌ Erreur de lecture audio");
        setPlayingId(null);
      };
      await audio.play();
    } catch (err) {
      console.error("Playback error:", err);
      setPlayingId(null);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => stopPreview();
  }, []);

  // --- INSTRUMENTALS MANAGEMENT (New Table) ---
  const toggleInstrumentalActive = async (id: string, current: boolean) => {
    try {
      await supabaseManager.updateInstrumentalActive(id, !current);
      await fetchInstrumentals();
      setStatus(`✅ Instrumental ${!current ? 'activé' : 'désactivé'}`);
    } catch (e) {
      console.error("Failed to toggle instrumental active:", e);
      setStatus("❌ Erreur lors de la mise à jour");
    }
  };

  // Start editing an instrumental
  const handleEditInstrumental = (inst: Instrumental) => {
    setEditingInstrumental(inst);
    setEditingId(null); // Clear old editing state
    // Pre-fill the form
    setName(inst.title);
    setCategory((inst.genre as any) || 'Trap');
    setBpm(inst.bpm || 140);
    setMusicalKey(inst.key || 'C Minor');
    setPriceBasic(inst.price_base || 100);
    setPricePremium(inst.price_exclusive || 500);
    setPriceExclusive(inst.price_stems || 500);
    setCoverPreviewUrl(inst.cover_image_url || null);
    setStatus(`✏️ Modification de: ${inst.title}`);
  };

  // Save instrumental modifications
  const handleSaveInstrumental = async () => {
    if (!editingInstrumental) return;
    
    setLoading(true);
    setStatus("💾 Sauvegarde en cours...");
    
    try {
      // Upload cover if changed
      let coverUrl = editingInstrumental.cover_image_url;
      if (coverFile) {
        setStatus("📸 Upload de la cover...");
        coverUrl = await supabaseManager.uploadStoreFile(coverFile, 'covers');
      }
      
      await supabaseManager.updateInstrumental(editingInstrumental.id, {
        title: name,
        genre: category,
        bpm: bpm,
        key: musicalKey,
        price_base: priceBasic,
        price_exclusive: pricePremium,
        price_stems: priceExclusive,
        cover_image_url: coverUrl,
      });
      
      setStatus("✅ Instrumental mis à jour !");
      setEditingInstrumental(null);
      resetForm();
      await fetchInstrumentals();
    } catch (err: any) {
      setStatus(`❌ Erreur: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Cancel editing instrumental
  const cancelEditInstrumental = () => {
    setEditingInstrumental(null);
    resetForm();
    setStatus("");
  };

  const playInstrumentalPreview = async (inst: Instrumental) => {
    if (playingId === inst.id) {
      stopPreview();
      return;
    }
    
    stopPreview();
    
    // Construire l'URL de streaming via l'Edge Function
    let url = '';
    if (inst.drive_file_id) {
      // Utiliser l'Edge Function proxy pour streamer depuis Google Drive
      url = supabaseManager.getDrivePreviewUrl(inst.drive_file_id);
    } else if (inst.preview_url) {
      url = supabaseManager.getPublicInstrumentUrl(inst.preview_url);
    }
    
    console.log("[AdminPanel] Playing instrumental:", inst.title, "URL:", url);
    
    if (!url) {
      setStatus("❌ Pas de fichier audio (drive_file_id manquant)");
      return;
    }
    
    setPlayingId(inst.id);
    setStatus(`▶️ Lecture: ${inst.title}`);
    
    try {
      const audio = new Audio(url);
      audio.volume = 0.8;
      audio.crossOrigin = "anonymous";
      audioRef.current = audio;
      audio.onended = () => {
        setPlayingId(null);
        setStatus("");
      };
      audio.onerror = (e) => {
        console.error("[AdminPanel] Audio error:", e);
        setStatus("❌ Erreur de lecture - vérifiez l'Edge Function stream-instrumental");
        setPlayingId(null);
      };
      await audio.play();
    } catch (err) {
      console.error("[AdminPanel] Playback error:", err);
      setStatus("❌ Impossible de lire l'audio");
      setPlayingId(null);
    }
  };

  // --- OLD INVENTORY MANAGEMENT ---
  const toggleVisibility = async (id: number | string, current: boolean) => {
      try {
          await supabaseManager.updateInstrumentVisibility(id, !current);
          onSuccess(); 
      } catch (e) {
          console.error("Failed to toggle visibility", e);
      }
  };

  const deleteInstrument = async (id: number | string) => {
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
      
      {/* MAIN CONTAINER (Glass Effect) */}
      <div className="w-full max-w-7xl h-[90vh] bg-[#14161a] border border-white/10 rounded-3xl flex flex-col overflow-hidden shadow-2xl relative">
        
        {/* HEADER */}
        <div className="h-16 border-b border-white/5 flex items-center justify-between px-8 bg-black/20">
            <div className="flex items-center space-x-3">
                <div className="w-8 h-8 bg-cyan-500 rounded-lg flex items-center justify-center text-black shadow-[0_0_15px_rgba(6,182,212,0.5)]">
                    <i className="fas fa-crown text-sm"></i>
                </div>
                <div>
                    <h2 className="text-sm font-black uppercase tracking-[0.2em] text-white">Admin Dashboard</h2>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Store Manager v2.1</p>
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
                    
                    {/* --- EDITING INSTRUMENTAL INFO --- */}
                    {editingInstrumental && (
                        <div className="mb-6 bg-purple-500/10 border border-purple-500/30 rounded-xl p-4">
                            <div className="flex items-center justify-between mb-3">
                                <span className="text-[10px] font-black uppercase text-purple-400 tracking-widest">
                                    <i className="fas fa-edit mr-2"></i>Modification de l'instrumental
                                </span>
                                <button 
                                    onClick={cancelEditInstrumental}
                                    className="text-[9px] bg-red-500/20 hover:bg-red-500 text-red-400 hover:text-white px-2 py-1 rounded transition-colors"
                                >
                                    <i className="fas fa-times mr-1"></i>Annuler
                                </button>
                            </div>
                            <div className="flex items-center space-x-3 bg-black/30 rounded-lg p-3">
                                <div className="w-12 h-12 bg-purple-600/30 rounded-lg flex items-center justify-center">
                                    {editingInstrumental.cover_image_url ? (
                                        <img src={editingInstrumental.cover_image_url} className="w-full h-full object-cover rounded-lg" />
                                    ) : (
                                        <i className="fas fa-music text-purple-400"></i>
                                    )}
                                </div>
                                <div className="flex-1">
                                    <div className="text-sm font-bold text-white">{editingInstrumental.title}</div>
                                    <div className="text-[9px] text-slate-500">
                                        {editingInstrumental.bpm} BPM • {editingInstrumental.key} • ID: {editingInstrumental.drive_file_id?.substring(0, 15)}...
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                    
                    {/* Message si aucun instrumental sélectionné */}
                    {!editingInstrumental && !editingId && (
                        <div className="mb-6 bg-slate-500/5 border border-slate-500/20 rounded-xl p-6 text-center">
                            <i className="fas fa-mouse-pointer text-3xl text-slate-500/30 mb-3"></i>
                            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                                Sélectionnez un instrumental à modifier
                            </p>
                            <p className="text-[9px] text-slate-600 mt-1">
                                Cliquez sur le bouton <span className="text-amber-400">✏️</span> à côté d'un instrumental
                            </p>
                        </div>
                    )}

                    <form onSubmit={(e) => { e.preventDefault(); editingInstrumental ? handleSaveInstrumental() : handleSubmit(e); }} className="space-y-6">
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
                            <label className="text-[9px] font-black text-slate-500 uppercase block">2. Fichiers & Cover {editingId && <span className="text-amber-500">(Optionnel si déjà présent)</span>}</label>
                            
                            {/* AI Cover Gen */}
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
                                        <input type="text" value={coverPrompt} onChange={(e) => setCoverPrompt(e.target.value)} placeholder="Prompt IA (ex: Neon city)" className="flex-1 bg-black/40 border border-white/10 rounded-lg px-2 text-[9px] text-white truncate" />
                                        <button 
                                            type="button" 
                                            onClick={() => handleGenerateCover()} 
                                            disabled={isGeneratingImg} 
                                            className="px-3 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs"
                                            title="Générer avec ce prompt"
                                        >
                                            <i className={`fas ${isGeneratingImg ? 'fa-spinner fa-spin' : 'fa-magic'}`}></i>
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Audio Inputs */}
                            <div className="space-y-2">
                                {/* PREVIEW MP3 */}
                                <div className={`flex items-center space-x-2 p-2 rounded-lg border ${importedPreviewUrl ? 'bg-blue-500/10 border-blue-500/30' : 'bg-black/20 border-white/5'}`}>
                                    <i className="fas fa-music text-green-400 text-xs"></i>
                                    <div className="flex-1 min-w-0">
                                        {importedPreviewUrl ? (
                                            <span className="text-[9px] font-mono text-blue-300">🔗 Fichier Drive Lié (MP3)</span>
                                        ) : (
                                            <input type="file" ref={previewInputRef} accept="audio/*" onChange={(e) => handleFileChange(e, 'preview')} className="text-[9px] text-slate-400 file:bg-white/10 file:text-white file:border-0 file:rounded-md file:px-2 file:py-0.5 file:mr-2 cursor-pointer w-full" />
                                        )}
                                        {editingId && !previewFile && !importedPreviewUrl && <p className="text-[8px] text-slate-500 pl-2 mt-1">Laissez vide pour garder l'actuel.</p>}
                                    </div>
                                    {importedPreviewUrl && <button type="button" onClick={() => setImportedPreviewUrl(null)} className="text-red-500 hover:text-white"><i className="fas fa-times text-[10px]"></i></button>}
                                </div>
                                
                                {/* STEMS ZIP */}
                                <div className={`flex items-center space-x-2 p-2 rounded-lg border ${importedStemsUrl ? 'bg-green-500/10 border-green-500/30' : 'bg-black/20 border-white/5'}`}>
                                    <div className="flex flex-col items-center justify-center w-4">
                                        <i className="fas fa-file-archive text-amber-400 text-xs"></i>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        {importedStemsUrl ? (
                                            <span className="text-[9px] font-mono text-green-300">🔗 Fichier Drive Lié (STEMS)</span>
                                        ) : (
                                            <input type="file" ref={stemsInputRef} accept=".zip,.rar" onChange={(e) => handleFileChange(e, 'stems')} className="text-[9px] text-slate-400 file:bg-white/10 file:text-white file:border-0 file:rounded-md file:px-2 file:py-0.5 file:mr-2 cursor-pointer w-full" />
                                        )}
                                        {editingId && !stemsFile && !importedStemsUrl && <p className="text-[8px] text-slate-500 pl-2 mt-1">Laissez vide pour garder les stems actuels (s'il y en a).</p>}
                                    </div>
                                    {importedStemsUrl ? (
                                        <button type="button" onClick={() => setImportedStemsUrl(null)} className="text-red-500 hover:text-white"><i className="fas fa-times text-[10px]"></i></button>
                                    ) : (
                                        <span className="text-[8px] text-slate-600 font-bold uppercase tracking-wider ml-auto">Optionnel</span>
                                    )}
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
                                disabled={loading || (!editingInstrumental && !editingId && !previewFile && !importedPreviewUrl)} 
                                className={`w-full h-12 rounded-xl text-[10px] font-black uppercase tracking-[0.2em] shadow-lg transition-all disabled:opacity-50 ${editingInstrumental ? 'bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-400 hover:to-pink-500 text-white shadow-purple-500/20' : editingId ? 'bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-black shadow-amber-500/20' : 'bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white shadow-cyan-500/20'}`}
                            >
                                {loading ? <i className="fas fa-spinner fa-spin"></i> : (editingInstrumental ? "💾 Sauvegarder les modifications" : editingId ? "Mettre à jour" : "Sélectionnez un instrumental →")}
                            </button>
                        </div>
                    </form>
                </div>
            </div>

            {/* RIGHT COLUMN: INSTRUMENTALS LIST (from Supabase instrumentals table) */}
            <div className="flex-1 flex flex-col bg-[#14161a]">
                <div className="p-6 border-b border-white/5 flex justify-between items-center">
                    <h3 className="text-xs font-black uppercase tracking-widest text-slate-300">
                        <i className="fab fa-google-drive mr-2 text-blue-400"></i>
                        Catalogue Instrumentals ({instrumentals.length})
                    </h3>
                    <div className="flex items-center space-x-3">
                        <span className="text-[9px] text-slate-500 font-mono">Table: instrumentals</span>
                        <button 
                            onClick={fetchInstrumentals}
                            className="text-cyan-400 hover:text-white transition-colors"
                            title="Rafraîchir"
                        >
                            <i className={`fas fa-sync-alt text-xs ${loadingInstrumentals ? 'fa-spin' : ''}`}></i>
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto custom-scroll">
                    {loadingInstrumentals ? (
                        <div className="flex items-center justify-center py-20">
                            <div className="w-8 h-8 border-4 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin"></div>
                        </div>
                    ) : instrumentals.length > 0 ? (
                        <div className="divide-y divide-white/5">
                            {instrumentals.map((inst) => (
                                <div 
                                    key={inst.id} 
                                    className={`p-4 hover:bg-white/[0.02] transition-colors flex items-center space-x-4 ${inst.is_active ? '' : 'opacity-60'}`}
                                >
                                    {/* Cover / Icon */}
                                    <div className="w-12 h-12 bg-gradient-to-br from-purple-600/30 to-blue-600/30 rounded-lg flex items-center justify-center border border-white/10 shrink-0">
                                        {inst.cover_image_url ? (
                                            <img src={inst.cover_image_url} alt="" className="w-full h-full object-cover rounded-lg" />
                                        ) : (
                                            <i className="fas fa-music text-purple-400"></i>
                                        )}
                                    </div>
                                    
                                    {/* Play Button */}
                                    <button
                                        onClick={() => playInstrumentalPreview(inst)}
                                        className={`w-10 h-10 rounded-full flex items-center justify-center transition-all shrink-0 ${playingId === inst.id ? 'bg-cyan-500 text-black animate-pulse' : 'bg-white/10 text-white hover:bg-cyan-500/50'}`}
                                        title={playingId === inst.id ? "Stop" : "Play"}
                                    >
                                        <i className={`fas ${playingId === inst.id ? 'fa-stop' : 'fa-play'} text-sm`}></i>
                                    </button>
                                    
                                    {/* Info */}
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-bold text-white truncate">{inst.title}</div>
                                        <div className="flex items-center space-x-2 mt-1">
                                            <span className="text-[10px] bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded">{inst.genre || 'Beat'}</span>
                                            <span className="text-[10px] text-slate-500">{inst.bpm} BPM</span>
                                            <span className="text-[10px] text-slate-500">{inst.key}</span>
                                        </div>
                                        {inst.drive_file_id && (
                                            <div className="text-[8px] text-slate-600 mt-1 truncate">
                                                <i className="fab fa-google-drive mr-1"></i>
                                                {inst.drive_file_id}
                                            </div>
                                        )}
                                    </div>
                                    
                                    {/* Prices */}
                                    <div className="text-right shrink-0">
                                        <div className="text-xs font-mono text-green-400">{inst.price_base}€</div>
                                        <div className="text-[9px] text-amber-400">{inst.price_exclusive}€ exclu</div>
                                    </div>
                                    
                                    {/* Stems indicator */}
                                    <div className="shrink-0 w-12 text-center">
                                        {inst.has_stems ? (
                                            <span className="text-[8px] bg-green-500/20 text-green-400 px-2 py-1 rounded">STEMS</span>
                                        ) : (
                                            <span className="text-[8px] text-slate-600">-</span>
                                        )}
                                    </div>
                                    
                                    {/* Active Toggle */}
                                    <button 
                                        onClick={() => toggleInstrumentalActive(inst.id, inst.is_active)}
                                        className={`w-12 h-6 rounded-full relative transition-colors duration-300 shrink-0 ${inst.is_active ? 'bg-green-500' : 'bg-slate-700'}`}
                                        title={inst.is_active ? "Actif (visible)" : "Inactif (masqué)"}
                                    >
                                        <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform duration-300 shadow ${inst.is_active ? 'translate-x-6' : 'translate-x-0'}`} />
                                    </button>
                                    
                                    {/* Edit Button */}
                                    <button
                                        onClick={() => handleEditInstrumental(inst)}
                                        className={`w-8 h-8 rounded-lg transition-all flex items-center justify-center shrink-0 ${editingInstrumental?.id === inst.id ? 'bg-amber-500 text-black' : 'bg-amber-500/10 hover:bg-amber-500 text-amber-400 hover:text-black'}`}
                                        title="Modifier cet instrumental"
                                    >
                                        <i className="fas fa-pen text-xs"></i>
                                    </button>
                                    
                                    {/* Open in Drive */}
                                    {inst.drive_file_id && (
                                        <a
                                            href={`https://drive.google.com/file/d/${inst.drive_file_id}/view`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="w-8 h-8 rounded-lg bg-blue-500/10 hover:bg-blue-500 text-blue-400 hover:text-white transition-all flex items-center justify-center shrink-0"
                                            title="Ouvrir dans Google Drive"
                                        >
                                            <i className="fab fa-google-drive text-xs"></i>
                                        </a>
                                    )}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="text-center py-20 opacity-40">
                            <i className="fab fa-google-drive text-4xl text-blue-500/30 mb-4"></i>
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Aucun instrumental dans la table.</p>
                            <p className="text-[9px] text-slate-600 mt-2">Les instrumentaux sont gérés depuis Supabase.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default AdminPanel;
