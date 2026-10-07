import React from 'react';
import { PluginInstance } from '../types';
import { useAutotuneLive } from './AutotuneVstPanel';
import { pluginDetail, pluginDisplayName, pluginIcon, shortKey } from '../utils/pluginLabel';

/**
 * Nom lisible d'un effet (« Auto-Tune Pro · F# mineur », « Pro-C 3 », « Compresseur »),
 * avec son icône. Utilisé dans l'en-tête de piste, le menu FX et la console.
 */
export const PluginName: React.FC<{ plugin: PluginInstance; showIcon?: boolean; showDetail?: boolean; compact?: boolean; className?: string }> = ({ plugin, showIcon = true, showDetail = false, compact = false, className = '' }) => {
  const at = useAutotuneLive(plugin.type === 'AUTOTUNE' ? plugin.id : null);
  const name = pluginDisplayName(plugin, at);
  const full = showDetail ? pluginDetail(plugin, at) : '';
  const detail = compact && full ? shortKey(full) : full;
  const pc = plugin.type === 'VST3' || (plugin.type === 'AUTOTUNE' && at?.engine === 'vst');
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${className}`}>
      {showIcon && <i className={`fas ${pluginIcon(plugin)} shrink-0 text-[8px] ${pc ? 'text-fuchsia-300' : 'opacity-70'}`} aria-hidden="true" />}
      <span className="truncate">{name}{detail ? <span className="opacity-70"> · {detail}</span> : null}</span>
    </span>
  );
};

/** Infobulle d'un effet (hook : l'autotune donne le vrai plugin). */
export const usePluginTitle = (plugin: PluginInstance): string => {
  const at = useAutotuneLive(plugin.type === 'AUTOTUNE' ? plugin.id : null);
  const name = pluginDisplayName(plugin, at);
  const detail = pluginDetail(plugin, at);
  return `${name}${detail ? ` · ${detail}` : ''}${plugin.isEnabled ? '' : ' (désactivé)'} : clic pour l'ouvrir`;
};
