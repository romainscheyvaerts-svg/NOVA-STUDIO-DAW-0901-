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
import { LimiterNode, DEFAULT_LIMITER_PARAMS, LIMITER_AUTOMATABLE } from './LimiterNode';
import { NovaLimiterUI } from '../plugins/LimiterPlugin';
import { V21EffectNode } from './v21Nodes';
import { V21_DEFAULTS, v21Automatable } from './v21Params';
import { NovaHarmonizerUI } from '../plugins/HarmonizerPlugin';
import { NovaVoiceShifterUI } from '../plugins/VoiceShifterPlugin';
import { NovaTimeFxUI } from '../plugins/TimeFxPlugin';
import { NovaDjFilterUI, NovaLofiUI } from '../plugins/FilterPlugin';
import { NovaGateFxUI } from '../plugins/GateFxPlugin';

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
  /** Nœud audio : { input, output } + updateParams, latency (s), ready éventuels. `bpm` : tempo du projet. */
  create: (ctx: BaseAudioContext, plugin: PluginInstance, bpm?: number) => { input: AudioNode; output: AudioNode; updateParams?: (p: any) => void; latency?: number; ready?: Promise<unknown> };
  /** Fenêtre d'édition (reçoit le nœud, les réglages et le rappel de modification). */
  ui: React.ComponentType<{ node: any; initialParams: any; onParamsChange: (p: Record<string, any>) => void }>;
  /** Réglages automatisables (éditeur d'automation). */
  automatable?: { id: string; label: string; min: number; max: number; unit?: string }[];
  /** Vrai : reçoit la tonalité du projet (`rootKey`, `scale`) comme l'Auto-Tune. */
  usesProjectKey?: boolean;
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
    // Anticipation et suréchantillonnage fixent la latence (PDC) : non automatisables.
    automatable: LIMITER_AUTOMATABLE,
  },
  // --- V21 : voix créatives et effets trap -------------------------------------
  {
    type: 'HARMONIZER',
    name: 'Harmoniseur',
    category: 'Voix créatives',
    icon: 'fa-users',
    color: '#e879f9',
    description: '1 à 4 voix d’harmonie dans la gamme du projet (tierce, quinte, octave…), timbre naturel et humanisé (comme les harmonies du Vocal Transformer de Logic ou le Pitcher de FL Studio).',
    defaultParams: V21_DEFAULTS.HARMONIZER,
    create: (ctx, plugin, bpm) => new V21EffectNode(ctx, 'HARMONIZER', plugin.params || {}, bpm),
    ui: NovaHarmonizerUI as any,
    automatable: v21Automatable('HARMONIZER'),
    usesProjectKey: true,
  },
  {
    type: 'VOICESHIFT',
    name: 'Voix grave / aiguë',
    category: 'Voix créatives',
    icon: 'fa-theater-masks',
    color: '#a78bfa',
    description: 'Hauteur et formant séparés : voix de démon, chipmunk, ou timbre seul (comme le Vocal Transformer de Logic ou Little AlterBoy).',
    defaultParams: V21_DEFAULTS.VOICESHIFT,
    create: (ctx, plugin, bpm) => new V21EffectNode(ctx, 'VOICESHIFT', plugin.params || {}, bpm),
    ui: NovaVoiceShifterUI as any,
    automatable: v21Automatable('VOICESHIFT'),
  },
  {
    type: 'TIMEFX',
    name: 'Tape stop & half-time',
    category: 'Effets trap',
    icon: 'fa-stopwatch',
    color: '#fb923c',
    description: 'Tape stop, half-time et stutter calés sur le tempo, déclenchables et automatisables (comme Gross Beat dans FL Studio ou le Beat Repeat de Live).',
    defaultParams: V21_DEFAULTS.TIMEFX,
    create: (ctx, plugin, bpm) => new V21EffectNode(ctx, 'TIMEFX', plugin.params || {}, bpm),
    ui: NovaTimeFxUI as any,
    automatable: v21Automatable('TIMEFX'),
  },
  {
    type: 'GATEFX',
    name: 'Gate rythmique',
    category: 'Effets trap',
    icon: 'fa-grip-lines-vertical',
    color: '#e879f9',
    description: 'Motif de 16 pas calé sur le tempo qui hache le son : stutter, half, triolets, pompe ; profondeur, attaque et relâchement automatisables (comme Gross Beat, le Trance Gate ou ShaperBox).',
    defaultParams: V21_DEFAULTS.GATEFX,
    create: (ctx, plugin, bpm) => new V21EffectNode(ctx, 'GATEFX', plugin.params || {}, bpm),
    ui: NovaGateFxUI as any,
    automatable: v21Automatable('GATEFX'),
  },
  {
    type: 'DJFILTER',
    name: 'Filtre DJ',
    category: 'Effets trap',
    icon: 'fa-filter',
    color: '#38bdf8',
    description: 'Un seul bouton : passe-bas à gauche, passe-haut à droite, résonance (comme le filtre d’une table DJ, l’Auto Filter de Live ou le DJ Filter de Logic).',
    defaultParams: V21_DEFAULTS.DJFILTER,
    create: (ctx, plugin, bpm) => new V21EffectNode(ctx, 'DJFILTER', plugin.params || {}, bpm),
    ui: NovaDjFilterUI as any,
    automatable: v21Automatable('DJFILTER'),
  },
  {
    type: 'LOFI',
    name: 'Lo-fi / téléphone',
    category: 'Effets trap',
    icon: 'fa-phone-alt',
    color: '#a3e635',
    description: 'Téléphone, radio, cassette, bitcrush : bande passante, grain léger, réduction de bits et souffle (comme le Bitcrusher de Logic, Redux de Live ou Lo-fi de FL Studio).',
    defaultParams: V21_DEFAULTS.LOFI,
    create: (ctx, plugin, bpm) => new V21EffectNode(ctx, 'LOFI', plugin.params || {}, bpm),
    ui: NovaLofiUI as any,
    automatable: v21Automatable('LOFI'),
  },
];

export const getRegisteredPlugin = (type: string): RegisteredPlugin | undefined => PLUGIN_REGISTRY.find(p => p.type === type);

/** Entrées pour les listes d'effets du navigateur (même forme que INTERNAL_PLUGINS). */
export const registryBrowserItems = () => PLUGIN_REGISTRY.map(p => ({ id: p.type, name: p.name, category: p.category, icon: p.icon, color: p.color, description: p.description }));

/** Entrées pour le menu « + » d'une piste (même forme qu'AVAILABLE_FX_MENU). */
export const registryMenuItems = () => PLUGIN_REGISTRY.map(p => ({ id: p.type, name: p.name, icon: p.icon }));

/** Vrai si l'effet suit la tonalité du projet (Auto-Tune, Harmoniseur). */
export const usesProjectKey = (type: string) => type === 'AUTOTUNE' || !!getRegisteredPlugin(type)?.usesProjectKey;

/** Vrai pour un limiteur à crête vraie (le limiteur de sécurité du master s'efface alors). */
export const isTruePeakLimiter = (type: string) => type === 'LIMITER';
