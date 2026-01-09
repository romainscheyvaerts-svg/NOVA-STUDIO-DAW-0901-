
import React from 'react';
import { PluginType } from '../types';

// DSP Imports
import { ReverbNode } from './ReverbPlugin';
import { SyncDelayNode } from './DelayPlugin';
import { ChorusNode } from './ChorusPlugin';
import { FlangerNode } from './FlangerPlugin';
import { VocalDoublerNode } from './DoublerPlugin';
import { StereoSpreaderNode } from './StereoSpreaderPlugin';
import { CompressorNode } from './CompressorPlugin';
import { AutoTuneNode } from './autotune-pro/AutoTuneNode'; // Updated to use the clean node
import { DeEsserNode } from './DeEsserPlugin';
import { DenoiserNode } from './DenoiserPlugin';
import { ProEQ12Node } from './ProEQ12Plugin';
import { VocalSaturatorNode } from './VocalSaturatorPlugin';
import { MasterSyncNode } from './MasterSyncPlugin';

// Instrument Nodes
import { MelodicSamplerNode } from '../engine/MelodicSamplerNode';
import { DrumSamplerNode } from '../engine/DrumSamplerNode';
import { DrumRackNode } from '../engine/DrumRackNode';

// LAZY LOADED UI COMPONENTS
const AutoTuneUI = React.lazy(() => import('./autotune-pro/AutoTuneUI').then(m => ({ default: m.AutoTuneUI })));
const ProfessionalReverbUI = React.lazy(() => import('./ReverbPlugin').then(m => ({ default: m.ProfessionalReverbUI })));
const VocalCompressorUI = React.lazy(() => import('./CompressorPlugin').then(m => ({ default: m.VocalCompressorUI })));
const SyncDelayUI = React.lazy(() => import('./DelayPlugin').then(m => ({ default: m.SyncDelayUI })));
const VocalChorusUI = React.lazy(() => import('./ChorusPlugin').then(m => ({ default: m.VocalChorusUI })));
const StudioFlangerUI = React.lazy(() => import('./FlangerPlugin').then(m => ({ default: m.StudioFlangerUI })));
const VocalDoublerUI = React.lazy(() => import('./DoublerPlugin').then(m => ({ default: m.VocalDoublerUI })));
const StereoSpreaderUI = React.lazy(() => import('./StereoSpreaderPlugin').then(m => ({ default: m.StereoSpreaderUI })));
const VocalDeEsserUI = React.lazy(() => import('./DeEsserPlugin').then(m => ({ default: m.VocalDeEsserUI })));
const VocalDenoiserUI = React.lazy(() => import('./DenoiserPlugin').then(m => ({ default: m.VocalDenoiserUI })));
const ProEQ12UI = React.lazy(() => import('./ProEQ12Plugin').then(m => ({ default: m.ProEQ12UI })));
const VocalSaturatorUI = React.lazy(() => import('./VocalSaturatorPlugin').then(m => ({ default: m.VocalSaturatorUI })));
const MasterSyncUI = React.lazy(() => import('./MasterSyncPlugin').then(m => ({ default: m.MasterSyncUI })));

const MelodicSamplerEditor = React.lazy(() => import('../components/MelodicSamplerEditor'));
const DrumSamplerEditor = React.lazy(() => import('../components/DrumSamplerEditor'));
const DrumRack = React.lazy(() => import('../components/DrumRack'));
const VSTPluginWindow = React.lazy(() => import('../components/VSTPluginWindow'));

export interface PluginEntry {
  name: string;
  type: PluginType;
  description: string;
  icon: string;
  color: string;
  category: 'DYNAMICS' | 'SPATIAL' | 'MODULATION' | 'PITCH' | 'EQ' | 'UTILITY' | 'INSTRUMENT' | 'EXTERNAL';
  factory: (ctx: AudioContext, params: any, bpm: number) => any;
  ui: React.LazyExoticComponent<any>;
  defaultParams: any;
}

export const PLUGIN_REGISTRY: Record<string, PluginEntry> = {
  // --- DYNAMICS ---
  'COMPRESSOR': {
    name: 'Leveler',
    type: 'COMPRESSOR',
    description: 'VCA Dynamics Processor',
    icon: 'fa-compress-alt',
    color: '#f97316',
    category: 'DYNAMICS',
    factory: (ctx) => new CompressorNode(ctx),
    ui: VocalCompressorUI,
    defaultParams: { threshold: -18, ratio: 4, knee: 12, attack: 0.003, release: 0.25, makeupGain: 1.0, isEnabled: true }
  },
  'VOCALSATURATOR': {
    name: 'Vocal Saturator',
    type: 'VOCALSATURATOR',
    description: 'Analog Warmth & Drive',
    icon: 'fa-fire',
    color: '#10b981',
    category: 'DYNAMICS',
    factory: (ctx) => new VocalSaturatorNode(ctx),
    ui: VocalSaturatorUI,
    defaultParams: { drive: 20, mix: 0.5, tone: 0.0, eqLow: 0, eqMid: 0, eqHigh: 0, mode: 'TAPE', isEnabled: true, outputGain: 1.0 }
  },
  'DEESSER': {
    name: 'S-Killer',
    type: 'DEESSER',
    description: 'Sibilance Processor',
    icon: 'fa-scissors',
    color: '#ef4444',
    category: 'DYNAMICS',
    factory: (ctx) => new DeEsserNode(ctx),
    ui: VocalDeEsserUI,
    defaultParams: { threshold: -25, frequency: 6500, q: 1.0, reduction: 0.6, mode: 'BELL', isEnabled: true }
  },
  
  // --- EQ ---
  'PROEQ12': {
    name: 'Pro-EQ 12',
    type: 'PROEQ12',
    description: '12-Band Surgical EQ',
    icon: 'fa-wave-square',
    color: '#00f2ff',
    category: 'EQ',
    factory: (ctx, params) => new ProEQ12Node(ctx, params || { bands: [], masterGain: 1, isEnabled: true }),
    ui: ProEQ12UI,
    defaultParams: {
        isEnabled: true, 
        masterGain: 1.0, 
        bands: Array.from({ length: 12 }, (_, i) => ({
            id: i, type: (i === 0 ? 'highpass' : i === 11 ? 'lowpass' : 'peaking'), 
            frequency: [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000][i], 
            gain: 0, q: 1.0, isEnabled: true, isSolo: false
        }))
    }
  },

  // --- SPATIAL ---
  'REVERB': {
    name: 'Spatial Verb',
    type: 'REVERB',
    description: 'Hybrid Reverb Engine',
    icon: 'fa-mountain-sun',
    color: '#6366f1',
    category: 'SPATIAL',
    factory: (ctx) => new ReverbNode(ctx),
    ui: ProfessionalReverbUI,
    defaultParams: { decay: 2.5, preDelay: 0.02, damping: 12000, mix: 0.3, size: 0.7, mode: 'HALL', isEnabled: true }
  },
  'DELAY': {
    name: 'Sync Delay',
    type: 'DELAY',
    description: 'Tempo Echo & Tape',
    icon: 'fa-history',
    color: '#0ea5e9',
    category: 'SPATIAL',
    factory: (ctx, _, bpm) => new SyncDelayNode(ctx, bpm || 120),
    ui: SyncDelayUI,
    defaultParams: { division: '1/4', feedback: 0.4, damping: 5000, mix: 0.3, pingPong: false, bpm: 120, isEnabled: true }
  },
  'STEREOSPREADER': {
    name: 'Phase Guard',
    type: 'STEREOSPREADER',
    description: 'M/S Width Spreader',
    icon: 'fa-arrows-alt-h',
    color: '#06b6d4',
    category: 'SPATIAL',
    factory: (ctx) => new StereoSpreaderNode(ctx),
    ui: StereoSpreaderUI,
    defaultParams: { width: 1.0, haasDelay: 0.015, lowBypass: 0.8, isEnabled: true }
  },
  'DOUBLER': {
    name: 'Vocal Doubler',
    type: 'DOUBLER',
    description: 'Haas Image Doubling',
    icon: 'fa-people-arrows',
    color: '#8b5cf6',
    category: 'SPATIAL',
    factory: (ctx) => new VocalDoublerNode(ctx),
    ui: VocalDoublerUI,
    defaultParams: { detune: 0.4, width: 0.8, gainL: 0.7, gainR: 0.7, directOn: true, isEnabled: true }
  },

  // --- MODULATION ---
  'CHORUS': {
    name: 'Vocal Chorus',
    type: 'CHORUS',
    description: 'Stereo Widener',
    icon: 'fa-layer-group',
    color: '#a855f7',
    category: 'MODULATION',
    factory: (ctx) => new ChorusNode(ctx),
    ui: VocalChorusUI,
    defaultParams: { rate: 1.2, depth: 0.35, spread: 0.5, mix: 0.4, isEnabled: true }
  },
  'FLANGER': {
    name: 'Studio Flanger',
    type: 'FLANGER',
    description: 'Jet Modulation',
    icon: 'fa-wind',
    color: '#3b82f6',
    category: 'MODULATION',
    factory: (ctx) => new FlangerNode(ctx),
    ui: StudioFlangerUI,
    defaultParams: { rate: 0.5, depth: 0.5, feedback: 0.7, manual: 0.3, mix: 0.5, invertPhase: false, isEnabled: true }
  },

  // --- PITCH ---
  'AUTOTUNE': {
    name: 'Auto-Tune Pro',
    type: 'AUTOTUNE',
    description: 'Neural Pitch Correction',
    icon: 'fa-microphone-alt',
    color: '#00f2ff',
    category: 'PITCH',
    factory: (ctx) => new AutoTuneNode(ctx),
    ui: AutoTuneUI,
    defaultParams: { speed: 0.1, humanize: 0.2, mix: 1.0, rootKey: 0, scale: 'CHROMATIC', isEnabled: true }
  },

  // --- UTILITY ---
  'DENOISER': {
    name: 'Denoiser',
    type: 'DENOISER',
    description: 'Noise Suppression',
    icon: 'fa-broom',
    color: '#00ff88',
    category: 'UTILITY',
    factory: (ctx) => new DenoiserNode(ctx),
    ui: VocalDenoiserUI,
    defaultParams: { threshold: -45, reduction: 0.8, release: 0.15, isEnabled: true }
  },
  'MASTERSYNC': {
    name: 'Master Sync',
    type: 'MASTERSYNC',
    description: 'Auto-Analysis & Scaling',
    icon: 'fa-sync-alt',
    color: '#00f2ff',
    category: 'UTILITY',
    factory: (ctx) => new MasterSyncNode(ctx),
    ui: MasterSyncUI,
    defaultParams: { detectedBpm: 120, detectedKey: 0, isMinor: false, isAnalyzing: false, analysisProgress: 0, isEnabled: true, hasResult: false }
  },

  // --- INSTRUMENTS ---
  'MELODIC_SAMPLER': {
      name: 'Melodic Sampler',
      type: 'MELODIC_SAMPLER',
      description: 'Polyphonic Texture Engine',
      icon: 'fa-wave-square',
      color: '#22d3ee',
      category: 'INSTRUMENT',
      factory: (ctx) => new MelodicSamplerNode(ctx),
      ui: MelodicSamplerEditor,
      defaultParams: { rootKey: 60, fineTune: 0, glide: 0.05, loop: true, loopStart: 0, loopEnd: 1, attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.5, filterCutoff: 20000, filterRes: 0, velocityToFilter: 0.5, lfoRate: 4, lfoAmount: 0, lfoDest: 'PITCH', saturation: 0, bitCrush: 0, chorus: 0, width: 0.5, isEnabled: true }
  },
  'DRUM_SAMPLER': {
      name: 'Drum Sampler',
      type: 'DRUM_SAMPLER',
      description: 'One-Shot Percussion',
      icon: 'fa-drum',
      color: '#f97316',
      category: 'INSTRUMENT',
      factory: (ctx) => new DrumSamplerNode(ctx),
      ui: DrumSamplerEditor,
      defaultParams: { gain: 0, transpose: 0, fineTune: 0, sampleStart: 0, sampleEnd: 1, attack: 0.005, hold: 0.05, decay: 0.2, sustain: 0, release: 0.1, cutoff: 20000, resonance: 0, pan: 0, velocitySens: 0.8, reverse: false, normalize: false, chokeGroup: 1, isEnabled: true }
  },
  'DRUM_RACK_UI': {
      name: 'Drum Rack',
      type: 'DRUM_RACK_UI',
      description: '30-Pad Sampler',
      icon: 'fa-th',
      color: '#f97316',
      category: 'INSTRUMENT',
      factory: (ctx) => new DrumRackNode(ctx),
      ui: DrumRack,
      defaultParams: { isEnabled: true }
  },
  
  // --- EXTERNAL ---
  'VST3': {
      name: 'VST3 Bridge',
      type: 'VST3',
      description: 'External Plugin',
      icon: 'fa-plug',
      color: '#ffffff',
      category: 'EXTERNAL',
      factory: (ctx) => { return { input: ctx.createGain(), output: ctx.createGain() }; },
      ui: VSTPluginWindow,
      defaultParams: { localPath: '', isEnabled: true }
  }
};
