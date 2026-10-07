import React, { useEffect, useRef, useState } from 'react';
import type { DrumMachine, DrumRow } from '../utils/drumKits';
import { assignSample, regionOf, removePad, userSampleId } from '../utils/drumSamples';
import { padSourceBuffer, sampleFromClip, sampleFromFile } from '../utils/padBuffers';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { audioEngine } from '../engine/AudioEngine';
import MiniWave from './MiniWave';

export interface SessionClipRef {
  id: string; name: string; bufferId?: string; offset: number; duration: number; isReversed?: boolean; gain?: number; color?: string; trackName?: string;
}

interface Props {
  dm: DrumMachine;
  rowIndex: number;
  onChange: (dm: DrumMachine) => void;
  onAudition: () => void;
  sessionClips: SessionClipRef[];
  ensureEngine: () => Promise<unknown>;
  /** Ouvre la découpe avec le son de ce pad. */
  onChop: (src: { buffer: AudioBuffer; name: string }) => void;
  notify?: (msg: string) => void;
}

const CHOKES: { v: number; label: string }[] = [
  { v: 0, label: 'aucun' }, { v: 1, label: '1 (hi-hats)' }, { v: 2, label: '2' }, { v: 3, label: '3' }, { v: 4, label: '4' }, { v: 9, label: 'tranches' },
];

/**
 * Sample du pad : importer ton son ou un clip du morceau, début / fin, fondus,
 * reverse, groupe de choke (comme le Drum Rack d'Ableton ou le sampler de canal de FL Studio).
 */
const PadSampleTools: React.FC<Props> = ({ dm, rowIndex, onChange, onAudition, sessionClips, ensureEngine, onChop, notify }) => {
  const row = dm.rows[rowIndex] as DrumRow;
  const [src, setSrc] = useState<AudioBuffer | null>(null);
  const [clipsOpen, setClipsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const reg = regionOf(row);
  const custom = userSampleId(row.sound);
  const info = custom ? dm.samples?.[custom] : undefined;

  useEffect(() => {
    let alive = true;
    void ensureEngine().then(() => {
      if (!audioEngine.ctx) return;
      return padSourceBuffer(row, audioEngine.ctx, 0).then(b => { if (alive) setSrc(b); });
    }).catch(() => { if (alive) setSrc(null); });
    return () => { alive = false; };
  }, [row.sound]);

  // Pré-écoute après le réglage (pas à chaque cran du curseur).
  const auditionTimer = useRef<number | null>(null);
  const edit = (patch: Partial<DrumRow>) => {
    onChange({ ...dm, rows: dm.rows.map((r, i) => (i === rowIndex ? { ...r, ...patch } : r)) });
    if (auditionTimer.current) window.clearTimeout(auditionTimer.current);
    auditionTimer.current = window.setTimeout(onAudition, 220);
  };

  const importFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      await ensureEngine();
      const s = await sampleFromFile(audioEngine.ctx!, f);
      const r = assignSample(dm, s.id, s.info, { rowIndex });
      if (r) { onChange(r.dm); onAudition(); notify?.(`🥁 « ${s.info.name} » est sur le pad. Annuler (Ctrl+Z) pour revenir au son d'avant.`); }
    } catch {
      notify?.('Ce fichier ne se lit pas : essaie un WAV, MP3, AIFF ou FLAC.');
    } finally { setBusy(false); }
  };

  const takeClip = async (c: SessionClipRef) => {
    await ensureEngine();
    const buf = c.bufferId ? audioBufferRegistry.get(c.bufferId) : undefined;
    if (!buf || !audioEngine.ctx) { notify?.('Le son de ce clip n\'est pas chargé.'); return; }
    const s = sampleFromClip(audioEngine.ctx, buf, c);
    const r = assignSample(dm, s.id, s.info, { rowIndex });
    if (r) { onChange(r.dm); onAudition(); setClipsOpen(false); }
  };

  const pct = (v: number) => `${Math.round(v * 1000) / 10} %`;
  const ms = (v: number) => (v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`);
  const btn = 'nova-hit h-9 px-3 rounded-lg text-[11px] font-bold bg-white/10 text-white hover:bg-white/15 disabled:opacity-40';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mr-auto">
          Sample {info ? <span className="normal-case font-normal text-slate-300">· {info.name}{row.slice ? ` · tranche ${row.slice}` : ''}</span> : null}
        </p>
        <input ref={fileRef} type="file" accept="audio/*,.wav,.mp3,.aif,.aiff,.flac,.ogg,.m4a" className="hidden"
          onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }} />
        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className={btn}
          title="Mets TON son sur ce pad (comme glisser un sample dans le Drum Rack d'Ableton). Tu peux aussi glisser un fichier sur le nom du pad.">
          <i className="fas fa-file-import mr-1" />{busy ? 'Chargement…' : 'Ton son'}
        </button>
        <button type="button" onClick={() => setClipsOpen(v => !v)} aria-expanded={clipsOpen} disabled={!sessionClips.length} className={btn}
          title={sessionClips.length ? 'Prendre un clip audio du morceau (sa partie jouée) comme son de ce pad' : 'Aucun clip audio dans le morceau'}>
          <i className="fas fa-film mr-1" />Clip du morceau
        </button>
        {src && (
          <button type="button" onClick={() => onChop({ buffer: src, name: info?.name || row.name })} className={btn}
            title="Découper ce son en tranches sur des pads (comme Slicex dans FL Studio ou Simpler en mode Slice dans Ableton)">
            <i className="fas fa-cut mr-1" />Découper
          </button>
        )}
      </div>
      {clipsOpen && (
        <div className="max-h-40 overflow-y-auto rounded-xl border border-white/10 divide-y divide-white/5">
          {sessionClips.map(c => (
            <button key={c.id} type="button" onClick={() => void takeClip(c)}
              className="nova-hit w-full flex items-center gap-2 px-3 h-10 text-left text-[12px] text-white hover:bg-white/5">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: c.color || '#94a3b8' }} />
              <span className="truncate flex-1">{c.name}</span>
              <span className="text-[11px] text-slate-400 shrink-0">{c.trackName} · {c.duration.toFixed(1)} s</span>
            </button>
          ))}
        </div>
      )}

      <MiniWave buffer={src} region={reg} height={56} label={`Forme d'onde du pad ${row.name}`} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
        <Slider label="Début" title="Début du son joué (comme « Sample Start »)" value={reg.start} min={0} max={0.99} step={0.001} fmt={pct}
          onChange={v => edit({ start: v, end: Math.max(v + 0.005, reg.end) })} onReset={() => edit({ start: 0 })} />
        <Slider label="Fin" title="Fin du son joué" value={reg.end} min={0.01} max={1} step={0.001} fmt={pct}
          onChange={v => edit({ end: v, start: Math.min(reg.start, v - 0.005) })} onReset={() => edit({ end: 1 })} />
        <Slider label="Fondu entrée" title="Fondu d'entrée (adoucit l'attaque)" value={reg.fadeIn} min={0} max={0.5} step={0.001} fmt={ms}
          onChange={v => edit({ fadeIn: v })} onReset={() => edit({ fadeIn: 0 })} />
        <Slider label="Fondu sortie" title="Fondu de sortie" value={reg.fadeOut} min={0} max={1} step={0.001} fmt={ms}
          onChange={v => edit({ fadeOut: v })} onReset={() => edit({ fadeOut: 0 })} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => edit({ reverse: !row.reverse })} aria-pressed={!!row.reverse}
          title="Jouer le son à l'envers (comme « Reverse » dans le sampler de canal de FL Studio)"
          className={`nova-hit h-9 px-3 rounded-lg text-[11px] font-black ${row.reverse ? 'bg-amber-400 text-black' : 'bg-white/10 text-white'}`}>
          <i className="fas fa-backward mr-1" />Reverse
        </button>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-300"
          title="Groupe de choke : les pads d'un même groupe se coupent (le hi-hat fermé coupe l'ouvert), comme les Choke groups du Drum Rack d'Ableton ou le « Cut by » de FL Studio">
          Choke
          <select value={row.choke || 0} onChange={e => edit({ choke: parseInt(e.target.value, 10) || undefined })}
            className="h-9 rounded-lg bg-white/5 border border-white/10 px-1.5 text-[11px] text-white">
            {CHOKES.map(c => <option key={c.v} value={c.v}>{c.label}</option>)}
          </select>
        </label>
        {dm.rows.length > 1 && (custom || row.slice) && (
          <button type="button" onClick={() => onChange(removePad(dm, rowIndex))} className="ml-auto nova-hit h-9 px-3 rounded-lg text-[11px] font-bold bg-white/5 text-red-300 hover:bg-red-500/15"
            title="Retirer ce pad (Annuler pour le remettre)"><i className="fas fa-trash mr-1" />Retirer le pad</button>
        )}
      </div>
    </div>
  );
};

const Slider: React.FC<{ label: string; title: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void; onReset: () => void }> = k => (
  <label className="flex flex-col gap-1 min-w-0" title={k.title}>
    <span className="flex justify-between text-[11px] text-slate-400">
      <span>{k.label}</span>
      <button type="button" onClick={k.onReset} title="Remettre à zéro" className="tabular-nums text-slate-200 hover:text-cyan-300">{k.fmt(k.value)}</button>
    </span>
    <input type="range" min={k.min} max={k.max} step={k.step} value={k.value} onChange={e => k.onChange(parseFloat(e.target.value))} className="w-full accent-amber-400" />
  </label>
);

export default PadSampleTools;
