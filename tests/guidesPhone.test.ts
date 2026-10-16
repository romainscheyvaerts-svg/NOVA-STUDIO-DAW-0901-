import { describe, expect, it } from 'vitest';
import { GUIDES, forPhone, guideById, projectFacts, stepText, stepsFor } from '../utils/guides';

describe('parcours au téléphone : ni Ctrl+K ni raccourcis clavier', () => {
  it('forPhone : Ctrl+K devient ☰ › « Chercher une action… », Ctrl+Z devient « Annuler », les autres raccourcis disparaissent', () => {
    expect(forPhone('Ouvre « Faire sa version » (Ctrl+K : « version »).')).toBe('Ouvre « Faire sa version » (☰ › « Chercher une action… » : « version »).');
    expect(forPhone('Lance « Importer un fichier audio » (Ctrl+K) et choisis ton beat.')).toBe('Lance « Importer un fichier audio » (☰ › « Chercher une action… ») et choisis ton beat.');
    expect(forPhone('Change de style pour comparer ; Ctrl+Z revient en arrière.')).toBe('Change de style pour comparer ; « Annuler » (☰) revient en arrière.');
    expect(forPhone('Ouvre « Sauvegarder » (Ctrl+S).')).toBe('Ouvre « Sauvegarder ».');
    expect(forPhone('Barre d’espace, ou ▶ en haut.')).toBe('▶ en haut.');
  });

  it('aucune étape montrée au téléphone ne parle de Ctrl, Alt ou Maj+', () => {
    const f = projectFacts({ tracks: [] }, { mobile: true, simple: true });
    for (const g of GUIDES) for (const s of stepsFor(g, f)) expect(s.shown, `${g.id} : « ${s.shown} »`).not.toMatch(/\b(Ctrl|Alt)\+|Maj\+/);
  });

  it('variante téléphone d’abord ; au bureau, le texte tel quel', () => {
    const exp = guideById('exporter')!.steps[0];
    expect(stepText(exp, true)).toBe(exp.phone);
    expect(stepText(exp, false)).toBe(exp.text);
  });

  it('« Faire sa version » et « Page publique » : l’étape de connexion n’apparaît que sans compte', () => {
    for (const id of ['faire-sa-version', 'page-publique']) {
      const g = guideById(id)!;
      const sans = stepsFor(g, projectFacts({ tracks: [] }, { loggedIn: false })).map(s => s.text);
      const avec = stepsFor(g, projectFacts({ tracks: [] }, { loggedIn: true })).map(s => s.text);
      expect(sans.some(t => t.startsWith('Connecte-toi'))).toBe(true);
      expect(avec.some(t => t.startsWith('Connecte-toi'))).toBe(false);
    }
  });

  it('Collaborer, Réglages audio, Sauvegarder : l’anneau vise l’entrée précise du menu ☰ avant « Plus d’outils »', () => {
    const t = (id: string) => [guideById(id)!.steps[0].target].flat().join(' ');
    expect(t('collab')).toMatch(/menu-collab.*menu-plus-toggle/);
    expect(t('micro-latence')).toMatch(/menu-audio.*menu-plus-toggle/);
    expect(t('sauvegarder')).toContain('menu-save');
    expect(t('exporter')).toContain('menu-export');
    expect(t('sauvegarder') + t('exporter')).not.toContain('menu-fichiers');
  });
});
