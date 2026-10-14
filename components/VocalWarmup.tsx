/**
 * « Voix et flow » (lot 11) : échauffement de la voix et du flow adapté au
 * rap, accordeur, progrès. L'équivalent du VoiceTrainer de BandLab, pensé
 * pour une cabine rap / R&B : souffle, sirènes, trilles, gammes dans ta
 * tessiture, tenue de note, virelangues et placement sur le clic à 80, 90
 * puis 140 BPM. Tout est calculé sur l'appareil (aucun serveur, aucune IA
 * payante) ; l'historique reste dans le navigateur.
 *
 * Micro : ouvert seulement pendant un exercice ou quand l'accordeur est à
 * l'écran ; rendu dès qu'on change d'onglet, qu'on ferme ou que l'appli passe
 * en arrière-plan (utils/micSession.ts).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TunerPanel from './TunerPanel';
import WarmupExercise from './WarmupExercise';
import { listInputs, MicSession } from '../utils/micSession';
import { detectHeadphones } from '../utils/headphoneDetect';
import { nameFr } from '../utils/tuner';
import {
  addResult, clearHistory, EXERCISES, exerciseById, loadHistory, loadTessiture, PROGRAM, progressOf, saveTessiture, streakDays,
  type Exercise, type ExerciseGroup, type Tessiture, type WarmupResult,
} from '../utils/vocalWarmup';

export type VocalTab = 'echauffement' | 'accordeur' | 'progres';

interface Props {
  initialTab?: VocalTab;
  onClose: () => void;
  projectKey?: number;
  projectScale?: string;
  /** Entrée de la piste armée (si c'est une entrée du navigateur). */
  preferredInputId?: string | null;
}

const GROUPS: { id: ExerciseGroup; title: string; icon: string }[] = [
  { id: 'souffle', title: 'Souffle', icon: '🌬️' },
  { id: 'voix', title: 'Voix', icon: '🎤' },
  { id: 'rap', title: 'Rap : diction et flow', icon: '🥁' },
];

const INPUT_PREF = 'nova_echauffement_entree';
const minutes = (ids: string[]) => Math.round(ids.reduce((s, id) => s + (exerciseById(id)?.seconds || 0) * 1.6, 0) / 60);

const VocalWarmup: React.FC<Props> = ({ initialTab = 'echauffement', onClose, projectKey, projectScale, preferredInputId }) => {
  const [tab, setTab] = useState<VocalTab>(initialTab);
  const [current, setCurrent] = useState<{ id: string; auto: boolean; prog: number | null } | null>(null);
  const [programDone, setProgramDone] = useState<number | null>(null);
  const [history, setHistory] = useState<WarmupResult[]>(() => loadHistory());
  const [tessiture, setTessiture] = useState<Tessiture | null>(() => loadTessiture());
  const [mic, setMic] = useState<MicSession | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<{ deviceId: string; label: string }[]>([]);
  const [inputId, setInputId] = useState<string>(() => { try { return localStorage.getItem(INPUT_PREF) || preferredInputId || ''; } catch { return preferredInputId || ''; } });
  const [speakers, setSpeakers] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const micRef = useRef<MicSession | null>(null);
  const opening = useRef<{ g: number; p: Promise<MicSession | null> } | null>(null);
  const gen = useRef(0);

  const openMic = useCallback(async (): Promise<MicSession | null> => {
    if (micRef.current && !micRef.current.isClosed) return micRef.current;
    // Ouverture déjà en cours pour cette « génération » (un changement d'onglet entre-temps en relance une).
    if (opening.current && opening.current.g === gen.current) return opening.current.p;
    const g = gen.current;
    const p = (async () => {
      try {
        const m = await MicSession.open(inputId || null);
        // Fermé ou onglet changé pendant l'ouverture : on rend le micro tout de suite.
        if (g !== gen.current) { void m.close(); return null; }
        micRef.current = m; setMic(m); setMicError(null);
        void listInputs().then(setInputs);
        return m;
      } catch (e: any) {
        setMicError(e?.message || 'Micro indisponible.');
        return null;
      } finally { if (opening.current?.p === p) opening.current = null; }
    })();
    opening.current = { g, p };
    return p;
  }, [inputId]);

  const releaseMic = useCallback(() => {
    gen.current++;
    const m = micRef.current;
    micRef.current = null;
    setMic(null);
    if (m) void m.close();
  }, []);

  // Accordeur : micro ouvert tant qu'il est à l'écran.
  useEffect(() => {
    if (tab !== 'accordeur' || current) return;
    void openMic();
    return () => releaseMic();
  }, [tab, current, openMic, releaseMic]);

  // Appli en arrière-plan (téléphone verrouillé, autre onglet) : micro rendu.
  useEffect(() => {
    const v = () => { if (document.visibilityState === 'hidden') releaseMic(); else if (tab === 'accordeur' && !current) void openMic(); };
    document.addEventListener('visibilitychange', v);
    return () => document.removeEventListener('visibilitychange', v);
  }, [tab, current, openMic, releaseMic]);

  // Fermeture de la fenêtre : tout est rendu.
  useEffect(() => () => { gen.current++; const m = micRef.current; micRef.current = null; if (m) void m.close(); }, []);

  useEffect(() => { void detectHeadphones().then(r => setSpeakers(r?.guess === 'haut-parleurs')); void listInputs().then(setInputs); }, []);

  // Échap : ferme (un exercice en cours capte Échap d'abord pour s'arrêter).
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); if (current) setCurrent(null); else onClose(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [current, onClose]);

  const onResult = useCallback((r: WarmupResult) => setHistory(addResult(r)), []);
  const onTessiture = useCallback((t: Tessiture) => { saveTessiture(t); setTessiture(t); }, []);

  const chooseInput = (id: string) => {
    setInputId(id);
    try { localStorage.setItem(INPUT_PREF, id); } catch { /* */ }
    releaseMic();
  };

  const startProgram = () => { setProgramDone(null); setTab('echauffement'); setCurrent({ id: PROGRAM[0], auto: true, prog: 0 }); };
  const startedAt = useRef(0);
  useEffect(() => { if (current?.prog === 0) startedAt.current = Date.now(); }, [current]);

  const streak = useMemo(() => streakDays(history), [history]);
  const ex = current ? exerciseById(current.id) : null;
  const next = current && current.prog !== null
    ? (current.prog + 1 < PROGRAM.length
      ? { title: exerciseById(PROGRAM[current.prog + 1])!.title, go: () => setCurrent({ id: PROGRAM[current.prog! + 1], auto: true, prog: current.prog! + 1 }) }
      : { title: 'Bilan', go: () => { setProgramDone(startedAt.current); setCurrent(null); } })
    : null;

  const todays = programDone !== null ? history.filter(r => r.at >= programDone) : [];

  return (
    <div className="fixed inset-0 z-[270] bg-black/70 backdrop-blur-sm flex items-stretch justify-center" role="dialog" aria-modal="true" aria-label="Voix et flow : échauffement et accordeur" data-testid="vocal-warmup" data-tab={tab}>
      <div className="w-full lg:max-w-4xl lg:my-4 flex flex-col bg-nv-bg lg:rounded-2xl border border-white/10 shadow-2xl text-white overflow-hidden">
        <header className="shrink-0 px-4 sm:px-5 pt-3 pb-2 border-b border-white/10 bg-nv-bg/95" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-black tracking-tight"><span aria-hidden="true" className="mr-1.5">🎤</span>Voix et flow</h2>
              <p className="text-[11px] text-slate-400 truncate">Échauffement, accordeur et progrès · tout reste sur ton appareil{mic ? ' · micro ouvert' : ''}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {mic && <span className="flex items-center gap-1.5 text-[11px] font-bold text-rose-300" data-testid="mic-on"><span className="w-2 h-2 rounded-full bg-rose-400 animate-pulse" aria-hidden="true" />Micro</span>}
              <button type="button" onClick={onClose} aria-label="Fermer" title="Fermer (Échap)" className="w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center"><i className="fas fa-times" aria-hidden="true"></i></button>
            </div>
          </div>
          <nav className="mt-2 grid grid-cols-3 gap-1 rounded-xl bg-white/[0.04] p-1" role="tablist" aria-label="Sections">
            {([['echauffement', 'Échauffement'], ['accordeur', 'Accordeur'], ['progres', 'Progrès']] as [VocalTab, string][]).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} data-vocal-tab={id}
                onClick={() => { if (current) setCurrent(null); setTab(id); }}
                className={`min-h-11 rounded-lg text-[13px] font-black transition-colors ${tab === id ? 'bg-cyan-400 text-black' : 'text-slate-300 hover:bg-white/10'}`}>{label}</button>
            ))}
          </nav>
        </header>

        <main className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-5" style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}>
          {tab === 'echauffement' && ex && current && (
            <WarmupExercise key={`${current.id}-${current.prog}`} exercise={ex} openMic={openMic} releaseMic={releaseMic} micError={micError}
              tessiture={tessiture} onTessiture={onTessiture} onResult={onResult} autoStart={current.auto} next={next}
              step={current.prog !== null ? `${current.prog + 1} / ${PROGRAM.length}` : undefined}
              onBack={() => setCurrent(null)} />
          )}

          {tab === 'echauffement' && !current && (
            <div className="space-y-5" data-testid="warmup-home">
              {programDone !== null && (
                <section className="rounded-2xl border border-emerald-400/40 bg-emerald-400/10 p-4" data-testid="warmup-bilan">
                  <p className="text-[16px] font-black">Échauffement terminé 🎉</p>
                  <p className="text-[13px] text-slate-200">{todays.length} exercice{todays.length > 1 ? 's' : ''} noté{todays.length > 1 ? 's' : ''}{todays.length ? ` · moyenne ${Math.round(todays.reduce((s, r) => s + r.score, 0) / todays.length)} / 100` : ''}. Ta voix est prête pour la prise.</p>
                  <ul className="mt-2 grid gap-1 sm:grid-cols-2 text-[12px]">{todays.map((r, i) => <li key={i} className="flex justify-between gap-2 rounded-lg bg-white/[0.04] px-2 py-1"><span className="truncate">{titleOf(r.id)}</span><span className="font-black">{r.score}</span></li>)}</ul>
                </section>
              )}
              <section className="rounded-2xl border border-cyan-400/30 bg-cyan-400/[0.07] p-4 sm:p-5">
                <h3 className="text-xl font-black leading-tight">Échauffe ta voix et ton flow</h3>
                <p className="mt-1 text-[13px] text-slate-300">≈ {minutes(PROGRAM)} min : souffle, sirènes, trilles, gammes dans ta tessiture, tenue de note, virelangues, puis le flow à 80, 90 et 140 BPM. Chaque exercice est noté (cents ou millisecondes).</p>
                <button type="button" onClick={startProgram} data-testid="warmup-start-program"
                  className="mt-4 w-full min-h-14 rounded-2xl bg-cyan-400 text-black text-[17px] font-black hover:bg-cyan-300 flex items-center justify-center gap-2">
                  <i className="fas fa-play" aria-hidden="true"></i>Démarrer l’échauffement
                </button>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-slate-300">
                  {streak > 0 && <span data-testid="warmup-streak">🔥 {streak} jour{streak > 1 ? 's' : ''} d’affilée</span>}
                  <span>Tessiture : {tessiture ? <b>{nameFr(tessiture.low)} → {nameFr(tessiture.high)}</b> : <span className="text-slate-400">pas encore mesurée</span>}{' '}
                    <button type="button" onClick={() => setCurrent({ id: 'tessiture', auto: false, prog: null })} className="inline-flex items-center min-h-11 px-1 underline font-bold">{tessiture ? 'refaire le test' : 'faire le test (20 s)'}</button></span>
                </div>
              </section>
              {speakers && (
                <p className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-[13px] text-amber-100" role="status" data-testid="warmup-casque">🎧 Le son sort sur des haut-parleurs : mets un casque pour le flow et la diction (sinon le clic revient dans le micro). Les exercices de voix marchent sans casque : la note guide se joue AVANT que tu chantes.</p>
              )}
              {micError && <p className="rounded-xl border border-rose-400/40 bg-rose-400/10 p-3 text-[13px] text-rose-200" role="alert">{micError}</p>}
              {GROUPS.map(g => (
                <section key={g.id}>
                  <h3 className="mb-2 text-[13px] font-black text-slate-300"><span aria-hidden="true" className="mr-1">{g.icon}</span>{g.title}</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {EXERCISES.filter(e => e.group === g.id && e.id !== 'tessiture').map(e => <ExerciseCard key={e.id} e={e} history={history}
                      onOpen={() => setCurrent({ id: e.id, auto: false, prog: null })} onGo={() => setCurrent({ id: e.id, auto: true, prog: null })} />)}
                  </div>
                </section>
              ))}
              <InputPicker inputs={inputs} value={inputId} onChange={chooseInput} />
            </div>
          )}

          {tab === 'accordeur' && (
            <div className="space-y-4">
              {micError && !mic && (
                <div className="rounded-xl border border-rose-400/40 bg-rose-400/10 p-3 text-[13px] text-rose-200" role="alert">
                  {micError} <button type="button" onClick={() => { void openMic(); }} className="ml-2 underline font-bold min-h-8">Réessayer</button>
                </div>
              )}
              <TunerPanel mic={mic} projectKey={projectKey} projectScale={projectScale} />
              <InputPicker inputs={inputs} value={inputId} onChange={chooseInput} />
            </div>
          )}

          {tab === 'progres' && (
            <div className="space-y-4" data-testid="warmup-progress">
              {!history.length ? (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center">
                  <p className="text-[15px] font-black">Pas encore de résultats</p>
                  <p className="mt-1 text-[13px] text-slate-400">Fais ton premier échauffement : chaque exercice noté s’affiche ici, jour après jour.</p>
                  <button type="button" onClick={startProgram} className="mt-4 min-h-12 px-5 rounded-xl bg-cyan-400 text-black font-black">Démarrer l’échauffement</button>
                </div>
              ) : (<>
                <p className="text-[13px] text-slate-300">{history.length} résultat{history.length > 1 ? 's' : ''} sur cet appareil{streak ? ` · 🔥 ${streak} jour${streak > 1 ? 's' : ''} d’affilée` : ''}.</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {progressIds(history).map(id => {
                    const p = progressOf(history, id)!;
                    const last = history.filter(r => r.id === id).sort((a, b) => b.at - a.at)[0];
                    return (
                      <section key={id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3" data-progress-id={id}>
                        <div className="flex items-baseline justify-between gap-2">
                          <h4 className="text-[14px] font-black truncate">{titleOf(id)}</h4>
                          <span className="text-[12px] text-slate-400 shrink-0">{p.count} fois</span>
                        </div>
                        <div className="mt-2 flex items-end gap-1 h-12" aria-label="10 derniers scores">
                          {Array.from({ length: 10 }, (_, i) => p.recent[i - (10 - p.recent.length)]).map((s, i) => s === undefined
                            ? <div key={i} className="flex-1 h-[6%] rounded-t bg-white/[0.06]" />
                            : <div key={i} className={`flex-1 rounded-t ${s >= 80 ? 'bg-emerald-400' : s >= 55 ? 'bg-amber-400' : 'bg-rose-400'}`} style={{ height: `${Math.max(8, s)}%` }} title={`${s}`} />)}
                        </div>
                        <p className="mt-1 text-[12px] text-slate-300">Dernier {p.last} · meilleur {p.best}{p.count > 1 ? ` · ${p.last - p.first >= 0 ? '+' : ''}${p.last - p.first} depuis le début` : ''}</p>
                        {last?.note && <p className="text-[11px] text-slate-500 truncate">{last.note}</p>}
                      </section>
                    );
                  })}
                </div>
                <div className="pt-2">
                  {!confirmClear ? <button type="button" onClick={() => setConfirmClear(true)} className="min-h-11 px-4 rounded-xl bg-white/[0.04] text-slate-300 text-[13px] font-bold">Effacer l’historique</button>
                    : <div className="flex flex-wrap items-center gap-2 text-[13px]"><span>Tout effacer sur cet appareil ?</span>
                      <button type="button" onClick={() => { clearHistory(); setHistory([]); setConfirmClear(false); }} className="min-h-11 px-4 rounded-xl bg-rose-500 text-white font-black">Oui, effacer</button>
                      <button type="button" onClick={() => setConfirmClear(false)} className="min-h-11 px-4 rounded-xl bg-white/10 font-bold">Annuler</button></div>}
                </div>
              </>)}
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

function titleOf(id: string) {
  const e = exerciseById(id);
  if (e) return e.title;
  const m = /^flow-(\d+)-(croches|triolets|doubles)$/.exec(id);
  if (m) return `Flow ${m[1]} BPM · ${m[2] === 'doubles' ? 'doubles croches' : m[2]}`;
  return id;
}

/** Exercices présents dans l'historique, dans l'ordre du programme. */
function progressIds(h: WarmupResult[]): string[] {
  const ids = Array.from(new Set(h.map(r => r.id)));
  const order = (id: string) => { const i = EXERCISES.findIndex(e => e.id === id); return i < 0 ? 100 : i; };
  return ids.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
}

const ExerciseCard: React.FC<{ e: Exercise; history: WarmupResult[]; onOpen: () => void; onGo: () => void }> = ({ e, history, onOpen, onGo }) => {
  const p = progressOf(history, e.id);
  return (
    <div className="flex items-stretch rounded-2xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] transition-colors" data-exercise-card={e.id}>
      <button type="button" onClick={onOpen} className="flex-1 min-w-0 text-left px-3 py-3">
        <span className="block text-[14px] font-black truncate">{e.title}</span>
        <span className="block text-[12px] text-slate-400 leading-snug">{e.goal}</span>
        <span className="mt-1 block text-[11px] text-slate-500">≈ {Math.max(1, Math.round(e.seconds * 1.6 / 60 * 2) / 2).toString().replace('.', ',')} min{p ? ` · meilleur ${p.best}` : ''}</span>
      </button>
      <button type="button" onClick={onGo} aria-label={`Démarrer : ${e.title}`} className="w-14 shrink-0 flex items-center justify-center border-l border-white/10 text-cyan-300 hover:bg-cyan-400 hover:text-black rounded-r-2xl"><i className="fas fa-play" aria-hidden="true"></i></button>
    </div>
  );
};

const InputPicker: React.FC<{ inputs: { deviceId: string; label: string }[]; value: string; onChange: (id: string) => void }> = ({ inputs, value, onChange }) => {
  if (inputs.length < 2) return null;
  return (
    <label className="flex flex-wrap items-center gap-2 text-[12px] text-slate-400">
      <span>Micro / entrée</span>
      <select value={value} onChange={e => onChange(e.target.value)} className="min-h-11 max-w-full rounded-xl bg-white/[0.06] border border-white/10 px-2 text-[13px] text-slate-100" aria-label="Micro ou entrée de la carte son">
        <option value="">Par défaut</option>
        {inputs.map(i => <option key={i.deviceId} value={i.deviceId}>{i.label}</option>)}
      </select>
    </label>
  );
};

export default VocalWarmup;
