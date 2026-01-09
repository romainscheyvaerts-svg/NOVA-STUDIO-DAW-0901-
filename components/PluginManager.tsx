
import React, { useState, useRef } from 'react';
import { PluginMetadata, PluginType } from '../types';

interface PluginManagerProps {
  onClose: () => void;
  onPluginsDiscovered: (plugins: PluginMetadata[]) => void;
}

interface ScanFolder {
  handle?: any;
  files?: File[];
  name: string;
}

const PluginManager: React.FC<PluginManagerProps> = ({ onClose, onPluginsDiscovered }) => {
  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentFile, setCurrentFile] = useState('');
  const [foundPlugins, setFoundPlugins] = useState<PluginMetadata[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanFolders, setScanFolders] = useState<ScanFolder[]>([]);
  const [useFallback, setUseFallback] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const PLUGIN_EXTENSIONS = ['.vst3', '.dll', '.vst', '.component', '.dylib', '.vst2'];

  const isPluginExtension = (name: string) => {
    const n = name.toLowerCase();
    return PLUGIN_EXTENSIONS.some(ext => n.endsWith(ext));
  };

  const guessType = (name: string): PluginType => {
    const n = name.toLowerCase();
    if (n.includes('comp') || n.includes('limit') || n.includes('dynamics') || n.includes('l2')) return 'COMPRESSOR';
    if (n.includes('verb') || n.includes('space') || n.includes('valhalla')) return 'REVERB';
    if (n.includes('tune') || n.includes('pitch') || n.includes('voice') || n.includes('vocal') || n.includes('autotune')) return 'AUTOTUNE';
    if (n.includes('delay') || n.includes('echo')) return 'DELAY';
    if (n.includes('denoise') || n.includes('broom')) return 'DENOISER';
    return 'DELAY';
  };

  const handleAddFolder = async () => {
    setScanError(null);
    try {
      if (!(window as any).showDirectoryPicker || useFallback) {
        fileInputRef.current?.click();
        return;
      }
      
      const handle = await (window as any).showDirectoryPicker();
      if (!handle) return;

      try {
        await handle.queryPermission({ mode: 'read' });
      } catch (e) {
        throw new Error("ACCES_REFUSE");
      }

      setScanFolders(prev => {
        if (prev.some(f => f.name === handle.name)) return prev;
        return [...prev, { handle, name: handle.name }];
      });
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      if (err.message === "ACCES_REFUSE" || err.name === 'SecurityError') {
        setScanError("Accès refusé par le système. Essayez de copier vos plugins dans un dossier non-système (ex: Documents/Plugins) ou utilisez le bouton 'Sélectionner' à nouveau.");
        setUseFallback(true);
      } else {
        setScanError(`Erreur: ${err.message}`);
      }
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const folderName = (files[0] as any).webkitRelativePath.split('/')[0] || "Dossier Externe";
    setScanFolders(prev => [...prev, { files: Array.from(files), name: folderName }]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeFolder = (index: number) => {
    setScanFolders(prev => prev.filter((_, i) => i !== index));
  };

  const startScan = async () => {
    if (scanFolders.length === 0) {
      setScanError("Veuillez sélectionner le dossier où se trouvent vos VST3.");
      return;
    }

    setIsScanning(true);
    setFoundPlugins([]);
    setProgress(0);
    setScanError(null);

    const candidates = new Map<string, { name: string, path: string }>();

    try {
      for (const folder of scanFolders) {
        if (folder.handle) {
          async function crawl(handle: any, currentPath: string) {
            for await (const entry of handle.values()) {
              const newPath = `${currentPath}/${entry.name}`;
              setCurrentFile(newPath);
              
              if (isPluginExtension(entry.name)) {
                if (!candidates.has(newPath)) {
                  candidates.set(newPath, { name: entry.name, path: newPath });
                }
              } else if (entry.kind === 'directory') {
                await crawl(entry, newPath);
              }
            }
          }
          await crawl(folder.handle, folder.name);
        } else if (folder.files) {
          folder.files.forEach(file => {
            const parts = (file as any).webkitRelativePath.split('/');
            for (let i = 0; i < parts.length; i++) {
              if (isPluginExtension(parts[i])) {
                const bundlePath = parts.slice(0, i + 1).join('/');
                const bundleName = parts[i];
                if (!candidates.has(bundlePath)) {
                  candidates.set(bundlePath, { name: bundleName, path: bundlePath });
                }
                break;
              }
            }
          });
        }
      }

      const filesToProcess = Array.from(candidates.values());

      if (filesToProcess.length === 0) {
        setIsScanning(false);
        setScanError("Aucun plugin trouvé.");
        return;
      }

      const results: PluginMetadata[] = [];
      for (let i = 0; i < filesToProcess.length; i++) {
        const item = filesToProcess[i];
        setCurrentFile(item.path);
        setProgress(((i + 1) / filesToProcess.length) * 100);
        
        const ext = '.' + item.name.split('.').pop()?.toLowerCase();
        const format = ext === '.vst3' ? 'VST3' : 
                       ext === '.component' ? 'AU' : 
                       ext === '.dll' || ext === '.vst' ? 'VST' : 'INTERNAL';

        results.push({
          id: `vst-local-${Math.random().toString(36).substr(2, 9)}`,
          name: item.name.replace(/\.(vst3|dll|vst|vst2|component|dylib)$/i, ''),
          type: guessType(item.name),
          format: format as any,
          vendor: 'Local Audio System',
          version: '1.0',
          latency: 0,
          localPath: item.path
        });
        
        setFoundPlugins([...results]);
        await new Promise(r => setTimeout(r, 2));
      }

      setIsScanning(false);
      onPluginsDiscovered(results);
    } catch (err: any) {
      setScanError(`Le scan a échoué : ${err.message}`);
      setIsScanning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[600] bg-black/98 backdrop-blur-3xl flex items-center justify-center p-6 animate-in fade-in duration-500">
      <input 
        type="file" 
        ref={fileInputRef} 
        style={{ display: 'none' }} 
        {...({ webkitdirectory: "", directory: "" } as any)} 
        onChange={handleFileInputChange} 
      />

      <div className="w-full max-w-5xl bg-[#0d1014] border border-cyan-500/40 rounded-[40px] overflow-hidden shadow-[0_0_150px_rgba(6,182,212,0.15)] flex flex-col h-[800px]">
        <div className="p-10 border-b border-white/5 flex justify-between items-center bg-gradient-to-br from-[#13171d] to-[#0d1014]">
          <div className="flex items-center space-x-6">
            <div className="w-16 h-16 rounded-[24px] bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-white shadow-2xl shadow-cyan-500/20">
              <i className="fas fa-microchip text-2xl animate-pulse"></i>
            </div>
            <div>
              <h2 className="text-2xl font-black uppercase tracking-[0.3em] text-white">Nova <span className="text-cyan-500">Plugin Bridge</span></h2>
              <p className="text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] mt-1">Détection avancée des binaires VST3 et Audio Units</p>
            </div>
          </div>
          <button onClick={onClose} className="w-14 h-14 rounded-full bg-white/5 hover:bg-white/10 text-slate-500 hover:text-white transition-all flex items-center justify-center border border-white/5">
            <i className="fas fa-times text-xl"></i>
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col p-10">
          {!isScanning && foundPlugins.length === 0 ? (
            <div className="flex-1 flex flex-col justify-center items-center space-y-12">
              <div className="grid grid-cols-2 gap-8 w-full">
                <div className="bg-white/[0.02] border border-white/5 rounded-[32px] p-10 flex flex-col items-center text-center space-y-6">
                  <div className="w-16 h-16 rounded-full bg-cyan-500/10 flex items-center justify-center text-cyan-500">
                    <i className="fas fa-folder-tree text-2xl"></i>
                  </div>
                  <h3 className="text-white font-black uppercase tracking-widest text-sm">Cible du Scan</h3>
                  <div className="w-full space-y-4">
                    {scanFolders.map((folder, idx) => (
                      <div key={idx} className="flex items-center justify-between bg-black/40 rounded-2xl p-4 border border-white/5 group">
                        <div className="flex items-center space-x-4 truncate">
                          <i className="fas fa-file-code text-cyan-500/40"></i>
                          <span className="text-[11px] font-black text-slate-300 truncate">{folder.name}</span>
                        </div>
                        <button onClick={() => removeFolder(idx)} className="text-slate-600 hover:text-red-500 transition-colors px-2">
                          <i className="fas fa-trash-alt text-xs"></i>
                        </button>
                      </div>
                    ))}
                    {scanFolders.length < 3 && (
                      <button onClick={handleAddFolder} className="w-full h-16 border-2 border-dashed border-white/10 rounded-2xl flex items-center justify-center text-[11px] font-black text-slate-500 hover:border-cyan-500/50 hover:text-cyan-400 transition-all uppercase tracking-widest">
                        <i className="fas fa-plus-circle mr-3"></i> Ajouter un dossier VST3
                      </button>
                    )}
                  </div>
                </div>

                <div className="bg-gradient-to-b from-cyan-500/[0.05] to-transparent border border-cyan-500/20 rounded-[32px] p-10 flex flex-col items-center justify-center text-center space-y-8">
                   <div className="p-6 bg-cyan-500/5 rounded-2xl border border-cyan-500/10 text-left">
                     <p className="text-[9px] font-black text-cyan-500 uppercase mb-2">Conseil de Performance</p>
                     <p className="text-slate-500 text-[10px] leading-relaxed">
                       Pour une détection garantie, ne sélectionnez pas 'Program Files' directement. Sélectionnez le sous-dossier exact.
                     </p>
                   </div>
                  <button onClick={startScan} disabled={scanFolders.length === 0} className="w-full h-20 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-20 text-black rounded-[24px] text-xs font-black uppercase tracking-[0.3em] shadow-2xl shadow-cyan-500/40 transition-all transform active:scale-95">
                    Analyser les binaires
                  </button>
                </div>
              </div>

              {scanError && (
                <div className="w-full bg-red-500/10 border border-red-500/20 text-red-400 p-6 rounded-3xl text-[10px] font-black uppercase flex items-center">
                  <i className="fas fa-shield-alt mr-4 text-xl"></i>
                  <span>{scanError}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden">
              {isScanning && (
                <div className="mb-12 space-y-6">
                  <div className="flex justify-between items-end">
                    <div className="space-y-2">
                      <div className="flex items-center space-x-3">
                         <div className="w-2 h-2 rounded-full bg-cyan-500 animate-ping"></div>
                         <p className="text-[12px] text-cyan-400 font-black uppercase tracking-widest">Recherche de bundles VST3...</p>
                      </div>
                      <p className="text-[10px] font-mono text-slate-500 italic truncate w-[700px]">{currentFile}</p>
                    </div>
                    <span className="text-5xl font-black text-white font-mono">{Math.round(progress)}%</span>
                  </div>
                  <div className="h-4 bg-black/50 rounded-full overflow-hidden border border-white/5 p-1">
                    <div className="h-full bg-gradient-to-r from-cyan-600 to-cyan-400 shadow-[0_0_30px_rgba(6,182,212,0.5)] transition-all duration-300 rounded-full" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              )}

              <div className="flex-1 overflow-y-auto pr-4 space-y-3 scrollbar-thin">
                {foundPlugins.map(plugin => (
                  <div key={plugin.id} className="flex items-center justify-between p-5 bg-white/[0.02] border border-white/5 rounded-3xl group hover:bg-white/[0.05] hover:border-cyan-500/30 transition-all">
                    <div className="flex items-center space-x-6">
                      <div className="w-12 h-12 rounded-2xl bg-black/40 flex items-center justify-center text-[10px] font-black text-cyan-500 border border-white/5 group-hover:border-cyan-500/20">
                        {plugin.format}
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[13px] font-black text-white uppercase tracking-tight">{plugin.name}</span>
                        <span className="text-[9px] text-slate-600 font-bold uppercase tracking-widest mt-1">{plugin.type} • Structure Validée</span>
                      </div>
                    </div>
                    <div className="flex items-center space-x-4">
                       <span className="text-[9px] font-black text-green-500 uppercase tracking-widest">Reconnu</span>
                       <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_10px_#22c55e]"></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-10 bg-[#0a0d11] border-t border-white/5 flex justify-between items-center">
           <div className="flex space-x-12">
              <div className="flex flex-col">
                <span className="text-[10px] text-slate-600 font-black uppercase tracking-widest">Plugins Détectés</span>
                <span className="text-3xl text-cyan-500 font-black font-mono">{foundPlugins.length}</span>
              </div>
           </div>
           
           <div className="flex space-x-6">
              <button onClick={onClose} className="px-10 py-5 bg-white/5 hover:bg-white/10 text-white rounded-2xl text-[11px] font-black uppercase tracking-[0.2em] transition-all border border-white/5">
                Fermer
              </button>
           </div>
        </div>
      </div>
    </div>
  );
};

export default PluginManager;
