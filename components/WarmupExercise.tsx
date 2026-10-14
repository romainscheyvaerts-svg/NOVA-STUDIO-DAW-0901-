/**
 * Un exercice de l'échauffement « Voix et flow » (lot 11a) : consignes,
 * passage guidé (sons et lumière), note et conseil.
 *
 * Le micro est demandé au départ de l'exercice et rendu à la fin (la fenêtre
 * parente `VocalWarmup` le ferme dès qu'aucun exercice ne tourne).
 * Exercices de hauteur : « écoute, puis à toi » (le guide ne joue jamais
 * pendant que tu chantes : même sur haut-parleurs, le micro n'entend que toi).
 * Flow et diction : le clic joue pendant la prise ; s'il revient dans le micro
 * (haut-parleurs), le résultat le dit et n'entre pas dans l'historique.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MicSession } from '../utils/micSession';
import { analyzeFlowTake, analyzeHiss, clickLeak, DICTION_TEMPOS, flowAdvice, planDiction, planFlow, SUBDIV_LABEL, SUBDIV_PER_BEAT, SUBDIV_SYLLABLES, VIRELANGUES, type FlowPlan, type FlowScore, type Subdivision } from '../utils/flowDrill';
import { holdStats, nameFr } from '../utils/tuner';
import {
  comfortableRoot, DEFAULT_TESSITURE, fiveNotePattern, foldCents, holdTarget, scoreGuided, scoreSiren, SOURCES, tessitureOf, trillPattern, zoneLabel,
  type Exercise, type PitchPoint, type TargetNote, type Tessiture, type WarmupResult,
} from '../utils/vocalWarmup';

type Phase = 'pret' | 'en-cours' | 'analyse' | 'resultat' | 'erreur';

export interface ExerciseOutcome {
  score: number;
  /** Mesure principale (unité de l'exercice). */
  value: number;
  headline: string;
  details: string[];
  advice: string;
  /** Résultat non enregistré (clic entendu dans le micro, rien capté…). */
  warning?: string;
  flow?: FlowScore;
  perNote?: (number | null)[];
  tessiture?: Tessiture;
}

interface Props {
  exercise: Exercise;
  openMic: () => Promise<MicSession | null>;
  releaseMic: () => void;
  micError: string | null;
  tessiture: Tessiture | null;
  onTessiture: (t: Tessiture) => void;
  onResult: (r: WarmupResult) => void;
  /** Démarre tout de suite (programme complet, bouton ▶ d'une carte). */
  autoStart?: boolean;
  next?: { title: string; go: () => void } | null;
  onBack: () => void;
  /** Position dans le programme (« 3 / 9 »). */
  step?: string;
}

const fmt = (x: number, d = 0) => x.toFixed(d).replace('.', ',');
const FLOW_GOAL: Record<Subdivision, string> = {
  croches: '2 syllabes par temps, pile sur la grille (« ta-ka »).',
  triolets: '3 syllabes par temps, égales (« ta-ki-ta »).',
  doubles: '4 syllabes par temps : le débit rapide (« ta-ka-ti-ki »).',
};
const CLICK_PREF = 'nova_echauffement_clic';

/** Évènement pour les tests de bout en bout (micro simulé qui suit le plan) ; sans effet sinon. */
const emit = (detail: Record<string, unknown>) => { try { window.dispatchEvent(new CustomEvent('nova:echauffement', { detail })); } catch { /* */ } };

const WarmupExercise: React.FC<Props> = ({ exercise, openMic, releaseMic, micError, tessiture, onTessiture, onResult, autoStart, next, onBack, step }) => {
  const [phase, setPhase] = useState<Phase>('pret');
  const [outcome, setOutcome] = useState<ExerciseOutcome | null>(null);
  const [, setFrame] = useState(0);
  const [bpm, setBpm] = useState(exercise.bpm || 80);
  const [sub, setSub] = useState<Subdivision>(exercise.subdivision || 'croches');
  const [vire, setVire] = useState(VIRELANGUES[0].id);
  const [dictionBpm, setDictionBpm] = useState(DICTION_TEMPOS[0]);
  const [clickMode, setClickMode] = useState<'son' | 'lumiere'>(() => { try { return localStorage.getItem(CLICK_PREF) === 'lumiere' ? 'lumiere' : 'son'; } catch { return 'son'; } });
  const live = useRef<{ mic: MicSession | null; label: string; sub?: string; track: PitchPoint[]; targets: TargetNote[]; plan: (FlowPlan & { syllableAt?: (string | null)[] }) | null; level: number; t0: number; t1: number; finish?: () => void }>({ mic: null, label: '', track: [], targets: [], plan: null, level: -120, t0: 0, t1: 0 });
  const abort = useRef(false);
  const started = useRef(false);
  const tess = tessiture || DEFAULT_TESSITURE;

  useEffect(() => { try { localStorage.setItem(CLICK_PREF, clickMode); } catch { /* */ } }, [clickMode]);

  // Redessin pendant l'exercice.
  useEffect(() => {
    if (phase !== 'en-cours') return;
    let raf = 0;
    const loop = () => { setFrame(f => (f + 1) % 1e6); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  // Sortie de l'écran : tout s'arrête, micro rendu.
  useEffect(() => () => { abort.current = true; releaseMic(); }, [releaseMic]);

  const wait = (m: MicSession, t: number) => new Promise<void>(res => {
    const chk = () => { if (abort.current || m.isClosed || m.now >= t) res(); else setTimeout(chk, 15); };
    chk();
  });

  /** Hauteur en direct (toutes les 25 ms), datée sur l'horloge des sons joués. */
  const trackPitch = (m: MicSession, fmin = 60, fmax = 1100) => {
    const lag = 2048 / m.sampleRate + m.latency();
    const id = window.setInterval(() => {
      if (m.isClosed) return;
      const p = m.pitch(fmin, fmax);
      live.current.level = m.level();
      live.current.track.push({ t: m.now - lag, midi: p && p.clarity >= 0.5 ? 69 + 12 * Math.log2(p.hz / 440) : NaN });
    }, 25);
    return () => window.clearInterval(id);
  };

  const finishEarly = () => live.current.finish?.();

  const runPitchSing = async (m: MicSession, maxSec: number, label: string) => {
    const L = live.current;
    L.label = label;
    const t0 = m.now + 0.1;
    L.t0 = t0; L.t1 = t0 + maxSec;
    emit({ type: 'plan', kind: exercise.kind, start: t0, end: t0 + maxSec, latency: m.latency(), tessiture: tess });
    const stop = trackPitch(m);
    let done = false;
    L.finish = () => { done = true; };
    let lastVoiced = -1;
    while (!abort.current && !done && m.now < t0 + maxSec) {
      await new Promise(r => setTimeout(r, 50));
      const last = L.track[L.track.length - 1];
      if (last && Number.isFinite(last.midi)) lastVoiced = m.now;
      // Plus rien depuis 2,5 s après avoir chanté : terminé.
      if (lastVoiced > 0 && m.now - lastVoiced > 2.5 && m.now - t0 > 4) break;
    }
    stop();
    L.finish = undefined;
    return L.track.filter(p => p.t >= t0);
  };

  const runGuided = async (m: MicSession, kind: 'trilles' | 'gamme5' | 'tenue') => {
    const L = live.current;
    const reps = kind === 'tenue' ? 1 : 3;
    const root = comfortableRoot(tess, reps);
    const all: TargetNote[] = [];
    const stop = trackPitch(m);
    let t = m.now + 0.4;
    for (let r = 0; r < reps && !abort.current; r++) {
      const pat = kind === 'trilles' ? trillPattern(root + r, t) : kind === 'gamme5' ? fiveNotePattern(root + r, t) : [{ t0: t, t1: t + 1.5, midi: holdTarget(tess) }];
      const len = pat[pat.length - 1].t1 - pat[0].t0;
      pat.forEach(n => m.tone(n.midi, n.t0, n.t1 - n.t0 - 0.03));
      const singStart = t + len + 0.35;
      const sing = kind === 'tenue' ? [{ t0: singStart, t1: singStart + 6, midi: pat[0].midi }] : pat.map(n => ({ t0: n.t0 - t + singStart, t1: n.t1 - t + singStart, midi: n.midi }));
      all.push(...sing);
      L.targets = [...pat.map(n => ({ ...n })), ...sing];
      L.t0 = t; L.t1 = sing[sing.length - 1].t1;
      emit({ type: 'plan', kind, listen: pat, sing, latency: m.latency() });
      L.label = 'Écoute…';
      L.sub = kind === 'trilles' ? 'Puis refais-le en « brrr »' : kind === 'gamme5' ? 'Puis chante : ma-mé-mi-mo-mou' : 'Puis tiens cette note sur « a »';
      await wait(m, singStart - 0.05);
      L.label = 'À toi !';
      L.sub = kind === 'tenue' ? 'Tiens la note 6 secondes, sans vibrato' : `Tour ${r + 1} sur ${reps}`;
      await wait(m, sing[sing.length - 1].t1 + 0.2);
      t = m.now + 0.3;
    }
    stop();
    return { track: L.track, targets: all };
  };

  const runRhythm = async (m: MicSession, plan: FlowPlan & { syllableAt?: (string | null)[] }) => {
    const L = live.current;
    L.plan = plan;
    const lat = m.latency();
    if (clickMode === 'son') plan.clicks.forEach(c => m.click(c.t, c.accent));
    emit({ type: 'plan', kind: exercise.kind, clicks: plan.clicks.map(c => c.t), grid: plan.grid, rapStart: plan.rapStart, end: plan.end, latency: lat, bpm: plan.bpm, sr: m.sampleRate });
    await m.startCapture();
    await wait(m, plan.end + 0.25);
    const cap = await m.stopCapture();
    if (cap) emit({ type: 'capture', kind: exercise.kind, firstTime: cap.firstTime, samples: cap.samples.length, sr: m.sampleRate, stoppedAt: m.now });
    return { cap, lat };
  };

  const start = useCallback(async () => {
    abort.current = false;
    setOutcome(null);
    live.current = { mic: null, label: 'Prépare-toi…', track: [], targets: [], plan: null, level: -120, t0: 0, t1: 0 };
    const m = await openMic();
    if (!m || abort.current) { if (!m) setPhase('erreur'); return; }
    live.current.mic = m;
    setPhase('en-cours');
    try {
      let out: ExerciseOutcome | null = null;
      const k = exercise.kind;
      if (k === 'souffle') out = await doSouffle(m);
      else if (k === 'tessiture' || k === 'sirene') {
        const track = await runPitchSing(m, k === 'tessiture' ? 20 : 15, k === 'tessiture' ? 'Du grave à l’aigu, sur « ou »' : 'Sirènes sur « ng » ou « ou »');
        if (abort.current) return;
        setPhase('analyse');
        const sir = scoreSiren(track, k === 'tessiture' ? 15 : 12);
        if (k === 'tessiture') {
          const t = tessitureOf(track);
          if (!t) out = { score: 0, value: 0, headline: 'Pas assez de notes entendues', details: [], advice: 'Glisse plus lentement, sur « ou », un peu plus fort.', warning: 'Rien d’enregistré.' };
          else {
            onTessiture(t);
            out = { score: sir.score, value: t.high - t.low, tessiture: t, headline: `Ta zone : ${nameFr(t.low)} → ${nameFr(t.high)}`, details: [`${t.high - t.low} demi-tons`, `voix ${zoneLabel(t)}`], advice: 'Les gammes et la tenue de note se placent maintenant dans cette zone.' };
          }
        } else {
          out = { score: sir.score, value: sir.rangeSemis, headline: `${fmt(sir.rangeSemis)} demi-tons parcourus`, details: [`continuité ${Math.round(sir.continuity * 100)} %`, sir.breaks ? `${sir.breaks} cassure${sir.breaks > 1 ? 's' : ''}` : 'aucune cassure'],
            advice: sir.breaks ? 'La voix casse au passage : ralentis à cet endroit, plus doucement, sur « ng ».' : sir.rangeSemis < 10 ? 'Va un peu plus haut et plus bas, sans forcer.' : 'Belle sirène, continue et sans cassure.' };
        }
      } else if (k === 'trilles' || k === 'gamme5' || k === 'tenue') {
        const { track, targets } = await runGuided(m, k);
        if (abort.current) return;
        setPhase('analyse');
        if (k === 'tenue') {
          const tg = targets[0];
          const mids = track.filter(p => p.t >= tg.t0 + 0.3 && p.t < tg.t1 && Number.isFinite(p.midi)).map(p => tg.midi + foldCents(p.midi, tg.midi) / 100);
          const h = holdStats(mids, tg.midi);
          const dir = h.meanCents > 5 ? 'un peu haut' : h.meanCents < -5 ? 'un peu bas' : 'centré';
          out = h.frames < 10 ? { score: 0, value: 0, headline: 'Note pas entendue', details: [], advice: 'Chante plus fort, sur « a », juste après la note guide.', warning: 'Rien d’enregistré.' }
            : { score: h.score, value: h.medianAbsCents, headline: `${nameFr(tg.midi)} tenu : ${fmt(h.medianAbsCents)} cents d’écart`, details: [`${Math.round(h.inTune * 100)} % du temps à ±25 cents`, `stabilité ±${fmt(h.spreadCents)} cents`, dir],
              advice: h.spreadCents > 20 ? 'La note bouge : appuie-toi sur le souffle, pas sur la gorge.' : Math.abs(h.meanCents) > 15 ? `Tu chantes ${dir} : écoute bien la note guide avant d’attaquer.` : 'Note juste et stable.' };
        } else {
          const g = scoreGuided(track, targets);
          const dir = g.meanCents > 8 ? 'plutôt haut' : g.meanCents < -8 ? 'plutôt bas' : 'centré';
          out = !g.sung ? { score: 0, value: 0, headline: 'Rien entendu', details: [], advice: k === 'trilles' ? 'Fais vibrer les lèvres en voisant (« brrr » avec la voix, pas seulement l’air).' : 'Chante juste après l’écoute, un peu plus fort.', warning: 'Rien d’enregistré.' }
            : { score: g.score, value: g.medianAbsCents, perNote: g.perNote, headline: `${fmt(g.medianAbsCents)} cents d’écart médian`, details: [`${g.sung} notes sur ${g.total}`, dir],
              advice: g.medianAbsCents <= 15 ? 'Juste : passe à l’exercice suivant.' : `Tu chantes ${dir} : écoute le motif, attaque chaque note au centre.` };
        }
      } else if (k === 'flow' || k === 'diction') {
        const v = VIRELANGUES.find(x => x.id === vire) || VIRELANGUES[0];
        const plan = k === 'flow' ? planFlow(bpm, sub, m.now + 0.5) : planDiction(v, dictionBpm, m.now + 0.5);
        const { cap, lat } = await runRhythm(m, plan);
        if (abort.current || !cap) return;
        setPhase('analyse');
        const s = analyzeFlowTake(cap.samples, m.sampleRate, cap.firstTime, lat, plan);
        const leak = clickMode === 'son' && clickLeak(cap.samples, m.sampleRate, cap.firstTime, lat, plan);
        const sign = s.meanOffsetMs > 3 ? 'en retard' : s.meanOffsetMs < -3 ? 'en avance' : 'pile';
        out = {
          score: s.score, value: s.meanAbsMs, flow: s,
          headline: !s.hits ? 'Aucune syllabe entendue' : sign === 'pile' ? `Pile sur le temps (${fmt(s.meanAbsMs)} ms d’écart)` : `${fmt(Math.abs(s.meanOffsetMs))} ms ${sign} en moyenne`,
          details: [`${s.hits} syllabes sur ${s.expected}`, `écart moyen ${fmt(s.meanAbsMs)} ms`, `régularité ±${fmt(s.spreadMs)} ms`, `${Math.round(s.tight * 100)} % à ±30 ms`],
          advice: flowAdvice(s),
          warning: leak ? 'Le clic s’entend dans le micro (haut-parleurs) : mets un casque, ou passe le clic en « lumière seulement ». Ce passage n’est pas enregistré.' : (!s.hits ? 'Rien d’enregistré.' : undefined),
        };
      }
      if (abort.current || !out) return;
      if (!out.warning) {
        const id = exercise.kind === 'flow' ? `flow-${bpm}-${sub}` : exercise.id;
        const note = exercise.kind === 'flow' || exercise.kind === 'diction' ? `${out.headline}${exercise.kind === 'diction' ? ` · ${dictionBpm} BPM` : ''}` : out.headline;
        onResult({ id, at: Date.now(), score: out.score, value: out.value, note });
      }
      setOutcome(out);
      setPhase('resultat');
    } catch (e: any) {
      setOutcome({ score: 0, value: 0, headline: 'L’exercice s’est interrompu', details: [], advice: String(e?.message || e), warning: 'Rien d’enregistré.' });
      setPhase('resultat');
    } finally {
      releaseMic();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exercise, openMic, releaseMic, bpm, sub, vire, dictionBpm, clickMode, tess, onResult, onTessiture]);

  const doSouffle = async (m: MicSession): Promise<ExerciseOutcome | null> => {
    const L = live.current;
    const t0 = m.now + 0.2;
    L.t0 = t0;
    emit({ type: 'plan', kind: 'souffle', inspire: t0, souffle: t0 + 6, latency: m.latency() });
    L.label = 'Inspire par le nez'; L.sub = '4 temps, le ventre gonfle';
    const levels: number[] = [];
    while (!abort.current && m.now < t0 + 4) { levels.push(m.level()); live.current.level = levels[levels.length - 1]; await new Promise(r => setTimeout(r, 50)); }
    L.label = 'Bloque'; L.sub = '2 temps, gorge détendue';
    while (!abort.current && m.now < t0 + 6) { live.current.level = m.level(); await new Promise(r => setTimeout(r, 50)); }
    if (abort.current) return null;
    const floor = [...levels].sort((a, b) => a - b)[Math.floor(levels.length / 2)] ?? -70;
    L.label = 'Souffle « sssss »'; L.sub = 'Le plus longtemps possible, volume constant';
    L.t1 = m.now;
    await m.startCapture();
    let done = false, seen = -1, quietSince = -1;
    L.finish = () => { done = true; };
    while (!abort.current && !done && m.now < L.t1 + 45) {
      await new Promise(r => setTimeout(r, 50));
      const lv = m.level();
      live.current.level = lv;
      if (lv > floor + 10 && lv > -62) { if (seen < 0) seen = m.now; quietSince = -1; }
      else if (seen > 0) { if (quietSince < 0) quietSince = m.now; if (m.now - quietSince > 1.2) break; }
      if (seen < 0 && m.now - L.t1 > 8) break;
    }
    L.finish = undefined;
    const cap = await m.stopCapture();
    if (abort.current || !cap) return null;
    setPhase('analyse');
    const h = analyzeHiss(cap.samples, m.sampleRate);
    if (!h.seconds) return { score: 0, value: 0, headline: 'Souffle pas entendu', details: [], advice: 'Rapproche-toi du micro (20 cm) et fais un « sss » bien audible.', warning: 'Rien d’enregistré.' };
    return { score: h.score, value: h.seconds, headline: `${fmt(h.seconds, 1)} s de souffle tenu`, details: [`régularité ${h.steadiness} %`],
      advice: h.seconds < 12 ? 'Inspire plus bas (le ventre, pas les épaules) et souffle moins fort.' : h.steadiness < 60 ? 'Le volume varie : garde le même « sss » du début à la fin.' : h.seconds < 25 ? 'Bon souffle : vise 25 secondes.' : 'Excellent souffle : de quoi finir tes phrases de 4 mesures.' };
  };

  const stopNow = () => { abort.current = true; live.current.finish?.(); releaseMic(); setPhase('pret'); };

  // Départ différé d'un tour : un montage annulé aussitôt (mode strict de React) ne lance rien.
  useEffect(() => {
    if (!autoStart || started.current) return;
    const id = window.setTimeout(() => { started.current = true; void start(); }, 0);
    return () => window.clearTimeout(id);
  }, [autoStart, start]);

  // Échap : arrête l'exercice en cours (le parent ferme la fenêtre sinon).
  useEffect(() => {
    if (phase !== 'en-cours') return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); stopNow(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const isRhythm = exercise.kind === 'flow' || exercise.kind === 'diction';
  const L = live.current;
  const m = L.mic;

  return (
    <div className="space-y-4" data-testid="warmup-exercise" data-exercise={exercise.id} data-phase={phase}
      data-score={outcome ? outcome.score : ''} data-offset-ms={outcome?.flow ? outcome.flow.meanOffsetMs : ''} data-value={outcome ? outcome.value : ''} data-warning={outcome?.warning ? '1' : ''}>
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => { stopNow(); onBack(); }} aria-label="Retour aux exercices" className="w-11 h-11 shrink-0 rounded-xl bg-white/[0.06] hover:bg-white/10 flex items-center justify-center"><i className="fas fa-arrow-left" aria-hidden="true"></i></button>
        <div className="min-w-0">
          <h3 className="text-lg font-black leading-tight">{exercise.kind === 'flow' ? `Flow ${bpm} BPM · ${SUBDIV_LABEL[sub].split(' (')[0].toLowerCase()}` : exercise.title}{step ? <span className="ml-2 text-[12px] font-bold text-slate-400">{step}</span> : null}</h3>
          <p className="text-[13px] text-slate-400">{exercise.kind === 'flow' ? FLOW_GOAL[sub] : exercise.goal}</p>
        </div>
      </div>

      {/* Réglages des exercices de rythme */}
      {isRhythm && phase !== 'en-cours' && phase !== 'analyse' && (
        <div className="space-y-2">
          {exercise.kind === 'flow' ? (<>
            <Chips<number> label="Tempo" value={bpm} options={[80, 90, 140].map(b => ({ v: b, t: `${b} BPM` }))} onChange={setBpm} />
            <Chips<Subdivision> label="Découpage" value={sub} options={(Object.keys(SUBDIV_PER_BEAT) as Subdivision[]).map(s => ({ v: s, t: SUBDIV_LABEL[s].split(' (')[0] }))} onChange={setSub} />
          </>) : (<>
            <Chips<string> label="Virelangue" value={vire} options={VIRELANGUES.map(v => ({ v: v.id, t: v.text.split(' ').slice(0, 3).join(' ') + '…' }))} onChange={setVire} />
            <Chips<number> label="Vitesse" value={dictionBpm} options={DICTION_TEMPOS.map(b => ({ v: b, t: `${b} BPM` }))} onChange={setDictionBpm} />
          </>)}
          <Chips<'son' | 'lumiere'> label="Clic" value={clickMode} options={[{ v: 'son', t: '🔊 Son + lumière' }, { v: 'lumiere', t: '💡 Lumière seulement' }]} onChange={setClickMode} />
        </div>
      )}

      {phase === 'pret' && (
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          {exercise.kind === 'diction' && <p className="mb-3 text-[15px] font-bold">« {(VIRELANGUES.find(v => v.id === vire) || VIRELANGUES[0]).text} »</p>}
          <ol className="space-y-1.5 text-[14px] text-slate-200 list-decimal pl-5">{exercise.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          {(exercise.kind === 'gamme5' || exercise.kind === 'trilles' || exercise.kind === 'tenue') && (
            <p className="mt-2 text-[12px] text-slate-400">Calé sur {tessiture ? 'ta tessiture' : 'une voix moyenne (fais le test de tessiture pour l’adapter)'} : {nameFr(tess.low)} → {nameFr(tess.high)}.</p>
          )}
          {micError && <p className="mt-3 rounded-xl border border-rose-400/40 bg-rose-400/10 p-3 text-[13px] text-rose-200" role="alert">{micError}</p>}
          <button type="button" onClick={() => { void start(); }} data-testid="warmup-go"
            className="mt-4 w-full min-h-14 rounded-2xl bg-cyan-400 text-black text-[16px] font-black hover:bg-cyan-300 flex items-center justify-center gap-2">
            <i className="fas fa-play" aria-hidden="true"></i>Commencer
          </button>
        </section>
      )}

      {phase === 'erreur' && (
        <section className="rounded-2xl border border-rose-400/40 bg-rose-400/10 p-4" role="alert">
          <p className="text-[14px] font-bold text-rose-200">{micError || 'Le micro n’a pas pu s’ouvrir.'}</p>
          <button type="button" onClick={() => { void start(); }} className="mt-3 min-h-12 px-5 rounded-xl bg-white/10 hover:bg-white/20 font-bold">Réessayer</button>
        </section>
      )}

      {phase === 'en-cours' && m && (
        <section className="rounded-2xl border border-cyan-400/30 bg-white/[0.03] p-4 space-y-3" data-testid="warmup-live">
          {exercise.kind === 'diction' && <p className="text-center text-[15px] font-bold text-slate-200">« {(VIRELANGUES.find(v => v.id === vire) || VIRELANGUES[0]).text} »</p>}
          {isRhythm && L.plan ? <RhythmGuide plan={L.plan} now={m.now} lightOnly={clickMode === 'lumiere'} /> : (
            <div className="text-center">
              <p className="text-2xl font-black" data-testid="warmup-label">{L.label}</p>
              {L.sub && <p className="text-[13px] text-slate-400">{L.sub}</p>}
            </div>
          )}
          {exercise.kind === 'souffle' ? <BreathGuide now={m.now} t0={L.t0} t1={L.t1} level={L.level} /> : !isRhythm ? <PitchGraph track={L.track} targets={L.targets} now={m.now} tess={tess} /> : null}
          <div className="flex gap-2">
            {(exercise.kind === 'souffle' || exercise.kind === 'sirene' || exercise.kind === 'tessiture') && (
              <button type="button" onClick={finishEarly} className="flex-1 min-h-12 rounded-xl bg-cyan-400/15 border border-cyan-400/40 text-cyan-100 font-black">J’ai fini</button>
            )}
            <button type="button" onClick={stopNow} className="flex-1 min-h-12 rounded-xl bg-white/[0.06] hover:bg-white/10 font-bold">Arrêter</button>
          </div>
        </section>
      )}

      {phase === 'analyse' && <p className="text-center text-[14px] text-slate-300 py-6"><i className="fas fa-circle-notch fa-spin mr-2" aria-hidden="true"></i>Calcul de la note…</p>}

      {phase === 'resultat' && outcome && (
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-3" data-testid="warmup-result">
          <div className="flex items-center gap-4">
            <ScoreRing score={outcome.score} muted={!!outcome.warning} />
            <div className="min-w-0">
              <p className="text-[17px] font-black leading-snug" data-testid="warmup-headline">{outcome.headline}</p>
              <p className="text-[12px] text-slate-400">{outcome.details.join(' · ')}</p>
            </div>
          </div>
          {outcome.flow && outcome.flow.hits > 0 && <FlowStrip score={outcome.flow} />}
          {outcome.perNote && <NoteBars perNote={outcome.perNote} />}
          <p className="text-[14px] text-slate-100">{outcome.advice}</p>
          {outcome.warning && <p className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-[13px] text-amber-100" role="status" data-testid="warmup-warning">{outcome.warning}</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => { void start(); }} className="min-h-12 rounded-xl bg-white/[0.06] hover:bg-white/10 font-bold"><i className="fas fa-redo mr-2" aria-hidden="true"></i>Recommencer</button>
            {next ? (
              <button type="button" onClick={next.go} data-testid="warmup-next" className="min-h-12 rounded-xl bg-cyan-400 text-black font-black hover:bg-cyan-300">Suivant : {next.title} ▶</button>
            ) : (
              <button type="button" onClick={onBack} className="min-h-12 rounded-xl bg-cyan-400 text-black font-black hover:bg-cyan-300">Retour aux exercices</button>
            )}
          </div>
        </section>
      )}

      <details className="text-[12px] text-slate-400">
        <summary className="cursor-pointer min-h-11 flex items-center">Pourquoi cet exercice ? (sources)</summary>
        <ul className="mt-1 space-y-1 list-disc pl-5">{exercise.sources.map(s => SOURCES[s]).filter(Boolean).map(s => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center min-h-11 py-1 underline hover:text-white">{s.label}</a></li>)}</ul>
      </details>
    </div>
  );
};

function Chips<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { v: T; t: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={label}>
      <span className="text-[12px] font-bold text-slate-400 w-full sm:w-auto sm:min-w-[78px]">{label}</span>
      {options.map(o => (
        <button key={String(o.v)} type="button" role="radio" aria-checked={value === o.v} onClick={() => onChange(o.v)} data-chip={String(o.v)}
          className={`min-h-11 px-3 rounded-xl text-[13px] font-bold border ${value === o.v ? 'bg-cyan-400 text-black border-cyan-400' : 'bg-white/[0.04] border-white/10 text-slate-200 hover:bg-white/10'}`}>{o.t}</button>
      ))}
    </div>
  );
}

/** Points lumineux : un par syllabe attendue ; décompte en gros chiffres. */
const RhythmGuide: React.FC<{ plan: FlowPlan & { syllableAt?: (string | null)[] }; now: number; lightOnly: boolean }> = ({ plan, now, lightOnly }) => {
  const beat = 60 / plan.bpm;
  const per = SUBDIV_PER_BEAT[plan.subdivision];
  const counting = now < plan.rapStart;
  const ciBeat = Math.floor((now - plan.start) / beat);
  const beatsPerBar = plan.beatsPerBar;
  const nBars = Math.round((plan.end - plan.rapStart) / beat / beatsPerBar);
  const cur = Math.floor((now - plan.rapStart) / (beat / per) + 0.0001);
  const syl = SUBDIV_SYLLABLES[plan.subdivision];
  const flash = lightOnly && plan.clicks.some(c => now >= c.t && now < c.t + 0.09);
  const pos = Math.max(0, Math.min(nBars * beatsPerBar * per, cur));
  const visibleBar = Math.min(nBars - 1, Math.floor(pos / (beatsPerBar * per)));
  // Diction : affiche la ligne de la mesure en cours (deux mesures à la fois au téléphone).
  return (
    <div className={`rounded-xl p-3 transition-colors ${flash ? 'bg-cyan-400/25' : ''}`} data-testid="rhythm-guide">
      <p className="text-center text-[13px] font-bold text-slate-300 min-h-[20px]">{counting ? 'Décompte : écoute le clic' : now > plan.end ? 'Terminé' : 'À toi !'}</p>
      {counting ? (
        <p className="text-center text-6xl font-black text-cyan-300 py-4" data-testid="countin">{Math.max(1, Math.min(beatsPerBar, ciBeat + 1))}</p>
      ) : (
        <div className="space-y-2 py-2">
          {Array.from({ length: nBars }, (_, b) => b).filter(b => b === visibleBar || b === visibleBar + 1 || nBars <= 2).map(b => (
            <div key={b} className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${beatsPerBar}, minmax(0, 1fr))` }}>
              {Array.from({ length: beatsPerBar }, (_, q) => (
                <div key={q} className="flex justify-around items-start rounded-lg bg-white/[0.03] py-1.5">
                  {Array.from({ length: per }, (_, k) => {
                    const idx = (b * beatsPerBar + q) * per + k;
                    const label = plan.syllableAt ? plan.syllableAt[idx] : syl[k % syl.length];
                    const on = idx === cur;
                    const past = idx < cur;
                    const rest = plan.syllableAt && !label;
                    return (
                      <div key={k} className="flex flex-col items-center gap-0.5 min-w-0">
                        <span className={`block rounded-full transition-transform ${k === 0 ? 'w-5 h-5' : 'w-4 h-4'} ${rest ? 'bg-white/5' : on ? 'bg-cyan-300 scale-150' : past ? 'bg-cyan-400/40' : 'bg-white/20'}`} />
                        <span className={`text-[11px] sm:text-[12px] font-bold truncate max-w-full ${on ? 'text-cyan-200' : 'text-slate-500'}`}>{rest ? '' : label}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** Courbe de hauteur chantée et notes visées (fenêtre glissante de 6 s). */
const PitchGraph: React.FC<{ track: PitchPoint[]; targets: TargetNote[]; now: number; tess: Tessiture }> = ({ track, targets, now, tess }) => {
  const W = 600, H = 200, span = 6;
  const t0 = now - span * 0.75;
  const tg = targets.filter(t => t.t1 > t0 && t.t0 < t0 + span);
  const recent = track.filter(p => p.t >= t0 && Number.isFinite(p.midi));
  const lo = Math.min(tess.low - 2, ...tg.map(t => t.midi - 2), ...recent.map(p => p.midi - 1));
  const hi = Math.max(tess.high + 2, ...tg.map(t => t.midi + 2), ...recent.map(p => p.midi + 1));
  const x = (t: number) => ((t - t0) / span) * W;
  const y = (m: number) => H - ((m - lo) / Math.max(1, hi - lo)) * H;
  const pts = recent.map(p => `${x(p.t).toFixed(1)},${y(p.midi).toFixed(1)}`);
  const last = recent[recent.length - 1];
  const lines: number[] = [];
  for (let m = Math.ceil(lo); m <= hi; m++) if (m % 12 === 0 || m % 12 === 7) lines.push(m);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-44 sm:h-52 rounded-xl bg-white/[0.03]" role="img" aria-label="Ta voix (ligne) et les notes à chanter (bandes)">
      {lines.map(m => <g key={m}><line x1="0" x2={W} y1={y(m)} y2={y(m)} className="stroke-white/10" strokeWidth="1" /><text x="4" y={y(m) - 3} fontSize="11" className="fill-slate-500">{nameFr(m)}</text></g>)}
      {tg.map((t, i) => (
        <g key={i}>
          {/* ±25 cents = la bande verte */}
          <rect x={x(t.t0)} y={y(t.midi + 0.25)} width={Math.max(2, x(t.t1) - x(t.t0) - 2)} height={Math.max(3, y(t.midi - 0.25) - y(t.midi + 0.25))} rx="3" className="fill-emerald-400/30" />
          <text x={x(t.t0) + 3} y={y(t.midi + 0.25) - 3} fontSize="10" className="fill-slate-400">{nameFr(t.midi)}</text>
        </g>
      ))}
      <line x1={x(now)} x2={x(now)} y1="0" y2={H} className="stroke-white/30" strokeWidth="1" />
      {pts.length > 1 && <polyline points={pts.join(' ')} fill="none" className="stroke-cyan-300" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />}
      {last && now - last.t < 0.3 && <circle cx={x(last.t)} cy={y(last.midi)} r="6" className="fill-cyan-300" />}
    </svg>
  );
};

/** Respiration : cercle qui gonfle (inspire), tient (bloque), puis chrono du souffle. */
const BreathGuide: React.FC<{ now: number; t0: number; t1: number; level: number }> = ({ now, t0, t1, level }) => {
  const e = now - t0;
  const scale = e < 4 ? 0.45 + 0.55 * (e / 4) : e < 6 ? 1 : 1;
  const count = e < 4 ? Math.ceil(4 - e) : e < 6 ? Math.ceil(6 - e) : null;
  const blowing = t1 > 0 && now >= t1;
  return (
    <div className="flex flex-col items-center gap-3 py-2">
      <div className="relative w-40 h-40 flex items-center justify-center">
        <div className={`absolute inset-0 rounded-full ${blowing ? 'bg-cyan-400/20' : 'bg-emerald-400/20'} transition-transform duration-100`} style={{ transform: `scale(${blowing ? 0.5 + 0.5 * Math.max(0, Math.min(1, (level + 70) / 45)) : scale})` }} />
        <span className="relative text-5xl font-black" data-testid="breath-count">{blowing ? `${fmt(now - t1, 1)} s` : count}</span>
      </div>
    </div>
  );
};

/** Placement de chaque syllabe : barre vers le haut = en retard, vers le bas = en avance. */
const FlowStrip: React.FC<{ score: FlowScore }> = ({ score }) => {
  const W = 600, H = 90, mid = H / 2, n = score.detail.length;
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-20 rounded-xl bg-white/[0.03]" role="img" aria-label="Placement de chaque syllabe par rapport au temps">
        <line x1="0" x2={W} y1={mid} y2={mid} className="stroke-white/25" strokeWidth="1" />
        {[-30, 30].map(v => <line key={v} x1="0" x2={W} y1={mid - v * (mid - 6) / 75} y2={mid - v * (mid - 6) / 75} className="stroke-emerald-400/30" strokeDasharray="4 4" strokeWidth="1" />)}
        {score.detail.map((d, i) => {
          const cx = ((i + 0.5) / n) * W;
          if (d.offsetMs === null) return <circle key={i} cx={cx} cy={mid} r="3" className="fill-rose-400" />;
          const v = Math.max(-75, Math.min(75, d.offsetMs));
          const yv = mid - v * (mid - 6) / 75;
          const a = Math.abs(d.offsetMs);
          return <line key={i} x1={cx} x2={cx} y1={mid} y2={yv} strokeWidth={Math.max(2, Math.min(8, W / n * 0.5))} strokeLinecap="round" className={a <= 15 ? 'stroke-emerald-400' : a <= 30 ? 'stroke-amber-400' : 'stroke-rose-400'} />;
        })}
      </svg>
      <figcaption className="mt-1 flex justify-between text-[11px] text-slate-500"><span>▲ en retard · ▼ en avance</span><span>vert ≤ 15 ms · orange ≤ 30 ms · point rouge = syllabe manquée</span></figcaption>
    </figure>
  );
};

const NoteBars: React.FC<{ perNote: (number | null)[] }> = ({ perNote }) => (
  <div className="flex items-end gap-1 h-16" aria-label="Écart de chaque note (cents)">
    {perNote.map((c, i) => {
      const a = c === null ? null : Math.abs(c);
      return <div key={i} className={`flex-1 rounded-t ${a === null ? 'bg-white/10' : a <= 10 ? 'bg-emerald-400' : a <= 25 ? 'bg-amber-400' : 'bg-rose-400'}`} style={{ height: `${a === null ? 10 : Math.max(10, 100 - Math.min(90, a * 1.8))}%` }} title={c === null ? 'pas chantée' : `${c > 0 ? '+' : ''}${c} cents`} />;
    })}
  </div>
);

const ScoreRing: React.FC<{ score: number; muted?: boolean }> = ({ score, muted }) => {
  const r = 30, c = 2 * Math.PI * r;
  const cls = muted ? 'stroke-slate-500' : score >= 80 ? 'stroke-emerald-400' : score >= 55 ? 'stroke-amber-400' : 'stroke-rose-400';
  return (
    <svg viewBox="0 0 76 76" className="w-20 h-20 shrink-0" role="img" aria-label={`Score ${score} sur 100`}>
      <circle cx="38" cy="38" r={r} className="stroke-white/10" strokeWidth="7" fill="none" />
      <circle cx="38" cy="38" r={r} className={cls} strokeWidth="7" fill="none" strokeLinecap="round" strokeDasharray={`${(c * Math.max(0, Math.min(100, score))) / 100} ${c}`} transform="rotate(-90 38 38)" />
      <text x="38" y="44" textAnchor="middle" fontSize="20" fontWeight="900" className="fill-white" data-testid="warmup-score">{score}</text>
    </svg>
  );
};

export default WarmupExercise;
