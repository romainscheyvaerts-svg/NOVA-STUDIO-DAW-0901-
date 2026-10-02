import React, { useEffect, useRef } from 'react';
import MobileContainer from './MobileContainer';
import { Track, TrackType } from '../types';

interface MobileMixerPageProps {
  tracks: Track[];
  selectedTrackId: string | null;
  onSelectTrack: (trackId: string) => void;
  onUpdateTrack: (track: Track) => void;
  onRemovePlugin?: (trackId: string, pluginId: string) => void;
  onOpenPlugin?: (trackId: string, pluginId: string) => void;
  onToggleBypass?: (trackId: string, pluginId: string) => void;
  onRequestAddPlugin?: (trackId: string, x: number, y: number) => void;
}

const MAX_VOLUME = 1.5;
// Même courbe que le fader du mixer PC (MixerView) : volume = p² × 1,5.
const volumeToPos = (v: number) => Math.sqrt(Math.max(0, v) / MAX_VOLUME);
const posToVolume = (p: number) => p * p * MAX_VOLUME;
const toDb = (v: number) => (v <= 0.0001 ? '-∞' : (20 * Math.log10(v)).toFixed(1));

/** Fader vertical tactile (Pointer Events : doigt, souris, stylet). */
const VerticalFader: React.FC<{
  value: number;
  color: string;
  label: string;
  onChange: (v: number) => void;
}> = ({ value, color, label, onChange }) => {
  const ref = useRef<HTMLDivElement>(null);
  const pos = volumeToPos(value);

  const setFromY = (clientY: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const p = 1 - Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    onChange(Math.round(posToVolume(p) * 100) / 100);
  };

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={MAX_VOLUME}
      aria-valuenow={value}
      aria-valuetext={`${toDb(value)} dB`}
      data-no-longpress
      className="relative w-10 h-48 rounded-full bg-black/50 border border-white/10 touch-none cursor-ns-resize focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setFromY(e.clientY); }}
      onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) setFromY(e.clientY); }}
      onDoubleClick={() => onChange(1)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.1 : 0.03;
        if (e.key === 'ArrowUp') { e.preventDefault(); onChange(posToVolume(Math.min(1, pos + step))); }
        if (e.key === 'ArrowDown') { e.preventDefault(); onChange(posToVolume(Math.max(0, pos - step))); }
      }}
    >
      {/* Remplissage */}
      <div
        className="absolute bottom-0 left-0 right-0 rounded-full opacity-40 pointer-events-none"
        style={{ height: `${pos * 100}%`, backgroundColor: color }}
      />
      {/* Repère 0 dB */}
      <div
        className="absolute left-0 right-0 h-px bg-white/40 pointer-events-none"
        style={{ bottom: `${volumeToPos(1) * 100}%` }}
      />
      {/* Curseur */}
      <div
        className="absolute left-1/2 -translate-x-1/2 w-12 h-6 rounded-md bg-slate-100 border border-white shadow-lg pointer-events-none flex items-center justify-center"
        style={{ bottom: `calc(${pos * 100}% - 12px)` }}
      >
        <div className="w-6 h-0.5 bg-slate-500 rounded" />
      </div>
    </div>
  );
};

/**
 * Table de mixage mobile : toutes les pistes côte à côte (défilement
 * horizontal, comme une console), master au bout, et le détail des inserts
 * de la piste touchée en dessous.
 */
const MobileMixerPage: React.FC<MobileMixerPageProps> = ({
  tracks,
  selectedTrackId,
  onSelectTrack,
  onUpdateTrack,
  onRemovePlugin,
  onOpenPlugin,
  onToggleBypass,
  onRequestAddPlugin,
}) => {
  const master = tracks.find((t) => t.id === 'master');
  const strips = [...tracks.filter((t) => t.id !== 'master'), ...(master ? [master] : [])];
  const current = strips.find((t) => t.id === selectedTrackId) ?? strips[0];
  const stripRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // La piste sélectionnée ailleurs (Pistes, Arrangement) reste visible ici.
  useEffect(() => {
    if (current) stripRefs.current[current.id]?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [current?.id]);

  if (!current) {
    return (
      <MobileContainer title="Mixer">
        <div className="text-center py-12 text-slate-500">
          <i className="fas fa-sliders-h text-4xl mb-4 opacity-30"></i>
          <p>Aucune piste à mixer</p>
        </div>
      </MobileContainer>
    );
  }

  const insertPlugins = current.plugins.filter(
    (p) => p.type !== 'MELODIC_SAMPLER' && p.type !== 'DRUM_SAMPLER'
  );

  return (
    <MobileContainer title="Mixer">
      <div className="space-y-5 pb-24">
        {/* === Tranches === */}
        <div className="-mx-6 overflow-x-auto overscroll-x-contain snap-x snap-proximity">
          <div className="flex gap-2 px-6 pb-2 w-max">
            {strips.map((t) => {
              const isMaster = t.id === 'master';
              const isSelected = t.id === current.id;
              const color = t.color || '#22d3ee';
              return (
                <div
                  key={t.id}
                  data-nova-target={`vol-${t.id}`}
                  ref={(el) => { stripRefs.current[t.id] = el; }}
                  onClick={() => onSelectTrack(t.id)}
                  className={`snap-start shrink-0 w-[96px] rounded-xl border p-2 flex flex-col items-center gap-2 transition-colors ${
                    isMaster ? 'bg-[#101820] border-cyan-500/40' : 'bg-[#14161a] border-white/10'
                  } ${isSelected ? 'ring-2 ring-cyan-400' : ''}`}
                >
                  <div className="w-full h-1 rounded-full" style={{ backgroundColor: color }} />
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onSelectTrack(t.id); }}
                    className="w-full min-h-[40px] text-center text-[11px] font-bold text-white truncate"
                    title={t.name}
                  >
                    {isMaster ? 'MASTER' : t.name}
                  </button>

                  {/* Pan (pas de pan sur le master) */}
                  {!isMaster ? (
                    <div className="w-full">
                      <input
                        type="range"
                        min="-1"
                        max="1"
                        step="0.01"
                        value={t.pan}
                        aria-label={`Panoramique ${t.name}`}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={() => onUpdateTrack({ ...t, pan: 0 })}
                        onChange={(e) => onUpdateTrack({ ...t, pan: parseFloat(e.target.value) })}
                        className="w-full"
                        // Zone tactile de 40 px ; la piste reste un trait de 4 px au centre.
                        style={{ height: 40, background: 'linear-gradient(transparent 18px, var(--border-highlight) 18px, var(--border-highlight) 22px, transparent 22px)' }}
                      />
                      {/* Le double-tap ne remet pas au centre sur tous les téléphones : toucher la valeur le fait. */}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onUpdateTrack({ ...t, pan: 0 }); }}
                        aria-label={`Centrer le panoramique de ${t.name}`}
                        title="Toucher pour centrer"
                        className="block w-full h-10 text-center text-[11px] text-slate-400"
                      >
                        {t.pan === 0 ? 'C' : t.pan > 0 ? `R${Math.round(t.pan * 100)}` : `L${Math.round(Math.abs(t.pan) * 100)}`}
                      </button>
                    </div>
                  ) : (
                    <div className="h-20" />
                  )}

                  <VerticalFader
                    value={t.volume}
                    color={color}
                    label={`Volume ${isMaster ? 'master' : t.name}`}
                    onChange={(v) => { onUpdateTrack({ ...t, volume: v }); if (!isSelected) onSelectTrack(t.id); }}
                  />
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onUpdateTrack({ ...t, volume: 1 }); }}
                    aria-label={`Remettre ${isMaster ? 'le master' : t.name} à 0 dB`}
                    title="Toucher pour revenir à 0 dB"
                    className="w-full h-10 text-[11px] font-mono text-cyan-400"
                  >
                    {toDb(t.volume)} dB
                  </button>

                  <div className="flex gap-1.5 w-full">
                    <button
                      type="button"
                      aria-pressed={t.isMuted}
                      aria-label={`Mute ${t.name}`}
                      onClick={(e) => { e.stopPropagation(); onUpdateTrack({ ...t, isMuted: !t.isMuted }); }}
                      className={`nova-hit flex-1 h-10 rounded-lg text-xs font-black ${t.isMuted ? 'bg-orange-500 text-white' : 'bg-white/5 text-slate-300'}`}
                    >
                      M
                    </button>
                    {!isMaster && (
                      <button
                        type="button"
                        aria-pressed={t.isSolo}
                        aria-label={`Solo ${t.name}`}
                        onClick={(e) => { e.stopPropagation(); onUpdateTrack({ ...t, isSolo: !t.isSolo }); }}
                        className={`nova-hit flex-1 h-10 rounded-lg text-xs font-black ${t.isSolo ? 'bg-yellow-500 text-black' : 'bg-white/5 text-slate-300'}`}
                      >
                        S
                      </button>
                    )}
                  </div>
                  {t.plugins.length > 0 && (
                    <div className="text-[10px] text-slate-400">
                      <i className="fas fa-plug mr-1"></i>{t.plugins.length} FX
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* === Détail de la piste sélectionnée : inserts === */}
        <div className="bg-[#14161a] rounded-xl p-4 border border-white/10">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: current.color || '#22d3ee' }} />
            <h3 className="text-sm font-bold text-white truncate flex-1">
              {current.id === 'master' ? 'MASTER' : current.name}
            </h3>
            <span className="text-xs text-slate-400">
              {current.type === TrackType.BUS ? 'Bus' : current.type}
            </span>
          </div>
          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">
            Inserts ({insertPlugins.length})
          </h4>

          <div className="space-y-2">
            {insertPlugins.map((plugin) => (
              <div
                key={plugin.id}
                className="bg-black/30 rounded-lg p-2 flex items-center gap-2"
              >
                <button
                  type="button"
                  onClick={() => onOpenPlugin?.(current.id, plugin.id)}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left h-11 active:scale-[0.98] transition-transform"
                >
                  <div className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center ${plugin.isEnabled ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/5 text-slate-500'}`}>
                    <i className="fas fa-plug text-xs"></i>
                  </div>
                  <span className={`text-sm font-medium truncate ${plugin.isEnabled ? 'text-white' : 'text-slate-500'}`}>
                    {plugin.name}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={plugin.isEnabled ? `Désactiver ${plugin.name}` : `Activer ${plugin.name}`}
                  aria-pressed={plugin.isEnabled}
                  onClick={() => onToggleBypass?.(current.id, plugin.id)}
                  className={`w-11 h-11 rounded-lg flex items-center justify-center ${plugin.isEnabled ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/5 text-slate-500'}`}
                >
                  <i className="fas fa-power-off text-sm"></i>
                </button>
                <button
                  type="button"
                  aria-label={`Supprimer ${plugin.name}`}
                  onClick={() => onRemovePlugin?.(current.id, plugin.id)}
                  className="w-11 h-11 rounded-lg bg-red-500/15 text-red-400 flex items-center justify-center"
                >
                  <i className="fas fa-trash text-sm"></i>
                </button>
              </div>
            ))}

            {insertPlugins.length === 0 && (
              <div className="text-center py-6 text-slate-500 text-xs">Aucun effet sur cette piste</div>
            )}

            {insertPlugins.length < 6 && onRequestAddPlugin && (
              <button
                type="button"
                onClick={(e) => onRequestAddPlugin(current.id, e.clientX, e.clientY)}
                className="w-full h-11 rounded-lg border border-dashed border-white/15 text-slate-400 hover:border-cyan-500/50 hover:text-cyan-400 transition-all flex items-center justify-center gap-2"
              >
                <i className="fas fa-plus text-xs"></i>
                <span className="text-xs font-medium">Ajouter un effet</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </MobileContainer>
  );
};

export default MobileMixerPage;
