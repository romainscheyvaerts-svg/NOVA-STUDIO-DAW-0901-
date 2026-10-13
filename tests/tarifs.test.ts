// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Grille du 14/10 côté DAW : prix lus sur le serveur (jamais en dur), décision d'export
 * demandée au serveur, repli propre sur l'ancienne grille (aucune erreur « Produit inconnu »),
 * contenu du projet envoyé (instrus du catalogue, kits), anti-enregistrement d'écran.
 */
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../services/supabase', () => ({ catalogSupabase: { functions: { invoke: h.invoke }, auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } } }));
vi.mock('../utils/analytics', () => ({ track: vi.fn() }));

import {
  ANCIENNE_GRILLE, euros, exportAccess, forgetExportAccess, hasPlan, loadPricing, productFor, resetPricingCache, startExportPayment,
} from '../services/Billing';
import { catalogIdsOf, projectUsesKits } from '../utils/exportProject';
import { onRecordersChange, recordersRunning, reportRecorders, setSecureScreen, unboughtCatalog } from '../utils/captureGuard';

const ok = (data: unknown) => ({ data, error: null });
const ko = (message: string, body?: unknown) => ({ data: null, error: { message, context: body === undefined ? undefined : { json: async () => body } } });
const GRILLE_SERVEUR = {
  version: '2026-10-14', currency: 'eur', export: { cents: 199 },
  pro: { mois_cents: 999, an_cents: 8900, economie_an_cents: 3088, economie_an_pourcent: 26, stockage_go: 20, melodies_offertes_par_mois: 1 },
  cadeaux: { instru_jours: 30, melodie_jours: 7, melodie_exclusive_jours: 30, studio_jours: 30 },
  gratuit: { projets_en_ligne: 1, projet_jours: 7, extrait_secondes: 30, export: false },
};

beforeEach(() => { h.invoke.mockReset(); resetPricingCache(); forgetExportAccess('projet-abc'); });

describe('prix lus sur le serveur', () => {
  it('« pricing » : la grille du serveur, gardée en cache', async () => {
    h.invoke.mockResolvedValue(ok(GRILLE_SERVEUR));
    const g = await loadPricing();
    expect(g).toMatchObject({ legacy: false, version: '2026-10-14', export: { cents: 199 }, pro: { mois_cents: 999, an_cents: 8900, economie_an_cents: 3088 } });
    await loadPricing();
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith('nova-billing', { body: { action: 'pricing' } });
    expect(productFor(g, 'export')).toBe('export_project');
    expect(productFor(g, 'pro_month')).toBe('pro_month');
    expect(productFor(g, 'pro_year')).toBe('pro_year');
  });

  it('serveur pas à jour (« Action inconnue ») : ancienne grille et anciens produits, pas d’annuel', async () => {
    h.invoke.mockResolvedValue(ko('non-2xx', { error: 'Action inconnue' }));
    const g = await loadPricing();
    expect(g).toEqual(ANCIENNE_GRILLE);
    expect(productFor(g, 'export')).toBe('export_voices');
    expect(productFor(g, 'pro_month')).toBe('collab');
    expect(productFor(g, 'pro_year')).toBeNull();
  });

  it('hors ligne : « prix indisponibles », redemandé la fois suivante', async () => {
    h.invoke.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(ok(GRILLE_SERVEUR));
    expect((await loadPricing()).unavailable).toBe(true);
    expect((await loadPricing()).unavailable).toBeUndefined();
  });

  it('euros : 1,99 € ; 9,99 € ; 89 €', () => {
    expect([euros(199), euros(999), euros(8900), euros(3088), euros(null)]).toEqual(['1,99 €', '9,99 €', '89 €', '30,88 €', '—']);
  });

  it('Nova Pro offert (cadeau) compte comme Pro ; ancien abonnement beatmaker garde l’import', () => {
    expect(hasPlan({ plans: [], admin: false, pro: { active: true } as any }, 'collab')).toBe(true);
    expect(hasPlan({ plans: [], admin: false, features: { import_instrus: true } as any }, 'beatmaker')).toBe(true);
    expect(hasPlan({ plans: [], admin: false, pro: { active: false } as any }, 'collab')).toBe(false);
  });
});

describe("export : le serveur décide", () => {
  const q = { projectKey: 'projet-abc', catalogIds: ['beat-1'], kits: false, scope: 'mix' as const, owned: [] };

  it('envoie le contenu du projet (catalogue, kits, portée) et rend la réponse du serveur', async () => {
    h.invoke.mockResolvedValue(ok({ unlocked: false, via: null, reason: 'catalogue_non_achete', missing: [{ id: 'beat-1', title: 'Nuit', kind: 'beat' }], login_required: false, kits: false, pro: null }));
    const a = await exportAccess(q);
    expect(h.invoke).toHaveBeenCalledWith('nova-billing', { body: { action: 'export_access', project_key: 'projet-abc', catalog_ids: ['beat-1'], kits: false, scope: 'mix' } });
    expect(a).toMatchObject({ unlocked: false, reason: 'catalogue_non_achete', legacy: false });
  });

  it('débloqué : en mémoire (jamais dans le navigateur) ; refus : redemandé', async () => {
    h.invoke.mockResolvedValue(ok({ unlocked: false, reason: 'paiement', missing: [] }));
    await exportAccess(q); await exportAccess(q);
    expect(h.invoke).toHaveBeenCalledTimes(2);
    h.invoke.mockReset();
    h.invoke.mockResolvedValue(ok({ unlocked: true, via: 'licence', missing: [] }));
    await exportAccess(q); await exportAccess(q);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
  });

  it('erreur réseau : bloqué avec un message actionnable (rien débloqué)', async () => {
    h.invoke.mockRejectedValue(new Error('offline'));
    const a = await exportAccess(q);
    expect(a).toMatchObject({ unlocked: false, reason: 'erreur' });
    expect(a.message).toMatch(/Réessaie/);
  });

  it('ancien serveur : ancienne règle rejouée (licence achetée → mix ; sinon payant), sans « Produit inconnu »', async () => {
    h.invoke.mockImplementation(async (_fn: string, { body }: any) => {
      if (body.action === 'export_access') return ko('non-2xx', { error: 'Action inconnue' });
      if (body.action === 'status') return ok({ plans: [], admin: false });
      if (body.action === 'export_unlocked') return ok({ unlocked: false });
      return ko('non-2xx', { error: 'Action inconnue' });
    });
    expect(await exportAccess({ ...q, owned: ['beat-1'] })).toMatchObject({ unlocked: true, via: 'licence', legacy: true });
    expect(await exportAccess({ ...q, owned: [] })).toMatchObject({ unlocked: false, reason: 'catalogue_non_achete', legacy: true });
    expect(await exportAccess({ ...q, catalogIds: [], owned: [] })).toMatchObject({ unlocked: false, reason: 'paiement', legacy: true });
  });

  it('payer : « export_project » + contenu du projet (nouvelle grille) ; « export_voices » (ancienne)', async () => {
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    h.invoke.mockResolvedValue(ok({ url: 'https://checkout.stripe.test/x', session_id: 'cs_1' }));
    const nouvelle = { ...ANCIENNE_GRILLE, legacy: false, version: '2026-10-14', export: { cents: 199 } };
    await expect(startExportPayment({ ...q, catalogIds: [] }, nouvelle)).resolves.toEqual({ sessionId: 'cs_1' });
    expect(h.invoke.mock.calls[0][1].body).toMatchObject({ action: 'checkout', product: 'export_project', project_key: 'projet-abc', scope: 'mix' });
    h.invoke.mockReset();
    h.invoke.mockImplementation(async (_fn: string, { body }: any) => body.action === 'use_export_credit'
      ? ok({ unlocked: false, remaining: 0, reason: 'not_pro' }) : ok({ url: 'https://checkout.stripe.test/y', session_id: 'cs_2' }));
    await startExportPayment({ ...q, catalogIds: [] }, ANCIENNE_GRILLE);
    expect(h.invoke.mock.calls.map(c => c[1].body.product).filter(Boolean)).toEqual(['export_voices']);
  });
});

describe('contenu du projet envoyé au serveur', () => {
  it('identifiants du catalogue (sans doublon, en texte)', () => {
    expect(catalogIdsOf([{ instrumentId: 'b2' }, { instrumentId: 12 }, {}, { instrumentId: '' }, { instrumentId: 'b2' }] as any)).toEqual(['12', 'b2']);
  });
  it('kits de batterie NOVA : pads « kit: » ou sampler chargé depuis un kit', () => {
    expect(projectUsesKits([{ drumMachine: { rows: [{ sound: 'kick-808' }] } }] as any)).toBe(false);
    expect(projectUsesKits([{ drumMachine: { rows: [{ sound: 'kit:trap-0a1b2c3d' }] } }] as any)).toBe(true);
    expect(projectUsesKits([{ melodicSampler: { kitRef: 'kit:pno-12345678' } }] as any)).toBe(true);
  });
});

describe('anti-enregistrement d’écran (DAW)', () => {
  it('liste reçue de l’appli (Windows / iPhone), signalée une fois, nettoyée', () => {
    const seen: string[][] = [];
    const off = onRecordersChange(l => seen.push(l));
    (window as any).__novaCaptureGuard(['OBS Studio', 'OBS Studio', '', 42]);
    expect(recordersRunning()).toEqual(['OBS Studio', '42']);
    reportRecorders(['OBS Studio', '42']); // inchangé : pas de nouvel appel
    reportRecorders([]);
    expect(seen).toEqual([['OBS Studio', '42'], []]);
    off();
  });
  it('instrus non achetées du projet', () => {
    const tracks = [{ instrumentId: 'a', name: 'A' }, { instrumentId: 'b', name: 'B' }, { name: 'Voix' }];
    expect(unboughtCatalog(tracks, ['a']).map(t => t.name)).toEqual(['B']);
  });
  it('Android : window.NovaSecure.secure appelé une seule fois par fenêtre', () => {
    const secure = vi.fn();
    (window as any).NovaSecure = { secure };
    setSecureScreen(true);
    expect(secure).toHaveBeenCalledTimes(1);
    expect(secure).toHaveBeenCalledWith(true);
    delete (window as any).NovaSecure;
  });
});
