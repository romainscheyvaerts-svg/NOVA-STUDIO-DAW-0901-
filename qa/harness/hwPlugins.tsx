/**
 * Banc d'essai visuel (QA) des façades « matériel » : monte la fenêtre d'un effet
 * NOVA par-dessus l'application, dans le même cadre que PluginEditor :
 *  - bureau : cadre « nova-sombre nova-hosted-plugin » centré ;
 *  - téléphone : plein écran défilable + FitToWidth (comme mobileShell).
 * Le nœud est factice : ses mesures bougent (VU, réduction, emphase).
 * Utilisé par qa/plugins_hw_captures.py.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FitToWidth from '../../components/FitToWidth';
import { NovaAnalogCompUI } from '../../plugins/AnalogCompPlugin';
import { ANALOG_SPECS } from '../../engine/analogCompParams';
import { NovaMasterTransientUI } from '../../plugins/MasterTransientPlugin';
import { MT_PRESETS, MT_DEFAULTS } from '../../engine/masterTransientParams';
import { NovaLimiterUI } from '../../plugins/LimiterPlugin';
import { DEFAULT_LIMITER_PARAMS } from '../../engine/LimiterNode';
import { VocalDeEsserUI, DEESSER_DEFAULTS } from '../../plugins/DeEsserPlugin';
import { VocalSaturatorUI } from '../../plugins/VocalSaturatorPlugin';

let root: Root | null = null;

function fakeNode(kind: string) {
  const t0 = performance.now();
  const t = () => (performance.now() - t0) / 1000;
  return {
    latency: kind === 'LIMITER' ? 0.003 : kind === 'MASTERTRANSIENT' ? 615 / 48000 : 0,
    getMeters: () => {
      const s = t();
      const g = Math.max(0, 4.2 * Math.sin(s * 2.1) + 1.5);
      const e = Math.max(0, 1.1 * Math.sin(s * 3));
      return {
        grDb: kind === 'MASTERTRANSIENT' ? 2.4 : g, grNowDb: g, detDb: -4, inPeakDb: -8, outPeakDb: -1.2 - Math.abs(Math.sin(s)),
        emphDb: e,
        bandEmphDb: Array.from({ length: 26 }, (_, b) => e * (b > 2 && b < 22 ? 1 : 0.5)),
        bandGrDb: Array.from({ length: 26 }, (_, b) => Math.max(0, 4 - b * 0.2)),
      };
    },
    getReduction: () => 0,
    updateParams: () => {},
    isFallback: () => false,
  } as any;
}

function ui(kind: string) {
  const node = fakeNode(kind);
  // Réglages remontés au projet : relus par qa/plugins_hw_gestes.py.
  const noop = (p: any) => { (window as any).__qaHwParams = { ...((window as any).__qaHwParams || {}), ...(p || {}) }; };
  if (ANALOG_SPECS[kind]) return <NovaAnalogCompUI kind={kind} node={node} initialParams={{ ...ANALOG_SPECS[kind].defaults }} onParamsChange={noop} trackId="qa" />;
  if (kind === 'MASTERTRANSIENT') {
    const romain = MT_PRESETS.find(p => p.id === 'romain')!.params;
    return <NovaMasterTransientUI node={node} initialParams={{ ...MT_DEFAULTS, ...romain }} onParamsChange={noop} trackId="qa" />;
  }
  if (kind === 'LIMITER') return <NovaLimiterUI node={node} initialParams={{ ...DEFAULT_LIMITER_PARAMS, ceiling: -1, inputGain: 4 }} onParamsChange={noop} />;
  if (kind === 'DEESSER') return <VocalDeEsserUI node={node} initialParams={{ ...DEESSER_DEFAULTS } as any} onParamsChange={noop} />;
  if (kind === 'VOCALSATURATOR') return <VocalSaturatorUI node={node} initialParams={{ drive: 35, mix: 0.5, tone: 0.1, eqLow: 0, eqMid: 0, eqHigh: 0, mode: 'TUBE', isEnabled: true, outputGain: 1 }} onParamsChange={noop} />;
  return <div>Effet inconnu : {kind}</div>;
}

export function unmountHwPlugin() {
  try { root?.unmount(); } catch { /* déjà démonté */ }
  root = null;
  document.querySelectorAll('[data-qa-hw]').forEach(n => n.remove());
}

export function mountHwPlugin(kind: string, mobile: boolean) {
  unmountHwPlugin();
  (window as any).__qaHwParams = {};
  const host = document.createElement('div');
  host.setAttribute('data-qa-hw', kind);
  document.body.appendChild(host);
  root = createRoot(host);
  if (mobile) {
    root.render(
      <div className="nova-sombre fixed inset-0 overflow-y-auto bg-nv-bg pt-14 pb-8" style={{ zIndex: 99999 }} data-qa-scroller>
        <div className="fixed top-0 left-0 right-0 z-[310] h-12 bg-black/90 border-b border-white/10 flex items-center justify-between pl-4 pr-1">
          <span className="text-[13px] font-bold text-white">{kind}</span>
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
          <div className="absolute left-0 right-0 -top-14 h-12 bg-black/90 rounded-full border border-white/10 flex items-center px-6 text-[12px] font-bold text-white">{kind}</div>
          <div className="nova-hosted-plugin shadow-[0_0_100px_rgba(0,0,0,0.8)] overflow-hidden rounded-[40px]">{ui(kind)}</div>
        </div>
      </div>,
    );
  }
  return true;
}
