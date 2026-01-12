import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { PluginMetadata } from '../types';

interface PluginManagerProps {
  onClose: () => void;
  onPluginsDiscovered: (plugins: PluginMetadata[]) => void;
}

const PluginManager: React.FC<PluginManagerProps> = ({ onClose, onPluginsDiscovered }) => {
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);

  const builtInPlugins: PluginMetadata[] = [
    { id: 'PROEQ12', name: 'Pro-EQ 12', type: 'PROEQ12', format: 'INTERNAL', vendor: 'Nova Studio', version: '1.0', latency: 0 },
    { id: 'COMPRESSOR', name: 'Leveler', type: 'COMPRESSOR', format: 'INTERNAL', vendor: 'Nova Studio', version: '1.0', latency: 0 },
    { id: 'REVERB', name: 'Spatial Verb', type: 'REVERB', format: 'INTERNAL', vendor: 'Nova Studio', version: '1.0', latency: 0 },
    { id: 'DELAY', name: 'Sync Delay', type: 'DELAY', format: 'INTERNAL', vendor: 'Nova Studio', version: '1.0', latency: 0 },
    { id: 'AUTOTUNE', name: 'Auto-Tune Pro', type: 'AUTOTUNE', format: 'INTERNAL', vendor: 'Nova Studio', version: '1.0', latency: 0 },
    { id: 'DENOISER', name: 'Denoiser', type: 'DENOISER', format: 'INTERNAL', vendor: 'Nova Studio', version: '1.0', latency: 0 },
    { id: 'DEESSER', name: 'S-Killer', type: 'DEESSER', format: 'INTERNAL', vendor: 'Nova Studio', version: '1.0', latency: 0 },
    { id: 'CHORUS', name: 'Vocal Chorus', type: 'CHORUS', format: 'INTERNAL', vendor: 'Nova Studio', version: '1.0', latency: 0 },
    { id: 'FLANGER', name: 'Studio Flanger', type: 'FLANGER', format: 'INTERNAL', vendor: 'Nova Studio', version: '1.0', latency: 0 },
    { id: 'DOUBLER', name: 'Vocal Doubler', type: 'DOUBLER', format: 'INTERNAL', vendor: 'Nova Studio', version: '1.0', latency: 0 },
    { id: 'STEREOSPREADER', name: 'Phase Guard', type: 'STEREOSPREADER', format: 'INTERNAL', vendor: 'Nova Studio', version: '1.0', latency: 0 },
    { id: 'VOCALSATURATOR', name: 'Vocal Saturator', type: 'VOCALSATURATOR', format: 'INTERNAL', vendor: 'Nova Studio', version: '1.0', latency: 0 },
    { id: 'MASTERSYNC', name: 'Master Sync', type: 'MASTERSYNC', format: 'INTERNAL', vendor: 'Nova Studio', version: '1.0', latency: 0 },
  ];

  const handleScan = async () => {
    setIsScanning(true);
    setScanProgress(0);

    // Simulate scanning
    for (let i = 0; i <= 100; i += 10) {
      await new Promise(resolve => setTimeout(resolve, 100));
      setScanProgress(i);
    }

    setIsScanning(false);
    onPluginsDiscovered(builtInPlugins);
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#14161a] border border-white/10 rounded-2xl w-full max-w-2xl p-6 relative max-h-[80vh] overflow-hidden flex flex-col">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center bg-white/5 rounded-full text-slate-400 hover:text-white hover:bg-red-500/50 transition-all z-10"
        >
          <i className="fas fa-times"></i>
        </button>

        <div className="mb-6">
          <h2 className="text-lg font-black text-white mb-1">
            <i className="fas fa-puzzle-piece mr-2 text-cyan-500"></i>
            Gestionnaire de Plugins
          </h2>
          <p className="text-[10px] text-slate-500">{builtInPlugins.length} plugins disponibles</p>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            {builtInPlugins.map(plugin => (
              <div
                key={plugin.id}
                className="p-4 bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 transition-all"
              >
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 bg-cyan-500/10 rounded-lg flex items-center justify-center">
                    <i className="fas fa-wave-square text-cyan-500"></i>
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">{plugin.name}</h3>
                    <p className="text-[9px] text-slate-500">{plugin.vendor} • v{plugin.version}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-white/10">
          <button
            onClick={handleScan}
            disabled={isScanning}
            className="w-full py-3 bg-white/5 hover:bg-white/10 text-white font-bold rounded-xl transition-all text-sm disabled:opacity-50"
          >
            {isScanning ? (
              <>
                <i className="fas fa-spinner fa-spin mr-2"></i>
                Scan en cours... {scanProgress}%
              </>
            ) : (
              <>
                <i className="fas fa-sync-alt mr-2"></i>
                Rescanner les plugins
              </>
            )}
          </button>
          <p className="text-[9px] text-slate-600 text-center mt-2">
            Les plugins VST3 nécessitent NOVA Bridge pour fonctionner
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default PluginManager;
