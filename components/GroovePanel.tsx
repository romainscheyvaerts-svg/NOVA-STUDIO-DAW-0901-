import React, { useMemo, useState } from 'react';
import { Clip, GrooveTemplate, Track, TrackType } from '../types';
import {
  PRESET_GROOVES, swingTemplate, setClipGroove, commitGroove, removeGroove, extractGroove, midiOnsets, onsetLevels, grooveLengthFor,
  readGroovePool, saveToGroovePool, removeFromGroovePool,
} from '../utils/groove';
import { transientsOf } from '../utils/transients';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';

/**
 * Fenêtre « Groove et swing » d'un clip (V25) : swing de croches ou de
 * doubles-croches (50 à 75 %), grooves prêts (MPC, trap), grooves extraits
 * de tes boucles ; intensité, effet sur la vélocité, calage. Le réglage
 * s'entend tout de suite (non destructif) ; « Appliquer le groove » le fige.
 * Sur un clip audio : extraire son groove pour le poser sur d'autres clips.
 */

interface Props {
  track: Track;
  clip: Clip;
  bpm: number;
  /** Écrit des champs du clip (une étape d'annulation, regroupée pendant un glissé). */
  onUpdateClip: (patch: Partial<Clip>) => void;
  onClose: () => void;
  notify?: (msg: string) => void;
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

/** Attaques d'un clip audio (temps du morceau) avec leur force. */
function audioOnsets(clip: Clip): { time: number; level: number }[] | null {
  const buf: AudioBuffer | undefined = (clip as any).buffer || (clip.bufferId ? audioBufferRegistry.get(clip.bufferId) : undefined);
  if (!buf) return null;
  const src = transientsOf(buf);
  const mono = buf.getChannelData(0);
  const levels = onsetLevels(mono, buf.sampleRate, src);
  const off = clip.offset || 0;
  return src
    .map((s, i) => ({ s, level: levels[i] }))
    .filter(o => o.s >= off - 1e-6 && o.s <= off + clip.duration + 1e-6)
    .map(o => ({ time: clip.start + (o.s - off), level: o.level }));
}

const GroovePanel: React.FC<Props> = ({ track, clip, bpm, onUpdateClip, onClose, notify }) => {
  const isMidi = clip.type === TrackType.MIDI && Array.isArray(clip.notes);
  const g = clip.groove;
  const [pool, setPool] = useState<GrooveTemplate[]>(readGroovePool);
  const [division, setDivision] = useState<8 | 16>(g?.template.stepsPerBeat === 2 ? 8 : 16);
  const swingFromTemplate = (t?: GrooveTemplate) => (t && /^swing(8|16)-/.test(t.id) ? 50 * ((t.timing[1] || 0) + 1) : 58);
  const [swing, setSwing] = useState<number>(Math.round(swingFromTemplate(g?.template)));
  const amount = g?.amount ?? 1;
  const velocity = g?.velocity ?? 0.5;
  const quantize = g?.quantize ?? 0;

  const write = (patch: { template?: GrooveTemplate; amount?: number; velocity?: number; quantize?: number }) => {
    const template = patch.template || g?.template || swingTemplate(division, swing);
    onUpdateClip(setClipGroove(clip, { template, amount: patch.amount ?? amount, velocity: patch.velocity ?? velocity, quantize: patch.quantize ?? quantize }, bpm));
  };

  const setSwingPct = (p: number, div = division) => { setSwing(p); setDivision(div); write({ template: swingTemplate(div, p) }); };

  // Mesure affichée : décalage des contretemps en ms (au tempo du projet).
  const measure = useMemo(() => {
    if (!g) return null;
    const slot = 60 / bpm / g.template.stepsPerBeat;
    const shifts = g.template.timing.map(t => t * slot * g.amount * 1000).filter(x => Math.abs(x) > 0.5);
    if (!shifts.length) return 'Groove sans décalage (vélocité seule).';
    const max = Math.max(...shifts.map(Math.abs));
    return `Notes décalées jusqu’à ${Math.round(max)} ms à ${Math.round(bpm)} BPM.`;
  }, [g, bpm]);

  const extract = () => {
    const onsets = isMidi ? midiOnsets(clip) : audioOnsets(clip);
    if (!onsets) { notify?.('Le son de ce clip n’est pas encore chargé : lance la lecture une fois, puis réessaie.'); return; }
    if (onsets.length < 4) { notify?.('Pas assez d’attaques dans ce clip pour en tirer un groove (il en faut au moins 4).'); return; }
    const tpl = extractGroove(onsets, { bpm, lengthBeats: grooveLengthFor(clip.duration, bpm), name: `Groove de « ${clip.name || track.name} »` });
    setPool(saveToGroovePool(tpl));
    notify?.(`🥁 Groove extrait de « ${clip.name || track.name} » (${onsets.length} attaques) : il est dans la liste, prêt à poser sur un autre clip.`);
  };

  const chip = (active: boolean) => `min-h-10 px-3 rounded-lg border text-[12px] font-bold text-left ${active ? 'bg-amber-400 border-amber-300 text-black' : 'bg-white/5 border-white/10 text-slate-200 hover:bg-white/10'}`;
  const slider = (label: string, hint: string, value: number, onChange: (v: number) => void, testid: string) => (
    <label className="block" title={hint}>
      <span className="flex justify-between text-[11px] text-slate-300"><span className="font-bold">{label}</span><span className="font-mono text-amber-200">{pct(value)}</span></span>
      <input type="range" min={0} max={100} step={1} value={Math.round(value * 100)} data-testid={testid}
        onChange={e => onChange(Number(e.target.value) / 100)} className="w-full h-8 accent-amber-400" disabled={!g} />
    </label>
  );

  return (
    <div className="fixed inset-0 z-[400] flex items-end sm:items-center justify-center bg-black/50" onPointerDown={onClose}>
      <div role="dialog" aria-label="Groove et swing" data-nova-groove=""
        className="w-full sm:w-[440px] max-h-[88dvh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-white/15 bg-[#16181d] p-4 shadow-2xl text-white"
        onPointerDown={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h3 className="text-[13px] font-black uppercase tracking-widest">{isMidi ? 'Groove et swing' : 'Extraire le groove'}</h3>
            <p className="text-[11px] text-slate-400">{track.name} · {clip.name}</p>
          </div>
          <button type="button" aria-label="Fermer" onClick={onClose} className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 text-slate-300"><i className="fas fa-times" /></button>
        </div>

        {!isMidi ? (
          <div className="space-y-3 text-[12px] text-slate-300">
            <p>NOVA repère les attaques de cette boucle (place et force de chaque coup) et en fait un groove. Pose-le ensuite sur tes clips MIDI : ils joueront avec le même balancement.</p>
            <p className="text-slate-500 text-[11px]">Comme « Extract Groove » dans Ableton Live et les grooves d’audio de Logic.</p>
            <button type="button" onClick={extract} data-testid="groove-extract"
              className="w-full min-h-11 rounded-xl bg-amber-400 text-black font-black"><i className="fas fa-wand-magic-sparkles mr-2" />Extraire le groove de cette boucle</button>
            {pool.length > 0 && <p className="text-[11px] text-slate-400">{pool.length} groove{pool.length > 1 ? 's' : ''} dans ta réserve.</p>}
          </div>
        ) : (
          <div className="space-y-4">
            <section>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400" title="Swing : place du contretemps dans chaque paire de notes. 50 % = droit, 66 % = triolet (swing de FL Studio, de la MPC et Q-Swing de Logic).">Swing</span>
                <div className="flex gap-1">
                  {([8, 16] as const).map(d => (
                    <button key={d} type="button" aria-pressed={division === d} onClick={() => setSwingPct(swing, d)} data-testid={`swing-div-${d}`}
                      className={`min-h-9 px-2.5 rounded-lg text-[11px] font-bold border ${division === d ? 'bg-cyan-400 border-cyan-300 text-black' : 'bg-white/5 border-white/10 text-slate-300'}`}>
                      {d === 8 ? 'Croches' : 'Doubles'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <input type="range" min={50} max={75} step={1} value={swing} aria-label="Swing en pourcentage" data-testid="swing-pct"
                  onChange={e => setSwingPct(Number(e.target.value))} className="flex-1 h-8 accent-cyan-400" />
                <span className="w-14 text-right font-mono text-cyan-200 text-[13px]">{swing} %</span>
              </div>
            </section>

            <section>
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5" title="Comme le Groove Pool d’Ableton Live : un clic pose le groove sur ce clip.">Grooves prêts</div>
              <div className="grid grid-cols-2 gap-1.5">
                {PRESET_GROOVES.map(p => (
                  <button key={p.id} type="button" title={p.hint} data-testid={`groove-${p.id}`} aria-pressed={g?.template.id === p.id}
                    onClick={() => write({ template: p })} className={chip(g?.template.id === p.id)}>{p.name}</button>
                ))}
                {pool.map(p => (
                  <span key={p.id} className="relative">
                    <button type="button" title="Groove extrait d’une de tes boucles" onClick={() => write({ template: p })} className={`${chip(g?.template.id === p.id)} w-full pr-8 truncate`}>{p.name}</button>
                    <button type="button" aria-label={`Retirer ${p.name} de la réserve`} onClick={() => setPool(removeFromGroovePool(p.id))}
                      className="absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 rounded text-slate-400 hover:text-white"><i className="fas fa-times text-[10px]" /></button>
                  </span>
                ))}
              </div>
            </section>

            <section className="space-y-2">
              {slider('Intensité', 'Force du décalage du groove (Timing dans le Groove Pool de Live).', amount, v => write({ amount: v }), 'groove-amount')}
              {slider('Effet sur la vélocité', 'Le groove change aussi la force des notes (Velocity dans le Groove Pool de Live).', velocity, v => write({ velocity: v }), 'groove-velocity')}
              {slider('Caler sur la grille', 'Ramène d’abord les notes sur la grille, puis ajoute le groove (Quantize dans le Groove Pool de Live).', quantize, v => write({ quantize: v }), 'groove-quantize')}
              {g ? <p className="text-[11px] text-cyan-200" role="status" data-testid="groove-measure">{g.template.name} · {measure}</p>
                : <p className="text-[11px] text-slate-500">Choisis un swing ou un groove : tu l’entends tout de suite à la lecture.</p>}
            </section>

            <div className="flex flex-col gap-2">
              <button type="button" disabled={!g} data-testid="groove-commit"
                onClick={() => { onUpdateClip(commitGroove(clip)); notify?.('Groove appliqué : les notes sont maintenant à leur nouvelle place (Ctrl+Z pour annuler).'); onClose(); }}
                title="Fige le groove dans les notes (Commit Groove dans Live)"
                className="w-full min-h-11 rounded-xl bg-amber-400 text-black font-black disabled:opacity-40">Appliquer le groove</button>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" disabled={!g} onClick={() => onUpdateClip(removeGroove(clip, bpm))} data-testid="groove-remove"
                  className="min-h-10 rounded-xl bg-white/5 border border-white/10 text-[12px] font-bold disabled:opacity-40">Retirer le groove</button>
                <button type="button" onClick={extract} data-testid="groove-extract"
                  title="Garde le placement de ce clip comme groove, pour le poser sur d’autres clips (Extract Groove dans Live)"
                  className="min-h-10 rounded-xl bg-white/5 border border-white/10 text-[12px] font-bold">Extraire son groove</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default GroovePanel;
