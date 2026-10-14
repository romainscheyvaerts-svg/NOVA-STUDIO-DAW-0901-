/**
 * Accordeur NOVA (lot 11b) : note, octave, écart en cents, aiguille.
 * Modes chromatique, guitare, basse et tonalité du morceau ; vérifie aussi
 * la justesse d'une voix tenue (« Note tenue : … »).
 *
 * Le micro est ouvert par la fenêtre « Voix et flow » (components/VocalWarmup)
 * seulement pendant que l'accordeur est affiché.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { MicSession } from '../utils/micSession';
import { BASS_STRINGS, GUITAR_STRINGS, holdStats, MODE_RANGE, nameEn, nameFr, readNote, TunerSmoother, tuneState, type TunerMode, type TunerReading, type HoldStats } from '../utils/tuner';
import { keyLabelFr } from '../utils/scales';

interface Props {
  mic: MicSession | null;
  projectKey?: number;
  projectScale?: string;
}

const MODES: { id: TunerMode; label: string }[] = [
  { id: 'chromatique', label: 'Chromatique' },
  { id: 'guitare', label: 'Guitare' },
  { id: 'basse', label: 'Basse' },
  { id: 'tonalite', label: 'Tonalité du morceau' },
];

const readPref = <T,>(k: string, d: T, ok: (v: any) => boolean): T => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return ok(v) ? v : d; } catch { return d; } };
const writePref = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };
const fmt = (x: number, d = 1) => x.toFixed(d).replace('.', ',');
const signed = (c: number) => `${c > 0.5 ? '+' : c < -0.5 ? '−' : '±'}${Math.abs(Math.round(c))}`;

const STATE_CLS = { juste: 'text-emerald-400', presque: 'text-amber-400', faux: 'text-rose-400' } as const;

const TunerPanel: React.FC<Props> = ({ mic, projectKey, projectScale }) => {
  const hasKey = typeof projectKey === 'number' && Number.isFinite(projectKey);
  const [mode, setMode] = useState<TunerMode>(() => readPref('nova_tuner_mode', 'chromatique' as TunerMode, v => MODES.some(m => m.id === v)));
  const [a4, setA4] = useState<number>(() => readPref('nova_tuner_a4', 440, v => typeof v === 'number' && v >= 430 && v <= 450));
  const [reading, setReading] = useState<TunerReading | null>(null);
  const [level, setLevel] = useState(-120);
  const [hold, setHold] = useState<{ live: boolean; secs: number; stats: HoldStats; target: number } | null>(null);
  const effMode: TunerMode = mode === 'tonalite' && !hasKey ? 'chromatique' : mode;
  const smoother = useRef(new TunerSmoother());
  const holdBuf = useRef<{ target: number; midis: number[]; t0: number; lastVoiced: number } | null>(null);

  useEffect(() => { writePref('nova_tuner_mode', mode); }, [mode]);
  useEffect(() => { writePref('nova_tuner_a4', a4); }, [a4]);

  useEffect(() => {
    if (!mic) { setReading(null); return; }
    smoother.current.reset();
    holdBuf.current = null;
    const range = MODE_RANGE[effMode];
    let stop = false;
    const tick = () => {
      if (stop || mic.isClosed) return;
      const now = performance.now();
      const p = mic.pitch(range.fmin, range.fmax);
      const hz = smoother.current.push(p && p.clarity >= 0.55 ? p.hz : null, now);
      setLevel(mic.level());
      if (!hz) { setReading(null); }
      else {
        const r = readNote(hz, effMode, hasKey ? { root: projectKey as number, scale: projectScale } : null, a4);
        setReading(r);
        // Note tenue : même note visée, sans trou de plus de 400 ms.
        const m = 69 + 12 * Math.log2(hz / a4);
        const hb = holdBuf.current;
        if (p && hb && hb.target === r.target && now - hb.lastVoiced < 400) { hb.midis.push(m); hb.lastVoiced = now; }
        else if (p) holdBuf.current = { target: r.target, midis: [m], t0: now, lastVoiced: now };
      }
      const hb = holdBuf.current;
      if (hb) {
        const secs = (hb.lastVoiced - hb.t0) / 1000;
        const live = now - hb.lastVoiced < 400;
        if (secs >= 0.8 && hb.midis.length >= 10) setHold({ live, secs, stats: holdStats(hb.midis, hb.target), target: hb.target });
        if (!live) holdBuf.current = null;
      }
    };
    const id = window.setInterval(tick, 33);
    return () => { stop = true; window.clearInterval(id); };
  }, [mic, effMode, a4, projectKey, projectScale, hasKey]);

  const cents = reading ? Math.max(-50, Math.min(50, reading.cents)) : 0;
  const st = reading ? tuneState(reading.cents) : null;
  const angle = (cents / 50) * 60;
  const strings = effMode === 'guitare' ? GUITAR_STRINGS : effMode === 'basse' ? BASS_STRINGS : null;

  const playRef = (midi: number) => { if (mic) mic.tone(midi + 12 * Math.log2(a4 / 440), mic.now + 0.02, 1.5, 0.3); };

  return (
    <div className="space-y-4" data-testid="tuner-panel" data-tuner-note={reading ? nameFr(reading.target) : ''} data-tuner-en={reading ? reading.en : ''}
      data-tuner-cents={reading ? reading.cents.toFixed(1) : ''} data-tuner-string={reading?.string ?? ''}>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Mode de l’accordeur">
        {MODES.map(m => {
          const disabled = m.id === 'tonalite' && !hasKey;
          const on = mode === m.id;
          return (
            <button key={m.id} type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => setMode(m.id)} data-tuner-mode={m.id}
              title={disabled ? 'Le morceau n’a pas encore de tonalité (choisis-la dans la barre, ou importe un beat)' : undefined}
              className={`min-h-11 px-3.5 rounded-xl text-[13px] font-bold border transition-colors disabled:opacity-40 ${on ? 'bg-cyan-400 text-black border-cyan-400' : 'bg-white/[0.04] border-white/10 text-slate-200 hover:bg-white/10'}`}>
              {m.label}{m.id === 'tonalite' && hasKey ? <span className="ml-1 font-normal opacity-80">({keyLabelFr(projectKey, projectScale)})</span> : null}
            </button>
          );
        })}
      </div>

      {/* Cadran */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 pt-4 pb-3 text-center" aria-live="polite">
        <svg viewBox="-110 -100 220 112" className="w-full max-w-[420px] mx-auto block" aria-hidden="true">
          <path d="M -90 0 A 90 90 0 0 1 90 0" className="stroke-white/15" strokeWidth="10" fill="none" strokeLinecap="round" />
          {/* ±15 cents (presque) puis ±5 cents (juste) */}
          <path d={arc(-18, 18)} className="stroke-amber-400/40" strokeWidth="10" fill="none" />
          <path d={arc(-6, 6)} className="stroke-emerald-400" strokeWidth="10" fill="none" />
          {[-50, -25, 0, 25, 50].map(c => {
            const a = ((c / 50) * 60 - 90) * Math.PI / 180;
            return <line key={c} x1={78 * Math.cos(a)} y1={78 * Math.sin(a)} x2={70 * Math.cos(a)} y2={70 * Math.sin(a)} className="stroke-slate-500" strokeWidth={c === 0 ? 2.5 : 1.5} />;
          })}
          <text x="-30" y="-46" className="fill-slate-500" fontSize="9" textAnchor="middle">−25</text>
          <text x="30" y="-46" className="fill-slate-500" fontSize="9" textAnchor="middle">+25</text>
          <g style={{ transform: `rotate(${angle}deg)`, transition: 'transform 90ms linear' }} data-tuner-needle={angle.toFixed(1)}>
            <line x1="0" y1="4" x2="0" y2="-84" strokeWidth="3.5" strokeLinecap="round" className={reading ? (st === 'juste' ? 'stroke-emerald-400' : st === 'presque' ? 'stroke-amber-400' : 'stroke-rose-400') : 'stroke-slate-600'} />
          </g>
          <circle cx="0" cy="4" r="6" className="fill-slate-300" />
        </svg>
        <div className="-mt-1 flex items-end justify-center gap-1 min-h-[76px]">
          {reading ? (<>
            <span className={`text-6xl sm:text-7xl font-black leading-none ${st ? STATE_CLS[st] : ''}`} data-testid="tuner-note">{reading.note}</span>
            <span className="text-2xl font-black text-slate-300 mb-1" data-testid="tuner-octave">{reading.octave}</span>
          </>) : <span className="text-2xl font-bold text-slate-500 mb-4">{mic ? 'Joue ou chante une note…' : 'Micro coupé'}</span>}
        </div>
        <div className="mt-1 flex items-center justify-center gap-3 text-[13px]">
          {reading ? (<>
            <span className={`font-mono font-black text-lg ${st ? STATE_CLS[st] : ''}`} data-testid="tuner-cents">{signed(reading.cents)} cents</span>
            <span className="text-slate-400">{reading.en} · {fmt(reading.hz)} Hz</span>
            {reading.string ? <span className="text-slate-300 font-bold">corde {reading.string}</span> : null}
          </>) : <span className="text-slate-500">—</span>}
        </div>
        <p className="mt-1 text-[12px] font-bold min-h-[18px]">
          {reading && st === 'juste' && <span className="text-emerald-400">Juste</span>}
          {reading && st !== 'juste' && <span className={st ? STATE_CLS[st] : ''}>{reading.cents > 0 ? 'Trop haut : descends un peu' : 'Trop bas : monte un peu'}</span>}
        </p>
        {/* Niveau d'entrée */}
        <div className="mt-2 h-1.5 rounded bg-white/10 overflow-hidden max-w-[260px] mx-auto" aria-hidden="true">
          <div className={`h-full ${level > -6 ? 'bg-rose-400' : 'bg-cyan-400'}`} style={{ width: `${Math.max(0, Math.min(100, (level + 70) * (100 / 70)))}%` }} />
        </div>
      </section>

      {strings && (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${strings.length}, minmax(0, 1fr))` }} aria-label="Cordes (touche pour entendre la note)">
          {strings.map((s, i) => {
            const num = strings.length - i;
            const on = reading?.string === num;
            return (
              <button key={s} type="button" onClick={() => playRef(s)} data-tuner-corde={num} aria-label={`Corde ${num} : ${nameFr(s)} (${nameEn(s)}), écouter`}
                className={`min-h-12 rounded-xl border text-[13px] font-black leading-tight transition-colors ${on ? (st === 'juste' ? 'bg-emerald-400 text-black border-emerald-400' : 'bg-cyan-400/20 border-cyan-400 text-cyan-100') : 'bg-white/[0.04] border-white/10 text-slate-200 hover:bg-white/10'}`}>
                {nameFr(s)}<span className="block text-[10px] font-normal opacity-75">{nameEn(s)}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Voix tenue */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-4" data-testid="tuner-hold" data-hold-score={hold ? hold.stats.score : ''}>
        <h3 className="text-[13px] font-black">Justesse d’une note tenue</h3>
        {hold ? (
          <p className="mt-1 text-[13px] text-slate-200">
            <span className="font-black">{nameFr(hold.target)}</span> tenu {fmt(hold.secs)} s · écart moyen <span className="font-mono font-bold">{signed(hold.stats.meanCents)} cents</span> · stabilité ±{Math.round(hold.stats.spreadCents)} cents ·{' '}
            <span className={hold.stats.inTune >= 0.8 ? 'text-emerald-400 font-bold' : hold.stats.inTune >= 0.5 ? 'text-amber-400 font-bold' : 'text-rose-400 font-bold'}>{Math.round(hold.stats.inTune * 100)} % juste</span>
            {hold.live ? <span className="ml-1 text-slate-400">(en cours…)</span> : null}
          </p>
        ) : <p className="mt-1 text-[12px] text-slate-400">Chante une note sur « a » plus d’une seconde : NOVA dit si elle est juste et stable (±25 cents = juste pour l’oreille d’un auditeur).</p>}
      </section>

      <div className="flex flex-wrap items-center gap-3 text-[12px] text-slate-400">
        <label className="flex items-center gap-2">
          <span>La de référence</span>
          <button type="button" aria-label="La de référence −1 Hz" onClick={() => setA4(v => Math.max(430, v - 1))} className="w-11 h-11 rounded-xl bg-white/[0.06] text-slate-100 font-black">−</button>
          <span className="font-mono font-bold text-slate-100 w-14 text-center" data-testid="tuner-a4">{a4} Hz</span>
          <button type="button" aria-label="La de référence +1 Hz" onClick={() => setA4(v => Math.min(450, v + 1))} className="w-11 h-11 rounded-xl bg-white/[0.06] text-slate-100 font-black">+</button>
        </label>
        <span>Noms français (Do3 = do central) ; en gris, la notation anglaise (A4 = 440 Hz).</span>
      </div>
    </div>
  );
};

/** Arc du cadran entre deux écarts (cents). */
function arc(c0: number, c1: number) {
  const p = (c: number) => { const a = ((c / 50) * 60 - 90) * Math.PI / 180; return `${(90 * Math.cos(a)).toFixed(2)} ${(90 * Math.sin(a)).toFixed(2)}`; };
  return `M ${p(c0)} A 90 90 0 0 1 ${p(c1)}`;
}

export default TunerPanel;
