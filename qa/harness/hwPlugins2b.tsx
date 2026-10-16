/**
 * Banc d'essai visuel (QA) de la vague 2B des façades « matériel » : monte la
 * fenêtre d'un effet NOVA par-dessus l'application, dans le même cadre que
 * PluginEditor (bureau : cadre « nova-sombre nova-hosted-plugin » centré ;
 * téléphone : plein écran défilable + FitToWidth, comme mobileShell).
 * Le nœud est factice : ses mesures bougent (hauteur chantée, pas du motif,
 * porte ouverte / fermée, corrélation…). Utilisé par qa/plugins_hw_vague2b.py.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FitToWidth from '../../components/FitToWidth';
import { VocalChorusUI } from '../../plugins/ChorusPlugin';
import { StudioFlangerUI } from '../../plugins/FlangerPlugin';
import { VocalDoublerUI } from '../../plugins/DoublerPlugin';
import { StereoSpreaderUI } from '../../plugins/StereoSpreaderPlugin';
import { VocalDenoiserUI } from '../../plugins/DenoiserPlugin';
import { MasterSyncUI } from '../../plugins/MasterSyncPlugin';
import { VocalCompressorUI } from '../../plugins/CompressorPlugin';
import SamplerEditor from '../../components/SamplerEditor';
import DrumSamplerEditor from '../../components/DrumSamplerEditor';
import DrumRack from '../../components/DrumRack';
import SamplerPanel from '../../components/SamplerPanel';
import { DEFAULT_SAMPLER } from '../../utils/melodicSampler';
import { NovaHarmonizerUI } from '../../plugins/HarmonizerPlugin';
import { NovaVoiceShifterUI } from '../../plugins/VoiceShifterPlugin';
import { NovaTimeFxUI } from '../../plugins/TimeFxPlugin';
import { NovaGateFxUI } from '../../plugins/GateFxPlugin';
import { NovaNoiseGateUI } from '../../plugins/NoiseGatePlugin';
import { NovaDjFilterUI, NovaLofiUI } from '../../plugins/FilterPlugin';
import { V21_DEFAULTS } from '../../engine/v21Params';
import { defaultBuiltinParams } from '../../utils/sessionTemplate';
import { NOVA_FX_NAMES } from '../../utils/pluginLabel';

let root: Root | null = null;

function fakeNode(kind: string) {
  const t0 = performance.now();
  const t = () => (performance.now() - t0) / 1000;
  const fft = 1024;
  const analyser = (ph: number) => ({
    fftSize: fft,
    getFloatTimeDomainData: (a: Float32Array) => { const s = t(); for (let i = 0; i < a.length; i++) a[i] = 0.45 * Math.sin(i * 0.07 + s * 3) + 0.25 * Math.sin(i * 0.031 + ph + s); },
  });
  let sync: any = { detectedBpm: 142, detectedKey: 9, detectedTransient: 13.2, isMinor: true, isAnalyzing: false, analysisProgress: 100, isEnabled: true, hasResult: true };
  return {
    latency: 0,
    // Effets V21
    getMeters: () => {
      const s = t();
      return {
        pitch: { note: 57 + (Math.floor(s) % 3) * 2 }, chord: 0,
        speed: 0.55 + 0.4 * Math.sin(s), mode: 'stopping',
        step: Math.floor(s * 4) % 16,
        open: Math.sin(s * 2) > 0, keyOn: false,
        cutoff: 900,
      };
    },
    // Stéréo
    analyzerL: analyser(0), analyzerR: analyser(0.9),
    // Gate de bruit (ex-Anti-bruit)
    getStatus: () => { const s = t(); const open = Math.sin(s * 2) > -0.2; return { reduction: open ? 1 : 0.2, reductionDb: open ? 0 : -14, inputLevel: -30 + 14 * Math.sin(s * 2), isOpen: open, isActive: !open, noiseFloorDb: -62, thresholdDb: -45, humHz: 50 }; },
    // Compresseur (plugins-fin 1.5.1) : réduction (dB ≤ 0), crêtes d'entrée / de sortie (dBFS) qui bougent.
    getReduction: () => { const s = t(); return -Math.max(0, 6 + 5 * Math.sin(s * 1.7)); },
    getInputLevel: () => { const s = t(); return -14 + 8 * Math.sin(s * 1.7); },
    getOutputLevel: () => { const s = t(); return -16 + 4 * Math.sin(s * 1.7 + 0.4); },
    // Analyse
    getParams: () => sync,
    updateParams: (p: any) => { if (kind === 'MASTERSYNC') sync = { ...sync, ...(p || {}) }; },
    analyzeInstru: async () => {},
    isFallback: () => false,
  } as any;
}

const LEGACY: Record<string, any> = {
  COMPRESSOR: VocalCompressorUI,
  CHORUS: VocalChorusUI, FLANGER: StudioFlangerUI, DOUBLER: VocalDoublerUI, STEREOSPREADER: StereoSpreaderUI, DENOISER: VocalDenoiserUI,
};
const V21: Record<string, any> = {
  HARMONIZER: NovaHarmonizerUI, VOICESHIFT: NovaVoiceShifterUI, TIMEFX: NovaTimeFxUI, GATEFX: NovaGateFxUI, GATE: NovaNoiseGateUI, DJFILTER: NovaDjFilterUI, LOFI: NovaLofiUI,
};
const INIT: Record<string, any> = {
  FLANGER: { rate: 0.5, depth: 0.5, feedback: 0.7, manual: 0.3, mix: 0.5, invertPhase: false, isEnabled: true },
  DOUBLER: { detune: 0.4, width: 0.8, gainL: 0.7, gainR: 0.7, directOn: true, isEnabled: true },
};

/** Instruments (plugins-fin 1.5.1) : Sampler, Drum sampler, Drum Rack (piste factice, réglages remontés). */
const DrumRackQa: React.FC = () => {
  const [track, setTrack] = React.useState<any>(() => ({
    id: 'qa-drums', name: 'Batterie', type: 'DRUM_RACK', clips: [], plugins: [], sends: [],
    drumPads: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `Pad ${i + 1}`, sampleName: ['Kick', 'Snare', 'Hi-hat', 'Clap'][i] || 'Empty', volume: 0.8, pan: 0, isMuted: false, isSolo: false, midiNote: 60 + i })),
  }));
  return <DrumRack track={track} onUpdateTrack={t => { setTrack(t); (window as any).__qaHwParams = { ...((window as any).__qaHwParams || {}), pads: t.drumPads }; }} onClose={() => {}} />;
};

/** Écran du Sampler mélodique (instrument MELODIC_SAMPLER) sur une piste factice ; réglages remontés. */
const SamplerPanelQa: React.FC<{ mobile: boolean; Comp?: any }> = ({ mobile, Comp = SamplerPanel }) => {
  const [s, setS] = React.useState<any>(() => ({ ...DEFAULT_SAMPLER }));
  return <Comp track={{ id: 'qa-sampler-m', name: 'Sampler', melodicSampler: s } as any} isMobile={mobile} bpm={120}
    onChange={(p: any) => { setS((x: any) => ({ ...x, ...p })); (window as any).__qaHwParams = { ...((window as any).__qaHwParams || {}), ...p }; }}
    onClose={() => {}} onBackToSynth={() => {}} ensureEngine={async () => {}} notify={() => {}} sessionClips={[]} />;
};

let qaMobile = false;
function ui(kind: string) {
  if (kind === 'MELODIC_SAMPLER') return <SamplerPanelQa mobile={qaMobile} />;
  if (kind === 'SAMPLER') return <SamplerEditor plugin={{ id: 'qa-sampler', name: 'Sampler', type: 'SAMPLER', isEnabled: true, params: {}, latency: 0 } as any} trackId="qa-sampler" onClose={() => {}} />;
  if (kind === 'DRUM_SAMPLER') return <DrumSamplerEditor plugin={{ id: 'qa-drum', name: 'Drum sampler', type: 'DRUM_SAMPLER', isEnabled: true, params: {}, latency: 0 } as any} trackId="qa-drum" onClose={() => {}} />;
  if (kind === 'DRUM_RACK_UI') return <DrumRackQa />;
  const node = fakeNode(kind);
  // Réglages remontés au projet (relus par les scénarios de gestes).
  const noop = (p: any) => { (window as any).__qaHwParams = { ...((window as any).__qaHwParams || {}), ...(p || {}) }; };
  if (LEGACY[kind]) { const C = LEGACY[kind]; return <C node={node} initialParams={INIT[kind] || defaultBuiltinParams(kind as any)} onParamsChange={noop} />; }
  if (V21[kind]) { const C = V21[kind]; return <C node={node} initialParams={(V21_DEFAULTS as any)[kind]()} onParamsChange={noop} trackId="qa" />; }
  if (kind === 'MASTERSYNC') return <MasterSyncUI node={node} initialParams={node.getParams()} onParamsChange={noop} />;
  return <div>Effet inconnu : {kind}</div>;
}

export function unmountHwPlugin() {
  try { root?.unmount(); } catch { /* déjà démonté */ }
  root = null;
  document.querySelectorAll('[data-qa-hw]').forEach(n => n.remove());
}

export function mountHwPlugin(kind: string, mobile: boolean) {
  unmountHwPlugin();
  qaMobile = mobile;
  (window as any).__qaHwParams = {};
  const host = document.createElement('div');
  host.setAttribute('data-qa-hw', kind);
  document.body.appendChild(host);
  root = createRoot(host);
  if (mobile) {
    root.render(
      <div className="nova-sombre fixed inset-0 overflow-y-auto bg-nv-bg pt-14 pb-8" style={{ zIndex: 99999 }} data-qa-scroller>
        <div className="fixed top-0 left-0 right-0 z-[310] h-12 bg-black/90 border-b border-white/10 flex items-center justify-between pl-4 pr-1">
          <span className="text-[13px] font-bold text-white">{NOVA_FX_NAMES[kind] || kind}</span>
          <span className="w-11 h-11 flex items-center justify-center text-white"><i className="fas fa-times" /></span>
        </div>
        <FitToWidth>
          <div className="nova-sombre nova-hosted-plugin shadow-[0_0_100px_rgba(0,0,0,0.8)] overflow-hidden rounded-none">{ui(kind)}</div>
        </FitToWidth>
      </div>,
    );
  } else {
    root.render(
      <div className="fixed inset-0 flex items-start justify-center overflow-auto p-6 pt-16" style={{ zIndex: 99999, background: 'rgba(0,0,0,0.55)' }}>
        <div className="nova-sombre relative">
          <div className="absolute left-0 right-0 -top-14 h-12 bg-black/90 rounded-full border border-white/10 flex items-center px-6 text-[12px] font-bold text-white">{NOVA_FX_NAMES[kind] || kind}</div>
          <div className="nova-hosted-plugin shadow-[0_0_100px_rgba(0,0,0,0.8)] overflow-hidden rounded-[40px]">{ui(kind)}</div>
        </div>
      </div>,
    );
  }
  return true;
}
