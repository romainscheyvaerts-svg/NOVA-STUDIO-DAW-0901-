/**
 * Préréglages de Nova Tune : UNIQUEMENT des recettes publiées et sourcées (règle de Romain),
 * détaillées dans CONTENU/nova-tune/RECHERCHE.md (sections B.4 et C.2). Noms génériques, sans
 * marque. Quand la source donne une plage, la valeur retenue est dans la plage (`plage`).
 *
 * Vitesse : les ms des recettes sont celles des correcteurs du marché. Pour la référence
 * mesurée en boîte noire (22/10/2026), ces ms sont la demi-vie de l'écart, convention que Nova
 * Tune affiche désormais (utils/tuneSpeed.ts) : une recette « 20 » se règle à 20 ms ici.
 * Pour les deux autres éditeurs, la définition exacte de leurs ms n'est pas publiée : même
 * conversion, signalée dans `note`.
 *
 * Un préréglage ne touche ni à la tonalité ni à la gamme (celles du projet), ni au formant /
 * à la transposition (effets de création, réglés à part).
 */
import { speedFromRetuneMs } from './tuneSpeed';

export interface NovaTunePreset {
  id: string;
  name: string;
  /** Une phrase pour l'artiste (aide au survol). */
  hint: string;
  /** Temps de correction de la recette (ms) et plage publiée. */
  ms: number;
  plage?: [number, number];
  humanize: number;
  flex: number;
  vibrato: number;
  mix: number;
  sources: { titre: string; url: string }[];
  note?: string;
}

const S = {
  uad: { titre: 'Manuel Auto-Tune Realtime Advanced (UAD), p. 26-27', url: 'https://media.uaudio.com/support/manuals/dd/Auto-Tune%20Realtime%20Advanced%20Manual.pdf' },
  evo: { titre: 'Blog Antares, « How to get that classic EVO sound » (27/01/2026)', url: 'https://www.antarestech.com/blog/how-to-get-that-classic-evo-sound-with-autotune-2026' },
  trap: { titre: 'Blog Antares, B. Davitt, « AutoTune for Rap & Hip-Hop » (20/08/2026)', url: 'https://www.antarestech.com/blog/auto-tune-for-rap-hip-hop-how-trap-producers-use-pitch-correction' },
  kesha: { titre: 'Sound On Sound, Inside Track Lil Uzi Vert (Kesha Lee, 12/2017)', url: 'https://www.soundonsound.com/techniques/inside-track-lil-uzi-vert' },
  teezio: { titre: 'Sound On Sound, Inside Track Chris Brown (Teezio Pigliapoco, 09/2019)', url: 'https://www.soundonsound.com/techniques/inside-track-chris-brown-heat' },
  artist: { titre: 'Manuel Auto-Tune Artist, p. 9-10', url: 'https://www.barryrudolph.com/recall/manuals/auto-tune_artist.pdf' },
  rudolph: { titre: 'Barry Rudolph, test Auto-Tune Artist (Mix)', url: 'https://barryrudolph.com/newtoys/toys19/antares_auto-tune_artist.html' },
  walden: { titre: 'Sound On Sound, J. Walden, « Creative Pitch Processing » (12/2015)', url: 'https://www.soundonsound.com/techniques/creative-pitch-processing' },
  waves: { titre: 'Manuel Waves Tune Real-Time (v16), p. 8-13 (valeurs par défaut)', url: 'https://assets.wavescdn.com/pdf/plugins/tune-real-time-v16-update.pdf' },
};

export const NOVA_TUNE_PRESETS: NovaTunePreset[] = [
  { id: 'robot', name: 'Robot (effet dur)', hint: 'La note saute d’un coup : l’effet autotune marqué du rap. Vitesse 0, Flex 0, naturel 0.',
    ms: 0, humanize: 0, flex: 0, vibrato: 0, mix: 1, sources: [S.uad, S.evo] },
  { id: 'trap-dur', name: 'Trap dur', hint: 'Effet marqué qui laisse passer un soupçon d’attaque. Plage publiée 0–5 ms.',
    ms: 3, plage: [0, 5], humanize: 0, flex: 0, vibrato: 0, mix: 1, sources: [S.trap] },
  { id: 'rap-serre', name: 'Rap serré', hint: 'Correction rapide entendue au casque pendant la prise (ingénieure de studio, 12 à 5 ms).',
    ms: 8, plage: [5, 12], humanize: 0, flex: 0, vibrato: 0, mix: 1, sources: [S.kesha] },
  { id: 'rnb-serre', name: 'R&B serré', hint: 'Chant R&B tenu juste, encore humain (11 à 13 ms selon l’ingénieur).',
    ms: 12, plage: [11, 13], humanize: 0, flex: 0, vibrato: 0, mix: 1, sources: [S.teezio] },
  { id: 'trap-melodique', name: 'Trap mélodique', hint: 'Effet présent mais chanté. Plage publiée 10–25 ms.',
    ms: 15, plage: [10, 25], humanize: 0, flex: 0, vibrato: 0, mix: 1, sources: [S.trap] },
  { id: 'rap-melodique', name: 'Rap mélodique', hint: 'Flow chanté calé sur la tonalité du morceau. Plage publiée 15–20 ms.',
    ms: 18, plage: [15, 20], humanize: 0, flex: 0, vibrato: 0, mix: 1, sources: [S.trap] },
  { id: 'naturel', name: 'Naturel', hint: 'Justesse corrigée sans effet audible. Plage publiée 10–50 ms.',
    ms: 30, plage: [10, 50], humanize: 0, flex: 0, vibrato: 0, mix: 1, sources: [S.artist] },
  { id: 'naturel-expressif', name: 'Naturel expressif', hint: 'Garde les glissés et l’expression : seules les notes proches de la cible sont corrigées (vitesse 35, Flex 61).',
    ms: 35, humanize: 0, flex: 0.61, vibrato: 0, mix: 1, sources: [S.rudolph] },
  { id: 'transparent', name: 'Transparent', hint: 'Correction lente, presque inaudible. Plage publiée 40–80 ms.',
    ms: 60, plage: [40, 80], humanize: 0, flex: 0, vibrato: 0, mix: 1, sources: [S.evo] },
  { id: 'naturel-doux', name: 'Naturel doux', hint: 'Correction douce des notes tenues (vitesse 90, naturel 50 %).',
    ms: 90, humanize: 0.5, flex: 0, vibrato: 0, mix: 1, sources: [S.walden] },
  { id: 'equilibre-vibrato', name: 'Équilibré, vibrato gardé', hint: 'Réglage d’usine d’un correcteur du marché : 15 ms, vibrato chanté conservé à 100 %.',
    ms: 15, humanize: 0, flex: 0, vibrato: 1, mix: 1, sources: [S.waves],
    note: 'Définition exacte des ms de cet éditeur non publiée : convertie comme la référence mesurée.' },
];

/** Réglages Nova Tune d'un préréglage (vitesse convertie, tonalité et gamme laissées). */
export function novaTunePresetParams(p: NovaTunePreset): { speed: number; humanize: number; flex: number; vibrato: number; mix: number } {
  return { speed: speedFromRetuneMs(p.ms), humanize: p.humanize, flex: p.flex, vibrato: p.vibrato, mix: p.mix };
}
