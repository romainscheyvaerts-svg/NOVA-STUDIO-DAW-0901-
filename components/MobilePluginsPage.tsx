import React, { useState } from 'react';
import MobileContainer from './MobileContainer';
import { Track, PluginInstance } from '../types';

interface MobilePluginsPageProps {
  tracks: Track[];
  onOpenPlugin?: (trackId: string, pluginId: string) => void;
  onToggleBypass?: (trackId: string, pluginId: string) => void;
  onRemovePlugin?: (trackId: string, pluginId: string) => void;
}

/**
 * Page mobile pour voir tous les plugins de toutes les pistes
 */
const MobilePluginsPage: React.FC<MobilePluginsPageProps> = ({
  tracks,
  onOpenPlugin,
  onToggleBypass,
  onRemovePlugin
}) => {
  const [filterType, setFilterType] = useState<'all' | 'enabled' | 'disabled'>('all');

  // Récupérer tous les plugins de toutes les pistes
  const allPlugins: Array<{ track: Track; plugin: PluginInstance }> = [];
  tracks.forEach(track => {
    if (track.id !== 'master') {
      track.plugins.forEach(plugin => {
        if (plugin.type !== 'MELODIC_SAMPLER' && plugin.type !== 'DRUM_SAMPLER') {
          allPlugins.push({ track, plugin });
        }
      });
    }
  });

  const filteredPlugins = allPlugins.filter(({ plugin }) => {
    if (filterType === 'all') return true;
    if (filterType === 'enabled') return plugin.isEnabled;
    if (filterType === 'disabled') return !plugin.isEnabled;
    return true;
  });

  const pluginCategories = [
    { id: 'all', name: 'Tous', count: allPlugins.length },
    { id: 'enabled', name: 'Actifs', count: allPlugins.filter(p => p.plugin.isEnabled).length },
    { id: 'disabled', name: 'Désactivés', count: allPlugins.filter(p => !p.plugin.isEnabled).length }
  ];

  return (
    <MobileContainer title="Plugins">
      <div className="space-y-4 pb-20">
        {/* Filtres */}
        <div className="flex gap-2 overflow-x-auto pb-2">
          {pluginCategories.map(cat => (
            <button
              key={cat.id}
              onClick={() => setFilterType(cat.id as any)}
              className={`shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                filterType === cat.id
                  ? 'bg-cyan-500 text-white'
                  : 'bg-[#14161a] text-slate-400'
              }`}
            >
              {cat.name} ({cat.count})
            </button>
          ))}
        </div>

        {/* Liste des plugins */}
        <div className="space-y-3">
          {filteredPlugins.map(({ track, plugin }) => (
            <div
              key={`${track.id}-${plugin.id}`}
              onClick={() => onOpenPlugin?.(track.id, plugin.id)}
              className="bg-[#14161a] rounded-xl p-4 border border-white/10 hover:border-cyan-500/30 transition-all active:scale-95"
            >
              <div className="flex items-start gap-3">
                <div
                  className={`w-12 h-12 shrink-0 rounded-lg flex items-center justify-center ${
                    plugin.isEnabled ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/5 text-slate-600'
                  }`}
                >
                  <i className="fas fa-plug"></i>
                </div>

                <div className="flex-1 min-w-0">
                  <h3 className={`font-medium truncate ${
                    plugin.isEnabled ? 'text-white' : 'text-slate-600'
                  }`}>
                    {plugin.name}
                  </h3>
                  <div className="flex items-center gap-2 mt-1">
                    <div
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: track.color }}
                    ></div>
                    <span className="text-xs text-slate-500 truncate">
                      {track.name}
                    </span>
                  </div>
                  <span className="text-xs text-slate-600 mt-1 block">
                    {plugin.type}
                  </span>
                </div>

                <div className="flex flex-col gap-2 shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleBypass?.(track.id, plugin.id);
                    }}
                    className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                      plugin.isEnabled
                        ? 'bg-cyan-500/20 text-cyan-400'
                        : 'bg-white/5 text-slate-600'
                    }`}
                  >
                    <i className="fas fa-power-off text-sm"></i>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemovePlugin?.(track.id, plugin.id);
                    }}
                    className="w-10 h-10 rounded-lg bg-red-500/20 text-red-400 flex items-center justify-center hover:bg-red-500/30"
                  >
                    <i className="fas fa-trash text-sm"></i>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Message vide */}
        {filteredPlugins.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            <i className="fas fa-plug text-4xl mb-4 opacity-30"></i>
            <p>Aucun plugin</p>
            <p className="text-xs mt-2">
              {filterType === 'all'
                ? 'Ajoutez des plugins à vos pistes'
                : `Aucun plugin ${filterType === 'enabled' ? 'actif' : 'désactivé'}`}
            </p>
          </div>
        )}

        {/* Stats en bas */}
        {allPlugins.length > 0 && (
          <div className="bg-[#14161a] rounded-xl p-4 border border-white/10">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-2xl font-bold text-cyan-400">{allPlugins.length}</div>
                <div className="text-xs text-slate-500 mt-1">Total</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-green-400">
                  {allPlugins.filter(p => p.plugin.isEnabled).length}
                </div>
                <div className="text-xs text-slate-500 mt-1">Actifs</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-slate-600">
                  {allPlugins.filter(p => !p.plugin.isEnabled).length}
                </div>
                <div className="text-xs text-slate-500 mt-1">Désactivés</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </MobileContainer>
  );
};

export default MobilePluginsPage;
