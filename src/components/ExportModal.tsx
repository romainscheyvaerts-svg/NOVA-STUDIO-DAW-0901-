import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { DAWState, User, Instrument } from '../types';
import { ProjectIO } from '../services/ProjectIO';
import { audioEngine } from '../engine/AudioEngine';
import { supabaseManager } from '../services/SupabaseManager';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectState: DAWState;
  user: User | null;
  onOpenAuth: () => void;
}

interface UnlicensedInstrument {
  id: number;
  name: string;
  price: number;
  stripeLink?: string;
}

type ExportFormat = 'WAV' | 'MP3' | 'ZIP';

const ExportModal: React.FC<ExportModalProps> = ({ isOpen, onClose, projectState, user, onOpenAuth }) => {
  const [exportFormat, setExportFormat] = useState<ExportFormat>('WAV');
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);

  // License checking state
  const [isCheckingLicenses, setIsCheckingLicenses] = useState(true);
  const [unlicensedInstruments, setUnlicensedInstruments] = useState<UnlicensedInstrument[]>([]);
  const [catalogInstrumentsUsed, setCatalogInstrumentsUsed] = useState<number[]>([]);

  // Check licenses on mount
  useEffect(() => {
    if (isOpen) {
      checkLicenses();
    }
  }, [isOpen, projectState, user]);

  const checkLicenses = async () => {
    setIsCheckingLicenses(true);
    setUnlicensedInstruments([]);

    try {
      // 1. Find all catalog instruments used in the project
      const usedInstrumentIds = new Set<number>();

      projectState.tracks.forEach(track => {
        if (track.instrumentId !== undefined) {
          usedInstrumentIds.add(track.instrumentId);
        }
      });

      const usedIds = Array.from(usedInstrumentIds);
      setCatalogInstrumentsUsed(usedIds);

      if (usedIds.length === 0) {
        // No catalog instruments used, export is free
        setIsCheckingLicenses(false);
        return;
      }

      // 2. Check which instruments are NOT licensed
      const ownedIds = user?.owned_instruments || [];
      const unlicensedIds = usedIds.filter(id => !ownedIds.includes(id));

      if (unlicensedIds.length === 0) {
        // All instruments are licensed
        setIsCheckingLicenses(false);
        return;
      }

      // 3. Fetch details for unlicensed instruments
      const unlicensedDetails: UnlicensedInstrument[] = [];

      for (const id of unlicensedIds) {
        const instrument = await supabaseManager.getInstrumentById(id);
        if (instrument) {
          unlicensedDetails.push({
            id: instrument.id,
            name: instrument.name,
            price: instrument.price_basic,
            stripeLink: instrument.stripe_link_basic
          });
        }
      }

      setUnlicensedInstruments(unlicensedDetails);
    } catch (error) {
      console.error('[ExportModal] License check failed:', error);
      setExportError('Erreur lors de la vérification des licences');
    } finally {
      setIsCheckingLicenses(false);
    }
  };

  const handleExport = async () => {
    if (!user) {
      onOpenAuth();
      return;
    }

    if (unlicensedInstruments.length > 0) {
      setExportError('Vous devez acheter les licences avant de pouvoir exporter.');
      return;
    }

    setIsExporting(true);
    setExportProgress(0);
    setExportError(null);

    try {
      if (exportFormat === 'ZIP') {
        // Project ZIP export
        setExportProgress(20);
        const ownedIds = user.owned_instruments || [];
        const blob = await ProjectIO.saveProject(projectState, ownedIds);
        setExportProgress(90);
        downloadBlob(blob, `${projectState.name || 'project'}.zip`);
      } else {
        // Audio bounce export (WAV or MP3)
        setExportProgress(10);

        // Get project duration
        const maxTime = Math.max(
          ...projectState.tracks.flatMap(t => t.clips.map(c => c.start + c.duration)),
          10
        );

        setExportProgress(20);

        // Render offline
        const audioBuffer = await audioEngine.renderOffline(
          projectState,
          maxTime,
          (progress) => setExportProgress(20 + progress * 60)
        );

        setExportProgress(80);

        if (exportFormat === 'WAV') {
          const wavBlob = audioBufferToWav(audioBuffer);
          downloadBlob(wavBlob, `${projectState.name || 'mix'}.wav`);
        } else {
          // MP3 encoding would require additional library
          // For now, fallback to WAV
          const wavBlob = audioBufferToWav(audioBuffer);
          downloadBlob(wavBlob, `${projectState.name || 'mix'}.wav`);
        }

        setExportProgress(100);
      }

      setTimeout(() => {
        onClose();
      }, 500);

    } catch (error: any) {
      console.error('[Export] Error:', error);
      setExportError(error.message || 'Erreur lors de l\'export');
    } finally {
      setIsExporting(false);
    }
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleBuyLicense = (stripeLink?: string) => {
    if (stripeLink) {
      window.open(stripeLink, '_blank');
    }
  };

  if (!isOpen) return null;

  // GUEST USER - Block completely
  if (!user) {
    return createPortal(
      <div className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-md flex items-center justify-center p-4">
        <div className="bg-[#14161a] border border-white/10 rounded-2xl w-full max-w-md p-8 text-center relative">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center bg-white/5 rounded-full text-slate-400 hover:text-white hover:bg-red-500/50 transition-all"
          >
            <i className="fas fa-times"></i>
          </button>

          <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <i className="fas fa-lock text-3xl text-red-500"></i>
          </div>

          <h2 className="text-xl font-black text-white mb-3">Compte Requis</h2>
          <p className="text-sm text-slate-400 mb-6">
            Pour exporter votre mix, vous devez créer un compte gratuit ou vous connecter.
          </p>

          <button
            onClick={() => { onClose(); onOpenAuth(); }}
            className="w-full py-3 bg-cyan-500 hover:bg-cyan-400 text-black font-black uppercase tracking-wider rounded-xl transition-all"
          >
            <i className="fas fa-user-plus mr-2"></i>
            Créer un compte / Se connecter
          </button>

          <p className="text-[10px] text-slate-600 mt-4">
            C'est gratuit et ne prend que 30 secondes
          </p>
        </div>
      </div>,
      document.body
    );
  }

  // CHECKING LICENSES
  if (isCheckingLicenses) {
    return createPortal(
      <div className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-md flex items-center justify-center p-4">
        <div className="bg-[#14161a] border border-white/10 rounded-2xl w-full max-w-md p-8 text-center">
          <div className="w-12 h-12 border-4 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm text-slate-400">Vérification des licences...</p>
        </div>
      </div>,
      document.body
    );
  }

  // UNLICENSED INSTRUMENTS - Block export
  if (unlicensedInstruments.length > 0) {
    return createPortal(
      <div className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-md flex items-center justify-center p-4">
        <div className="bg-[#14161a] border border-white/10 rounded-2xl w-full max-w-lg p-6 relative">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center bg-white/5 rounded-full text-slate-400 hover:text-white hover:bg-red-500/50 transition-all"
          >
            <i className="fas fa-times"></i>
          </button>

          <div className="text-center mb-6">
            <div className="w-16 h-16 bg-orange-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <i className="fas fa-exclamation-triangle text-2xl text-orange-500"></i>
            </div>
            <h2 className="text-lg font-black text-white mb-2">Licence Requise</h2>
            <p className="text-sm text-slate-400">
              Votre projet utilise {unlicensedInstruments.length} instrumental{unlicensedInstruments.length > 1 ? 's' : ''} du catalogue sans licence.
              <br />Achetez les licences pour débloquer l'export.
            </p>
          </div>

          <div className="space-y-3 mb-6 max-h-60 overflow-y-auto">
            {unlicensedInstruments.map(inst => (
              <div
                key={inst.id}
                className="flex items-center justify-between p-4 bg-white/5 border border-white/10 rounded-xl"
              >
                <div>
                  <h3 className="text-sm font-bold text-white">{inst.name}</h3>
                  <p className="text-[10px] text-slate-500">Licence Basic requise</p>
                </div>
                <div className="flex items-center space-x-3">
                  <span className="text-sm font-black text-cyan-400">${inst.price}</span>
                  <button
                    onClick={() => handleBuyLicense(inst.stripeLink)}
                    className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-black text-[10px] font-black uppercase rounded-lg transition-all"
                  >
                    Acheter
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="text-center">
            <p className="text-[9px] text-slate-600 mb-4">
              <i className="fas fa-info-circle mr-1"></i>
              Après l'achat, rafraîchissez la page pour activer votre licence
            </p>
            <button
              onClick={checkLicenses}
              className="text-cyan-500 hover:text-cyan-400 text-xs font-bold"
            >
              <i className="fas fa-sync-alt mr-1"></i>
              J'ai acheté, vérifier à nouveau
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  // ALL LICENSES OK - Show export options
  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#14161a] border border-white/10 rounded-2xl w-full max-w-md p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center bg-white/5 rounded-full text-slate-400 hover:text-white hover:bg-red-500/50 transition-all"
        >
          <i className="fas fa-times"></i>
        </button>

        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-cyan-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <i className="fas fa-download text-2xl text-cyan-500"></i>
          </div>
          <h2 className="text-lg font-black text-white mb-1">Exporter le Mix</h2>
          <p className="text-[10px] text-slate-500">{projectState.name || 'Sans titre'}</p>
        </div>

        {catalogInstrumentsUsed.length > 0 && (
          <div className="mb-4 p-3 bg-green-500/10 border border-green-500/20 rounded-lg flex items-center text-green-400 text-[10px]">
            <i className="fas fa-check-circle mr-2"></i>
            Toutes les licences sont validées
          </div>
        )}

        {exportError && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center text-red-400 text-[10px]">
            <i className="fas fa-exclamation-circle mr-2"></i>
            {exportError}
          </div>
        )}

        <div className="space-y-2 mb-6">
          <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider">Format</label>
          <div className="grid grid-cols-3 gap-2">
            {(['WAV', 'MP3', 'ZIP'] as ExportFormat[]).map(format => (
              <button
                key={format}
                onClick={() => setExportFormat(format)}
                disabled={isExporting}
                className={`py-3 rounded-xl text-[10px] font-black uppercase transition-all ${
                  exportFormat === format
                    ? 'bg-cyan-500 text-black'
                    : 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white'
                } ${isExporting ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {format === 'ZIP' ? (
                  <>
                    <i className="fas fa-file-archive mr-1"></i>
                    Projet
                  </>
                ) : (
                  <>
                    <i className="fas fa-music mr-1"></i>
                    {format}
                  </>
                )}
              </button>
            ))}
          </div>
          <p className="text-[9px] text-slate-600">
            {exportFormat === 'ZIP'
              ? 'Sauvegarde complète du projet (audio + session)'
              : `Export audio ${exportFormat} (mixage final)`
            }
          </p>
        </div>

        {isExporting && (
          <div className="mb-4">
            <div className="flex justify-between text-[10px] text-slate-400 mb-1">
              <span>Export en cours...</span>
              <span>{Math.round(exportProgress)}%</span>
            </div>
            <div className="h-2 bg-white/5 rounded-full overflow-hidden">
              <div
                className="h-full bg-cyan-500 transition-all duration-300"
                style={{ width: `${exportProgress}%` }}
              />
            </div>
          </div>
        )}

        <button
          onClick={handleExport}
          disabled={isExporting}
          className={`w-full py-3 rounded-xl font-black uppercase tracking-wider transition-all ${
            isExporting
              ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
              : 'bg-cyan-500 hover:bg-cyan-400 text-black'
          }`}
        >
          {isExporting ? (
            <>
              <i className="fas fa-spinner fa-spin mr-2"></i>
              Export en cours...
            </>
          ) : (
            <>
              <i className="fas fa-download mr-2"></i>
              Exporter en {exportFormat}
            </>
          )}
        </button>
      </div>
    </div>,
    document.body
  );
};

// Helper function to convert AudioBuffer to WAV blob
function audioBufferToWav(audioBuffer: AudioBuffer): Blob {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;

  const dataLength = audioBuffer.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  // Audio data
  const channels: Float32Array[] = [];
  for (let i = 0; i < numChannels; i++) {
    channels.push(audioBuffer.getChannelData(i));
  }

  let offset = 44;
  for (let i = 0; i < audioBuffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

export default ExportModal;
