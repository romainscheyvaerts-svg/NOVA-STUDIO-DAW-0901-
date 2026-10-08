import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { TimeSignature } from '../types';
import { METER_CHOICES, buildTempoMap, barToTime, upsertTempoEvent, removeTempoEvent, type TempoEvent } from '../utils/tempoMap';
import { sharedTap, roundTapped } from '../utils/tapTempo';
import { metronomeService } from '../services/MetronomeService';

interface Props {
  open: boolean;
  onClose: () => void;
  bpm: number;
  timeSignature: TimeSignature;
  events: TempoEvent[];
  onChange: (p: { bpm?: number; timeSignature?: TimeSignature; tempoEvents?: TempoEvent[] }) => void;
  /** Mesure (0 = la 1re) proposée pour un nouveau changement (tête de lecture). */
  suggestedBar?: number;
  /** Changement à éditer à l'ouverture (clic dans la piste tempo). */
  focusBar?: number | null;
  tempoLaneOn: boolean;
  onTempoLane: (on: boolean) => void;
}

const fmtS = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0').replace('.', ',')}`;

/**
 * Tempo et mesure (R2) : tap tempo, saisie du BPM, mesure (3/4, 6/8, 7/8…) et
 * changements dans le morceau — la piste tempo / mesure de Pro Tools, la piste
 * Tempo globale de Logic, l'automation de tempo d'Ableton et de FL.
 */
const TempoDialog: React.FC<Props> = ({ open, onClose, bpm, timeSignature, events, onChange, suggestedBar = 1, focusBar = null, tempoLaneOn, onTempoLane }) => {
  const [bpmText, setBpmText] = useState(String(bpm));
  const [tapped, setTapped] = useState<number | null>(null);
  const [tapCount, setTapCount] = useState(0);
  const [newBar, setNewBar] = useState(Math.max(2, suggestedBar + 1));
  const [newBpm, setNewBpm] = useState(String(bpm));
  const [newMeter, setNewMeter] = useState(`${timeSignature.numerator}/${timeSignature.denominator}`);
  const tapRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (open) { setBpmText(String(bpm)); setTapped(null); setTapCount(0); sharedTap.reset(); } }, [open, bpm]);
  useEffect(() => {
    if (!open) return;
    const b = focusBar !== null && focusBar !== undefined ? focusBar + 1 : Math.max(2, suggestedBar + 1);
    setNewBar(b);
    const ex = events.find(e => e.bar === b - 1);
    setNewBpm(String(ex?.bpm ?? bpm));
    setNewMeter(ex?.numerator ? `${ex.numerator}/${ex.denominator}` : `${timeSignature.numerator}/${timeSignature.denominator}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusBar, suggestedBar]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); return; }
      // T dans la fenêtre : tape (comme le champ tempo de Pro Tools)
      if ((e.key === 't' || e.key === 'T') && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); e.stopImmediatePropagation(); doTap(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);

  const map = useMemo(() => buildTempoMap(bpm, timeSignature, events), [bpm, timeSignature, events]);
  if (!open) return null;

  const doTap = () => {
    const v = sharedTap.tap(performance.now());
    setTapCount(sharedTap.count());
    metronomeService.playPreviewClick(sharedTap.count() === 1);
    if (v) { const r = roundTapped(v); setTapped(r); setBpmText(String(r)); }
  };
  const applyBpm = (v: number) => { if (Number.isFinite(v) && v >= 20 && v <= 999) onChange({ bpm: Math.round(v * 100) / 100 }); };
  const parseMeter = (s: string) => { const [n, d] = s.split('/').map(Number); return { numerator: n, denominator: d }; };
  const sorted = [...events].sort((a, b) => a.bar - b.bar);
  const chip = (on: boolean) => `nova-hit min-h-10 px-2.5 rounded-lg border text-[12px] font-bold ${on ? 'bg-cyan-500 text-black border-cyan-400' : 'border-nv-line/15 text-nv-ink hover:bg-nv-raised'}`;
  const sec = 'text-[10px] font-black text-nv-accent uppercase tracking-widest block border-b border-nv-line/15 pb-1';
  const field = 'min-h-10 bg-nv-well/40 border border-nv-line/15 rounded-lg px-3 text-[13px] text-nv-ink font-bold outline-none focus:border-nv-accent';

  return (
    <div className="fixed inset-0 z-[1250] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="tempo-title" data-testid="tempo-dialog" onMouseDown={e => e.stopPropagation()}
        className="w-full sm:max-w-xl max-h-[92dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-nv-line/15 bg-nv-surface text-nv-ink shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-nv-line/15">
          <div>
            <h2 id="tempo-title" className="text-[14px] font-black uppercase tracking-widest">Tempo et mesure</h2>
            <p className="text-[12px] text-nv-muted">Tape le tempo (touche T), choisis la mesure, ajoute des changements dans le morceau.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer" title="Fermer (Échap)" className="nova-hit w-9 h-9 rounded-full text-nv-muted hover:text-nv-ink flex items-center justify-center"><i className="fas fa-times" aria-hidden="true"></i></button>
        </div>

        <div className="p-5 space-y-6">
          <section className="space-y-3">
            <span className={sec}>Tempo du début</span>
            <div className="flex flex-col sm:flex-row gap-3 items-stretch">
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => applyBpm(bpm - 1)} aria-label="Tempo −1" className="nova-hit w-11 h-11 rounded-xl border border-nv-line/15 text-[18px] font-black">−</button>
                <input value={bpmText} inputMode="decimal" aria-label="Tempo en BPM" data-testid="tempo-bpm-input"
                  onChange={e => setBpmText(e.target.value.replace(/[^0-9.,]/g, ''))}
                  onBlur={() => applyBpm(Number(bpmText.replace(',', '.')))}
                  onKeyDown={e => { if (e.key === 'Enter') applyBpm(Number(bpmText.replace(',', '.'))); }}
                  className={`${field} w-24 text-center text-[20px]`} />
                <button type="button" onClick={() => applyBpm(bpm + 1)} aria-label="Tempo +1" className="nova-hit w-11 h-11 rounded-xl border border-nv-line/15 text-[18px] font-black">+</button>
                <span className="text-[12px] text-nv-muted font-bold">BPM</span>
              </div>
              <button ref={tapRef} type="button" data-testid="tempo-tap"
                onPointerDown={e => { e.preventDefault(); doTap(); }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doTap(); } }}
                title="Tape au rythme de la prod (4 fois ou plus). Comme le tap tempo de Pro Tools (T), de Logic, d'Ableton et de FL."
                className="flex-1 min-h-16 rounded-2xl border-2 border-dashed border-nv-accent/60 bg-cyan-500/10 text-nv-accent font-black text-[15px] select-none touch-manipulation active:scale-[0.98]">
                TAP {tapped ? <span className="ml-2 font-mono">{tapped}</span> : null}
                <span className="block text-[11px] font-bold text-nv-muted">{tapCount === 0 ? 'Tape ici (ou T) au rythme' : tapCount < 4 ? 'Continue…' : 'Encore pour affiner'}</span>
              </button>
            </div>
            {tapped !== null && tapped !== bpm && (
              <button type="button" data-testid="tempo-tap-apply" onClick={() => applyBpm(tapped)} className="w-full min-h-11 rounded-xl bg-cyan-500 text-black text-[13px] font-black">
                Utiliser {tapped} BPM
              </button>
            )}
          </section>

          <section className="space-y-3">
            <span className={sec}>Mesure du début</span>
            <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Mesure du début">
              {METER_CHOICES.map(m => (
                <button key={m.label} type="button" role="radio" aria-checked={timeSignature.numerator === m.num && timeSignature.denominator === m.den}
                  data-testid={`tempo-meter-${m.num}-${m.den}`}
                  onClick={() => onChange({ timeSignature: { numerator: m.num, denominator: m.den } })}
                  title={m.den === 8 ? `${m.label} : le clic bat les croches` : `${m.label} : ${m.num} temps par mesure`}
                  className={chip(timeSignature.numerator === m.num && timeSignature.denominator === m.den)}>{m.label}</button>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <span className={sec}>Changements dans le morceau (piste tempo)</span>
            {sorted.length === 0 ? (
              <p className="text-[12px] text-nv-muted">Aucun changement : tout le morceau est à {bpm} BPM en {timeSignature.numerator}/{timeSignature.denominator}.</p>
            ) : (
              <ul className="space-y-1.5" data-testid="tempo-events">
                {sorted.map(e => {
                  const s = map.segments.find(x => x.bar === e.bar);
                  return (
                    <li key={e.id} className="flex items-center gap-2 rounded-xl border border-nv-line/15 bg-nv-well/30 px-3 py-2 text-[12px]">
                      <span className="font-black w-20">Mesure {e.bar + 1}</span>
                      <span className="flex-1 text-nv-muted">{s ? `${s.bpm} BPM · ${s.num}/${s.den} · à ${fmtS(barToTime(map, e.bar))}` : '—'}</span>
                      <button type="button" onClick={() => { setNewBar(e.bar + 1); setNewBpm(String(e.bpm ?? s?.bpm ?? bpm)); setNewMeter(`${s?.num ?? 4}/${s?.den ?? 4}`); }}
                        className="nova-hit min-h-9 px-2 rounded-lg text-nv-ink hover:bg-nv-raised" aria-label={`Modifier le changement de la mesure ${e.bar + 1}`}><i className="fas fa-pen" aria-hidden="true"></i></button>
                      <button type="button" onClick={() => onChange({ tempoEvents: removeTempoEvent(events, e.id) })}
                        className="nova-hit min-h-9 px-2 rounded-lg text-red-400 hover:bg-nv-raised" aria-label={`Supprimer le changement de la mesure ${e.bar + 1}`}><i className="fas fa-trash" aria-hidden="true"></i></button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="grid grid-cols-3 gap-2 items-end">
              <label className="block"><span className="text-[11px] font-bold text-nv-muted">À la mesure</span>
                <input type="number" min={2} value={newBar} onChange={e => setNewBar(Math.max(2, Math.round(Number(e.target.value) || 2)))} className={`${field} w-full`} data-testid="tempo-new-bar" /></label>
              <label className="block"><span className="text-[11px] font-bold text-nv-muted">Tempo</span>
                <input value={newBpm} inputMode="decimal" onChange={e => setNewBpm(e.target.value.replace(/[^0-9.,]/g, ''))} className={`${field} w-full`} data-testid="tempo-new-bpm" /></label>
              <label className="block"><span className="text-[11px] font-bold text-nv-muted">Mesure</span>
                <select value={newMeter} onChange={e => setNewMeter(e.target.value)} className={`${field} w-full`} data-testid="tempo-new-meter">
                  {METER_CHOICES.map(m => <option key={m.label} value={`${m.num}/${m.den}`}>{m.label}</option>)}
                </select></label>
            </div>
            <button type="button" data-testid="tempo-add"
              onClick={() => {
                const v = Number(newBpm.replace(',', '.'));
                const mt = parseMeter(newMeter);
                onChange({ tempoEvents: upsertTempoEvent(events, { bar: newBar - 1, bpm: Number.isFinite(v) && v >= 20 ? v : undefined, numerator: mt.numerator, denominator: mt.denominator }) });
                onTempoLane(true);
              }}
              title="Pose le changement au début de la mesure (Pro Tools : Tempo / Meter Change)"
              className="w-full min-h-11 rounded-xl bg-cyan-500 text-black text-[13px] font-black">
              Poser le changement à la mesure {newBar}
            </button>
            <label className="flex items-center gap-2 text-[12px] font-bold">
              <input type="checkbox" checked={tempoLaneOn} onChange={e => onTempoLane(e.target.checked)} className="w-5 h-5" data-testid="tempo-lane-toggle" />
              Afficher la piste tempo sous la règle
            </label>
          </section>
        </div>
      </div>
    </div>
  );
};

export default TempoDialog;
