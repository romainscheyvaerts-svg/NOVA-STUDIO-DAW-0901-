import { describe, expect, it } from 'vitest';
import { MSG, estTechnique, messageClair } from '../utils/friendlyError';

describe('messageClair : erreurs en français simple, qui disent quoi faire', () => {
  it('réseau coupé ou serveur muet', () => {
    expect(messageClair(new TypeError('Failed to fetch'))).toBe(MSG.reseau);
    expect(messageClair(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(MSG.reseau);
    expect(messageClair({ status: 503, message: 'Service Unavailable' })).toBe(MSG.serviceIndispo);
  });

  it('compte : identifiants, e-mail non confirmé, déjà inscrit, mot de passe, essais, connexion expirée', () => {
    expect(messageClair({ status: 400, message: 'Invalid login credentials' })).toBe(MSG.identifiants);
    expect(messageClair(new Error('Email not confirmed'))).toBe(MSG.emailNonConfirme);
    expect(messageClair(new Error('User already registered'))).toBe(MSG.dejaInscrit);
    expect(messageClair(new Error('Password should be at least 6 characters.'))).toBe(MSG.motDePasseCourt);
    expect(messageClair({ status: 429, message: 'Request rate limit reached' })).toBe(MSG.tropDEssais);
    expect(messageClair(new Error('JWT expired'))).toBe(MSG.sessionExpiree);
  });

  it('micro et stockage du navigateur', () => {
    expect(messageClair(new DOMException('Permission denied', 'NotAllowedError'))).toBe(MSG.microBloque);
    expect(messageClair(new DOMException('Requested device not found', 'NotFoundError'))).toBe(MSG.microAbsent);
    expect(messageClair(new DOMException('Could not start audio source', 'NotReadableError'))).toBe(MSG.microOccupe);
    expect(messageClair(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))).toBe(MSG.stockagePlein);
  });

  it('un message déjà écrit pour l’artiste passe tel quel', () => {
    expect(messageClair(new Error('Ce beat n’a pas de fichier audio disponible.'))).toBe('Ce beat n’a pas de fichier audio disponible.');
    expect(messageClair(new Error('Bus introuvable.'))).toBe('Bus introuvable.');
  });

  it('une phrase technique inconnue est remplacée par le repli de l’écran', () => {
    expect(messageClair(new Error('Cannot read properties of undefined (reading "x")'), 'Sauvegarde impossible : réessaie.')).toBe('Sauvegarde impossible : réessaie.');
    expect(messageClair(new Error('new row violates row-level security policy for table "sessions"'), 'Envoi impossible : réessaie.')).toBe('Envoi impossible : réessaie.');
    expect(messageClair(new SyntaxError('Unexpected token < in JSON at position 0'))).toBe(MSG.reponseBizarre);
    expect(messageClair(null, 'Repli.')).toBe('Repli.');
    expect(messageClair('{"code":500}', 'Repli.')).toBe('Repli.');
  });

  it('estTechnique : anglais ou brut = technique ; français = pour l’artiste', () => {
    expect(estTechnique('Failed to load the session')).toBe(true);
    expect(estTechnique('')).toBe(true);
    expect(estTechnique('Code inconnu ou expiré : demande un nouveau code.')).toBe(false);
    expect(estTechnique('Pas de lien')).toBe(false);
  });
});
