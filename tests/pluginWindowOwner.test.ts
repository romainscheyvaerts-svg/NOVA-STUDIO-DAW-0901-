// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fenêtres de plugins « comme dans un DAW » : dans l'appli Windows, la page passe au pont le HWND de
 * la fenêtre de Nova Studio (window.__novaDesktop.hwnd) avec chaque demande de fenêtre de plugin
 * (owner) ; la fenêtre du plugin appartient alors à Nova (aucune icône de plus dans la barre des
 * tâches). Dans un navigateur : rien n'est ajouté (fenêtre indépendante, comme avant).
 */

let bridgeMod: typeof import('../services/NovaBridge');

beforeEach(async () => {
  delete (window as any).__novaDesktop;
  vi.resetModules();
  bridgeMod = await import('../services/NovaBridge');
});
afterEach(() => { delete (window as any).__novaDesktop; vi.restoreAllMocks(); });

const sent = () => {
  const b = bridgeMod.novaBridge as any;
  const spy = vi.spyOn(b, 'request').mockResolvedValue({ success: true });
  return spy;
};

describe('Fenêtre du plugin possédée par Nova Studio', () => {
  it('appli Windows : owner = HWND de Nova avec SHOW_EDITOR, ARA_SHOW, ARA_INSERT_EDITOR flottant', async () => {
    (window as any).__novaDesktop = { version: '1.5.15', hwnd: 0x1a2b3c };
    const spy = sent();
    const b = bridgeMod.novaBridge;
    await b.showEditor('slot-1');
    await b.araShow('ses-1');
    await b.araInsertEditor('slot-2', { mode: 'float' });
    await b.araInsertEditor('slot-2', { mode: 'dock', parent: 99, x: 0, y: 0, w: 10, h: 10 });
    const msgs = spy.mock.calls.map(c => c[0] as any);
    expect(msgs[0]).toMatchObject({ action: 'SHOW_EDITOR', slot_id: 'slot-1', owner: 0x1a2b3c });
    expect(msgs[1]).toMatchObject({ action: 'ARA_SHOW', owner: 0x1a2b3c });
    expect(msgs[2]).toMatchObject({ action: 'ARA_INSERT_EDITOR', mode: 'float', owner: 0x1a2b3c });
    // Ancré dans la page : parent déjà fourni, pas de propriétaire.
    expect(msgs[3].owner).toBeUndefined();
    expect(bridgeMod.desktopOwnerHwnd()).toBe(0x1a2b3c);
  });

  it('appli Windows : VocAlign (ARA_ALIGN) et Melodyne (ARA_OPEN) emportent aussi le HWND de Nova', async () => {
    (window as any).__novaDesktop = { version: '1.5.15', hwnd: 0x1a2b3c };
    const b = bridgeMod.novaBridge as any;
    const spy = vi.spyOn(b, 'sendAraFrame').mockResolvedValue({ success: true, renders: [] });
    const clip = { id: 'c1', name: 'Double', channels: [new Float32Array(10)] };
    await b.araAlign({ sessionId: 's', sampleRate: 48000, interactive: true, guide: clip, dubs: [clip] });
    await b.araOpen({ sessionId: 's2', plugin: 'melodyne', sampleRate: 48000, tempo: 120, clips: [clip] });
    const metas = spy.mock.calls.map(c => c[0] as any);
    expect(metas[0]).toMatchObject({ action: 'ARA_ALIGN', owner: 0x1a2b3c });
    expect(metas[1]).toMatchObject({ action: 'ARA_OPEN', owner: 0x1a2b3c });
  });

  it('site dans un navigateur : aucune clé owner (comportement inchangé)', async () => {
    const spy = sent();
    await bridgeMod.novaBridge.showEditor('slot-1');
    expect(spy.mock.calls[0][0]).toEqual({ action: 'SHOW_EDITOR', slot_id: 'slot-1' });
    expect(bridgeMod.desktopOwnerHwnd()).toBeUndefined();
  });

  it('HWND absent ou invalide : ignoré', async () => {
    for (const hwnd of [0, -5, 'abc', null, undefined]) {
      (window as any).__novaDesktop = { version: '1.5.15', hwnd };
      expect(bridgeMod.desktopOwnerHwnd()).toBeUndefined();
    }
  });
});
