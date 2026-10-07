import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DrumMachine, makeDrumMachine } from '../utils/drumKits';
import { ChopMode, chopIntoPads, detectTransients, estimateLoopBpm, gridPoints, MAX_SLICES, normalizePoints, pointsToSlices, toggleMarker } from '../utils/chop';
import { clipRegionChannels, MAX_PADS } from '../utils/drumSamples';
import { bufferFrom, registerPadSample } from '../utils/padBuffers';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { etirerBufferAsync, facteurPourTempo } from '../utils/timeStretch';
import { audioEngine } from '../engine/AudioEngine';
import MiniWave from './MiniWave';
import type { SessionClipRef } from './PadSampleTools';

interface Props {
  dm: DrumMachine | null;
  onChange: (dm: DrumMachine) => void;
  onClose: () => void;
  bpm: number;
  sessionClips: SessionClipRef[];
  ensureEngine: () => Promise<unknown>;
  /** Son de départ (le pad choisi). */
  initial?: { buffer: AudioBuffer; name: string } | null;
  notify?: (msg: string) => void;
}

const channelsOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));

/**
 * « Découper en pads » : comme Slicex / Fruity Slicer dans FL Studio, ou
 * Simpler en mode Slice dans Ableton. Transitoires, grille ou à la main ;
 * chaque tranche devient un pad jouable dans le séquenceur et au clavier.
 */
const ChopPanel: React.FC<Props> = ({ dm, onChange, onClose, bpm, sessionClips, ensureEngine, initial, notify }) => {
  const [src, setSrc] = useState<{ buffer: AudioBuffer; name: string } | null>(initial || null);
  const [mode, setMode] = useState<ChopMode>('transients');
  const [sens, setSens] = useState(0.6);
  const [perBar, setPerBar] = useState(8);
  const [manual, setManual] = useState<number[] | null>(null);
  const [loopBpm, setLoopBpm] = useState<number>(bpm);
  const [keepTempo, setKeepTempo] = useState(true);
  const [choke, setChoke] = useState(true);
  const [busy, setBusy] = useState(false);
  const [hot, setHot] = useState(-1);
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Ouvert en bas d'un panneau défilé : on le ramène sous les yeux.
  useEffect(() => { boxRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [src]);
  const playing = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    if (!src) return;
    setLoopBpm(estimateLoopBpm(src.buffer.duration, bpm).bpm);
    setManual(null);
  }, [src]);

  const auto = useMemo(() => {
    if (!src) return [0];
    const b = src.buffer;
    return mode === 'grid'
      ? gridPoints(b.length, b.sampleRate, loopBpm, perBar)
      : detectTransients(channelsOf(b), b.sampleRate, { sensitivity: sens });
  }, [src, mode, sens, perBar, loopBpm]);
  const points = mode === 'manual' && manual ? manual : auto;
  const len = src?.buffer.length || 1;
  const fractions = useMemo(() => normalizePoints(points, len).map(p => p / len), [points, len]);
  const room = MAX_PADS - (dm?.rows.filter(r => !r.slice).length ?? 7);
  const count = Math.min(fractions.length, room, MAX_SLICES);
  const tempoDiff = Math.abs(loopBpm - bpm) > 0.5;

  const tap = (f: number) => {
    const base = mode === 'manual' && manual ? manual : auto;
    setManual(toggleMarker(base, f * len, len, len * 0.015));
    setMode('manual');
  };

  const play = (k: number) => {
    if (!src || !audioEngine.ctx) return;
    const ctx = audioEngine.ctx;
    const s = pointsToSlices(points, len)[k];
    if (!s) return;
    try { playing.current?.stop(); } catch { /* déjà arrêtée */ }
    const node = ctx.createBufferSource();
    node.buffer = src.buffer;
    node.connect(ctx.destination);
    node.start(0, s.start * src.buffer.duration, (s.end - s.start) * src.buffer.duration);
    playing.current = node;
    setHot(k);
    node.onended = () => setHot(h => (h === k ? -1 : h));
  };

  const pickFile = async (f?: File) => {
    if (!f) return;
    try {
      await ensureEngine();
      const buffer = await audioEngine.ctx!.decodeAudioData(await f.arrayBuffer());
      setSrc({ buffer, name: f.name.replace(/\.[a-z0-9]{2,5}$/i, '') });
    } catch { notify?.('Ce fichier ne se lit pas : essaie un WAV, MP3, AIFF ou FLAC.'); }
  };
  const pickClip = async (c: SessionClipRef) => {
    await ensureEngine();
    const buf = c.bufferId ? audioBufferRegistry.get(c.bufferId) : undefined;
    if (!buf || !audioEngine.ctx) { notify?.('Le son de ce clip n\'est pas chargé.'); return; }
    // Aperçu seulement : le son n'est rangé (sample du projet) qu'au moment de poser les tranches.
    setSrc({ buffer: bufferFrom(audioEngine.ctx, clipRegionChannels(channelsOf(buf), buf.sampleRate, c), buf.sampleRate), name: c.name });
  };

  const apply = async () => {
    if (!src || !audioEngine.ctx) return;
    setBusy(true);
    try {
      const ctx = audioEngine.ctx;
      let buffer = src.buffer;
      let pts = normalizePoints(points, len);
      let bufferBpm = loopBpm;
      // « Garder le tempo du projet » : la boucle est étirée au tempo du projet (sans changer sa hauteur).
      if (keepTempo && tempoDiff) {
        const f = facteurPourTempo(loopBpm, bpm);
        buffer = await etirerBufferAsync(ctx, src.buffer, f);
        pts = pts.map(p => Math.round(p * (buffer.length / len)));
        bufferBpm = bpm;
      }
      const reg = registerPadSample(buffer, src.name, { bpm: bufferBpm });
      const slices = pointsToSlices(pts, buffer.length).slice(0, count);
      const base = dm || { ...makeDrumMachine('empty') };
      const r = chopIntoPads(base, reg.id, reg.info, slices, { bufferBpm, duration: buffer.duration, choke, replace: true });
      onChange(r.dm);
      notify?.(`✂️ ${r.padIndexes.length} tranches posées sur les pads, dans le motif « Découpe ». Change l'ordre dans la grille, ou « 🎲 Remixer ». Annuler (Ctrl+Z) pour revenir.`);
      onClose();
    } catch {
      notify?.('La découpe a échoué : réessaie avec un son plus court.');
    } finally { setBusy(false); }
  };

  const tab = (m: ChopMode, label: string, title: string) => (
    <button type="button" role="tab" aria-selected={mode === m} title={title}
      onClick={() => { setMode(m); if (m === 'manual' && !manual) setManual(auto); }}
      className={`nova-hit h-9 px-3 text-[12px] font-bold ${mode === m ? 'bg-white text-black' : 'bg-white/5 text-white'}`}>{label}</button>
  );

  return (
    <div ref={boxRef} className="rounded-2xl border border-pink-400/30 bg-pink-500/[0.04] p-3 space-y-3 scroll-mt-2" role="region" aria-label="Découper en pads">
      <div className="flex items-center gap-2">
        <p className="text-[13px] font-black text-white mr-auto" title="Comme Slicex / Fruity Slicer dans FL Studio, ou Simpler en mode Slice dans Ableton">
          ✂️ Découper en pads {src && <span className="font-normal text-slate-400 text-[12px]">· {src.name} · {src.buffer.duration.toFixed(2)} s</span>}
        </p>
        <button type="button" onClick={onClose} aria-label="Fermer la découpe" className="nova-hit w-9 h-9 rounded-lg bg-white/5 text-slate-300"><i className="fas fa-times" /></button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <input ref={fileRef} data-nova-chop-file="" type="file" accept="audio/*,.wav,.mp3,.aif,.aiff,.flac,.ogg,.m4a" className="hidden"
          onChange={e => { void pickFile(e.target.files?.[0]); e.target.value = ''; }} />
        <button type="button" onClick={() => fileRef.current?.click()} className="nova-hit h-9 px-3 rounded-lg text-[11px] font-bold bg-white/10 text-white hover:bg-white/15">
          <i className="fas fa-file-import mr-1" />{src ? 'Autre boucle' : 'Importer une boucle'}
        </button>
        {sessionClips.slice(0, 6).map(c => (
          <button key={c.id} type="button" onClick={() => void pickClip(c)} title={`Découper le clip « ${c.name} » (${c.trackName || ''})`}
            className="nova-hit h-9 max-w-[180px] px-3 rounded-lg text-[11px] font-bold bg-white/5 text-slate-200 hover:bg-white/10 truncate">
            <i className="fas fa-film mr-1" />{c.name}
          </button>
        ))}
      </div>

      {!src ? (
        <p className="text-[12px] text-slate-400">Choisis une boucle (batterie, sample de soul, accords…) : Nova la coupe sur ses attaques, chaque tranche va sur un pad.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-xl overflow-hidden border border-white/10" role="tablist" aria-label="Façon de découper">
              {tab('transients', 'Attaques', 'Coupe sur les transitoires (chaque coup de batterie, chaque note) — comme « Detect » dans Slicex')}
              {tab('grid', 'Grille', 'Coupe à intervalles réguliers au tempo de la boucle — comme « Beat » dans Simpler')}
              {tab('manual', 'À la main', 'Touche la forme d\'onde pour ajouter ou retirer un repère — comme « Manual » dans Simpler')}
            </div>
            {mode === 'transients' && (
              <label className="flex items-center gap-2 text-[11px] text-slate-300" title="Sensibilité : plus haut = trouve aussi les coups faibles">
                Sensibilité
                <input type="range" min={0} max={1} step={0.05} value={sens} onChange={e => setSens(parseFloat(e.target.value))} className="accent-pink-400" />
              </label>
            )}
            {mode === 'grid' && (
              <div className="flex rounded-xl overflow-hidden border border-white/10" role="group" aria-label="Tranches par mesure">
                {[4, 8, 16].map(n => (
                  <button key={n} type="button" onClick={() => setPerBar(n)} aria-pressed={perBar === n}
                    className={`nova-hit h-9 px-3 text-[12px] font-bold ${perBar === n ? 'bg-pink-400 text-black' : 'bg-white/5 text-white'}`}>{n === 4 ? 'noires' : n === 8 ? 'croches' : 'doubles'}</button>
                ))}
              </div>
            )}
          </div>

          <MiniWave buffer={src.buffer} markers={fractions} hot={hot} height={96} onTap={tap}
            label="Forme d'onde : touche pour ajouter ou retirer un repère de découpe" />

          <div className="flex flex-wrap gap-1.5" aria-label="Écouter les tranches">
            {fractions.slice(0, count).map((_, k) => (
              <button key={k} type="button" onClick={() => play(k)} title={`Écouter la tranche ${k + 1}`}
                className={`nova-hit h-9 min-w-[36px] px-2 rounded-lg text-[12px] font-black ${hot === k ? 'bg-cyan-400 text-black' : 'bg-white/10 text-white'}`}>{k + 1}</button>
            ))}
            {fractions.length > count && <span className="self-center text-[11px] text-amber-300">{fractions.length - count} tranche(s) en trop : 30 pads au plus.</span>}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-slate-300">
            <label className="flex items-center gap-1.5" title="Tempo d'origine de la boucle (deviné d'après sa durée ; corrige-le si besoin)">
              Tempo de la boucle
              <input type="number" min={50} max={220} step={0.5} value={loopBpm} onChange={e => setLoopBpm(Math.max(50, Math.min(220, parseFloat(e.target.value) || bpm)))}
                onKeyDown={e => e.stopPropagation()} className="w-20 h-9 rounded-lg bg-black/30 border border-white/10 px-2 text-white tabular-nums" />
            </label>
            <label className={`flex items-center gap-1.5 ${tempoDiff ? '' : 'opacity-50'}`}
              title="Étire la boucle au tempo du projet sans changer sa hauteur, pour que les tranches tombent pile sur la grille (comme « Warp » dans Simpler, ou « Stretch » dans Slicex)">
              <input type="checkbox" checked={keepTempo} disabled={!tempoDiff} onChange={e => setKeepTempo(e.target.checked)} className="w-4 h-4 accent-pink-400" />
              Garder le tempo du projet ({Math.round(bpm)} BPM)
            </label>
            <label className="flex items-center gap-1.5" title="Une tranche coupe la précédente (lecture mono, comme Simpler en mode Slice)">
              <input type="checkbox" checked={choke} onChange={e => setChoke(e.target.checked)} className="w-4 h-4 accent-pink-400" />
              Les tranches se coupent
            </label>
          </div>

          <button type="button" disabled={busy || count < 1} onClick={() => void apply()}
            className="nova-hit w-full sm:w-auto h-11 px-5 rounded-xl text-[13px] font-black bg-gradient-to-r from-pink-500 to-violet-500 text-white disabled:opacity-50">
            {busy ? 'Découpe…' : `Poser ${count} tranche${count > 1 ? 's' : ''} sur les pads`}
          </button>
          <p className="text-[11px] text-slate-500">Les tranches d'une découpe précédente sont remplacées. Un motif « Découpe » rejoue la boucle telle quelle : change l'ordre dans la grille pour la réinventer.</p>
        </>
      )}
    </div>
  );
};

export default ChopPanel;
