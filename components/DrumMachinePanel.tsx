import React, { useEffect, useRef, useState } from 'react';
import { DRUM_KITS, DrumMachine, DrumRow, setBars } from '../utils/drumKits';
import { DRUM_SOUNDS, DrumCategory } from '../utils/drumSounds';
import { audioEngine } from '../engine/AudioEngine';

interface DrumMachinePanelProps {
  open: boolean;
  onClose: () => void;
  dm: DrumMachine | null;
  onChange: (dm: DrumMachine) => void;
  onKit: (kitId: string) => void;
  onRemove: () => void;
  onAudition: (rowIndex: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  bpm: number;
  clipStart: number;
}

const CAT_OF: Record<string, DrumCategory[]> = {
  kick: ['kick'], '808': ['808'], snare: ['snare', 'clap'], clap: ['clap', 'snare'],
  hatc: ['hat-closed'], hato: ['hat-open', 'cymbal'], perc: ['perc', 'hat-closed', 'snare'], fx: ['snare', 'cymbal', 'perc'],
};

/**
 * Boîte à rythmes Make Music : un tap allume un pas, un deuxième tap le passe
 * en accent léger, un troisième l'éteint. Sur les hi-hats, l'appui long (ou
 * clic droit) fait un « roll » ×2 ×3 ×4.
 */
const DrumMachinePanel: React.FC<DrumMachinePanelProps> = (p) => {
  const [playStep, setPlayStep] = useState(-1);
  const [soundMenu, setSoundMenu] = useState<number | null>(null);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);

  // Tête de lecture sur le motif
  useEffect(() => {
    if (!p.open || !p.dm) return;
    let raf = 0;
    const tick = () => {
      if (p.isPlaying && p.dm) {
        const t = audioEngine.getCurrentTime() - p.clipStart;
        const stepDur = 60 / p.bpm / 4;
        const len = 16 * p.dm.bars;
        setPlayStep(t >= 0 ? Math.floor(t / stepDur) % len : -1);
      } else setPlayStep(-1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [p.open, p.isPlaying, p.bpm, p.clipStart, p.dm]);

  if (!p.open) return null;
  const dm = p.dm;

  const editRow = (ri: number, patch: (r: DrumRow) => DrumRow) => {
    if (!dm) return;
    p.onChange({ ...dm, rows: dm.rows.map((r, i) => (i === ri ? patch({ ...r, steps: [...r.steps], ratchet: [...r.ratchet] }) : r)) });
  };
  const toggleStep = (ri: number, si: number) => editRow(ri, r => {
    const v = r.steps[si];
    r.steps[si] = v === 0 ? 110 : v >= 100 ? 70 : 0;
    if (r.steps[si] === 0) r.ratchet[si] = 1;
    return r;
  });
  const cycleRoll = (ri: number, si: number) => editRow(ri, r => {
    const n = r.ratchet[si] || 1;
    r.ratchet[si] = n >= 4 ? 1 : n + 1;
    if (!r.steps[si]) r.steps[si] = 90;
    return r;
  });

  const startPress = (ri: number, si: number) => {
    longPressed.current = false;
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => { longPressed.current = true; cycleRoll(ri, si); }, 450);
  };
  const endPress = (ri: number, si: number) => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    if (!longPressed.current) toggleStep(ri, si);
  };

  const len = dm ? 16 * dm.bars : 16;

  return (
    <div className="fixed inset-0 z-[560] flex items-end sm:items-center justify-center bg-black/50" onClick={p.onClose} role="dialog" aria-modal="true" aria-labelledby="drums-title">
      <div className="w-full sm:max-w-4xl max-h-[92vh] flex flex-col rounded-t-3xl sm:rounded-3xl bg-[#121418] border border-white/10 shadow-2xl pb-[env(safe-area-inset-bottom)]" onClick={e => e.stopPropagation()}>
        {/* En-tête */}
        <div className="flex items-center gap-2 px-4 pt-4 pb-3 border-b border-white/5">
          <h2 id="drums-title" className="text-[16px] font-black text-white mr-auto">🥁 Batterie <span className="text-slate-400 font-bold text-[12px]">Make Music</span></h2>
          {dm && (
            <button type="button" onClick={p.onTogglePlay} className={`h-10 px-4 rounded-xl text-[12px] font-black ${p.isPlaying ? 'bg-white text-black' : 'bg-cyan-500 text-black'}`}>
              <i className={`fas ${p.isPlaying ? 'fa-pause' : 'fa-play'} mr-1.5`} />{p.isPlaying ? 'Pause' : 'Écouter'}
            </button>
          )}
          <button type="button" onClick={p.onClose} aria-label="Fermer" className="w-10 h-10 rounded-xl bg-white/5 text-slate-300"><i className="fas fa-times" /></button>
        </div>

        <div className="overflow-y-auto px-4 py-3 space-y-3">
          {/* Kits */}
          <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
            {DRUM_KITS.map(k => (
              <button key={k.id} type="button" onClick={() => p.onKit(k.id)}
                className={`shrink-0 h-10 px-3 rounded-xl border text-[12px] font-bold ${dm?.kitId === k.id ? 'border-cyan-400 bg-cyan-500/15 text-white' : 'border-white/10 bg-white/[0.03] text-slate-200'}`}>
                {k.emoji} {k.name}
              </button>
            ))}
          </div>

          {!dm ? (
            <p className="text-sm text-slate-300">Choisis un style de batterie : elle se cale sur le tempo et la tonalité de ta mélodie.</p>
          ) : (
            <>
              {/* Grille */}
              <div className="overflow-x-auto no-scrollbar">
                <div className="inline-block min-w-full">
                  {dm.rows.map((r, ri) => (
                    <div key={r.id} className="flex items-center gap-1 mb-1">
                      <div className="sticky left-0 z-10 bg-[#121418] pr-1 flex items-center gap-1 w-[118px] shrink-0">
                        <button type="button" onClick={() => p.onAudition(ri)} title="Écouter le son"
                          className="flex-1 min-w-0 h-9 rounded-lg bg-white/5 text-left px-2 text-[11px] font-bold text-white truncate hover:bg-white/10">
                          {r.name}
                        </button>
                        <button type="button" onClick={() => setSoundMenu(soundMenu === ri ? null : ri)} aria-label={`Changer le son de ${r.name}`}
                          className="w-7 h-9 rounded-lg bg-white/5 text-slate-300 text-[10px] hover:bg-white/10"><i className="fas fa-caret-down" /></button>
                      </div>
                      {Array.from({ length: len }, (_, si) => {
                        const v = r.steps[si] || 0;
                        const roll = r.ratchet[si] || 1;
                        const beatStart = si % 4 === 0;
                        return (
                          <button
                            key={si}
                            type="button"
                            aria-label={`${r.name}, pas ${si + 1}${v ? (roll > 1 ? `, roll ×${roll}` : ', actif') : ''}`}
                            onPointerDown={() => startPress(ri, si)}
                            onPointerUp={() => endPress(ri, si)}
                            onPointerLeave={() => { if (pressTimer.current) window.clearTimeout(pressTimer.current); }}
                            onContextMenu={e => { e.preventDefault(); cycleRoll(ri, si); }}
                            className={`relative shrink-0 w-8 h-9 rounded-md border transition-colors ${playStep === si ? 'ring-2 ring-white/70' : ''} ${
                              v >= 100 ? 'bg-gradient-to-b from-cyan-400 to-violet-500 border-transparent'
                              : v > 0 ? 'bg-cyan-500/45 border-transparent'
                              : beatStart ? 'bg-white/[0.09] border-white/10' : 'bg-white/[0.04] border-white/5'}`}
                          >
                            {roll > 1 && v > 0 && <span className="absolute inset-0 flex items-center justify-center text-[10px] font-black text-black">×{roll}</span>}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              {soundMenu !== null && dm.rows[soundMenu] && (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                  <p className="text-[12px] font-bold text-white mb-2">Son du pad « {dm.rows[soundMenu].name} »</p>
                  <div className="flex flex-wrap gap-2">
                    {DRUM_SOUNDS.filter(s => (CAT_OF[dm.rows[soundMenu].id] || []).includes(s.category)).map(s => (
                      <button key={s.id} type="button"
                        onClick={() => { editRow(soundMenu, r => ({ ...r, sound: `synth:${s.id}` })); setTimeout(() => p.onAudition(soundMenu), 120); }}
                        className={`h-9 px-3 rounded-lg text-[12px] font-bold ${dm.rows[soundMenu].sound === `synth:${s.id}` ? 'bg-cyan-500 text-black' : 'bg-white/10 text-white'}`}>
                        {s.name}
                      </button>
                    ))}
                  </div>
                  <label className="mt-3 flex items-center gap-3 text-[12px] text-slate-300">
                    Volume
                    <input type="range" min={0} max={1.2} step={0.01} value={dm.rows[soundMenu].volume}
                      onChange={e => editRow(soundMenu, r => ({ ...r, volume: parseFloat(e.target.value) }))} className="flex-1" />
                  </label>
                </div>
              )}

              {/* Réglages */}
              <div className="flex flex-wrap items-center gap-3 text-[12px] text-slate-300">
                <div className="flex rounded-xl overflow-hidden border border-white/10">
                  {[1, 2].map(b => (
                    <button key={b} type="button" onClick={() => p.onChange(setBars(dm, b as 1 | 2))}
                      className={`h-9 px-3 font-bold ${dm.bars === b ? 'bg-white text-black' : 'bg-white/5 text-white'}`}>{b} mesure{b > 1 ? 's' : ''}</button>
                  ))}
                </div>
                <label className="flex items-center gap-2">
                  Swing
                  <input type="range" min={0} max={0.6} step={0.05} value={dm.swing} onChange={e => p.onChange({ ...dm, swing: parseFloat(e.target.value) })} />
                  <span className="tabular-nums w-8">{Math.round(dm.swing * 100)}%</span>
                </label>
                <button type="button" onClick={p.onRemove} className="ml-auto h-9 px-3 rounded-lg bg-white/5 text-slate-300 hover:text-white">Retirer la batterie</button>
              </div>
              <p className="text-[11px] text-slate-500">
                Tap : allumer → accent léger → éteindre. Appui long (ou clic droit) : roll ×2 ×3 ×4. La 808 et le log drum sont accordés sur la tonalité du morceau.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default DrumMachinePanel;
