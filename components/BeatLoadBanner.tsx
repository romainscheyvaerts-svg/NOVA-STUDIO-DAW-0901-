import React, { useSyncExternalStore } from 'react';
import { beatLoadStore, cancelBeatLoad, retryBeatLoad } from '../utils/beatLoad';

/**
 * Le beat met trop de temps (15 s) ou le réseau a lâché (audit B6) : on le dit,
 * et on propose de réessayer ou d'en choisir un autre. REC reste bloqué tant
 * que le beat n'est pas là (voir isBeatLoading dans App).
 */
const BeatLoadBanner: React.FC<{ onPickOther: () => void; isMobile?: boolean }> = ({ onPickOther, isMobile }) => {
  const st = useSyncExternalStore(beatLoadStore.subscribe, beatLoadStore.get, beatLoadStore.get);
  if (st.phase !== 'slow' && st.phase !== 'failed') return null;
  const failed = st.phase === 'failed';
  return (
    <div role="alert" data-testid="beat-load-banner"
      className={`fixed left-1/2 -translate-x-1/2 z-[545] w-[min(30rem,calc(100vw-2rem))] rounded-2xl border shadow-2xl backdrop-blur-sm p-3.5 ${isMobile ? 'top-14' : 'top-20'} ${failed ? 'bg-[#1c1214]/95 border-rose-500/40' : 'bg-[#1a1710]/95 border-amber-400/40'}`}>
      <div className="flex items-start gap-3">
        <i className={`fas ${failed ? 'fa-wifi text-rose-300' : 'fa-hourglass-half text-amber-300'} mt-0.5`} aria-hidden="true"></i>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-white">
            {failed ? `« ${st.title} » n'a pas pu être chargé` : `« ${st.title} » met du temps à arriver`}
          </p>
          <p className="mt-0.5 text-[12px] text-slate-300">
            {failed ? 'La connexion a coupé. ' : 'Ta connexion est peut-être lente. '}
            L'enregistrement attend le beat : sans lui, ta prise partirait sur du silence.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button type="button" onClick={retryBeatLoad}
              className="h-9 px-3.5 rounded-lg bg-cyan-500 text-black text-[12px] font-bold hover:bg-cyan-400">
              <i className="fas fa-rotate-right mr-1.5" aria-hidden="true"></i>Réessayer
            </button>
            <button type="button" onClick={() => { cancelBeatLoad(); onPickOther(); }}
              className="h-9 px-3.5 rounded-lg border border-white/15 bg-white/5 text-white text-[12px] font-bold hover:bg-white/10">
              Choisir un autre beat
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BeatLoadBanner;
