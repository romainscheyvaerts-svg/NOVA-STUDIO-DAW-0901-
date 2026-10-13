import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Export du master express : la décision et le prix viennent du serveur (Billing.ts simulé, vraie fonction euros / productFor). */
const b = vi.hoisted(() => ({
  loadPricing: vi.fn(), exportAccess: vi.fn(), startExportPayment: vi.fn(), waitPaid: vi.fn(), forgetExportAccess: vi.fn(),
}));
vi.mock('../services/Billing', async (orig) => {
  const real = await orig<typeof import('../services/Billing')>();
  return { ...real, ...b };
});

import { masterExportAccess, masterExportQuery, masterFileKey, unlockMasterExport } from '../services/quickMasterBilling';
import { ANCIENNE_GRILLE } from '../services/Billing';

const GRILLE = { ...ANCIENNE_GRILLE, version: '2026-10-14', legacy: false, export: { cents: 199 } };
const acces = (o: Record<string, unknown>) => ({ unlocked: false, via: null, reason: 'paiement', missing: [], login_required: false, kits: false, pro: null, legacy: false, ...o });

beforeEach(() => {
  Object.values(b).forEach(f => f.mockReset());
  b.loadPricing.mockResolvedValue(GRILLE);
  b.exportAccess.mockResolvedValue(acces({}));
});

describe('Master express : export décidé par le serveur, écoute libre', () => {
  it('clé d’achat = empreinte du fichier (même fichier → même clé, acceptée par le serveur)', async () => {
    const k1 = await masterFileKey(new Uint8Array([1, 2, 3])), k2 = await masterFileKey(new Uint8Array([1, 2, 3])), k3 = await masterFileKey(new Uint8Array([1, 2, 4]));
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toMatch(/^master:[0-9a-f]{32}$/);
    expect(k1).toMatch(/^[A-Za-z0-9_.:-]{6,80}$/); // PROJECT_RE de nova-billing
  });

  it('requête d’export : aucun élément du catalogue, aucun kit, portée mix', () => {
    expect(masterExportQuery('master:x')).toEqual({ projectKey: 'master:x', catalogIds: [], kits: false, scope: 'mix' });
  });

  it('prix affiché = grille du serveur (1,99 €), jamais en dur', async () => {
    const a = await masterExportAccess('master:x');
    expect(a).toMatchObject({ kind: 'pay', price: '1,99 €' });
    b.loadPricing.mockResolvedValue({ ...GRILLE, export: { cents: 250 } });
    expect((await masterExportAccess('master:x')).price).toBe('2,50 €');
    b.loadPricing.mockResolvedValue({ ...GRILLE, unavailable: true });
    expect((await masterExportAccess('master:x')).price).toBeNull();
  });

  it('admin, Nova Pro, déjà payé : libres, sans paiement', async () => {
    for (const [via, kind] of [['admin', 'admin'], ['pro', 'pro'], ['achat', 'unlocked']] as const) {
      b.exportAccess.mockResolvedValue(acces({ unlocked: true, via, reason: null }));
      expect((await masterExportAccess('master:x')).kind).toBe(kind);
      expect((await unlockMasterExport('master:x')).ok).toBe(true);
    }
    expect(b.startExportPayment).not.toHaveBeenCalled();
  });

  it('à payer : startExportPayment avec la clé du morceau et la grille, puis attente du paiement', async () => {
    b.startExportPayment.mockResolvedValue({ sessionId: 'cs_1' });
    b.waitPaid.mockResolvedValue(true);
    const waiting = vi.fn();
    const r = await unlockMasterExport('master:x', { onWaiting: waiting });
    expect(b.startExportPayment).toHaveBeenCalledWith(masterExportQuery('master:x'), GRILLE);
    expect(waiting).toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, via: 'paiement' });
    expect(b.forgetExportAccess).toHaveBeenCalledWith('master:x');
  });

  it('ancien serveur : crédit Nova Pro utilisé sans Stripe', async () => {
    b.startExportPayment.mockResolvedValue({ credit: true });
    expect(await unlockMasterExport('master:x', { access: { kind: 'pay', price: '2 €', loginRequired: false, grille: ANCIENNE_GRILLE } })).toMatchObject({ ok: true, via: 'credit' });
    expect(b.waitPaid).not.toHaveBeenCalled();
  });

  it('accès déjà lu : aucune requête avant Stripe (pas de fenêtre bloquée)', async () => {
    b.startExportPayment.mockResolvedValue({ sessionId: 'cs_2' });
    b.waitPaid.mockResolvedValue(true);
    await unlockMasterExport('master:y', { access: { kind: 'pay', price: '1,99 €', loginRequired: false, grille: GRILLE as any } });
    expect(b.exportAccess).not.toHaveBeenCalled();
    expect(b.loadPricing).not.toHaveBeenCalled();
  });

  it('connexion demandée, erreur réseau, paiement non reçu : rien de débloqué, message actionnable', async () => {
    b.exportAccess.mockResolvedValue(acces({ login_required: true }));
    expect((await unlockMasterExport('master:z')).message).toMatch(/Connecte-toi/);
    b.exportAccess.mockResolvedValue(acces({ reason: 'erreur', message: 'Vérification impossible (connexion ?).' }));
    expect(await unlockMasterExport('master:z')).toMatchObject({ ok: false, message: 'Vérification impossible (connexion ?).' });
    b.exportAccess.mockResolvedValue(acces({}));
    b.startExportPayment.mockResolvedValue({ sessionId: 'cs_3' });
    b.waitPaid.mockResolvedValue(false);
    expect(await unlockMasterExport('master:z')).toMatchObject({ ok: false });
    expect(b.forgetExportAccess).not.toHaveBeenCalled();
  });
});
