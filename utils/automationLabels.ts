import { Track } from '../types';
import { panToText } from './db';
import { gainDbFr } from './pluginUi';
import { sendLabel } from './sendLabels';
import { parsePluginParam } from './automationWrite';
import { v21ParamLabel, V21_SPECS } from '../engine/v21Params';
import { pluginDisplayName } from './pluginLabel';
import { LIMITER_AUTOMATABLE } from '../engine/LimiterNode';
import { analogParamLabel, ANALOG_SPECS } from '../engine/analogCompParams';

/**
 * Automation en français et en vraies unités (audit G22) : « Volume » en dB
 * (« −6,0 dB », pas « 0.50 »), panoramique « G 30 / D 30 », envois nommés
 * comme partout (« Envoi Reverb courte »).
 */
const isGain = (p: string) => p === 'volume' || p === 'preVolume' || p === 'trim' || p.startsWith('send::');

export function automationParamLabel(param: string, tracks?: Track[] | null): string {
  if (param === 'volume') return 'Volume';
  if (param === 'preVolume') return 'Volume avant effets';
  if (param === 'pan') return 'Panoramique';
  if (param === 'trim') return "Trim d'entrée";
  if (param === 'width') return 'Largeur stéréo';
  if (param.startsWith('send::')) return `Envoi ${sendLabel(param.slice(6), tracks)}`;
  // Réglage d'un effet NOVA (limiteur, V21 : harmoniseur, tape stop…) : « Tape stop · Durée de l'arrêt ».
  const pp = parsePluginParam(param);
  if (pp) {
    const pl = tracks?.flatMap(t => t.plugins || []).find(x => x.id === pp.pluginId);
    const limiterLabel = pl?.type === 'LIMITER' ? LIMITER_AUTOMATABLE.find(a => a.id === pp.key)?.label || null
      : pl && ANALOG_SPECS[pl.type] ? analogParamLabel(pl.type, pp.key) : null;
    const label = limiterLabel || (pl ? v21ParamLabel(pl.type, pp.key) : Object.keys(V21_SPECS).map(t => v21ParamLabel(t, pp.key)).find(Boolean) || null);
    if (label) return pl ? `${pluginDisplayName(pl)} · ${label}` : label;
  }
  return param.replace(/^plugin::/, '');
}

export function automationValueText(param: string, v: number): string {
  if (isGain(param)) return gainDbFr(v);
  if (param === 'pan') return panToText(v);
  if (param === 'width') return v <= 0.005 ? 'Mono' : `${Math.round(v * 100)} %`;
  return v.toFixed(2).replace('.', ',');
}

export function automationRangeText(param: string, min: number, max: number): string {
  if (isGain(param)) return `${gainDbFr(min)} à ${gainDbFr(max)}`;
  if (param === 'pan') return 'G 100 à D 100';
  return `${min.toFixed(1).replace('.', ',')} à ${max.toFixed(1).replace('.', ',')}`;
}

export const CURVE_LABELS_FR: Record<string, string> = {
  LINEAR: 'Linéaire', EXPONENTIAL: 'Exponentielle', LOGARITHMIC: 'Logarithmique', S_CURVE: 'En S', HOLD: 'Paliers',
};
