import { PluginInstance } from '../types';

/**
 * Nom lisible d'un effet, partout pareil (en-tête de piste, menu FX, console) :
 * le vrai nom d'un VST (« Pro-C 3 »), le plugin qui traite vraiment la voix pour
 * l'autotune (« Auto-Tune Pro »), un nom français pour les effets de NOVA.
 * Avant : « TUNE », « PRO- » (4 lettres) ou le type brut « VST3 » / « COMPRESSOR ».
 */
export const NOVA_FX_NAMES: Record<string, string> = {
  REVERB: 'Réverbe', DELAY: 'Delay', CHORUS: 'Chorus', FLANGER: 'Flanger', DOUBLER: 'Doubleur',
  STEREOSPREADER: 'Stéréo', COMPRESSOR: 'Compresseur', AUTOTUNE: 'Nova Tune', DEESSER: 'De-esser',
  DENOISER: 'Anti-bruit', PROEQ12: 'Égaliseur', VOCALSATURATOR: 'Saturation', MASTERSYNC: 'Master',
  SAMPLER: 'Sampler', DRUM_SAMPLER: 'Drum sampler', MELODIC_SAMPLER: 'Sampler mélodique', DRUM_RACK_UI: 'Drum Rack',
};

const ICONS: Record<string, string> = {
  AUTOTUNE: 'fa-microphone-alt', COMPRESSOR: 'fa-compress-alt', DEESSER: 'fa-wind', DENOISER: 'fa-volume-mute',
  PROEQ12: 'fa-sliders-h', VOCALSATURATOR: 'fa-fire', REVERB: 'fa-water', DELAY: 'fa-history',
  CHORUS: 'fa-wave-square', FLANGER: 'fa-wave-square', DOUBLER: 'fa-clone', STEREOSPREADER: 'fa-arrows-alt-h',
  MASTERSYNC: 'fa-crown', VST3: 'fa-plug',
};

/** Ce que l'autotune du PC publie (services/AutotuneVst : autotuneLive). */
export interface AutotuneLabelInfo { engine?: string; pluginName?: string; keyText?: string; loading?: boolean }

/** Nom affiché d'un effet. `autotune` : état en direct de l'autotune (VST du PC ou NOVA). */
export const pluginDisplayName = (p: Pick<PluginInstance, 'type' | 'name'>, autotune?: AutotuneLabelInfo | null): string => {
  if (p.type === 'AUTOTUNE') {
    if (autotune?.engine === 'vst' && autotune.pluginName) return autotune.pluginName;
    return NOVA_FX_NAMES.AUTOTUNE;
  }
  if (p.type === 'VST3') return (p.name || '').trim() || 'Plugin VST';
  return NOVA_FX_NAMES[p.type] || (p.name || '').trim() || p.type;
};

/** Détail court (tonalité de l'autotune). */
export const pluginDetail = (p: Pick<PluginInstance, 'type'>, autotune?: AutotuneLabelInfo | null): string =>
  p.type === 'AUTOTUNE' && autotune?.keyText ? autotune.keyText : '';

export const pluginIcon = (p: Pick<PluginInstance, 'type'>): string => ICONS[p.type] || 'fa-magic';

/** Infobulle : nom complet, rôle, et comment l'ouvrir. */
export const pluginTooltip = (p: Pick<PluginInstance, 'type' | 'name' | 'isEnabled'>, autotune?: AutotuneLabelInfo | null): string => {
  const name = pluginDisplayName(p, autotune);
  const detail = pluginDetail(p, autotune);
  const kind = p.type === 'VST3' || (p.type === 'AUTOTUNE' && autotune?.engine === 'vst') ? 'plugin du PC' : 'effet NOVA';
  return `${name}${detail ? ` · ${detail}` : ''} (${kind})${p.isEnabled ? '' : ' — désactivé'} : clic pour l'ouvrir`;
};

/** Tonalité courte pour les pastilles : « F# mineur » → « F#m », « Do majeur » → « Do ». */
export const shortKey = (keyText: string): string =>
  keyText.replace(/\s*mineur\b/i, 'm').replace(/\s*majeur\b/i, '').replace(/\s*minor\b/i, 'm').replace(/\s*major\b/i, '').trim();
