/**
 * « Tu as un casque ? » avant la 1re prise : détection automatique quand le navigateur
 * le permet. Chrome / Edge (et l'appli Windows) listent les sorties audio avec leur nom
 * une fois le micro autorisé (il l'est : la piste vient d'être armée). Le nom de la
 * sortie par défaut suffit souvent : « Casque (Realtek) », « AirPods », « Haut-parleurs
 * (Realtek) », « Focusrite USB »… Nom ambigu ou navigateur muet (Safari, Firefox) : on
 * pose la question (un seul toucher, mémorisé sur l'appareil).
 */

export type HeadphoneGuess = 'casque' | 'haut-parleurs';

const HEADPHONES = /(casque|headphone|headset|écouteur|ecouteur|earphone|earbud|airpods|buds|bose qc|wh-1000|sony wf|jabra|beats|kopfh[öo]rer|auricular|cuffie)/i;
// Carte son de studio : on y branche un casque (retour), jamais des enceintes sans retour coupé à la main.
const INTERFACE = /(focusrite|scarlett|clarett|apollo|universal audio|\buad\b|volt \d|rme|fireface|babyface|motu|audient|\bid\d+\b|ssl \d|steinberg|ur\d{2}|presonus|audiobox|behringer|umc\d+|arturia|minifuse|komplete audio|zoom u|asio)/i;
const SPEAKERS = /(haut-parleur|haut parleur|speaker|enceinte|lautsprecher|altavoz|altoparlant|monitor|écran|hdmi|displayport|tv\b|\bnvidia high definition)/i;

/** Devine la nature d'une sortie d'après son nom (null : on ne sait pas). */
export function classifyOutputLabel(label: string | null | undefined): HeadphoneGuess | null {
  const l = (label || '').trim();
  if (!l) return null;
  if (HEADPHONES.test(l)) return 'casque';
  // Windows nomme « Haut-parleurs (Focusrite USB Audio) » la sortie d'une carte son : la carte gagne.
  if (INTERFACE.test(l)) return 'casque';
  if (SPEAKERS.test(l)) return 'haut-parleurs';
  return null;
}

export interface OutputDevice { deviceId: string; kind: string; label: string }

/** Sortie réellement utilisée : celle choisie dans NOVA, sinon « default » (Chrome), sinon la 1re. */
export function pickOutput(devices: OutputDevice[], chosenId?: string | null): OutputDevice | null {
  const outs = devices.filter(d => d.kind === 'audiooutput');
  if (!outs.length) return null;
  return outs.find(d => chosenId && d.deviceId === chosenId) || outs.find(d => d.deviceId === 'default') || outs[0];
}

/** Détection (≤ 400 ms) : null si le navigateur ne donne pas de nom ou si le nom est ambigu. */
export async function detectHeadphones(chosenOutputId?: string | null): Promise<{ guess: HeadphoneGuess; label: string } | null> {
  try {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md?.enumerateDevices) return null;
    const list = await Promise.race([
      md.enumerateDevices(),
      new Promise<MediaDeviceInfo[]>(resolve => setTimeout(() => resolve([]), 400)),
    ]);
    const out = pickOutput(list.map(d => ({ deviceId: d.deviceId, kind: d.kind, label: d.label })), chosenOutputId);
    // « Par défaut - Casque (Realtek) » : on juge le vrai nom.
    const label = (out?.label || '').replace(/^(par défaut|default|défaut)\s*[-–:]\s*/i, '');
    const guess = classifyOutputLabel(label);
    return guess ? { guess, label } : null;
  } catch {
    return null;
  }
}
