import React, { useEffect, useRef, useState } from 'react';
import { DRUM_KITS, DrumMachine, DrumRow, setBars, PadMix, DEFAULT_PAD_MIX, PAD_MIX_PRESETS, libraryChoices, libSoundLabel, makeDrumMachine } from '../utils/drumKits';
import { ensurePatterns, GROOVES, whereAt, rowStepAt, rowStepsPerBar, STEPS_PER_BAR, STEP_RATES } from '../utils/drumPatterns';
import { KitBar, StepGraph, RowTiming, rowCells } from './DrumStepTools';
import { requestSampler } from '../utils/samplerPanelStore';
import { assignSample, MAX_PADS, userSampleId } from '../utils/drumSamples';
import { reorderSlices, shuffledOrder } from '../utils/chop';
import { sampleFromFile } from '../utils/padBuffers';
import { isTypingTarget, padIndexForCode, padKeyCodes, padKeyLabel } from '../utils/padKeys';
import DrumPatternBar from './DrumPatternBar';
import PadSampleTools, { SessionClipRef } from './PadSampleTools';
import ChopPanel from './ChopPanel';
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
  /** Ouvre (ou crée) la piste 808 dans le piano roll. */
  onOpen808?: () => void;
  has808?: boolean;
  /** V16 : fin de la boucle du morceau (s), pour le placement des motifs. */
  loopEnd?: number;
  /** Repères du morceau (régions Intro, Partie, Refrain…). */
  markers?: { type?: string; name: string; time: number; endTime?: number; color?: string }[];
  /** Clips audio de la session (à poser sur un pad ou à découper). */
  sessionClips?: SessionClipRef[];
  ensureEngine?: () => Promise<unknown>;
  notify?: (msg: string) => void;
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
  // Téléphone : 8 pas par page (1–8 / 9–16) au lieu d'une grille qui défilait
  // sans le dire (7 pas visibles sur 16) ; le pad touché est le pad « choisi ».
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 639px)').matches);
  const [page, setPage] = useState(0);
  const [selPad, setSelPad] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia?.('(max-width: 639px)');
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  // Tablette : la grille déborde (16 ou 32 pas) -> fondu + flèche à droite
  const gridRef = useRef<HTMLDivElement>(null);
  const [moreRight, setMoreRight] = useState(false);
  const checkScroll = () => {
    const el = gridRef.current;
    setMoreRight(!!el && el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  };
  useEffect(() => {
    checkScroll();
    window.addEventListener('resize', checkScroll);
    return () => window.removeEventListener('resize', checkScroll);
  }, [p.open, p.dm?.bars, !!p.dm, narrow]);

  // Tête de lecture : pas du motif affiché (s'il joue à cet endroit) et mesure du morceau.
  const [playBar, setPlayBar] = useState(-1);
  // R18 : position fine (rangées en 1/32, triolets, longueurs propres).
  const [playW, setPlayW] = useState<{ pos16: number; runBars: number } | null>(null);
  useEffect(() => {
    if (!p.open || !p.dm) return;
    let raf = 0;
    const dmP = ensurePatterns(p.dm);
    const tick = () => {
      if (p.isPlaying) {
        const w = whereAt(dmP, p.bpm, audioEngine.getCurrentTime() - p.clipStart);
        const here = !!w && w.patternId === dmP.activePattern;
        setPlayStep(here ? w!.step : -1);
        setPlayW(prev => (here ? (prev && Math.floor(prev.pos16 * 6) === Math.floor(w!.pos16 * 6) ? prev : { pos16: w!.pos16, runBars: w!.runBars }) : null));
        setPlayBar(w ? w.bar : -1);
      } else { setPlayStep(-1); setPlayBar(-1); setPlayW(null); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [p.open, p.isPlaying, p.bpm, p.clipStart, p.dm]);

  // V16/V17 : découpe, pads perso, clavier.
  const [chop, setChop] = useState<null | { buffer: AudioBuffer; name: string } | 'new'>(null);
  const padFileRef = useRef<HTMLInputElement>(null);
  const [keysOn, setKeysOn] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches);
  const [layout, setLayout] = useState<Map<string, string> | null>(null);
  const [flash, setFlash] = useState(-1);
  // R18 · Roulement (FL : Note Repeat, MPC : Note Repeat) : tenir un pad le rejoue en rythme.
  const [repeat, setRepeat] = useState<0 | 4 | 8 | 16 | 32 | 24>(0);
  const repeatTimer = useRef<number | null>(null);
  const stopRepeat = () => { if (repeatTimer.current) { window.clearInterval(repeatTimer.current); repeatTimer.current = null; } };
  useEffect(() => () => stopRepeat(), []);
  /** Démarre le roulement d'un pad : 1re frappe tout de suite, puis calé sur la grille au tempo. */
  const startRepeat = (ri: number) => {
    stopRepeat();
    const ctx = audioEngine.ctx;
    if (!repeat || !ctx) return;
    const per = (60 / p.bpm) * (4 / repeat);
    const song0 = audioEngine.getCurrentTime();
    // En lecture : frappes sur la grille du morceau ; à l'arrêt : à partir de l'appui.
    let next = p.isPlaying ? ctx.currentTime + (Math.ceil((song0 + 0.001) / per) * per - song0) : ctx.currentTime + per;
    let n = 0;
    const tick = () => {
      while (next < ctx.currentTime + 0.12 && n < 400) {
        audioEngine.triggerTrackAttack('track-drums', 60 + ri, 0.85, next);
        next += per; n++;
      }
    };
    tick();
    repeatTimer.current = window.setInterval(tick, 25);
  };
  useEffect(() => {
    try { (navigator as any).keyboard?.getLayoutMap?.().then((m: any) => setLayout(new Map(m))).catch(() => {}); } catch { /* navigateur sans l'API */ }
  }, []);
  const auditionRef = useRef(p.onAudition);
  auditionRef.current = p.onAudition;
  const visibleRows = (d: DrumMachine) => d.rows.map((r, ri) => ({ r, ri })).filter(({ r }) => r.id !== '808' || r.steps.some(v => v > 0)).map(x => x.ri);
  useEffect(() => {
    if (!p.open || !keysOn || !p.dm) return;
    const visible = visibleRows(p.dm);
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const k = padIndexForCode(e.code, visible.length);
      if (k < 0) return;
      // Le pad prend la touche (sinon R = enregistrer, L = boucle…).
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat) return;
      const ri = visible[k];
      auditionRef.current(ri);
      repeatStartRef.current(ri);
      setFlash(ri);
      window.setTimeout(() => setFlash(f => (f === ri ? -1 : f)), 140);
    };
    const onUp = (e: KeyboardEvent) => { if (padIndexForCode(e.code, visible.length) >= 0) stopRepeat(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onUp, true); };
  }, [p.open, keysOn, p.dm]);
  const repeatStartRef = useRef(startRepeat);
  repeatStartRef.current = startRepeat;

  if (!p.open) return null;
  const dm = p.dm;

  /** Fichiers audio → pads (sur un pad précis, ou un nouveau pad par fichier). Une seule étape d'annulation. */
  const importFiles = async (files: File[], rowIndex: number | null) => {
    const audio = files.filter(f => /^audio\//.test(f.type) || /\.(wav|mp3|aiff?|flac|ogg|m4a)$/i.test(f.name));
    if (!audio.length) { p.notify?.('Glisse un fichier audio (WAV, MP3, AIFF, FLAC…).'); return; }
    try {
      await p.ensureEngine?.();
      if (!audioEngine.ctx) return;
      let cur = p.dm || makeDrumMachine('empty');
      let last = -1;
      for (const [i, f] of (rowIndex !== null ? audio.slice(0, 1) : audio).entries()) {
        const s = await sampleFromFile(audioEngine.ctx, f);
        const r = assignSample(cur, s.id, s.info, { rowIndex: rowIndex !== null && i === 0 ? rowIndex : null });
        if (!r) { p.notify?.(`${MAX_PADS} pads au plus : pose ton son sur un pad existant (bouton réglages du pad → « Ton son »).`); break; }
        cur = r.dm; last = r.rowIndex;
      }
      if (last < 0) return;
      p.onChange(cur);
      setSelPad(last); setSoundMenu(last);
      window.setTimeout(() => p.onAudition(last), 200);
      p.notify?.(`🥁 ${audio.length > 1 && rowIndex === null ? `${audio.length} sons ajoutés` : `« ${cur.rows[last].name} » posé`} sur ${rowIndex === null ? 'de nouveaux pads' : 'le pad'} : allume ses pas dans la grille. Annuler (Ctrl+Z) pour revenir.`);
    } catch {
      p.notify?.('Ce fichier ne se lit pas : essaie un WAV, MP3, AIFF ou FLAC.');
    }
  };
  const onDropFiles = (e: React.DragEvent, rowIndex: number | null) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); e.stopPropagation();
    void importFiles(Array.from(e.dataTransfer.files), rowIndex);
  };
  const allowDrop = (e: React.DragEvent) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault(); };
  const sliceCount = dm ? dm.rows.filter(r => r.slice).length : 0;
  const keyOf = (ri: number) => {
    if (!dm || !keysOn) return '';
    const k = visibleRows(dm).indexOf(ri);
    return k >= 0 && k < 30 ? padKeyLabel(padKeyCodes(30)[k], layout) : '';
  };

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
  // Largeur d'un pas 1/16 sur ordinateur (w-8 + gap-1 ; tablette au doigt : w-9 + gap-1).
  const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  const step16Px = coarse ? 40 : 36;
  const pages = len / 8;
  const curPage = Math.min(page, pages - 1);
  const shownSteps = narrow ? Array.from({ length: 8 }, (_, i) => curPage * 8 + i) : Array.from({ length: len }, (_, i) => i);
  const pad = dm?.rows[Math.min(selPad, (dm?.rows.length || 1) - 1)];
  // Ancienne rangée 808 (projets d'avant la piste 808) : visible tant qu'elle joue.
  const shownRows = dm ? dm.rows.map((r, ri) => ({ r, ri })).filter(({ r }) => r.id !== '808' || r.steps.some(v => v > 0)) : [];

  // Ordinateur : panneau en bas, sans fond qui bloque (la barre de transport
  // reste cliquable). Téléphone : feuille plein écran avec fond.
  // data-nova-transport : la barre d'espace lance / coupe la lecture (App.tsx).
  return (
    <div data-nova-transport="" className={narrow
      ? 'fixed inset-0 z-[560] flex items-end justify-center bg-black/50'
      : 'fixed inset-x-0 bottom-0 z-[560] flex justify-center px-4 pb-3 pointer-events-none'}
      onClick={narrow ? p.onClose : undefined} role="dialog" aria-modal={narrow ? 'true' : undefined} aria-labelledby="drums-title"
      onDragOver={allowDrop} onDrop={e => onDropFiles(e, null)}>
      <div className={`w-full flex flex-col bg-nv-surface border border-white/[0.06] shadow-2xl pb-[env(safe-area-inset-bottom)] pointer-events-auto ${narrow ? 'max-h-[92vh] rounded-t-3xl' : 'max-w-4xl max-h-[min(80vh,760px)] rounded-3xl shadow-black/60'}`} onClick={e => e.stopPropagation()}>
        {/* En-tête */}
        <div className="flex items-center gap-2 px-4 pt-4 pb-3 border-b border-white/5">
          <h2 id="drums-title" className="text-[16px] font-black text-white mr-auto whitespace-nowrap">🥁 Batterie <span className="hidden sm:inline text-slate-400 font-bold text-[12px]">Make Music</span></h2>
          {p.onOpen808 && (
            <button type="button" onClick={p.onOpen808} title="Basse 808 : joue-la au piano roll, accordée sur la tonalité, avec glissés"
              className="h-10 px-3 rounded-xl whitespace-nowrap text-[12px] font-black bg-white/[0.06] text-slate-200 hover:bg-white/10">
              <i className="fas fa-wave-square mr-1.5 text-fuchsia-400" aria-hidden />808{p.has808 ? '' : ' +'}
            </button>
          )}
          <button type="button" onClick={() => setChop(chop ? null : 'new')} aria-expanded={!!chop}
            title="Découper une boucle en tranches sur des pads (comme Slicex dans FL Studio, ou Simpler en mode Slice dans Ableton)"
            className={`h-10 px-3 rounded-xl text-[12px] font-black ${chop ? 'bg-pink-500 text-black' : 'bg-white/[0.06] text-slate-200 hover:bg-white/10'}`}>
            <i className={`fas fa-cut ${chop ? '' : 'text-pink-400'}`} aria-hidden /><span className="hidden sm:inline"> Découper</span>
          </button>
          {dm && !narrow && (
            <button type="button" onClick={() => setKeysOn(v => !v)} aria-pressed={keysOn}
              title={keysOn ? "Clavier de l'ordinateur → pads : activé (rangée du milieu = pads 1 à 10). Clique pour le couper." : "Jouer les pads au clavier de l'ordinateur (comme le « typing keyboard » de FL Studio)"}
              className={`h-10 px-3 rounded-xl text-[12px] font-black ${keysOn ? 'bg-cyan-500 text-black' : 'bg-white/[0.06] text-slate-200 hover:bg-white/10'}`}>
              <i className="fas fa-keyboard" />
            </button>
          )}
          {dm && (
            <button type="button" onClick={p.onTogglePlay} className={`h-10 px-4 rounded-xl text-[12px] font-black ${p.isPlaying ? 'bg-white text-black' : 'bg-cyan-500 text-black'}`}>
              <i className={`fas ${p.isPlaying ? 'fa-pause' : 'fa-play'} mr-1.5`} />{p.isPlaying ? 'Pause' : 'Écouter'}
            </button>
          )}
          <button type="button" onClick={p.onClose} aria-label="Fermer la batterie" title="Fermer (Échap)" className="w-10 h-10 rounded-xl bg-white/[0.06] text-slate-300 hover:text-white"><i className="fas fa-times" /></button>
        </div>

        <div className="overflow-y-auto px-4 py-3 space-y-3">
          {/* Kits */}
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Style de batterie">
            {DRUM_KITS.map(k => (
              <button key={k.id} type="button" onClick={() => p.onKit(k.id)} aria-pressed={dm?.kitId === k.id}
                className={`nova-hit-tactile shrink-0 h-9 px-3 rounded-xl text-[12px] font-bold ${dm?.kitId === k.id ? 'bg-cyan-500/15 text-white ring-1 ring-cyan-400/70' : 'bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] hover:text-white'}`}>
                {k.emoji} {k.name}
              </button>
            ))}
          </div>

          <KitBar dm={dm} onChange={p.onChange} ensureEngine={p.ensureEngine} notify={p.notify} narrow={narrow} />

          <input ref={padFileRef} type="file" multiple accept="audio/*,.wav,.mp3,.aif,.aiff,.flac,.ogg,.m4a" className="hidden"
            onChange={e => { const fs = Array.from(e.target.files || []); e.target.value = ''; if (fs.length) void importFiles(fs, null); }} />
          {chop && (
            <ChopPanel dm={dm} onChange={p.onChange} onClose={() => setChop(null)} bpm={p.bpm} sessionClips={p.sessionClips || []}
              ensureEngine={p.ensureEngine || (async () => {})} initial={chop === 'new' ? null : chop} notify={p.notify} />
          )}

          {!dm ? (
            <div className="space-y-2">
              <p className="text-sm text-slate-300">Choisis un style de batterie : elle se cale sur le tempo et la tonalité de ta mélodie.</p>
              <button type="button" onClick={() => padFileRef.current?.click()}
                className="w-full rounded-2xl border-2 border-dashed border-white/15 hover:border-cyan-400/60 px-4 py-4 text-[13px] font-bold text-slate-200">
                <i className="fas fa-file-import mr-2" />Ou commence avec TES sons : choisis ou glisse ici tes fichiers audio (un pad par son)
              </button>
            </div>
          ) : (
            <>
              <DrumPatternBar dm={dm} onChange={p.onChange} bpm={p.bpm} loopEnd={p.loopEnd || 0} markers={p.markers} playBar={playBar} />

              {/* Téléphone : choix de la moitié de mesure + réglages du pad choisi */}
              {narrow && (
                <div className="flex items-center gap-2">
                  <div className="flex min-w-0 shrink overflow-x-auto no-scrollbar rounded-xl border border-white/10" role="group" aria-label="Pas affichés">
                    {Array.from({ length: pages }, (_, pi) => (
                      <button key={pi} type="button" onClick={() => setPage(pi)} aria-pressed={curPage === pi}
                        aria-label={`Pas ${pi * 8 + 1} à ${pi * 8 + 8}`}
                        className={`relative h-10 min-w-[48px] px-2 text-[12px] font-black tabular-nums ${curPage === pi ? 'bg-white text-black' : 'bg-white/5 text-white'}`}>
                        {pi * 8 + 1}–{pi * 8 + 8}
                        {/* Point = la lecture joue dans cette page */}
                        {playStep >= pi * 8 && playStep < pi * 8 + 8 && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-cyan-400" />}
                      </button>
                    ))}
                  </div>
                  {pad && (
                    <button type="button" onClick={() => setSoundMenu(soundMenu === null ? Math.min(selPad, dm.rows.length - 1) : null)}
                      aria-expanded={soundMenu !== null} title="Son et mix du pad choisi"
                      className={`ml-auto min-w-0 h-10 px-3 rounded-xl text-[12px] font-bold truncate ${soundMenu !== null ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-200'}`}>
                      <i className="fas fa-sliders-h mr-1.5" />{pad.name}
                    </button>
                  )}
                </div>
              )}

              {/* Grille */}
              <div className="relative">
              <div ref={gridRef} onScroll={checkScroll} className={narrow ? '-mx-2' : 'overflow-x-auto no-scrollbar'}>
                <div className={narrow ? '' : 'inline-block min-w-full'}>
                  {shownRows.map(({ r, ri }) => (
                    <div key={r.id} className="flex items-center gap-1 mb-1">
                      {narrow ? (
                        <button type="button" onClick={() => { p.onAudition(ri); setSelPad(ri); if (soundMenu !== null) setSoundMenu(ri); }}
                          onPointerDown={() => startRepeat(ri)} onPointerUp={stopRepeat} onPointerLeave={stopRepeat} onPointerCancel={stopRepeat} data-own-longpress=""
                          aria-label={`Écouter ${r.name}`} aria-pressed={selPad === ri} title="Écouter et choisir ce pad"
                          className={`shrink-0 w-10 h-10 rounded-lg px-0.5 text-[9px] leading-[10px] font-bold text-center break-words overflow-hidden ${flash === ri ? 'bg-cyan-400 text-black' : selPad === ri ? 'bg-cyan-500/20 text-white ring-1 ring-cyan-400/60' : 'bg-white/5 text-slate-200'}`}>
                          <span className={r.muted ? 'line-through opacity-50' : ''}>{r.name}</span>
                          {r.solo && <span className="text-amber-300"> S</span>}
                        </button>
                      ) : (
                      <div className="sticky left-0 z-10 bg-nv-surface pr-1 flex items-center gap-1 w-[150px] shrink-0">
                        <button type="button" onClick={() => { p.onAudition(ri); setSelPad(ri); }}
                          onPointerDown={() => startRepeat(ri)} onPointerUp={stopRepeat} onPointerLeave={stopRepeat} onPointerCancel={stopRepeat} data-own-longpress=""
                          aria-pressed={selPad === ri}
                          title={`${r.name} : écouter le son et le choisir pour le graphe${keyOf(ri) ? ` (touche ${keyOf(ri)})` : ''}. Glisse un fichier audio ici pour mettre TON son sur ce pad.`}
                          onDragOver={allowDrop} onDrop={e => onDropFiles(e, ri)}
                          className={`flex-1 min-w-0 h-9 rounded-lg text-left px-2 text-[11px] font-bold truncate ${flash === ri ? 'bg-cyan-400 text-black' : selPad === ri ? 'bg-cyan-500/15 text-white ring-1 ring-cyan-400/50' : 'bg-white/[0.04] text-white hover:bg-white/[0.08]'}`}>
                          {r.rate && r.rate !== '16' && <span className="mr-1 text-[9px] text-violet-300">{STEP_RATES.find(x => x.id === r.rate)?.label}</span>}
                          {keyOf(ri) && <span className="mr-1 inline-block min-w-[14px] px-0.5 rounded bg-white/10 text-[9px] text-center text-slate-300">{keyOf(ri)}</span>}
                          {userSampleId(r.sound) && <i className={`fas ${r.slice ? 'fa-cut text-pink-300' : 'fa-user text-amber-300'} mr-1 text-[9px]`} />}
                          <span className={r.muted ? 'line-through opacity-50' : ''}>{r.name}</span>
                          {r.solo && <span className="ml-1 text-amber-300">S</span>}
                          {r.mix && Object.values(r.mix).some(v => v) && <span className="ml-1 text-violet-300" title="Effets sur ce pad">✦</span>}
                        </button>
                        <button type="button" onClick={() => setSoundMenu(soundMenu === ri ? null : ri)} aria-label={`Son et mix du pad ${r.name}`} title="Son et mix du pad"
                          className={`nova-hit-tactile w-7 h-9 rounded-lg text-[11px] ${soundMenu === ri ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}><i className="fas fa-sliders-h" /></button>
                      </div>
                      )}
                      {(rowStepsPerBar(r) !== STEPS_PER_BAR || (r.len || 0) > 0) ? (() => {
                        // R18 : rangée en 1/32 / triolets / longueur propre : cases à l'échelle du temps.
                        const { cells, usable } = rowCells(r, dm.bars, narrow ? curPage : null);
                        const ps = playW ? rowStepAt(r, playW, dm.bars) : -1;
                        return (
                          <div className={`flex gap-0.5 ${narrow ? 'flex-1 min-w-0' : 'shrink-0'}`} style={narrow ? undefined : { width: `${len * step16Px - 4}px` }}>
                            {cells.map(si => {
                              const v = r.steps[si] || 0;
                              const roll = r.ratchet[si] || 1;
                              const off = si >= usable;
                              return (
                                <button key={si} type="button" disabled={off} data-own-longpress=""
                                  aria-label={`${r.name}, pas ${si + 1}${off ? ' (hors de la longueur de la rangée)' : v ? (roll > 1 ? `, roll ×${roll}` : ', actif') : ''}`}
                                  onPointerDown={() => startPress(ri, si)} onPointerUp={() => endPress(ri, si)}
                                  onPointerLeave={() => { if (pressTimer.current) window.clearTimeout(pressTimer.current); }}
                                  onContextMenu={e => { e.preventDefault(); cycleRoll(ri, si); }}
                                  className={`relative flex-1 min-w-0 rounded-[4px] ${narrow ? 'h-10' : 'h-9 [@media(pointer:coarse)]:h-10'} ${ps === si ? 'ring-2 ring-white/70' : ''} ${
                                    off ? 'bg-white/[0.015] opacity-40' : v >= 100 ? 'bg-violet-400' : v > 0 ? 'bg-violet-400/45' : (si * STEPS_PER_BAR / rowStepsPerBar(r)) % 4 === 0 ? 'bg-white/[0.09]' : 'bg-white/[0.04]'}`}>
                                  {roll > 1 && v > 0 && <span className="absolute inset-0 flex items-center justify-center text-[9px] font-black text-black">×{roll}</span>}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })() : shownSteps.map(si => {
                        const v = r.steps[si] || 0;
                        const roll = r.ratchet[si] || 1;
                        const beatStart = si % 4 === 0;
                        return (
                          <button
                            key={si}
                            type="button"
                            data-own-longpress=""
                            aria-label={`${r.name}, pas ${si + 1}${v ? (roll > 1 ? `, roll ×${roll}` : ', actif') : ''}`}
                            onPointerDown={() => startPress(ri, si)}
                            onPointerUp={() => endPress(ri, si)}
                            onPointerLeave={() => { if (pressTimer.current) window.clearTimeout(pressTimer.current); }}
                            onContextMenu={e => { e.preventDefault(); cycleRoll(ri, si); }}
                            className={`relative rounded-md border transition-colors ${narrow ? 'nova-hit flex-1 min-w-0 h-10' : 'nova-hit-tactile shrink-0 w-8 h-9 [@media(pointer:coarse)]:w-9 [@media(pointer:coarse)]:h-10'} ${playStep === si ? 'ring-2 ring-white/70' : ''} ${
                              v >= 100 ? 'bg-cyan-400 border-transparent'
                              : v > 0 ? 'bg-cyan-400/40 border-transparent'
                              : beatStart ? 'bg-white/[0.09] border-transparent' : 'bg-white/[0.04] border-transparent'}`}
                          >
                            {roll > 1 && v > 0 && <span className="absolute inset-0 flex items-center justify-center text-[10px] font-black text-black">×{roll}</span>}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
              {!narrow && moreRight && (
                <button type="button" onClick={() => gridRef.current?.scrollBy({ left: gridRef.current.clientWidth * 0.6, behavior: 'smooth' })}
                  aria-label="Voir les pas suivants" title="Pas suivants"
                  className="absolute right-0 inset-y-0 mb-1 w-11 flex items-center justify-end pr-1.5 rounded-r-lg bg-gradient-to-l from-nv-surface via-nv-surface/85 to-transparent text-white/80">
                  <i className="fas fa-chevron-right" />
                </button>
              )}
              </div>

              {/* R18 · Éditeur de graphe du pad choisi (vélocité, pan, hauteur par pas). */}
              {dm.rows[Math.min(selPad, dm.rows.length - 1)] && (() => {
                const gi = Math.min(selPad, dm.rows.length - 1);
                const gr = dm.rows[gi];
                const plain = rowStepsPerBar(gr) === STEPS_PER_BAR && !((gr.len || 0) > 0);
                const cells = plain ? shownSteps : rowCells(gr, dm.bars, narrow ? curPage : null).cells.filter(i => i < gr.steps.length);
                return (
                  <div className={narrow ? '' : 'overflow-x-auto no-scrollbar'}>
                    <div style={narrow ? undefined : { width: `${154 + len * step16Px}px`, paddingLeft: '154px' }}>
                      <StepGraph dm={dm} rowIndex={gi} cells={cells} onChange={p.onChange}
                        playStep={playW ? rowStepAt(gr, playW, dm.bars) : -1} />
                    </div>
                  </div>
                );
              })()}

              {soundMenu !== null && dm.rows[soundMenu] && (
                <PadEditor
                  kitId={dm.kitId}
                  row={dm.rows[soundMenu]}
                  onEdit={patch => editRow(soundMenu, patch)}
                  onAudition={() => setTimeout(() => p.onAudition(soundMenu), 120)}
                  onClose={() => setSoundMenu(null)}
                  extra={
                    <>
                    <RowTiming dm={dm} rowIndex={soundMenu} onChange={p.onChange} />
                    <PadSampleTools dm={dm} rowIndex={soundMenu} onChange={d => { p.onChange(d); if (!d.rows[soundMenu]) setSoundMenu(null); }}
                      onAudition={() => p.onAudition(soundMenu)} sessionClips={p.sessionClips || []}
                      ensureEngine={p.ensureEngine || (async () => {})} onChop={src => setChop(src)} notify={p.notify} />
                    <button type="button" onClick={() => { requestSampler({ kind: 'from-pad', rowIndex: soundMenu }); p.onClose(); }} data-testid="pad-to-sampler"
                      title="Met le son de ce pad dans un sampler sur une nouvelle piste : il se joue sur tout le clavier (808 mélodique, perc accordée) — comme « Send to Sampler » de FL ou Convert to Simpler de Live"
                      className="nova-hit h-10 px-3 rounded-lg bg-amber-500/15 border border-amber-400/40 text-amber-200 text-[12px] font-bold hover:bg-amber-500/25">
                      <i className="fas fa-wave-square mr-1.5" />Convertir en sampler
                    </button>
                    </>
                  }
                />
              )}

              {/* Réglages */}
              <div className="flex flex-wrap items-center gap-3 text-[12px] text-slate-300">
                <div className="flex rounded-xl overflow-hidden border border-white/10">
                  {[1, 2, 4].map(b => (
                    <button key={b} type="button" onClick={() => p.onChange(setBars(dm, b as 1 | 2 | 4))} title={`Motif de ${b} mesure${b > 1 ? 's' : ''}`}
                      className={`h-10 px-3 font-bold ${dm.bars === b ? 'bg-white text-black' : 'bg-white/5 text-white'}`}>{b} mesure{b > 1 ? 's' : ''}</button>
                  ))}
                </div>
                <label className="flex items-center gap-2" title="Swing : décale les doubles-croches paires, comme le swing global de FL Studio">
                  Swing
                  <input type="range" min={0} max={0.6} step={0.05} value={dm.swing} onChange={e => p.onChange({ ...dm, swing: parseFloat(e.target.value) })} />
                  <span className="tabular-nums w-8">{Math.round(dm.swing * 100)}%</span>
                </label>
                <label className="flex items-center gap-1.5" title={`Groove : ${GROOVES.find(g => g.id === (dm.groove || 'none'))?.hint} Comme le Groove Pool d'Ableton.`}>
                  Groove
                  <select value={dm.groove || 'none'} onChange={e => p.onChange({ ...dm, groove: e.target.value === 'none' ? undefined : e.target.value })}
                    className="h-10 rounded-lg bg-white/5 border border-white/10 px-1.5 text-[12px] text-white">
                    {GROOVES.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                  {dm.groove && dm.groove !== 'none' && (
                    <input type="range" min={0} max={1} step={0.05} value={dm.grooveAmount ?? 1} aria-label="Dosage du groove"
                      onChange={e => p.onChange({ ...dm, grooveAmount: parseFloat(e.target.value) })} className="w-20" />
                  )}
                </label>
                <label className="flex items-center gap-1.5" title="Roulement (Note Repeat de FL Studio et de la MPC) : tiens un pad (ou sa touche) et il se rejoue en rythme, calé sur le tempo.">
                  <i className="fas fa-repeat text-violet-300" aria-hidden />Roulement
                  <select value={repeat} onChange={e => setRepeat(parseInt(e.target.value, 10) as 0 | 4 | 8 | 16 | 32 | 24)} data-testid="note-repeat"
                    className="h-10 rounded-lg bg-white/5 border border-white/10 px-1.5 text-[12px] text-white">
                    <option value={0}>Non</option><option value={4}>1/4</option><option value={8}>1/8</option><option value={16}>1/16</option><option value={24}>1/16 T</option><option value={32}>1/32</option>
                  </select>
                </label>
                <button type="button" onClick={() => padFileRef.current?.click()} disabled={dm.rows.length >= MAX_PADS}
                  title="Ajouter un pad avec TON son (fichier audio). Tu peux aussi glisser des fichiers sur la batterie."
                  className="h-10 px-3 rounded-lg bg-white/[0.06] text-slate-200 hover:text-white disabled:opacity-40"><i className="fas fa-plus mr-1" />Pad</button>
                {sliceCount > 1 && (
                  <button type="button" onClick={() => p.onChange(reorderSlices(dm, shuffledOrder(sliceCount, Date.now())))}
                    title="Rejoue les tranches dans un autre ordre (comme « Randomize » dans Slicex). Annuler pour revenir."
                    className="h-10 px-3 rounded-lg bg-white/[0.06] text-slate-200 hover:bg-white/10">🎲 Remixer</button>
                )}
                <button type="button" onClick={p.onRemove} className="ml-auto h-10 px-3 rounded-lg bg-white/[0.06] text-slate-300 hover:text-red-300">Retirer la batterie</button>
              </div>
              <p className="text-[11px] text-slate-500">
                {narrow && "Touche le nom d'un pad pour l'écouter et le choisir ; 1–8 / 9–16 change de moitié de mesure (le point bleu montre où joue la lecture). "}
                Motifs : comme les Patterns de FL Studio — crée A, B, C…, puis peins les mesures du morceau. Glisse tes fichiers audio sur un pad (ou « + Pad ») ; ✂️ découpe une boucle sur les pads.{keysOn && !narrow ? ' Clavier : rangée du milieu = pads 1 à 10.' : ''} Tap : allumer → accent léger → éteindre. Appui long (ou clic droit) : roll ×2 ×3 ×4. Bouton réglages d'un pad : son, accordage, longueur et mix (EQ, compression, saturation, réverb, délai). Le log drum est accordé sur la tonalité du morceau ; la 808 se joue au piano roll (bouton « 🔊 808 »). Barre d'espace : lecture / pause.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

interface PadEditorProps {
  /** Réglages du sample (V16). */
  extra?: React.ReactNode;
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
const PadEditor: React.FC<PadEditorProps> = ({ kitId, row, onEdit, onAudition, onClose, extra }) => {
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
          className={`nova-hit h-8 px-3 rounded-lg text-[11px] font-black ${row.muted ? 'bg-red-500 text-white' : 'bg-white/10 text-white'}`}>Mute</button>
        <button type="button" onClick={() => onEdit(r => ({ ...r, solo: !r.solo }))} aria-pressed={!!row.solo}
          className={`nova-hit h-8 px-3 rounded-lg text-[11px] font-black ${row.solo ? 'bg-amber-400 text-black' : 'bg-white/10 text-white'}`}>Solo</button>
        <button type="button" onClick={onClose} aria-label="Fermer les réglages du pad" className="nova-hit w-8 h-8 rounded-lg bg-white/5 text-slate-300"><i className="fas fa-times" /></button>
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
                    className={`nova-hit h-8 min-w-[36px] px-2 rounded-lg text-[12px] font-bold ${row.sound === ref ? 'bg-cyan-500 text-black' : 'bg-white/10 text-white hover:bg-white/15'}`}>
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
                  className={`nova-hit h-8 px-3 rounded-lg text-[12px] font-bold ${row.sound === `synth:${x.id}` ? 'bg-cyan-500 text-black' : 'bg-white/10 text-white hover:bg-white/15'}`}>
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

      {extra}

      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mr-auto">Mix du pad</p>
          <button type="button" onClick={() => setMix({ ...DEFAULT_PAD_MIX, ...(PAD_MIX_PRESETS[row.id] || {}) })}
            className="nova-hit h-8 px-3 rounded-lg bg-violet-500/20 text-violet-200 text-[11px] font-bold hover:bg-violet-500/30">✦ Réglage pro</button>
          <button type="button" onClick={() => onEdit(r => ({ ...r, mix: {} }))}
            className="nova-hit h-8 px-3 rounded-lg bg-white/5 text-slate-300 text-[11px] font-bold hover:text-white">Sans effet</button>
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
