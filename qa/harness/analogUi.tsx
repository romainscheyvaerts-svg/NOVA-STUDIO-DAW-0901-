/**
 * Banc d'essai visuel (QA) : monte la fenêtre d'un compresseur analogique NOVA
 * par-dessus l'application, comme PluginEditor (cadre « nova-sombre »), avec un
 * nœud factice dont le VU bouge. Utilisé par qa/analog_fenetres.py.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { NovaAnalogCompUI } from '../../plugins/AnalogCompPlugin';
import { ANALOG_SPECS } from '../../engine/analogCompParams';

export function mountAnalogWindow(kind: string) {
  const host = document.createElement('div');
  host.setAttribute('data-qa-analog', kind);
  host.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:' + (window.innerWidth < 640 ? '8px 0' : '24px') + ';overflow:auto;background:rgba(0,0,0,0.35)';
  document.body.appendChild(host);
  const t0 = performance.now();
  const node = {
    latency: 0,
    getMeters: () => { const t = (performance.now() - t0) / 1000; const g = Math.max(0, 4.2 * Math.sin(t * 2.1) + 1.5); return { grDb: g, grNowDb: g, inPeakDb: -8, outPeakDb: -9 }; },
    updateParams: () => {},
    isFallback: () => false,
  };
  createRoot(host).render(
    <div className="nova-sombre nova-hosted-plugin shadow-2xl rounded-2xl overflow-hidden">
      <NovaAnalogCompUI kind={kind} node={node} initialParams={{ ...ANALOG_SPECS[kind].defaults }} onParamsChange={() => {}} trackId="qa" />
    </div>,
  );
  return true;
}
