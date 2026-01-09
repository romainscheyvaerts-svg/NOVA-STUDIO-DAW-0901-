
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Instrument, User, PendingUpload } from '../types';
import { supabaseManager } from '../services/SupabaseManager';
import { generateCoverArt, generateCreativeMetadata } from '../services/AIService';

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
  
  // Inventory Management State
  const [inventory, setInventory] = useState<Instrument[]>(existingInstruments);

  // Pending Uploads State
  const [pendingUploads, setPendingUploads] = useState<{
    instru: PendingUpload;
    stems?: PendingUpload;
    identifier: string;
  }[]>([]);

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
  }, []);

  const fetchPendingUploads = async () => {
      const data = await supabaseManager.getPendingUploads();
      processPendingUploads(data);
  };

  // Logic to group Instrus and Stems based on numbers in filename
  const processPendingUploads = (uploads: PendingUpload[]) => {
      const groups: Record<string, { instru?: PendingUpload, stems?: PendingUpload }> = {};
      
      uploads.forEach(item => {
          // Extract first sequence of digits as identifier
          const match = item.filename.match(/(\d+)/);
          if (!match) return; // Skip files without numbers

          const identifier = match[1];
          const isPPP = item.filename.toLowerCase().includes('ppp');

          if (!groups[identifier]) groups[identifier] = {};

          if (isPPP) {
              groups[identifier].stems = item;
          } else {
              groups[identifier].instru = item;
          }
      });

      // Convert to array containing only groups with at least an instru
      const groupedList = Object.entries(groups)
          .filter(([_, grp]) => grp.instru)
          .map(([key, grp]) => ({
              instru: grp.instru!,
              stems: grp.stems,
              identifier: key
          }));
      
      setPendingUploads(groupedList);
  };

  // AUTO-GENERATION ON MOUNT (Only if adding new)
  const initialized = useRef(false);
  useEffect(() => {
      if (!initialized.current && !editingId) {
          initialized.current = true;
          // We don't auto-gen immediately if we might import from Drive, user can click "Auto-Gen" manually
          // handleRegenerateAll(); 
      }
  }, [editingId]);

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

  // --- IMPORT FROM DRIVE ACTION ---
  const handleImport = (group: { instru: PendingUpload, stems?: PendingUpload, identifier: string }) => {
      resetForm();
      
      // 1. Clean Name (Remove extensions and common prefixes/suffixes)
      let cleanName = group.instru.filename
          .replace(/\.(mp3|wav|zip|rar)$/i, '')
          .replace(/^\d+\s*[-_]?\s*/, '') // Remove leading numbers
          .replace(/[-_]/g, ' ')
          .trim();
      
      if (!cleanName) cleanName = `Beat #${group.identifier}`;

      setName(cleanName);
      setImportedPreviewUrl(group.instru.download_url);
      setImportSourceIds([group.instru.id]);
      
      if (group.stems) {
          setImportedStemsUrl(group.stems.download_url);
          setImportSourceIds(prev => [...prev, group.stems!.id]);
          // Auto-configure prices for full package
          setPriceBasic(10);
          setPricePremium(30);
          setPriceExclusive(150);
      } else {
          // Standard pricing if no stems
          setPriceBasic(29.99);
          setPricePremium(79.99);
          setPriceExclusive(299.99);
      }

      setStatus(`✅ Importé: ${cleanName}. Complétez les infos.`);
      
      // Trigger AI suggestions based on name
      handleRegenerateName(cleanName); 
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
              await fetchPendingUploads(); // Refresh list
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

  // --- INVENTORY MANAGEMENT ---
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
                    
                    {/* --- PENDING UPLOADS SECTION (DRIVE) --- */}
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
                                                    {group.stems ? '✅ STEMS' : '⚠️ MP3 ONLY'}
                                                </span>
                                            </div>
                                        </div>
                                        <button 
                                            onClick={() => handleImport(group)}
                                            className="px-3 py-1.5 bg-blue-500 hover:bg-blue-400 text-black text-[9px] font-black uppercase rounded shadow-lg transition-transform active:scale-95"
                                        >
                                            Importer
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
                                disabled={loading} 
                                className={`w-full h-12 rounded-xl text-[10px] font-black uppercase tracking-[0.2em] shadow-lg transition-all disabled:opacity-50 ${editingId ? 'bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-black shadow-amber-500/20' : 'bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white shadow-cyan-500/20'}`}
                            >
                                {loading ? <i className="fas fa-spinner fa-spin"></i> : (editingId ? "Mettre à jour" : "Mettre en ligne")}
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
                    <div className="text-[9px] text-slate-500 font-mono">Gérez la visibilité publique</div>
                </div>

                <div className="flex-1 overflow-y-auto custom-scroll p-6">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="border-b border-white/10 text-[9px] font-black uppercase text-slate-500 tracking-wider">
                                <th className="py-3 pl-2">Cover</th>
                                <th className="py-3">Nom</th>
                                <th className="py-3">Infos</th>
                                <th className="py-3">Prix (MP3)</th>
                                <th className="py-3 text-center">Stems</th>
                                <th className="py-3 text-center">Visible ?</th>
                                <th className="py-3 text-right pr-2">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {inventory.map((inst) => (
                                <tr key={inst.id} className={`hover:bg-white/[0.02] transition-colors ${editingId === inst.id ? 'bg-amber-500/5' : ''}`}>
                                    <td className="py-3 pl-2">
                                        <img src={inst.image_url} alt="cover" className="w-10 h-10 rounded-md object-cover border border-white/10" />
                                    </td>
                                    <td className="py-3">
                                        <div className="text-xs font-bold text-white">{inst.name}</div>
                                        <div className="text-[9px] text-slate-500">{inst.category}</div>
                                    </td>
                                    <td className="py-3">
                                        <span className="text-[9px] bg-white/5 px-2 py-1 rounded text-slate-400">{inst.bpm} BPM / {inst.musical_key}</span>
                                    </td>
                                    <td className="py-3">
                                        <span className="text-xs font-mono text-green-400">${inst.price_basic}</span>
                                    </td>
                                    <td className="py-3 text-center">
                                        {inst.stems_url ? (
                                            <i className="fas fa-check text-green-500 text-[10px]" title="Stems Available"></i>
                                        ) : (
                                            <i className="fas fa-times text-slate-600 text-[10px]" title="No Stems"></i>
                                        )}
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
                    
                    {inventory.length === 0 && (
                        <div className="text-center py-20 opacity-40">
                            <i className="fas fa-box-open text-4xl text-slate-600 mb-4"></i>
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Aucun produit en stock.</p>
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
