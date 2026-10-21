/**
 * L5 · écart 7 · Éditeur spectral : le spectre d'un clip (temps × fréquence),
 * une zone tracée à la souris ou au doigt, puis « Atténuer » (de 6 à 40 dB) ou
 * « Remplir depuis le voisinage » (la zone prend le niveau du son juste avant et
 * juste après : une toux, une sonnerie, une chaise qui grince disparaissent).
 *
 * Les retouches s'accumulent dans la fenêtre (« Annuler la dernière retouche »),
 * on écoute la zone avant / après, puis « Garder » = traitement de clip : un
 * nouveau son, l'original gardé (menu du clip → « Revenir à l'original »), Ctrl+Z.
 * Les calculs tournent dans un Worker (services/VoiceRepair) : l'écran ne gèle pas.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DAWState, Track } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { patchClip } from '../utils/clipProcess';
import { repairBlock, repairPatch, repairRegion } from '../utils/repair';
import { ATTENUATIONS, freqToY, yToFreq, type Spectrogram, type SpectralZone, type ZoneOp } from '../utils/spectral/stft';
import { bufferOf, channelsOf, runSpectralEdit, runSpectrogram } from '../services/VoiceRepair';
import { AbPlayer } from '../utils/abPlayer';

export interface SpectralRequest { targets: { trackId: string; clipId: string }[] }

interface Props {
  request: SpectralRequest | null;
  tracks: Track[];
  setState: (fn: (prev: DAWState) => DAWState) => void;
  onClose: () => void;
}

interface Work {
  trackId: string; clipId: string; clipName: string;
  sampleRate: number;
  /** Début de la région (s, dans le son du clip) ; partie montrée dans la région (s). */
  from: number; viewFrom: number; viewDur: number;
  orig: Float32Array[];
}

/** Retouche annulable : les échantillons d'avant, sur la seule partie changée. */
interface Undo { start: number; data: Float32Array[]; label: string }

const notify = (detail: string) => { try { window.dispatchEvent(new CustomEvent('nova:notify', { detail })); } catch { /* hors navigateur */ } };
const btn = 'min-h-10 [@media(pointer:coarse)]:min-h-11 px-3 py-2 rounded-xl text-[12px] leading-tight font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const primary = `${btn} bg-cyan-500 text-black hover:bg-cyan-400 font-black`;
const secondary = `${btn} border border-nv-line text-nv-ink hover:bg-nv-accent/10`;
const fmtHz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1).replace('.', ',')} kHz` : `${Math.round(f)} Hz`);
const fmtS = (t: number) => `${t.toFixed(2).replace('.', ',')} s`;
const ATT_KEY = 'nova_spectral_db';

/** Couleurs du spectre : noir → bleu → cyan → jaune → blanc (lisible en clair et en sombre). */
const PALETTE = (() => {
  const stops: [number, [number, number, number]][] = [[0, [6, 8, 18]], [0.35, [20, 40, 120]], [0.6, [0, 170, 210]], [0.82, [250, 220, 60]], [1, [255, 255, 255]]];
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let k = 0; while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
    const [a, ca] = stops[k], [b, cb] = stops[k + 1];
    const f = (v - a) / Math.max(1e-6, b - a);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(ca[c] + (cb[c] - ca[c]) * f);
  }
  return out;
})();

const SpectralEditor: React.FC<Props> = ({ request, tracks, setState, onClose }) => {
  const [work, setWork] = useState<Work | null>(null);
  const [cur, setCur] = useState<Float32Array[] | null>(null);
  const [spec, setSpec] = useState<Spectrogram | null>(null);
  const [sel, setSel] = useState<{ x0: number; x1: number; y0: number; y1: number } | null>(null);
  const [undo, setUndo] = useState<Undo[]>([]);
  /** Retouches faites (les 20 dernières seulement s'annulent). */
  const [edits, setEdits] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [att, setAtt] = useState<number>(() => { try { const v = Number(localStorage.getItem(ATT_KEY)); return ATTENUATIONS.includes(v) ? v : 12; } catch { return 12; } });
  const [playing, setPlaying] = useState<'before' | 'after' | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const player = useRef<AbPlayer | null>(null);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  // Chargement du clip visé.
  useEffect(() => {
    setWork(null); setCur(null); setSpec(null); setSel(null); setUndo([]); setEdits(0); setError(null);
    const t = request?.targets?.[0];
    if (!t) return;
    const track = tracksRef.current.find(x => x.id === t.trackId);
    const clip = track?.clips.find(c => c.id === t.clipId);
    const block = repairBlock(clip);
    if (block) { setError(block); return; }
    const buf = clip!.buffer || audioBufferRegistry.get(clip!.bufferId!);
    if (!buf) { setError('Le son de ce clip n’est pas encore chargé : attends la fin du chargement, puis rouvre l’éditeur.'); return; }
    const reg = repairRegion(clip!, buf.duration);
    const sr = buf.sampleRate;
    const orig = channelsOf(buf, Math.round(reg.from * sr), Math.round(reg.to * sr));
    setWork({ trackId: t.trackId, clipId: t.clipId, clipName: clip!.name, sampleRate: sr, from: reg.from, viewFrom: reg.lead, viewDur: Math.min(clip!.duration, (reg.to - reg.from) - reg.lead), orig });
    setCur(orig);
  }, [request]);

  // Spectre (recalculé après chaque retouche).
  useEffect(() => {
    if (!work || !cur) return;
    let alive = true;
    setBusy('Calcul du spectre…');
    const cols = Math.max(200, Math.min(1400, Math.round((box.current?.clientWidth || 900) * Math.min(2, window.devicePixelRatio || 1))));
    runSpectrogram(cur, work.sampleRate, { from: work.viewFrom * work.sampleRate, to: (work.viewFrom + work.viewDur) * work.sampleRate, cols, rows: 256 })
      .then(s => { if (alive) setSpec(s); })
      .catch(e => { if (alive) setError(`Spectre impossible : ${e?.message || e}`); })
      .finally(() => { if (alive) setBusy(null); });
    return () => { alive = false; };
  }, [work, cur]);

  // Dessin.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !spec) return;
    c.width = spec.cols; c.height = spec.rows;
    const g = c.getContext('2d');
    if (!g) return;
    const img = g.createImageData(spec.cols, spec.rows);
    for (let i = 0; i < spec.data.length; i++) {
      const v = spec.data[i] * 3;
      img.data[i * 4] = PALETTE[v]; img.data[i * 4 + 1] = PALETTE[v + 1]; img.data[i * 4 + 2] = PALETTE[v + 2]; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, [spec]);

  useEffect(() => () => { player.current?.close(); }, []);
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { if (sel) setSel(null); else onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, busy, sel, onClose]);

  const zone: SpectralZone | null = useMemo(() => {
    if (!sel || !work || !spec) return null;
    const xa = Math.min(sel.x0, sel.x1), xb = Math.max(sel.x0, sel.x1), ya = Math.min(sel.y0, sel.y1), yb = Math.max(sel.y0, sel.y1);
    return { t0: work.viewFrom + xa * work.viewDur, t1: work.viewFrom + xb * work.viewDur, f0: yToFreq(yb, spec.fMin, spec.fMax), f1: yToFreq(ya, spec.fMin, spec.fMax) };
  }, [sel, work, spec]);
  const zoneOk = !!zone && zone.t1 - zone.t0 >= 0.01 && zone.f1 / Math.max(1, zone.f0) > 1.02;

  const pos = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const onDown = (e: React.PointerEvent) => {
    if (busy || !spec) return;
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* pointeur déjà relâché */ }
    const p = pos(e);
    drag.current = p;
    setSel({ x0: p.x, x1: p.x, y0: p.y, y1: p.y });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const p = pos(e);
    setSel({ x0: drag.current.x, y0: drag.current.y, x1: p.x, y1: p.y });
  };
  const onUp = () => { drag.current = null; };

  const apply = useCallback(async (op: ZoneOp) => {
    if (!work || !cur || !zone || !zoneOk) return;
    setError(null);
    const label = op.kind === 'attenuate' ? `−${op.db} dB` : 'remplie';
    setBusy(op.kind === 'attenuate' ? `Atténuation de la zone (−${op.db} dB)…` : 'Remplissage depuis le voisinage…');
    try {
      const r = await runSpectralEdit(cur, work.sampleRate, zone, op);
      if (!r.changed) { setError('Rien n’a changé : la zone est peut-être hors du son, ou déjà silencieuse.'); return; }
      const [lo, hi] = r.changed;
      setUndo(u => [...u.slice(-19), { start: lo, data: cur.map(c => c.slice(lo, hi)), label }]);
      setCur(r.channels);
      setEdits(n => n + 1);
      player.current?.stop(); setPlaying(null);
    } catch (e: any) {
      setError(`La retouche n’a pas abouti : ${e?.message || e}.`);
    } finally { setBusy(null); }
  }, [work, cur, zone, zoneOk]);

  const undoLast = () => {
    const last = undo[undo.length - 1];
    if (!last || !cur) return;
    const next = cur.map((c, i) => { const o = new Float32Array(c); o.set(last.data[i], last.start); return o; });
    setUndo(u => u.slice(0, -1));
    setEdits(n => Math.max(0, n - 1));
    setCur(next);
  };

  const listen = (which: 'before' | 'after') => {
    if (!work || !cur) return;
    if (playing === which) { player.current?.stop(); setPlaying(null); return; }
    const sr = work.sampleRate;
    // La zone et une demi-seconde autour ; sans zone, la partie visible.
    const t0 = zone && zoneOk ? Math.max(0, zone.t0 - 0.5) : work.viewFrom;
    const t1 = zone && zoneOk ? zone.t1 + 0.5 : work.viewFrom + work.viewDur;
    const a = Math.round(t0 * sr), b = Math.min(cur[0].length, Math.round(t1 * sr));
    if (b - a < 16) return;
    if (!player.current) player.current = new AbPlayer();
    player.current.onEnd = () => setPlaying(null);
    player.current.play({ orig: work.orig.map(c => c.slice(a, b)), wet: cur.map(c => c.slice(a, b)), sampleRate: sr }, 1, which === 'after');
    setPlaying(which);
  };

  const keep = () => {
    if (!work || !cur || !edits) return;
    const clip = tracksRef.current.find(t => t.id === work.trackId)?.clips.find(c => c.id === work.clipId);
    if (!clip) { setError('Le clip a été supprimé entre-temps.'); return; }
    const id = `spec-${clip.id}-${Date.now().toString(36)}`;
    audioBufferRegistry.register(bufferOf(cur, work.sampleRate), id);
    const n = edits;
    const patch = repairPatch(clip, { newBufferId: id, from: work.from, name: `Retouche spectrale (${n} zone${n > 1 ? 's' : ''})`, type: 'SPECTRAL_EDIT' });
    setState(prev => ({ ...prev, tracks: prev.tracks.map(t => (t.id === work.trackId ? { ...t, clips: t.clips.map(c => (c.id === work.clipId ? patchClip(c, patch) : c)) } : t)) }));
    notify(`🎨 Retouche spectrale gardée (${n} zone${n > 1 ? 's' : ''}). L'original est gardé : menu du clip → « Revenir à l'original ». Ctrl+Z pour annuler.`);
    onClose();
  };

  if (!request) return null;
  const selStyle = sel ? { left: `${Math.min(sel.x0, sel.x1) * 100}%`, top: `${Math.min(sel.y0, sel.y1) * 100}%`, width: `${Math.abs(sel.x1 - sel.x0) * 100}%`, height: `${Math.abs(sel.y1 - sel.y0) * 100}%` } : undefined;
  const freqTicks = spec ? [100, 1000, 10000].filter(f => f > spec.fMin && f < spec.fMax) : [];

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={() => !busy && !edits && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Éditeur spectral" data-testid="spectral-editor" onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-4xl max-h-[100dvh] overflow-y-auto space-y-3 rounded-t-2xl sm:rounded-2xl border border-nv-line bg-nv-panel p-4 text-nv-ink shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-black">Éditeur spectral{work ? <span className="font-bold text-nv-muted"> · {work.clipName}</span> : null}</h2>
            <p className="text-[11px] text-nv-muted">Trace une zone sur un bruit (toux, sonnerie, chaise, souffle), puis atténue-la ou remplis-la avec le son d’à côté. En bas les graves, en haut les aigus.</p>
          </div>
          <button type="button" disabled={!!busy} onClick={onClose} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10"><i className="fas fa-times" /></button>
        </div>

        {error && <p role="alert" className="rounded-lg bg-red-500/10 px-2 py-1.5 text-[12px] text-red-400">{error}</p>}

        {work && (
          <div className="flex gap-1">
            <div className="relative w-12 shrink-0 text-[10px] text-nv-muted" aria-hidden>
              {spec && freqTicks.map(f => (
                <span key={f} className="absolute right-1 -translate-y-1/2" style={{ top: `${freqToY(f, spec.fMin, spec.fMax) * 100}%` }}>{fmtHz(f)}</span>
              ))}
            </div>
            <div className="min-w-0 flex-1">
              <div ref={box} data-testid="spectral-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
                className="relative h-[260px] sm:h-[320px] w-full cursor-crosshair touch-none select-none overflow-hidden rounded-lg border border-nv-line bg-black">
                <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
                {!spec && <div className="absolute inset-0 flex items-center justify-center text-[12px] text-white/70"><i className="fas fa-circle-notch animate-spin mr-2" />Calcul du spectre…</div>}
                {sel && <div data-testid="spectral-selection" className="pointer-events-none absolute border-2 border-amber-300 bg-amber-300/15" style={selStyle} />}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-nv-muted" aria-hidden>
                <span>0 s</span><span>{fmtS(work.viewDur / 2)}</span><span>{fmtS(work.viewDur)}</span>
              </div>
            </div>
          </div>
        )}

        {work && (
          <p className="text-[12px]" role="status" data-testid="spectral-zone">
            {zone && zoneOk
              ? <>Zone : <b>{fmtS(zone.t0 - work.viewFrom)} → {fmtS(zone.t1 - work.viewFrom)}</b>, <b>{fmtHz(zone.f0)} → {fmtHz(zone.f1)}</b></>
              : <span className="text-nv-muted">Glisse sur le spectre pour tracer une zone.</span>}
          </p>
        )}

        {busy && <p role="status" className="text-[12px] text-nv-muted"><i className="fas fa-circle-notch animate-spin mr-2" />{busy}</p>}

        {work && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <button type="button" className={primary} disabled={!!busy || !zoneOk} onClick={() => void apply({ kind: 'attenuate', db: att })} data-testid="spectral-attenuate"
                title="Baisse tout ce qui est dans la zone, du même nombre de décibels">
                <i className="fas fa-volume-low mr-1.5" />Atténuer
              </button>
              <select value={att} onChange={e => { const v = Number(e.target.value); setAtt(v); try { localStorage.setItem(ATT_KEY, String(v)); } catch { /* stockage indisponible */ } }}
                aria-label="Atténuation" className="rounded-lg border border-nv-line bg-nv-well px-2 py-2 text-[12px] text-nv-ink">
                {ATTENUATIONS.map(d => <option key={d} value={d}>−{d} dB</option>)}
              </select>
            </div>
            <button type="button" className={secondary} disabled={!!busy || !zoneOk} onClick={() => void apply({ kind: 'fill' })} data-testid="spectral-fill"
              title="Chaque fréquence de la zone prend le niveau du son juste avant et juste après : le bruit se fond dans le fond">
              <i className="fas fa-fill-drip mr-1.5" />Remplir depuis le voisinage
            </button>
            <button type="button" className={secondary} disabled={!!busy || !undo.length} onClick={undoLast} data-testid="spectral-undo" title="Annule la dernière retouche de cette fenêtre">
              <i className="fas fa-rotate-left mr-1.5" />Annuler la retouche
            </button>
            <span className="mx-1 hidden h-6 w-px bg-nv-line sm:block" />
            <button type="button" className={secondary} disabled={!!busy} onClick={() => listen('before')} aria-pressed={playing === 'before'} title="Écoute la zone (et une demi-seconde autour) telle qu’enregistrée">
              <i className={`fas ${playing === 'before' ? 'fa-stop' : 'fa-play'} mr-1.5`} />Avant
            </button>
            <button type="button" className={secondary} disabled={!!busy} onClick={() => listen('after')} aria-pressed={playing === 'after'} title="Écoute la zone avec tes retouches">
              <i className={`fas ${playing === 'after' ? 'fa-stop' : 'fa-play'} mr-1.5`} />Après
            </button>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 border-t border-nv-line pt-3">
          <button type="button" className={secondary} disabled={!!busy} onClick={onClose}>{edits ? 'Fermer sans garder' : 'Fermer'}</button>
          <button type="button" className={primary} disabled={!!busy || !edits} onClick={keep} data-testid="spectral-keep"
            title="Le clip joue le son retouché ; l’original reste gardé (menu du clip → Revenir à l’original)">
            <i className="fas fa-check mr-1.5" />Garder{edits ? ` (${edits} retouche${edits > 1 ? 's' : ''})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SpectralEditor;
