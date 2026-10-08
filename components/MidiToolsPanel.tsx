import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MidiNote } from '../types';
import {
  MIDI_TOOLS, ARP_PATTERNS, ToolId, ToolContext, seededRandom,
  strum, arpeggiate, flam, chop, roll, velocityCurve, randomize, legato, invert, retrograde, quantize, chordify,
  StrumParams, ArpParams, FlamParams, ChopParams, RollParams, VelocityCurveParams, RandomizeParams, QuantizeParams, ChordifyParams,
} from '../utils/midiTools';

/**
 * Menu « Outils » du piano roll (V25) : chaque outil s'applique à la sélection
 * (sinon à tout le clip), en une seule étape d'annulation. Les réglages
 * s'affichent en aperçu dans la grille avant d'appliquer.
 */

interface Props {
  notes: MidiNote[];
  selectedIds: Set<string>;
  ctx: ToolContext;
  /** Aperçu dans la grille (null : plus d'aperçu). */
  onPreview: (notes: MidiNote[] | null) => void;
  /** Écrit le résultat (une étape d'annulation). */
  onApply: (notes: MidiNote[], label: string) => void;
  onClose: () => void;
  /** Position (bureau) ; sur petit écran : feuille du bas. */
  anchor?: { x: number; y: number } | null;
  /** Outil ouvert directement. */
  initialTool?: ToolId;
}

interface AllParams {
  quantize: QuantizeParams; strum: StrumParams; arp: ArpParams; flam: FlamParams; chop: ChopParams; roll: RollParams;
  velocity: VelocityCurveParams; random: RandomizeParams & { seed: number }; chord: ChordifyParams;
}

const DEFAULTS: AllParams = {
  quantize: { grid: '1/16', strength: 1, swing: 50, ends: false },
  strum: { direction: 'up', spreadMs: 30, tension: 0 },
  arp: { pattern: 'UP', rate: '1/16', octaves: 1, gate: 80 },
  flam: { offsetMs: 25, velocity: 0.6 },
  chop: { grid: '1/16', gate: 100 },
  roll: { rate: '1/32', ramp: 'up', from: 0.35, to: 1, pitchRamp: 0 },
  velocity: { shape: 'up', min: 0.3, max: 1, cycles: 1, points: [0.3, 0.6, 1, 0.6, 0.3, 0.6, 1, 0.6] },
  random: { pitch: 0, velocity: 0.15, timingMs: 8, chance: 1, seed: 1 },
  chord: { chordType: 'MINOR', inversion: 0, velocityScale: 85, strumMs: 0 },
};

const PREFS_KEY = 'nova.midiTools.params';
const readParams = (): AllParams => {
  try { const v = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); const out: any = { ...DEFAULTS }; for (const k of Object.keys(DEFAULTS)) out[k] = { ...(DEFAULTS as any)[k], ...(v[k] || {}) }; return out; } catch { return DEFAULTS; }
};

export function runTool(id: ToolId, notes: MidiNote[], sel: Set<string>, ctx: ToolContext, p: AllParams): MidiNote[] {
  switch (id) {
    case 'quantize': return quantize(notes, sel, ctx, p.quantize);
    case 'strum': return strum(notes, sel, ctx, p.strum);
    case 'arp': return arpeggiate(notes, sel, { ...ctx, rand: seededRandom(p.random.seed) }, p.arp);
    case 'flam': return flam(notes, sel, ctx, p.flam);
    case 'chop': return chop(notes, sel, ctx, p.chop);
    case 'roll': return roll(notes, sel, ctx, p.roll);
    case 'velocity': return velocityCurve(notes, sel, ctx, p.velocity);
    case 'random': return randomize(notes, sel, { ...ctx, rand: seededRandom(p.random.seed) }, p.random);
    case 'chord': return chordify(notes, sel, ctx, p.chord);
    case 'legato': return legato(notes, sel, ctx);
    case 'invert': return invert(notes, sel, ctx);
    case 'retro': return retrograde(notes, sel);
  }
}

const Chips: React.FC<{ value: string; options: { id: string; label: string; title?: string }[]; onChange: (v: string) => void; name: string }> = ({ value, options, onChange, name }) => (
  <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={name}>
    {options.map(o => (
      <button key={o.id} type="button" role="radio" aria-checked={value === o.id} title={o.title} onClick={() => onChange(o.id)} data-testid={`opt-${name}-${o.id}`}
        className={`min-h-9 px-2.5 rounded-lg text-[11px] font-bold border ${value === o.id ? 'bg-cyan-400 border-cyan-300 text-black' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}`}>{o.label}</button>
    ))}
  </div>
);

const Range: React.FC<{ label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; testid?: string; fmt?: (v: number) => string }> = ({ label, value, min, max, step = 1, unit = '', onChange, testid, fmt }) => (
  <label className="block">
    <span className="flex justify-between text-[11px] text-slate-300"><span className="font-bold">{label}</span><span className="font-mono text-cyan-200">{fmt ? fmt(value) : `${value}${unit}`}</span></span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} data-testid={testid} className="w-full h-8 accent-cyan-400" />
  </label>
);

/** Courbe dessinée au doigt ou à la souris (8 barres). */
const DrawCurve: React.FC<{ points: number[]; onChange: (p: number[]) => void }> = ({ points, onChange }) => {
  const ref = useRef<HTMLDivElement>(null);
  const drawing = useRef(false);
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const i = Math.max(0, Math.min(points.length - 1, Math.floor(((e.clientX - r.left) / r.width) * points.length)));
    const v = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
    const next = [...points]; next[i] = Math.round(v * 100) / 100; onChange(next);
  };
  return (
    <div ref={ref} className="h-24 rounded-lg bg-black/40 border border-white/10 flex items-end gap-1 p-1 touch-none cursor-crosshair" aria-label="Dessine la courbe de vélocité"
      onPointerDown={e => { drawing.current = true; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); at(e); }}
      onPointerMove={e => { if (drawing.current) at(e); }} onPointerUp={() => { drawing.current = false; }}>
      {points.map((p, i) => <div key={i} className="flex-1 bg-cyan-400/70 rounded-sm pointer-events-none" style={{ height: `${Math.max(4, p * 100)}%` }} />)}
    </div>
  );
};

const GRIDS = ['1/8', '1/16', '1/32', '1/8T', '1/16T'].map(g => ({ id: g, label: g }));

const MidiToolsPanel: React.FC<Props> = ({ notes, selectedIds, ctx, onPreview, onApply, onClose, anchor, initialTool }) => {
  const [tool, setTool] = useState<ToolId | null>(initialTool || null);
  const [params, setParams] = useState<AllParams>(readParams);
  const set = <K extends keyof AllParams>(k: K, patch: Partial<AllParams[K]>) => setParams(p => {
    const n = { ...p, [k]: { ...p[k], ...patch } };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(n)); } catch { /* */ }
    return n;
  });
  const info = MIDI_TOOLS.find(t => t.id === tool);
  const scope = selectedIds.size > 0 ? `${selectedIds.size} note${selectedIds.size > 1 ? 's' : ''} sélectionnée${selectedIds.size > 1 ? 's' : ''}` : 'tout le clip';
  const result = useMemo(() => (tool && !info?.instant ? runTool(tool, notes, selectedIds, ctx, params) : null), [tool, notes, selectedIds, ctx, params, info]);

  useEffect(() => { onPreview(result); }, [result]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onPreview(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (id: ToolId) => {
    const out = id === tool && result ? result : runTool(id, notes, selectedIds, ctx, params);
    onApply(out, MIDI_TOOLS.find(t => t.id === id)!.label);
    onPreview(null);
    onClose();
  };

  const p = params;
  const form = (() => {
    switch (tool) {
      case 'quantize': return (<>
        <Chips name="grille" value={p.quantize.grid} options={[{ id: '1/4', label: '1/4' }, ...GRIDS]} onChange={v => set('quantize', { grid: v })} />
        <Range label="Intensité" value={Math.round(p.quantize.strength * 100)} min={0} max={100} unit=" %" onChange={v => set('quantize', { strength: v / 100 })} testid="q-strength" />
        <Range label="Swing" value={p.quantize.swing} min={50} max={75} unit=" %" onChange={v => set('quantize', { swing: v })} testid="q-swing" />
        <label className="flex items-center gap-2 text-[11px] text-slate-300 min-h-9"><input type="checkbox" className="w-5 h-5 accent-cyan-400" checked={!!p.quantize.ends} onChange={e => set('quantize', { ends: e.target.checked })} />Caler aussi les fins de notes</label>
      </>);
      case 'strum': return (<>
        <Chips name="sens" value={p.strum.direction} options={[{ id: 'up', label: 'Montant' }, { id: 'down', label: 'Descendant' }, { id: 'alternate', label: 'Alterné (guitare)' }]} onChange={v => set('strum', { direction: v as any })} />
        <Range label="Écart entre les notes" value={p.strum.spreadMs} min={5} max={150} unit=" ms" onChange={v => set('strum', { spreadMs: v })} testid="strum-ms" />
        <Range label="Courbe (ralentit ← → accélère)" value={Math.round((p.strum.tension || 0) * 100)} min={-90} max={90} unit=" %" onChange={v => set('strum', { tension: v / 100 })} />
      </>);
      case 'arp': return (<>
        <Chips name="motif" value={p.arp.pattern} options={ARP_PATTERNS} onChange={v => set('arp', { pattern: v as any })} />
        <Chips name="vitesse" value={p.arp.rate} options={['1/8', '1/16', '1/32', '1/8T', '1/16T'].map(r => ({ id: r, label: r }))} onChange={v => set('arp', { rate: v as any })} />
        <Range label="Octaves" value={p.arp.octaves} min={1} max={4} onChange={v => set('arp', { octaves: v })} />
        <Range label="Longueur des notes" value={p.arp.gate} min={10} max={200} unit=" %" onChange={v => set('arp', { gate: v })} />
      </>);
      case 'roll': return (<>
        <Chips name="vitesse" value={p.roll.rate} options={[{ id: '1/16', label: '1/16' }, { id: '1/32', label: '1/32' }, { id: '1/64', label: '1/64' }, { id: '1/16T', label: '1/16 triolet' }, { id: '1/32T', label: '1/32 triolet' }]} onChange={v => set('roll', { rate: v })} />
        <Chips name="rampe" value={p.roll.ramp} options={[{ id: 'flat', label: 'Plate' }, { id: 'up', label: 'Montée' }, { id: 'down', label: 'Descente' }, { id: 'updown', label: 'Vague' }]} onChange={v => set('roll', { ramp: v as any })} />
        {p.roll.ramp !== 'flat' && <>
          <Range label="Vélocité la plus douce" value={Math.round(p.roll.from * 100)} min={5} max={100} unit=" %" onChange={v => set('roll', { from: v / 100 })} />
          <Range label="Vélocité la plus forte" value={Math.round(p.roll.to * 100)} min={5} max={100} unit=" %" onChange={v => set('roll', { to: v / 100 })} />
        </>}
        <Range label="Glisse de hauteur (808, toms)" value={p.roll.pitchRamp || 0} min={-12} max={12} unit=" dt" onChange={v => set('roll', { pitchRamp: v })} />
      </>);
      case 'chop': return (<>
        <Chips name="morceaux" value={p.chop.grid} options={GRIDS} onChange={v => set('chop', { grid: v })} />
        <Range label="Longueur des morceaux" value={p.chop.gate ?? 100} min={20} max={100} unit=" %" onChange={v => set('chop', { gate: v })} />
      </>);
      case 'flam': return (<>
        <Range label="Avance de la petite note" value={p.flam.offsetMs} min={5} max={80} unit=" ms" onChange={v => set('flam', { offsetMs: v })} />
        <Range label="Force de la petite note" value={Math.round(p.flam.velocity * 100)} min={10} max={100} unit=" %" onChange={v => set('flam', { velocity: v / 100 })} />
      </>);
      case 'velocity': return (<>
        <Chips name="forme" value={p.velocity.shape} options={[{ id: 'up', label: 'Montée' }, { id: 'down', label: 'Descente' }, { id: 'sine', label: 'Vague' }, { id: 'drawn', label: 'Dessin' }, { id: 'flat', label: 'Égale' }]} onChange={v => set('velocity', { shape: v as any })} />
        {p.velocity.shape === 'drawn' && <DrawCurve points={p.velocity.points || DEFAULTS.velocity.points!} onChange={pts => set('velocity', { points: pts })} />}
        {p.velocity.shape === 'sine' && <Range label="Vagues" value={p.velocity.cycles || 1} min={1} max={8} onChange={v => set('velocity', { cycles: v })} />}
        <Range label="Minimum" value={Math.round(p.velocity.min * 100)} min={1} max={100} unit=" %" onChange={v => set('velocity', { min: v / 100 })} />
        <Range label="Maximum" value={Math.round(p.velocity.max * 100)} min={1} max={100} unit=" %" onChange={v => set('velocity', { max: v / 100 })} />
      </>);
      case 'random': return (<>
        <Range label={`Hauteur${typeof ctx.keyRoot === 'number' ? ' (dans la gamme)' : ''}`} value={p.random.pitch} min={0} max={7} unit={typeof ctx.keyRoot === 'number' ? ' degrés' : ' dt'} onChange={v => set('random', { pitch: v })} />
        <Range label="Vélocité" value={Math.round(p.random.velocity * 100)} min={0} max={60} unit=" %" onChange={v => set('random', { velocity: v / 100 })} />
        <Range label="Placement" value={p.random.timingMs} min={0} max={50} unit=" ms" onChange={v => set('random', { timingMs: v })} />
        <Range label="Notes touchées" value={Math.round((p.random.chance ?? 1) * 100)} min={5} max={100} unit=" %" onChange={v => set('random', { chance: v / 100 })} />
        <button type="button" onClick={() => set('random', { seed: (p.random.seed % 100000) + 1 })} className="min-h-9 px-3 rounded-lg bg-white/5 border border-white/10 text-[11px] font-bold"><i className="fas fa-dice mr-1.5" />Relancer les dés</button>
      </>);
      case 'chord': return (<>
        <Chips name="accord" value={p.chord.chordType} options={[
          { id: 'MAJOR', label: 'Majeur' }, { id: 'MINOR', label: 'Mineur' }, { id: 'MIN7', label: 'm7' }, { id: 'MAJ7', label: 'Maj7' }, { id: 'DOM7', label: '7' },
          { id: 'SUS2', label: 'sus2' }, { id: 'SUS4', label: 'sus4' }, { id: 'MIN9', label: 'm9' }, { id: 'POWER', label: 'Quinte' },
        ]} onChange={v => set('chord', { chordType: v as any })} />
        <Range label="Renversement" value={p.chord.inversion} min={0} max={3} onChange={v => set('chord', { inversion: v })} />
        <Range label="Force des notes ajoutées" value={p.chord.velocityScale} min={30} max={100} unit=" %" onChange={v => set('chord', { velocityScale: v })} />
        <Range label="Égrener" value={p.chord.strumMs} min={0} max={80} unit=" ms" onChange={v => set('chord', { strumMs: v })} />
      </>);
      default: return null;
    }
  })();

  const style: React.CSSProperties | undefined = anchor ? { left: Math.max(8, Math.min(window.innerWidth - 360, anchor.x)), top: anchor.y } : undefined;
  return (
    <>
      <div className="fixed inset-0 z-[290]" onPointerDown={onClose} />
      <div role="dialog" aria-label="Outils MIDI" data-nova-roll-menu="outils"
        className={`fixed z-[300] rounded-xl border border-white/15 bg-nv-raised p-3 shadow-2xl text-[11px] text-slate-200 overflow-y-auto ${anchor ? 'w-[352px] max-h-[75vh]' : 'inset-x-0 bottom-0 rounded-b-none max-h-[80dvh]'}`}
        style={style} onPointerDown={e => e.stopPropagation()}>
        {!tool ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Outils · {scope}</span>
              <button type="button" aria-label="Fermer" onClick={onClose} className="w-9 h-9 [@media(pointer:coarse)]:w-10 [@media(pointer:coarse)]:h-10 rounded-full hover:bg-white/10"><i className="fas fa-times" /></button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {MIDI_TOOLS.map(t => (
                <button key={t.id} type="button" title={t.hint} data-testid={`tool-${t.id}`} disabled={!notes.length}
                  onClick={() => (t.instant ? apply(t.id) : setTool(t.id))}
                  className="min-h-11 px-2.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-left flex items-center gap-2 font-bold disabled:opacity-40">
                  <i className={`fas ${t.icon} w-4 text-center text-cyan-300`} /><span className="truncate">{t.label}</span>
                </button>
              ))}
            </div>
            {!notes.length && <p className="mt-2 text-slate-500">Pose d’abord quelques notes : les outils travaillent sur les notes du clip.</p>}
          </>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <button type="button" aria-label="Retour aux outils" onClick={() => { setTool(null); onPreview(null); }} className="w-9 h-9 rounded-full hover:bg-white/10"><i className="fas fa-arrow-left" /></button>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-black text-white">{info?.label}</div>
                <div className="text-[10px] text-slate-400 truncate">{scope} · aperçu dans la grille</div>
              </div>
            </div>
            <p className="text-[10px] text-slate-500">{info?.hint}</p>
            {form}
            {result && <p className="text-[11px] text-cyan-200" role="status" data-testid="tool-preview-count">Aperçu : {result.length} note{result.length > 1 ? 's' : ''} (avant : {notes.length})</p>}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button type="button" onClick={() => { onPreview(null); onClose(); }} className="min-h-10 rounded-lg bg-white/5 border border-white/10 font-bold">Annuler</button>
              <button type="button" data-testid="tool-apply" onClick={() => apply(tool)} className="min-h-10 rounded-lg bg-cyan-400 text-black font-black">Appliquer</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default MidiToolsPanel;
