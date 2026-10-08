
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
    <div className="fixed inset-0 z-[9999] bg-black/70 flex justify-center items-center p-6 animate-in fade-in duration-300" role="dialog" aria-modal="true" aria-labelledby="admin-title">
      
      {/* Épure orbitale : surface du thème, sans verre ni lueur */}
      <div className="w-full max-w-7xl h-[90vh] bg-nv-surface border border-white/[0.06] rounded-3xl flex flex-col overflow-hidden shadow-2xl relative">
        
        {/* HEADER */}
        <div className="h-16 border-b border-white/[0.06] flex items-center justify-between px-6">
            <div className="flex items-center space-x-3">
                <div className="w-9 h-9 bg-white/[0.06] rounded-xl flex items-center justify-center text-amber-400">
                    <i className="fas fa-crown text-sm"></i>
                </div>
                <div>
                    <h2 id="admin-title" className="text-[15px] font-black text-white">Gestion du catalogue</h2>
                    <p className="text-[11px] text-slate-400">Beats du store Make Music · réservé à l'admin</p>
                </div>
            </div>
            <button aria-label="Fermer" title="Fermer" 
                onClick={onClose}
                className="nova-hit w-9 h-9 rounded-xl bg-white/[0.06] hover:bg-white/10 hover:text-white text-slate-300 flex items-center justify-center transition-all"
            >
                <i className="fas fa-times"></i>
            </button>
        </div>

        {/* CONTENT SPLIT VIEW */}
        <div className="flex-1 flex overflow-hidden">
            
            {/* LEFT COLUMN: FORM */}
            <div className="w-1/3 min-w-[380px] border-r border-white/[0.06] flex flex-col bg-nv-bg">
                <div className={`px-6 py-4 border-b border-white/[0.06] flex justify-between items-center ${editingId ? 'bg-amber-500/10' : ''}`}>
                    <h3 className={`text-[13px] font-black ${editingId ? 'text-amber-400' : 'text-white'}`}>
                        <i className={`fas ${editingId ? 'fa-edit' : 'fa-plus-circle'} mr-2`}></i>
                        {editingId ? 'Modifier le beat' : 'Ajouter un beat'}
                    </h3>
                    
                    {editingId ? (
                        <button 
                            onClick={resetForm}
                            className="h-9 px-3 rounded-lg bg-white/[0.06] hover:bg-white/10 text-[12px] font-bold text-slate-300 transition-colors"
                        >
                            <i className="fas fa-times mr-1"></i> Annuler
                        </button>
                    ) : (
                        <button 
                            onClick={() => handleRegenerateAll()}
                            disabled={isGeneratingMeta || isGeneratingImg}
                            className="h-9 px-3 rounded-lg bg-white/[0.06] hover:bg-white/10 text-[12px] font-bold text-slate-300 transition-colors disabled:opacity-40"
                            title="Proposer un nom et une pochette (IA)"
                        >
                            <i className={`fas fa-wand-magic-sparkles mr-1 text-violet-400 ${isGeneratingMeta ? 'fa-spin' : ''}`}></i> Nom + pochette IA
                        </button>
                    )}
                </div>
                
                <div className="flex-1 overflow-y-auto p-6 custom-scroll">
                    
                    {/* --- EDITING INSTRUMENTAL INFO --- */}
                    {editingInstrumental && (
                        <div className="mb-6 rounded-2xl bg-cyan-500/[0.07] ring-1 ring-cyan-400/30 p-4">
                            <div className="flex items-center justify-between mb-3">
                                <span className="text-[12px] font-black text-cyan-300">
                                    <i className="fas fa-edit mr-2"></i>Modification de l'instrumental
                                </span>
                                <button 
                                    onClick={cancelEditInstrumental}
                                    className="h-8 px-3 rounded-lg bg-white/[0.06] hover:bg-white/10 text-[12px] font-bold text-slate-300 transition-colors"
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
                        <div className="mb-6 rounded-2xl border border-dashed border-white/15 p-5 text-center">
                            <i className="fas fa-arrow-pointer text-2xl text-slate-400 mb-2"></i>
                            <p className="text-[13px] text-white font-bold">
                                Choisis un beat à modifier dans la liste
                            </p>
                            <p className="text-[12px] text-slate-400 mt-1">
                                Bouton <i className="fas fa-pen text-amber-400" aria-hidden /> sur sa ligne : ses infos, sa pochette et ses prix s'affichent ici.
                            </p>
                        </div>
                    )}

                    <form onSubmit={(e) => { e.preventDefault(); editingInstrumental ? handleSaveInstrumental() : handleSubmit(e); }} className="space-y-6">
                        {/* METADATA */}
                        <div className="space-y-3 rounded-2xl bg-white/[0.03] p-4">
                            <label className="text-[11px] font-bold text-slate-400 block">1. Informations</label>
                            
                            <div className="relative">
                                <input 
                                    type="text" 
                                    value={name} 
                                    onChange={(e) => setName(e.target.value)} 
                                    className="w-full bg-nv-bg border border-white/10 rounded-lg text-[13px] text-white focus:border-cyan-500 outline-none pl-3 pr-10 py-2" aria-label="Nom du beat"
                                    placeholder="Nom du beat (ex. : NIGHT RIDER)" 
                                />
                                <button 
                                    type="button"
                                    onClick={() => handleRegenerateName()}
                                    disabled={isGeneratingMeta}
                                    className="nova-hit absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-cyan-400"
                                    title="Proposer un autre nom (IA)" aria-label="Proposer un autre nom"
                                >
                                    <i className={`fas fa-dice ${isGeneratingMeta ? 'fa-spin' : ''}`}></i>
                                </button>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-3">
                                <select value={category} onChange={(e) => setCategory(e.target.value as any)} aria-label="Style" className="bg-nv-bg border border-white/10 rounded-lg text-[13px] text-white focus:border-cyan-500 outline-none px-3 py-2">
                                    {['Trap', 'Drill', 'Boombap', 'Afro', 'RnB', 'Pop', 'Electro'].map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                                <div className="flex space-x-2">
                                    <input type="number" value={bpm} onChange={(e) => setBpm(Number(e.target.value))} aria-label="Tempo (BPM)" className="w-1/2 bg-nv-bg border border-white/10 rounded-lg text-[13px] text-white focus:border-cyan-500 outline-none px-3 py-2 text-center" placeholder="BPM" />
                                    <input type="text" value={musicalKey} onChange={(e) => setMusicalKey(e.target.value)} aria-label="Tonalité" className="w-1/2 bg-nv-bg border border-white/10 rounded-lg text-[13px] text-white focus:border-cyan-500 outline-none px-3 py-2 text-center" placeholder="Tonalité" />
                                </div>
                            </div>
                        </div>

                        {/* FILES */}
                        <div className="space-y-3 rounded-2xl bg-white/[0.03] p-4">
                            <label className="text-[11px] font-bold text-slate-400 block">2. Fichiers et pochette {editingId && <span className="font-normal text-amber-400">(facultatif s'ils existent déjà)</span>}</label>
                            
                            {/* AI Cover Gen */}
                            <div className="flex space-x-3">
                                <div className="w-20 h-20 bg-white/[0.06] rounded-xl flex items-center justify-center overflow-hidden shrink-0 relative group">
                                    {coverPreviewUrl ? (
                                        <img src={coverPreviewUrl} className="w-full h-full object-cover" alt="Preview" />
                                    ) : (
                                        <i className={`fas ${isGeneratingImg ? 'fa-spinner fa-spin' : 'fa-image'} text-slate-400`}></i>
                                    )}
                                    <button 
                                        type="button" 
                                        onClick={() => handleGenerateCover()} 
                                        className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center text-cyan-400 transition-opacity"
                                        title="Nouvelle pochette (IA)" aria-label="Nouvelle pochette"
                                    >
                                        <i className="fas fa-sync-alt"></i>
                                    </button>
                                </div>
                                <div className="flex-1 space-y-2">
                                    <input type="file" ref={coverInputRef} accept="image/*" onChange={(e) => handleFileChange(e, 'cover')} className="hidden" id="cover-upload" />
                                    <label htmlFor="cover-upload" className="block w-full py-2 bg-white/[0.06] hover:bg-white/10 text-center rounded-lg text-[12px] font-bold text-slate-200 cursor-pointer transition-all truncate px-2">
                                        {coverFile ? `✓ ${coverFile.name}` : "Choisir une image"}
                                    </label>
                                    
                                    <div className="flex space-x-2">
                                        <input type="text" value={coverPrompt} onChange={(e) => setCoverPrompt(e.target.value)} placeholder="Idée de pochette pour l'IA (ex. : ville néon)" aria-label="Idée de pochette pour l'IA" className="flex-1 min-w-0 bg-nv-bg border border-white/10 rounded-lg text-[13px] text-white focus:border-cyan-500 outline-none px-2 py-2 text-[12px] truncate" />
                                        <button 
                                            type="button" 
                                            onClick={() => handleGenerateCover()} 
                                            disabled={isGeneratingImg} 
                                            className="px-3 bg-violet-600 hover:bg-violet-700 text-white rounded-lg text-xs disabled:opacity-40"
                                            title="Créer la pochette avec cette idée" aria-label="Créer la pochette"
                                        >
                                            <i className={`fas ${isGeneratingImg ? 'fa-spinner fa-spin' : 'fa-magic'}`}></i>
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Audio Inputs */}
                            <div className="space-y-2">
                                {/* PREVIEW MP3 */}
                                <div className={`flex items-center space-x-2 p-2 rounded-lg ${importedPreviewUrl ? 'bg-cyan-500/10' : 'bg-white/[0.04]'}`}>
                                    <i className="fas fa-music text-cyan-400 text-xs"></i>
                                    <div className="flex-1 min-w-0">
                                        {importedPreviewUrl ? (
                                            <span className="text-[12px] text-cyan-300">🔗 Extrait lié depuis le Drive (MP3)</span>
                                        ) : (
                                            <label className="flex items-center gap-2 cursor-pointer">
                                                <input type="file" ref={previewInputRef} accept="audio/*" onChange={(e) => handleFileChange(e, 'preview')} className="sr-only" />
                                                <span className="shrink-0 h-8 px-3 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] text-[12px] font-bold text-slate-200 leading-8">Choisir l'extrait</span>
                                                <span className="min-w-0 truncate text-[12px] text-slate-400">{previewFile ? previewFile.name : 'MP3 ou WAV, joué dans le catalogue'}</span>
                                            </label>
                                        )}
                                        {editingId && !previewFile && !importedPreviewUrl && <p className="text-[11px] text-slate-400 mt-1">Laisse vide pour garder l'extrait actuel.</p>}
                                    </div>
                                    {importedPreviewUrl && <button aria-label="Retirer l'extrait" title="Retirer l'extrait" type="button" onClick={() => setImportedPreviewUrl(null)} className="text-red-500 hover:text-white"><i className="fas fa-times text-[10px]"></i></button>}
                                </div>
                                
                                {/* STEMS ZIP */}
                                <div className={`flex items-center space-x-2 p-2 rounded-lg ${importedStemsUrl ? 'bg-emerald-500/10' : 'bg-white/[0.04]'}`}>
                                    <div className="flex flex-col items-center justify-center w-4">
                                        <i className="fas fa-file-archive text-amber-400 text-xs"></i>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        {importedStemsUrl ? (
                                            <span className="text-[12px] text-emerald-300">🔗 Pistes séparées liées depuis le Drive</span>
                                        ) : (
                                            <label className="flex items-center gap-2 cursor-pointer">
                                                <input type="file" ref={stemsInputRef} accept=".zip,.rar" onChange={(e) => handleFileChange(e, 'stems')} className="sr-only" />
                                                <span className="shrink-0 h-8 px-3 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] text-[12px] font-bold text-slate-200 leading-8">Choisir les pistes</span>
                                                <span className="min-w-0 truncate text-[12px] text-slate-400">{stemsFile ? stemsFile.name : 'Pistes séparées (.zip)'}</span>
                                            </label>
                                        )}
                                        {editingId && !stemsFile && !importedStemsUrl && <p className="text-[11px] text-slate-400 mt-1">Laisse vide pour garder les pistes séparées actuelles (s'il y en a).</p>}
                                    </div>
                                    {importedStemsUrl ? (
                                        <button aria-label="Retirer les pistes séparées" title="Retirer les pistes séparées" type="button" onClick={() => setImportedStemsUrl(null)} className="text-red-500 hover:text-white"><i className="fas fa-times text-[10px]"></i></button>
                                    ) : (
                                        <span className="text-[11px] text-slate-400 ml-auto">facultatif</span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* PRICES */}
                        <div className="space-y-3 rounded-2xl bg-white/[0.03] p-4">
                            <label className="text-[11px] font-bold text-slate-400 block">3. Prix des licences (€)</label>
                            <div className="grid grid-cols-3 gap-2">
                                <div><label className="text-[11px] text-slate-400 block mb-1">MP3</label><input type="number" step="0.01" value={priceBasic} onChange={(e) => setPriceBasic(Number(e.target.value))} className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-xs text-white" /></div>
                                <div><label className="text-[11px] text-slate-400 block mb-1">WAV</label><input type="number" step="0.01" value={pricePremium} onChange={(e) => setPricePremium(Number(e.target.value))} className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-xs text-white" /></div>
                                <div><label className="text-[11px] text-slate-400 block mb-1">Pistes séparées</label><input type="number" step="0.01" value={priceExclusive} onChange={(e) => setPriceExclusive(Number(e.target.value))} className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-xs text-white" /></div>
                            </div>
                        </div>

                        <div className="pt-2">
                            <span className="block text-[12px] text-center text-slate-300 mb-2" role="status">{status}</span>
                            <button 
                                type="submit" 
                                disabled={loading || (!editingInstrumental && !editingId && !previewFile && !importedPreviewUrl)} 
                                className={`w-full h-12 rounded-xl text-[13px] font-black transition-all disabled:opacity-40 ${editingId && !editingInstrumental ? 'bg-amber-400 hover:bg-amber-300 text-black' : 'bg-cyan-500 hover:bg-cyan-400 text-black'}`}
                            >
                                {loading ? <i className="fas fa-spinner fa-spin"></i> : (editingInstrumental ? "💾 Sauvegarder les modifications" : editingId ? "Mettre à jour" : "Choisis un beat dans la liste →")}
                            </button>
                        </div>
                    </form>
                </div>
            </div>

            {/* RIGHT COLUMN: INSTRUMENTALS LIST (from Supabase instrumentals table) */}
            <div className="flex-1 min-w-0 flex flex-col bg-nv-surface">
                <div className="px-6 py-4 border-b border-white/[0.06] flex justify-between items-center">
                    <h3 className="text-[13px] font-black text-white">
                        <i className="fab fa-google-drive mr-2 text-blue-400"></i>
                        Beats du catalogue ({instrumentals.length})
                    </h3>
                    <div className="flex items-center space-x-3">
                        <span className="text-[11px] text-slate-400">Base Supabase · table « instrumentals »</span>
                        <button 
                            onClick={fetchInstrumentals}
                            className="nova-hit w-9 h-9 rounded-lg bg-white/[0.06] text-cyan-400 hover:text-white transition-colors"
                            title="Recharger la liste" aria-label="Recharger la liste"
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
                        <div className="divide-y divide-white/[0.06]">
                            {instrumentals.map((inst) => (
                                <div 
                                    key={inst.id} 
                                    className={`px-6 py-3 hover:bg-white/[0.03] transition-colors flex items-center space-x-4 ${inst.is_active ? '' : 'opacity-60'}`}
                                >
                                    {/* Cover / Icon */}
                                    <div className="w-12 h-12 bg-white/[0.06] rounded-lg flex items-center justify-center shrink-0">
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
                                            <span className="text-[11px] bg-white/[0.06] text-slate-300 px-2 py-0.5 rounded">{inst.genre || 'Beat'}</span>
                                            <span className="text-[11px] text-slate-400">{inst.bpm ? `${inst.bpm} BPM` : 'BPM à renseigner'}</span>
                                            {inst.key && <span className="text-[11px] text-slate-400">{inst.key}</span>}
                                        </div>
                                        {inst.drive_file_id && (
                                            <div className="text-[10px] text-slate-500 mt-1 truncate">
                                                <i className="fab fa-google-drive mr-1"></i>
                                                {inst.drive_file_id}
                                            </div>
                                        )}
                                    </div>
                                    
                                    {/* Prices */}
                                    <div className="text-right shrink-0">
                                        <div className="text-[12px] font-mono text-emerald-400">{inst.price_base} €</div>
                                        <div className="text-[11px] text-amber-400">{inst.price_exclusive} € exclu</div>
                                    </div>
                                    
                                    {/* Stems indicator */}
                                    <div className="shrink-0 w-12 text-center">
                                        {inst.has_stems ? (
                                            <span className="text-[10px] bg-emerald-500/15 text-emerald-300 px-2 py-1 rounded" title="Pistes séparées disponibles">Pistes</span>
                                        ) : (
                                            <span className="text-[11px] text-slate-500" title="Pas de pistes séparées">—</span>
                                        )}
                                    </div>
                                    
                                    {/* Active Toggle */}
                                    <button 
                                        onClick={() => toggleInstrumentalActive(inst.id, inst.is_active)}
                                        role="switch" aria-checked={!!inst.is_active} aria-label={`Visible dans le store : ${inst.title}`}
                                        className={`nova-hit w-12 h-6 rounded-full relative transition-colors duration-300 shrink-0 ${inst.is_active ? 'bg-emerald-500' : 'bg-white/15'}`}
                                        title={inst.is_active ? "Visible dans le store (clic : masquer)" : "Masqué du store (clic : afficher)"}
                                    >
                                        <div className={`absolute top-1 left-1 w-4 h-4 bg-white [[data-theme=light]_&]:bg-nv-surface rounded-full transition-transform duration-300 shadow ${inst.is_active ? 'translate-x-6' : 'translate-x-0'}`} />
                                    </button>
                                    
                                    {/* Edit Button */}
                                    <button
                                        onClick={() => handleEditInstrumental(inst)}
                                        className={`nova-hit w-9 h-9 rounded-lg transition-all flex items-center justify-center shrink-0 ${editingInstrumental?.id === inst.id ? 'bg-amber-400 text-black' : 'bg-white/[0.06] hover:bg-white/10 text-amber-400'}`}
                                        title="Modifier ce beat" aria-label={`Modifier ${inst.title}`}
                                    >
                                        <i className="fas fa-pen text-xs"></i>
                                    </button>
                                    
                                    {/* Open in Drive */}
                                    {inst.drive_file_id && (
                                        <a
                                            href={`https://drive.google.com/file/d/${inst.drive_file_id}/view`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="nova-hit w-9 h-9 rounded-lg bg-white/[0.06] hover:bg-white/10 text-blue-400 transition-all flex items-center justify-center shrink-0"
                                            title="Ouvrir dans Google Drive" aria-label={`Ouvrir ${inst.title} dans Google Drive`}
                                        >
                                            <i className="fab fa-google-drive text-xs"></i>
                                        </a>
                                    )}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="text-center py-20 px-6">
                            <i className="fab fa-google-drive text-4xl text-slate-500 mb-4"></i>
                            <p className="text-[14px] font-bold text-white">Aucun beat dans le catalogue</p>
                            <p className="text-[12px] text-slate-400 mt-2">Ajoute ton premier beat avec le formulaire à gauche, ou vérifie ta connexion puis « Recharger la liste ».</p>
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
