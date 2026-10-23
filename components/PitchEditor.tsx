import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { Clip, Track } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import type { PitchNote } from '../utils/pitchAnalysis';
import {
  autoCorrect, centsFromScale, clampFormant, clampGain, CorrectStyle, FORMANT_RANGE, GAIN_MAX_DB, GAIN_MIN_DB, guessKey, isNeutral,
  NATURAL_TRANSITION_MS, NEUTRAL_EDIT, NoteEdit, snapEdit, targetCenter,
} from '../utils/pitchCorrect';
import { editsForNotes, manualNotes, revertClipPatch, storeEdits } from '../utils/pitchEdit';
import { infoSig, layoutOf, pendingPatch } from '../utils/novaPitch';
import { loadClipVoice, pitchRenderStatus, whenRendered, type ClipVoice } from '../utils/novaPitchHost';
import { applyLayout, cutAt, isEmptyLayout, joinAfter, noteShape, type NoteLayout } from '../engine/pitch/notes';
import { buildPlan } from '../engine/pitch/plan';
import { outputPitchCurve } from '../engine/pitch/render';
import { dstToSrc, srcToDst } from '../engine/pitch/timeMap';
import {
  moveNote, quietLenFrom, renderedSpan, resetLength, silenceFloor, stretchEnd, stretchGroup, stretchStart, type ElasticCtx, type ElasticResult,
} from '../engine/pitch/elastic';
import {
  centerOf as centerPctOf, correctNotes, dragPitch, editsAfterCut, editsAfterJoin, nudge, remapIndices, withCenter, withTarget, type Magnet,
} from '../utils/pitchOps';
import { fmtDuration, fmtPitch, parseDuration, parsePitch } from '../utils/pitchText';
import { keyLabelFr, NOTE_NAMES_FR, SCALE_CHOICES } from '../utils/scales';
import { useTheme } from '../utils/themeStore';
import { usePlayheadTime } from '../utils/playheadStore';
import { windowAbove } from '../utils/windowAbove';
import RollMenu, { RollMenuEntry } from './pianoroll/RollMenu';
import {
  drawAll, drawKeys, makePeaks, mOfY, PITCH_DARK, PITCH_LIGHT, tOfX, xOf, yOf, type DrawNote, type Peaks, type PitchView,
} from './pitch/pitchDraw';
import './pianoroll/pianoroll.css';
import './pitch/novaPitch.css';

/**
 * Nova Pitch · « Notes de la voix » : l'éditeur de notes de NOVA.
 *
 * La voix du clip apparaît note par note dans un piano roll (clavier à gauche,
 * gamme du projet surlignée, grille du projet), chaque note en bloc épaissi
 * selon son niveau, avec la vraie courbe de hauteur par-dessus.
 *
 * Outils (un seul visible à la fois, le reste dans les menus et le clic droit) :
 *  - Hauteur (1) : glisser une note (aimant gamme / demi-ton / libre au pas de
 *    2 cents ; Alt = sans aimant, Maj = fin), flèches ↑↓ = demi-ton,
 *    Maj + ↑↓ = 2 cents, saisie « La3 +4 c » ; centre, dérive, vibrato,
 *    transition, formant, gain dans « Réglages de la note » ;
 *  - Élastique (2) : tirer le bord d'une note l'allonge ou la raccourcit (seule
 *    la partie tenue s'étire, consonnes intactes, vibrato à sa vitesse), glisser
 *    la note la déplace ; la voisine s'adapte ou « décaler la suite » ;
 *  - Couper (3) : clic dans une note ; « Fusionner » (M) dans le menu.
 *
 * Chaque geste = une étape d'annulation (Ctrl+Z / Ctrl+Y du projet). Rien n'est
 * détruit : la prise d'origine reste ; le son retouché est calculé en
 * arrière-plan (utils/novaPitchHost), le même pour la lecture et l'export.
 */

interface Props {
  open: boolean;
  trackId?: string;
  clipId?: string;
  tracks: Track[];
  projectKey?: number;
  projectScale?: string;
  bpm?: number;
  /** Ouvert par « Corriger la justesse » : version épurée. */
  simple?: boolean;
  /** Un geste = une étape d'annulation. Message vide : pas de bulle. */
  onCommit: (trackId: string, clipId: string, patch: Partial<Clip>, message: string) => void;
  onClose: () => void;
}

type Tool = 'pitch' | 'time' | 'cut';
interface Draft {
  layout: NoteLayout;
  edits: (NoteEdit | undefined)[];
  manual: Set<number>;
  extend: number;
  amount: number;
  style: CorrectStyle;
}
const EMPTY_DRAFT: Draft = { layout: {}, edits: [], manual: new Set(), extend: 0, amount: 0, style: 'naturel' };

const TOOLS: { id: Tool; label: string; icon: string; keys: string; hint: string }[] = [
  { id: 'pitch', label: 'Hauteur', icon: 'fa-arrows-alt-v', keys: '1', hint: 'Glisse une note vers le haut ou le bas. Alt : sans aimant · Maj : au plus fin (2 cents)' },
  { id: 'time', label: 'Élastique', icon: 'fa-arrows-alt-h', keys: '2', hint: 'Tire le bord d’une note pour l’allonger ou la raccourcir, glisse-la pour la déplacer. Alt : sans grille' },
  { id: 'cut', label: 'Couper', icon: 'fa-cut', keys: '3', hint: 'Clique dans une note pour la couper en deux à cet endroit' },
];
const MAGNETS: { id: Magnet; label: string; hint: string }[] = [
  { id: 'scale', label: 'Gamme', hint: 'La note se pose sur une note de la gamme' },
  { id: 'semi', label: 'Demi-ton', hint: 'La note se pose sur un demi-ton juste' },
  { id: 'free', label: 'Libre (2 c)', hint: 'Au cinquantième de demi-ton près (2 cents)' },
];
const GRIDS: { v: number; label: string }[] = [
  { v: 1, label: '1/4 (temps)' }, { v: 0.5, label: '1/8' }, { v: 0.25, label: '1/16' }, { v: 0.125, label: '1/32' }, { v: 0, label: 'Sans grille' },
];

const HEIGHT_KEY = 'nova.pitch.dockHeight';
const readHeight = () => { try { const v = Number(localStorage.getItem(HEIGHT_KEY)); return v >= 220 && v <= 1000 ? v : 360; } catch { return 360; } };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const KEYS_W = 48;
const RULER_H = 18;

const usePhone = () => {
  const q = '(max-width: 640px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(q).matches);
  useEffect(() => {
    if (!window.matchMedia) return;
    const m = window.matchMedia(q);
    const on = () => setPhone(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return phone;
};

async function getCtx(): Promise<AudioContext | null> {
  try {
    const { audioEngine } = await import('../engine/AudioEngine');
    if (!audioEngine.ctx) await audioEngine.init();
    if (audioEngine.ctx?.state === 'suspended') await audioEngine.ctx.resume().catch(() => {});
    return audioEngine.ctx;
  } catch { return null; }
}

/** Crêtes de forme d'onde gardées par son (le dessin ne refait pas le calcul). */
const peaksCache = new WeakMap<AudioBuffer, Map<string, Peaks>>();
function peaksOf(buf: AudioBuffer, start: number, len: number): Peaks {
  let m = peaksCache.get(buf);
  if (!m) { m = new Map(); peaksCache.set(buf, m); }
  const k = `${start}:${len}`;
  let p = m.get(k);
  if (!p) {
    const ch = buf.getChannelData(0);
    const s = Math.max(0, start), e = Math.min(ch.length, start + len);
    p = makePeaks(ch.subarray(s, e), buf.sampleRate, 0);
    m.set(k, p);
  }
  return p;
}

interface Slider { label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; testId: string; hint: string; onLive: (v: number) => void; onReset?: () => void }

const PitchEditor: React.FC<Props> = ({ open, trackId, clipId, tracks, projectKey, projectScale, bpm = 120, simple: simpleProp, onCommit, onClose }) => {
  const phone = usePhone();
  const light = useTheme().theme === 'light';
  const P = light ? PITCH_LIGHT : PITCH_DARK;
  const track = tracks.find(t => t.id === trackId);
  const clip = track?.clips.find(c => c.id === clipId);
  const clipRef = useRef(clip);
  clipRef.current = clip;

  // ----- Analyse (worker, avec avancement) -----
  const [voice, setVoice] = useState<ClipVoice | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const srcBufferId = clip?.pitchEdit?.sourceBufferId && audioBufferRegistry.has(clip.pitchEdit.sourceBufferId) ? clip.pitchEdit.sourceBufferId : clip?.bufferId;
  useEffect(() => {
    if (!open || !clipRef.current) return;
    let alive = true;
    const c = clipRef.current;
    setVoice(null); setStatus('loading'); setProgress(0); setError('');
    if (c.isReversed) { setStatus('error'); setError('Ce clip est inversé : remets-le à l’endroit (menu du clip) pour éditer ses notes.'); return; }
    loadClipVoice(c, p => { if (alive) setProgress(p); }).then(v => {
      if (!alive) return;
      setVoice(v);
      setStatus(v.analysis.notes.length ? 'ready' : 'empty');
    }).catch(e => { if (alive) { setStatus('error'); setError(String(e?.message || e)); } });
    return () => { alive = false; };
  }, [open, clipId, srcBufferId]);

  // ----- Retouches : le clip est la référence (annuler / rétablir / collaboration) -----
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const lastSig = useRef<string | null>(null);
  const pe = clip?.pitchEdit;
  useEffect(() => {
    if (!voice) return;
    const own = pe && pe.sourceBufferId === voice.sourceBufferId ? pe : undefined;
    const sig = `${voice.key}|${own ? infoSig(own) : ''}`;
    if (lastSig.current === sig) return;
    lastSig.current = sig;
    const layout = own ? layoutOf(own, voice.region.start) : {};
    const ns = applyLayout(voice.analysis.track, voice.analysis.notes, layout);
    setDraft({
      layout,
      edits: own ? editsForNotes(ns, own.edits, voice.region.start) : ns.map(() => undefined),
      manual: own ? manualNotes(ns, own.edits, voice.region.start) : new Set(),
      extend: own?.extend || 0,
      amount: own?.amount !== undefined ? Math.round(own.amount * 100) : 0,
      style: own?.style || 'naturel',
    });
  }, [voice, pe]);

  const tr = voice?.analysis.track;
  const hopSec = tr ? tr.hop / tr.sr : 0.005;
  const notes: PitchNote[] = useMemo(() => (voice ? applyLayout(voice.analysis.track, voice.analysis.notes, draft.layout) : []), [voice, draft.layout]);
  const shapes = useMemo(() => (tr ? notes.map(n => noteShape(tr, n)) : []), [tr, notes]);
  const plan = useMemo(() => (tr && notes.length ? buildPlan({ track: tr, notes, shapes, edits: draft.edits, extend: draft.extend }) : null), [tr, notes, shapes, draft.edits, draft.extend]);
  const sungCurve = useMemo(() => (plan ? outputPitchCurve(plan, false) : null), [plan]);
  const targetCurve = useMemo(() => (plan && draft.edits.some(e => e && !isNeutral(e)) ? outputPitchCurve(plan, true) : null), [plan, draft.edits]);
  const quietLen = useMemo(() => (tr ? quietLenFrom(tr.rmsDb, hopSec, silenceFloor(tr.rmsDb)) : () => 0), [tr, hopSec]);
  const regionLen = voice ? voice.region.end - voice.region.start : 1;
  /** Début du clip dans le temps de la région (s). */
  const z = voice ? voice.sourceOffset - voice.region.start : 0;
  const clipDur = clip?.duration || 0;

  const keyGuess = useMemo(() => (notes.length ? guessKey(notes) : null), [notes]);
  const [keyOverride, setKeyOverride] = useState<{ root?: number; scale?: string } | null>(null);
  const key = useMemo(() => keyOverride ?? (typeof projectKey === 'number' && projectScale ? { root: projectKey, scale: projectScale } : keyGuess ? { root: keyGuess.root, scale: keyGuess.scale } : { root: undefined, scale: 'CHROMATIC' }), [keyOverride, projectKey, projectScale, keyGuess]);
  const keyGuessed = !keyOverride && !(typeof projectKey === 'number' && projectScale) && !!keyGuess;

  // ----- Valider un geste (une étape d'annulation) -----
  const commit = useCallback((next: Draft, message = '') => {
    const c = clipRef.current;
    if (!c || !trackId || !voice || !tr) return;
    const ns = applyLayout(tr, voice.analysis.notes, next.layout);
    const stored = storeEdits(ns, next.edits, voice.region.start, next.manual);
    setDraft(next);
    if (!stored.length && isEmptyLayout(next.layout) && Math.abs(next.extend) < 1e-5) {
      // Plus rien de retouché : la prise d'origine revient.
      if (!c.pitchEdit) return;
      const patch = revertClipPatch(c, id => audioBufferRegistry.has(id));
      if (!patch) return;
      lastSig.current = `${voice.key}|`;
      onCommit(trackId, c.id, patch, message);
      return;
    }
    const patch = pendingPatch(c, {
      sourceBufferId: voice.sourceBufferId, sourceOffset: voice.sourceOffset, region: voice.region,
      edits: stored, layout: next.layout, extend: next.extend, amount: next.amount / 100, style: next.style, at: Date.now(),
    });
    lastSig.current = `${voice.key}|${patch.pitchEdit ? infoSig(patch.pitchEdit) : ''}`;
    onCommit(trackId, c.id, patch, message);
  }, [trackId, voice, tr, onCommit]);

  const editNotes = useCallback((idx: number[], fn: (n: PitchNote, e: NoteEdit, i: number) => NoteEdit, live = false) => {
    if (!idx.length) return;
    const d = draftRef.current;
    const edits = d.edits.slice();
    idx.forEach(i => { if (notes[i]) edits[i] = fn(notes[i], d.edits[i] || NEUTRAL_EDIT, i); });
    const manual = new Set(d.manual); idx.forEach(i => manual.add(i));
    const next = { ...d, edits, manual };
    if (live) setDraft(next); else commit(next);
  }, [notes, commit]);

  // ----- Sélection, outil, aimant, vue -----
  const [sel, setSel] = useState<Set<number>>(new Set());
  const selected = useMemo(() => Array.from(sel).filter(i => i < notes.length).sort((a, b) => a - b), [sel, notes.length]);
  const [tool, setTool] = useState<Tool>('pitch');
  const [magnet, setMagnet] = useState<Magnet>('scale');
  const [grid, setGrid] = useState(0.25);
  const [ripple, setRipple] = useState(false);
  const [epure, setEpure] = useState(!!simpleProp);
  useEffect(() => { setEpure(!!simpleProp); }, [simpleProp, clipId]);
  const [showSung, setShowSung] = useState(true);
  const [showWave, setShowWave] = useState(true);
  const [audition, setAudition] = useState(true);
  const [height, setHeight] = useState(readHeight);
  const [menu, setMenu] = useState<null | { name: string; label: string; anchor: { x: number; y: number }; entries: (RollMenuEntry | false | null)[] }>(null);
  const [pop, setPop] = useState<null | { kind: 'settings' | 'correct' | 'all'; x: number; y: number }>(null);
  const renderBusy = useSyncExternalStore(pitchRenderStatus.subscribe, () => (clipId ? pitchRenderStatus.busy(clipId) : false), () => false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 280 });
  const [view, setView] = useState<PitchView>({ t0: 0, pps: 100, top: 72, rowH: 14 });
  const viewRef = useRef(view);
  viewRef.current = view;
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const set = () => setBox({ w: Math.max(50, el.clientWidth), h: Math.max(60, el.clientHeight) });
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, status, phone, epure]);

  // Vue ajustée à l'ouverture : tout le clip (au plus 16 s), notes centrées verticalement.
  const fitted = useRef<string>('');
  const fitView = useCallback((all = false) => {
    if (!voice || !notes.length) return;
    const W = box.w, H = box.h - RULER_H;
    const a = all ? 0 : Math.max(0, z - 0.15), b = all ? regionLen : Math.min(regionLen, z + Math.min(clipDur, 16) + 0.15);
    const pps = clamp(W / Math.max(0.3, b - a), 8, 2000);
    let lo = Infinity, hi = -Infinity;
    notes.forEach((n, i) => { const c = targetCenter(n, draftRef.current.edits[i]); lo = Math.min(lo, n.center, c); hi = Math.max(hi, n.center, c); });
    const span = Math.max(12, hi - lo + 6);
    const rowH = clamp(H / span, 8, 26);
    const mid = (hi + lo) / 2;
    setView({ t0: a, pps, rowH, top: mid + H / rowH / 2 });
  }, [voice, notes, box.w, box.h, z, regionLen, clipDur]);
  useEffect(() => {
    if (!voice || status !== 'ready') return;
    const k = `${voice.key}|${box.w > 50 ? 1 : 0}`;
    if (fitted.current === k) return;
    fitted.current = k;
    fitView();
  }, [voice, status, box.w, fitView]);

  // Lignes de la grille du projet (temps région ↔ temps projet : clip.start ↔ z).
  const beatSec = 60 / Math.max(20, bpm || 120);
  const clipStart = clip?.start ?? 0;
  const toProject = useCallback((t: number) => clipStart + (t - z), [clipStart, z]);
  const fromProject = useCallback((p: number) => p - clipStart + z, [clipStart, z]);
  const gridLines = useMemo(() => {
    const out: { t: number; kind: 0 | 1 | 2 }[] = [];
    const tA = tOfX(view, 0), tB = tOfX(view, box.w);
    const pxBeat = beatSec * view.pps;
    const sub = grid > 0 && pxBeat * grid >= 10 ? grid : pxBeat >= 12 ? 1 : 4;
    const step = beatSec * sub;
    const pA = toProject(tA), pB = toProject(tB);
    for (let q = Math.floor(pA / step); q * step <= pB; q++) {
      const p = q * step;
      const beats = p / beatSec;
      const kind: 0 | 1 | 2 = Math.abs(beats / 4 - Math.round(beats / 4)) < 1e-6 ? 0 : Math.abs(beats - Math.round(beats)) < 1e-6 ? 1 : 2;
      out.push({ t: fromProject(p), kind });
    }
    return out;
  }, [view, box.w, beatSec, grid, toProject, fromProject]);
  const snapTime = useCallback((t: number, alt: boolean) => {
    if (!grid || alt) return t;
    const g = beatSec * grid;
    return fromProject(Math.round(toProject(t) / g) * g);
  }, [grid, beatSec, toProject, fromProject]);

  // ----- Écoute : note au clic, sélection en boucle, original -----
  const playRef = useRef<{ node: AudioBufferSourceNode; ctx: AudioContext; startedAt: number; from: number; a: number; b: number; loop: boolean } | null>(null);
  const [playing, setPlaying] = useState<null | 'note' | 'loop' | 'orig'>(null);
  const [previewAt, setPreviewAt] = useState<number | null>(null);
  const stopPreview = useCallback(() => {
    const p = playRef.current;
    if (p) { try { p.node.onended = null; p.node.stop(); } catch { /* déjà arrêté */ } }
    playRef.current = null;
    setPlaying(null); setPreviewAt(null);
  }, []);
  useEffect(() => () => stopPreview(), [stopPreview]);
  useEffect(() => { if (!open) stopPreview(); }, [open, stopPreview]);

  /** Son rendu à jour (ou la prise d'origine s'il n'y a rien de retouché), temps = région rendue. */
  const outputBuffer = useCallback(async (): Promise<{ buf: AudioBuffer; offset: number } | null> => {
    const c = clipRef.current;
    if (!voice) return null;
    const p = c?.pitchEdit;
    if (!p || p.sourceBufferId !== voice.sourceBufferId) return { buf: voice.source, offset: voice.region.start };
    const sig = infoSig(p);
    if (p.renderSig === sig && c?.bufferId && c.bufferId !== p.sourceBufferId) {
      const b = audioBufferRegistry.get(c.bufferId);
      if (b) return { buf: b, offset: 0 };
    }
    const b = await Promise.race([whenRendered(c!.id, sig), new Promise<null>(r => setTimeout(() => r(null), 12000))]);
    return b ? { buf: b, offset: 0 } : null;
  }, [voice]);

  const play = useCallback(async (kind: 'note' | 'loop' | 'orig', a: number, b: number) => {
    stopPreview();
    const ctx = await getCtx();
    if (!ctx || !voice || !plan) return;
    let src: { buf: AudioBuffer; offset: number } | null;
    let ra = a, rb = b;
    if (kind === 'orig') {
      src = { buf: voice.source, offset: voice.region.start };
      ra = dstToSrc(plan.map, a * voice.source.sampleRate) / voice.source.sampleRate;
      rb = dstToSrc(plan.map, b * voice.source.sampleRate) / voice.source.sampleRate;
    } else src = await outputBuffer();
    if (!src) return;
    const node = ctx.createBufferSource();
    node.buffer = src.buf;
    const from = Math.max(0, src.offset + ra), len = Math.max(0.02, rb - ra);
    if (kind === 'loop') { node.loop = true; node.loopStart = from; node.loopEnd = from + len; node.start(0, from); }
    else node.start(0, from, len);
    node.connect(ctx.destination);
    node.onended = () => { if (playRef.current?.node === node) stopPreview(); };
    playRef.current = { node, ctx, startedAt: ctx.currentTime, from: a, a, b, loop: kind === 'loop' };
    setPlaying(kind);
  }, [stopPreview, voice, plan, outputBuffer]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const p = playRef.current;
      if (p) {
        let t = p.ctx.currentTime - p.startedAt;
        if (p.loop) t = t % Math.max(0.02, p.b - p.a);
        setPreviewAt(p.a + t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const spanOf = useCallback((k: number) => renderedSpan({ notes, edits: draft.edits }, k), [notes, draft.edits]);
  const selRange = useCallback((): [number, number] | null => {
    const idx = selected.length ? selected : notes.map((_, i) => i);
    if (!idx.length) return null;
    return [Math.max(0, spanOf(idx[0])[0] - 0.12), spanOf(idx[idx.length - 1])[1] + 0.12];
  }, [selected, notes, spanOf]);
  const toggleLoop = useCallback(() => {
    if (playing === 'loop') { stopPreview(); return; }
    const r = selRange();
    if (r) void play('loop', r[0], r[1]);
  }, [playing, stopPreview, selRange, play]);
  const toggleOrig = useCallback(() => {
    if (playing === 'orig') { stopPreview(); return; }
    const r = selRange();
    if (r) void play('orig', r[0], r[1]);
  }, [playing, stopPreview, selRange, play]);

  // ----- Tête de lecture du projet -----
  const ph = usePlayheadTime(0.02);
  const playhead = clip && ph >= clip.start - 0.01 && ph <= clip.start + clip.duration + 0.01 ? fromProject(ph) : null;

  // ----- Dessin -----
  const drawNotes: DrawNote[] = useMemo(() => {
    if (!tr) return [];
    return notes.map((n, k) => {
      const [a, b] = renderedSpan({ notes, edits: draft.edits }, k);
      const e = draft.edits[k];
      const m = targetCenter(n, e);
      const steps = Math.max(2, Math.min(80, Math.round((n.end - n.start) / 0.01)));
      const body = new Float32Array(steps);
      let mx = -Infinity;
      for (let i = n.i0; i < n.i1; i++) mx = Math.max(mx, tr.rmsDb[i]);
      for (let s = 0; s < steps; s++) {
        const f = Math.min(n.i1 - 1, n.i0 + Math.floor(((s + 0.5) / steps) * (n.i1 - n.i0)));
        body[s] = clamp((tr.rmsDb[f] - (mx - 30)) / 30, 0, 1);
      }
      const cents = centsFromScale(m, key.root, key.scale);
      return { a, b, m, sung: n.center, cents, edited: !!e && !isNeutral(e), selected: sel.has(k), body, label: fmtPitch(m) };
    });
  }, [tr, notes, draft.edits, key, sel]);

  const [rubber, setRubber] = useState<null | { x0: number; y0: number; x1: number; y1: number }>(null);
  const [cutX, setCutX] = useState<number | null>(null);
  const peaks = useMemo(() => {
    if (!voice || !showWave) return null;
    const c = clip;
    const p = c?.pitchEdit;
    const sr = voice.source.sampleRate;
    if (p && p.sourceBufferId === voice.sourceBufferId && p.renderSig === infoSig(p) && c?.bufferId && c.bufferId !== p.sourceBufferId) {
      const b = audioBufferRegistry.get(c.bufferId);
      if (b) return peaksOf(b, 0, b.length);
    }
    return peaksOf(voice.source, Math.round(voice.region.start * sr), Math.round(regionLen * sr));
  }, [voice, showWave, clip, regionLen]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!open || !cv || !voice) return;
    const dpr = window.devicePixelRatio || 1;
    const W = box.w, H = box.h - RULER_H;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawAll(ctx, {
      w: W, h: H, v: view, P, key, grid: gridLines, clip: { a: z, b: z + clipDur }, peaks, hopSec,
      sung: showSung ? sungCurve : null, target: targetCurve, notes: drawNotes, handles: tool === 'time',
      playhead, preview: previewAt, rubber, cutX,
    });
  }, [open, voice, box, view, P, key, gridLines, z, clipDur, peaks, hopSec, showSung, sungCurve, targetCurve, drawNotes, tool, playhead, previewAt, rubber, cutX]);
  useEffect(() => {
    const cv = keysRef.current;
    if (!open || !cv) return;
    const dpr = window.devicePixelRatio || 1;
    const H = box.h - RULER_H;
    cv.width = KEYS_W * dpr; cv.height = Math.round(H * dpr); cv.style.width = `${KEYS_W}px`; cv.style.height = `${H}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawKeys(ctx, KEYS_W, H, view, P, key);
  }, [open, box.h, view, P, key, status]);

  // ----- Zoom et défilement (molette, pincement) -----
  const clampView = useCallback((v: PitchView): PitchView => {
    const W = box.w;
    const pps = clamp(v.pps, 4, 4000);
    const t0 = clamp(v.t0, -0.5, Math.max(0, regionLen + Math.max(0, draft.extend) - W / pps + 0.5));
    const rowH = clamp(v.rowH, 6, 48);
    const top = clamp(v.top, 20, 120);
    return { t0, pps, rowH, top };
  }, [box.w, regionLen, draft.extend]);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left - KEYS_W, y = e.clientY - r.top - RULER_H;
      const dy = e.deltaY || e.deltaX;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const f = Math.exp(-dy * 0.0015);
        if (e.shiftKey || e.altKey) { const m = mOfY(v, y); const rowH = clamp(v.rowH * f, 6, 48); setView(clampView({ ...v, rowH, top: m + y / rowH })); }
        else { const t = tOfX(v, x); const pps = clamp(v.pps * f, 4, 4000); setView(clampView({ ...v, pps, t0: t - x / pps })); }
        return;
      }
      if (e.altKey) { const m = mOfY(v, y); const rowH = clamp(v.rowH * Math.exp(-dy * 0.002), 6, 48); setView(clampView({ ...v, rowH, top: m + y / rowH })); return; }
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { setView(clampView({ ...v, t0: v.t0 + (e.deltaX || e.deltaY) / v.pps })); return; }
      setView(clampView({ ...v, top: v.top - e.deltaY / v.rowH / 3 }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [clampView, status]);

  // ----- Souris / doigt / stylet -----
  type Drag =
    | { kind: 'pitch'; idx: number[]; y: number; base: Draft; moved: boolean; hit: number }
    | { kind: 'edge'; k: number; edge: 'start' | 'end'; x: number; base: Draft; moved: boolean; group: number[] }
    | { kind: 'move'; k: number; x: number; base: Draft; moved: boolean }
    | { kind: 'box'; x: number; y: number; add: boolean; moved: boolean }
    | { kind: 'pan'; x: number; y: number; v: PitchView; moved: boolean };
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<null | { d: number; dx: number; dy: number; v: PitchView; cx: number; cy: number }>(null);
  const activeRef = useRef(false);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const hitNote = useCallback((x: number, y: number, touch: boolean): number => {
    const tol = Math.max(view.rowH * 0.7, touch ? 22 : 8);
    let best = -1, bestD = Infinity;
    drawNotes.forEach((n, i) => {
      const x0 = xOf(view, n.a), x1 = xOf(view, n.b);
      if (x < x0 - (touch ? 10 : 2) || x > x1 + (touch ? 10 : 2)) return;
      const d = Math.abs(y - yOf(view, n.m));
      if (d <= tol && d < bestD) { bestD = d; best = i; }
    });
    return best;
  }, [drawNotes, view]);
  const hitEdge = useCallback((x: number, y: number, touch: boolean): { k: number; edge: 'start' | 'end' } | null => {
    const tolX = touch ? 22 : 7, tolY = Math.max(view.rowH * 0.8, touch ? 26 : 10);
    let best: { k: number; edge: 'start' | 'end' } | null = null, bestD = Infinity;
    drawNotes.forEach((n, i) => {
      if (Math.abs(y - yOf(view, n.m)) > tolY) return;
      const x0 = xOf(view, n.a), x1 = xOf(view, n.b);
      const d0 = Math.abs(x - x0), d1 = Math.abs(x - x1);
      if (d1 <= tolX && d1 < bestD) { bestD = d1; best = { k: i, edge: 'end' }; }
      if (d0 <= tolX && d0 < bestD && x1 - x0 > 2 * tolX * 0.6) { bestD = d0; best = { k: i, edge: 'start' }; }
    });
    return best;
  }, [drawNotes, view]);

  const elasticCtx = useCallback((d: Draft): ElasticCtx => ({ notes, edits: d.edits, quietLen, regionLen, extend: d.extend, ripple }), [notes, quietLen, regionLen, ripple]);
  const applyElastic = useCallback((base: Draft, r: ElasticResult, idx: number[], live: boolean) => {
    const manual = new Set(base.manual); idx.forEach(i => manual.add(i));
    const next = { ...base, edits: r.edits, extend: r.extend, manual };
    if (live) setDraft(next); else commit(next);
  }, [commit]);

  const auditionNote = useCallback((k: number) => {
    if (!audition) return;
    const [a, b] = spanOf(k);
    void play('note', Math.max(0, a - 0.02), b + 0.04);
  }, [audition, spanOf, play]);

  const doCut = useCallback((k: number, tDst: number) => {
    if (!tr || !plan || !voice) return;
    const sr = tr.sr;
    const tSrc = dstToSrc(plan.map, tDst * sr) / sr;
    const d = draftRef.current;
    const layout = cutAt(tr, notes, d.layout, tSrc);
    if (!layout) return;
    const offset = tDst - tSrc;
    const n = notes[k];
    const offAtCut = n ? offset : 0;
    commit({ ...d, layout, edits: editsAfterCut(d.edits, k, offAtCut), manual: remapIndices(d.manual, k, 1) }, '');
    setSel(new Set([k + 1]));
  }, [tr, plan, voice, notes, commit]);
  const doJoin = useCallback((k: number) => {
    const d = draftRef.current;
    const layout = joinAfter(notes, d.layout, k);
    if (!layout) return;
    commit({ ...d, layout, edits: editsAfterJoin(d.edits, k), manual: remapIndices(d.manual, k, -1) }, '');
    setSel(new Set([k]));
  }, [notes, commit]);
  const joinSelection = useCallback(() => {
    const idx = selected.length >= 2 ? selected : selected.length === 1 ? [selected[0], selected[0] + 1] : [];
    if (idx.length < 2 || idx[idx.length - 1] >= notes.length) return;
    // De la dernière à la première (les indices restent valides).
    let d = draftRef.current;
    let layout = d.layout, edits = d.edits, manual = d.manual;
    let ns = notes;
    for (let q = idx.length - 2; q >= 0; q--) {
      const k = idx[q];
      if (idx[q + 1] !== k + 1) continue;
      const l = joinAfter(ns, layout, k);
      if (!l || !tr) continue;
      layout = l; edits = editsAfterJoin(edits, k); manual = remapIndices(manual, k, -1);
      ns = applyLayout(tr, voice!.analysis.notes, layout);
    }
    d = { ...d, layout, edits, manual };
    commit(d, '');
    setSel(new Set([idx[0]]));
  }, [selected, notes, tr, voice, commit]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (status !== 'ready') return;
    activeRef.current = true;
    const { x, y } = local(e);
    const touch = e.pointerType !== 'mouse';
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x, y });
    if (pointers.current.size === 2) {
      const [p1, p2] = Array.from(pointers.current.values());
      pinch.current = { d: Math.hypot(p2.x - p1.x, p2.y - p1.y), dx: Math.abs(p2.x - p1.x), dy: Math.abs(p2.y - p1.y), v: viewRef.current, cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2 };
      drag.current = null; setRubber(null);
      return;
    }
    if (e.button === 2) return;
    const d = draftRef.current;
    if (tool === 'time' && !epure) {
      const ed = hitEdge(x, y, touch);
      if (ed) {
        if (!sel.has(ed.k)) setSel(new Set([ed.k]));
        const group = sel.has(ed.k) && sel.size > 1 && ed.edge === 'end' ? Array.from(sel) : [ed.k];
        drag.current = { kind: 'edge', k: ed.k, edge: ed.edge, x, base: d, moved: false, group };
        return;
      }
    }
    const i = hitNote(x, y, touch);
    if (i >= 0 && tool === 'cut' && !epure) { doCut(i, tOfX(view, x)); return; }
    if (i >= 0) {
      let idx: number[];
      if (e.shiftKey || e.ctrlKey || e.metaKey) { const s = new Set(sel); if (s.has(i)) s.delete(i); else s.add(i); setSel(s); idx = Array.from(s); }
      else if (sel.has(i)) idx = Array.from(sel);
      else { setSel(new Set([i])); idx = [i]; }
      if (tool === 'time' && !epure) drag.current = { kind: 'move', k: i, x, base: d, moved: false };
      else drag.current = { kind: 'pitch', idx, y, base: d, moved: false, hit: i };
      return;
    }
    if (touch) drag.current = { kind: 'pan', x, y, v: viewRef.current, moved: false };
    else drag.current = { kind: 'box', x, y, add: e.shiftKey, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x, y });
    const pz = pinch.current;
    if (pz && pointers.current.size >= 2) {
      const [p1, p2] = Array.from(pointers.current.values());
      const dx = Math.abs(p2.x - p1.x), dy = Math.abs(p2.y - p1.y);
      const v = pz.v;
      const fx = pz.dx > 30 ? dx / pz.dx : 1, fy = pz.dy > 30 ? dy / pz.dy : 1;
      const t = tOfX(v, pz.cx), m = mOfY(v, pz.cy);
      const pps = clamp(v.pps * fx, 4, 4000), rowH = clamp(v.rowH * fy, 6, 48);
      const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
      setView(clampView({ pps, rowH, t0: t - cx / pps, top: m + cy / rowH }));
      return;
    }
    if (tool === 'cut' && !drag.current && !epure) {
      const i = hitNote(x, y, e.pointerType !== 'mouse');
      setCutX(i >= 0 ? x : null);
    }
    const d = drag.current;
    if (!d) return;
    const alt = e.altKey;
    if (d.kind === 'pan') {
      if (Math.abs(x - d.x) + Math.abs(y - d.y) > 4) d.moved = true;
      setView(clampView({ ...d.v, t0: d.v.t0 - (x - d.x) / d.v.pps, top: d.v.top + (y - d.y) / d.v.rowH }));
      return;
    }
    if (d.kind === 'box') {
      if (Math.abs(x - d.x) + Math.abs(y - d.y) > 4) d.moved = true;
      setRubber({ x0: d.x, y0: d.y, x1: x, y1: y });
      return;
    }
    if (d.kind === 'pitch') {
      const dy = y - d.y;
      if (!d.moved && Math.abs(dy) < 4) return;
      d.moved = true;
      const fine = e.shiftKey;
      const delta = (-dy / view.rowH) * (fine ? 0.1 : 1);
      const mg: Magnet = alt || fine ? 'free' : epure ? 'scale' : magnet;
      const edits = dragPitch(notes, d.base.edits, d.idx, delta, mg, key);
      const manual = new Set(d.base.manual); d.idx.forEach(i => manual.add(i));
      setDraft({ ...d.base, edits, manual });
      return;
    }
    if (d.kind === 'edge') {
      if (!d.moved && Math.abs(x - d.x) < 3) return;
      d.moved = true;
      const t = snapTime(tOfX(view, x), alt);
      const c = elasticCtx(d.base);
      let r: ElasticResult;
      if (d.edge === 'end' && d.group.length > 1) {
        const [a, b] = renderedSpan(c, d.k);
        r = stretchGroup(c, d.group, Math.max(0.01, (t - a) / Math.max(1e-3, b - a)));
      } else r = d.edge === 'end' ? stretchEnd(c, d.k, t) : stretchStart(c, d.k, t);
      applyElastic(d.base, r, d.group, true);
      return;
    }
    if (d.kind === 'move') {
      if (!d.moved && Math.abs(x - d.x) < 4) return;
      d.moved = true;
      const c = elasticCtx(d.base);
      const [a] = renderedSpan(c, d.k);
      const target = snapTime(a + (x - d.x) / view.pps, alt);
      applyElastic(d.base, moveNote(c, d.k, target - a), [d.k], true);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current) { if (pointers.current.size < 2) pinch.current = null; return; }
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'box') {
      setRubber(null);
      if (!d.moved) { setSel(new Set()); return; }
      const { x, y } = local(e);
      const [xa, xb] = [Math.min(d.x, x), Math.max(d.x, x)], [ya, yb] = [Math.min(d.y, y), Math.max(d.y, y)];
      const s = new Set<number>(d.add ? sel : []);
      drawNotes.forEach((n, i) => {
        const yc = yOf(view, n.m);
        if (xOf(view, n.b) >= xa && xOf(view, n.a) <= xb && yc >= ya - view.rowH / 2 && yc <= yb + view.rowH / 2) s.add(i);
      });
      setSel(s);
      return;
    }
    if (d.kind === 'pan') { if (!d.moved) setSel(new Set()); return; }
    if (d.kind === 'pitch') {
      if (d.moved) commit(draftRef.current, '');
      else auditionNote(d.hit);
      return;
    }
    if ((d.kind === 'edge' || d.kind === 'move') && d.moved) commit(draftRef.current, '');
    else if (d.kind === 'move') auditionNote(d.k);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e);
    const i = hitNote(x, y, false);
    if (i < 0) return;
    if (tool === 'time' && !epure) {
      const d = draftRef.current;
      applyElastic(d, resetLength(elasticCtx(d), i), [i], false);
      return;
    }
    if (tool === 'pitch' || epure) editNotes([i], (n, ed) => snapEdit(n, ed, key));
  };

  // ----- Actions (menus, clavier) -----
  const asSung = useCallback((idx: number[]) => {
    if (!idx.length) return;
    const d = draftRef.current;
    const edits = d.edits.slice();
    const manual = new Set(d.manual);
    idx.forEach(i => { edits[i] = undefined; manual.delete(i); });
    commit({ ...d, edits, manual }, '');
  }, [commit]);
  const snapSel = useCallback(() => editNotes(selected, (n, ed) => snapEdit(n, ed, key)), [editNotes, selected, key]);
  const nudgeSel = useCallback((dir: 1 | -1, fine: boolean) => editNotes(selected, (n, ed) => nudge(n, ed, dir, fine)), [editNotes, selected]);
  const globalCorrect = useCallback((amount: number, style: CorrectStyle, live: boolean) => {
    const d = draftRef.current;
    const auto = autoCorrect(notes, key, amount / 100, style);
    const edits = notes.map((_, i) => (d.manual.has(i) ? d.edits[i] : amount > 0 ? { ...auto[i], ...(d.edits[i]?.dt0 !== undefined ? { dt0: d.edits[i]!.dt0 } : {}), ...(d.edits[i]?.dt1 !== undefined ? { dt1: d.edits[i]!.dt1 } : {}) } : (d.edits[i]?.dt0 || d.edits[i]?.dt1 ? { ...NEUTRAL_EDIT, dt0: d.edits[i]!.dt0, dt1: d.edits[i]!.dt1 } : undefined)));
    const next = { ...d, edits, amount, style };
    if (live) setDraft(next); else commit(next, amount > 0 ? '' : '');
  }, [notes, key, commit]);

  const openMenuAt = (name: string, label: string, el: HTMLElement | { x: number; y: number }, entries: (RollMenuEntry | false | null)[]) => {
    const anchor = 'x' in el ? el : (() => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; })();
    setMenu({ name, label, anchor, entries });
  };
  const toolEntries = (): (RollMenuEntry | false)[] => [
    { kind: 'section', label: 'Outil' },
    ...TOOLS.map(t => ({ id: `outil-${t.id}`, label: t.label, icon: t.icon, keys: t.keys, hint: t.hint, checked: tool === t.id, onSelect: () => setTool(t.id) } as RollMenuEntry)),
    { kind: 'sep' },
    { kind: 'section', label: 'Élastique' },
    { id: 'decaler-suite', label: 'Décaler la suite', hint: 'Allonger une note pousse tout ce qui suit (le clip s’allonge). Sinon, la note voisine s’adapte.', checked: ripple, keepOpen: true, onSelect: () => setRipple(r => !r) },
  ];
  const magnetEntries = (): (RollMenuEntry | false)[] => tool === 'time'
    ? [{ kind: 'section', label: 'Grille du projet (Alt : sans grille)' }, ...GRIDS.map(g => ({ id: `grille-${g.v}`, label: g.label, checked: grid === g.v, onSelect: () => setGrid(g.v) } as RollMenuEntry))]
    : [{ kind: 'section', label: 'Aimant de hauteur (Alt : sans aimant)' }, ...MAGNETS.map(m => ({ id: `aimant-${m.id}`, label: m.label, hint: m.hint, checked: magnet === m.id, onSelect: () => setMagnet(m.id) } as RollMenuEntry))];
  const noteEntries = (anchor: { x: number; y: number }, at?: { k: number; t: number }): (RollMenuEntry | false)[] => {
    const n = selected.length;
    const k = at?.k ?? (n === 1 ? selected[0] : -1);
    return [
      { kind: 'section', label: n ? `${n} note${n > 1 ? 's' : ''}` : 'Notes' },
      { id: 'reglages', label: 'Réglages de la note…', icon: 'fa-sliders-h', keys: 'R', disabled: !n, hint: 'Hauteur, centre, dérive, vibrato, transition, formant, gain, durée', onSelect: () => setPop({ kind: 'settings', ...anchor }) },
      { id: 'corriger-selection', label: 'Corriger la sélection…', icon: 'fa-magic', keys: 'Q', hint: 'Centre et dérive à X % en un geste', onSelect: () => setPop({ kind: 'correct', ...anchor }) },
      { id: 'coller-gamme', label: 'Coller à la gamme', icon: 'fa-magnet', keys: 'G', disabled: !n, onSelect: snapSel },
      { id: 'comme-chante', label: 'Comme chanté', icon: 'fa-undo', keys: 'Suppr', disabled: !n, onSelect: () => asSung(selected) },
      { kind: 'sep' },
      { id: 'couper-ici', label: at ? 'Couper ici' : 'Couper au milieu', icon: 'fa-cut', keys: '3', disabled: k < 0, onSelect: () => { if (k >= 0) { const [a, b] = spanOf(k); doCut(k, at?.t ?? (a + b) / 2); } } },
      { id: 'fusionner', label: 'Fusionner avec la suivante', icon: 'fa-compress-alt', keys: 'M', disabled: !n || selected[selected.length - 1] >= notes.length - 1, onSelect: joinSelection },
      { id: 'duree-origine', label: 'Durée d’origine', icon: 'fa-arrows-alt-h', disabled: !n, onSelect: () => { let d = draftRef.current; for (const i of selected) d = { ...d, ...resetLength(elasticCtx(d), i) }; commit(d, ''); } },
      { kind: 'sep' },
      { id: 'tout-selectionner', label: 'Tout sélectionner', keys: 'Ctrl+A', onSelect: () => setSel(new Set(notes.map((_, i) => i))) },
      { id: 'corriger-tout', label: 'Corriger tout le clip…', icon: 'fa-bullseye', onSelect: () => setPop({ kind: 'all', ...anchor }) },
    ];
  };
  const viewEntries = (): (RollMenuEntry | false)[] => [
    { kind: 'section', label: 'Vue' },
    { id: 'ajuster', label: 'Tout le clip', icon: 'fa-expand', keys: 'F', onSelect: () => fitView() },
    { id: 'zoom-plus', label: 'Zoomer', icon: 'fa-search-plus', keys: 'Ctrl+molette', keepOpen: true, onSelect: () => setView(v => clampView({ ...v, pps: v.pps * 1.5 })) },
    { id: 'zoom-moins', label: 'Dézoomer', icon: 'fa-search-minus', keepOpen: true, onSelect: () => setView(v => clampView({ ...v, pps: v.pps / 1.5 })) },
    { kind: 'sep' },
    { id: 'courbe', label: 'Courbe chantée', checked: showSung, keepOpen: true, onSelect: () => setShowSung(s => !s) },
    { id: 'onde', label: 'Forme d’onde', checked: showWave, keepOpen: true, onSelect: () => setShowWave(s => !s) },
    { id: 'ecoute-clic', label: 'Écouter la note au clic', checked: audition, keepOpen: true, onSelect: () => setAudition(s => !s) },
    { kind: 'sep' },
    { kind: 'section', label: 'Gamme' },
    { id: 'gamme-chroma', label: 'Chromatique (aucune)', checked: typeof key.root !== 'number', onSelect: () => setKeyOverride({ root: undefined, scale: 'CHROMATIC' }) },
    ...(typeof projectKey === 'number' && projectScale ? [{ id: 'gamme-projet', label: `Gamme du projet : ${keyLabelFr(projectKey, projectScale)}`, checked: !keyOverride, onSelect: () => setKeyOverride(null) } as RollMenuEntry] : []),
    { id: 'gamme-choisir', label: 'Autre gamme…', onSelect: () => setPop({ kind: 'all', x: menu?.anchor.x ?? 200, y: menu?.anchor.y ?? 200 }) },
  ];

  // Clavier (quand l'éditeur a la main : dernier clic dedans, ou il vient de s'ouvrir).
  useEffect(() => { if (open) activeRef.current = true; }, [open, clipId]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { activeRef.current = !!rootRef.current?.contains(e.target as Node) || !!(e.target as HTMLElement)?.closest?.('[data-nova-roll-menu]'); };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    // Une fenêtre ouverte par-dessus (palette, Track Presets, export…) : ses touches sont à elle.
    // Avant, Échap fermait le panneau du dessous et la fenêtre restait ouverte (qa/protools_ecarts).
    if (windowAbove(rootRef.current)) return;
    // Un menu ou un réglage ouvert : Échap le ferme (et seulement lui).
    if (e.key === 'Escape' && (menu || pop)) { e.preventDefault(); e.stopPropagation(); if (menu) setMenu(null); else setPop(null); return; }
    if (menu) return;
    if (!activeRef.current || status !== 'ready') return;
    const t = e.target as HTMLElement;
    if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.tagName === 'SELECT' || t?.isContentEditable) return;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    const k = e.key;
    if (k === 'Escape') { stop(); if (sel.size) setSel(new Set()); else onClose(); return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'a') { stop(); setSel(new Set(notes.map((_, i) => i))); return; }
    if (e.ctrlKey || e.metaKey) return; // Ctrl+Z / Ctrl+Y : annuler / rétablir du projet
    if (k === 'ArrowUp' || k === 'ArrowDown') { if (!selected.length) return; stop(); nudgeSel(k === 'ArrowUp' ? 1 : -1, e.shiftKey); return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      if (!notes.length) return; stop();
      const cur = selected.length ? (k === 'ArrowLeft' ? selected[0] : selected[selected.length - 1]) : -1;
      const nx = clamp(cur < 0 ? 0 : cur + (k === 'ArrowLeft' ? -1 : 1), 0, notes.length - 1);
      setSel(new Set([nx])); auditionNote(nx);
      return;
    }
    if (k === 'Delete' || k === 'Backspace') { if (!selected.length) return; stop(); asSung(selected); return; }
    if (epure) return;
    const l = k.toLowerCase();
    if (l === '1' || l === '2' || l === '3') { stop(); setTool(l === '1' ? 'pitch' : l === '2' ? 'time' : 'cut'); return; }
    if (l === 'g') { stop(); snapSel(); return; }
    if (l === 'm') { stop(); joinSelection(); return; }
    if (l === 'l') { stop(); toggleLoop(); return; }
    if (l === 'o') { stop(); toggleOrig(); return; }
    if (l === 'f') { stop(); fitView(); return; }
    if (l === 'q') { stop(); const r = rootRef.current?.getBoundingClientRect(); setPop({ kind: 'correct', x: (r?.left ?? 0) + 200, y: (r?.top ?? 0) + 60 }); return; }
    if (l === 'r' || k === 'Enter') { if (!selected.length) return; stop(); const r = rootRef.current?.getBoundingClientRect(); setPop({ kind: 'settings', x: (r?.left ?? 0) + 200, y: (r?.top ?? 0) + 60 }); }
  };
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [open]);

  // ----- Hauteur du panneau -----
  const gripRef = useRef<{ y: number; h: number } | null>(null);
  const onGripDown = (e: React.PointerEvent) => { e.currentTarget.setPointerCapture(e.pointerId); gripRef.current = { y: e.clientY, h: height }; };
  const onGripMove = (e: React.PointerEvent) => { const g = gripRef.current; if (g) setHeight(clamp(g.h - (e.clientY - g.y), 220, Math.max(240, window.innerHeight - 160))); };
  const onGripUp = () => { gripRef.current = null; try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* */ } };

  if (!open) return null;

  // ----- Panneaux de réglage -----
  const firstSel = selected.length ? draft.edits[selected[0]] || NEUTRAL_EDIT : null;
  const firstNote = selected.length ? notes[selected[0]] : null;
  const sliderRow = (s: Slider) => (
    <label key={s.testId} className="np-row" title={s.hint}>
      <span className="text-[11px] font-bold">{s.label}</span>
      <input type="range" min={s.min} max={s.max} step={s.step} value={s.value} aria-label={s.label} data-testid={s.testId}
        onChange={ev => s.onLive(Number(ev.target.value))}
        onPointerUp={() => commit(draftRef.current, '')}
        onKeyUp={ev => { if (ev.key.startsWith('Arrow') || ev.key === 'Home' || ev.key === 'End' || ev.key.startsWith('Page')) commit(draftRef.current, ''); }}
        onDoubleClick={() => s.onReset?.()} />
      <span className="np-val" data-testid={`${s.testId}-value`}>{s.fmt(s.value)}</span>
    </label>
  );
  const settingsPanel = firstSel && firstNote && (() => {
    const live = (fn: (n: PitchNote, e: NoteEdit) => NoteEdit) => editNotes(selected, fn, true);
    const cpct = centerPctOf(firstNote, firstSel, key);
    const [a, b] = spanOf(selected[0]);
    const rows: Slider[] = [
      { label: 'Centre', value: cpct ?? 0, min: 0, max: 100, step: 1, fmt: v => (cpct === null ? 'déplacée' : `${v} %`), testId: 'pitch-center', hint: 'Ramène la note vers la note de la gamme la plus proche (0 % = comme chantée, 100 % = pile)', onLive: v => live((n, e) => withCenter(n, e, v, key)) },
      { label: 'Dérive', value: Math.round(firstSel.drift * 100), min: 0, max: 100, step: 1, fmt: v => `${v} %`, testId: 'pitch-drift', hint: 'Redresse la note qui monte ou descend lentement pendant qu’elle est tenue', onLive: v => live((_, e) => ({ ...e, drift: v / 100 })) },
      { label: 'Vibrato', value: Math.round(firstSel.vibrato * 100), min: 0, max: 200, step: 5, fmt: v => `${v} %`, testId: 'pitch-vibrato', hint: '0 % : supprimé · 100 % : intact · 200 % : doublé', onLive: v => live((_, e) => ({ ...e, vibrato: v / 100 })) },
      { label: 'Transition', value: firstSel.transitionMs ?? NATURAL_TRANSITION_MS, min: 0, max: 300, step: 5, fmt: v => (firstSel.transitionMs === undefined ? 'naturelle' : `${v} ms`), testId: 'pitch-transition', hint: 'Glissé depuis la note d’avant : 0 = saut net, plus long = glissé', onLive: v => live((_, e) => ({ ...e, transitionMs: v })), onReset: () => editNotes(selected, (_, e) => { const o = { ...e }; delete o.transitionMs; return o; }) },
      { label: 'Formant', value: firstSel.formant ?? 0, min: -FORMANT_RANGE, max: FORMANT_RANGE, step: 0.5, fmt: v => (!v ? 'timbre gardé' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1).replace('.', ',')} dt`), testId: 'pitch-formant', hint: 'Timbre de la note sans changer sa hauteur : à droite plus fin, à gauche plus épais. Le timbre est gardé tout seul quand tu bouges la hauteur.', onLive: v => live((_, e) => ({ ...e, formant: clampFormant(v) })), onReset: () => editNotes(selected, (_, e) => { const o = { ...e }; delete o.formant; return o; }) },
      { label: 'Gain', value: firstSel.gainDb ?? 0, min: GAIN_MIN_DB, max: GAIN_MAX_DB, step: 0.5, fmt: v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1).replace('.', ',')} dB`, testId: 'pitch-gain', hint: 'Niveau de la note (fondus de 10 ms aux bords)', onLive: v => live((_, e) => ({ ...e, gainDb: clampGain(v) })), onReset: () => editNotes(selected, (_, e) => { const o = { ...e }; delete o.gainDb; return o; }) },
    ];
    return (
      <div className="space-y-1" data-testid="pitch-settings">
        <div className="mb-1 flex items-center gap-2">
          <b className="text-[12px]">{selected.length > 1 ? `${selected.length} notes` : 'Note'}</b>
          <span className="np-soft text-[11px]">{fmtDuration(b - a, bpm)}</span>
        </div>
        <NumberField label="Hauteur" testId="pitch-number" value={fmtPitch(targetCenter(firstNote, firstSel))} placeholder="La3 +4 c"
          hint="Écris une note (« La3 +4 », « Sol#2 −10 c », « A3+4 »), un nombre MIDI (57,04) ou un écart (« +2 c », « −1 dt »)"
          onSubmit={txt => {
            const cur = targetCenter(firstNote, firstSel);
            const m = parsePitch(txt, cur);
            if (m === null) return false;
            const rel = /^[+−-]/.test(txt.trim());
            editNotes(selected, (n, e) => withTarget(n, e, rel ? targetCenter(n, e) + (m - cur) : m));
            return true;
          }} />
        <NumberField label="Durée" testId="pitch-duration" value={`${Math.round((b - a) * 1000)} ms`} placeholder="420 ms, 1/8, 2 t"
          hint="Durée de la note : en millisecondes (420 ms), en secondes (0,42 s), en temps (2 t) ou en fraction de ronde (1/8)"
          onSubmit={txt => {
            const sec = parseDuration(txt, bpm);
            if (sec === null || sec <= 0) return false;
            const d = draftRef.current;
            const c = elasticCtx(d);
            const r = selected.length > 1 ? stretchGroup(c, selected, sec / Math.max(1e-3, b - a)) : stretchEnd(c, selected[0], a + sec);
            applyElastic(d, r, selected, false);
            return true;
          }} />
        {rows.map(sliderRow)}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="pr-cap" data-testid="pitch-reset" onClick={() => asSung(selected)} title="Remet ces notes comme chantées (Suppr)">Comme chanté</button>
        </div>
      </div>
    );
  })();
  const correctPanel = (scopeAll: boolean) => <CorrectPanel all={scopeAll} count={scopeAll ? notes.length : (selected.length || notes.length)} draft={draft}
    keyChoice={key} onKey={k => setKeyOverride(k)}
    onApply={(c, d) => { const idx = scopeAll || !selected.length ? notes.map((_, i) => i) : selected; const cur = draftRef.current; const manual = new Set(cur.manual); idx.forEach(i => manual.add(i)); commit({ ...cur, edits: correctNotes(notes, cur.edits, idx, key, c, d), manual }, ''); setPop(null); }}
    onGlobal={(a, s, live) => globalCorrect(a, s, live)} />;

  const busy = status === 'loading';
  const clipName = clip?.name || 'clip';
  const stateMsg = status === 'loading' ? `J’écoute ta voix et je la découpe en notes… ${Math.round(progress * 100)} %`
    : status === 'error' ? error
    : status === 'empty' ? 'Aucune note chantée trouvée dans ce clip (parlé, souffle ou niveau trop bas). Essaie sur un passage chanté.'
    : '';
  const selInfo = selected.length === 1 && firstNote && firstSel ? `${fmtPitch(targetCenter(firstNote, firstSel))} · ${fmtDuration(spanOf(selected[0])[1] - spanOf(selected[0])[0], bpm)}`
    : selected.length > 1 ? `${selected.length} notes` : notes.length ? (epure ? 'Glisse une note vers le haut ou le bas' : 'Clique une note · Ctrl+A : toutes') : '';
  const geom = JSON.stringify(drawNotes.map((n, i) => ({ i, x0: Math.round(xOf(view, n.a)), x1: Math.round(xOf(view, n.b)), y: Math.round(yOf(view, n.m)), m: +n.m.toFixed(4), a: +n.a.toFixed(4), b: +n.b.toFixed(4) })));

  const simpleBar = (
    <SimpleBar amount={draft.amount} style={draft.style} stacked={phone} keyText={typeof key.root === 'number' ? `${keyLabelFr(key.root, key.scale)}${keyGuessed ? ' (devinée)' : ''}` : 'chromatique'}
      onLive={(a, s) => globalCorrect(a, s, true)} onCommit={(a, s) => globalCorrect(a, s, false)} />
  );
  const header = (
    <div className="np-bar flex min-h-[44px] flex-wrap items-center gap-2 px-2 py-1" data-testid="pitch-bar">
      <span className="mr-1 min-w-0 truncate text-[12px] font-black" id="pitch-title" title={clipName}>
        🎵 Notes de la voix <span className="np-soft font-semibold">· {clipName}</span>
      </span>
      {!epure && status === 'ready' && (
        <>
          <button type="button" className="pr-cap pr-drop" data-testid="pitch-tool" data-tool={tool} aria-haspopup="menu" title={TOOLS.find(t => t.id === tool)!.hint}
            onClick={ev => openMenuAt('outil', 'Outil', ev.currentTarget, toolEntries())}>
            <i className={`fas ${TOOLS.find(t => t.id === tool)!.icon}`} aria-hidden /> {TOOLS.find(t => t.id === tool)!.label}{tool === 'time' && ripple ? ' · décale la suite' : ''} <i className="fas fa-chevron-down" aria-hidden />
          </button>
          <button type="button" className="pr-cap pr-drop" data-testid="pitch-magnet" aria-haspopup="menu"
            title={tool === 'time' ? 'Grille du projet pour l’élastique (Alt : sans grille)' : 'Aimant de hauteur (Alt : sans aimant, Maj : au plus fin)'}
            onClick={ev => openMenuAt('aimant', 'Aimant', ev.currentTarget, magnetEntries())}>
            <i className="fas fa-magnet" aria-hidden /> {tool === 'time' ? `Grille : ${GRIDS.find(g => g.v === grid)?.label}` : `Aimant : ${MAGNETS.find(m => m.id === magnet)!.label.toLowerCase()}`} <i className="fas fa-chevron-down" aria-hidden />
          </button>
          <button type="button" className="pr-cap pr-drop" data-testid="pitch-menu-notes" aria-haspopup="menu"
            onClick={ev => { const r = ev.currentTarget.getBoundingClientRect(); openMenuAt('notes', 'Notes', ev.currentTarget, noteEntries({ x: r.left, y: r.bottom + 6 })); }}>
            Notes <i className="fas fa-chevron-down" aria-hidden />
          </button>
          <button type="button" className="pr-cap pr-drop" data-testid="pitch-menu-view" aria-haspopup="menu" onClick={ev => openMenuAt('vue', 'Vue', ev.currentTarget, viewEntries())}>
            Vue <i className="fas fa-chevron-down" aria-hidden />
          </button>
        </>
      )}
      {epure && !phone && status === 'ready' && simpleBar}
      <span className="mr-auto" />
      {status === 'ready' && !phone && (
        <>
          <span className="np-soft hidden text-[11px] sm:inline" data-testid="pitch-render-state" aria-live="polite">{renderBusy ? '⏳ Calcul du son…' : '✓ À jour'}</span>
          <button type="button" className="pr-cap" data-testid="pitch-loop" aria-pressed={playing === 'loop'} onClick={toggleLoop}
            title="Écoute la sélection en boucle, retouchée (L). Sans sélection : tout le clip.">{playing === 'loop' ? '■' : '▶'} {selected.length ? 'Sélection' : 'Écouter'}</button>
          <button type="button" className="pr-cap" data-testid="pitch-orig" aria-pressed={playing === 'orig'} onClick={toggleOrig}
            title="Écoute la même partie telle que chantée (O)">{playing === 'orig' ? '■' : '▶'} Original</button>
          {epure && <button type="button" className="pr-cap" data-testid="pitch-full" onClick={() => setEpure(false)} title="Toutes les retouches, note par note">Note par note…</button>}
        </>
      )}
      <button type="button" className="pr-cap" onClick={onClose} aria-label="Fermer l’éditeur de notes" data-testid="pitch-close">✕</button>
      {phone && status === 'ready' && (
        <div className="flex w-full flex-col gap-2 pb-1">
          {epure && simpleBar}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="pr-cap flex-1" data-testid="pitch-loop" aria-pressed={playing === 'loop'} onClick={toggleLoop}>{playing === 'loop' ? '■' : '▶'} {selected.length ? 'Sélection' : 'Écouter'}</button>
            <button type="button" className="pr-cap flex-1" data-testid="pitch-orig" aria-pressed={playing === 'orig'} onClick={toggleOrig}>{playing === 'orig' ? '■' : '▶'} Original</button>
            {epure && <button type="button" className="pr-cap flex-1" data-testid="pitch-full" onClick={() => setEpure(false)}>Note par note…</button>}
            <span className="np-soft w-full text-[11px]" data-testid="pitch-render-state" aria-live="polite">{renderBusy ? '⏳ Calcul du son…' : '✓ À jour · rien n’est effacé, ta prise d’origine est gardée'}</span>
          </div>
        </div>
      )}
    </div>
  );

  const content = (
    <div ref={rootRef} data-nova-pitch="" data-testid="pitch-editor" data-mode={phone ? 'phone' : epure ? 'simple' : 'full'}
      role="region" aria-labelledby="pitch-title"
      className={phone ? 'fixed inset-0 z-[700] flex flex-col pb-[env(safe-area-inset-bottom)]' : 'flex flex-col border-t'}
      style={phone ? undefined : { height, borderColor: 'var(--border-dim, rgba(255,255,255,0.08))' }}>
      {!phone && <div className="np-grip" role="separator" aria-orientation="horizontal" aria-label="Hauteur du panneau" onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} />}
      {header}
      {status === 'loading' && <div className="np-progress mx-2 my-1" data-testid="pitch-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
      <div ref={boxRef} className="relative min-h-0 flex-1 select-none overflow-hidden" data-testid="pitch-grid">
        <div className="absolute left-0 right-0 top-0 flex" style={{ height: RULER_H }}>
          <div style={{ width: KEYS_W }} className="np-soft shrink-0 text-center text-[9px] leading-[18px]">{keyLabelFr(key.root, key.scale) || '—'}</div>
          <Ruler w={box.w - KEYS_W} view={view} grid={gridLines} toProject={toProject} beatSec={beatSec} />
        </div>
        <div className="absolute bottom-0 left-0 right-0 flex" style={{ top: RULER_H }}>
          <canvas ref={keysRef} className="shrink-0" aria-hidden="true" />
          {voice && (
            <canvas ref={canvasRef} role="img" data-testid="pitch-canvas" data-geom={geom} data-sung={JSON.stringify(notes.map(n => +n.center.toFixed(4)))} data-tool={tool}
              aria-label={`Notes de ${clipName} dans un piano roll, avec la courbe de hauteur`}
              className="block touch-none"
              style={{ cursor: tool === 'cut' && !epure ? 'crosshair' : tool === 'time' && !epure ? 'ew-resize' : 'ns-resize' }}
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
              onPointerCancel={e => { pointers.current.delete(e.pointerId); drag.current = null; pinch.current = null; setRubber(null); }}
              onPointerLeave={() => setCutX(null)}
              onDoubleClick={onDoubleClick}
              onContextMenu={e => {
                e.preventDefault();
                if (epure) return;
                const { x, y } = local(e);
                const i = hitNote(x, y, false);
                if (i >= 0 && !sel.has(i)) setSel(new Set([i]));
                openMenuAt('clic-droit', 'Note', { x: e.clientX, y: e.clientY }, noteEntries({ x: e.clientX, y: e.clientY }, i >= 0 ? { k: i, t: tOfX(view, x) } : undefined));
              }} />
          )}
        </div>
        {stateMsg && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-[13px]" role="status" data-testid="pitch-status">
            {busy && <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />}
            {stateMsg}
          </div>
        )}
      </div>
      <div className={`np-bar flex min-h-[30px] items-center gap-3 border-t px-2 text-[11px] ${phone ? '' : 'pr-32'}`} style={{ borderColor: 'var(--pr-panel-line)' }} data-testid="pitch-selection">
        <span role="status" className="min-w-0 truncate">{selInfo}</span>
        {selected.length > 0 && !epure && <button type="button" className="pr-cap" onClick={ev => { const r = ev.currentTarget.getBoundingClientRect(); setPop({ kind: 'settings', x: r.left, y: r.top }); }} data-testid="pitch-open-settings">Réglages…</button>}
        <span className="np-soft ml-auto hidden md:inline">{epure ? 'Rien n’est effacé : ta prise d’origine est gardée · Ctrl+Z annule' : '↑↓ demi-ton · Maj+↑↓ 2 cents · Alt sans aimant · Ctrl+Z annule'}</span>
      </div>
      {menu && <RollMenu name={menu.name} label={menu.label} anchor={menu.anchor} entries={menu.entries} onClose={() => setMenu(null)} />}
      {pop && (
        <Popover x={pop.x} y={pop.y} onClose={() => setPop(null)} label={pop.kind === 'settings' ? 'Réglages de la note' : 'Corriger'}>
          {pop.kind === 'settings' ? settingsPanel || <p className="np-soft">Choisis d’abord une note.</p> : correctPanel(pop.kind === 'all')}
        </Popover>
      )}
    </div>
  );

  if (phone) return content;
  const slot = typeof document !== 'undefined' ? document.getElementById('nova-pitch-dock') : null;
  if (slot) return createPortal(content, slot);
  return <div className="fixed bottom-16 left-0 right-0 z-[260]">{content}</div>;
};

// ---------------------------------------------------------------------------

const Ruler: React.FC<{ w: number; view: PitchView; grid: { t: number; kind: 0 | 1 | 2 }[]; toProject: (t: number) => number; beatSec: number }> = ({ w, view, grid, toProject, beatSec }) => (
  <div className="relative min-w-0 flex-1 overflow-hidden text-[9px] np-soft" aria-hidden style={{ width: w }}>
    {grid.filter(g => g.kind === 0 || (g.kind === 1 && beatSec * view.pps > 40)).map(g => {
      const x = xOf(view, g.t);
      if (x < -40 || x > w) return null;
      const beats = toProject(g.t) / beatSec;
      const bar = Math.floor(beats / 4 + 1e-6) + 1, beat = Math.round(beats - (bar - 1) * 4) + 1;
      return <span key={`${g.t.toFixed(4)}`} className="absolute top-0 leading-[18px]" style={{ left: x + 3 }}>{g.kind === 0 ? bar : `${bar}.${beat}`}</span>;
    })}
  </div>
);

const Popover: React.FC<{ x: number; y: number; label: string; onClose: () => void; children: React.ReactNode }> = ({ x, y, label, onClose, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), y: y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height - 8) : y });
  }, [x, y]);
  return (
    <>
      <div className="fixed inset-0 z-[289]" onPointerDown={e => { e.stopPropagation(); onClose(); }} />
      <div ref={ref} role="dialog" aria-label={label} data-nova-roll-menu="pitch-pop" className="np-pop fixed z-[300] w-[340px] max-w-[calc(100vw-16px)]" style={{ left: pos.x, top: pos.y }}>
        {children}
      </div>
    </>
  );
};

const NumberField: React.FC<{ label: string; value: string; placeholder: string; hint: string; testId: string; onSubmit: (txt: string) => boolean }> = ({ label, value, placeholder, hint, testId, onSubmit }) => {
  const [txt, setTxt] = useState(value);
  const [bad, setBad] = useState(false);
  useEffect(() => { setTxt(value); setBad(false); }, [value]);
  return (
    <label className="np-row" title={hint}>
      <span className="text-[11px] font-bold">{label}</span>
      <input className="np-field" value={txt} placeholder={placeholder} aria-label={label} data-testid={testId} aria-invalid={bad}
        onChange={e => { setTxt(e.target.value); setBad(false); }}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (!onSubmit(txt)) setBad(true); } if (e.key === 'Escape') { setTxt(value); (e.target as HTMLInputElement).blur(); } }} />
      <span className={`text-[10px] ${bad ? 'text-rose-400' : 'np-soft'}`}>{bad ? 'illisible' : 'Entrée'}</span>
    </label>
  );
};

const SimpleBar: React.FC<{ amount: number; style: CorrectStyle; keyText: string; stacked?: boolean; onLive: (a: number, s: CorrectStyle) => void; onCommit: (a: number, s: CorrectStyle) => void }> = ({ amount, style, keyText, stacked, onLive, onCommit }) => (
  <div className={`flex min-w-0 flex-1 gap-2 ${stacked ? 'w-full flex-col items-stretch' : 'flex-wrap items-center'}`} data-testid="pitch-global">
    <label className={`flex items-center gap-2 ${stacked ? 'w-full flex-wrap' : 'min-w-[260px] flex-1'}`} title="Ramène chaque note vers la note de la gamme la plus proche. Les notes retouchées à la main ne bougent pas.">
      <span className="whitespace-nowrap text-[12px] font-black">🎯 Corriger la justesse</span>
      <input type="range" min={0} max={100} step={1} value={amount} aria-label="Dosage de la correction" data-testid="pitch-amount"
        onChange={e => onLive(Number(e.target.value), style)} onPointerUp={e => onCommit(Number((e.target as HTMLInputElement).value), style)}
        onKeyUp={e => onCommit(Number((e.target as HTMLInputElement).value), style)}
        className="min-w-[110px] flex-1" style={{ accentColor: 'var(--pr-accent)', minHeight: 32 }} />
      <span className="w-12 shrink-0 text-right font-mono text-[12px] font-black" data-testid="pitch-amount-value">{amount} %</span>
    </label>
    <div role="radiogroup" aria-label="Style de correction" className={`pr-seg ${stacked ? 'self-start' : ''}`}>
      {([['naturel', 'Naturel', 'Garde la vie de ta voix : glissades, vibrato'], ['robot', 'Robot', 'Notes bien droites, sauts nets : l’effet rap']] as const).map(([id, label, hint]) => (
        <button key={id} type="button" role="radio" aria-checked={style === id} aria-pressed={style === id} title={hint} data-testid={`pitch-style-${id}`} className="pr-cap"
          onClick={() => onCommit(amount || 100, id)}>{label}</button>
      ))}
    </div>
    <span className="np-soft text-[11px]">Gamme : {keyText}</span>
  </div>
);

const CorrectPanel: React.FC<{ all: boolean; count: number; draft: Draft; keyChoice: { root?: number; scale?: string }; onKey: (k: { root?: number; scale?: string }) => void; onApply: (centerPct: number, driftPct: number) => void; onGlobal: (a: number, s: CorrectStyle, live: boolean) => void }> = ({ all, count, draft, keyChoice, onKey, onApply, onGlobal }) => {
  const [c, setC] = useState(100);
  const [d, setD] = useState(50);
  return (
    <div className="space-y-2" data-testid="pitch-correct">
      <b className="text-[12px]">{all ? 'Corriger tout le clip' : `Corriger ${count > 1 ? `ces ${count} notes` : 'cette note'}`}</b>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="np-soft">Gamme</span>
        <select className="np-field" aria-label="Tonique" value={typeof keyChoice.root === 'number' ? String(keyChoice.root) : ''} data-testid="pitch-key-root"
          onChange={e => onKey(e.target.value === '' ? { root: undefined, scale: 'CHROMATIC' } : { root: Number(e.target.value), scale: keyChoice.scale && keyChoice.scale !== 'CHROMATIC' ? keyChoice.scale : 'MINOR' })}>
          <option value="">— chromatique</option>
          {NOTE_NAMES_FR.map((n, i) => <option key={n} value={i}>{n}</option>)}
        </select>
        {typeof keyChoice.root === 'number' && (
          <select className="np-field" aria-label="Gamme" value={keyChoice.scale || 'MINOR'} data-testid="pitch-key-scale" onChange={e => onKey({ root: keyChoice.root, scale: e.target.value })}>
            {SCALE_CHOICES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        )}
      </div>
      <label className="np-row" title="0 % : comme chanté · 100 % : chaque note pile sur la note de la gamme la plus proche">
        <span className="text-[11px] font-bold">Centre</span>
        <input type="range" min={0} max={100} value={c} onChange={e => setC(Number(e.target.value))} data-testid="pitch-correct-center" aria-label="Centre" />
        <span className="np-val">{c} %</span>
      </label>
      <label className="np-row" title="Redresse la dérive lente des notes tenues">
        <span className="text-[11px] font-bold">Dérive</span>
        <input type="range" min={0} max={100} value={d} onChange={e => setD(Number(e.target.value))} data-testid="pitch-correct-drift" aria-label="Dérive" />
        <span className="np-val">{d} %</span>
      </label>
      <div className="flex justify-end">
        <button type="button" className="pr-cap" data-on="true" data-testid="pitch-correct-apply" onClick={() => onApply(c, d)}>Corriger</button>
      </div>
      {all && (
        <div className="border-t pt-2" style={{ borderColor: 'var(--pr-menu-line)' }}>
          <SimpleBar amount={draft.amount} style={draft.style} keyText={keyLabelFr(keyChoice.root, keyChoice.scale) || 'chromatique'} onLive={(a, s) => onGlobal(a, s, true)} onCommit={(a, s) => onGlobal(a, s, false)} />
        </div>
      )}
    </div>
  );
};

export default PitchEditor;
