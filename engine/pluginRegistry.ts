/**
 * Registre des effets NOVA (V15).
 *
 * Un nouvel effet se déclare UNE fois ici : réglages par défaut, création du
 * nœud audio (lecture et export), fenêtre d'édition et place dans les listes
 * d'effets (navigateur PC, téléphone, menu « + »). Plus besoin de toucher la
 * fabrique d'AudioEngine.ts, createDefaultPlugins (App.tsx) et les deux listes
 * du navigateur pour chaque effet.
 */
import type React from 'react';
import type { PluginInstance, PluginType } from '../types';
import { LimiterNode, DEFAULT_LIMITER_PARAMS } from './LimiterNode';
import { NovaLimiterUI } from '../plugins/LimiterPlugin';

export interface RegisteredPlugin {
  type: PluginType;
  /** Nom affiché. */
  name: string;
  /** Catégorie affichée dans le navigateur d'effets. */
  category: string;
  /** Icône Font Awesome. */
  icon: string;
  color: string;
  /** Infobulle : à quoi ça sert, avec l'équivalent dans les autres DAW. */
  description: string;
  defaultParams: () => Record<string, any>;
  /** Nœud audio : { input, output } + updateParams, latency (s), ready éventuels. */
  create: (ctx: BaseAudioContext, plugin: PluginInstance) => { input: AudioNode; output: AudioNode; updateParams?: (p: any) => void; latency?: number; ready?: Promise<unknown> };
  /** Fenêtre d'édition (reçoit le nœud, les réglages et le rappel de modification). */
  ui: React.ComponentType<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }>;
}

export const PLUGIN_REGISTRY: RegisteredPlugin[] = [
  {
    type: 'LIMITER',
    name: 'Nova Limiter',
    category: 'Master',
    icon: 'fa-compress-arrows-alt',
    color: '#fbbf24',
    description: 'Limiteur / maximiseur à crête vraie pour le master ou la 808 (comme Maximus dans FL Studio, le Limiter de Live ou l’Adaptive Limiter de Logic).',
    defaultParams: () => ({ ...DEFAULT_LIMITER_PARAMS }),
    create: (ctx, plugin) => new LimiterNode(ctx, plugin.params || {}),
    ui: NovaLimiterUI as any,
  },
];

export const getRegisteredPlugin = (type: string): RegisteredPlugin | undefined => PLUGIN_REGISTRY.find(p => p.type === type);

/** Entrées pour les listes d'effets du navigateur (même forme que INTERNAL_PLUGINS). */
export const registryBrowserItems = () => PLUGIN_REGISTRY.map(p => ({ id: p.type, name: p.name, category: p.category, icon: p.icon, color: p.color, description: p.description }));

/** Entrées pour le menu « + » d'une piste (même forme qu'AVAILABLE_FX_MENU). */
export const registryMenuItems = () => PLUGIN_REGISTRY.map(p => ({ id: p.type, name: p.name, icon: p.icon }));

/** Vrai pour un limiteur à crête vraie (le limiteur de sécurité du master s'efface alors). */
export const isTruePeakLimiter = (type: string) => type === 'LIMITER';
