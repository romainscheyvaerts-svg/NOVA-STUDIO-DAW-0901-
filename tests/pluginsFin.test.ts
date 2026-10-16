// @vitest-environment jsdom
/**
 * Fin des façades « matériel » (1.5.1) : Compresseur, Stéréo, Master.
 *
 * « Le son ne change pas » : tests/fixtures/pluginsFinGolden.json a été capturé sur les
 * ANCIENNES fenêtres (commit f2e7c054, curseurs et anciens potards pilotés à la souris) :
 * pour chaque geste (bouton en butée haute / basse, double-clic, caractère, préréglage,
 * interrupteur, analyse…), les paramètres envoyés au moteur (node.updateParams) et au
 * projet (onParamsChange). On rejoue ici les MÊMES gestes sur les nouvelles façades
 * (boutons rotatifs du kit plugins/hw, au clavier : Début / Fin = butées) et on exige
 * exactement les mêmes envois. Un geste qui ne change rien (bouton déjà en butée) n'envoie
 * plus de doublon : on vérifie alors que l'ancien envoi était bien identique à l'état courant.
 */
import { afterEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import golden from './fixtures/pluginsFinGolden.json';
import { VocalCompressorUI } from '../plugins/CompressorPlugin';
import { StereoSpreaderUI } from '../plugins/StereoSpreaderPlugin';
import { MasterSyncUI } from '../plugins/MasterSyncPlugin';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
HTMLCanvasElement.prototype.getContext = function () { return new Proxy({}, { get: () => () => {}, set: () => true }) as any; } as any;
(globalThis as any).requestAnimationFrame = () => 1;
(globalThis as any).cancelAnimationFrame = () => {};

const clone = (x: any) => JSON.parse(JSON.stringify(x ?? null));
const hosts: (() => void)[] = [];
afterEach(() => { while (hosts.length) hosts.pop()!(); delete (window as any).DAW_CONTROL; });

function mount(el: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  hosts.push(() => { act(() => root.unmount()); host.remove(); });
  return host;
}
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
const dbl = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
const click = (el: Element | null | undefined) => { expect(el, 'élément introuvable').toBeTruthy(); act(() => { (el as HTMLElement).click(); }); };
const knob = (host: Element, id: string) => host.querySelector(`[data-nova-param='${id}'] [role=slider]`)!;

/** Geste sur un bouton rotatif : « max » = Fin, « min » = Début, « defaut » = double-clic. */
function knobGesture(host: Element, action: string) {
  const [id, what] = action.split(':');
  const k = knob(host, id);
  expect(k, `bouton ${id}`).toBeTruthy();
  if (what === 'max') key(k, 'End');
  else if (what === 'min') key(k, 'Home');
  else dbl(k);
}

/** Compare un geste rejoué à l'ancien envoi. */
function expectSame(g: { action: string; node: any[]; host?: any[] }, node: any[], hostSent: any[] | null, state: any): 'identique' | 'sans effet' {
  if (g.node.length && !node.length) {
    // Rien d'envoyé : l'ancienne fenêtre renvoyait l'état déjà en place (bouton déjà en butée).
    expect(g.node[g.node.length - 1], g.action).toEqual(state);
    return 'sans effet';
  }
  expect(node, g.action).toEqual(g.node);
  if (hostSent) expect(hostSent, g.action).toEqual(g.host);
  return 'identique';
}

describe('Compresseur : mêmes paramètres envoyés qu\'avant', () => {
  it('rejoue les 35 gestes de l\'ancienne fenêtre', () => {
    const init = { threshold: -18, ratio: 2, knee: 6, attack: 0.005, release: 0.1, makeupGain: 1.4, isEnabled: true };
    let calls: any[] = [];
    let sent: any[] = [];
    const node = { updateParams: (p: any) => calls.push(clone(p)), getReduction: () => 0, getInputLevel: () => -100, getOutputLevel: () => -100, latency: 0 } as any;
    const host = mount(h(VocalCompressorUI, { node, initialParams: init as any, onParamsChange: (p: any) => sent.push(clone(p)) }));
    const PRESET_IDS: Record<string, string> = { 'Voix douce': 'Vocal Smooth', 'Voix agressive': 'Vocal Aggressive', 'Colle de mix': 'Mix Bus Glue', 'Punch parallèle': 'Parallel Punch', 'Limiteur transparent': 'Transparent Limiter' };
    const MODE_TEXT: Record<string, string> = { CLEAN: 'Clean', VCA: 'VCA', OPTO: 'Opto', FET: 'FET' };
    let state: any = null;
    const gs = (golden as any).COMPRESSOR as any[];
    expect(gs.length).toBe(35);
    const bilan: string[] = [];
    for (const g of gs) {
      calls = []; sent = [];
      const [kind, arg] = g.action.split(':');
      if (kind === 'mode') click([...host.querySelectorAll("[data-nova-param='mode'] [role=radio]")].find(b => b.textContent?.trim() === MODE_TEXT[arg]));
      else if (kind === 'preset') click(host.querySelector(`[data-nova-preset='${PRESET_IDS[arg]}']`));
      else if (kind === 'autoMakeup') click(host.querySelector("[data-nova-param='autoMakeup'] [role=checkbox]"));
      else knobGesture(host, g.action);
      bilan.push(expectSame(g, calls, sent, state));
      if (sent.length) state = sent[sent.length - 1];
    }
    // 33 envois identiques ; 2 gestes sans effet (mélange déjà à 100 %, anticipation déjà à 0 : plus de doublon envoyé).
    expect(bilan.filter(b => b === 'identique').length).toBe(33);
  });

  it('façade matériel : aucun curseur, aide hors façade, bornes d\'avant', () => {
    const node = { updateParams: () => {}, getReduction: () => 0, getInputLevel: () => -100, getOutputLevel: () => -100, latency: 0 } as any;
    const host = mount(h(VocalCompressorUI, { node, initialParams: {} as any, onParamsChange: () => {} }));
    expect(host.querySelector("[data-nova-plugin='COMPRESSOR'] h2")?.textContent).toBe('Compresseur');
    expect(host.querySelectorAll('input[type=range]').length).toBe(0);
    expect(host.querySelector('[data-plugin-power]')).toBeNull(); // un seul marche / arrêt : la barre de la fenêtre
    const b = (id: string) => [knob(host, id).getAttribute('aria-valuemin'), knob(host, id).getAttribute('aria-valuemax')].map(Number);
    expect(b('threshold')).toEqual([-60, 0]);
    expect(b('ratio')).toEqual([1, 20]);
    expect(b('knee')).toEqual([0, 40]);
    expect(b('attack')).toEqual([0.0001, 0.1]);
    expect(b('release')).toEqual([0.01, 1]);
    expect(b('makeupGain')).toEqual([0.25, 4]);
    expect(b('mix')).toEqual([0, 1]);
    expect(b('lookahead')).toEqual([0, 0.005]);
    // L'aide est dans l'infobulle (et la ligne d'info), pas en paragraphe.
    expect(host.querySelector("[data-nova-param='threshold']")?.getAttribute('title')).toMatch(/Seuil/);
    expect(host.querySelector('[data-nova-infobar]')).toBeTruthy();
  });
});

describe('Stéréo : mêmes paramètres envoyés qu\'avant', () => {
  it('rejoue les 18 gestes de l\'ancienne fenêtre', () => {
    const init = { width: 1.0, balance: 0, monoFreq: 120, lowWidth: 0.8, midWidth: 1.2, highWidth: 1.5, lowMidFreq: 250, midHighFreq: 4000, haasDelay: 0.015, haasAmount: 0, mode: 'STEREO', multiBand: false, safeMonoBass: true, isEnabled: true };
    let calls: any[] = [];
    let sent: any[] = [];
    const node = { updateParams: (p: any) => calls.push(clone(p)), analyzerL: { fftSize: 32, getFloatTimeDomainData: () => {} }, analyzerR: { fftSize: 32, getFloatTimeDomainData: () => {} } } as any;
    const host = mount(h(StereoSpreaderUI, { node, initialParams: init as any, onParamsChange: (p: any) => sent.push(clone(p)) }));
    let state: any = init;
    const gs = (golden as any).STEREOSPREADER as any[];
    expect(gs.length).toBe(18);
    const bilan: string[] = [];
    for (const g of gs) {
      calls = []; sent = [];
      const [kind] = g.action.split(':');
      if (kind === 'multiBand' || kind === 'safeMonoBass') click(host.querySelector(`[data-nova-param='${kind}'] [role=checkbox]`));
      else knobGesture(host, g.action);
      bilan.push(expectSame(g, calls, sent, state));
      if (sent.length) state = sent[sent.length - 1];
    }
    expect(bilan.every(b => b === 'identique')).toBe(true);
  });

  it('projet sans ces réglages : la façade montre ce que le moteur applique (graves en mono allumé, largeur 100 %)', () => {
    let last: any = null;
    const node = { updateParams: (p: any) => { last = clone(p); }, analyzerL: { fftSize: 32, getFloatTimeDomainData: () => {} }, analyzerR: { fftSize: 32, getFloatTimeDomainData: () => {} } } as any;
    // Réglages d'un Stéréo neuf (utils/sessionTemplate) : pas de safeMonoBass, pas de balance.
    const host = mount(h(StereoSpreaderUI, { node, initialParams: { width: 1.0, haasDelay: 0.015, lowBypass: 0.8, isEnabled: true } as any, onParamsChange: () => {} }));
    const mono = host.querySelector("[data-nova-param='safeMonoBass'] [role=checkbox]")!;
    expect(mono.getAttribute('aria-checked')).toBe('true');
    expect(knob(host, 'width').getAttribute('aria-valuenow')).toBe('1');
    expect(knob(host, 'balance').getAttribute('aria-valuenow')).toBe('0');
    // Avant, le 1er clic renvoyait « true » (déjà le cas dans le moteur) : il ne se passait rien.
    click(mono);
    expect(last.safeMonoBass).toBe(false);
    expect(last).toEqual({ width: 1.0, haasDelay: 0.015, lowBypass: 0.8, isEnabled: true, safeMonoBass: false });
    // Largeur à 0 : affichée 0 % (avant : « || 1 » l'affichait à 100 %).
    key(knob(host, 'width'), 'Home');
    expect(last.width).toBe(0);
    expect(knob(host, 'width').getAttribute('aria-valuetext')).toBe('0 %');
    expect(host.querySelectorAll('input[type=range]').length).toBe(0);
  });
});

describe('Master (analyse tempo / tonalité) : mêmes appels qu\'avant', () => {
  it('analyser, tout appliquer, réinitialiser, analyser sans instru', async () => {
    const log: any[] = [];
    let params: any = { detectedBpm: 142, detectedKey: 9, detectedTransient: 13.2, isMinor: true, isAnalyzing: false, analysisProgress: 0, isEnabled: true, hasResult: false };
    const node = {
      getParams: () => params,
      updateParams: (p: any) => { log.push({ node: clone(p) }); params = { ...params, ...p }; },
      analyzeInstru: async (b: any) => { log.push({ analyze: b }); params = { ...params, hasResult: true, analysisProgress: 100 }; },
    } as any;
    (window as any).DAW_CONTROL = {
      getInstrumentalBuffer: () => 'BUFFER',
      setBpm: (b: number) => log.push({ setBpm: b }),
      syncAutoTuneScale: (k: number, s: string) => log.push({ sync: [k, s] }),
      getState: () => ({ tracks: [{ id: 'instrumental', clips: [{ id: 'c1' }] }] }),
      editClip: (...a: any[]) => log.push({ editClip: a }),
    };
    const host = mount(h(MasterSyncUI, { node, initialParams: params, onParamsChange: () => {} }));
    const G = (golden as any).MASTERSYNC as any[];
    const wait = () => act(async () => { await new Promise(r => setTimeout(r, 250)); });
    expect((host.querySelector("[data-nova-sync='appliquer']") as HTMLButtonElement).disabled).toBe(true);
    log.length = 0;
    await act(async () => { (host.querySelector("[data-nova-sync='analyse']") as HTMLElement).click(); await Promise.resolve(); });
    expect(log).toEqual(G[0].log);
    await wait();
    expect(host.querySelector("[data-nova-sync='bpm']")?.textContent).toContain('142');
    expect(host.querySelector("[data-nova-sync='key']")?.textContent).toBe('La mineur');
    log.length = 0;
    click(host.querySelector("[data-nova-sync='appliquer']"));
    expect(log).toEqual(G[1].log);
    await wait();
    expect(host.querySelector("[data-nova-sync='message']")?.textContent).toMatch(/Drop calé mesure 9/);
    log.length = 0;
    click(host.querySelector("[aria-label=\"Réinitialiser l'analyse\"]"));
    expect(log).toEqual(G[2].log);
    (window as any).DAW_CONTROL.getInstrumentalBuffer = () => null;
    await wait();
    log.length = 0;
    await act(async () => { (host.querySelector("[data-nova-sync='analyse']") as HTMLElement).click(); await Promise.resolve(); });
    expect(log).toEqual(G[3].log);
    await wait();
    expect(host.querySelector("[data-nova-sync='message']")?.textContent).toMatch(/Aucun audio/);
    expect(host.querySelector("[data-nova-plugin='MASTERSYNC'] h2")?.textContent).toBe('Master');
  });
});
