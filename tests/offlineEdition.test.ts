import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Édition hors ligne de l'appli Windows (clé USB, installateur NovaStudioSetup-HorsLigne.exe) :
 * aucun appel au serveur pour les droits, Nova Pro sur place, jamais admin, et jamais une instru
 * du catalogue non achetée dans le mix (même règle que decisionExport côté serveur).
 */

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../services/supabase', () => ({ catalogSupabase: { functions: { invoke: h.invoke } } }));

import { billingStatus, exportAccess, hasPlan, isExportVoicesUnlocked, offlineEditionAccess } from '../services/Billing';
import { masterExportAccess } from '../services/quickMasterBilling';
import { isOfflineEdition } from '../utils/desktopApp';

const g = globalThis as any;
const setDesktop = (info: unknown) => { g.window = { __novaDesktop: info }; };

beforeEach(() => { h.invoke.mockReset(); h.invoke.mockRejectedValue(new Error('Failed to fetch')); });
afterEach(() => { delete g.window; });

describe('édition hors ligne', () => {
  it('reconnue seulement avec edition « hors-ligne »', () => {
    setDesktop({ version: '1.5.4', edition: 'hors-ligne' });
    expect(isOfflineEdition()).toBe(true);
    setDesktop({ version: '1.5.4', edition: 'standard' });
    expect(isOfflineEdition()).toBe(false);
    setDesktop({ version: '1.5.3' });
    expect(isOfflineEdition()).toBe(false);
  });

  it('statut : Nova Pro sur place, pas admin, sans appel au serveur', async () => {
    setDesktop({ version: '1.5.4', edition: 'hors-ligne' });
    const st = await billingStatus();
    expect(st.admin).toBe(false);
    expect(st.pro?.active).toBe(true);
    expect(st.pro?.source).toBe('edition');
    expect(hasPlan(st, 'collab')).toBe(true);
    expect(hasPlan(st, 'beatmaker')).toBe(true);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('export : libre pour un projet sans instru du catalogue (kits compris)', async () => {
    setDesktop({ version: '1.5.4', edition: 'hors-ligne' });
    const a = await exportAccess({ projectKey: 'p1', catalogIds: [], kits: true, scope: 'mix' });
    expect(a).toMatchObject({ unlocked: true, via: 'edition', reason: null });
    expect(await isExportVoicesUnlocked('p1')).toBe(true);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('export : instru du catalogue non achetée refusée dans le mix, mes pistes seules permises', () => {
    expect(offlineEditionAccess({ projectKey: 'p2', catalogIds: ['beat-1'], kits: false, scope: 'mix' }))
      .toMatchObject({ unlocked: false, reason: 'catalogue_non_achete', missing: [{ id: 'beat-1' }] });
    expect(offlineEditionAccess({ projectKey: 'p2', catalogIds: ['beat-1'], kits: false, scope: 'voix' }))
      .toMatchObject({ unlocked: true, via: 'edition' });
  });

  it('« Masteriser un morceau » : inclus, comme Nova Pro', async () => {
    setDesktop({ version: '1.5.4', edition: 'hors-ligne' });
    expect((await masterExportAccess('master:abc')).kind).toBe('pro');
  });

  it('édition standard : le serveur décide toujours', async () => {
    setDesktop({ version: '1.5.4', edition: 'standard' });
    h.invoke.mockResolvedValue({ data: { plans: [], admin: false }, error: null });
    expect((await billingStatus()).pro).toBeUndefined();
    expect(h.invoke).toHaveBeenCalledWith('nova-billing', { body: { action: 'status' } });
  });
});
