/**
 * Banc d'essai visuel (QA) des gros effets à écran (vague 2A) : Égaliseur 12
 * bandes, Réverbe, Écho (delay), Nova Tune. Appelé par qa/harness/hwPlugins.tsx
 * (même cadre que PluginEditor) ; les nœuds sont factices mais « vivants » :
 * spectre qui bouge, niveaux d'entrée / sortie, hauteur chantée qui oscille.
 */
import React from 'react';
import { ProEQ12Node, ProEQ12UI } from '../../plugins/ProEQ12Plugin';
import { ProfessionalReverbUI, REVERB_PRESETS } from '../../plugins/ReverbPlugin';
import { SyncDelayUI } from '../../plugins/DelayPlugin';
import { AutoTuneUI } from '../../plugins/AutoTunePlugin';

export const KINDS_2A = ['PROEQ12', 'REVERB', 'DELAY', 'AUTOTUNE'];

const EQ_BANDS = [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000].map((f, i) => ({
  id: i, type: (i === 0 ? 'highpass' : i === 11 ? 'lowpass' : 'peaking') as any, frequency: f,
  gain: i === 2 ? -3.5 : i === 6 ? 4 : i === 9 ? 2.5 : 0, q: i === 6 ? 1.4 : 1, isEnabled: true, isSolo: false,
}));

function eqNode() {
  // Contexte temps réel : les réglages des filtres s'appliquent (un contexte hors ligne jamais rendu garderait leurs valeurs d'origine).
  const ctx = new AudioContext({ sampleRate: 48000 });
  (window as any).__qaEqCtx?.close?.().catch?.(() => {});
  (window as any).__qaEqCtx = ctx;
  const node = new ProEQ12Node(ctx, { isEnabled: true, masterGain: 1, bands: EQ_BANDS.map(b => ({ ...b })) });
  // Branché (muet) sur la sortie : le moteur ne calcule — et n'applique les réglages — qu'aux nœuds reliés.
  const mute = ctx.createGain(); mute.gain.value = 0; node.output.connect(mute); mute.connect(ctx.destination);
  const t0 = performance.now();
  // Spectre factice (voix : pente douce, bosses de formants), qui respire.
  const fake = (arr: Uint8Array) => {
    const t = (performance.now() - t0) / 1000;
    const n = arr.length;
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) * 24000 / n;
      const lf = Math.log10(Math.max(20, f));
      let db = -28 - 9 * Math.max(0, lf - 2.4) - 30 * Math.max(0, 2 - lf);
      db += 9 * Math.exp(-((lf - 2.65) ** 2) / 0.02) + 6 * Math.exp(-((lf - 3.35) ** 2) / 0.03) + 4 * Math.exp(-((lf - 3.6) ** 2) / 0.015);
      db += 2.5 * Math.sin(t * 2.3 + i * 0.07);
      arr[i] = Math.max(0, Math.min(255, Math.round((db + 100) / 70 * 255)));
    }
  };
  (node.postAnalyzer as any).getByteFrequencyData = fake;
  (node.preAnalyzer as any).getByteFrequencyData = fake;
  return node;
}

function reverbNode() {
  const t0 = performance.now();
  const t = () => (performance.now() - t0) / 1000;
  return {
    getInputLevel: () => -14 + 6 * Math.sin(t() * 3.1),
    getOutputLevel: () => -18 + 5 * Math.sin(t() * 2.2 + 1),
    updateParams: () => {},
    getParams: () => ({ ...REVERB_PRESETS[0] }),
  } as any;
}

function delayNode() {
  return { updateParams: () => {}, getParams: () => ({}) } as any;
}

function tuneNode() {
  let cb: ((d: any) => void) | null = null;
  const t0 = performance.now();
  const id = window.setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    const cents = 38 * Math.sin(t * 1.7);
    const target = 220 * Math.pow(2, 3 / 12); // Do (C4 ≈ 261,6 Hz)
    cb?.({ detectedFreq: target * Math.pow(2, cents / 1200), targetFreq: target, correctionCents: -cents });
  }, 40);
  (window as any).__qaTuneTimer = id;
  return { setStatusCallback: (f: any) => { cb = f; }, updateParams: () => {} } as any;
}

/** Fenêtre d'un effet de la vague 2A, ou null si le type n'en fait pas partie. */
export function ui2a(kind: string, noop: (p: any) => void): React.ReactElement | null {
  window.clearInterval((window as any).__qaTuneTimer);
  if (kind === 'PROEQ12') return <ProEQ12UI node={eqNode()} initialParams={{ isEnabled: true, masterGain: 1, bands: EQ_BANDS.map(b => ({ ...b })) }} onParamsChange={noop} />;
  if (kind === 'REVERB') return <ProfessionalReverbUI node={reverbNode()} initialParams={{ ...REVERB_PRESETS[0], freeze: false, isEnabled: true } as any} onParamsChange={noop} />;
  if (kind === 'DELAY') return <SyncDelayUI node={delayNode()} initialParams={{
    division: '1/8D', divisionR: '1/4', feedback: 0.45, feedbackHP: 150, feedbackLP: 5000, mix: 0.3, stereoWidth: 1, pingPong: true, ducking: 0.3,
    saturation: 0.3, modRate: 0.3, modDepth: 0.05, mode: 'TAPE', freeze: false, multiTap: false, tap2Level: 0.5, tap3Level: 0.35, tap4Level: 0.2, bpm: 140, isEnabled: true,
  }} onParamsChange={noop} />;
  if (kind === 'AUTOTUNE') return <AutoTuneUI node={tuneNode()} initialParams={{ speed: 0.1, humanize: 0.2, mix: 1, rootKey: 9, scale: 'MINOR', isEnabled: true }} onParamsChange={noop} />;
  return null;
}
