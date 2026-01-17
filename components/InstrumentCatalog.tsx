
import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Instrumental, User } from '../types';
import { supabaseManager } from '../services/SupabaseManager';
import { stripeManager } from '../services/StripeManager';
import AdminPanel from './AdminPanel';
import { audioEngine } from '../engine/AudioEngine';

interface InstrumentCatalogProps {
  user: User | null;
  onPurchase?: (instrumentId: number) => void;
}

type AudioMode = 'STANDARD' | 'STUDIO';

const InstrumentCatalog: React.FC<InstrumentCatalogProps> = ({ user, onPurchase }) => {
  const [allInstrumentals, setAllInstrumentals] = useState<Instrumental[]>([]);
  const [displayedInstrumentals, setDisplayedInstrumentals] = useState<Instrumental[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [processingPayment, setProcessingPayment] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  
  // Audio Player State
  const [playingId, setPlayingId] = useState<string | null>(null);
  
  // Mode Standard (HTML5)
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playPromiseRef = useRef<Promise<void> | null>(null);
  
  // Mode Studio (WebAudio)
  const [audioMode, setAudioMode] = useState<AudioMode>('STANDARD');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  // Modal State
  const [selectedBeat, setSelectedBeat] = useState<Instrumental | null>(null);

  const isAdmin = user?.email.toLowerCase() === 'romain.scheyvaerts@gmail.com';

  useEffect(() => {
    if (window.innerWidth < 768) {
        setAudioMode('STANDARD');
    } else {
        setAudioMode('STUDIO');
    }
  }, []);

  const fetchInstrumentals = async () => {
    setLoading(true);
    try {
      // Récupère uniquement les instrumentaux actifs (is_active = true)
      const data = await supabaseManager.getActiveInstrumentals();
      console.log("[InstrumentCatalog] Données actives reçues:", data.length, "instruments");
      setAllInstrumentals(data);
      setDisplayedInstrumentals(data);
    } catch (error: any) {
      console.error("Failed to load catalog", error.message || error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInstrumentals();
    return () => {
        stopAllPlayback();
        if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, []);

  useEffect(() => {
    stopAllPlayback();
  }, [audioMode]);

  const stopAllPlayback = () => {
    if (audioRef.current) {
        const audio = audioRef.current;
        if (playPromiseRef.current) {
            playPromiseRef.current.then(() => {
                audio.pause();
                audio.currentTime = 0;
            }).catch(e => {
                // Ignore AbortError here as it means we interrupted correctly
            });
        } else {
            audio.pause();
            audio.currentTime = 0;
        }
        audioRef.current = null;
    }
    audioEngine.stopPreview();
    setPlayingId(null);
  };

  const togglePlay = async (beat: Instrumental, e: React.MouseEvent) => {
    e.stopPropagation();
    
    if (playingId === beat.id) {
        stopAllPlayback();
        return;
    }

    // Stop previous track
    stopAllPlayback();
    
    // Construire l'URL de preview à partir de drive_file_id ou preview_url
    let url = '';
    if (beat.preview_url) {
        url = supabaseManager.getPublicInstrumentUrl(beat.preview_url);
    } else if (beat.drive_file_id) {
        url = supabaseManager.getDrivePreviewUrl(beat.drive_file_id);
    }

    if (!url) {
        console.warn("No preview URL for beat:", beat.title);
        return;
    }

    setPlayingId(beat.id);

    if (audioMode === 'STANDARD') {
        const audio = new Audio(url);
        audio.volume = 0.8;
        audio.crossOrigin = "anonymous"; 
        audioRef.current = audio;
        audio.onended = () => setPlayingId(null);
        
        try {
            const promise = audio.play();
            playPromiseRef.current = promise;
            await promise;
        } catch (err: any) {
            if (err.name === 'AbortError') return;
            console.error("Standard Playback Error:", err);
            setPlayingId(null);
        }
    } else {
        try {
            await audioEngine.playHighResPreview(url, () => setPlayingId(null));
            startVisualizer();
        } catch (err) {
            console.error("Studio Mode failed, falling back to Standard", err);
            
            setAudioMode('STANDARD');
            
            const audio = new Audio(url);
            audioRef.current = audio;
            audio.onended = () => setPlayingId(null);
            
            try {
                const promise = audio.play();
                playPromiseRef.current = promise;
                await promise;
            } catch (innerErr: any) {
                if (innerErr.name !== 'AbortError') {
                    console.error("Fallback Playback Error:", innerErr);
                    setPlayingId(null);
                }
            }
        }
    }
  };

  const startVisualizer = () => {
      const canvas = canvasRef.current;
      const analyzer = audioEngine.getPreviewAnalyzer();
      if (!canvas || !analyzer) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const bufferLength = analyzer.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const draw = () => {
          if (!audioEngine.getPreviewAnalyzer()) {
             cancelAnimationFrame(animationRef.current);
             return;
          }

          animationRef.current = requestAnimationFrame(draw);
          analyzer.getByteTimeDomainData(dataArray);

          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#00f2ff';
          ctx.beginPath();

          const sliceWidth = canvas.width * 1.0 / bufferLength;
          let x = 0;

          for (let i = 0; i < bufferLength; i++) {
              const v = dataArray[i] / 128.0;
              const y = v * canvas.height / 2;

              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);

              x += sliceWidth;
          }

          ctx.lineTo(canvas.width, canvas.height / 2);
          ctx.stroke();
      };

      draw();
  };

  const handleDragStart = (e: React.DragEvent, inst: Instrumental) => {
      // Construire l'URL pour le drag & drop
      let audioUrl = '';
      if (inst.preview_url) {
          audioUrl = supabaseManager.getPublicInstrumentUrl(inst.preview_url);
      } else if (inst.drive_file_id) {
          audioUrl = supabaseManager.getDrivePreviewUrl(inst.drive_file_id);
      }
      
      console.log('[DragStart] Instrumental:', inst.title);
      console.log('[DragStart] preview_url:', inst.preview_url);
      console.log('[DragStart] drive_file_id:', inst.drive_file_id);
      console.log('[DragStart] audioUrl résultant:', audioUrl);
      
      if (!audioUrl) {
          console.warn('[DragStart] ATTENTION: Pas d\'URL audio pour cet instrumental!');
      }
      
      e.dataTransfer.setData('audio-url', audioUrl); 
      e.dataTransfer.setData('audio-name', inst.title);
      e.dataTransfer.setData('instrument-id', inst.id);
      e.dataTransfer.setData('audio-bpm', (inst.bpm || 120).toString());
      e.dataTransfer.setData('audio-key', inst.key || 'C Minor');
      e.dataTransfer.effectAllowed = 'copy';
      
      const dragIcon = document.createElement('div');
      dragIcon.style.width = '120px';
      dragIcon.style.height = '40px';
      dragIcon.style.backgroundColor = '#00f2ff';
      dragIcon.style.borderRadius = '8px';
      dragIcon.style.color = '#000';
      dragIcon.style.display = 'flex';
      dragIcon.style.alignItems = 'center';
      dragIcon.style.justifyContent = 'center';
      dragIcon.style.fontWeight = 'bold';
      dragIcon.style.fontSize = '10px';
      dragIcon.textContent = inst.title;
      dragIcon.style.position = 'absolute';
      dragIcon.style.top = '-1000px';
      document.body.appendChild(dragIcon);
      e.dataTransfer.setDragImage(dragIcon, 0, 0);
      setTimeout(() => document.body.removeChild(dragIcon), 0);
  };

  const hasLicense = (instId: string) => {
      // Pour les licences, on vérifie si l'ID existe dans owned_instruments
      // Note: owned_instruments contient des numbers, il faudra peut-être adapter
      return false; // À adapter selon votre système de licences
  };

  const handleStripeBuy = async () => {
      if (!user || !selectedBeat) return;
      
      // Rediriger vers le site de vente
      window.open('https://studiomakemusic.com/instrumentals', '_blank');
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
      if (!processingPayment) {
          setSelectedBeat(null);
      }
  };

  // Récupérer l'image de couverture ou une image par défaut
  const getCoverImage = (inst: Instrumental): string => {
      return inst.cover_image_url || 'https://via.placeholder.com/150?text=No+Cover';
  };

  return (
    <div className="h-full flex flex-col bg-[#08090b] relative">
      
      {showAdminModal && user && (
        <AdminPanel 
            user={user} 
            existingInstruments={[]} 
            onSuccess={fetchInstrumentals} 
            onClose={() => setShowAdminModal(false)}
        />
      )}

      {/* Header Compact */}
      <div className="p-4 border-b border-white/5 bg-[#08090b] sticky top-0 z-20 space-y-3">
        <div className="flex justify-between items-center">
          <div>
             <h2 className="text-xs font-black uppercase tracking-widest text-white">Beat <span className="text-cyan-500">Store</span></h2>
             <p className="text-[8px] text-slate-500 font-mono">Drag & Drop to Try</p>
          </div>
          
          {isAdmin && (
            <button onClick={() => setShowAdminModal(true)} className="text-slate-500 hover:text-white">
              <i className="fas fa-cog"></i>
            </button>
          )}
        </div>
      </div>

      {/* WAVEFORM VISUALIZER (STUDIO MODE ONLY) */}
      {audioMode === 'STUDIO' && playingId && (
         <div className="h-12 bg-black/20 border-b border-white/5 relative overflow-hidden">
             <canvas ref={canvasRef} width={300} height={48} className="w-full h-full opacity-60" />
             <div className="absolute top-1 right-2 text-[7px] font-mono text-cyan-500/50">32-BIT FLOAT STREAM</div>
         </div>
      )}

      {/* List View Compact */}
      <div className="flex-1 overflow-y-auto custom-scroll">
        {loading ? (
          <div className="flex justify-center items-center py-10">
             <div className="w-4 h-4 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin"></div>
          </div>
        ) : (
          <div className="flex flex-col">
            {displayedInstrumentals.map((inst) => (
              <div 
                key={inst.id} 
                draggable
                onDragStart={(e) => handleDragStart(e, inst)}
                className={`group flex items-center p-3 border-b border-white/5 hover:bg-white/[0.03] transition-colors cursor-grab active:cursor-grabbing relative ${playingId === inst.id ? 'bg-white/[0.05]' : ''}`}
              >
                {/* Cover & Play */}
                <div className="relative w-10 h-10 shrink-0 mr-3">
                    <img src={getCoverImage(inst)} alt={inst.title} className="w-full h-full object-cover rounded-md opacity-80 group-hover:opacity-100" />
                    <button 
                        onClick={(e) => togglePlay(inst, e)}
                        className={`absolute inset-0 flex items-center justify-center bg-black/40 hover:bg-black/60 transition-all ${playingId === inst.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    >
                        {playingId === inst.id ? (
                            <i className="fas fa-pause text-cyan-400 text-[10px]"></i>
                        ) : (
                            <i className="fas fa-play text-white text-[10px]"></i>
                        )}
                    </button>
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0 pr-2">
                    <div className="flex items-center space-x-2">
                        <h3 className={`text-[10px] font-bold truncate ${playingId === inst.id ? 'text-cyan-400' : 'text-white'}`}>{inst.title}</h3>
                        {hasLicense(inst.id) && <i className="fas fa-check-circle text-[8px] text-green-500" title="Purchased"></i>}
                    </div>
                    <div className="flex items-center text-[8px] text-slate-500 space-x-2">
                        <span>{inst.bpm || '?'} BPM</span>
                        <span>•</span>
                        <span className="truncate">{inst.genre || 'Beat'}</span>
                        {inst.key && (
                            <>
                                <span>•</span>
                                <span className="truncate">{inst.key}</span>
                            </>
                        )}
                    </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col items-end space-y-1">
                    <span className="text-[9px] font-mono text-cyan-400">{inst.price_base ? `${inst.price_base}€` : 'N/A'}</span>
                    <button 
                        onClick={() => setSelectedBeat(inst)}
                        className="w-5 h-5 rounded bg-white/5 hover:bg-cyan-500 hover:text-black flex items-center justify-center transition-colors"
                        title="Buy License"
                    >
                        <i className="fas fa-shopping-cart text-[8px]"></i>
                    </button>
                </div>
              </div>
            ))}
            
            {displayedInstrumentals.length === 0 && (
                <div className="text-center py-10 text-[9px] text-slate-600">
                    <i className="fas fa-music text-3xl text-slate-700 mb-3"></i>
                    <p>Aucun beat disponible.</p>
                    <p className="text-[8px] text-slate-700 mt-1">Revenez bientôt !</p>
                </div>
            )}
          </div>
        )}
      </div>

      {/* LICENSE MODAL (Fixed Overlay) */}
      {selectedBeat && (
        createPortal(
            <div 
                className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-md flex items-center justify-center p-6 animate-in fade-in duration-200"
                onClick={handleBackdropClick}
            >
                <div 
                    className="bg-[#14161a] border border-white/10 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col md:flex-row relative"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* BOUTON FERMETURE AVEC Z-INDEX ÉLEVÉ */}
                    <button 
                        onClick={() => { if(!processingPayment) setSelectedBeat(null); }} 
                        className="absolute top-4 right-4 z-50 w-8 h-8 flex items-center justify-center bg-black/50 rounded-full text-slate-400 hover:text-white hover:bg-red-500/80 transition-all"
                    >
                        <i className="fas fa-times"></i>
                    </button>
                    
                    <div className="w-full md:w-1/3 bg-[#0c0d10] p-6 flex flex-col items-center justify-center text-center">
                        <img src={getCoverImage(selectedBeat)} className="w-32 h-32 rounded-lg shadow-lg mb-4" />
                        <h2 className="text-lg font-black text-white uppercase">{selectedBeat.title}</h2>
                        <p className="text-[10px] text-slate-500 mb-4">{selectedBeat.bpm || '?'} BPM • {selectedBeat.key || 'N/A'}</p>
                    </div>

                    <div className="w-full md:w-2/3 p-6 relative">
                        {processingPayment && (
                            <div className="absolute inset-0 bg-[#14161a]/90 z-20 flex flex-col items-center justify-center space-y-4">
                                <div className="w-8 h-8 border-4 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin"></div>
                                <p className="text-xs font-black text-cyan-400 uppercase tracking-widest">Redirection...</p>
                            </div>
                        )}

                        <h3 className="text-xs font-black text-white uppercase mb-4">Sélectionner une Licence</h3>
                        
                        {paymentError && (
                            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center text-red-400 text-[10px]">
                                <i className="fas fa-exclamation-circle mr-2"></i>
                                {paymentError}
                            </div>
                        )}

                        <div className="space-y-2">
                            {selectedBeat.price_base && (
                                <LicenseOption 
                                    name="Licence MP3" 
                                    price={selectedBeat.price_base} 
                                    feat="MP3 • Tagged" 
                                    onBuy={handleStripeBuy} 
                                    disabled={processingPayment} 
                                />
                            )}
                            {selectedBeat.price_exclusive && (
                                <LicenseOption 
                                    name="Licence WAV" 
                                    price={selectedBeat.price_exclusive} 
                                    feat="WAV • Untagged • Full Rights" 
                                    onBuy={handleStripeBuy} 
                                    disabled={processingPayment} 
                                />
                            )}
                            {selectedBeat.has_stems && selectedBeat.price_stems && (
                                <LicenseOption 
                                    name="Licence STEMS" 
                                    price={selectedBeat.price_stems} 
                                    feat="STEMS • WAV • Full Production Rights" 
                                    onBuy={handleStripeBuy} 
                                    disabled={processingPayment} 
                                />
                            )}
                            <a
                                href="https://studiomakemusic.com/instrumentals"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center justify-between p-3 rounded-lg border transition-all border-amber-500/20 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 cursor-pointer"
                            >
                                <div>
                                    <div className="text-xs font-bold text-white uppercase">Voir toutes les licences</div>
                                    <div className="text-[9px] text-slate-400">Visitez notre boutique officielle</div>
                                </div>
                                <div className="flex items-center space-x-2 text-sm">
                                    <span className="text-[9px] font-black uppercase">Voir</span>
                                    <i className="fas fa-arrow-right text-xs"></i>
                                </div>
                            </a>
                        </div>
                        <div className="mt-4 flex items-center justify-center text-[9px] text-slate-500 space-x-2">
                            <i className="fas fa-lock"></i>
                            <span>Paiement sécurisé via Stripe</span>
                        </div>
                    </div>
                </div>
            </div>,
            document.body
        )
      )}
    </div>
  );
};

const LicenseOption = ({ name, price, feat, onBuy, disabled }: any) => (
    <div className={`flex items-center justify-between p-3 rounded-lg border transition-all ${disabled ? 'border-white/5 opacity-50 cursor-not-allowed' : 'border-white/10 bg-white/5 hover:bg-white/10 hover:border-cyan-500/50 cursor-pointer'}`}>
        <div>
            <div className="text-xs font-bold text-white uppercase">{name}</div>
            <div className="text-[9px] text-slate-400">{feat}</div>
        </div>
        <div className="flex items-center space-x-3">
            <span className="text-sm font-black text-white">{price}€</span>
            <button onClick={onBuy} disabled={disabled} className="px-3 py-1.5 bg-cyan-500 text-black text-[9px] font-black uppercase tracking-wider rounded hover:bg-cyan-400 disabled:bg-slate-700 transition-colors">
                ACHETER
            </button>
        </div>
    </div>
);

export default InstrumentCatalog;
