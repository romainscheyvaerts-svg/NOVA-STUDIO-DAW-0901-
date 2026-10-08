/**
 * Banc d'essai visuel (QA) : monte la fenêtre du de-esser NOVA par-dessus
 * l'application, comme PluginEditor (cadre « nova-sombre »), avec un nœud
 * factice dont la réduction bouge. Utilisé par qa/deesser_fenetre.py.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { VocalDeEsserUI, DEESSER_DEFAULTS } from '../../plugins/DeEsserPlugin';

export function mountDeesserWindow(variant: string) {
  const host = document.createElement('div');
  host.setAttribute('data-qa-deesser', variant);
  host.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:' + (window.innerWidth < 640 ? '8px 0' : '24px') + ';overflow:auto;background:rgba(0,0,0,0.35)';
  document.body.appendChild(host);
  const t0 = performance.now();
  const node: any = {
    latency: 0,
    getMeters: () => { const t = (performance.now() - t0) / 1000; const g = Math.max(0, 6 * Math.sin(t * 3.1)); return { grDb: g, grNowDb: g, detDb: -4 }; },
    getReduction: () => 0,
    updateParams: () => {},
    isFallback: () => false,
  };
  const params = variant === 'ancien'
    ? { threshold: -25, frequency: 6500, q: 1.0, reduction: 0.6, mode: 'BELL', isEnabled: true }
    : variant === 'ecoute' ? { ...DEESSER_DEFAULTS, listen: 1, mode: 'SHELF' } : { ...DEESSER_DEFAULTS };
  createRoot(host).render(
    <div className="nova-sombre nova-hosted-plugin shadow-2xl rounded-[28px] overflow-hidden">
      <VocalDeEsserUI node={node} initialParams={params as any} onParamsChange={() => {}} />
    </div>,
  );
  return true;
}
