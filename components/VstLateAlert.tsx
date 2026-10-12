import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Track } from '../types';
import type { VstLateDetail } from '../engine/VSTPluginNode';
import { useVstNodeInfo } from '../hooks/useNovaBridge';
import { coupures } from '../utils/vstAdaptiveBuffer';

/**
 * (C6) Le pont VST rend ses blocs en retard : avant, le son du plugin se coupait sans rien
 * dire. Ici : alerte visible et compréhensible (« Le plugin X a pris du retard : 12 coupures
 * en 10 s »), ce que NOVA a fait (tampon agrandi, retard compensé) et une action (geler la
 * piste : l'effet est rendu dans l'audio, plus de dépendance au pont).
 * Événement « nova:vst-late » (engine/VSTPluginNode) ; l'alerte se ferme seule quand les
 * coupures cessent.
 */

const HIDE_AFTER_MS = 15_000;

interface Props {
  tracks: Track[];
  onFreezeTrack?: (trackId: string) => void;
}

const VstLateAlert: React.FC<Props> = ({ tracks, onFreezeTrack }) => {
  const [alert, setAlert] = useState<VstLateDetail | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useVstNodeInfo(alert?.pluginId || '');

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<VstLateDetail>).detail;
      if (!d?.pluginId) return;
      setAlert(d);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setAlert(null), HIDE_AFTER_MS);
    };
    window.addEventListener('nova:vst-late', on);
    return () => { window.removeEventListener('nova:vst-late', on); if (timer.current) clearTimeout(timer.current); };
  }, []);

  if (!alert || dismissed === `${alert.pluginId}:${alert.dropoutsTotal}`) return null;
  const track = tracks.find(t => t.plugins?.some(p => p.id === alert.pluginId));
  // Chiffres à jour (le nœud continue de compter pendant que l'alerte est affichée).
  const n10 = live ? live.dropouts10s : alert.dropouts10s;
  const total = live ? live.dropoutsTotal : alert.dropoutsTotal;
  const ms = live ? live.bufferMs : alert.bufferMs;
  const grown = live ? live.bufferGrown : alert.grown;
  const atMax = live ? live.bufferAtMax : alert.atMax;
  const dismiss = () => setDismissed(`${alert.pluginId}:${alert.dropoutsTotal}`);

  return createPortal(
    <div role="alert" data-testid="vst-late-alert" data-plugin={alert.pluginId}
      className="fixed z-[689] top-[72px] right-3 w-[min(400px,calc(100vw-24px))] rounded-2xl border border-amber-400/40 bg-[#1a1610] p-4 shadow-2xl text-[12px] text-slate-200">
      <p className="font-black text-white text-[13px] mb-1">
        <i className="fas fa-hourglass-half text-amber-300 mr-2" aria-hidden="true"></i>
        {n10 > 0
          ? <>Le plugin {alert.name} a pris du retard : <span data-testid="vst-late-count">{coupures(n10)}</span> en 10 s</>
          : <>Le plugin {alert.name} avait pris du retard : plus de coupure depuis 10 s</>}
      </p>
      <p className="text-slate-300 mb-1">
        Le pont VST du PC renvoie le son de ce plugin trop tard : sans marge, on entend des trous.
        {total > n10 ? ` ${coupures(total)} depuis le chargement.` : ''}
      </p>
      <p className="mb-3" data-testid="vst-late-buffer">
        {!alert.adaptive
          ? <span className="text-slate-300">Ferme les programmes inutiles, ou gèle la piste.</span>
          : atMax
            ? <span className="text-amber-200">Tampon déjà au maximum ({ms} ms). Gèle la piste pour ne plus dépendre du pont.</span>
            : grown
              ? <span className="text-emerald-200">NOVA a agrandi son tampon à {ms} ms : le son ne coupe plus. Ce retard est compensé, tes pistes restent calées.</span>
              : <span className="text-slate-300">NOVA agrandit son tampon si ça continue (retard compensé).</span>}
      </p>
      <div className="flex flex-wrap gap-2">
        {track && onFreezeTrack && (
          <button type="button" data-testid="vst-late-freeze" onClick={() => { onFreezeTrack(track.id); dismiss(); }}
            title="L'effet est rendu dans l'audio de la piste : plus aucune dépendance au pont (tu peux dégeler quand tu veux)."
            className="h-10 px-3 rounded-xl bg-cyan-400 text-black font-black text-[12px]">Geler « {track.name} »</button>
        )}
        <button type="button" onClick={dismiss} className="h-10 px-3 rounded-xl text-slate-400 text-[12px] underline">Ignorer</button>
      </div>
    </div>,
    document.body,
  );
};

export default VstLateAlert;

/**
 * Pastille de l'insert : coupures récentes (orange) ou tampon agrandi (discret). Rien sinon.
 */
export const VstLateBadge: React.FC<{ pluginId: string }> = ({ pluginId }) => {
  const info = useVstNodeInfo(pluginId);
  if (!info || info.status !== 'active' || (!info.dropouts10s && !info.bufferGrown)) return null;
  const hot = info.dropouts10s > 0;
  const title = hot
    ? `Le plugin a pris du retard : ${coupures(info.dropouts10s)} en 10 s. Tampon ${info.bufferMs} ms${info.bufferGrown ? ' (agrandi, retard compensé)' : ''}. Clic : ouvrir l'effet.`
    : `Tampon du pont agrandi à ${info.bufferMs} ms après des retards (compensé : la piste reste calée). Il redescend tout seul à l'arrêt quand tout va bien.`;
  return (
    <span data-testid={`vst-late-badge-${pluginId}`} data-hot={hot ? '1' : '0'} title={title} aria-label={title}
      className={`ml-1 inline-flex items-center gap-0.5 rounded px-1 text-[9px] font-black leading-[14px] ${hot ? 'bg-amber-400 text-black' : 'bg-white/10 text-amber-200'}`}>
      <i className="fas fa-hourglass-half text-[8px]" aria-hidden="true"></i>{hot ? info.dropouts10s : ''}
    </span>
  );
};
