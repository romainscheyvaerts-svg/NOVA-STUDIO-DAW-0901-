import React, { useEffect, useState } from 'react';
import { Track } from '../../types';
import { audioEngine } from '../../engine/AudioEngine';
import { pluginDisplayName } from '../../utils/pluginLabel';

/**
 * Latence des effets d'une tranche (audit mix 22/10/2026) : comme l'affichage du retard des
 * consoles de DAW, « ⏱ 43 ms » dans l'en-tête des effets dès qu'un effet de la piste retarde le
 * son (EQ à phase linéaire, limiteur à anticipation, VST). L'infobulle détaille effet par effet,
 * en ms et en échantillons ; NOVA compense (PDC). Rien d'affiché à 0.
 *
 * Une seule minuterie pour toute la console (1 lecture par seconde), et seulement pour les
 * tranches montées ; aucun rendu tant que la valeur ne change pas.
 */
type Listener = () => void;
const listeners = new Map<Listener, string>();
let values = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

const read = (trackId: string): number => {
  try {
    let s = 0;
    audioEngine.getTrackPluginLatencies(trackId).forEach(v => { s += v; });
    return s;
  } catch { return 0; }
};

function poll() {
  const next = new Map<string, number>();
  for (const id of new Set(listeners.values())) next.set(id, read(id));
  const changed = [...next].some(([id, v]) => Math.abs((values.get(id) ?? 0) - v) > 1e-6);
  values = next;
  if (changed) listeners.forEach((_, l) => l());
}

const fmtMs = (s: number) => {
  const ms = s * 1000;
  return ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(1).replace('.', ',')} ms`;
};

const StripLatency: React.FC<{ track: Track }> = ({ track }) => {
  const [lat, setLat] = useState(() => read(track.id));
  useEffect(() => {
    const l = () => setLat(values.get(track.id) ?? 0);
    listeners.set(l, track.id);
    if (!timer) timer = setInterval(poll, 1000);
    setLat(read(track.id));
    return () => {
      listeners.delete(l);
      if (!listeners.size && timer) { clearInterval(timer); timer = null; }
    };
  }, [track.id]);
  if (!(lat > 0.00005)) return null;
  const sr = audioEngine.ctx?.sampleRate || 48000;
  let per: Map<string, number> = new Map();
  try { per = audioEngine.getTrackPluginLatencies(track.id); } catch { /* moteur pas prêt */ }
  const detail = track.plugins
    .filter(p => (per.get(p.id) || 0) > 0)
    .map(p => `${pluginDisplayName(p)} : ${fmtMs(per.get(p.id)!)} (${Math.round(per.get(p.id)! * sr)} échantillons)`).join('\n');
  return (
    <span data-strip-latency={track.id} data-latency-samples={Math.round(lat * sr)}
      title={`Latence des effets de la piste : ${fmtMs(lat)} (${Math.round(lat * sr)} échantillons), compensée par NOVA (PDC) : toutes les pistes restent calées.${detail ? `\n${detail}` : ''}`}
      className="rounded px-1 text-[8px] font-bold leading-3 tabular-nums text-amber-300/90 bg-amber-500/10">
      <i className="far fa-clock mr-0.5 text-[7px]" aria-hidden="true" />{fmtMs(lat)}
    </span>
  );
};

export default StripLatency;
