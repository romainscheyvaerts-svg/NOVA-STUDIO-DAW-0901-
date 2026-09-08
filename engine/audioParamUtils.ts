/**
 * Fige un gain a sa valeur COURANTE avant une rampe de relachement.
 *
 * Lire gain.value renvoie la valeur intrinseque du parametre (1.0 par defaut),
 * pas la valeur automatisee en cours : ancrer la rampe dessus faisait sauter le
 * gain a pleine echelle et produisait un clic a chaque fin de note.
 */
export const figerGain = (gain: AudioParam, t: number) => {
  const p = gain as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
  if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(t);
  else gain.cancelScheduledValues(t);
};
