import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, Track } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { StripSilenceOptions, stripSilenceFromClip } from '../utils/stripSilence';

export interface StripSilenceSettings { thresholdDb: number; minStripMs: number; startPadMs: number; endPadMs: number }

export const DEFAULT_STRIP_SETTINGS: StripSilenceSettings = { thresholdDb: -45, minStripMs: 350, startPadMs: 80, endPadMs: 150 };

/** Réglages de la fenêtre → options du nettoyage (sans les regroupements automatiques). */
export const stripOptions = (s: StripSilenceSettings): StripSilenceOptions => ({
  thresholdDb: s.thresholdDb,
  minSilenceSec: s.minStripMs / 1000,
  preRollSec: s.startPadMs / 1000,
  postRollSec: s.endPadMs / 1000,
  minSoundSec: 0.02,
  minClipSec: 0,
  joinGapSec: 0,
});

const bufferOf = (clip: Clip): AudioBuffer | undefined => clip.buffer || (clip.bufferId ? audioBufferRegistry.get(clip.bufferId) : undefined);

interface Props {
  open: boolean;
  tracks: Track[];
  targets: { trackId: string; clipId: string }[];
  onApply: (results: { trackId: string; clipId: string; clips: Clip[] }[]) => void;
  onClose: () => void;
}

const SETTINGS_KEY = 'nova_strip_silence';

/**
 * Fenêtre Strip Silence (Pro Tools, Ctrl+U) : seuil, durée minimale de blanc,
 * marges avant / après, aperçu sur la forme d'onde. Non destructif et annulable.
 */
const StripSilenceDialog: React.FC<Props> = ({ open, tracks, targets, onApply, onClose }) => {
  const [s, setS] = useState<StripSilenceSettings>(() => {
    try { return { ...DEFAULT_STRIP_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return DEFAULT_STRIP_SETTINGS; }
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const items = useMemo(() => targets.map(t => {
    const track = tracks.find(x => x.id === t.trackId);
    const clip = track?.clips.find(c => c.id === t.clipId);
    return clip ? { trackId: t.trackId, clip, buffer: bufferOf(clip) } : null;
  }).filter(Boolean) as { trackId: string; clip: Clip; buffer?: AudioBuffer }[], [targets, tracks]);

  const results = useMemo(() => {
    if (!open) return [];
    const opts = stripOptions(s);
    return items.map(it => ({ ...it, res: it.buffer ? stripSilenceFromClip(it.clip, it.buffer, opts) : null }));
  }, [open, items, s]);

  const removed = results.reduce((n, r) => n + (r.res?.removedSec || 0), 0);
  const kept = results.reduce((n, r) => n + (r.res ? r.res.clips.length : 0), 0);
  const changed = results.filter(r => r.res);
  const noAudio = items.filter(i => !i.buffer).length;

  // Aperçu : forme d'onde du premier clip, passages gardés en couleur.
  useEffect(() => {
    const cv = canvasRef.current;
    const first = results[0];
    if (!open || !cv) return;
    const w = cv.width = cv.clientWidth * (window.devicePixelRatio || 1);
    const h = cv.height = cv.clientHeight * (window.devicePixelRatio || 1);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b0d10'; ctx.fillRect(0, 0, w, h);
    if (!first?.buffer) return;
    const { clip, buffer } = first;
    const from = clip.offset || 0, dur = Math.min(clip.duration, buffer.duration - from);
    const sr = buffer.sampleRate, data = buffer.getChannelData(0);
    const xOf = (t: number) => ((t - from) / dur) * w;
    // Passages gardés
    const segs = first.res ? first.res.clips.map(c => [c.offset, c.offset + c.duration]) : [[from, from + dur]];
    ctx.fillStyle = 'rgba(34,211,238,0.14)';
    segs.forEach(([a, b]) => ctx.fillRect(xOf(a), 0, Math.max(1, xOf(b) - xOf(a)), h));
    // Affichage normalisé sur la crête du clip : une voix enregistrée bas reste lisible.
    let clipPeak = 1e-4;
    for (let i = Math.floor(from * sr); i < Math.min(data.length, Math.floor((from + dur) * sr)); i += 8) clipPeak = Math.max(clipPeak, Math.abs(data[i]));
    const scale = 0.95 / clipPeak;
    // Seuil
    const thr = Math.min(1, Math.pow(10, s.thresholdDb / 20) * scale);
    ctx.strokeStyle = 'rgba(248,113,113,0.6)'; ctx.setLineDash([4, 4]);
    [h / 2 - thr * h / 2, h / 2 + thr * h / 2].forEach(y => { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); });
    ctx.setLineDash([]);
    // Forme d'onde (crêtes par colonne)
    const inKept = (t: number) => segs.some(([a, b]) => t >= a && t <= b);
    for (let x = 0; x < w; x++) {
      const t0 = from + (x / w) * dur, t1 = from + ((x + 1) / w) * dur;
      let pk = 0;
      for (let i = Math.floor(t0 * sr); i < Math.min(data.length, Math.floor(t1 * sr)); i += 4) pk = Math.max(pk, Math.abs(data[i]));
      ctx.fillStyle = inKept((t0 + t1) / 2) ? '#22d3ee' : '#475569';
      const hh = Math.max(1, Math.min(1, pk * scale) * h);
      ctx.fillRect(x, h / 2 - hh / 2, 1, hh);
    }
  }, [open, results, s.thresholdDb]);

  if (!open) return null;

  const set = (k: keyof StripSilenceSettings, v: number) => setS(prev => ({ ...prev, [k]: v }));
  const apply = () => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* */ }
    onApply(changed.map(r => ({ trackId: r.trackId, clipId: r.clip.id, clips: r.res!.clips })));
    onClose();
  };

  // Fonction (pas un composant) : un composant défini ici serait recréé à chaque rendu et le curseur lâcherait le glisser.
  const field = ({ k, label, min, max, step, unit, hint }: { k: keyof StripSilenceSettings; label: string; min: number; max: number; step: number; unit: string; hint: string }) => (
    <label key={k} className="block" title={hint}>
      <span className="flex items-center justify-between text-[11px] font-bold text-slate-300">
        <span>{label}</span>
        <span className="font-mono text-cyan-300">{s[k]} {unit}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={s[k]} onChange={e => set(k, Number(e.target.value))}
        aria-label={label} className="mt-1 w-full accent-cyan-500" />
    </label>
  );

  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="strip-title">
      <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-[#121418] p-5 shadow-2xl" onClick={e => e.stopPropagation()} data-testid="strip-silence">
        <div className="mb-3 flex items-center">
          <h2 id="strip-title" className="mr-auto text-[15px] font-black text-white" title="Pro Tools : Strip Silence (Ctrl+U)">Strip Silence : retirer les blancs</h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="h-9 w-9 rounded-lg bg-white/5 text-slate-300">✕</button>
        </div>
        <p className="mb-3 text-[12px] text-slate-400">
          {items.length === 0 ? 'Sélectionne un clip audio (ou une piste) puis rouvre cette fenêtre.' :
            `${items.length} clip${items.length > 1 ? 's' : ''} : ${items[0].clip.name}${items.length > 1 ? '…' : ''}. Rien n’est effacé : le son reste dans le clip, Ctrl+Z revient en arrière.`}
        </p>
        <canvas ref={canvasRef} className="mb-4 h-24 w-full rounded-lg border border-white/5" aria-label="Aperçu : en bleu, ce qui est gardé" />
        <div className="grid gap-3 sm:grid-cols-2">
          {field({ k: 'thresholdDb', label: 'Seuil', min: -80, max: -10, step: 1, unit: 'dB', hint: "Sous ce niveau, c'est un blanc (Pro Tools : Strip Threshold)" })}
          {field({ k: 'minStripMs', label: 'Blanc minimum', min: 50, max: 2000, step: 10, unit: 'ms', hint: "Un blanc plus court est gardé : respirations, coupures entre les mots (Pro Tools : Minimum Strip Duration)" })}
          {field({ k: 'startPadMs', label: 'Marge avant', min: 0, max: 500, step: 5, unit: 'ms', hint: "Gardé avant chaque passage : l'attaque, la respiration (Pro Tools : Clip Start Pad)" })}
          {field({ k: 'endPadMs', label: 'Marge après', min: 0, max: 1000, step: 5, unit: 'ms', hint: "Gardé après chaque passage : la fin du mot (Pro Tools : Clip End Pad)" })}
        </div>
        <div className="mt-4 rounded-lg bg-black/30 px-3 py-2 text-[12px] text-slate-300" role="status" data-testid="strip-summary">
          {noAudio > 0 && <span className="mr-2 text-amber-300">{noAudio} clip(s) sans audio chargé ignoré(s).</span>}
          {changed.length > 0
            ? <>Résultat : <b className="text-white">{kept}</b> passage{kept > 1 ? 's' : ''} gardé{kept > 1 ? 's' : ''}, <b className="text-white">{removed.toFixed(1)} s</b> de blanc retiré.</>
            : items.length > 0 ? 'Rien à retirer avec ces réglages (essaie un seuil plus haut).' : null}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => setS(DEFAULT_STRIP_SETTINGS)} className="mr-auto rounded-lg px-3 py-2 text-[12px] font-bold text-slate-400 hover:text-white">Réglages par défaut</button>
          <button type="button" onClick={onClose} className="rounded-lg bg-white/5 px-4 py-2 text-[12px] font-bold text-slate-300">Annuler</button>
          <button type="button" onClick={apply} disabled={!changed.length} data-testid="strip-apply"
            className="rounded-lg bg-cyan-500 px-4 py-2 text-[12px] font-black text-black disabled:cursor-not-allowed disabled:opacity-40">Retirer les blancs</button>
        </div>
      </div>
    </div>
  );
};

export default StripSilenceDialog;
