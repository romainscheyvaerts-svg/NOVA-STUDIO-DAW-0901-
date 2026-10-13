import { useEffect, useState } from 'react';
import { euros, loadPricing, type Grille } from '../services/Billing';

/** Grille de prix lue sur le serveur (nova-billing « pricing ») ; null pendant le chargement. */
export function useNovaPricing(enabled = true): Grille | null {
  const [g, setG] = useState<Grille | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadPricing().then(x => { if (live) setG(x); });
    return () => { live = false; };
  }, [enabled]);
  return g;
}

/** « 9,99 €/mois » ; vide si les prix ne sont pas (encore) connus : jamais de prix inventé. */
export const proMoisTexte = (g: Grille | null) => (g && !g.unavailable ? `${euros(g.pro.mois_cents)}/mois` : '');
/** « 1,99 € » ; vide si inconnu. */
export const exportTexte = (g: Grille | null) => (g && !g.unavailable ? euros(g.export.cents) : '');
