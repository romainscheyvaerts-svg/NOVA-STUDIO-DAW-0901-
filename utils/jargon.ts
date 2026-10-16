/**
 * Mots du métier expliqués en une phrase, pour les infobulles (title) là où l'interface les affiche.
 * Un débutant (rappeur, première séance) doit comprendre sans chercher sur internet.
 */
export const JARGON = {
  lufs: 'LUFS : le volume moyen ressenti, mesuré comme le font Spotify, Apple Music ou YouTube (−14 LUFS ≈ le niveau de Spotify).',
  dbtp: 'dBTP (crête vraie) : le point le plus fort du son. Sous −1 dBTP, le MP3 des plateformes ne sature pas.',
  lra: 'LRA : l’écart entre les passages calmes et les passages forts du morceau.',
  pdc: 'PDC (calage de latence) : NOVA retarde les autres pistes pour que les effets lents restent pile en rythme. Laisse-le allumé.',
  bus: 'Bus : une piste de regroupement où plusieurs pistes se mélangent (toutes les voix, par exemple) pour les régler ensemble.',
  envoi: 'Envoi : une partie du son de la piste part vers un effet partagé (réverb, delay), sans toucher au son d’origine.',
  insert: 'Insert : un effet posé directement sur la piste (égaliseur, compresseur, autotune…), dans l’ordre de la liste.',
} as const;

/** Infobulle des cibles de volume (LUFS · dBTP) du mastering. */
export const LOUDNESS_TITLE = `${JARGON.lufs}\n${JARGON.dbtp}`;
