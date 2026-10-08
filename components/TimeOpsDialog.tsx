import React, { useMemo, useState } from 'react';
import type { DAWState } from '../types';
import { buildTempoMap, formatBarsBeats, segmentAtTime, timeToPosition, barToTime, positionToTime } from '../utils/tempoMap';
import { newTimeOpId, TimeOp } from '../utils/timeOps';
import { runTimeOp, TimeDialogPreset } from '../utils/r12Bus';
import { arrangeLaneStore, useArrangeLaneShown } from './ArrangeLane';

/**
 * Fenêtre « Temps » (Pro Tools : Event › Time Operations › Insert Time / Cut
 * Time, Edit › Insert Silence) : insérer ou supprimer du temps à un endroit,
 * sur toutes les pistes ou sur les pistes sélectionnées. Repères, accords,
 * tempo, automation, boucle et clips suivent. Longueur en mesures + temps (au
 * tempo de l'endroit) ou en secondes.
 */
const fmtS = (s: number) => `${(Math.round(s * 1000) / 1000).toFixed(3).replace('.', ',')} s`;

const TimeOpsDialog: React.FC<{ state: DAWState; preset?: TimeDialogPreset; onClose: () => void; compact?: boolean }> = ({ state, preset, onClose, compact }) => {
  const map = useMemo(() => buildTempoMap(state.bpm, state.timeSignature, state.tempoEvents), [state.bpm, state.timeSignature, state.tempoEvents]);
  const [mode, setMode] = useState<'insert' | 'delete'>(preset?.mode || 'insert');
  // Position (s) : réglée en mesure + temps (1 = la première) ou reprise de la sélection / tête de lecture.
  const [atSec, setAtSec] = useState(Math.max(0, preset?.at ?? 0));
  const p0 = timeToPosition(map, atSec + 1e-6);
  const bar = p0.bar + 1, beat = p0.beat + 1;
  const setPos = (b: number, bt: number) => setAtSec(positionToTime(map, Math.max(0, b - 1), Math.max(0, bt - 1)));
  const [unit, setUnit] = useState<'bars' | 'sec'>('bars');
  const ins = segmentAtTime(map, Math.max(0, atSec - 1e-6));
  const presetLen = preset?.length ?? (preset?.end !== undefined ? preset.end - (preset.at || 0) : undefined);
  const [lenBars, setLenBars] = useState(() => (presetLen ? Math.floor(presetLen / ins.barSec + 1e-6) : 1));
  const [lenBeats, setLenBeats] = useState(() => (presetLen ? Math.round((presetLen - Math.floor(presetLen / ins.barSec + 1e-6) * ins.barSec) / ins.beatSec) : 0));
  const [lenSec, setLenSec] = useState(() => presetLen ?? ins.barSec);
  const sel = (preset?.trackIds || []).filter(id => state.tracks.some(t => t.id === id));
  const [scope, setScope] = useState<'all' | 'sel'>(sel.length && sel.length < state.tracks.length - 1 ? 'sel' : 'all');
  const [rulers, setRulers] = useState(scope === 'all');
  const laneShown = useArrangeLaneShown();
  const len = unit === 'bars' ? lenBars * ins.barSec + lenBeats * ins.beatSec : Math.max(0, lenSec);
  const at = atSec;
  const trackIds = scope === 'all' ? 'all' as const : sel;

  const preview = useMemo(() => {
    const end = mode === 'insert' ? at : at + len;
    const clips = state.tracks.filter(t => scope === 'all' || sel.includes(t.id)).reduce((n, t) => n + t.clips.filter(c => c.start + c.duration > at).length, 0);
    const markers = rulers ? (state.markers || []).filter(m => m.time >= at - 1e-6).length : 0;
    const chords = rulers ? (state.chords || []).filter(c => c.end > at).length : 0;
    const tempo = rulers ? (state.tempoEvents || []).filter(e => barToTime(map, e.bar) >= at - 1e-6).length : 0;
    void end;
    return { clips, markers, chords, tempo };
  }, [mode, at, len, scope, sel, rulers, state.tracks, state.markers, state.chords, state.tempoEvents, map]);

  const go = () => {
    if (!(len > 1e-4)) return;
    const op: TimeOp = mode === 'insert'
      ? { kind: 'insert', id: newTimeOpId(), at, length: len, tracks: trackIds, rulers }
      : { kind: 'delete', id: newTimeOpId(), start: at, end: at + len, tracks: trackIds, rulers };
    runTimeOp(op);
    onClose();
  };
  const num = (v: string, min: number) => Math.max(min, Math.round(Number(v) || 0));
  const field = 'h-9 rounded-lg border border-nv-line bg-nv-bg px-2 text-[13px] font-bold text-nv-ink tabular-nums';

  return (
    <div className="fixed inset-0 z-[760] flex items-center justify-center bg-black/50 p-3" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="timeops-title" data-testid="time-ops-dialog"
        className={`w-full ${compact ? 'max-w-[420px]' : 'max-w-[460px]'} rounded-2xl border border-nv-line bg-nv-panel p-4 shadow-2xl flex flex-col gap-3`}>
        <div className="flex items-center gap-2">
          <i className="fas fa-arrows-alt-h text-nv-accent" />
          <h2 id="timeops-title" className="flex-1 text-[14px] font-bold text-nv-ink">Temps</h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="nova-hit-tactile w-8 h-8 rounded-lg text-nv-muted hover:text-nv-ink"><i className="fas fa-times" /></button>
        </div>
        <div role="radiogroup" aria-label="Opération" className="flex gap-1 rounded-xl bg-nv-well p-1">
          {([['insert', 'Insérer du temps', 'Pro Tools : Insert Silence (Ctrl+Maj+E) / Insert Time'], ['delete', 'Supprimer du temps', 'Pro Tools : Cut Time']] as const).map(([m, label, pt]) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} data-testid={`timeops-mode-${m}`} title={pt} onClick={() => setMode(m)}
              className={`nova-hit-tactile flex-1 h-9 rounded-lg text-[12px] font-bold ${mode === m ? 'bg-nv-accent text-black' : 'text-nv-muted hover:text-nv-ink'}`}>{label}</button>
          ))}
        </div>
        <div className="grid grid-cols-[88px_1fr] items-center gap-x-2 gap-y-2.5">
          <span className="text-[11px] font-bold text-nv-muted">{mode === 'insert' ? 'À' : 'À partir de'}</span>
          <div className="flex items-center gap-1.5">
            <label className="flex items-center gap-1 text-[11px] text-nv-muted">Mesure
              <input type="number" min={1} value={bar} onChange={e => setPos(num(e.target.value, 1), beat)} data-testid="timeops-bar" className={`${field} w-16`} /></label>
            <label className="flex items-center gap-1 text-[11px] text-nv-muted">temps
              <input type="number" min={1} max={p0.seg.num} value={beat} onChange={e => setPos(bar, Math.min(p0.seg.num, num(e.target.value, 1)))} data-testid="timeops-beat" className={`${field} w-14`} /></label>
            <span className="ml-auto text-[10px] font-mono text-nv-muted">{fmtS(at)}</span>
          </div>
          <span className="text-[11px] font-bold text-nv-muted">Durée</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {unit === 'bars' ? (
              <>
                <label className="flex items-center gap-1 text-[11px] text-nv-muted">
                  <input type="number" min={0} value={lenBars} onChange={e => setLenBars(num(e.target.value, 0))} data-testid="timeops-len-bars" className={`${field} w-16`} />mesure{lenBars > 1 ? 's' : ''}</label>
                <label className="flex items-center gap-1 text-[11px] text-nv-muted">
                  <input type="number" min={0} value={lenBeats} onChange={e => setLenBeats(num(e.target.value, 0))} data-testid="timeops-len-beats" className={`${field} w-14`} />temps</label>
              </>
            ) : (
              <label className="flex items-center gap-1 text-[11px] text-nv-muted">
                <input type="number" min={0} step={0.001} value={Math.round(lenSec * 1000) / 1000} onChange={e => setLenSec(Math.max(0, Number(e.target.value) || 0))} data-testid="timeops-len-sec" className={`${field} w-24`} />s</label>
            )}
            <button type="button" onClick={() => { if (unit === 'bars') setLenSec(len); setUnit(u => (u === 'bars' ? 'sec' : 'bars')); }}
              className="nova-hit-tactile ml-auto h-7 rounded-full bg-nv-well px-2.5 text-[10px] font-bold text-nv-muted hover:text-nv-ink">{unit === 'bars' ? 'en secondes' : 'en mesures'}</button>
          </div>
          <span className="text-[11px] font-bold text-nv-muted">Pistes</span>
          <div className="flex gap-1">
            <button type="button" aria-pressed={scope === 'all'} onClick={() => { setScope('all'); setRulers(true); }} data-testid="timeops-scope-all"
              className={`nova-hit-tactile flex-1 h-8 rounded-lg text-[11px] font-bold ${scope === 'all' ? 'bg-nv-accent text-black' : 'bg-nv-well text-nv-muted'}`}>Toutes</button>
            <button type="button" aria-pressed={scope === 'sel'} disabled={!sel.length} onClick={() => { setScope('sel'); setRulers(false); }} data-testid="timeops-scope-sel"
              title={sel.length ? '' : 'Sélectionne d’abord une plage sur des pistes'}
              className={`nova-hit-tactile flex-1 h-8 rounded-lg text-[11px] font-bold disabled:opacity-40 ${scope === 'sel' ? 'bg-nv-accent text-black' : 'bg-nv-well text-nv-muted'}`}>Sélectionnées ({sel.length})</button>
          </div>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-nv-ink">
          <input type="checkbox" checked={rulers} onChange={e => setRulers(e.target.checked)} data-testid="timeops-rulers" className="accent-cyan-500 w-4 h-4" />
          Repères, accords, tempo et boucle suivent
        </label>
        <p data-testid="timeops-preview" className="rounded-xl bg-nv-well px-3 py-2 text-[11px] leading-snug text-nv-muted">
          {mode === 'insert' ? 'Insère' : 'Supprime'} <b className="text-nv-ink">{unit === 'bars' ? ([lenBars ? `${lenBars} mesure${lenBars > 1 ? 's' : ''}` : '', lenBeats ? `${lenBeats} temps` : ''].filter(Boolean).join(' ') || '0 temps') : fmtS(len)}</b>
          {' '}({fmtS(len)}) à <b className="text-nv-ink font-mono">{formatBarsBeats(map, at)}</b>.
          {' '}{mode === 'insert' ? 'Recule' : 'Avance'} : {preview.clips} clip{preview.clips > 1 ? 's' : ''}{rulers ? `, ${preview.markers} repère${preview.markers > 1 ? 's' : ''}, ${preview.chords} accord${preview.chords > 1 ? 's' : ''}, ${preview.tempo} changement${preview.tempo > 1 ? 's' : ''} de tempo` : ''}, et l’automation.
          {unit === 'sec' && Math.abs(len / ins.beatSec - Math.round(len / ins.beatSec)) > 1e-6 && rulers && <span className="block text-amber-300">Pas un nombre entier de temps : le tempo suivra à la mesure près.</span>}
        </p>
        {!compact && (
          <label className="flex items-center gap-2 text-[11px] text-nv-muted">
            <input type="checkbox" checked={laneShown} onChange={e => arrangeLaneStore.set(e.target.checked)} className="accent-cyan-500 w-4 h-4" />
            Afficher la piste Arrangement (sections à glisser depuis la règle)
          </label>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="nova-hit-tactile h-10 flex-1 rounded-xl bg-nv-well text-[12px] font-bold text-nv-ink">Annuler</button>
          <button type="button" onClick={go} disabled={!(len > 1e-4)} data-testid="timeops-go"
            className="nova-hit-tactile h-10 flex-[2] rounded-xl bg-nv-accent text-[12px] font-bold text-black disabled:opacity-40">{mode === 'insert' ? 'Insérer' : 'Supprimer'} {fmtS(len)}</button>
        </div>
      </div>
    </div>
  );
};

export default TimeOpsDialog;
