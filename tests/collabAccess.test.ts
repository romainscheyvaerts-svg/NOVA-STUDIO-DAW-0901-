import { describe, expect, it } from 'vitest';
import { collabRefusal, remoteNeedsPro, MSG_HOST_NOT_PRO, MSG_OLD_SERVER_GUEST, MSG_SESSION_FULL } from '../utils/collabAccess';

describe('Lot 3 · invité gratuit : refus de la collaboration', () => {
  it("un invité n'est JAMAIS envoyé vers l'abonnement", () => {
    for (const err of [
      { status: 402, reason: 'host_not_pro', message: "L'hôte de cette séance n'a plus Nova Pro" },
      { status: 402, message: 'Abonnement collaboration requis (5 €/mois)' }, // ancien serveur
      { status: 402, message: 'Nova Pro requis' },
    ]) {
      const r = collabRefusal(err, false);
      expect(r?.gate).toBeNull();
      expect(r?.message).not.toMatch(/abonne-toi|5 €/i);
      expect(r?.message).toMatch(/rien à payer/);
    }
    expect(collabRefusal({ status: 402, reason: 'host_not_pro' }, false)?.message).toBe(MSG_HOST_NOT_PRO);
    expect(collabRefusal({ status: 402, message: 'Abonnement collaboration requis (5 €/mois)' }, false)?.message).toBe(MSG_OLD_SERVER_GUEST);
  });

  it("l'hôte sans Nova Pro voit la carte Nova Pro ; connexion demandée à tous", () => {
    expect(collabRefusal({ status: 402, reason: 'host_pro' }, true)).toEqual({ gate: 'subscribe', message: null });
    expect(collabRefusal({ status: 402, message: 'Abonnement collaboration requis (5 €/mois)' }, true)?.gate).toBe('subscribe');
    expect(collabRefusal({ status: 401, message: 'Connecte-toi à ton compte Make Music pour collaborer' }, false)?.gate).toBe('login');
    expect(collabRefusal({ message: 'Connecte-toi à ton compte' }, true)?.gate).toBe('login');
  });

  it('séance complète, codes faux, erreurs inconnues', () => {
    expect(collabRefusal({ status: 429, reason: 'session_full' }, false)?.message).toBe(MSG_SESSION_FULL);
    expect(collabRefusal({ status: 429, reason: 'code_attempts' }, false)?.message).toMatch(/une heure/);
    expect(collabRefusal({ status: 404, message: 'Code introuvable ou expiré' }, false)).toBeNull();
    expect(collabRefusal({ message: 'Failed to fetch' }, true)).toBeNull();
    expect(collabRefusal(null, false)).toBeNull();
  });

  it('« Ingé à distance » : Nova Pro seulement pour l’artiste qui crée le lien', () => {
    expect(remoteNeedsPro('artist', true)).toBe(true);
    expect(remoteNeedsPro('artist', false)).toBe(false);
    expect(remoteNeedsPro('engineer', true)).toBe(false);
    expect(remoteNeedsPro(undefined, true)).toBe(false);
  });
});
