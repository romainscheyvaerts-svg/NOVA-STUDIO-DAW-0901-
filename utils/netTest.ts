/**
 * Test de connexion avant la séance (B3) : verdict en français simple et prédiction
 * du temps d'arrivée d'une prise chez l'ingé.
 *
 * Mesures (services/NetTest) : aller-retour avec le serveur de la collaboration (petits
 * appels), pertes (appels sans réponse), débit montant (envoi d'un paquet de données à ce
 * même serveur, rien n'est enregistré). La prise part pendant l'enregistrement, par
 * morceaux de 1 s (utils/liveTake) : si le débit montant suit le flux de la prise, elle
 * arrive ~2 s après le STOP ; sinon le retard s'accumule pendant la prise.
 */

import { LT_SEGMENT_SEC } from './liveTake';

export interface NetMeasure {
  /** Débit montant mesuré (kbit/s). */
  upKbps: number;
  /** Aller-retour médian avec le serveur (ms). */
  rttMs: number;
  /** Appels sans réponse (%). */
  lossPct: number;
  /** Écart des allers-retours (ms) : connexion instable. */
  jitterMs?: number;
}

export interface TakeFormat { sampleRate: number; channels: number; /** Débit du flux codé (kbit/s) mesuré sur les dernières prises, s'il est connu. */ streamKbps?: number }

export type NetLevel = 'parfait' | 'ok' | 'faible';

export interface NetVerdict {
  level: NetLevel;
  title: string;
  advice: string;
  /** Temps d'arrivée d'une prise de 3 min chez l'ingé, après le STOP (s). */
  arrivalSec: number;
  arrivalText: string;
  /** Débit nécessaire (kbit/s) pour que la prise parte en direct. */
  needKbps: number;
}

export const VERDICT_TEXT: Record<NetLevel, string> = {
  parfait: 'Ta connexion est parfaite pour enregistrer',
  ok: 'Ça ira, mais évite de télécharger en même temps',
  faible: 'Connexion trop faible : rapproche-toi de la box ou passe en 4G',
};

/**
 * Débit du flux de la prise (kbit/s). Sans mesure : voix codée sans perte, environ
 * 9 bits par échantillon (un micro 16 bits avec des silences) — 430 kbit/s en mono à 48 kHz.
 */
export const streamKbpsOf = (f: TakeFormat): number => {
  if (f.streamKbps && f.streamKbps > 0) return f.streamKbps;
  return (f.sampleRate * Math.max(1, f.channels) * 9) / 1000;
};

/** Temps d'arrivée (s) d'une prise de `takeSec` après le STOP. */
export const arrivalAfterStop = (m: NetMeasure, f: TakeFormat, takeSec = 180): number => {
  const need = streamKbpsOf(f);
  const up = Math.max(1, m.upKbps);
  const rtt = Math.max(0, m.rttMs) / 1000;
  const loss = Math.min(0.9, Math.max(0, m.lossPct) / 100);
  // Fin de prise : envoi du dernier morceau puis annonce (l'adresse est demandée d'avance) ;
  // chez l'ingé : téléchargement, vérification, pose. Une perte = un nouvel essai.
  const perSeg = (2 * rtt + 0.4) / (1 - loss);
  const segBits = need * 1000 * LT_SEGMENT_SEC;
  // Le dernier morceau (~1 s de son) part au STOP, puis l'ingé le télécharge et pose la prise.
  const last = segBits / (up * 1000) + perSeg + 0.3;
  // Débit insuffisant : le retard pris pendant la prise s'ajoute.
  const totalBits = need * 1000 * takeSec;
  const backlog = Math.max(0, totalBits / (up * 1000) / (1 - loss) - takeSec);
  return Math.round((backlog + last) * 10) / 10;
};

const fmtDelay = (s: number): string => {
  if (s < 10) return `${Math.max(1, Math.round(s))} s`;
  if (s < 90) return `${Math.round(s / 5) * 5} s`;
  const t = Math.round(s / 10) * 10;
  const m = Math.floor(t / 60), r = t % 60;
  return r ? `${m} min ${r}` : `${m} min`;
};

/** Verdict à partir des mesures (même règle partout : écran de l'artiste, panneau Collaboration). */
export const judgeNetwork = (m: NetMeasure, f: TakeFormat): NetVerdict => {
  const need = streamKbpsOf(f);
  const arrival = arrivalAfterStop(m, f);
  let level: NetLevel;
  if (m.upKbps < need * 1.2 || m.lossPct >= 20 || m.rttMs > 800) level = 'faible';
  else if (m.upKbps >= need * 4 && m.rttMs <= 100 && m.lossPct === 0 && (m.jitterMs ?? 0) <= 60) level = 'parfait';
  else level = 'ok';
  const advice = level === 'parfait'
    ? 'Tes prises arriveront chez l’ingé presque tout de suite après le STOP.'
    : level === 'ok'
      ? 'Ferme les téléchargements et les vidéos sur les autres appareils de la maison pendant la séance.'
      : 'Le son partira quand même (rien n’est perdu), mais l’ingé attendra tes prises.';
  return {
    level, title: VERDICT_TEXT[level], advice,
    arrivalSec: arrival,
    arrivalText: `Une prise de 3 min arrivera chez l’ingé environ ${fmtDelay(arrival)} après le STOP.`,
    needKbps: Math.round(need),
  };
};

/** Médiane et écart (ms) d'une série d'allers-retours. */
export const rttStats = (rtts: number[]): { median: number; jitter: number } => {
  if (!rtts.length) return { median: 0, jitter: 0 };
  const s = [...rtts].sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)];
  const jitter = s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] - s[0];
  return { median: Math.round(median), jitter: Math.round(jitter) };
};
