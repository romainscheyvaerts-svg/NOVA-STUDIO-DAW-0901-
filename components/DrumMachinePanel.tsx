import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DRUM_KITS, DrumMachine, DrumRow, setBars, PadMix, DEFAULT_PAD_MIX, PAD_MIX_PRESETS, libraryChoices, libSoundLabel, makeDrumMachine } from '../utils/drumKits';
import {
  duplicatePattern, ensurePatterns, GROOVES, whereAt, rowStepAt, rowStepsPerBar, selectPattern, setRowLength, setRowRate, setStepParam, stepParamOf,
  STEPS_PER_BAR, STEP_RATES, type StepParam, type StepRate,
} from '../utils/drumPatterns';
import {
  clearPattern, clearRow, copyPattern, copyRow, clipboard, fillEvery, paste, recordHit, reverseRow, rotatePattern, rotateRow,
} from '../utils/drumEdit';
import { KitBar, StepGraph, rowCells } from './DrumStepTools';
import { requestSampler } from '../utils/samplerPanelStore';
import { assignSample, MAX_PADS, removePad, userSampleId } from '../utils/drumSamples';
import { reorderSlices, shuffledOrder } from '../utils/chop';
import { sampleFromFile } from '../utils/padBuffers';
import { isTypingTarget, padIndexForCode, padKeyCodes, padKeyLabel } from '../utils/padKeys';
import DrumPatternBar from './DrumPatternBar';
import PadSampleTools, { SessionClipRef } from './PadSampleTools';
import ChopPanel from './ChopPanel';
import { libUrl } from '../utils/drumLibrary';
import { DRUM_SOUNDS, DrumCategory } from '../utils/drumSounds';
import { audioEngine } from '../engine/AudioEngine';
import DrumKitBrowser from './DrumKitBrowser';
import { applyKitDef, isKitRef, KIT_DRAG_TYPE, kitIndexIfLoaded, KitDef, KitIndex, loadKitIndex, setPadKitSound } from '../utils/drumKitLibrary';
import { DrumMenu, menuAt, menuUnder, type DrumMenuItem, type DrumMenuState } from './DrumMenu';
import PadSamplerEditor, { TOUCH_RANGE } from './PadSamplerEditor';
import { useSimpleMode } from '../utils/simpleMode';
import { tempoMapStore, timeToQuarters } from '../utils/tempoMap';

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
  /** Tonique du morceau (0-11) : les 808 des kits y sont réaccordées. */
  projectKey?: number | null;
  /** Change de valeur pour ouvrir le navigateur des kits (bouton « Kits » hors du panneau). */
  kitsSignal?: number;
  /** Métronome du projet (la touche O est prise par les pads quand la batterie est ouverte). */
  metronomeOn?: boolean;
  onToggleMetronome?: () => void;
}

const CAT_OF: Record<string, DrumCategory[]> = {
  kick: ['kick'], '808': ['808'], snare: ['snare', 'clap'], clap: ['clap', 'snare'],
  hatc: ['hat-closed'], hato: ['hat-open', 'cymbal'], perc: ['perc', 'hat-closed', 'snare'], fx: ['snare', 'cymbal', 'perc'],
};

/** Largeur de l'en-tête d'une rangée (nom + M / S / ⋯) sur ordinateur. */
const HEAD_W = 196;
/** Point d'ouverture d'un menu sous un bouton. */
const atEl = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return { clientX: Math.max(8, r.right - 280), clientY: r.bottom + 4 }; };
const QUANT_KEY = 'nova_drum_quantize';

/** Raccourcis de la boîte à rythmes (aussi listés dans le menu ⋯ › Raccourcis). */
export const DRUM_SHORTCUTS: [string, string][] = [
  ['Clic', 'allumer / éteindre un pas'],
  ['Glisser', 'peindre plusieurs pas'],
  ['Maj + clic', 'accent léger ↔ fort'],
  ['Clic droit / appui long', 'réglages du pas (roll, probabilité, décalage, longueur, hauteur, glisse)'],
  ['Clic droit sur un pad', 'menu de la rangée (mute, solo, résolution, nombre de pas…)'],
  ['Double-clic sur un pad', 'éditer le son (sampler)'],
  ['Rangée du milieu du clavier', 'jouer les pads 1 à 10'],
  ['Maj + ← / →', 'décaler la rangée choisie'],
  ['Maj + Alt + ← / →', 'décaler tout le motif'],
  ['Suppr', 'effacer la rangée choisie (Maj + Suppr : tout le motif)'],
  ['Ctrl + C / Ctrl + V', 'copier / coller le motif'],
  ['Ctrl + D', 'dupliquer le motif'],
  ['[ / ]', 'motif précédent / suivant'],
  ['Espace', 'lecture / pause'],
];

/**
 * Boîte à rythmes Make Music (séquenceur de pas pro) : un clic allume un pas, un deuxième l'éteint ;
 * Maj + clic : accent ; glisser : peindre. Clic droit (ou appui long) sur un pas : roll, probabilité,
 * décalage fin, longueur, hauteur, glisse. Clic droit sur un pad : mute / solo, résolution, nombre de
 * pas, swing et décalage de la rangée, étouffement… Les commandes rares sont dans les menus ⋯.
 */
const DrumMachinePanel: React.FC<DrumMachinePanelProps> = (p) => {
  const { simple } = useSimpleMode();
  const [playStep, setPlayStep] = useState(-1);
  const [soundMenu, setSoundMenu] = useState<number | null>(null);
  const [samplerFor, setSamplerFor] = useState<number | null>(null);
  const [menu, setMenu] = useState<DrumMenuState | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const closeMenu = useCallback(() => setMenu(null), []);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Tour beatmaking (22/10/2026) : coup de pinceau sur les pas (souris), comme dans les step sequencers. */
  const strokeRef = useRef<{ on: boolean; painting: boolean; ri: number; si: number; dm: DrumMachine | null } | null>(null);
  useEffect(() => {
    const end = () => { strokeRef.current = null; };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => { window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); };
  }, []);
  // Téléphone : 8 pas par page (1–8 / 9–16) au lieu d'une grille qui défilait
  // sans le dire (7 pas visibles sur 16) ; le pad touché est le pad « choisi ».
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 639px)').matches);
  const [page, setPage] = useState(0);
  const [selPad, setSelPad] = useState(0);
  // Kits NOVA : navigateur ouvert, pad visé par « Poser » (null = nouveau pad).
  const [kitsOpen, setKitsOpen] = useState(false);
  const [kitTarget, setKitTarget] = useState<number | null>(null);
  const [, setKitIxTick] = useState(0);
  useEffect(() => { if (p.kitsSignal) setKitsOpen(true); }, [p.kitsSignal]);
  // Noms des pads « kit:… » (« Kick 12 ») : l'index est chargé dès qu'un pad en utilise un.
  const usesKit = !!p.dm?.rows.some(r => isKitRef(r.sound));
  useEffect(() => { if (usesKit && !kitIndexIfLoaded()) loadKitIndex().then(() => setKitIxTick(n => n + 1)).catch(() => {}); }, [usesKit]);
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

  /** Carte des tempos : seulement si le projet a des changements (sinon le tempo constant, comme le clip). */
  const tempoMap = () => { const m = tempoMapStore.get(); return m && m.segments.length > 1 ? m : null; };

  // Tête de lecture : pas du motif affiché (s'il joue à cet endroit) et mesure du morceau.
  // Léger : la boucle d'affichage ne tourne QUE pendant la lecture (rien à l'arrêt).
  const [playBar, setPlayBar] = useState(-1);
  // R18 : position fine (rangées en 1/32, triolets, longueurs propres).
  const [playW, setPlayW] = useState<{ pos16: number; runBars: number } | null>(null);
  useEffect(() => {
    if (!p.open || !p.dm || !p.isPlaying) { setPlayStep(-1); setPlayBar(-1); setPlayW(null); return; }
    let raf = 0;
    const dmP = ensurePatterns(p.dm);
    const map = tempoMap();
    const tick = () => {
      const w = whereAt(dmP, p.bpm, audioEngine.getCurrentTime() - p.clipStart, map);
      const here = !!w && w.patternId === dmP.activePattern;
      setPlayStep(here ? w!.step : -1);
      setPlayW(prev => (here ? (prev && Math.floor(prev.pos16 * 6) === Math.floor(w!.pos16 * 6) ? prev : { pos16: w!.pos16, runBars: w!.runBars }) : null));
      setPlayBar(w ? w.bar : -1);
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
  // Enregistrement en direct : les pads frappés pendant la lecture s'écrivent dans le motif affiché.
  const [rec, setRec] = useState(false);
  const [quantize, setQuantize] = useState(() => { try { return localStorage.getItem(QUANT_KEY) !== '0'; } catch { return true; } });
  const setQuant = (q: boolean) => { setQuantize(q); try { localStorage.setItem(QUANT_KEY, q ? '1' : '0'); } catch { /* */ } };
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
  // Dernier état connu (plusieurs frappes avant le rendu suivant pendant l'enregistrement).
  const dmRef = useRef(p.dm);
  dmRef.current = p.dm;
  const liveRef = useRef<{ rec: boolean; quantize: boolean; playing: boolean; bpm: number; clipStart: number; sel: number }>({ rec, quantize, playing: p.isPlaying, bpm: p.bpm, clipStart: p.clipStart, sel: selPad });
  liveRef.current = { rec, quantize, playing: p.isPlaying, bpm: p.bpm, clipStart: p.clipStart, sel: selPad };
  /** Coup sur un pad : pré-écoute, roulement, éclair ; en enregistrement pendant la lecture, le pas est écrit. */
  const hitPad = (ri: number) => {
    p.onAudition(ri);
    const L = liveRef.current;
    const d = dmRef.current;
    if (!L.rec || !L.playing || !d) return;
    const out = audioEngine.videoSyncInfo?.()?.outputSide || 0;
    const t = audioEngine.getCurrentTime() - out - L.clipStart;
    const map = tempoMap();
    const abs16 = map ? timeToQuarters(map, Math.max(0, t)) * 4 : t / (60 / L.bpm / 4);
    const next = recordHit(d, ri, abs16, L.quantize);
    dmRef.current = next;
    p.onChange(next);
  };
  const hitRef = useRef(hitPad);
  hitRef.current = hitPad;
  const visibleRows = (d: DrumMachine) => d.rows.map((r, ri) => ({ r, ri })).filter(({ r }) => r.id !== '808' || r.steps.some(v => v > 0)).map(x => x.ri);
  useEffect(() => {
    if (!p.open || !keysOn || !p.dm) return;
    const visible = visibleRows(p.dm);
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector('[data-testid=drum-menu]')) return;
      const k = padIndexForCode(e.code, visible.length);
      if (k < 0) return;
      // Le pad prend la touche (sinon R = enregistrer, L = boucle…).
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat) return;
      const ri = visible[k];
      hitRef.current(ri);
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

  // Raccourcis d'édition (focus dans la batterie) : décaler, effacer, copier / coller, dupliquer, motif suivant.
  const changeRef = useRef(p.onChange);
  changeRef.current = p.onChange;
  const notifyRef = useRef(p.notify);
  notifyRef.current = p.notify;
  useEffect(() => {
    if (!p.open) return;
    const onKey = (e: KeyboardEvent) => {
      const d = dmRef.current;
      if (!d || isTypingTarget(e.target) || document.querySelector('[data-testid=drum-menu]')) return;
      if (!rootRef.current?.contains(document.activeElement)) return;
      const mod = e.ctrlKey || e.metaKey;
      const ri = Math.min(liveRef.current.sel, d.rows.length - 1);
      const dP = ensurePatterns(d);
      const pats = dP.patterns!;
      const ai = pats.findIndex(x => x.id === dP.activePattern);
      let next: DrumMachine | null = null;
      let msg = '';
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyC') { copyPattern(d); msg = `Motif ${pats[ai]?.name || ''} copié : Ctrl+V pour le coller dans un autre motif.`; }
      else if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyV') { next = paste(d, ri); if (!next) msg = 'Rien à coller : copie d\'abord un motif (Ctrl+C) ou une rangée (clic droit sur un pad).'; }
      else if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyD') next = duplicatePattern(d, dP.activePattern!);
      else if (!mod && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { const dir = e.key === 'ArrowRight' ? 1 : -1; next = e.altKey ? rotatePattern(d, dir) : rotateRow(d, ri, dir); }
      else if (!mod && !e.altKey && (e.key === 'Delete' || e.key === 'Backspace')) next = e.shiftKey ? clearPattern(d) : clearRow(d, ri);
      else if (!mod && !e.altKey && (e.key === '[' || e.key === ']') && pats.length > 1) next = selectPattern(d, pats[(ai + (e.key === ']' ? 1 : -1) + pats.length) % pats.length].id);
      else if (!mod && e.key === '?') { setHelpOpen(v => !v); }
      else return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (next) { dmRef.current = next; changeRef.current(next); }
      if (msg) notifyRef.current?.(msg);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [p.open]);

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
        if (!r) { p.notify?.(`${MAX_PADS} pads au plus : pose ton son sur un pad existant (clic droit sur le pad → « Son et mix »).`); break; }
        cur = r.dm; last = r.rowIndex;
      }
      if (last < 0) return;
      p.onChange(cur);
      setSelPad(last);
      if (samplerFor === null) setSoundMenu(last);
      window.setTimeout(() => p.onAudition(last), 200);
      p.notify?.(`🥁 ${audio.length > 1 && rowIndex === null ? `${audio.length} sons ajoutés` : `« ${cur.rows[last].name} » posé`} sur ${rowIndex === null ? 'de nouveaux pads' : 'le pad'} : allume ses pas dans la grille. Annuler (Ctrl+Z) pour revenir.`);
    } catch {
      p.notify?.('Ce fichier ne se lit pas : essaie un WAV, MP3, AIFF ou FLAC.');
    }
  };
  /** Kits NOVA : son posé sur un pad (ou un nouveau pad). Une seule étape d'annulation. */
  const pickKitSound = (id: string, rowIndex: number | null, ix: KitIndex | null) => {
    const r = setPadKitSound(p.dm || makeDrumMachine('empty'), id, rowIndex, ix);
    if (!r) { p.notify?.(`${MAX_PADS} pads au plus : choisis un pad existant dans « Poser sur ».`); return; }
    p.onChange(r.dm);
    setSelPad(r.rowIndex);
    window.setTimeout(() => p.onAudition(r.rowIndex), 120);
    p.notify?.(`🥁 « ${r.dm.rows[r.rowIndex].name} » posé sur ${rowIndex === null ? 'un nouveau pad' : 'le pad'} : allume ses pas dans la grille. Annuler (Ctrl+Z) pour revenir.`);
  };
  const applyNovaKit = (kit: KitDef, ix: KitIndex) => {
    const next = applyKitDef(p.dm || makeDrumMachine('empty'), kit, ix);
    p.onChange(next);
    setSelPad(0); setKitTarget(null);
    p.notify?.(`🥁 Kit « ${kit.name} » chargé sur ${next.rows.length} pads${p.dm?.rows.some(r => r.steps.some(v => v > 0)) ? ' (tes pas sont gardés)' : ''}${typeof p.projectKey === 'number' ? ', 808 accordée sur la tonique' : ''}. Annuler (Ctrl+Z) pour revenir.`);
  };
  const onDropFiles = (e: React.DragEvent, rowIndex: number | null) => {
    const kitId = e.dataTransfer?.getData(KIT_DRAG_TYPE);
    if (kitId) { e.preventDefault(); e.stopPropagation(); pickKitSound(kitId, rowIndex, kitIndexIfLoaded()); return; }
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); e.stopPropagation();
    void importFiles(Array.from(e.dataTransfer.files), rowIndex);
  };
  const allowDrop = (e: React.DragEvent) => { const t = Array.from(e.dataTransfer?.types || []); if (t.includes('Files') || t.includes(KIT_DRAG_TYPE)) e.preventDefault(); };
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
  /** Clic : allumé ↔ éteint. Maj + clic : accent léger ↔ fort (un pas éteint s'allume en léger). */
  const toggleStep = (ri: number, si: number, accent = false) => editRow(ri, r => {
    const v = r.steps[si];
    r.steps[si] = accent ? (v > 0 && v < 100 ? 110 : 70) : v === 0 ? 110 : 0;
    if (r.steps[si] === 0) r.ratchet[si] = 1;
    return r;
  });
  /** Pinceau : pose l'état du coup (allumé / éteint) sur un pas, sans relire des props pas encore à jour. */
  const paintStep = (ri: number, si: number) => {
    const s = strokeRef.current;
    if (!s?.dm) return;
    const row = s.dm.rows[ri];
    if (!row || si >= row.steps.length) return;
    const v = row.steps[si] || 0;
    if (s.on ? v > 0 : v === 0) return;
    const steps = [...row.steps]; const ratchet = [...row.ratchet];
    steps[si] = s.on ? 110 : 0;
    if (!s.on) ratchet[si] = 1;
    s.dm = { ...s.dm, rows: s.dm.rows.map((x, i) => (i === ri ? { ...x, steps, ratchet } : x)) };
    p.onChange(s.dm);
  };
  const stepDown = (e: React.PointerEvent, ri: number, si: number) => {
    if (e.button === 2) return;
    startPress(e, ri, si);
    strokeRef.current = e.pointerType === 'mouse' && e.button === 0 && dm ? { on: !(dm.rows[ri]?.steps[si] > 0), painting: false, ri, si, dm } : null;
  };
  const stepEnter = (e: React.PointerEvent, ri: number, si: number) => {
    const s = strokeRef.current;
    if (!s || !(e.buttons & 1)) return;
    if (!s.painting) {
      s.painting = true;
      if (pressTimer.current) window.clearTimeout(pressTimer.current);
      paintStep(s.ri, s.si);
    }
    paintStep(ri, si);
  };
  const stepUp = (e: React.PointerEvent, ri: number, si: number) => {
    if (e.button === 2) return;
    const s = strokeRef.current;
    strokeRef.current = null;
    if (s?.painting) return;
    endPress(ri, si, e.shiftKey);
  };

  /** Appui long (doigt) : le menu du pas, comme le clic droit. */
  const startPress = (e: React.PointerEvent, ri: number, si: number) => {
    longPressed.current = false;
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    const at = { clientX: e.clientX, clientY: e.clientY };
    pressTimer.current = window.setTimeout(() => { longPressed.current = true; strokeRef.current = null; openStepMenu(at, ri, si); }, 450);
  };
  const endPress = (ri: number, si: number, accent = false) => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    if (!longPressed.current) toggleStep(ri, si, accent);
  };

  // ── Menus (clic droit, appui long, ⋯) ──────────────────────────────────────────────
  const setParam = (ri: number, si: number, param: StepParam, v: number) => {
    const d = dmRef.current;
    if (!d) return;
    let next = d;
    // Un réglage sur un pas éteint l'allume (comme dans les autres séquenceurs).
    if (param !== 'vel' && !(next.rows[ri]?.steps[si] > 0)) next = { ...next, rows: next.rows.map((r, i) => (i === ri ? { ...r, steps: r.steps.map((x, k) => (k === si ? 110 : x)) } : r)) };
    next = setStepParam(next, ri, si, param, v);
    dmRef.current = next;
    p.onChange(next);
  };
  const stepMenuItems = (ri: number, si: number): DrumMenuItem[] => {
    const d = dmRef.current;
    const r = d?.rows[ri];
    if (!d || !r) return [];
    const v = r.steps[si] || 0;
    const roll = r.ratchet[si] || 1;
    const cellMs = (60 / p.bpm / 4) * (STEPS_PER_BAR / rowStepsPerBar(r)) * 1000;
    const val = (k: StepParam) => stepParamOf(r, si, k);
    const refresh = () => setMenu(m => (m ? { ...m, items: stepMenuItems(ri, si) } : m));
    const pick = (k: StepParam) => (x: string | number) => { setParam(ri, si, k, Number(x)); window.setTimeout(refresh, 0); };
    return [
      { kind: 'choices', label: 'Force', value: v >= 100 ? 110 : v > 0 ? 70 : 0, testId: 'step-vel', options: [{ label: 'Éteint', value: 0 }, { label: 'Léger', value: 70 }, { label: 'Fort', value: 110 }, { label: 'Max', value: 127 }],
        onPick: x => { const n = Number(x); const dd = dmRef.current!; const next = { ...dd, rows: dd.rows.map((row, i) => (i === ri ? { ...row, steps: row.steps.map((s0, k) => (k === si ? n : s0)), ratchet: n ? row.ratchet : row.ratchet.map((q, k) => (k === si ? 1 : q)) } : row)) }; dmRef.current = next; p.onChange(next); window.setTimeout(refresh, 0); } },
      { kind: 'choices', label: 'Roll (répétitions dans le pas)', value: roll, testId: 'step-roll', options: [1, 2, 3, 4].map(n => ({ label: n === 1 ? 'Non' : `×${n}`, value: n })),
        onPick: x => { const n = Number(x); const dd = dmRef.current!; const next = { ...dd, rows: dd.rows.map((row, i) => (i === ri ? { ...row, steps: row.steps.map((s0, k) => (k === si && !s0 ? 90 : s0)), ratchet: row.ratchet.map((q, k) => (k === si ? n : q)) } : row)) }; dmRef.current = next; p.onChange(next); window.setTimeout(refresh, 0); } },
      { kind: 'choices', label: 'Probabilité de jouer', value: val('prob'), testId: 'step-prob', options: [100, 75, 50, 25, 10].map(n => ({ label: `${n} %`, value: n })), onPick: pick('prob') },
      { kind: 'choices', label: `Décalage fin (1 pas = ${Math.round(cellMs)} ms à ${Math.round(p.bpm)} BPM)`, value: val('nudge'), testId: 'step-nudge',
        options: [-25, -10, 0, 10, 25].map(n => ({ label: n === 0 ? 'Calé' : `${n > 0 ? '+' : '−'}${Math.round(Math.abs(n) * cellMs / 100)} ms`, value: n, hint: `${n > 0 ? '+' : ''}${n} % d'un pas` })), onPick: pick('nudge') },
      { kind: 'choices', label: 'Longueur de la note', value: val('gate'), testId: 'step-gate', options: [{ label: 'Son entier', value: 0 }, { label: '½ pas', value: 0.5 }, { label: '1 pas', value: 1 }, { label: '2 pas', value: 2 }, { label: '4 pas', value: 4 }, { label: '8 pas', value: 8 }], onPick: pick('gate') },
      { kind: 'choices', label: 'Hauteur (demi-tons)', value: val('pitch'), testId: 'step-pitch', options: [-12, -7, -5, -2, 0, 2, 3, 5, 7, 12].map(n => ({ label: n === 0 ? '0' : `${n > 0 ? '+' : '−'}${Math.abs(n)}`, value: n })), onPick: pick('pitch') },
      { label: 'Glisse depuis le coup précédent', checked: val('glide') > 0, hint: 'La hauteur glisse depuis le coup précédent du pad (808, percus accordées). Temps de glisse : sampler du pad › Hauteur.', testId: 'step-glide',
        onClick: () => { setParam(ri, si, 'glide', val('glide') > 0 ? 0 : 1); window.setTimeout(refresh, 0); }, keepOpen: true },
      { kind: 'sep' },
      { label: 'Éditer le son du pad…', icon: 'fa-wave-square', onClick: () => openSampler(ri) },
    ];
  };
  const openStepMenu = (e: { clientX: number; clientY: number }, ri: number, si: number) => {
    const r = dmRef.current?.rows[ri];
    if (!r) return;
    setSelPad(ri);
    setMenu(menuAt(e, `${r.name} · pas ${si + 1}`, stepMenuItems(ri, si)));
  };
  const openSampler = (ri: number) => { setSoundMenu(null); setSelPad(ri); setSamplerFor(ri); };
  const rowMenuItems = (ri: number): DrumMenuItem[] => {
    const d = dmRef.current;
    const r = d?.rows[ri];
    if (!d || !r) return [];
    const spb = rowStepsPerBar(r);
    const full = spb * (d.bars || 1);
    const len = r.len && r.len > 0 ? r.len : full;
    const edit = (patch: Partial<DrumRow>) => { const dd = dmRef.current!; const next = { ...dd, rows: dd.rows.map((x, i) => (i === ri ? { ...x, ...patch } : x)) }; dmRef.current = next; p.onChange(next); };
    const apply = (next: DrumMachine | null) => { if (!next) return; dmRef.current = next; p.onChange(next); };
    const refresh = () => window.setTimeout(() => setMenu(m => (m ? { ...m, items: rowMenuItems(ri) } : m)), 0);
    const counts = [12, 16, 24, 32, 48, 64].filter(n => n <= spb * 8);
    const stepMs = (60 / p.bpm / 4) * 1000;
    return [
      { label: 'Éditer le son (sampler)…', icon: 'fa-wave-square', kbd: 'Double-clic', onClick: () => openSampler(ri), testId: 'row-edit-sound' },
      { label: 'Son et mix du pad…', icon: 'fa-sliders-h', onClick: () => { setSamplerFor(null); setSoundMenu(ri); setSelPad(ri); } },
      { kind: 'sep' },
      { label: 'Muet (mute)', checked: !!r.muted, onClick: () => { edit({ muted: !r.muted }); refresh(); }, keepOpen: true, testId: 'row-mute' },
      { label: 'Solo', checked: !!r.solo, onClick: () => { edit({ solo: !r.solo }); refresh(); }, keepOpen: true, testId: 'row-solo' },
      { kind: 'node', node: <QuickMix row={r} onEdit={edit} /> },
      { kind: 'choices', label: 'Résolution de la rangée', value: r.rate || '16', testId: 'row-rate', options: STEP_RATES.map(x => ({ label: x.label, value: x.id, hint: x.hint })),
        onPick: x => { apply(setRowRate(dmRef.current!, ri, x as StepRate)); refresh(); } },
      { kind: 'choices', label: `Nombre de pas (polymétrie) : ${len}`, value: r.len && r.len > 0 ? r.len : 0, testId: 'row-steps',
        options: [{ label: 'Motif', value: 0, hint: 'La rangée suit la longueur du motif' }, ...counts.map(n => ({ label: String(n), value: n }))],
        onPick: x => { apply(setRowLength(dmRef.current!, ri, Number(x))); refresh(); } },
      { kind: 'choices', label: 'Swing de la rangée', value: typeof r.swing === 'number' ? r.swing : -1, testId: 'row-swing',
        options: [{ label: 'Global', value: -1 }, ...[0, 0.15, 0.3, 0.45, 0.6].map(s => ({ label: `${Math.round(s * 100)} %`, value: s }))],
        onPick: x => { const v = Number(x); edit({ swing: v < 0 ? undefined : v }); refresh(); } },
      { kind: 'choices', label: 'Décalage de toute la rangée', value: r.shift || 0, testId: 'row-shift',
        options: [-20, -10, -5, 0, 5, 10, 20].map(n => ({ label: n === 0 ? 'Calée' : `${n > 0 ? '+' : '−'}${(Math.abs(n) * stepMs / 100).toFixed(1).replace('.', ',')} ms`, value: n, hint: `${n > 0 ? 'En retard' : n < 0 ? 'En avance' : 'Sur la grille'} de ${Math.abs(n)} % d'une double-croche` })),
        onPick: x => { const v = Number(x); edit({ shift: v || undefined }); refresh(); } },
      { kind: 'choices', label: 'Groupe d\'étouffement (un pad du groupe coupe les autres)', value: r.choke || 0, testId: 'row-choke',
        options: [{ label: 'Aucun', value: 0 }, ...[1, 2, 3, 4].map(n => ({ label: String(n), value: n, hint: n === 1 ? 'Groupe des hi-hats' : undefined }))],
        onPick: x => { edit({ choke: Number(x) || undefined }); refresh(); } },
      { kind: 'sep' },
      { label: 'Décaler la rangée vers la gauche', icon: 'fa-arrow-left', kbd: 'Maj+←', onClick: () => apply(rotateRow(dmRef.current!, ri, -1)), keepOpen: true },
      { label: 'Décaler la rangée vers la droite', icon: 'fa-arrow-right', kbd: 'Maj+→', onClick: () => apply(rotateRow(dmRef.current!, ri, 1)), keepOpen: true },
      { label: 'Inverser la rangée', icon: 'fa-right-left', onClick: () => apply(reverseRow(dmRef.current!, ri)) },
      { kind: 'choices', label: 'Remplir : un coup tous les…', value: '', options: [2, 3, 4, 8].map(n => ({ label: `${n} pas`, value: n })), onPick: x => apply(fillEvery(dmRef.current!, ri, Number(x))) },
      { label: 'Copier la rangée', icon: 'fa-copy', onClick: () => { copyRow(dmRef.current!, ri); p.notify?.(`Rangée « ${r.name} » copiée : clic droit sur un autre pad › Coller.`); } },
      { label: 'Coller sur cette rangée', icon: 'fa-paste', kbd: 'Ctrl+V', disabled: !clipboard(), onClick: () => apply(paste(dmRef.current!, ri)) },
      { label: 'Effacer la rangée', icon: 'fa-eraser', kbd: 'Suppr', onClick: () => apply(clearRow(dmRef.current!, ri)) },
      ...(d.rows.length > 1 ? [{ label: 'Retirer le pad', icon: 'fa-trash', danger: true, onClick: () => { apply(removePad(dmRef.current!, ri)); setSelPad(0); setSamplerFor(null); setSoundMenu(null); } } as DrumMenuItem] : []),
    ];
  };
  const openRowMenu = (e: { clientX: number; clientY: number }, ri: number) => {
    const r = dmRef.current?.rows[ri];
    if (!r) return;
    setSelPad(ri);
    setMenu(menuAt(e, `Pad « ${r.name} »`, rowMenuItems(ri)));
  };
  const panelMenu = (el: HTMLElement) => setMenu(menuUnder(el, 'Batterie', [
    { label: 'Métronome', checked: !!p.metronomeOn, onClick: () => p.onToggleMetronome?.(), disabled: !p.onToggleMetronome, testId: 'drum-metronome' },
    { label: 'Enregistrement quantifié (calé sur la grille)', checked: quantize, onClick: () => setQuant(!quantize), testId: 'drum-quantize',
      hint: 'Coché : chaque coup enregistré tombe sur le pas le plus proche. Décoché : le décalage fin garde ton jeu.' },
    { kind: 'sep' },
    { label: 'Découper une boucle sur les pads…', icon: 'fa-cut', onClick: () => setChop('new') },
    { label: 'Ajouter un pad avec ton son…', icon: 'fa-plus', disabled: !!dm && dm.rows.length >= MAX_PADS, onClick: () => padFileRef.current?.click() },
    ...(sliceCount > 1 ? [{ label: 'Remixer les tranches', icon: 'fa-dice', onClick: () => dm && p.onChange(reorderSlices(dm, shuffledOrder(sliceCount, Date.now()))) } as DrumMenuItem] : []),
    ...(!narrow && dm ? [{ label: 'Jouer les pads au clavier', checked: keysOn, onClick: () => setKeysOn(v => !v) } as DrumMenuItem] : []),
    { label: 'Raccourcis clavier', icon: 'fa-keyboard', kbd: '?', onClick: () => setHelpOpen(true) },
    { kind: 'sep' },
    ...(dm ? [{ label: 'Retirer la batterie', icon: 'fa-trash', danger: true, onClick: p.onRemove } as DrumMenuItem] : []),
  ]));

  const len = dm ? 16 * dm.bars : 16;
  // Largeur d'un pas 1/16 sur ordinateur (w-8 + gap-1 ; tablette au doigt : w-9 + gap-1).
  const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  const step16Px = coarse ? 44 : 36;
  // Tablette (au doigt) : en-tête de rangée = nom + ⋯ (mute / solo dans le menu du pad), cibles de 44 px.
  const headW = coarse ? 156 : HEAD_W;
  const pages = len / 8;
  const curPage = Math.min(page, pages - 1);
  const shownSteps = narrow ? Array.from({ length: 8 }, (_, i) => curPage * 8 + i) : Array.from({ length: len }, (_, i) => i);
  const pad = dm?.rows[Math.min(selPad, (dm?.rows.length || 1) - 1)];
  // Ancienne rangée 808 (projets d'avant la piste 808) : visible tant qu'elle joue.
  const shownRows = dm ? dm.rows.map((r, ri) => ({ r, ri })).filter(({ r }) => r.id !== '808' || r.steps.some(v => v > 0)) : [];
  const recOn = rec && p.isPlaying;

  /** Repères d'un pas allumé : force (hauteur du remplissage), roll, probabilité, décalage, longueur, hauteur, glisse. */
  const stepMarks = (r: DrumRow, si: number, v: number, roll: number) => {
    if (v <= 0) return null;
    const prob = r.stepProb?.[si] ?? 100;
    const nudge = r.stepNudge?.[si] || 0;
    const gate = r.stepGate?.[si] || 0;
    const pitch = r.stepPitch?.[si] || 0;
    const glide = (r.stepGlide?.[si] || 0) > 0;
    return (
      <>
        <span className={`absolute inset-x-0 bottom-0 rounded-[3px] pointer-events-none ${v >= 100 ? 'bg-cyan-400' : 'bg-cyan-300/80'}`} style={{ height: `${Math.max(18, (v / 127) * 100)}%`, opacity: prob < 100 ? 0.35 + (prob / 100) * 0.65 : 1 }} />
        {gate > 0 && <span className="absolute left-0 top-0.5 h-[3px] rounded-full bg-amber-300 pointer-events-none z-[1]" style={{ width: `calc(${gate * 100}% + ${(gate - 1) * 4}px)` }} />}
        {nudge !== 0 && <span className="absolute bottom-0.5 w-[2px] h-2 bg-black/70 pointer-events-none" style={{ left: `calc(${50 + nudge}% - 1px)` }} />}
        {prob < 100 && <span className="absolute top-0.5 left-0.5 text-[8px] leading-none font-black text-black pointer-events-none">{prob}</span>}
        {glide && <span className="absolute top-0 right-0.5 text-[9px] leading-none font-black text-black pointer-events-none">↗</span>}
        {pitch !== 0 && <span className="absolute bottom-0.5 left-0.5 text-[8px] leading-none font-black text-black pointer-events-none">{pitch > 0 ? '+' : ''}{pitch}</span>}
        {roll > 1 && <span className="absolute inset-0 flex items-center justify-center text-[10px] font-black text-black pointer-events-none">×{roll}</span>}
      </>
    );
  };
  const stepLabel = (r: DrumRow, si: number, v: number, roll: number) => {
    if (!v) return '';
    const bits = [roll > 1 ? `roll ×${roll}` : 'actif'];
    if (v < 100) bits.push('léger');
    const prob = r.stepProb?.[si] ?? 100; if (prob < 100) bits.push(`${prob} %`);
    const n = r.stepNudge?.[si] || 0; if (n) bits.push(`décalé ${n > 0 ? '+' : ''}${n} %`);
    const g = r.stepGate?.[si] || 0; if (g) bits.push(`${g} pas`);
    const h = r.stepPitch?.[si] || 0; if (h) bits.push(`${h > 0 ? '+' : ''}${h} dt`);
    if ((r.stepGlide?.[si] || 0) > 0) bits.push('glisse');
    return `, ${bits.join(', ')}`;
  };

  /**
   * Case d'un pas. Le bouton est la cible (au téléphone : collées, sans zone morte entre deux pas) ;
   * la case visible est dedans (écart visuel de 2 px). Tablette : 40 × 44 px ; téléphone : toute la largeur / 8 × 44 px.
   */
  const stepCell = (r: DrumRow, ri: number, si: number, playing: boolean, beat: boolean, off: boolean, scaled: boolean) => {
    const v = r.steps[si] || 0;
    const roll = r.ratchet[si] || 1;
    const size = narrow || scaled ? `flex-1 min-w-0 ${narrow ? 'h-11' : coarse ? 'h-11' : 'h-9'}` : coarse ? 'shrink-0 w-10 h-11' : 'shrink-0 w-8 h-9';
    return (
      <button key={si} type="button" disabled={off} data-own-longpress=""
        aria-label={`${r.name}, pas ${si + 1}${off ? ' (hors de la longueur de la rangée)' : stepLabel(r, si, v, roll)}`}
        onPointerDown={e => stepDown(e, ri, si)} onPointerUp={e => stepUp(e, ri, si)} onPointerEnter={e => stepEnter(e, ri, si)}
        onPointerLeave={() => { if (pressTimer.current) window.clearTimeout(pressTimer.current); }}
        onContextMenu={e => { e.preventDefault(); if (!off) openStepMenu(e, ri, si); }}
        className={`relative ${size} ${off ? 'opacity-40' : ''}`}>
        <span className={`absolute ${narrow || scaled ? 'inset-[1px]' : 'inset-0'} rounded-md overflow-visible transition-colors ${playing ? 'ring-2 ring-white/70' : ''} ${
          off ? 'bg-white/[0.015]' : v > 0 ? (scaled ? 'bg-violet-400/25' : 'bg-cyan-400/25') : beat ? 'bg-white/[0.09]' : 'bg-white/[0.04]'}`}>
          {!off && stepMarks(r, si, v, roll)}
        </span>
      </button>
    );
  };

  // Ordinateur : panneau en bas, sans fond qui bloque (la barre de transport
  // reste cliquable). Téléphone : feuille plein écran avec fond.
  // data-nova-transport : la barre d'espace lance / coupe la lecture (App.tsx).
  return (
    <div data-nova-transport="" className={narrow
      ? 'fixed inset-0 z-[560] flex items-end justify-center bg-black/50'
      : 'fixed inset-x-0 bottom-0 z-[560] flex justify-center px-4 pb-3 pointer-events-none'}
      onClick={narrow ? p.onClose : undefined} role="dialog" aria-modal={narrow ? 'true' : undefined} aria-labelledby="drums-title"
      onDragOver={allowDrop} onDrop={e => onDropFiles(e, null)}>
      <div ref={rootRef} className={`w-full flex flex-col bg-nv-surface border border-white/[0.06] shadow-2xl pb-[env(safe-area-inset-bottom)] pointer-events-auto ${narrow ? 'max-h-[92vh] rounded-t-3xl' : 'max-w-4xl max-h-[min(80vh,760px)] rounded-3xl shadow-black/60'}`} onClick={e => e.stopPropagation()}>
        {/* En-tête : seules les commandes de chaque instant ; le reste est dans ⋯ */}
        <div className="flex items-center gap-2 px-4 pt-4 pb-3 border-b border-white/5">
          <h2 id="drums-title" className="text-[16px] font-black text-white mr-auto whitespace-nowrap min-w-0 truncate">🥁 Batterie <span className="hidden sm:inline text-slate-400 font-bold text-[12px]">Make Music</span></h2>
          {/* Ordinateur : bouton dans l'en-tête. Téléphone : grand bouton en haut du panneau (en-tête trop étroit). */}
          {!narrow && (
            <button type="button" onClick={() => setKitsOpen(v => !v)} aria-expanded={kitsOpen} data-testid="open-kits"
              title="Kits NOVA : des kits prêts à jouer et ~2 000 sons (kicks, snares, 808, percus…) à écouter puis poser sur les pads"
              className={`h-10 px-3 rounded-xl whitespace-nowrap text-[12px] font-black ${kitsOpen ? 'bg-cyan-500 text-black' : 'bg-white/[0.06] text-slate-200 hover:bg-white/10'}`}>
              <i className={`fas fa-layer-group ${kitsOpen ? '' : 'text-cyan-400'} mr-1.5`} aria-hidden />Kits
            </button>
          )}
          {p.onOpen808 && (
            <button type="button" onClick={p.onOpen808} title="Basse 808 : joue-la au piano roll, accordée sur la tonalité, avec glissés"
              className={`shrink-0 h-10 ${narrow ? 'px-2' : 'px-3'} rounded-xl whitespace-nowrap text-[12px] font-black bg-white/[0.06] text-slate-200 hover:bg-white/10`}>
              <i className="fas fa-wave-square mr-1.5 text-fuchsia-400" aria-hidden />808{p.has808 ? '' : ' +'}
            </button>
          )}
          {dm && !simple && (
            <button type="button" aria-pressed={rec} data-testid="drum-rec"
              onClick={() => { const on = !rec; setRec(on); if (on && !p.isPlaying) p.onTogglePlay(); if (on) p.notify?.(`● Enregistrement : frappe les pads (clavier ou clic) pendant la lecture, ils s'écrivent dans le motif affiché${quantize ? ', calés sur la grille' : ', avec ton décalage'}.`); }}
              title="Enregistrer en direct : les pads frappés pendant la lecture s'écrivent dans le motif affiché (⋯ › Enregistrement quantifié)"
              className={`shrink-0 h-10 ${narrow ? 'w-10' : 'px-3'} rounded-xl text-[12px] font-black whitespace-nowrap ${recOn ? 'bg-red-500 text-white animate-pulse' : rec ? 'bg-red-500/80 text-white' : 'bg-white/[0.06] text-slate-200 hover:bg-white/10'}`}>
              <i className={`fas fa-circle ${rec ? '' : 'text-red-400'}`} aria-hidden /><span className="hidden sm:inline ml-1.5">Enr.</span>
            </button>
          )}
          {dm && (
            <button type="button" onClick={p.onTogglePlay} aria-label={p.isPlaying ? 'Pause' : 'Écouter'} className={`shrink-0 h-10 ${narrow ? 'w-11' : 'px-4'} rounded-xl text-[12px] font-black ${p.isPlaying ? 'bg-white text-black' : 'bg-cyan-500 text-black'}`}>
              <i className={`fas ${p.isPlaying ? 'fa-pause' : 'fa-play'} ${narrow ? '' : 'mr-1.5'}`} />{narrow ? '' : p.isPlaying ? 'Pause' : 'Écouter'}
            </button>
          )}
          <button type="button" onClick={e => panelMenu(e.currentTarget)} aria-label="Plus d'options de la batterie" aria-haspopup="menu" data-testid="drum-more"
            className="shrink-0 w-10 h-10 rounded-xl bg-white/[0.06] text-slate-200 hover:bg-white/10"><i className="fas fa-ellipsis" aria-hidden /></button>
          <button type="button" onClick={p.onClose} aria-label="Fermer la batterie" title="Fermer (Échap)" className="shrink-0 w-10 h-10 rounded-xl bg-white/[0.06] text-slate-300 hover:text-white"><i className="fas fa-times" /></button>
        </div>

        <div className={`overflow-y-auto ${narrow ? 'px-3' : 'px-4'} py-3 space-y-3`}>
          {/* Kits */}
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Style de batterie">
            {DRUM_KITS.map(k => (
              <button key={k.id} type="button" onClick={() => p.onKit(k.id)} aria-pressed={dm?.kitId === k.id}
                className={`nova-hit-tactile shrink-0 h-9 px-3 rounded-xl text-[12px] font-bold ${dm?.kitId === k.id ? 'bg-cyan-500/15 text-white ring-1 ring-cyan-400/70' : 'bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] hover:text-white'}`}>
                {k.emoji} {k.name}
              </button>
            ))}
          </div>

          {narrow && !kitsOpen && (
            <button type="button" onClick={() => setKitsOpen(true)} aria-expanded={false} data-testid="open-kits"
              className="w-full h-12 rounded-2xl border border-cyan-400/40 bg-cyan-500/10 text-left px-4 flex items-center gap-3">
              <i className="fas fa-layer-group text-cyan-300" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-black text-white">Kits NOVA</span>
                <span className="block text-[11px] text-slate-300 truncate">Kits prêts à jouer et ~2 000 sons à écouter</span>
              </span>
              <i className="fas fa-chevron-right text-slate-400" aria-hidden />
            </button>
          )}
          {kitsOpen && (
            <DrumKitBrowser dm={dm} targetPad={kitTarget} onTargetPad={setKitTarget} bpm={p.bpm} projectKey={p.projectKey}
              onApplyKit={applyNovaKit} onPickSound={pickKitSound} onClose={() => setKitsOpen(false)}
              ensureEngine={p.ensureEngine} notify={p.notify} narrow={narrow} />
          )}

          {!simple && <KitBar dm={dm} onChange={p.onChange} ensureEngine={p.ensureEngine} notify={p.notify} narrow={narrow} />}

          <input ref={padFileRef} type="file" multiple accept="audio/*,.wav,.mp3,.aif,.aiff,.flac,.ogg,.m4a" className="hidden"
            onChange={e => { const fs = Array.from(e.target.files || []); e.target.value = ''; if (fs.length) void importFiles(fs, null); }} />
          {chop && (
            <ChopPanel dm={dm} onChange={p.onChange} onClose={() => setChop(null)} bpm={p.bpm} sessionClips={p.sessionClips || []}
              ensureEngine={p.ensureEngine || (async () => {})} initial={chop === 'new' ? null : chop} notify={p.notify} />
          )}

          {!dm ? (
            <div className="space-y-2">
              <p className="text-sm text-slate-300">Choisis un style de batterie : elle se cale sur le tempo et la tonalité du projet.</p>
              <button type="button" onClick={() => padFileRef.current?.click()}
                className="w-full rounded-2xl border-2 border-dashed border-white/15 hover:border-cyan-400/60 px-4 py-4 text-[13px] font-bold text-slate-200">
                <i className="fas fa-file-import mr-2" />Ou commence avec TES sons : choisis ou glisse ici tes fichiers audio (un pad par son)
              </button>
            </div>
          ) : (
            <>
              <DrumPatternBar dm={dm} onChange={p.onChange} bpm={p.bpm} loopEnd={p.loopEnd || 0} markers={p.markers} playBar={playBar}
                simple={simple} narrow={narrow} notify={p.notify} />

              {/* Téléphone : choix de la moitié de mesure + réglages du pad choisi */}
              {narrow && (
                <div className="flex items-center gap-2">
                  <div className="flex min-w-0 shrink overflow-x-auto no-scrollbar rounded-xl border border-white/10" role="group" aria-label="Pas affichés">
                    {Array.from({ length: pages }, (_, pi) => (
                      <button key={pi} type="button" onClick={() => setPage(pi)} aria-pressed={curPage === pi}
                        aria-label={`Pas ${pi * 8 + 1} à ${pi * 8 + 8}`}
                        className={`relative h-11 min-w-[48px] px-2 text-[12px] font-black tabular-nums ${curPage === pi ? 'bg-white text-black' : 'bg-white/5 text-white'}`}>
                        {pi * 8 + 1}–{pi * 8 + 8}
                        {/* Point = la lecture joue dans cette page */}
                        {playStep >= pi * 8 && playStep < pi * 8 + 8 && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-cyan-400" />}
                      </button>
                    ))}
                  </div>
                  {pad && (
                    <button type="button" onClick={e => openRowMenu(atEl(e.currentTarget), Math.min(selPad, dm.rows.length - 1))}
                      aria-haspopup="menu" title="Réglages du pad choisi (mute, solo, son, sampler…)"
                      className="ml-auto min-w-0 h-11 px-3 rounded-xl text-[12px] font-bold truncate bg-white/5 text-slate-200">
                      <i className="fas fa-sliders-h mr-1.5" />{pad.name}
                    </button>
                  )}
                </div>
              )}

              {/* Grille. Bureau : la flèche « pas suivants » a sa propre colonne à droite (elle recouvrait
                  les dernières cases visibles quand elle était posée par-dessus la grille). */}
              <div className={narrow ? 'relative' : 'flex items-stretch gap-1'} data-testid="drum-grid">
              <div ref={gridRef} onScroll={checkScroll} className={narrow ? '-mx-2' : 'min-w-0 flex-1 overflow-x-auto no-scrollbar'}>
                <div className={narrow ? '' : 'inline-block min-w-full'}>
                  {shownRows.map(({ r, ri }) => (
                    <div key={r.id} className="flex items-center gap-1 mb-1" data-row={r.id}>
                      {narrow ? (
                        <button type="button" onClick={() => { hitPad(ri); setSelPad(ri); if (soundMenu !== null) setSoundMenu(ri); }}
                          onPointerDown={() => startRepeat(ri)} onPointerUp={stopRepeat} onPointerLeave={stopRepeat} onPointerCancel={stopRepeat} data-own-longpress=""
                          onContextMenu={e => { e.preventDefault(); stopRepeat(); openRowMenu(e, ri); }}
                          aria-label={`Écouter ${r.name}`} aria-pressed={selPad === ri} title="Écouter et choisir ce pad (appui long : réglages du pad)"
                          className={`shrink-0 w-11 h-11 rounded-lg px-0.5 text-[9px] leading-[10px] font-bold text-center break-words overflow-hidden ${flash === ri ? 'bg-cyan-400 text-black' : selPad === ri ? 'bg-cyan-500/20 text-white ring-1 ring-cyan-400/60' : 'bg-white/5 text-slate-200'}`}>
                          <span className={r.muted ? 'line-through opacity-50' : ''}>{r.name}</span>
                          {r.solo && <span className="text-amber-300"> S</span>}
                        </button>
                      ) : (
                      <div className="sticky left-0 z-10 bg-nv-surface pr-1 flex items-center gap-0.5 shrink-0" style={{ width: headW - 4 }}>
                        <button type="button" onClick={() => { hitPad(ri); setSelPad(ri); }}
                          onDoubleClick={() => openSampler(ri)}
                          onContextMenu={e => { e.preventDefault(); stopRepeat(); openRowMenu(e, ri); }}
                          onPointerDown={() => startRepeat(ri)} onPointerUp={stopRepeat} onPointerLeave={stopRepeat} onPointerCancel={stopRepeat} data-own-longpress=""
                          aria-pressed={selPad === ri}
                          title={`${r.name} : écouter le son et le choisir pour le graphe${keyOf(ri) ? ` (touche ${keyOf(ri)})` : ''}. Double-clic : éditer le son. Clic droit : réglages de la rangée. Glisse un fichier audio ici pour mettre TON son sur ce pad.`}
                          onDragOver={allowDrop} onDrop={e => onDropFiles(e, ri)}
                          className={`flex-1 min-w-0 ${coarse ? 'h-11' : 'h-9'} rounded-lg text-left px-2 text-[11px] font-bold truncate ${flash === ri ? 'bg-cyan-400 text-black' : selPad === ri ? 'bg-cyan-500/15 text-white ring-1 ring-cyan-400/50' : 'bg-white/[0.04] text-white hover:bg-white/[0.08]'}`}>
                          {r.rate && r.rate !== '16' && <span className="mr-1 text-[9px] text-violet-300">{STEP_RATES.find(x => x.id === r.rate)?.label}</span>}
                          {r.len ? <span className="mr-1 text-[9px] text-violet-300">{r.len}</span> : null}
                          {keyOf(ri) && <span className="mr-1 inline-block min-w-[14px] px-0.5 rounded bg-white/10 text-[9px] text-center text-slate-300">{keyOf(ri)}</span>}
                          {userSampleId(r.sound) && <i className={`fas ${r.slice ? 'fa-cut text-pink-300' : 'fa-user text-amber-300'} mr-1 text-[9px]`} />}
                          <span className={r.muted ? 'line-through opacity-50' : ''}>{r.name}</span>
                          {(r.mix && Object.values(r.mix).some(v => v)) || r.smp ? <span className="ml-1 text-violet-300" title="Son réglé (mix ou sampler)">✦</span> : null}
                        </button>
                        {!simple && !coarse && (
                          <>
                            <button type="button" onClick={() => editRow(ri, x => ({ ...x, muted: !x.muted }))} aria-pressed={!!r.muted} aria-label={`Muet : ${r.name}`} title="Muet (mute)"
                              className={`nova-hit-tactile w-7 h-9 [@media(pointer:coarse)]:h-10 rounded-md text-[10px] font-black ${r.muted ? 'bg-red-500 text-white' : 'bg-white/5 text-slate-400 hover:text-white'}`}>M</button>
                            <button type="button" onClick={() => editRow(ri, x => ({ ...x, solo: !x.solo }))} aria-pressed={!!r.solo} aria-label={`Solo : ${r.name}`} title="Solo"
                              className={`nova-hit-tactile w-7 h-9 [@media(pointer:coarse)]:h-10 rounded-md text-[10px] font-black ${r.solo ? 'bg-amber-400 text-black' : 'bg-white/5 text-slate-400 hover:text-white'}`}>S</button>
                          </>
                        )}
                        <button type="button" onClick={e => openRowMenu(atEl(e.currentTarget), ri)} aria-haspopup="menu"
                          aria-label={`Réglages du pad ${r.name}`} title="Réglages du pad : son, sampler, résolution, nombre de pas, swing, étouffement…"
                          className={`${coarse ? 'w-11 h-11' : 'w-7 h-9'} rounded-md text-[11px] ${soundMenu === ri || samplerFor === ri ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}><i className="fas fa-ellipsis-vertical" aria-hidden /></button>
                      </div>
                      )}
                      {(rowStepsPerBar(r) !== STEPS_PER_BAR || (r.len || 0) > 0) ? (() => {
                        // R18 : rangée en 1/8, 1/32 / triolets / longueur propre : cases à l'échelle du temps.
                        const { cells, usable } = rowCells(r, dm.bars, narrow ? curPage : null);
                        const ps = playW ? rowStepAt(r, playW, dm.bars) : -1;
                        return (
                          <div className={`flex ${narrow ? 'flex-1 min-w-0' : 'shrink-0'}`} style={narrow ? undefined : { width: `${Math.max(len, (cells.length * STEPS_PER_BAR) / rowStepsPerBar(r)) * step16Px - 4}px` }}>
                            {cells.map(si => {
                              const off = si >= usable;
                              return stepCell(r, ri, si, ps === si, (si * STEPS_PER_BAR / rowStepsPerBar(r)) % 4 === 0, off, true);
                            })}
                          </div>
                        );
                      })() : (
                        <div className={`flex ${narrow ? 'flex-1 min-w-0' : 'shrink-0 gap-1'}`}>
                          {shownSteps.map(si => stepCell(r, ri, si, playStep === si, si % 4 === 0, false, false))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              {!narrow && (moreRight || (gridRef.current?.scrollLeft || 0) > 0) && (
                <button type="button" disabled={!moreRight} onClick={() => gridRef.current?.scrollBy({ left: gridRef.current.clientWidth * 0.6, behavior: 'smooth' })}
                  aria-label="Voir les pas suivants" title={moreRight ? 'Pas suivants' : 'Tu vois déjà les derniers pas'} data-testid="drum-steps-next"
                  className="shrink-0 w-9 mb-1 flex items-center justify-center rounded-lg bg-white/5 text-slate-200 hover:bg-white/10 disabled:opacity-30 disabled:cursor-default">
                  <i className="fas fa-chevron-right" aria-hidden />
                </button>
              )}
              </div>

              {/* R18 · Éditeur de graphe du pad choisi (vélocité, probabilité, décalage, longueur, hauteur, pan par pas). */}
              {!simple && dm.rows[Math.min(selPad, dm.rows.length - 1)] && (() => {
                const gi = Math.min(selPad, dm.rows.length - 1);
                const gr = dm.rows[gi];
                const plain = rowStepsPerBar(gr) === STEPS_PER_BAR && !((gr.len || 0) > 0);
                const cells = plain ? shownSteps : rowCells(gr, dm.bars, narrow ? curPage : null).cells.filter(i => i < gr.steps.length);
                return (
                  <div className={narrow ? '' : 'overflow-x-auto no-scrollbar'}>
                    <div style={narrow ? undefined : { width: `${headW + len * step16Px}px`, paddingLeft: `${headW}px` }}>
                      <StepGraph dm={dm} rowIndex={gi} cells={cells} onChange={p.onChange} bpm={p.bpm}
                        playStep={playW ? rowStepAt(gr, playW, dm.bars) : -1} />
                    </div>
                  </div>
                );
              })()}

              {samplerFor !== null && dm.rows[samplerFor] && (
                <PadSamplerEditor dm={dm} rowIndex={samplerFor} onChange={p.onChange} onAudition={() => p.onAudition(samplerFor)}
                  onClose={() => setSamplerFor(null)} ensureEngine={p.ensureEngine || (async () => {})} notify={p.notify} narrow={narrow}
                  projectKey={p.projectKey ?? null} onDropFiles={e => onDropFiles(e, samplerFor)} allowDrop={allowDrop} />
              )}

              {soundMenu !== null && dm.rows[soundMenu] && (
                <PadEditor
                  kitId={dm.kitId}
                  row={dm.rows[soundMenu]}
                  onEdit={patch => editRow(soundMenu, patch)}
                  onAudition={() => setTimeout(() => p.onAudition(soundMenu), 120)}
                  onClose={() => setSoundMenu(null)}
                  extra={
                    <>
                    <PadSampleTools dm={dm} rowIndex={soundMenu} onChange={d => { p.onChange(d); if (!d.rows[soundMenu]) setSoundMenu(null); }}
                      onAudition={() => p.onAudition(soundMenu)} sessionClips={p.sessionClips || []}
                      ensureEngine={p.ensureEngine || (async () => {})} onChop={src => setChop(src)} notify={p.notify} />
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => openSampler(soundMenu)} data-testid="pad-open-sampler"
                        className="nova-hit h-10 px-3 rounded-lg bg-cyan-500/15 border border-cyan-400/40 text-cyan-200 text-[12px] font-bold hover:bg-cyan-500/25">
                        <i className="fas fa-wave-square mr-1.5" />Éditer le son (enveloppes, filtre, hauteur…)
                      </button>
                      <button type="button" onClick={() => { requestSampler({ kind: 'from-pad', rowIndex: soundMenu }); p.onClose(); }} data-testid="pad-to-sampler"
                        title="Met le son de ce pad dans un sampler sur une nouvelle piste : il se joue sur tout le clavier (808 mélodique, perc accordée)"
                        className="nova-hit h-10 px-3 rounded-lg bg-amber-500/15 border border-amber-400/40 text-amber-200 text-[12px] font-bold hover:bg-amber-500/25">
                        <i className="fas fa-keyboard mr-1.5" />Convertir en sampler (piste)
                      </button>
                    </div>
                    </>
                  }
                />
              )}

              {/* Réglages de chaque instant : longueur, swing, groove, roulement */}
              <div className="flex flex-wrap items-center gap-3 text-[12px] text-slate-300">
                <div className="flex rounded-xl overflow-hidden border border-white/10" role="group" aria-label="Longueur du motif">
                  {[1, 2, 4, 8].map(b => (
                    <button key={b} type="button" onClick={() => p.onChange(setBars(dm, b as 1 | 2 | 4 | 8))} title={`Motif de ${b} mesure${b > 1 ? 's' : ''} (${b * 16} pas)`} aria-pressed={dm.bars === b}
                      className={`h-10 px-3 font-bold ${dm.bars === b ? 'bg-white text-black' : 'bg-white/5 text-white'}`}>{b}<span className="hidden sm:inline"> mes.</span></button>
                  ))}
                </div>
                <label className="flex items-center gap-2" title="Swing : retarde les doubles-croches paires (50 % = droit, comme sur les boîtes à rythmes : 66 % = triolet)">
                  Swing
                  <input type="range" min={0} max={0.6} step={0.01} value={dm.swing} onChange={e => p.onChange({ ...dm, swing: parseFloat(e.target.value) })} className="w-24 accent-cyan-400" aria-label="Swing" />
                  <span className="tabular-nums w-10">{Math.round(dm.swing * 100)} %</span>
                </label>
                {!simple && (
                  <label className="flex items-center gap-1.5" title={`Groove : ${GROOVES.find(g => g.id === (dm.groove || 'none'))?.hint}`}>
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
                )}
                {!simple && (
                  <label className="flex items-center gap-1.5" title="Roulement : tiens un pad (ou sa touche) et il se rejoue en rythme, calé sur le tempo.">
                    <i className="fas fa-repeat text-violet-300" aria-hidden />Roulement
                    <select value={repeat} onChange={e => setRepeat(parseInt(e.target.value, 10) as 0 | 4 | 8 | 16 | 32 | 24)} data-testid="note-repeat"
                      className="h-10 rounded-lg bg-white/5 border border-white/10 px-1.5 text-[12px] text-white">
                      <option value={0}>Non</option><option value={4}>1/4</option><option value={8}>1/8</option><option value={16}>1/16</option><option value={24}>1/16 T</option><option value={32}>1/32</option>
                    </select>
                  </label>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                {narrow
                  ? "Touche un pas pour l'allumer, appui long pour ses réglages ; touche le nom d'un pad pour l'écouter (appui long : réglages du pad). 1–8 / 9–16 change de moitié de mesure."
                  : <>Clic : allumer / éteindre · glisser : peindre · Maj + clic : accent · clic droit sur un pas : roll, probabilité, décalage, longueur, hauteur, glisse · double-clic sur un pad : éditer le son. <button type="button" className="underline text-slate-400 hover:text-white" onClick={() => setHelpOpen(true)}>Tous les raccourcis (?)</button></>}
              </p>
            </>
          )}
        </div>
      </div>
      <DrumMenu menu={menu} onClose={closeMenu} narrow={narrow} />
      {helpOpen && (
        <div className="fixed inset-0 z-[650] flex items-center justify-center bg-black/50 p-4 pointer-events-auto" onClick={e => { e.stopPropagation(); setHelpOpen(false); }} role="dialog" aria-modal="true" aria-label="Raccourcis de la batterie">
          <div className="w-full max-w-md max-h-[80vh] overflow-y-auto rounded-2xl border border-white/10 bg-nv-raised p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center mb-2">
              <p className="text-[14px] font-black text-white mr-auto">Raccourcis de la batterie</p>
              <button type="button" onClick={() => setHelpOpen(false)} aria-label="Fermer les raccourcis" className="w-11 h-11 rounded-xl bg-white/5 text-slate-300"><i className="fas fa-times" /></button>
            </div>
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-[12px]">
              {DRUM_SHORTCUTS.map(([k, v]) => <React.Fragment key={k}><dt className="font-bold text-cyan-300 whitespace-nowrap">{k}</dt><dd className="text-slate-300">{v}</dd></React.Fragment>)}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
};

const coarseNow = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

/** Volume, pan et envoi réverb du pad, dans son menu (réglage rapide sans ouvrir le mix). */
const QuickMix: React.FC<{ row: DrumRow; onEdit: (patch: Partial<DrumRow>) => void }> = ({ row, onEdit }) => {
  const [v, setV] = useState({ volume: row.volume, pan: row.pan, verb: row.mix?.verb || 0 });
  const db = v.volume > 0 ? 20 * Math.log10(v.volume) : -Infinity;
  return (
    <div className="grid grid-cols-3 gap-2" data-testid="row-quick-mix">
      <label className="flex flex-col gap-1 text-[11px] text-slate-400">
        <span className="flex justify-between"><span>Volume</span><span className="tabular-nums text-slate-200">{Number.isFinite(db) ? `${db > 0 ? '+' : ''}${db.toFixed(1)} dB` : '−∞'}</span></span>
        <input type="range" min={0} max={1.2} step={0.01} value={v.volume} aria-label="Volume du pad" className="w-full h-8 accent-cyan-400" style={coarseNow() ? TOUCH_RANGE : undefined}
          onChange={e => { const x = parseFloat(e.target.value); setV(s => ({ ...s, volume: x })); onEdit({ volume: x }); }} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-slate-400">
        <span className="flex justify-between"><span>Pan</span><span className="tabular-nums text-slate-200">{Math.abs(v.pan) < 0.025 ? 'C' : `${v.pan < 0 ? 'G' : 'D'} ${Math.round(Math.abs(v.pan) * 100)}`}</span></span>
        <input type="range" min={-1} max={1} step={0.05} value={v.pan} aria-label="Panoramique du pad" className="w-full h-8 accent-cyan-400" style={coarseNow() ? TOUCH_RANGE : undefined}
          onChange={e => { const x = parseFloat(e.target.value); setV(s => ({ ...s, pan: x })); onEdit({ pan: x }); }} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-slate-400">
        <span className="flex justify-between"><span>Réverb</span><span className="tabular-nums text-slate-200">{Math.round(v.verb * 100)} %</span></span>
        <input type="range" min={0} max={1} step={0.01} value={v.verb} aria-label="Envoi réverb du pad" className="w-full h-8 accent-cyan-400" style={coarseNow() ? TOUCH_RANGE : undefined}
          onChange={e => { const x = parseFloat(e.target.value); setV(s => ({ ...s, verb: x })); onEdit({ mix: { ...(row.mix || {}), verb: x } }); }} />
      </label>
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
