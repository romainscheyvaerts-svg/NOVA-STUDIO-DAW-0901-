import { describe, expect, it } from 'vitest';
import { isImportantNotice } from '../components/MobileNoticeInline';

describe('téléphone : messages importants posés dans la page Morceau', () => {
  it('erreurs et blocages : affichés', () => {
    expect(isImportantNotice("🎤 Micro bloqué par le navigateur : clique sur le cadenas 🔒 à gauche de l'adresse du site, mets « Micro » sur « Autoriser », puis réappuie sur REC.")).toBe(true);
    expect(isImportantNotice('🎤 Aucun micro détecté : branche un micro (ou des écouteurs avec micro) puis réappuie sur REC.')).toBe(true);
    expect(isImportantNotice('❌ Sauvegarde en ligne impossible : vérifie ta connexion internet, puis réessaie.')).toBe(true);
    expect(isImportantNotice('⚠️ Session en ligne impossible à ouvrir : lien invalide')).toBe(true);
    expect(isImportantNotice('⏺️ Arrête la prise en cours avant d’ajouter une piste.')).toBe(true);
    expect(isImportantNotice('Connecte-toi d’abord avec ton compte Make Music, puis entre le code.')).toBe(true);
  });

  it('annonces de routine : restent dans le fil de Nova', () => {
    expect(isImportantNotice('✅ Projet "Mon son" sauvegardé dans le cloud')).toBe(false);
    expect(isImportantNotice('🎚️ Style « Rap clair » appliqué.')).toBe(false);
    expect(isImportantNotice('🥁 Squelette Trap posé : batterie, 808 et accords. Ctrl+Z pour annuler.')).toBe(false);
    expect(isImportantNotice('')).toBe(false);
    expect(isImportantNotice(null)).toBe(false);
  });
});
