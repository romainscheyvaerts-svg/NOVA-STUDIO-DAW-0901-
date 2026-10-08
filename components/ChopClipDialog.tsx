import React, { useEffect, useMemo, useRef, useState } from 'react';
import { produce } from 'immer';
import { DAWState, MidiNote, Track } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { clipRegionChannels } from '../utils/drumSamples';
import { detectTransients, gridPoints, equalPoints, normalizePoints, pointsToSlices, snapToZero, toggleMarker, chopIntoPads, MAX_SLICES } from '../utils/chop';
import { makeDrumMachine, DrumMachine } from '../utils/drumKits';
import { registerPadSample } from '../utils/padBuffers';
import { DEFAULT_SAMPLER, MelodicSamplerSettings, newSamplerSampleId, normalizeSampler, noteName, samplerBufferKey, sliceNote } from '../utils/melodicSampler';

/**
 * R18 · Découper (chop) un sample depuis le menu d'un clip de l'arrangement
 * (FL : Slicex / « Chop » du sampler · Live : « Slice to New MIDI Track » ·
 * Logic : Quick Sampler en mode Slice). Les tranches (sur les attaques, à la
 * grille ou en parts égales) vont :
 *  - sur des NOTES d'un sampler (une tranche par note à partir de C3), avec
 *    un clip MIDI qui rejoue l'original à l'identique ;
 *  - ou sur des PADS de la boîte à rythmes, avec un motif « Découpe ».
 */

interface Props {
  target: { trackId: string; clipId: string };
  tracks: Track[];
  bpm: number;
  isMobile: boolean;
  setState: (updater: (prev: DAWState) => DAWState) => void;
  getState: () => DAWState;
  createSamplerTrack: (o: { name: string; settings: MelodicSamplerSettings; notes?: MidiNote[]; start?: number; duration?: number; afterTrackId?: string }) => { trackId: string; clipId: string };
  notify: (msg: string) => void;
  onClose: () => void;
}

type Mode = 'transients' | 'grid' | 'equal';
const channelsOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
const mono = (ch: Float32Array[]) => {
  if (ch.length === 1) return ch[0];
  const o = new Float32Array(ch[0].length);
  ch.forEach(c => { for (let i = 0; i < o.length; i++) o[i] += c[i] / ch.length; });
  return o;
};

/** Points de découpe d'un son (échantillons), sur des passages par zéro. */
export function chopPoints(channels: Float32Array[], sampleRate: number, mode: Mode, o: { sensitivity: number; bpm: number; perBar: number; count: number }): number[] {
  const len = channels[0]?.length || 0;
  if (!len) return [0];
  let pts: number[];
  if (mode === 'transients') pts = detectTransients(channels, sampleRate, { sensitivity: o.sensitivity, maxSlices: MAX_SLICES });
  else if (mode === 'grid') pts = gridPoints(len, sampleRate, o.bpm, o.perBar, MAX_SLICES);
  else pts = equalPoints(len, o.count);
  const x = mono(channels);
  // Attaques : le point juste avant la montée (passage par zéro) ; grille et parts égales : au plus près.
  return normalizePoints(pts.map(p => (p === 0 ? 0 : snapToZero(x, p, mode === 'transients' ? 96 : 48))), len);
}

const ChopClipDialog: React.FC<Props> = ({ target, tracks, bpm, isMobile, setState, getState, createSamplerTrack, notify, onClose }) => {
  const track = tracks.find(t => t.id === target.trackId);
  const clip = track?.clips.find(c => c.id === target.clipId);
  const src = clip?.bufferId ? audioBufferRegistry.get(clip.bufferId) : undefined;
  const region = useMemo(() => (src && clip ? clipRegionChannels(channelsOf(src), src.sampleRate, clip) : null), [src, clip]);
  const sr = src?.sampleRate || 48000;
  const len = region?.[0]?.length || 0;
  const [mode, setMode] = useState<Mode>('transients');
  const [sens, setSens] = useState(0.5);
  const [perBar, setPerBar] = useState(8);
  const [count, setCount] = useState(8);
  const [dest, setDest] = useState<'notes' | 'pads'>('notes');
  const [muteOriginal, setMuteOriginal] = useState(true);
  const [manual, setManual] = useState<number[] | null>(null);
  const auto = useMemo(() => (region ? chopPoints(region, sr, mode, { sensitivity: sens, bpm, perBar, count }) : [0]), [region, sr, mode, sens, bpm, perBar, count]);
  useEffect(() => { setManual(null); }, [mode, sens, perBar, count]);
  const points = manual || auto;
  const slices = pointsToSlices(points, Math.max(1, len));
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<AudioBufferSourceNode | null>(null);
  const regionBuf = useMemo(() => {
    if (!region || !audioEngine.ctx) return null;
    const b = audioEngine.ctx.createBuffer(region.length, Math.max(1, len), sr);
    region.forEach((c, i) => b.getChannelData(i).set(c));
    return b;
  }, [region, len, sr]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => () => { try { preview.current?.stop(); } catch { /* finie */ } }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !region) return;
    const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const x = region[0];
    const step = Math.max(1, Math.floor(x.length / w));
    slices.forEach((s, i) => { g.fillStyle = i % 2 ? 'rgba(236,72,153,0.10)' : 'rgba(34,211,238,0.10)'; g.fillRect(s.start * w, 0, (s.end - s.start) * w, h); });
    g.fillStyle = '#94a3b8';
    for (let px = 0; px < w; px++) {
      let m = 0;
      for (let k = px * step; k < Math.min(x.length, (px + 1) * step); k++) { const a = Math.abs(x[k]); if (a > m) m = a; }
      g.fillRect(px, h / 2 - m * (h / 2 - 2), 1, Math.max(1, m * (h - 4)));
    }
    g.fillStyle = '#ec4899';
    g.font = 'bold 10px system-ui';
    slices.forEach((s, i) => { g.fillRect(Math.round(s.start * w), 0, 2, h); g.fillText(String(i + 1), s.start * w + 4, 11); });
  }, [region, slices]);

  if (!track || !clip || !src || !region) {
    return (
      <div className="fixed inset-0 z-[320] bg-black/60 flex items-center justify-center" role="dialog" aria-modal="true">
        <div className="bg-nv-panel text-nv-ink border border-nv-line rounded-2xl p-4 max-w-sm">
          <p className="text-[13px]">Ce clip n’a pas de son chargé : attends la fin du chargement, puis réessaie.</p>
          <button type="button" onClick={onClose} className="mt-3 h-10 px-4 rounded-lg bg-nv-raised border border-nv-line">Fermer</button>
        </div>
      </div>
    );
  }

  const audition = (i: number) => {
    const ctx = audioEngine.ctx;
    const s = slices[i];
    if (!ctx || !regionBuf || !s) return;
    try { preview.current?.stop(); } catch { /* finie */ }
    const n = ctx.createBufferSource();
    n.buffer = regionBuf;
    n.connect(ctx.destination);
    n.start(0, s.start * regionBuf.duration, (s.end - s.start) * regionBuf.duration);
    preview.current = n;
  };

  const onCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    if (e.altKey || e.shiftKey || e.button === 2) {
      // Repère à la main (Alt / Maj + clic) : ajouté ou retiré.
      setManual(toggleMarker(points, snapToZero(mono(region), frac * len), len, len * 0.01));
      return;
    }
    const i = slices.findIndex(s => frac >= s.start && frac < s.end);
    if (i >= 0) audition(i);
  };

  const apply = () => {
    const ctx = audioEngine.ctx;
    if (!ctx || !regionBuf) return;
    const dur = regionBuf.duration;
    if (dest === 'notes') {
      const id = newSamplerSampleId();
      audioBufferRegistry.register(regionBuf, samplerBufferKey(id));
      const settings = normalizeSampler({
        ...DEFAULT_SAMPLER, sampleId: id, sampleName: `${clip.name || 'Clip'} (tranches)`, duration: dur,
        slices, sliceBase: 48, velSens: 0, attack: 0, release: 0.01,
      });
      // Clip MIDI : chaque tranche à sa place d'origine, sur sa note → l'original rejoué tel quel.
      const notes: MidiNote[] = slices.map((s, i) => ({
        id: `sl-${i}-${Date.now().toString(36)}`, pitch: sliceNote(i, 48), start: s.start * dur, duration: (s.end - s.start) * dur, velocity: 1,
      }));
      createSamplerTrack({ name: `Tranches ${clip.name || ''}`.trim(), settings, notes, start: clip.start, duration: clip.duration, afterTrackId: track.id });
      notify(`✂️ ${slices.length} tranches de « ${clip.name || 'Clip'} » sur les notes ${noteName(48)} à ${noteName(48 + slices.length - 1)} d’un sampler, avec un clip MIDI qui rejoue l’original : déplace les notes pour remixer (comme Slicex de FL ou « Slice to MIDI » de Live).`);
    } else {
      const st = getState();
      const dm0 = (st.tracks.find(t => t.id === 'track-drums')?.drumMachine as DrumMachine | undefined) || makeDrumMachine('empty');
      const { id, info } = registerPadSample(regionBuf, clip.name || 'Clip', { bpm });
      const r = chopIntoPads(dm0, id, info, slices, { bufferBpm: bpm, duration: dur });
      window.dispatchEvent(new CustomEvent('nova:apply-drum-machine', { detail: { dm: r.dm } }));
      notify(`✂️ ${r.padIndexes.length} tranches posées sur des pads, avec le motif « Découpe » qui les rejoue dans l’ordre : ouvre la batterie pour les remixer.`);
    }
    if (muteOriginal) {
      setState(produce((d: DAWState) => {
        const c = d.tracks.find(t => t.id === target.trackId)?.clips.find(x => x.id === target.clipId);
        if (c) c.isMuted = true;
      }) as (s: DAWState) => DAWState);
    }
    onClose();
  };

  const seg = (cur: string, items: [string, string, string][], set: (v: string) => void, label: string) => (
    <div className="flex rounded-lg overflow-hidden border border-nv-line" role="group" aria-label={label}>
      {items.map(([v, txt, tip]) => (
        <button key={v} type="button" onClick={() => set(v)} aria-pressed={cur === v} title={tip} data-testid={`chop-${label === 'Découper' ? 'mode' : 'dest'}-${v}`}
          className={`min-h-[40px] px-3 text-[12px] font-bold ${cur === v ? 'bg-pink-500 text-black' : 'bg-nv-raised text-nv-ink'}`}>{txt}</button>
      ))}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[320] bg-black/60 flex items-stretch sm:items-center justify-center" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog" aria-modal="true" aria-label="Découper le clip" data-testid="chop-clip-dialog">
      <div className="w-full sm:w-[min(820px,96vw)] h-full sm:h-auto bg-nv-panel text-nv-ink sm:rounded-2xl border border-nv-line shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-nv-line">
          <h2 className="text-[14px] font-black mr-auto truncate">✂️ Découper « {clip.name || 'Clip'} »</h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="nova-hit w-10 h-10 rounded-lg bg-nv-raised border border-nv-line"><i className="fas fa-times" /></button>
        </div>
        <div className="p-3 flex flex-col gap-3 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2">
            {seg(mode, [
              ['transients', 'Attaques', 'Une tranche par attaque (transitoire), comme Slicex de FL ou le mode « Transient » de Simpler'],
              ['grid', 'Grille', 'Une tranche par division de la mesure au tempo du projet (« Beat » dans Simpler, « Auto-slice » de FL)'],
              ['equal', 'Égales', 'N tranches de même longueur (« Region » dans Simpler)'],
            ], v => setMode(v as Mode), 'Découper')}
            {mode === 'transients' && (
              <label className="flex items-center gap-2 text-[12px] text-nv-muted" title="Plus haut : trouve aussi les attaques faibles">
                Sensibilité <input type="range" min={0} max={1} step={0.05} value={sens} onChange={e => setSens(parseFloat(e.target.value))} className="w-28 accent-pink-500" />
              </label>
            )}
            {mode === 'grid' && (
              <select value={perBar} onChange={e => setPerBar(parseInt(e.target.value, 10))} aria-label="Division"
                className="min-h-[40px] rounded-lg bg-nv-raised border border-nv-line px-2 text-[12px]">
                {[[4, 'Noires (1/4)'], [8, 'Croches (1/8)'], [16, 'Doubles (1/16)']].map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            )}
            {mode === 'equal' && (
              <select value={count} onChange={e => setCount(parseInt(e.target.value, 10))} aria-label="Nombre de tranches"
                className="min-h-[40px] rounded-lg bg-nv-raised border border-nv-line px-2 text-[12px]">
                {[2, 4, 8, 16].map(v => <option key={v} value={v}>{v} tranches</option>)}
              </select>
            )}
            <span className="ml-auto text-[12px] font-bold text-pink-500" data-testid="chop-count">{slices.length} tranche{slices.length > 1 ? 's' : ''}</span>
          </div>
          <canvas ref={canvas} onPointerDown={onCanvas} onContextMenu={e => e.preventDefault()} data-testid="chop-wave"
            title={isMobile ? 'Touche une tranche pour l’écouter' : 'Clic : écouter la tranche · Alt + clic : ajouter / retirer un repère'}
            className="w-full h-28 rounded-lg bg-nv-bg border border-nv-line touch-none cursor-pointer" />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-nv-muted">Vers</span>
            {seg(dest, [
              ['notes', 'Notes (sampler)', 'Une tranche par note d’un sampler, à partir de C3, avec un clip MIDI qui rejoue l’original (Live : Slice to New MIDI Track · Logic : Quick Sampler en Slice)'],
              ['pads', 'Pads (batterie)', 'Une tranche par pad de la boîte à rythmes, avec le motif « Découpe » (FL : Slicex / Fruity Slicer)'],
            ], v => setDest(v as 'notes' | 'pads'), 'Vers')}
            <label className="flex items-center gap-2 text-[12px] text-nv-muted ml-auto">
              <input type="checkbox" checked={muteOriginal} onChange={e => setMuteOriginal(e.target.checked)} className="w-5 h-5 accent-pink-500" />Couper le clip d’origine
            </label>
          </div>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 border-t border-nv-line">
          <p className="text-[11px] text-nv-muted mr-auto hidden sm:block">Annuler (Ctrl+Z) remet tout comme avant.</p>
          <button type="button" onClick={onClose} className="h-11 px-4 rounded-lg bg-nv-raised border border-nv-line text-[13px] font-bold">Annuler</button>
          <button type="button" onClick={apply} data-testid="chop-apply" className="h-11 px-5 rounded-lg bg-pink-500 text-black text-[13px] font-black">Découper</button>
        </div>
      </div>
    </div>
  );
};

export default ChopClipDialog;
