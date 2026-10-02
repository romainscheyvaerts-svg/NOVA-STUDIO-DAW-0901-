import React, { useEffect, useRef, useState } from 'react';
import { DRUM_KITS, DrumMachine, DrumRow, setBars, PadMix, DEFAULT_PAD_MIX, PAD_MIX_PRESETS, libraryChoices, libSoundLabel } from '../utils/drumKits';
import { libUrl } from '../utils/drumLibrary';
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
                          <span className={r.muted ? 'line-through opacity-50' : ''}>{r.name}</span>
                          {r.solo && <span className="ml-1 text-amber-300">S</span>}
                          {r.mix && Object.values(r.mix).some(v => v) && <span className="ml-1 text-violet-300" title="Effets sur ce pad">✦</span>}
                        </button>
                        <button type="button" onClick={() => setSoundMenu(soundMenu === ri ? null : ri)} aria-label={`Son et mix du pad ${r.name}`} title="Son et mix du pad"
                          className={`w-7 h-9 rounded-lg text-[11px] ${soundMenu === ri ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}><i className="fas fa-sliders-h" /></button>
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
                <PadEditor
                  kitId={dm.kitId}
                  row={dm.rows[soundMenu]}
                  onEdit={patch => editRow(soundMenu, patch)}
                  onAudition={() => setTimeout(() => p.onAudition(soundMenu), 120)}
                  onClose={() => setSoundMenu(null)}
                />
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
                Tap : allumer → accent léger → éteindre. Appui long (ou clic droit) : roll ×2 ×3 ×4. Bouton réglages d'un pad : son, accordage, longueur et mix (EQ, compression, saturation, réverb, délai). La 808 et le log drum sont accordés sur la tonalité du morceau.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

interface PadEditorProps {
  kitId: string;
  row: DrumRow;
  onEdit: (patch: (r: DrumRow) => DrumRow) => void;
  onAudition: () => void;
  onClose: () => void;
}

interface KnobProps {
  label: string; value: number; min: number; max: number; step: number;
  fmt: (v: number) => string; onChange: (v: number) => void; onReset: () => void;
}

const Knob: React.FC<KnobProps> = k => (
  <label className="flex flex-col gap-1 min-w-0">
    <span className="flex justify-between text-[11px] text-slate-400">
      <span>{k.label}</span>
      <button type="button" onClick={k.onReset} title="Remettre à zéro" className="tabular-nums text-slate-200 hover:text-cyan-300">{k.fmt(k.value)}</button>
    </span>
    <input type="range" min={k.min} max={k.max} step={k.step} value={k.value} onChange={e => k.onChange(parseFloat(e.target.value))} className="w-full accent-cyan-400" />
  </label>
);

/** Réglages d'un pad : son, niveau, panoramique, accordage, longueur, mute / solo et mix par effets natifs. */
const PadEditor: React.FC<PadEditorProps> = ({ kitId, row, onEdit, onAudition, onClose }) => {
  const [allStyles, setAllStyles] = React.useState(false);
  const lib = libraryChoices(row.id, kitId);
  const synths = DRUM_SOUNDS.filter(s => (CAT_OF[row.id] || []).includes(s.category)).map(s => `synth:${s.id}`);
  // Tous les sons possibles du pad, dans l'ordre affiché (pour ◀ ▶)
  const all = [...lib.flatMap(c => c.ids.map(libUrl)), ...synths];
  const pick = (ref: string) => { onEdit(r => ({ ...r, sound: ref })); onAudition(); };
  const step = (d: number) => {
    if (!all.length) return;
    const i = all.indexOf(row.sound);
    pick(all[(i + d + all.length) % all.length]);
  };
  const label = libSoundLabel(row.sound) || DRUM_SOUNDS.find(x => `synth:${x.id}` === row.sound)?.name || 'Son';
  const shown = allStyles ? lib : lib.slice(0, 2);
  const mix: PadMix = { ...DEFAULT_PAD_MIX, ...(row.mix || {}) };
  const setMix = (patch: Partial<PadMix>) => onEdit(r => ({ ...r, mix: { ...(r.mix || {}), ...patch } }));
  const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-[13px] font-black text-white mr-auto">Pad « {row.name} »</p>
        <button type="button" onClick={() => onEdit(r => ({ ...r, muted: !r.muted }))} aria-pressed={!!row.muted}
          className={`h-8 px-3 rounded-lg text-[11px] font-black ${row.muted ? 'bg-red-500 text-white' : 'bg-white/10 text-white'}`}>Mute</button>
        <button type="button" onClick={() => onEdit(r => ({ ...r, solo: !r.solo }))} aria-pressed={!!row.solo}
          className={`h-8 px-3 rounded-lg text-[11px] font-black ${row.solo ? 'bg-amber-400 text-black' : 'bg-white/10 text-white'}`}>Solo</button>
        <button type="button" onClick={onClose} aria-label="Fermer les réglages du pad" className="w-8 h-8 rounded-lg bg-white/5 text-slate-300"><i className="fas fa-times" /></button>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mr-auto">Son</p>
          <button type="button" onClick={() => step(-1)} aria-label="Son précédent" className="w-9 h-9 rounded-lg bg-white/10 text-white"><i className="fas fa-chevron-left" /></button>
          <span className="min-w-[120px] text-center text-[12px] font-bold text-white truncate">{label}</span>
          <button type="button" onClick={() => step(1)} aria-label="Son suivant" className="w-9 h-9 rounded-lg bg-white/10 text-white"><i className="fas fa-chevron-right" /></button>
        </div>
        {shown.map(c => (
          <div key={c.style} className="mb-2">
            <p className="text-[11px] text-slate-400 mb-1">Make Music · {c.styleName}</p>
            <div className="flex flex-wrap gap-1.5">
              {c.ids.map((id, i) => {
                const ref = libUrl(id);
                return (
                  <button key={id} type="button" onClick={() => pick(ref)} title={libSoundLabel(ref) || ''}
                    className={`h-8 min-w-[36px] px-2 rounded-lg text-[12px] font-bold ${row.sound === ref ? 'bg-cyan-500 text-black' : 'bg-white/10 text-white hover:bg-white/15'}`}>
                    {i + 1}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {lib.length > 2 && (
          <button type="button" onClick={() => setAllStyles(v => !v)} className="mb-2 text-[11px] font-bold text-cyan-300 hover:text-cyan-200">
            {allStyles ? 'Moins de styles' : `+ ${lib.length - 2} autres styles`}
          </button>
        )}
        {synths.length > 0 && (
          <>
            <p className="text-[11px] text-slate-400 mb-1">Sons Nova{row.id === '808' ? ' (accordés sur la tonalité)' : ''}</p>
            <div className="flex flex-wrap gap-1.5">
              {DRUM_SOUNDS.filter(x => synths.includes(`synth:${x.id}`)).map(x => (
                <button key={x.id} type="button" onClick={() => pick(`synth:${x.id}`)}
                  className={`h-8 px-3 rounded-lg text-[12px] font-bold ${row.sound === `synth:${x.id}` ? 'bg-cyan-500 text-black' : 'bg-white/10 text-white hover:bg-white/15'}`}>
                  {x.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
        <Knob label="Volume" value={row.volume} min={0} max={1.2} step={0.01} fmt={pct} onChange={v => onEdit(r => ({ ...r, volume: v }))} onReset={() => onEdit(r => ({ ...r, volume: 0.9 }))} />
        <Knob label="Panoramique" value={row.pan} min={-1} max={1} step={0.05}
          fmt={v => (Math.abs(v) < 0.025 ? 'centre' : `${v < 0 ? 'G' : 'D'} ${Math.round(Math.abs(v) * 100)}`)}
          onChange={v => onEdit(r => ({ ...r, pan: v }))} onReset={() => onEdit(r => ({ ...r, pan: 0 }))} />
        <Knob label="Accordage" value={row.tune || 0} min={-12} max={12} step={1} fmt={v => `${v > 0 ? '+' : ''}${v} dt`}
          onChange={v => onEdit(r => ({ ...r, tune: v }))} onReset={() => onEdit(r => ({ ...r, tune: 0 }))} />
        <Knob label="Longueur" value={row.decay ?? 1} min={0.05} max={1} step={0.01} fmt={pct}
          onChange={v => onEdit(r => ({ ...r, decay: v }))} onReset={() => onEdit(r => ({ ...r, decay: 1 }))} />
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mr-auto">Mix du pad</p>
          <button type="button" onClick={() => setMix({ ...DEFAULT_PAD_MIX, ...(PAD_MIX_PRESETS[row.id] || {}) })}
            className="h-8 px-3 rounded-lg bg-violet-500/20 text-violet-200 text-[11px] font-bold hover:bg-violet-500/30">✦ Réglage pro</button>
          <button type="button" onClick={() => onEdit(r => ({ ...r, mix: {} }))}
            className="h-8 px-3 rounded-lg bg-white/5 text-slate-300 text-[11px] font-bold hover:text-white">Sans effet</button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
          <Knob label="Graves" value={mix.eqLow} min={-12} max={12} step={0.5} fmt={db} onChange={v => setMix({ eqLow: v })} onReset={() => setMix({ eqLow: 0 })} />
          <Knob label="Médiums" value={mix.eqMid} min={-12} max={12} step={0.5} fmt={db} onChange={v => setMix({ eqMid: v })} onReset={() => setMix({ eqMid: 0 })} />
          <Knob label="Aigus" value={mix.eqHigh} min={-12} max={12} step={0.5} fmt={db} onChange={v => setMix({ eqHigh: v })} onReset={() => setMix({ eqHigh: 0 })} />
          <Knob label="Compression" value={mix.comp} min={0} max={1} step={0.01} fmt={pct} onChange={v => setMix({ comp: v })} onReset={() => setMix({ comp: 0 })} />
          <Knob label="Saturation" value={mix.sat} min={0} max={1} step={0.01} fmt={pct} onChange={v => setMix({ sat: v })} onReset={() => setMix({ sat: 0 })} />
          <Knob label="Réverb" value={mix.verb} min={0} max={1} step={0.01} fmt={pct} onChange={v => setMix({ verb: v })} onReset={() => setMix({ verb: 0 })} />
          <Knob label="Délai" value={mix.delay} min={0} max={1} step={0.01} fmt={pct} onChange={v => setMix({ delay: v })} onReset={() => setMix({ delay: 0 })} />
        </div>
        <p className="mt-2 text-[11px] text-slate-500">Effets natifs Nova, sans latence : EQ, compresseur, saturation à bande ; réverb et délai partagés avec les voix (envois).</p>
      </div>
    </div>
  );
};

export default DrumMachinePanel;
