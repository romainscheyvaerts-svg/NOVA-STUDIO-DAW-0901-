/**
 * Banc d'essai visuel (QA) : monte la fenêtre « Mastering Transient » par-dessus
 * l'application, comme PluginEditor (cadre « nova-sombre »), avec un nœud
 * factice dont les mesures bougent. Utilisé par qa/master_transient_fenetres.py.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { NovaMasterTransientUI } from '../../plugins/MasterTransientPlugin';
import { MT_PRESETS, MT_DEFAULTS } from '../../engine/masterTransientParams';

export function mountMasterTransientWindow() {
  const host = document.createElement('div');
  host.setAttribute('data-qa-mt', '1');
  host.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:' + (window.innerWidth < 640 ? '8px 0' : '24px') + ';overflow:auto;background:rgba(0,0,0,0.35)';
  document.body.appendChild(host);
  const t0 = performance.now();
  const node = {
    latency: 615 / 48000,
    getMeters: () => {
      const t = (performance.now() - t0) / 1000;
      const e = Math.max(0, 1.1 * Math.sin(t * 3));
      return { emphDb: e, grDb: 2.4, inPeakDb: -3, outPeakDb: -0.1,
        bandEmphDb: Array.from({ length: 26 }, (_, b) => e * (b > 2 && b < 22 ? 1 : 0.5)),
        bandGrDb: Array.from({ length: 26 }, (_, b) => Math.max(0, 4 - b * 0.2)) };
    },
    updateParams: () => {},
    isFallback: () => false,
  };
  const romain = MT_PRESETS.find(p => p.id === 'romain')!.params;
  createRoot(host).render(
    <div className="nova-sombre nova-hosted-plugin shadow-2xl rounded-2xl overflow-hidden">
      <NovaMasterTransientUI node={node} initialParams={{ ...MT_DEFAULTS, ...romain }} onParamsChange={() => {}} trackId="qa" />
    </div>,
  );
  return true;
}
