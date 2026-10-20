// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BUSY_TEXT, connectNativeUpdate, desktopHasNativeUpdate, isNewerVersion, legacyManifestStore, nativeUpdateStore,
  parseLatestManifest, parseNativeUpdateMessage, parseVersion, refreshLegacyManifest, requestDesktopUpdateCheck,
  sendUpdateCommand, shouldShowLegacyCard,
} from '../utils/appUpdate';
import DesktopUpdateCard from '../components/DesktopUpdateCard';
import DesktopUpdateSettings from '../components/DesktopUpdateSettings';
import { GUIDES } from '../utils/guides';

/** Appli Windows : mise à jour du programme (carte dans la page, réglages, appli ancienne). */

const SHA = 'a'.repeat(64);
const MANIFEST = { version: '1.5.3', url: 'downloads/NovaStudioSetup-1.5.3.exe', sha256: SHA, size: 51_035_415, date: '2026-10-19T12:00:00+02:00', notes: ['Un', 'Deux', 'Trois'] };

function fakeWebview() {
  const sent: string[] = [];
  const handlers: ((e: { data: unknown }) => void)[] = [];
  (window as any).chrome = { webview: { postMessage: (m: string) => sent.push(m), addEventListener: (_: string, h: any) => handlers.push(h), removeEventListener: () => {} } };
  return { sent, emit: (d: unknown) => handlers.forEach(h => h({ data: d })) };
}

beforeEach(() => { localStorage.clear(); nativeUpdateStore._reset(); legacyManifestStore._reset(); });
afterEach(() => { delete (window as any).__novaDesktop; delete (window as any).chrome; });

describe('versions', () => {
  it('compare numériquement, jamais de rétrogradation', () => {
    expect(isNewerVersion('1.5.3', '1.5.2')).toBe(true);
    expect(isNewerVersion('1.5.10', '1.5.9')).toBe(true);
    expect(isNewerVersion('1.6', '1.5.99')).toBe(true);
    expect(isNewerVersion('1.5.2', '1.5.2')).toBe(false);
    expect(isNewerVersion('1.5.1', '1.5.2')).toBe(false);
    expect(isNewerVersion('abc', '1.0')).toBe(false);
    expect(parseVersion('1.5.3-beta')).toBeNull();
  });
});

describe('manifeste', () => {
  it('lit le manifeste écrit par build.py', () => {
    expect(parseLatestManifest(MANIFEST)).toMatchObject({ version: '1.5.3', url: 'downloads/NovaStudioSetup-1.5.3.exe', notes: ['Un', 'Deux', 'Trois'] });
  });
  it('refuse un installateur hors de /downloads/ ou d’un autre domaine, une empreinte ou taille invalide', () => {
    expect(parseLatestManifest({ ...MANIFEST, url: 'https://evil.com/NovaStudioSetup.exe' })).toBeNull();
    expect(parseLatestManifest({ ...MANIFEST, url: 'downloads/autre.exe' })).toBeNull();
    expect(parseLatestManifest({ ...MANIFEST, sha256: 'x' })).toBeNull();
    expect(parseLatestManifest({ ...MANIFEST, size: 3 })).toBeNull();
    expect(parseLatestManifest(null)).toBeNull();
  });
  it('garde au plus 6 nouveautés', () => {
    expect(parseLatestManifest({ ...MANIFEST, notes: ['1', '2', '3', '4', '5', '6', '7'] })!.notes).toHaveLength(6);
  });
});

describe('carte de l’appli ancienne (1.5.2 et avant)', () => {
  const m = parseLatestManifest(MANIFEST);
  it('montrée seulement dans l’appli Windows, si sa version est plus ancienne', () => {
    expect(shouldShowLegacyCard({ version: '1.5.2' }, m)).toBe(true);
    expect(shouldShowLegacyCard({ version: '1.5.3' }, m)).toBe(false);
    expect(shouldShowLegacyCard({ version: '1.6.0' }, m)).toBe(false);
    expect(shouldShowLegacyCard(null, m)).toBe(false); // site (navigateur)
    expect(shouldShowLegacyCard({ version: '1.5.2' }, null)).toBe(false); // manifeste absent / illisible
  });
  it('jamais dans une appli qui a la mise à jour native (elle s’en charge)', () => {
    expect(shouldShowLegacyCard({ version: '1.5.2', features: ['google-login', 'app-update'] }, m)).toBe(false);
  });
  it('« Plus tard » : plus montrée pour cette version, de nouveau pour la suivante', () => {
    expect(shouldShowLegacyCard({ version: '1.5.2' }, m, '1.5.3')).toBe(false);
    expect(shouldShowLegacyCard({ version: '1.5.2' }, parseLatestManifest({ ...MANIFEST, version: '1.5.4' }), '1.5.3')).toBe(true);
  });
  it('lit le manifeste sur le site (sans cache) et affiche la carte avec le bouton de téléchargement', async () => {
    (window as any).__novaDesktop = { version: '1.5.2', features: ['google-login', 'reveal-download'] };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }));
    await refreshLegacyManifest(true, fetcher as unknown as typeof fetch);
    expect((fetcher.mock.calls[0] as unknown[])[0]).toMatch(/^\/downloads\/nova-studio-latest\.json\?t=\d+$/);
    expect((fetcher.mock.calls[0] as unknown[])[1]).toMatchObject({ cache: 'no-store' });
    const html = renderToStaticMarkup(React.createElement(DesktopUpdateCard));
    expect(html).toContain('Une nouvelle version de Nova Studio est disponible (1.5.3)');
    expect(html).toContain('href="/downloads/NovaStudioSetup.exe"');
    expect(html).toContain('Télécharger la mise à jour');
    expect(html).toContain('Tu as la version 1.5.2');
  });
  it('manifeste absent (page index.html renvoyée) : rien d’affiché', async () => {
    (window as any).__novaDesktop = { version: '1.5.2' };
    await refreshLegacyManifest(true, (async () => new Response('<!doctype html>', { status: 200 })) as unknown as typeof fetch);
    expect(renderToStaticMarkup(React.createElement(DesktopUpdateCard))).toBe('');
  });
  it('sur le site : ni carte, ni réglage', () => {
    expect(renderToStaticMarkup(React.createElement(DesktopUpdateCard))).toBe('');
    expect(renderToStaticMarkup(React.createElement(DesktopUpdateSettings))).toBe('');
  });
});

describe('mise à jour native (1.5.3 et plus)', () => {
  const READY = { type: 'nova-desktop-update', installed: '1.5.3', auto: true, phase: 'ready', progress: 1, available: { version: '1.5.4', notes: ['Nouveau A', 'Nouveau B'], size: 51_000_000, date: '' }, error: '', busy: null, busyText: '', dismissed: false, justUpdated: null, lastCheck: 0 };

  it('dit bonjour à l’appli et suit l’état qu’elle envoie', () => {
    (window as any).__novaDesktop = { version: '1.5.3', features: ['app-update'] };
    const wv = fakeWebview();
    connectNativeUpdate();
    expect(wv.sent).toEqual(['nova-desktop:update:hello']);
    wv.emit(JSON.stringify(READY));
    expect(nativeUpdateStore.get()).toMatchObject({ phase: 'ready', available: { version: '1.5.4' } });
    wv.emit('{"type":"nova-google:ready"}'); // autre message : ignoré
    expect(nativeUpdateStore.get()?.phase).toBe('ready');
  });
  it('« Nova Studio X.Y.Z est prête » : nouveautés + Redémarrer et mettre à jour + Plus tard', () => {
    (window as any).__novaDesktop = { version: '1.5.3', features: ['app-update'] };
    nativeUpdateStore._set(parseNativeUpdateMessage(READY));
    const html = renderToStaticMarkup(React.createElement(DesktopUpdateCard));
    expect(html).toContain('Nova Studio 1.5.4 est prête');
    expect(html).toContain('Nouveau A');
    expect(html).toContain('Redémarrer et mettre à jour');
    expect(html).toContain('Plus tard');
    expect(html).toContain('quand tu fermeras Nova Studio');
    expect(html).not.toContain('Une nouvelle version de Nova Studio est disponible');
  });
  it('refus pendant un enregistrement : le message de l’appli est affiché', () => {
    (window as any).__novaDesktop = { version: '1.5.3', features: ['app-update'] };
    nativeUpdateStore._set(parseNativeUpdateMessage({ ...READY, busy: 'recording', busyText: BUSY_TEXT.recording }));
    expect(renderToStaticMarkup(React.createElement(DesktopUpdateCard))).toContain('Un enregistrement est en cours');
  });
  it('« Mis à jour en X.Y.Z ✓ » une fois, avec les nouveautés', () => {
    (window as any).__novaDesktop = { version: '1.5.4', features: ['app-update'] };
    nativeUpdateStore._set(parseNativeUpdateMessage({ ...READY, installed: '1.5.4', phase: 'uptodate', available: null, justUpdated: { version: '1.5.4', notes: ['Nouveau A'] } }));
    const html = renderToStaticMarkup(React.createElement(DesktopUpdateCard));
    expect(html).toContain('Mis à jour en 1.5.4 ✓');
    expect(html).toContain('Nouveau A');
  });
  it('rien tant que rien n’est prêt ; « Plus tard » déjà choisi : rien', () => {
    (window as any).__novaDesktop = { version: '1.5.3', features: ['app-update'] };
    nativeUpdateStore._set(parseNativeUpdateMessage({ ...READY, phase: 'downloading', available: null }));
    expect(renderToStaticMarkup(React.createElement(DesktopUpdateCard))).toBe('');
    nativeUpdateStore._set(parseNativeUpdateMessage({ ...READY, dismissed: true }));
    expect(renderToStaticMarkup(React.createElement(DesktopUpdateCard))).toBe('');
  });
  it('réglages : version installée, « Mises à jour automatiques », « Rechercher maintenant »', () => {
    (window as any).__novaDesktop = { version: '1.5.3', features: ['app-update'] };
    nativeUpdateStore._set(parseNativeUpdateMessage({ ...READY, phase: 'uptodate', available: null, lastCheck: Date.now() }));
    const html = renderToStaticMarkup(React.createElement(DesktopUpdateSettings));
    expect(html).toContain('version installée : 1.5.3');
    expect(html).toContain('Mises à jour automatiques');
    expect(html).toContain('checked=""');
    expect(html).toContain('Rechercher maintenant');
    expect(html).toContain('Nova Studio est à jour');
  });
  it('commandes envoyées à l’appli ; « Rechercher maintenant » passe par l’appli', () => {
    (window as any).__novaDesktop = { version: '1.5.3', features: ['app-update'] };
    const wv = fakeWebview();
    expect(sendUpdateCommand('apply')).toBe(true);
    requestDesktopUpdateCheck();
    expect(wv.sent).toEqual(['nova-desktop:update:apply', 'nova-desktop:update:check']);
  });
  it('appli ancienne : aucune commande native envoyée', () => {
    (window as any).__novaDesktop = { version: '1.5.2', features: ['reveal-download'] };
    const wv = fakeWebview();
    expect(desktopHasNativeUpdate()).toBe(false);
    expect(sendUpdateCommand('apply')).toBe(false);
    expect(wv.sent).toEqual([]);
  });
  it('message mal formé : ignoré', () => {
    expect(parseNativeUpdateMessage('pas du json')).toBeNull();
    expect(parseNativeUpdateMessage({ type: 'autre' })).toBeNull();
    expect(parseNativeUpdateMessage({ type: 'nova-desktop-update', phase: 'pirate', busy: 'x' })).toMatchObject({ phase: 'idle', busy: null });
  });
});

describe('guide « Comment faire ? »', () => {
  it('parcours de mise à jour de l’appli, avec « Fais-le pour moi »', () => {
    const g = GUIDES.find(x => x.id === 'mise-a-jour-appli');
    expect(g).toBeTruthy();
    expect(g!.prereqs).toContain('appli-windows');
    expect(g!.doIt!({} as never)[0]).toMatchObject({ action: 'RUN_COMMAND', payload: { id: 'pal.appUpdate' } });
  });
});
