/* -----------------------------------------------------------------------------
 * Défi du jour : la même prod pour tout le monde, qui change chaque jour à
 * minuit (heure de Bruxelles), sans serveur. Choix déterministe à partir de la
 * date, sur la liste triée des prods actives. Copie conforme de
 * studiomakemusic/src/lib/dailyChallenge.ts : le site et le DAW doivent tomber
 * sur la même prod.
 * -------------------------------------------------------------------------- */

export const todayKey = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Brussels" }); // YYYY-MM-DD

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

/** Identifiant de la prod du défi du jour parmi `ids`. */
export function dailyChallengeId(ids: string[], day = todayKey()): string | null {
  if (!ids.length) return null;
  const sorted = [...ids].sort();
  return sorted[hash(`mm-defi-${day}`) % sorted.length];
}
