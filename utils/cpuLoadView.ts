import { Track, TrackType } from '../types';
import { DSP_BUDGET_MS, pluginCostMs, trackCostMs, TRACK_BASE_MS } from './dspLoad';
import { canBakeTrack, isTrackFrozen } from './freeze';
import { pluginDisplayName } from './pluginLabel';

/**
 * Charge processeur d'une piste et de chacun de ses effets, pour la console (comme
 * « System Usage » de Pro Tools, mais piste par piste). Module pur, sans audio.
 *
 * Les coûts viennent de utils/dspLoad (mesurés hors ligne, ms de calcul par seconde de son),
 * rapportés au budget d'un fil audio (DSP_BUDGET_MS). Une piste dont les effets dorment
 * (veille automatique, engine/effectSleep : rien n'entre, la chaîne est au repos) ne coûte
 * plus que sa base (fader, pan, vumètre).
 */
export type CpuLevel = 'faible' | 'moyenne' | 'forte';

export interface TrackCpuView {
  /** Part du budget audio (%) que coûte la piste maintenant. */
  pct: number;
  /** Part qu'elle coûte quand elle joue (effets réveillés). */
  pctAwake: number;
  asleep: boolean;
  level: CpuLevel;
  effects: { id: string; name: string; pct: number }[];
  /** Conseil actionnable, ou null. */
  advice: string | null;
  /** La piste peut être gelée tout de suite (bouton « Geler »). */
  canFreeze: boolean;
}

/** Au-delà, une seule piste pèse lourd (6 % du fil audio : 16 pistes comme elle le remplissent). */
export const HEAVY_TRACK_PCT = 6;
export const MEDIUM_TRACK_PCT = 3;

const pctOf = (ms: number) => Math.round((ms / DSP_BUDGET_MS) * 1000) / 10;

const freezable = (t: Track) =>
  !isTrackFrozen(t) && !t.isTrackArmed && !t.isInactive && !t.vstInstrument && !t.remote && !t.livePreview
  && (t.type === TrackType.AUDIO || t.type === TrackType.MIDI) && (t.clips || []).length > 0 && canBakeTrack(t)
  && (t.plugins || []).some(p => pluginCostMs(p) > 0);

export function trackCpuView(t: Track, asleep = false): TrackCpuView {
  const awakeMs = trackCostMs(t);
  const ms = asleep ? Math.min(awakeMs, TRACK_BASE_MS) : awakeMs;
  const pct = pctOf(ms);
  const pctAwake = pctOf(awakeMs);
  const frozen = isTrackFrozen(t);
  const effects = frozen ? [] : (t.plugins || [])
    .filter(p => pluginCostMs(p) > 0)
    .map(p => ({ id: p.id, name: pluginDisplayName(p), pct: asleep ? 0 : pctOf(pluginCostMs(p)) }));
  const level: CpuLevel = pctAwake >= HEAVY_TRACK_PCT ? 'forte' : pctAwake >= MEDIUM_TRACK_PCT ? 'moyenne' : 'faible';
  const canFreeze = freezable(t);
  let advice: string | null = null;
  if (frozen) advice = 'Piste gelée : ses effets sont déjà rendus.';
  else if (asleep) advice = 'En veille : ses effets ne calculent rien tant qu\'elle est muette.';
  else if (level === 'forte' && canFreeze) advice = `Geler cette piste libère environ ${Math.max(0, Math.round(pctAwake - pctOf(TRACK_BASE_MS)))} % du processeur audio.`;
  else if (level === 'forte') advice = 'Piste lourde : retire ou désactive un effet si le son craque.';
  return { pct, pctAwake, asleep, level, effects, advice, canFreeze };
}

/** Texte de l'infobulle (une ligne par effet, puis le conseil). */
export function cpuTooltip(t: Track, v: TrackCpuView): string {
  const lines = [`Charge processeur de « ${t.name} » : ${v.pct} %${v.asleep ? ` (en veille ; ${v.pctAwake} % quand elle joue)` : ''}`];
  for (const e of v.effects) lines.push(`  ${e.name} : ${e.pct} %`);
  if (v.advice) lines.push(v.advice);
  return lines.join('\n');
}
