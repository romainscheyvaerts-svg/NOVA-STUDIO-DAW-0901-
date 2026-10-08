import React, { useMemo, useRef, useState } from 'react';
import { MidiNote } from '../types';
import {
  MidiCcPoint, COMMON_LANES, ccLabel, ccShortLabel, ccKey, ccRange, ccDefault, isPitchBend, isSwitchCc, linePoints, replacePoints, sortPoints, clampCc,
} from '../utils/midiCc';

/**
 * Couloirs du piano roll (R16) : vélocité, pitch bend, modulation, sustain,
 * expression et n'importe quel CC, comme les couloirs de contrôleurs de Pro
 * Tools et l'« Event editor » de FL Studio.
 * - Crayon : dessine à main levée (un point toutes les 30 ms, la résolution du
 *   crayon de Pro Tools) ; sur la vélocité, règle les notes survolées.
 * - Ligne : tire une rampe droite (fondu de modulation, montée de filtre).
 * - Alt + glisser : efface les points du passage.
 * Une seule étape d'annulation par geste (écrit au relâchement).
 */

export const VELOCITY_LANE = 'vel';
const PENCIL_RES = 0.03;

type LaneTool = 'pencil' | 'line';

interface Props {
  notes: MidiNote[];
  cc: Record<string, MidiCcPoint[]> | undefined;
  duration: number;
  zoomX: number;
  /** Largeur du contenu (comme la grille). */
  width: number;
  /** Colonne de gauche (alignée sur le clavier). */
  sideWidth: string;
  selectedIds: Set<string>;
  color: string;
  onNotes: (notes: MidiNote[], label: string) => void;
  onCc: (key: string, points: MidiCcPoint[], label: string) => void;
  innerRef: React.RefObject<HTMLDivElement>;
}

const MidiCcLanes: React.FC<Props> = ({ notes, cc, duration, zoomX, width, sideWidth, selectedIds, color, onNotes, onCc, innerRef }) => {
  const [lane, setLane] = useState<string>(VELOCITY_LANE);
  const [tool, setTool] = useState<LaneTool>('pencil');
  const [custom, setCustom] = useState('');
  const [draft, setDraft] = useState<{ notes?: MidiNote[]; points?: MidiCcPoint[]; line?: { x0: number; y0: number; x1: number; y1: number } } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x0: number; y0: number; t0: number; tMin: number; tMax: number; erase: boolean; pts: MidiCcPoint[]; notes: MidiNote[] } | null>(null);

  const lanes = useMemo(() => {
    const extra = Object.keys(cc || {}).filter(k => (cc![k] || []).length && !COMMON_LANES.includes(k));
    return [VELOCITY_LANE, ...COMMON_LANES, ...extra];
  }, [cc]);
  const isVel = lane === VELOCITY_LANE;
  const range = isVel ? { min: 1, max: 127 } : ccRange(lane);
  const points = draft?.points ?? sortPoints(cc?.[lane] || []);
  const shownNotes = draft?.notes ?? notes;

  const geom = () => {
    const r = boxRef.current!.getBoundingClientRect();
    const sl = innerRef.current?.scrollLeft || 0;
    return { r, sl };
  };
  const toT = (clientX: number) => { const { r, sl } = geom(); return Math.max(0, (clientX - r.left + sl) / zoomX); };
  const toV = (clientY: number) => {
    const { r } = geom();
    const f = 1 - Math.max(0, Math.min(1, (clientY - r.top) / Math.max(1, r.height)));
    const raw = range.min + f * (range.max - range.min);
    return isVel ? Math.max(1, Math.min(127, Math.round(raw))) : isSwitchCc(lane) ? (raw >= 64 ? 127 : 0) : clampCc(lane, raw);
  };
  const yOf = (v: number, h: number) => h * (1 - (v - range.min) / Math.max(1, range.max - range.min));

  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const t = toT(e.clientX), v = toV(e.clientY);
    gesture.current = { x0: e.clientX, y0: e.clientY, t0: t, tMin: t, tMax: t, erase: e.altKey, pts: [{ t, v }], notes: [...notes] };
    move(e);
  };

  const move = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const t = toT(e.clientX), v = toV(e.clientY);
    g.tMin = Math.min(g.tMin, t); g.tMax = Math.max(g.tMax, t);
    if (g.erase) { setDraft({ points: (cc?.[lane] || []).filter(p => p.t < g.tMin || p.t > g.tMax), notes }); return; }
    if (tool === 'line') {
      const { r, sl } = geom();
      setDraft({ line: { x0: g.x0 - r.left + sl, y0: g.y0 - r.top, x1: e.clientX - r.left + sl, y1: e.clientY - r.top } });
      return;
    }
    if (isVel) {
      // Crayon sur la vélocité : chaque note survolée prend la hauteur du crayon.
      const tol = 4 / zoomX;
      const sel = selectedIds.size > 0;
      g.notes = g.notes.map(n => (Math.abs(n.start - t) <= tol && (!sel || selectedIds.has(n.id)) ? { ...n, velocity: v / 127 } : n));
      setDraft({ notes: g.notes });
      return;
    }
    const last = g.pts[g.pts.length - 1];
    if (Math.abs(t - last.t) >= PENCIL_RES || last.v !== v) g.pts.push({ t, v });
    const a = g.tMin, b = g.tMax;
    setDraft({ points: replacePoints(cc?.[lane], a, b, sortPoints([...g.pts]).filter((p, i, arr) => i === 0 || Math.abs(p.t - arr[i - 1].t) >= PENCIL_RES * 0.5 || p.v !== arr[i - 1].v)) });
  };

  const up = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const label = isVel ? 'Vélocité' : ccLabel(lane);
    if (g.erase) {
      if (!isVel) onCc(lane, (cc?.[lane] || []).filter(p => p.t < g.tMin || p.t > g.tMax), `${label} effacé`);
      setDraft(null);
      return;
    }
    if (tool === 'line') {
      const t1 = toT(e.clientX), v1 = toV(e.clientY);
      const v0 = g.pts[0].v;
      if (isVel) {
        const a = Math.min(g.t0, t1), b = Math.max(g.t0, t1);
        const sel = selectedIds.size > 0;
        const next = notes.map(n => {
          if (n.start < a - 1e-9 || n.start > b + 1e-9 || (sel && !selectedIds.has(n.id))) return n;
          const f = b > a ? (n.start - g.t0) / (t1 - g.t0) : 1;
          return { ...n, velocity: Math.max(1, Math.min(127, Math.round(v0 + (v1 - v0) * f))) / 127 };
        });
        onNotes(next, 'Rampe de vélocité');
      } else {
        const fresh = linePoints(lane, g.t0, v0, t1, v1, PENCIL_RES);
        onCc(lane, replacePoints(cc?.[lane], Math.min(g.t0, t1), Math.max(g.t0, t1), fresh), `Ligne de ${label.toLowerCase()}`);
      }
      setDraft(null);
      return;
    }
    if (isVel) onNotes(g.notes, 'Vélocité dessinée');
    else if (draft?.points) onCc(lane, draft.points, `${label} dessiné`);
    setDraft(null);
  };

  const h = 1; // hauteur relative (SVG en viewBox 0..100)
  void h;
  const stepPath = (pts: MidiCcPoint[], H: number) => {
    if (!pts.length) return '';
    const W = Math.max(width, duration * zoomX);
    let d = `M 0 ${yOf(ccDefault(lane), H)}`;
    let prevY = yOf(ccDefault(lane), H);
    for (const p of pts) {
      const x = p.t * zoomX, y = yOf(p.v, H);
      d += ` L ${x} ${prevY} L ${x} ${y}`;
      prevY = y;
    }
    d += ` L ${W} ${prevY}`;
    return d;
  };

  const H = 100;
  const addCustom = () => {
    const n = Number(custom);
    if (Number.isInteger(n) && n >= 0 && n <= 127) { setLane(ccKey(n)); setCustom(''); }
  };

  return (
    <div className="h-[30%] border-t border-white/10 bg-[#0f1115] flex relative z-30" data-nova-cc-lanes="">
      <div className={`flex-shrink-0 border-r border-white/10 bg-[#0c0d10] ${sideWidth} p-1 flex flex-col gap-1 overflow-y-auto no-scrollbar`}>
        <select aria-label="Couloir affiché" value={lane} onChange={e => { setLane(e.target.value); setDraft(null); }} data-nova-cc-select=""
          title="Couloir : vélocité, pitch bend, modulation, sustain, expression ou un autre CC (couloirs de contrôleurs de Pro Tools, Event editor de FL)"
          className="w-full h-7 [@media(pointer:coarse)]:h-10 rounded bg-black/40 border border-white/15 text-[9px] text-white px-0.5">
          {lanes.map(k => <option key={k} value={k} title={k === VELOCITY_LANE ? 'Vélocité' : ccLabel(k)}>{k === VELOCITY_LANE ? 'Vélocité' : ccShortLabel(k)}{k !== VELOCITY_LANE && (cc?.[k]?.length || 0) > 0 ? ' •' : ''}</option>)}
        </select>
        <div className="flex gap-1">
          <button type="button" aria-label="Crayon" aria-pressed={tool === 'pencil'} onClick={() => setTool('pencil')} data-nova-cc-tool="pencil"
            title="Crayon : dessine à main levée (vélocité : règle les notes survolées). Alt + glisser efface."
            className={`flex-1 h-7 [@media(pointer:coarse)]:h-10 rounded text-[10px] ${tool === 'pencil' ? 'bg-cyan-400 text-black' : 'bg-white/5 text-slate-300'}`}><i className="fas fa-pencil-alt"></i></button>
          <button type="button" aria-label="Ligne" aria-pressed={tool === 'line'} onClick={() => setTool('line')} data-nova-cc-tool="line"
            title="Ligne : tire une rampe droite (outil Ligne du crayon de Pro Tools)"
            className={`flex-1 h-7 [@media(pointer:coarse)]:h-10 rounded text-[10px] ${tool === 'line' ? 'bg-cyan-400 text-black' : 'bg-white/5 text-slate-300'}`}><i className="fas fa-slash"></i></button>
        </div>
        <div className="flex gap-0.5">
          <input aria-label="Numéro de CC" inputMode="numeric" placeholder="CC" value={custom} onChange={e => setCustom(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
            onKeyDown={e => { if (e.key === 'Enter') addCustom(); }} className="w-full min-w-0 h-7 rounded bg-black/40 border border-white/15 text-[9px] text-white px-1" />
          <button type="button" aria-label="Afficher ce CC" onClick={addCustom} className="h-7 px-1 rounded bg-white/5 text-[9px] text-slate-300">OK</button>
        </div>
        {!isVel && (cc?.[lane]?.length || 0) > 0 && (
          <button type="button" onClick={() => onCc(lane, [], `${ccLabel(lane)} vidé`)} className="h-7 rounded bg-white/5 text-[9px] text-slate-400 hover:text-red-300" title="Effacer tout ce couloir">Vider</button>
        )}
      </div>
      <div ref={innerRef} className="flex-1 overflow-hidden relative">
        <div ref={boxRef} style={{ width, height: '100%', position: 'relative', touchAction: 'none' }} className="cursor-crosshair"
          onPointerDown={onDown} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { gesture.current = null; setDraft(null); }} data-nova-cc-area={lane}>
          {isVel ? shownNotes.map(note => {
            const sel = selectedIds.has(note.id);
            return (
              <div key={`vel-${note.id}`} className={`absolute bottom-0 w-1.5 ${note.muted ? 'bg-slate-600' : sel ? 'bg-white' : 'bg-slate-500'}`}
                style={{ left: note.start * zoomX, height: `${Math.max(1, Math.round(note.velocity * 127)) / 127 * 100}%`, opacity: note.muted ? 0.5 : 1 }}
                title={`Vélocité ${Math.round(note.velocity * 127)}`} data-nova-vel={Math.round(note.velocity * 127)} />
            );
          }) : (
            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${width} ${H}`} preserveAspectRatio="none" aria-hidden>
              {isPitchBend(lane) && <line x1={0} x2={width} y1={yOf(0, H)} y2={yOf(0, H)} stroke="currentColor" className="text-white/20" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
              <path d={stepPath(points, H)} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              {points.map((p, i) => <circle key={i} cx={p.t * zoomX} cy={yOf(p.v, H)} r={1.6} fill={color} vectorEffect="non-scaling-stroke" />)}
            </svg>
          )}
          {draft?.line && (
            <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden>
              <line x1={draft.line.x0} y1={draft.line.y0} x2={draft.line.x1} y2={draft.line.y1} stroke="#22d3ee" strokeWidth={2} strokeDasharray="5 3" />
            </svg>
          )}
          {!isVel && !points.length && !draft && (
            <div className="absolute left-3 top-2 text-[10px] text-slate-500 pointer-events-none">
              {ccLabel(lane)} : dessine au crayon, ou enregistre en jouant (molette, pédale…).
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MidiCcLanes;
