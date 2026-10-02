/** Gain linéaire → texte en dB façon console (« -3.5 dB », « 0.0 dB », « -∞ »). */
export const gainToDbText = (g: number): string => {
  if (!(g > 0.0001)) return '-∞';
  const db = 20 * Math.log10(g);
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
};
