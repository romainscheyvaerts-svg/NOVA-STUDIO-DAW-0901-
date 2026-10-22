/** Panoramique -1…1 → « C », « G 30 », « D 100 ». */
export const panToText = (p: number): string => {
  const v = Math.round(p * 100);
  return v === 0 ? 'C' : v < 0 ? `G ${-v}` : `D ${v}`;
};

/**
 * Gain linéaire → texte en dB façon console (« -3.5 dB », « 0.0 dB », « -∞ »).
 * « -∞ » seulement quand le son est réellement coupé (sous −120 dB) : avant (22/10/2026),
 * tout ce qui était sous −80 dB s'affichait « -∞ » alors que le fader laissait passer le son.
 */
export const gainToDbText = (g: number): string => {
  if (!(g > 1e-6)) return '-∞';
  const db = 20 * Math.log10(g);
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
};
