import React, { useRef, useState } from 'react';
import { ProjectIO } from '../../services/ProjectIO'; // adapte si nécessaire
import { addInstrumentalToUserCatalogue } from '../../services/UserCatalogue'; // stub : adapte si necessaire
import type { Instrumental } from '../../types';

interface Props {
  instrumentals?: Instrumental[];
  onImportLocal?: (sample: any) => void;
  onSelectInstrumental?: (inst: Instrumental) => void;
  userId?: string;
}

const MobileSoundBrowser: React.FC<Props> = ({ instrumentals = [], onImportLocal, onSelectInstrumental, userId }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isImporting, setIsImporting] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    try {
      const file = e.target.files?.[0];
      if (!file) return console.warn('Aucun fichier sélectionné');

      setIsImporting(true);
      console.log('[MobileSoundBrowser] Import fichier local:', file.name, file.type, file.size);

      const arrayBuffer = await file.arrayBuffer();

      try {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        await audioCtx.decodeAudioData(arrayBuffer.slice(0));
        console.log('[MobileSoundBrowser] Décodage audio OK');
      } catch (decodeErr) {
        console.warn('[MobileSoundBrowser] decodeAudioData failed (peut être normal pour certains formats):', decodeErr);
      }

      if (ProjectIO?.importSampleFromBuffer) {
        try {
          const sample = await ProjectIO.importSampleFromBuffer(file.name, arrayBuffer);
          console.log('[MobileSoundBrowser] Sample importé via ProjectIO:', sample);
          onImportLocal?.(sample);
          addInstrumentalToUserCatalogue?.(userId, sample).catch(() => {});
          return;
        } catch (err) {
          console.warn('[MobileSoundBrowser] ProjectIO.importSampleFromBuffer a échoué, fallback:', err);
        }
      }

      const blob = new Blob([arrayBuffer], { type: file.type || 'audio/*' });
      const blobUrl = URL.createObjectURL(blob);
      const localSample = {
        id: `local-${Date.now()}`,
        name: file.name,
        url: blobUrl,
        format: file.type,
        duration: null,
      };
      try {
        addInstrumentalToUserCatalogue?.(userId, localSample);
      } catch (e) {
        console.warn('[MobileSoundBrowser] addInstrumentalToUserCatalogue failed:', e);
      }
      onImportLocal?.(localSample);
      console.log('[MobileSoundBrowser] Import local via blobURL OK', blobUrl);
    } catch (err) {
      console.error('[MobileSoundBrowser] Erreur import fichier local:', err);
      alert('Erreur lors de l’import du fichier. Regardez la console pour plus de détails.');
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleClickImport = () => {
    fileInputRef.current?.click();
  };

  const filteredInstrumentals = instrumentals.filter(i => i.name.toLowerCase().includes(searchQuery.toLowerCase()));

  return (
    <div className="flex-1 overflow-y-auto bg-[#0a0b0d]" style={{ paddingLeft: 'max(16px, env(safe-area-inset-left))', paddingRight: 'max(16px, env(safe-area-inset-right))', paddingBottom: '100px' }}>
      <div className="sticky top-0 bg-[#0a0b0d] py-4 z-10">
        <h2 className="text-white font-bold text-lg mb-4">🎵 Sons</h2>

        <button onClick={handleClickImport} className="w-full mb-4 p-4 bg-gradient-to-r from-cyan-500 to-blue-500 rounded-xl flex items-center justify-center gap-3 active:opacity-80 transition-all">
          <i className="fas fa-folder-open text-white text-xl"></i>
          <span className="text-white font-bold">{isImporting ? 'Import en cours...' : 'Importer un fichier local'}</span>
        </button>

        <input ref={fileInputRef} type="file" accept="audio/*" onChange={handleFileChange} className="hidden" />
        <div className="relative mb-3">
          <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-white/30"></i>
          <input type="text" placeholder="Rechercher une instru..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full bg-white/10 rounded-xl py-3 pl-10 pr-4 text-white placeholder-white/30 outline-none focus:ring-2 focus:ring-cyan-500" />
        </div>
      </div>

      <div className="mb-6">
        <h3 className="text-white/50 text-xs uppercase mb-3 flex items-center gap-2"><i className="fas fa-music"></i> Mon catalogue d'instrumentales</h3>

        {filteredInstrumentals.length > 0 ? (
          <div className="space-y-2">
            {filteredInstrumentals.map(inst => (
              <button key={inst.id} onClick={() => onSelectInstrumental?.(inst)} className="w-full p-4 bg-white/5 rounded-xl flex items-center gap-4 active:bg-white/10 transition-all text-left">
                <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-purple-500/30 to-pink-500/30 flex items-center justify-center flex-shrink-0">
                  <i className="fas fa-play text-white"></i>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white font-medium truncate">{inst.name}</p>
                  <div className="flex items-center gap-3 text-white/50 text-xs mt-1">
                    <span>{inst.bpm ?? '-' } BPM</span>
                    {inst.key && <span>{inst.key}</span>}
                    <span>{inst.duration ?? ''}</span>
                  </div>
                </div>
                {inst.genre && <span className="px-2 py-1 bg-white/10 rounded text-white/50 text-xs">{inst.genre}</span>}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 bg-white/5 rounded-xl">
            <i className="fas fa-music text-white/20 text-3xl mb-3"></i>
            <p className="text-white/50">Aucune instrumentale</p>
            <p className="text-white/30 text-sm">Importer un fichier local pour commencer</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default MobileSoundBrowser;
