import type { AIAction, DAWState } from '../types';
import { parseMixIntent } from './mixStyles';
import { isVoiceTrack } from './vocalRoles';

/**
 * Phrases de l'artiste qui pilotent les plugins VST du PC (sans l'IA), quand le
 * pont VST est connecté : mix par style (« mix spatial et saturé avec beaucoup de
 * delay », « un mix neutre », « rends ma voix plus pro », « plus d'air », « moins de
 * sifflantes », « mets un compresseur sur ma voix »), liste des plugins, lecture et
 * réglage d'un paramètre, retrait d'un plugin. Exécuté par services/NovaVstMix.
 */
export interface VstCommandResult { text: string; actions: AIAction[] }

const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’'-]/g, ' ').replace(/\s+/g, ' ').trim();

const ROLE_WORDS: [RegExp, string][] = [
  [/\bratio\b/, 'ratio'], [/\b(seuil|threshold)\b/, 'threshold'], [/\b(attaque|attack)\b/, 'attack'],
  [/\b(relachement|release)\b/, 'release'], [/\b(mix|dosage|dry ?wet)\b/, 'mix'], [/\b(decay|duree|longueur)\b/, 'decay'],
  [/\b(pre ?delai|predelay|pre ?delay)\b/, 'predelay'], [/\b(feedback|repetitions?)\b/, 'feedback'], [/\b(drive|saturation)\b/, 'drive'],
  [/\b(frequence|freq)\b/, 'frequency'], [/\b(gain de sortie|sortie|output)\b/, 'output'],
];

const CAT_WORDS: [RegExp, string][] = [
  [/\b(compresseurs?|comp)\b/, 'compressor'], [/\b(eq|egaliseurs?|equaliseurs?)\b/, 'eq'], [/\b(reverbs?|reverbe)\b/, 'reverb'],
  [/\b(delays?|delais?|echos?)\b/, 'delay'], [/\b(de ?ess\w*)\b/, 'deesser'], [/\b(saturation|saturateurs?)\b/, 'saturation'],
  [/\b(autotune|auto tune)\b/, 'autotune'], [/\b(limiteurs?|limiter)\b/, 'limiter'],
];

/**
 * @param vstReady pont VST connecté et à jour (v7) : sinon null (les commandes
 *                 classiques et les effets de NOVA s'en chargent).
 */
export function parseVstCommand(raw: string, st: DAWState, vstReady: boolean): VstCommandResult | null {
  if (!vstReady) return null;
  const msg = norm(raw);
  if (!msg || msg.length > 140) return null;
  const say = (text: string, ...actions: AIAction[]): VstCommandResult => ({ text, actions });
  const voices = st.tracks.filter(isVoiceTrack);
  const target = /\bback/.test(msg) ? voices.find(t => /back/i.test(t.name)) : undefined;
  const trackId = target?.id;

  // Liste : « quels plugins j'ai ? », « liste mes compresseurs »
  if (/\b(quels?|liste|montre|affiche|c est quoi)\b.*\b(plugins?|vst|effets? (du|de mon) pc)\b/.test(msg)
    || /\b(liste|montre)\b.*\bmes\b/.test(msg) && CAT_WORDS.some(([re]) => re.test(msg))) {
    const cat = CAT_WORDS.find(([re]) => re.test(msg))?.[1];
    return say('🎛️ Je regarde les plugins installés sur ton PC…', { action: 'VST_LIST', payload: cat ? { category: cat } : {} } as AIAction);
  }

  // Lire les réglages : « montre les réglages du Pro-C », « quels sont les réglages de la reverb »
  const show = msg.match(/\b(montre|affiche|lis|donne|quels? sont)\b.*\b(reglages?|parametres?)\b\s+(du|de la|de l|de|sur le|sur la)\s+(.+)$/);
  if (show) return say('🔎 Je lis les réglages sur le plugin…', { action: 'VST_SHOW_PARAMS', payload: { plugin: show[4].trim(), trackId } } as AIAction);

  // Régler : « mets le ratio du compresseur à 2 », « règle le mix de la reverb à 20 % »
  const roleHit = ROLE_WORDS.find(([re]) => re.test(msg));
  const val = msg.match(/\b(a|sur)\s+(-?\d+(?:[.,]\d+)?)\s*(%|db|ms|hz|khz|s|:1)?\s*$/);
  if (roleHit && val && /\b(regle|mets|passe|monte|baisse|change|fixe)\b/.test(msg)) {
    const plug = msg.match(/\b(du|de la|de l|de|sur le|sur la)\s+([a-z0-9 .\-]+?)\s+(a|sur)\s+-?\d/);
    const cat = CAT_WORDS.find(([re]) => re.test(msg))?.[1];
    const value = val[3] === 'khz' ? `${Number(val[2].replace(',', '.')) * 1000}` : val[2].replace(',', '.');
    return say(`🎛️ Je règle ${roleHit[1]} → ${val[2]}${val[3] || ''}…`, { action: 'VST_SET_PARAM', payload: { plugin: plug?.[2]?.trim() || cat || '', param: roleHit[1], value, trackId } } as AIAction);
  }

  // Retirer un plugin posé : « enlève le Decapitator », « retire le compresseur VST »
  const rm = msg.match(/\b(enleve|retire|supprime|vire)\b\s+(le |la |l |les )?(.+?)(\s+(de|sur)\s+(ma |la |mes )?(voix|piste|backs?))?$/);
  if (rm) {
    const name = rm[3].trim();
    const onTrack = st.tracks.some(t => t.plugins.some(p => p.type === 'VST3' && norm(p.name || '').includes(name)));
    if (onTrack) return say(`🗑️ Je retire ${name}.`, { action: 'VST_REMOVE', payload: { plugin: name, trackId } } as AIAction);
  }

  // Mix par style / retouche : sur les plugins du PC. « plus / moins de reverb » ne
  // refait pas tout le mix : c'est le dosage des envois (commandes classiques).
  if (/\b(plus|moins|un peu plus|un peu moins) (de |d )?(la |l )?(reverb\w*|delay|delai|echo|espace)\b/.test(msg) && !/\b(mix|style)\b/.test(msg)) return null;
  const intent = parseMixIntent(msg);
  const mixWords = /\b(mix|mixe|mixer|mixage|style|rends|fais|mets|donne|ajoute|veux|voudrais)\b/.test(msg);
  if ((mixWords && !intent.unknown) || (!intent.unknown && intent.tweakOnly) || /\b(mixe ma voix|fais (moi )?un mix|un mix)\b/.test(msg)) {
    return say('🎚️ Je prépare ton mix sur tes plugins…', { action: 'VST_MIX', payload: { intent: raw, trackId } } as AIAction);
  }
  return null;
}
