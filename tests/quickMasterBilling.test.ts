import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Export du master express : la règle d'export de NOVA (Billing.ts simulé). */
const b = vi.hoisted(() => ({
  billingStatus: vi.fn(), isExportVoicesUnlocked: vi.fn(), spendExportCredit: vi.fn(),
  openCheckout: vi.fn(), waitPaid: vi.fn(), markExportVoicesUnlocked: vi.fn(),
}));
vi.mock('../services/Billing', () => b);

import { QUICK_MASTER_PRODUCT, masterExportAccess, masterFileKey, unlockMasterExport } from '../services/quickMasterBilling';

beforeEach(() => {
  Object.values(b).forEach(f => f.mockReset());
  b.billingStatus.mockResolvedValue({ plans: [], admin: false });
  b.isExportVoicesUnlocked.mockResolvedValue(false);
});

describe('Master express : export payant, écoute libre', () => {
  it('une seule clé produit, celle de l’export NOVA', () => {
    expect(QUICK_MASTER_PRODUCT).toBe('export_voices');
  });

  it('clé d’achat = empreinte du fichier (même fichier → même clé, ≤ 80 caractères)', async () => {
    const k1 = await masterFileKey(new Uint8Array([1, 2, 3])), k2 = await masterFileKey(new Uint8Array([1, 2, 3])), k3 = await masterFileKey(new Uint8Array([1, 2, 4]));
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toMatch(/^master:[0-9a-f]{32}$/);
  });

  it('admin : gratuit, sans paiement', async () => {
    b.billingStatus.mockResolvedValue({ plans: [], admin: true });
    expect(await masterExportAccess('master:x')).toEqual({ kind: 'admin' });
    const r = await unlockMasterExport('master:x');
    expect(r).toMatchObject({ ok: true, via: 'admin' });
    expect(b.openCheckout).not.toHaveBeenCalled();
  });

  it('déjà payé : libre', async () => {
    b.isExportVoicesUnlocked.mockResolvedValue(true);
    expect(await unlockMasterExport('master:x')).toMatchObject({ ok: true, via: 'deja_paye' });
    expect(b.openCheckout).not.toHaveBeenCalled();
  });

  it('Nova Pro avec des exports gratuits : un crédit est utilisé', async () => {
    b.billingStatus.mockResolvedValue({ plans: [{ plan: 'collab', status: 'active', current_period_end: null }], admin: false, free_exports_left: 3 });
    b.spendExportCredit.mockResolvedValue({ unlocked: true, remaining: 2 });
    const r = await unlockMasterExport('master:x');
    expect(r).toMatchObject({ ok: true, via: 'nova_pro', left: 2 });
    expect(b.spendExportCredit).toHaveBeenCalledWith('master:x');
    expect(b.markExportVoicesUnlocked).toHaveBeenCalledWith('master:x');
    expect(b.openCheckout).not.toHaveBeenCalled();
  });

  it('sinon : Stripe Checkout avec la clé produit et la clé du morceau, puis attente du paiement', async () => {
    b.openCheckout.mockResolvedValue('cs_1');
    b.waitPaid.mockResolvedValue(true);
    const waiting = vi.fn();
    const r = await unlockMasterExport('master:x', { onWaiting: waiting });
    expect(b.openCheckout).toHaveBeenCalledWith('export_voices', { project_key: 'master:x' });
    expect(waiting).toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, via: 'paiement' });
    expect(b.markExportVoicesUnlocked).toHaveBeenCalledWith('master:x');
  });

  it('accès déjà lu : Stripe s’ouvre sans nouvelle requête avant (pas de fenêtre bloquée)', async () => {
    b.openCheckout.mockResolvedValue('cs_2');
    b.waitPaid.mockResolvedValue(true);
    await unlockMasterExport('master:y', { access: { kind: 'pay' } });
    expect(b.billingStatus).not.toHaveBeenCalled();
    expect(b.openCheckout).toHaveBeenCalledTimes(1);
  });

  it('paiement non reçu ou erreur : message actionnable, rien de débloqué', async () => {
    b.openCheckout.mockResolvedValue('cs_3');
    b.waitPaid.mockResolvedValue(false);
    expect(await unlockMasterExport('master:z')).toMatchObject({ ok: false });
    b.openCheckout.mockRejectedValue(new Error('401 not authenticated'));
    const r = await unlockMasterExport('master:z');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Connecte-toi/);
    expect(b.markExportVoicesUnlocked).not.toHaveBeenCalled();
  });
});
