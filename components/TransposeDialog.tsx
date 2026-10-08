/**
 * R13 · « Transposer / étirer le clip » : ±12 demi-tons au cent près, avec ou
 * sans les formants, et durée (étirement, calage au tempo du projet).
 *
 * Pro Tools : Clip Transpose / Elastic Audio (Polyphonic, Monophonic) ·
 * Logic : Flex Pitch, Transposer la région · Live : Transpose / Detune + Warp ·
 * FL : Pitch et Stretch du clip audio.
 *
 * Non destructif : l'original est gardé, le réglage se rouvre, « Revenir à
 * l'original » remet le son d'avant. Version simple (téléphone, mode simple) :
 * juste la tonalité du beat.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { Clip, DAWState, ElasticInfo, Track } from '../types';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import {
  detectMaterial, editingElastic, estimateTempo, elasticBlock, elasticLabel, elasticRevertPatch, isNeutralElastic, MAX_STRETCH, MIN_STRETCH, monoMix,
  semitoneText, stretchOf, withDuration, withSemitones,
} from '../utils/clipTranspose';
import { applyClipPatches, doneMessage, notifyElastic, renderAndApply } from '../services/elasticRender';

interface Props {
  open: boolean;
  targets: { trackId: string; clipId: string }[];
  tracks: Track[];
  bpm: number;
  setState: (fn: (prev: DAWState) => DAWState) => void;
  onClose: () => void;
  /** Version simple : la tonalité seulement (téléphone, mode simple). */
  simple?: boolean;
}

const has = (id: string) => !!audioBufferRegistry.get(id);

const AlgoHelp: Record<ElasticInfo['algo'], { label: string; title: string }> = {
  auto: { label: 'Auto', title: 'NOVA écoute le son et choisit : voix seule → moteur voix ; beat, sample, accords → moteur polyphonique (Pro Tools : choix de l’algorithme Elastic Audio).' },
  voice: { label: 'Voix', title: 'Voix seule (PSOLA, comme la justesse note par note) : timbre naturel, pas d’effet « chipmunk » (Pro Tools : Monophonic · Logic : Flex Pitch · Live : Tones).' },
  poly: { label: 'Beat / sample', title: 'Son polyphonique (beat entier, sample, accords) : vocodeur de phase avec attaques nettes (Pro Tools : Polyphonic · Logic : Polyphonic · Live : Complex Pro · FL : Pro mode).' },
};

const TransposeDialog: React.FC<Props> = ({ open, targets, tracks, bpm, setState, onClose, simple = false }) => {
  const resolved = useMemo(() => targets.map(t => {
    const track = tracks.find(x => x.id === t.trackId);
    const clip = track?.clips.find(c => c.id === t.clipId);
    return track && clip ? { track, clip } : null;
  }).filter(Boolean) as { track: Track; clip: Clip }[], [targets, tracks]);
  const first = resolved[0]?.clip;
  const start = useMemo(() => (first ? editingElastic(first, has).info : null), [first?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [semis, setSemis] = useState(0);
  const [cents, setCents] = useState(0);
  const [formants, setFormants] = useState(true);
  const [formantsTouched, setFormantsTouched] = useState(false);
  const [algo, setAlgo] = useState<ElasticInfo['algo']>('auto');
  /** Durée visée / durée d'origine (null : on garde celle du clip). */
  const [ratio, setRatio] = useState<number | null>(null);
  const [sampleBpm, setSampleBpm] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<'voice' | 'poly' | null>(null);
  const [estimated, setEstimated] = useState(false);

  useEffect(() => {
    if (!open || !start) return;
    const st = start.semitones || 0;
    const whole = Math.trunc(st);
    setSemis(whole); setCents(Math.round((st - whole) * 100));
    setFormants(start.formants ?? true);
    setFormantsTouched(!!first?.elastic);
    setAlgo(start.algo || 'auto');
    setRatio(null);
    setSampleBpm(start.tempo?.sourceBpm ? String(start.tempo.sourceBpm) : first?.warp?.originalBpm ? String(Math.round(first.warp.originalBpm * 100) / 100) : '');
    setError(null); setBusy(null); setDetected(null); setEstimated(false);
    // Ce que l'auto choisira (même analyse que le rendu : le milieu de la partie montrée, 20 s au plus).
    const id = window.setTimeout(() => {
      const buf = first ? audioBufferRegistry.get(editingElastic(first, has).bufferId || first.bufferId || '') : null;
      if (!buf) return;
      const sr = buf.sampleRate, a = Math.round((start.sourceOffset || 0) * sr), n = Math.min(buf.length - a, Math.round(Math.min(30, start.sourceDuration) * sr));
      if (n < sr * 0.3) return;
      const chs: Float32Array[] = [];
      for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c).subarray(a, a + n));
      try {
        const m = monoMix(chs);
        const kind = detectMaterial(m, sr).kind;
        setDetected(kind);
        // Tempo du sample inconnu : estimé (warp automatique d'Ableton), à corriger si besoin.
        if (kind === 'poly' && !start.tempo?.sourceBpm && !first?.warp?.originalBpm) {
          const t = estimateTempo(m, sr);
          if (t) { setSampleBpm(String(t.bpm)); setEstimated(true); }
        }
      } catch { /* */ }
    }, 120);
    return () => window.clearTimeout(id);
  }, [open, start]); // eslint-disable-line react-hooks/exhaustive-deps

  // Timbre gardé par défaut pour une voix, pas pour un beat (transposition « naturelle » des instruments).
  useEffect(() => { if (detected && !formantsTouched) setFormants(detected === 'voice'); }, [detected, formantsTouched]);

  if (!open || !resolved.length || !start) return null;

  const blocked = resolved.map(r => elasticBlock(r.clip)).find(Boolean) || null;
  const total = Math.max(-12, Math.min(12, semis + cents / 100));
  const revertable = resolved.filter(r => !!r.clip.elastic && !!r.clip.elastic.sourceBufferId && has(r.clip.elastic.sourceBufferId));
  const curRatio = ratio ?? stretchOf(start);
  const pct = Math.round(curRatio * 1000) / 10;
  const sb = Number(sampleBpm);
  const project = (info: ElasticInfo): ElasticInfo => {
    let out = withSemitones({ ...info, formants, algo }, total);
    if (!simple && ratio !== null) {
      out = withDuration(out, info.sourceDuration * ratio);
      out = { ...out, tempo: sb > 0 && Math.abs(ratio - sb / bpm) < 1e-6 ? { sourceBpm: sb, bpm } : undefined };
    }
    return out;
  };
  const preview = project(start);

  const apply = async () => {
    setError(null);
    try {
      const reqs = resolved.map(r => ({ trackId: r.track.id, clipId: r.clip.id, info: project(editingElastic(r.clip, has).info) }));
      const n = await renderAndApply(tracks, reqs, setState, m => setBusy(m));
      notifyElastic(n ? doneMessage(reqs[0].info, n) : 'Rien à changer.');
      onClose();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setBusy(null); }
  };

  const revert = () => {
    const patches = revertable.map(r => ({ trackId: r.track.id, clipId: r.clip.id, patch: elasticRevertPatch(r.clip, has)! })).filter(p => p.patch);
    applyClipPatches(setState, patches);
    notifyElastic(`↩️ ${patches.length > 1 ? `${patches.length} clips revenus` : 'Clip revenu'} à l'original. Ctrl+Z pour retrouver la transposition.`);
    onClose();
  };

  const fitTempo = () => {
    if (!(sb > 0)) { setError('Indique le tempo du sample (BPM) : il est souvent dans le nom du fichier.'); return; }
    setError(null);
    // Même calcul que withTempo (utils/clipTranspose) : un sample à 90 BPM dans un projet à 120 dure 75 %.
    setRatio(Math.max(MIN_STRETCH, Math.min(MAX_STRETCH, sb / bpm)));
  };

  const btn = 'min-h-[40px] [@media(pointer:coarse)]:min-h-[48px] rounded-xl border border-nv-line px-3 text-[13px] font-bold hover:bg-nv-accent/10 disabled:opacity-40';
  const step = (d: number) => setSemis(s => Math.max(-12, Math.min(12, s + d)));

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Transposer le clip" data-testid="transpose-dialog" onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto space-y-3 rounded-t-2xl sm:rounded-2xl border border-nv-line bg-nv-panel p-4 text-nv-ink shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-black">{simple ? 'Changer la tonalité' : 'Transposer / étirer le clip'}</h2>
            <p className="text-[11px] text-nv-muted" title="Pro Tools : Clip Transpose et Elastic Audio · Logic : Flex Pitch · Live : Transpose et Warp · FL : Pitch et Stretch du clip">
              {resolved.length > 1 ? `${resolved.length} clips` : `« ${first!.elastic?.sourceName || first!.name} »`} · la hauteur change, pas le tempo. L'original est gardé.
            </p>
          </div>
          <button type="button" disabled={!!busy} onClick={onClose} aria-label="Fermer" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10"><i className="fas fa-times" /></button>
        </div>

        {/* Tonalité : gros boutons au doigt, curseur, cents. */}
        <div className="rounded-xl bg-nv-well p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={() => step(-1)} disabled={semis <= -12} aria-label="Un demi-ton plus bas" data-testid="transpose-down"
              className="h-12 w-12 rounded-xl border border-nv-line text-[18px] font-black hover:bg-nv-accent/10 disabled:opacity-40">−</button>
            <div className="text-center">
              <div className="text-[22px] font-black tabular-nums" data-testid="transpose-value">{semitoneText(total)}</div>
              <div className="text-[10px] text-nv-muted">{total === 0 ? 'tonalité d’origine' : total > 0 ? 'plus aigu' : 'plus grave'}</div>
            </div>
            <button type="button" onClick={() => step(1)} disabled={semis >= 12} aria-label="Un demi-ton plus haut" data-testid="transpose-up"
              className="h-12 w-12 rounded-xl border border-nv-line text-[18px] font-black hover:bg-nv-accent/10 disabled:opacity-40">+</button>
          </div>
          <input type="range" min={-12} max={12} step={1} value={semis} onChange={e => setSemis(Number(e.target.value))} aria-label="Demi-tons" data-testid="transpose-semitones"
            title="−12 à +12 demi-tons (une octave de chaque côté)" className="w-full accent-cyan-500" />
          {!simple && (
            <label className="flex items-center gap-2 text-[11px]" title="Réglage fin, au cent près (100 cents = 1 demi-ton) : accorder un sample sur le beat (Live : Detune · Pro Tools : Fine).">
              <span className="w-16 text-nv-muted">Cents</span>
              <input type="range" min={-50} max={50} step={1} value={cents} onChange={e => setCents(Number(e.target.value))} aria-label="Cents" data-testid="transpose-cents" className="flex-1 accent-cyan-500" />
              <input type="number" min={-50} max={50} value={cents} onChange={e => setCents(Math.max(-50, Math.min(50, Math.round(Number(e.target.value) || 0))))} aria-label="Cents (valeur)"
                className="w-14 rounded-lg border border-nv-line bg-nv-panel px-1 py-1 text-right text-[12px] tabular-nums" />
            </label>
          )}
        </div>

        {!simple && (
          <>
            <div className="space-y-1.5">
              <div className="text-[11px] font-bold text-nv-muted">Moteur {algo === 'auto' && detected ? <span className="font-normal" data-testid="transpose-detected">· {detected === 'voice' ? 'voix détectée' : 'beat / sample détecté'}</span> : null}</div>
              <div role="radiogroup" aria-label="Moteur" className="flex gap-1 rounded-xl bg-nv-well p-1">
                {(['auto', 'voice', 'poly'] as const).map(a => (
                  <button key={a} type="button" role="radio" aria-checked={algo === a} onClick={() => setAlgo(a)} title={AlgoHelp[a].title} data-testid={`transpose-algo-${a}`}
                    className={`flex-1 min-h-[36px] [@media(pointer:coarse)]:min-h-[44px] rounded-lg px-2 text-[12px] font-bold ${algo === a ? 'bg-cyan-500 text-black' : 'text-nv-muted hover:bg-nv-accent/10'}`}>{AlgoHelp[a].label}</button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-[12px] min-h-[36px]" title="Garder le timbre (formants) : la voix reste la même personne, juste plus haut ou plus bas. Décoché : effet « chipmunk » / voix grave, comme un disque accéléré (Logic : Formant · Live : Formants de Complex Pro · Melodyne : formants).">
                <input type="checkbox" checked={formants} onChange={e => { setFormants(e.target.checked); setFormantsTouched(true); }} data-testid="transpose-formants" className="h-4 w-4 accent-cyan-500" />
                Garder le timbre (formants)
              </label>
            </div>

            <div className="rounded-xl bg-nv-well p-3 space-y-2">
              <label className="flex items-center gap-2 text-[12px]" title="Durée du clip, hauteur inchangée (Pro Tools : Trim TCE · Logic : Flex Time · Live : Warp · FL : Stretch). Plus rapide : tire le bord du clip avec Alt.">
                <span className="w-16 text-nv-muted">Durée</span>
                <input type="range" min={50} max={200} step={0.5} value={Math.min(200, Math.max(50, pct))} onChange={e => setRatio(Number(e.target.value) / 100)} aria-label="Durée en pourcentage" data-testid="transpose-stretch" className="flex-1 accent-cyan-500" />
                <input type="number" min={MIN_STRETCH * 100} max={MAX_STRETCH * 100} step={0.1} value={pct} onChange={e => setRatio(Math.max(MIN_STRETCH, Math.min(MAX_STRETCH, (Number(e.target.value) || 100) / 100)))}
                  aria-label="Durée (%)" className="w-16 rounded-lg border border-nv-line bg-nv-panel px-1 py-1 text-right text-[12px] tabular-nums" />
                <span className="text-nv-muted">%</span>
              </label>
              <div className="flex items-center gap-2 text-[12px]">
                <span className="w-16 text-nv-muted" title="Tempo d'origine du sample (souvent dans le nom du fichier) ; estimé à l'écoute s'il n'est pas connu">Sample{estimated ? <span className="block text-[9px]" data-testid="transpose-bpm-estimated">estimé</span> : null}</span>
                <input type="number" min={30} max={300} step={0.01} value={sampleBpm} placeholder="BPM" onChange={e => { setSampleBpm(e.target.value); setEstimated(false); }} aria-label="Tempo du sample (BPM)" data-testid="transpose-sample-bpm"
                  className="w-20 rounded-lg border border-nv-line bg-nv-panel px-2 py-1 text-right text-[12px] tabular-nums" />
                <button type="button" onClick={fitTempo} className={`${btn} flex-1`} data-testid="transpose-fit-tempo"
                  title="Cale le sample sur le tempo du projet, sans changer sa hauteur (Live : Warp · Pro Tools : Elastic Audio et Conform · Logic : Smart Tempo)">
                  <i className="fas fa-clock mr-1.5" />Caler sur {Math.round(bpm * 100) / 100} BPM
                </button>
              </div>
            </div>
          </>
        )}

        <p className="text-[11px] text-nv-muted" data-testid="transpose-summary">Résultat : {isNeutralElastic(preview) ? 'son d’origine' : elasticLabel(preview)}</p>
        {blocked && <p role="alert" className="rounded-lg bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-500">{blocked}</p>}
        {busy && <p role="status" className="text-[12px] text-nv-muted"><i className="fas fa-circle-notch animate-spin mr-2" />{busy}</p>}
        {error && <p role="alert" className="rounded-lg bg-red-500/10 px-2 py-1.5 text-[12px] text-red-400">{error}</p>}

        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!!busy || !!blocked} onClick={() => void apply()} data-testid="transpose-apply"
            className="min-h-[40px] [@media(pointer:coarse)]:min-h-[48px] flex-1 rounded-xl bg-cyan-500 px-4 text-[13px] font-bold text-black hover:bg-cyan-400 disabled:opacity-40">
            <i className="fas fa-check mr-2" />Appliquer
          </button>
          {revertable.length > 0 && (
            <button type="button" disabled={!!busy} onClick={revert} data-testid="transpose-revert" title="Remet le son d'origine (durée et tonalité d'avant)" className={btn}>
              <i className="fas fa-rotate-left mr-2" />Revenir à l'original
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default TransposeDialog;
