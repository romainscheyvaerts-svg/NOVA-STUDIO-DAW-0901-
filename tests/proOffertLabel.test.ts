import { describe, expect, it } from 'vitest';
import { joursOffertsLabel, SANS_LIMITE_JOURS } from '../components/NovaProPlans';

describe('Nova Pro offert : libellé de durée', () => {
  it('décompte les jours pour un cadeau ordinaire', () => {
    expect(joursOffertsLabel(1)).toBe('dernier jour');
    expect(joursOffertsLabel(30)).toBe('30 jours restants');
    expect(joursOffertsLabel(SANS_LIMITE_JOURS)).toBe(`${SANS_LIMITE_JOURS} jours restants`);
  });
  it('affiche « sans limite » pour un cadeau à vie du studio', () => {
    expect(joursOffertsLabel(30 * 365)).toBe('sans limite');
  });
});
