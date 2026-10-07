import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, Track } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import type { PitchNote, PitchTrack } from '../utils/pitchAnalysis';
import {
  autoCorrect, centsFromScale, correctionCurve, CorrectStyle, guessKey, hasEdits, isNeutral, NATURAL_TRANSITION_MS,
  NEUTRAL_EDIT, NoteEdit, nudgeEdit, snapEdit, targetCenter, targetPitch,
} from '../utils/pitchCorrect';
import {
  analyzeRegion, clipRegion, correctedClipPatch, editingSource, editsForNotes, manualNotes, renderRegion, revertClipPatch, storeEdits,
} from '../utils/pitchEdit';
import { isInScale, keyLabelFr, noteNameFr, NOTE_NAMES_FR, SCALE_CHOICES } from '../utils/scales';

/**
 * Justesse note par note (V19) : l'éditeur, comme Flex Pitch (Logic),
 * Melodyne ou le Pitch Editor de FL Studio.
 *
 * La voix du clip est découpée en notes (blocs sur une grille de piano), avec
 * la vraie courbe de hauteur par-dessus ; la gamme du projet est surlignée.
 * Note par note : monter / descendre (demi-ton ou au cent près), coller à la
 * gamme, redresser la dérive, vibrato, transition. Pour tout le clip :
 * « Corriger tout dans la gamme », dosé de 0 à 100 %, naturel ou robot.
 *
 * Rien n'est détruit : « Appliquer » rend un nouveau son (même durée,
 * formants gardés), la prise d'origine est gardée ; Ctrl+Z ou « Revenir à la
 * prise d'origine » reviennent en arrière. Sur téléphone : version simple
 * (tout corriger dans la gamme, avec le dosage).
 */

interface Props {
  open: boolean;
  trackId?: string;
  clipId?: string;
  tracks: Track[];
  projectKey?: number;
  projectScale?: string;
  /** Applique les changements du clip (une étape d'annulation). */
  onApply: (trackId: string, clipId: string, patch: Partial<Clip>, message: string) => void;
  onClose: () => void;
}

type Status = 'loading' | 'ready' | 'rendering' | 'error' | 'empty';

const bufferOf = (id?: string) => (id ? audioBufferRegistry.get(id) : undefined);
const fmtCents = (c: number) => `${c > 0 ? '+' : c < 0 ? '−' : '±'}${Math.abs(Math.round(c))} ct`;
/** Écart à la gamme lisible : ✓, « +38 ct », ou « hors gamme » (note sur un demi-ton hors de la gamme). */
const scaleTag = (c: number) => (Math.abs(c) >= 50 ? 'hors gamme' : Math.abs(c) >= 3 ? fmtCents(c) : '✓');
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Couleur d'une note selon sa justesse (écart à la gamme, en cents). */
const noteColor = (cents: number) => (Math.abs(cents) <= 8 ? '#22d3ee' : Math.abs(cents) <= 20 ? '#facc15' : '#fb7185');

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

const PitchEditor: React.FC<Props> = ({ open, trackId, clipId, tracks, projectKey, projectScale, onApply, onClose }) => {
  const phone = usePhone();
  const track = tracks.find(t => t.id === trackId);
  const clip = track?.clips.find(c => c.id === clipId);

  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState('');
  const [analysis, setAnalysis] = useState<{ track: PitchTrack; notes: PitchNote[] } | null>(null);
  const [source, setSource] = useState<{ buffer: AudioBuffer; bufferId: string; offset: number; fromOriginal: boolean; region: { start: number; end: number } } | null>(null);
  const [edits, setEdits] = useState<(NoteEdit | undefined)[]>([]);
  const [manual, setManual] = useState<Set<number>>(new Set());
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [amount, setAmount] = useState(0);
  const [style, setStyle] = useState<CorrectStyle>('naturel');
  const [fine, setFine] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [key, setKey] = useState<{ root?: number; scale?: string; guessed?: boolean }>({});
  const [playing, setPlaying] = useState<null | 'avant' | 'apres'>(null);
  const undoRef = useRef<{ edits: (NoteEdit | undefined)[]; manual: Set<number>; amount: number; style: CorrectStyle }[]>([]);
  const renderCache = useRef<{ sig: string; buffer: AudioBuffer } | null>(null);
  const playRef = useRef<{ node: AudioBufferSourceNode; startedAt: number; from: number; ctx: AudioContext } | null>(null);
  const [playhead, setPlayhead] = useState<number | null>(null);

  // ----- Ouverture : analyse du clip (dans un worker) -----
  useEffect(() => {
    if (!open || !clip) return;
    let alive = true;
    setStatus('loading'); setError(''); setAnalysis(null); setSel(new Set()); setManual(new Set());
    undoRef.current = []; renderCache.current = null;
    const src = editingSource(clip, id => audioBufferRegistry.has(id));
    const buffer = bufferOf(src.bufferId);
    if (!buffer || !src.bufferId) { setStatus('error'); setError("Le son de ce clip n'est pas chargé : lance la lecture une fois puis réessaie."); return; }
    const region = clipRegion({ offset: src.offset, duration: clip.duration }, buffer.duration);
    setSource({ buffer, bufferId: src.bufferId, offset: src.offset, fromOriginal: src.fromOriginal, region });
    analyzeRegion(buffer, region.start, region.end).then(res => {
      if (!alive) return;
      if (!res.notes.length) { setStatus('empty'); setAnalysis(res); return; }
      setAnalysis(res);
      const pe = src.fromOriginal ? clip.pitchEdit : undefined;
      const restored = editsForNotes(res.notes, pe?.edits, region.start);
      setEdits(restored);
      setManual(manualNotes(res.notes, pe?.edits, region.start));
      setAmount(pe?.amount !== undefined ? Math.round(pe.amount * 100) : 0);
      setStyle(pe?.style || 'naturel');
      if (typeof projectKey === 'number' && projectScale) setKey({ root: projectKey, scale: projectScale });
      else { const g = guessKey(res.notes); setKey(g ? { ...g, guessed: true } : { root: undefined, scale: 'CHROMATIC' }); }
      setStatus('ready');
    }).catch(e => { if (alive) { setStatus('error'); setError(`Analyse impossible : ${e?.message || e}`); } });
    return () => { alive = false; };
    // Analyse refaite seulement à l'ouverture (ou si on change de clip).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clipId, trackId]);

  const stopPreview = useCallback(() => {
    const p = playRef.current;
    if (p) { try { p.node.onended = null; p.node.stop(); } catch { /* déjà arrêté */ } }
    playRef.current = null;
    setPlaying(null); setPlayhead(null);
  }, []);
  useEffect(() => () => stopPreview(), [stopPreview]);
  useEffect(() => { if (!open) stopPreview(); }, [open, stopPreview]);

  const notes = analysis?.notes || [];
  const keyArg = useMemo(() => ({ root: key.root, scale: key.scale }), [key.root, key.scale]);

  // ----- Modifications (avec annulation interne) -----
  const snapshot = useCallback(() => {
    undoRef.current.push({ edits: edits.slice(), manual: new Set(manual), amount, style });
    if (undoRef.current.length > 100) undoRef.current.shift();
  }, [edits, manual, amount, style]);
  const undo = useCallback(() => {
    const s = undoRef.current.pop();
    if (!s) return;
    setEdits(s.edits); setManual(s.manual); setAmount(s.amount); setStyle(s.style);
  }, []);

  const editNotes = useCallback((idx: number[], fn: (n: PitchNote, e: NoteEdit) => NoteEdit, push = true) => {
    if (!idx.length) return;
    if (push) snapshot();
    setEdits(prev => {
      const next = prev.slice();
      idx.forEach(i => { next[i] = fn(notes[i], prev[i] || NEUTRAL_EDIT); });
      return next;
    });
    setManual(prev => { const s = new Set(prev); idx.forEach(i => s.add(i)); return s; });
  }, [notes, snapshot]);

  /** « Corriger tout » : recalcule les notes non retouchées à la main. */
  const applyGlobal = useCallback((a: number, st: CorrectStyle, k = keyArg) => {
    const auto = autoCorrect(notes, k, a / 100, st);
    setEdits(prev => notes.map((_, i) => (manual.has(i) ? prev[i] : a > 0 ? auto[i] : undefined)));
  }, [notes, manual, keyArg]);

  const selected = useMemo(() => Array.from(sel).filter(i => i < notes.length).sort((a, b) => a - b), [sel, notes.length]);
  const firstSel = selected.length ? edits[selected[0]] || NEUTRAL_EDIT : null;

  const curve = useMemo(() => (analysis && notes.length ? correctionCurve(analysis.track, notes, edits) : null), [analysis, notes, edits]);
  const target = useMemo(() => (analysis && curve ? targetPitch(analysis.track, curve) : null), [analysis, curve]);
  const sig = useMemo(() => JSON.stringify(edits.map(e => (e && !isNeutral(e) ? [e.shift.toFixed(4), e.drift.toFixed(3), e.vibrato.toFixed(3), e.transitionMs ?? null] : 0))), [edits]);
  const changed = hasEdits(edits);

  // ----- Rendu (aperçu = ce qui sera appliqué) -----
  const ensureRender = useCallback(async (): Promise<AudioBuffer | null> => {
    if (!analysis || !source) return null;
    if (renderCache.current?.sig === sig) return renderCache.current.buffer;
    const ctx = await getCtx();
    if (!ctx) { setError("Le moteur audio n'a pas démarré."); return null; }
    setStatus('rendering');
    try {
      const out = await renderRegion(ctx, source.buffer, source.region.start, source.region.end, analysis.track, notes, edits);
      renderCache.current = { sig, buffer: out };
      return out;
    } finally {
      setStatus('ready');
    }
  }, [analysis, source, sig, notes, edits]);

  const preview = useCallback(async (which: 'avant' | 'apres') => {
    if (playing === which) { stopPreview(); return; }
    stopPreview();
    if (!source) return;
    const ctx = await getCtx();
    if (!ctx) return;
    const buf = which === 'apres' ? await ensureRender() : null;
    // Écoute depuis la première note sélectionnée (un peu avant), sinon depuis le début du clip.
    const clipFrom = source.offset - source.region.start;
    const from = selected.length ? Math.max(0, notes[selected[0]].start - 0.3) : Math.max(0, clipFrom);
    const node = ctx.createBufferSource();
    if (which === 'apres') { if (!buf) return; node.buffer = buf; node.start(0, from); }
    else { node.buffer = source.buffer; node.start(0, source.region.start + from, source.region.end - source.region.start - from); }
    node.connect(ctx.destination);
    node.onended = () => { if (playRef.current?.node === node) stopPreview(); };
    playRef.current = { node, startedAt: ctx.currentTime, from, ctx };
    setPlaying(which);
  }, [playing, stopPreview, source, ensureRender, selected, notes]);

  // Tête de lecture de l'aperçu.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const p = playRef.current;
      if (p) setPlayhead(p.from + (p.ctx.currentTime - p.startedAt));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const apply = useCallback(async () => {
    if (!clip || !trackId || !source || !analysis) return;
    stopPreview();
    const out = await ensureRender();
    if (!out) return;
    const newBufferId = `justesse-${clip.id}-${Date.now()}`;
    audioBufferRegistry.register(out, newBufferId);
    const patch = correctedClipPatch(clip, {
      newBufferId, sourceBufferId: source.bufferId, sourceOffset: source.offset, regionStart: source.region.start,
      edits: storeEdits(notes, edits, source.region.start, manual),
      amount: amount / 100, style, at: Date.now(),
    });
    const fixedCount = edits.filter(e => e && !isNeutral(e)).length;
    onApply(trackId, clip.id, patch, `🎯 Justesse corrigée sur ${fixedCount} note${fixedCount > 1 ? 's' : ''} : la prise d'origine est gardée (Ctrl+Z pour annuler).`);
    onClose();
  }, [clip, trackId, source, analysis, stopPreview, ensureRender, notes, edits, manual, amount, style, onApply, onClose]);

  const revert = useCallback(() => {
    if (!clip || !trackId) return;
    const patch = revertClipPatch(clip, id => audioBufferRegistry.has(id));
    if (!patch) return;
    stopPreview();
    onApply(trackId, clip.id, patch, '↩️ Prise d’origine remise (Ctrl+Z pour revenir à la version corrigée).');
    onClose();
  }, [clip, trackId, stopPreview, onApply, onClose]);
  const canRevert = !!clip?.pitchEdit?.sourceBufferId && audioBufferRegistry.has(clip.pitchEdit.sourceBufferId);

  // ----- Grille (canvas) -----
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 800, h: 360 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [open, status, phone]);

  const dur = source ? source.region.end - source.region.start : 1;
  const pps = Math.max(40, (box.w / Math.max(0.5, dur)) * zoom);
  const width = Math.max(box.w, Math.ceil(dur * pps));
  const range = useMemo(() => {
    if (!analysis || !notes.length) return { lo: 48, hi: 72 };
    let lo = Infinity, hi = -Infinity;
    notes.forEach((n, i) => { const c = targetCenter(n, edits[i]); lo = Math.min(lo, n.center, c); hi = Math.max(hi, n.center, c); });
    lo = Math.floor(lo) - 3; hi = Math.ceil(hi) + 3;
    if (hi - lo < 14) { const mid = (hi + lo) / 2; lo = Math.floor(mid - 7); hi = Math.ceil(mid + 7); }
    return { lo, hi };
  }, [analysis, notes, edits]);
  const rowH = box.h / (range.hi - range.lo + 1);
  const yOf = useCallback((m: number) => (range.hi + 0.5 - m) * rowH, [range.hi, rowH]);
  const hopSec = analysis ? analysis.track.hop / analysis.track.sr : 0.005;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!open || !cv || !analysis) return;
    const dpr = window.devicePixelRatio || 1;
    const H = box.h;
    cv.width = Math.round(width * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = `${width}px`; cv.style.height = `${H}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0d10'; ctx.fillRect(0, 0, width, H);
    // Lignes de la grille : gamme surlignée, tonique plus marquée.
    for (let m = range.lo; m <= range.hi; m++) {
      const y = yOf(m) - rowH / 2;
      const inKey = typeof key.root === 'number' && isInScale(m, key.root, key.scale);
      const isRoot = typeof key.root === 'number' && ((m - key.root) % 12 + 12) % 12 === 0;
      ctx.fillStyle = isRoot ? 'rgba(34,211,238,0.13)' : inKey ? 'rgba(34,211,238,0.055)' : 'rgba(0,0,0,0.25)';
      ctx.fillRect(0, y, width, rowH);
      ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(0, y, width, 1);
    }
    // Repères de temps (toutes les 0,5 s).
    ctx.font = '10px ui-sans-serif, system-ui'; ctx.textBaseline = 'top';
    const step = pps > 160 ? 0.25 : pps > 60 ? 0.5 : 1;
    for (let t = 0; t < dur; t += step) {
      const x = t * pps;
      ctx.fillStyle = Math.abs(t - Math.round(t)) < 1e-6 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(x, 0, 1, H);
    }
    // Limites du clip (la marge autour sert aux fins de notes).
    if (source) {
      const a = (source.offset - source.region.start) * pps, b = a + (clip?.duration || 0) * pps;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, Math.max(0, a), H); ctx.fillRect(b, 0, Math.max(0, width - b), H);
    }
    // Niveau (forme d'onde discrète en bas).
    const { rmsDb, midi } = analysis.track;
    ctx.fillStyle = 'rgba(148,163,184,0.18)';
    for (let i = 0; i < rmsDb.length; i++) {
      const h = clamp((rmsDb[i] + 60) / 60, 0, 1) * H * 0.18;
      ctx.fillRect(i * hopSec * pps, H - h, Math.max(1, hopSec * pps), h);
    }
    // Notes : position d'origine en pointillé si déplacée, bloc à la hauteur visée.
    const r = Math.min(8, rowH * 0.35);
    notes.forEach((n, i) => {
      const e = edits[i];
      const x0 = n.start * pps, x1 = n.end * pps;
      const c = targetCenter(n, e);
      const cents = centsFromScale(c, key.root, key.scale);
      const h = Math.max(6, rowH * 0.72);
      if (e && Math.abs(e.shift) > 0.005) {
        ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(148,163,184,0.55)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(x0, yOf(n.center) - h / 2, x1 - x0, h, r); ctx.stroke(); ctx.setLineDash([]);
      }
      const isSel = sel.has(i);
      ctx.globalAlpha = isSel ? 0.75 : 0.45;
      ctx.fillStyle = noteColor(cents);
      ctx.beginPath(); ctx.roundRect(x0, yOf(c) - h / 2, Math.max(2, x1 - x0), h, r); ctx.fill();
      ctx.globalAlpha = 1;
      if (isSel) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke(); }
    });
    // Courbes : hauteur chantée (gris) et hauteur corrigée (cyan).
    const drawCurve = (v: Float32Array | Float32Array | null, color: string, w: number) => {
      if (!v) return;
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
      let pen = false;
      for (let i = 0; i < v.length; i++) {
        if (Number.isNaN(v[i])) { pen = false; continue; }
        const x = i * hopSec * pps, y = yOf(v[i]);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();
    };
    drawCurve(midi, 'rgba(203,213,225,0.55)', 1.2);
    if (changed) drawCurve(target, '#67e8f9', 1.8);
    // Étiquettes des notes (par-dessus les courbes) : nom et écart à la gamme.
    const fs = Math.max(9, Math.min(12, rowH * 0.55));
    ctx.font = `bold ${fs}px ui-sans-serif, system-ui`; ctx.textBaseline = 'middle';
    notes.forEach((n, i) => {
      const x0 = n.start * pps, x1 = n.end * pps;
      if (x1 - x0 < 26) return;
      const c = targetCenter(n, edits[i]);
      const cents = centsFromScale(c, key.root, key.scale);
      const label = scaleTag(cents);
      const text = x1 - x0 > 80 ? `${noteNameFr(Math.round(c))} ${label}` : label;
      const tw = ctx.measureText(text).width;
      // Au-dessus du bloc, dans un petit cartouche lisible.
      const ty = yOf(c) - Math.max(6, rowH * 0.72) / 2 - fs * 0.75;
      ctx.fillStyle = 'rgba(11,13,16,0.82)';
      ctx.beginPath(); ctx.roundRect(x0, ty - fs * 0.65, tw + 8, fs * 1.3, 4); ctx.fill();
      ctx.fillStyle = noteColor(cents);
      ctx.fillText(text, x0 + 4, ty);
    });
    // Repères de temps (secondes depuis le début du clip).
    if (source) {
      const zero = source.offset - source.region.start;
      ctx.font = '10px ui-sans-serif, system-ui'; ctx.textBaseline = 'top'; ctx.fillStyle = 'rgba(148,163,184,0.8)';
      const lab = pps > 120 ? 0.5 : pps > 40 ? 1 : 2;
      for (let t = 0; zero + t < dur; t += lab) ctx.fillText(`${(t).toFixed(lab < 1 ? 1 : 0).replace('.', ',')} s`, (zero + t) * pps + 3, 3);
    }
    if (playhead !== null) { ctx.fillStyle = '#f472b6'; ctx.fillRect(playhead * pps, 0, 2, H); }
  }, [open, analysis, notes, edits, sel, box.h, width, pps, range, rowH, yOf, key, source, clip?.duration, dur, hopSec, target, changed, playhead]);

  // Clavier (noms des notes) à gauche.
  useEffect(() => {
    const cv = keysRef.current;
    if (!open || !cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 46, H = box.h;
    cv.width = W * dpr; cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#121418'; ctx.fillRect(0, 0, W, H);
    ctx.font = `${Math.max(8, Math.min(11, rowH * 0.6))}px ui-sans-serif, system-ui`; ctx.textBaseline = 'middle';
    for (let m = range.lo; m <= range.hi; m++) {
      const y = yOf(m);
      const black = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
      const inKey = typeof key.root === 'number' && isInScale(m, key.root, key.scale);
      ctx.fillStyle = black ? '#1e2229' : '#2a2f38';
      ctx.fillRect(0, y - rowH / 2, W, rowH - 1);
      if (inKey) { ctx.fillStyle = '#22d3ee'; ctx.fillRect(W - 3, y - rowH / 2, 3, rowH - 1); }
      if (rowH >= 9) { ctx.fillStyle = inKey ? '#e2e8f0' : '#64748b'; ctx.fillText(noteNameFr(m), 4, y); }
    }
  }, [open, box.h, range, rowH, yOf, key]);

  // ----- Souris / doigt -----
  const drag = useRef<null | { kind: 'note' | 'pan' | 'box'; x: number; y: number; moved: boolean; base: (NoteEdit | undefined)[]; idx: number[]; scroll: number; pushed: boolean }>(null);
  const [rubber, setRubber] = useState<null | { x0: number; y0: number; x1: number; y1: number }>(null);
  const hit = (x: number, y: number, touch: boolean): number => {
    const tol = rowH * (touch ? 1.3 : 0.65);
    let best = -1, bestD = Infinity;
    notes.forEach((n, i) => {
      if (x < n.start * pps - (touch ? 6 : 0) || x > n.end * pps + (touch ? 6 : 0)) return;
      const d = Math.abs(y - yOf(targetCenter(n, edits[i])));
      if (d <= tol && d < bestD) { bestD = d; best = i; }
    });
    return best;
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (status !== 'ready' && status !== 'rendering') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const touch = e.pointerType !== 'mouse';
    const i = phone ? -1 : hit(x, y, touch);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (i >= 0) {
      let idx: number[];
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const s = new Set(sel); s.has(i) ? s.delete(i) : s.add(i); setSel(s); idx = Array.from(s);
      } else if (sel.has(i)) idx = Array.from(sel);
      else { setSel(new Set([i])); idx = [i]; }
      drag.current = { kind: 'note', x, y, moved: false, base: edits.slice(), idx, scroll: 0, pushed: false };
    } else if (touch || phone) {
      drag.current = { kind: 'pan', x: e.clientX, y, moved: false, base: [], idx: [], scroll: scrollRef.current?.scrollLeft || 0, pushed: false };
    } else {
      drag.current = { kind: 'box', x, y, moved: false, base: [], idx: [], scroll: 0, pushed: false };
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (d.kind === 'pan') {
      if (scrollRef.current) scrollRef.current.scrollLeft = d.scroll - (e.clientX - d.x);
      d.moved = true;
      return;
    }
    if (d.kind === 'box') {
      if (Math.abs(x - d.x) + Math.abs(y - d.y) > 4) d.moved = true;
      setRubber({ x0: d.x, y0: d.y, x1: x, y1: y });
      return;
    }
    const dy = y - d.y;
    if (!d.moved && Math.abs(dy) < 5) return;
    d.moved = true;
    if (!d.pushed) { snapshot(); d.pushed = true; }
    const delta = -dy / rowH;
    const fineNow = fine || e.altKey;
    setEdits(() => {
      const next = d.base.slice();
      d.idx.forEach(i => {
        const b = d.base[i] || NEUTRAL_EDIT;
        const n = notes[i];
        const shift = fineNow ? Math.round((b.shift + delta) * 100) / 100 : Math.round(n.center + b.shift + delta) - n.center;
        next[i] = { ...b, shift };
      });
      return next;
    });
    setManual(prev => { const s = new Set(prev); d.idx.forEach(i => s.add(i)); return s; });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'box') {
      setRubber(null);
      if (!d.moved) { setSel(new Set()); return; }
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const [xa, xb] = [Math.min(d.x, x), Math.max(d.x, x)], [ya, yb] = [Math.min(d.y, y), Math.max(d.y, y)];
      const s = new Set<number>(e.shiftKey ? sel : []);
      notes.forEach((n, i) => {
        const yc = yOf(targetCenter(n, edits[i]));
        if (n.end * pps >= xa && n.start * pps <= xb && yc >= ya - rowH / 2 && yc <= yb + rowH / 2) s.add(i);
      });
      setSel(s);
    } else if (d.kind === 'pan' && !d.moved) setSel(new Set());
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = hit(e.clientX - rect.left, e.clientY - rect.top, false);
    if (i >= 0) editNotes([i], (n, ed) => snapEdit(n, ed, keyArg));
  };

  // ----- Clavier -----
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); setSel(new Set(notes.map((_, i) => i))); return; }
      if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); void preview('apres'); return; }
      if (!selected.length) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        const s = e.key === 'ArrowUp' ? 1 : -1;
        const cent = fine || e.altKey || e.shiftKey;
        editNotes(selected, (n, ed) => nudgeEdit(n, ed, cent ? s * (e.shiftKey && !fine && !e.altKey ? 10 : 1) : s, cent ? 'cent' : 'semitone'));
      } else if (e.key.toLowerCase() === 'g') { e.preventDefault(); editNotes(selected, (n, ed) => snapEdit(n, ed, keyArg)); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); editNotes(selected, () => ({ ...NEUTRAL_EDIT })); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, undo, notes, selected, fine, editNotes, keyArg, preview]);

  if (!open) return null;

  const keyText = typeof key.root === 'number' ? `${keyLabelFr(key.root, key.scale)}${key.guessed ? ' (devinée d’après ta voix)' : ''}` : 'chromatique (tous les demi-tons)';
  const setRoot = (v: string) => {
    const k = v === '' ? { root: undefined, scale: 'CHROMATIC' } : { root: Number(v), scale: key.scale && key.scale !== 'CHROMATIC' ? key.scale : 'MINOR' };
    setKey(k);
    if (amount > 0) { snapshot(); applyGlobal(amount, style, k); }
  };
  const setScale = (v: string) => {
    const k = { root: key.root, scale: v };
    setKey(k);
    if (amount > 0) { snapshot(); applyGlobal(amount, style, k); }
  };
  const busy = status === 'loading' || status === 'rendering';
  const clipName = clip?.name || 'clip';

  const globalBar = (
    <div className={phone ? 'flex flex-col gap-2' : 'flex flex-wrap items-center gap-x-4 gap-y-2'} data-testid="pitch-global">
      <label className={phone ? 'flex flex-wrap items-center gap-x-2 gap-y-1' : 'flex min-w-[220px] flex-1 items-center gap-2'} title="Comme « Corriger la hauteur » de Flex Pitch : ramène chaque note vers la note de la gamme la plus proche. Les notes que tu as retouchées à la main ne bougent pas.">
        <span className={`whitespace-nowrap text-[12px] font-black text-white ${phone ? 'w-full' : ''}`}>🎯 Corriger tout dans la gamme</span>
        <input type="range" min={0} max={100} step={1} value={amount} aria-label="Dosage de la correction"
          data-testid="pitch-amount" disabled={!notes.length}
          onPointerDown={() => snapshot()}
          onKeyDown={e => { if (e.key.startsWith('Arrow')) snapshot(); }}
          onChange={e => { const a = Number(e.target.value); setAmount(a); applyGlobal(a, style); }}
          className="min-w-[90px] flex-1 accent-cyan-400" style={{ minHeight: 32 }} />
        <span className="w-12 shrink-0 text-right font-mono text-[13px] font-black text-cyan-300">{amount} %</span>
      </label>
      <div role="radiogroup" aria-label="Style de correction" className={`flex overflow-hidden rounded-lg border border-white/10 ${phone ? 'w-full' : ''}`}>
        {([['naturel', 'Naturel', 'Garde la vie de ta voix : glissades, vibrato, petites variations'], ['robot', 'Robot', 'Notes bien droites, sauts nets : l’effet Auto-Tune du rap']] as const).map(([id, label, hint]) => (
          <button key={id} type="button" role="radio" aria-checked={style === id} title={hint} data-testid={`pitch-style-${id}`}
            onClick={() => { snapshot(); setStyle(id); applyGlobal(amount || 100, id); if (!amount) setAmount(100); }}
            className={`min-h-[40px] px-3 text-[12px] font-black ${phone ? 'flex-1 min-h-[44px]' : ''} ${style === id ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}>{label}</button>
        ))}
      </div>
    </div>
  );

  const listenBar = (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => void preview('avant')} disabled={busy || !source} data-testid="pitch-listen-before"
        title="Écoute ta voix telle que tu l’as chantée" aria-pressed={playing === 'avant'}
        className={`min-h-[40px] rounded-lg px-3 text-[12px] font-bold ${playing === 'avant' ? 'bg-slate-200 text-black' : 'bg-white/5 text-slate-200 hover:bg-white/10'} disabled:opacity-40`}>
        {playing === 'avant' ? '■ Stop' : '▶ Avant'}
      </button>
      <button type="button" onClick={() => void preview('apres')} disabled={busy || !notes.length} data-testid="pitch-listen-after"
        title="Écoute le résultat corrigé (Espace) : exactement ce que « Appliquer » posera dans le clip" aria-pressed={playing === 'apres'}
        className={`min-h-[40px] rounded-lg px-3 text-[12px] font-black ${playing === 'apres' ? 'bg-pink-400 text-black' : 'bg-pink-500/20 text-pink-200 hover:bg-pink-500/30'} disabled:opacity-40`}>
        {status === 'rendering' ? 'Calcul…' : playing === 'apres' ? '■ Stop' : '▶ Après'}
      </button>
    </div>
  );

  const keyBar = (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-300" title="Gamme utilisée pour corriger et surlignée sur la grille">
      <span>Gamme :</span>
      <select aria-label="Tonique" value={typeof key.root === 'number' ? String(key.root) : ''} onChange={e => setRoot(e.target.value)}
        className="min-h-[34px] rounded-md border border-white/10 bg-black/40 px-2 text-white" data-testid="pitch-key-root">
        <option value="">— (chromatique)</option>
        {NOTE_NAMES_FR.map((n, i) => <option key={n} value={i}>{n}</option>)}
      </select>
      {typeof key.root === 'number' && (
        <select aria-label="Gamme" value={key.scale || 'MINOR'} onChange={e => setScale(e.target.value)}
          className="min-h-[34px] rounded-md border border-white/10 bg-black/40 px-2 text-white" data-testid="pitch-key-scale">
          {SCALE_CHOICES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      )}
      {key.guessed && <span className="text-[11px] text-amber-300/90">devinée d’après ta voix</span>}
    </div>
  );

  const stateMsg = status === 'loading' ? 'J’écoute ta voix et je la découpe en notes…'
    : status === 'error' ? error
    : status === 'empty' ? 'Aucune note chantée trouvée dans ce clip (parlé, souffle ou niveau trop bas). Essaie sur un passage chanté.'
    : '';

  const grid = (
    <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-lg border border-white/5 bg-[#0b0d10]">
      <canvas ref={keysRef} className="shrink-0" aria-hidden="true" />
      <div ref={scrollRef} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden" data-testid="pitch-grid">
        {analysis && notes.length > 0 && (
          <canvas ref={canvasRef} role="img" aria-label={`Notes de ${clipName} sur une grille de piano, avec la courbe de hauteur`}
            data-geom={JSON.stringify(notes.map((n, i) => ({ i, x0: Math.round(n.start * pps), x1: Math.round(n.end * pps), y: Math.round(yOf(targetCenter(n, edits[i]))), c: +targetCenter(n, edits[i]).toFixed(3) })))}
            className="block touch-none select-none" style={{ cursor: 'ns-resize' }}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = null; setRubber(null); }}
            onDoubleClick={phone ? undefined : onDoubleClick} />
        )}
        {rubber && (
          <div className="pointer-events-none absolute border border-white/70 bg-white/10" style={{
            left: Math.min(rubber.x0, rubber.x1),
            top: Math.min(rubber.y0, rubber.y1), width: Math.abs(rubber.x1 - rubber.x0), height: Math.abs(rubber.y1 - rubber.y0) }} />
        )}
        {stateMsg && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-[13px] text-slate-300" role="status" data-testid="pitch-status">
            {status === 'loading' && <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />}
            {stateMsg}
          </div>
        )}
      </div>
    </div>
  );

  const footer = (
    <div className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
      {canRevert && (
        <button type="button" onClick={revert} data-testid="pitch-revert"
          title="Remet la voix telle que tu l’as chantée (la version corrigée reste dans Ctrl+Z)"
          className="min-h-[42px] rounded-lg px-3 text-[12px] font-bold text-amber-300 hover:bg-amber-400/10">↩ Revenir à la prise d’origine</button>
      )}
      <span className={`mr-auto text-[11px] text-slate-500 ${phone ? 'w-full' : ''}`}>{changed ? 'Rien n’est effacé : la prise d’origine est gardée.' : 'Aucune note retouchée pour l’instant.'}</span>
      <button type="button" onClick={onClose} className={`min-h-[42px] rounded-lg bg-white/5 px-4 text-[12px] font-bold text-slate-300 ${phone ? 'min-h-[48px] flex-1' : ''}`}>Annuler</button>
      <button type="button" onClick={() => void apply()} disabled={!changed || busy} data-testid="pitch-apply"
        title="Crée la version corrigée du clip (même durée, timbre gardé). Ctrl+Z pour annuler."
        className={`min-h-[42px] rounded-lg bg-cyan-500 px-5 text-[13px] font-black text-black disabled:cursor-not-allowed disabled:opacity-40 ${phone ? 'min-h-[48px] flex-[2]' : ''}`}>
        {status === 'rendering' ? 'Calcul…' : 'Appliquer'}
      </button>
    </div>
  );

  // ----- Téléphone : version simple -----
  if (phone) {
    return (
      <div className="fixed inset-0 z-[700] flex flex-col bg-[#121418] p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]" role="dialog" aria-modal="true" aria-labelledby="pitch-title" data-testid="pitch-editor" data-mode="phone">
        <div className="mb-2 flex items-center gap-2">
          <h2 id="pitch-title" className="mr-auto text-[15px] font-black text-white">🎯 Justesse : {clipName}</h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-11 w-11 rounded-lg bg-white/5 text-slate-300">✕</button>
        </div>
        <p className="mb-2 text-[12px] text-slate-400">Ramène ta voix dans la gamme. Dose à l’oreille, puis « Appliquer » : ta prise d’origine est gardée.</p>
        <div className="mb-3 flex h-[34vh] min-h-[160px] flex-col">{grid}</div>
        <div className="space-y-3">
          {keyBar}
          {globalBar}
          <div className="flex items-center justify-between gap-2">{listenBar}</div>
          <p className="text-[11px] text-slate-500">Retouche note par note : ouvre ce clip sur un ordi ou une tablette.</p>
        </div>
        <div className="mt-auto">{footer}</div>
      </div>
    );
  }

  // ----- Ordinateur / tablette : éditeur complet -----
  const selCount = selected.length;
  const selCenter = selCount === 1 ? targetCenter(notes[selected[0]], edits[selected[0]]) : null;
  const sliders = firstSel && (
    <>
      <label className="flex items-center gap-2" title="Redresse la note qui glisse (monte ou descend lentement pendant qu’elle est tenue)">
        <span className="w-[118px] text-[11px] font-bold text-slate-300">Redresser la dérive</span>
        <input type="range" min={0} max={100} step={1} value={Math.round(firstSel.drift * 100)} aria-label="Redresser la dérive"
          data-testid="pitch-drift" onPointerDown={() => snapshot()}
          onChange={e => editNotes(selected, (_, ed) => ({ ...ed, drift: Number(e.target.value) / 100 }), false)}
          className="w-28 accent-cyan-400" style={{ minHeight: 30 }} />
        <span className="w-10 font-mono text-[11px] text-cyan-300">{Math.round(firstSel.drift * 100)} %</span>
      </label>
      <label className="flex items-center gap-2" title="0 % : vibrato supprimé · 100 % : intact · 200 % : doublé">
        <span className="w-[56px] text-[11px] font-bold text-slate-300">Vibrato</span>
        <input type="range" min={0} max={200} step={5} value={Math.round(firstSel.vibrato * 100)} aria-label="Vibrato"
          data-testid="pitch-vibrato" onPointerDown={() => snapshot()}
          onChange={e => editNotes(selected, (_, ed) => ({ ...ed, vibrato: Number(e.target.value) / 100 }), false)}
          className="w-28 accent-cyan-400" style={{ minHeight: 30 }} />
        <span className="w-12 font-mono text-[11px] text-cyan-300">{Math.round(firstSel.vibrato * 100)} %</span>
      </label>
      <label className="flex items-center gap-2" title="Temps de passage depuis la note d’avant : 0 = saut net (robot), plus long = glissé">
        <span className="w-[72px] text-[11px] font-bold text-slate-300">Transition</span>
        <input type="range" min={0} max={300} step={5} value={firstSel.transitionMs ?? NATURAL_TRANSITION_MS} aria-label="Transition entre les notes"
          data-testid="pitch-transition" onPointerDown={() => snapshot()}
          onChange={e => editNotes(selected, (_, ed) => ({ ...ed, transitionMs: Number(e.target.value) }), false)}
          className="w-28 accent-cyan-400" style={{ minHeight: 30 }} />
        <span className="w-16 font-mono text-[11px] text-cyan-300">{firstSel.transitionMs === undefined ? 'naturelle' : `${firstSel.transitionMs} ms`}</span>
      </label>
    </>
  );
  const stepBtn = 'min-h-[40px] min-w-[44px] rounded-lg bg-white/5 px-2 text-[12px] font-black text-white hover:bg-white/10 disabled:opacity-30';

  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center bg-black/70 p-2 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="pitch-title" onClick={onClose}>
      <div className="flex h-full max-h-[920px] w-full max-w-[1400px] flex-col gap-3 rounded-2xl border border-white/10 bg-[#121418] p-3 shadow-2xl sm:p-4"
        onClick={e => e.stopPropagation()} data-testid="pitch-editor" data-mode="full">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 id="pitch-title" className="text-[15px] font-black text-white" title="Comme Flex Pitch dans Logic, Melodyne ou le Pitch Editor de FL Studio">
            🎯 Justesse note par note <span className="font-semibold text-slate-400">· {clipName}</span>
          </h2>
          {keyBar}
          <span className="mr-auto" />
          {listenBar}
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-10 w-10 rounded-lg bg-white/5 text-slate-300">✕</button>
        </div>
        {globalBar}
        {grid}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-black/25 px-3 py-2" data-testid="pitch-selection">
          <span className="min-w-[150px] text-[12px] text-slate-300" role="status">
            {!notes.length ? '' : selCount === 0 ? 'Touche une note pour la retoucher (Ctrl+A : toutes).'
              : selCount === 1 && selCenter !== null ? <><b className="text-white">{noteNameFr(Math.round(selCenter))}</b> · {Math.abs(centsFromScale(selCenter, key.root, key.scale)) >= 50 ? 'hors gamme' : `${scaleTag(centsFromScale(selCenter, key.root, key.scale))}${Math.abs(centsFromScale(selCenter, key.root, key.scale)) >= 3 ? ' de la gamme' : ' juste'}`}</>
              : <><b className="text-white">{selCount} notes</b> sélectionnées</>}
          </span>
          <div className="flex items-center gap-1" role="group" aria-label="Monter ou descendre">
            <button type="button" disabled={!selCount} className={stepBtn} data-testid="pitch-down"
              title={fine ? 'Descendre d’un cent (Alt+↓)' : 'Descendre d’un demi-ton (↓)'}
              onClick={() => editNotes(selected, (n, ed) => nudgeEdit(n, ed, -1, fine ? 'cent' : 'semitone'))}>▼ {fine ? '1 ct' : '½ ton'}</button>
            <button type="button" disabled={!selCount} className={stepBtn} data-testid="pitch-up"
              title={fine ? 'Monter d’un cent (Alt+↑)' : 'Monter d’un demi-ton (↑)'}
              onClick={() => editNotes(selected, (n, ed) => nudgeEdit(n, ed, 1, fine ? 'cent' : 'semitone'))}>▲ {fine ? '1 ct' : '½ ton'}</button>
            <button type="button" aria-pressed={fine} onClick={() => setFine(v => !v)} data-testid="pitch-fine"
              title="Au cent près : les flèches et le glisser bougent la note finement (sinon par demi-ton). Astuce : Alt pendant le glisser."
              className={`min-h-[40px] rounded-lg px-2 text-[11px] font-bold ${fine ? 'bg-cyan-500/25 text-cyan-200 ring-1 ring-cyan-400/50' : 'bg-white/5 text-slate-300'}`}>Au cent près</button>
          </div>
          <button type="button" disabled={!selCount} className={stepBtn} data-testid="pitch-snap"
            title="Pose la note pile sur la note de la gamme la plus proche (G, ou double-clic sur la note)"
            onClick={() => editNotes(selected, (n, ed) => snapEdit(n, ed, keyArg))}>Coller à la gamme</button>
          {sliders}
          <button type="button" disabled={!selCount} className={`${stepBtn} font-bold text-slate-300`} data-testid="pitch-reset"
            title="Remet ces notes comme tu les as chantées (Suppr)"
            onClick={() => editNotes(selected, () => ({ ...NEUTRAL_EDIT }))}>Comme chanté</button>
          <span className="ml-auto flex items-center gap-1">
            <button type="button" onClick={undo} disabled={!undoRef.current.length} className={stepBtn} title="Annuler la dernière retouche (Ctrl+Z)" aria-label="Annuler la dernière retouche">↶</button>
            <button type="button" onClick={() => setZoom(z => clamp(z / 1.5, 1, 40))} className={stepBtn} aria-label="Dézoomer" title="Dézoomer">−</button>
            <button type="button" onClick={() => setZoom(z => clamp(z * 1.5, 1, 40))} className={stepBtn} aria-label="Zoomer" title="Zoomer">+</button>
          </span>
        </div>
        {footer}
      </div>
    </div>
  );
};

export default PitchEditor;
