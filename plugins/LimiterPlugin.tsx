import React, { useEffect, useState } from 'react';
import type { LimiterNode, LimiterParams } from '../engine/LimiterNode';
import { DEFAULT_LIMITER_PARAMS } from '../engine/LimiterNode';

/**
 * Fenêtre du limiteur / maximiseur NOVA (V15), comme Maximus (FL Studio),
 * Limiter (Live), Adaptive Limiter (Logic) ou un L2 sur le master.
 * Curseurs larges (doigt, souris), valeurs lisibles, tout en français.
 */
interface Props {
  node: LimiterNode;
  initialParams: Partial<LimiterParams>;
  onParamsChange: (p: Partial<LimiterParams>) => void;
}

const fmt = (v: number, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d).replace('.', ',');
const fr = (v: number, d = 1) => v.toFixed(d).replace('.', ',');

/** Curseur hors du composant : il ne se recrée pas à chaque mesure (le glisser reste fluide). */
const Slider = ({ id, label, hint, min, max, step, value, unit, onChange, digits = 1 }: { id: string; label: string; hint: string; min: number; max: number; step: number; value: number; unit: string; onChange: (v: number) => void; digits?: number }) => (
    <label className="block" title={hint} data-nova-limiter={id}>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] font-bold text-slate-200">{label}</span>
        <span className="text-[13px] font-mono font-black text-white tabular-nums">{id === 'release' || id === 'lookahead' ? fr(value, digits) : fmt(value, digits)} <span className="text-slate-400 text-[10px]">{unit}</span></span>
      </div>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-8 accent-amber-400 cursor-pointer" />
      <p className="text-[10px] text-slate-500 leading-snug">{hint}</p>
    </label>
  );


export const NovaLimiterUI: React.FC<Props> = ({ node, initialParams, onParamsChange }) => {
  const [p, setP] = useState<LimiterParams>({ ...DEFAULT_LIMITER_PARAMS, ...initialParams });
  const [m, setM] = useState({ grDb: 0, outPeakDb: -120, inPeakDb: -120 });
  const [grHold, setGrHold] = useState(0);

  useEffect(() => {
    let raf = 0, last = 0;
    const loop = (t: number) => {
      if (t - last > 60) {
        last = t;
        const mm = node?.getMeters?.();
        if (mm) { setM(mm); setGrHold(h => Math.max(mm.grDb, h * 0.97)); }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [node]);

  const set = (patch: Partial<LimiterParams>) => {
    setP(prev => ({ ...prev, ...patch }));
    node?.updateParams?.(patch);
    onParamsChange(patch);
  };

  const latencyMs = node ? node.latency * 1000 : 0;
  const outPk = Math.max(-30, m.outPeakDb);
  return (
    <div data-nova-plugin="LIMITER" className="w-[min(560px,calc(100vw-16px))] bg-gradient-to-b from-[#1b1710] to-[#0e0d0b] p-6 text-white">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-black tracking-tight">Nova Limiter <span className="text-amber-400">· maximiseur</span></h2>
          <p className="text-[11px] text-slate-400">Plafond en crête vraie, pour le master ou la 808 (comme Maximus dans FL Studio ou le Limiter de Live)</p>
        </div>
        <div className="text-right text-[10px] text-slate-500" title="Retard ajouté par l'anticipation, compensé automatiquement (PDC)">
          Latence<br /><b className="text-slate-300 font-mono">{fr(latencyMs)} ms</b>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-6">
        <div className="space-y-4">
          <Slider id="inputGain" label="Gain d'entrée" hint="Pousse le son dans le limiteur : plus fort, sans jamais dépasser le plafond." min={0} max={24} step={0.1} value={p.inputGain} unit="dB" onChange={v => set({ inputGain: v })} />
          <Slider id="ceiling" label="Plafond (crête vraie)" hint="Niveau maximal de sortie. −1 dBTP est la valeur sûre pour Spotify, Apple Music et YouTube." min={-6} max={0} step={0.1} value={p.ceiling} unit="dBTP" onChange={v => set({ ceiling: v })} />
          <Slider id="release" label="Relâchement" hint="Vitesse à laquelle le son revient après une crête. Court = plus fort mais pompe ; long = plus doux." min={10} max={1000} step={1} value={p.release} unit="ms" digits={0} onChange={v => set({ release: v })} />
          <Slider id="lookahead" label="Anticipation" hint="Le limiteur voit les crêtes arriver et baisse le gain en douceur. Plus long = plus transparent, un peu plus de latence." min={0.5} max={10} step={0.1} value={p.lookahead} unit="ms" onChange={v => set({ lookahead: v })} />
          <div title="Suréchantillonnage de la détection : à 4× et 8×, les crêtes entre les échantillons (crête vraie, dBTP) sont prises en compte, comme le mesurent les plateformes.">
            <div className="text-[11px] font-bold text-slate-200 mb-1">Suréchantillonnage (crête vraie)</div>
            <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="Suréchantillonnage">
              {[1, 2, 4, 8].map(o => (
                <button key={o} type="button" role="radio" aria-checked={p.oversample === o} onClick={() => set({ oversample: o })}
                  className={`h-9 rounded-lg text-[11px] font-black border ${p.oversample === o ? 'bg-amber-400 text-black border-amber-300' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}`}>
                  {o}×{o === 4 ? ' ✓' : ''}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-slate-500 mt-1">{p.oversample === 1 ? 'Crête échantillon seulement : un MP3 ou une plateforme peut dépasser le plafond.' : p.oversample >= 4 ? 'Crête vraie (dBTP) : recommandé.' : 'Crête vraie approchée.'}</p>
          </div>
        </div>

        {/* Mesures */}
        <div className="w-24 flex flex-col items-center gap-2" aria-label="Mesures du limiteur">
          <div className="text-[9px] font-black uppercase tracking-widest text-slate-500">Réduction</div>
          <div className="relative w-6 h-48 rounded bg-black/60 border border-white/10 overflow-hidden" title="Réduction de gain en cours (dB)">
            <div className="absolute top-0 left-0 right-0 bg-amber-400 transition-[height] duration-75" style={{ height: `${Math.min(100, (grHold / 12) * 100)}%` }} />
          </div>
          <div className="text-[13px] font-mono font-black text-amber-300" data-nova-limiter="gr">{grHold < 0.05 ? '0,0' : `−${fr(grHold)}`} dB</div>
          <div className="text-[9px] font-black uppercase tracking-widest text-slate-500 mt-2">Sortie</div>
          <div className="relative w-6 h-24 rounded bg-black/60 border border-white/10 overflow-hidden" title="Crête de sortie (dB)">
            <div className={`absolute bottom-0 left-0 right-0 ${m.outPeakDb > p.ceiling + 0.05 ? 'bg-red-500' : 'bg-emerald-400'}`} style={{ height: `${((outPk + 30) / 30) * 100}%` }} />
            <div className="absolute left-0 right-0 border-t border-white/70" style={{ bottom: `${((p.ceiling + 30) / 30) * 100}%` }} />
          </div>
          <div className="text-[11px] font-mono text-slate-300">{m.outPeakDb > -100 ? fmt(m.outPeakDb) : '—'} dB</div>
        </div>
      </div>
      {node?.isFallback?.() && <p className="mt-4 text-[11px] text-red-300">Ce navigateur ne peut pas charger le limiteur : il est contourné (aucun traitement).</p>}
    </div>
  );
};

export default NovaLimiterUI;
