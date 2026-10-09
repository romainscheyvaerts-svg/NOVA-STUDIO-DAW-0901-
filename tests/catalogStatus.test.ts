// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogStatus, isQuotaError, retryDelay, outageMessage, formatWait, classifyError } from '../utils/catalogStatus';

beforeEach(() => { localStorage.clear(); catalogStatus.reset(); vi.restoreAllMocks(); });

describe('catalogue indisponible (quota Supabase, panne)', () => {
  it('reconnaît la restriction de quota (402, exceed_egress_quota)', () => {
    expect(isQuotaError(402)).toBe(true);
    expect(isQuotaError(500, 'Service for this project is restricted due to the following violations: exceed_egress_quota')).toBe(true);
    expect(isQuotaError(500, 'boom')).toBe(false);
    expect(classifyError(new Error('Failed to fetch'))).toBe('offline');
  });

  it('délai croissant entre deux essais, plafonné (jamais de boucle)', () => {
    const d = [1, 2, 3, 4, 5, 6, 7, 8].map(n => retryDelay('quota', n));
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1]);
    expect(d[0]).toBeGreaterThanOrEqual(60_000);
    expect(d[d.length - 1]).toBe(3_600_000);
  });

  it('pendant le délai : pas d\'essai ; après : essai permis ; succès : tout repart', () => {
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    const o = catalogStatus.fail(Object.assign(new Error('HTTP 402'), { status: 402 }), 402);
    expect(o.kind).toBe('quota');
    expect(catalogStatus.canTry(t0 + 1000)).toBe(false);
    expect(catalogStatus.canTry(t0 + retryDelay('quota', 1))).toBe(true);
    catalogStatus.fail(new Error('x'), 402);
    expect(catalogStatus.get()!.attempts).toBe(2);
    expect(catalogStatus.msUntilRetry(t0)).toBe(retryDelay('quota', 2));
    catalogStatus.ok();
    expect(catalogStatus.get()).toBeNull();
    expect(catalogStatus.canTry()).toBe(true);
  });

  it('l\'état survit au rechargement de la page (pas de rafale en rechargeant)', async () => {
    catalogStatus.fail(new Error('x'), 402);
    expect(JSON.parse(localStorage.getItem('nova_catalog_outage')!).kind).toBe('quota');
  });

  it('message clair pour l\'utilisateur', () => {
    const q = outageMessage({ kind: 'quota', since: 0, attempts: 1, retryAt: 0, detail: '' });
    expect(q.title).toBe('Le catalogue est momentanément indisponible.');
    expect(q.hint).toMatch(/propres fichiers/);
    expect(formatWait(90_000)).toBe('1 min 30');
    expect(formatWait(12_000)).toBe('12 s');
  });
});
