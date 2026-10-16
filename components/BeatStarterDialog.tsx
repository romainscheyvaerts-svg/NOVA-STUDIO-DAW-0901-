import React, { useEffect, useMemo, useRef, useState } from 'react';
import { audioEngine } from '../engine/AudioEngine';
import { loadKitIndex, type KitIndex } from '../utils/drumKitLibrary';
import { BEAT_GENRES, genreRecipe, type BeatGenreId } from '../utils/beatRecipes';
import { beatVariants, isMinor, keyNameFr, progressionsFor, type BeatSkeleton } from '../utils/beatStarter';
import { renderSkeleton } from '../utils/soundPreview';
import { NOTE_NAMES_FR } from '../utils/scales';
import type { ChordQuality } from '../utils/chordDetect';

/**
 * Lot 10 · « Démarrer un beat » : genre → squelette de 8 mesures à base de RÈGLES (tempo du genre,
 * motif de batterie d'une recette connue, suite d'accords classique dans la tonalité choisie, 808
 * qui suit les fondamentales). Le dé propose 3 variantes ; rien n'est généré par une IA.
 */

export interface BeatStarterDialogProps {
  bpm: number;
  root: number | null;
  scale: string | null;
  /** Une instru est déjà chargée : on garde son tempo et sa tonalité. */
  hasBeat: boolean;
  /** Le projet a déjà une batterie / une 808 / des accords du squelette : ils seront remplacés. */
  replaces: string[];
  isMobile: boolean;
  ensureEngine?: () => Promise<unknown>;
  notify?: (msg: string) => void;
  onApply: (sk: BeatSkeleton) => void;
  onClose: () => void;
}

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SUFFIX: Record<ChordQuality, string> = { maj: '', min: 'm', '7': '7', maj7: 'maj7', min7: 'm7', sus2: 'sus2', sus4: 'sus4', dim: 'dim' };
/** Tonalités écrites avec des dièses (Sol, Ré, La, Mi, Si majeur ; Mi, Si, Fa#, Do# mineur) : les autres en bémols. */
const sharpKey = (root: number, minor: boolean) => (minor ? [4, 11, 6, 1, 8] : [7, 2, 9, 4, 11, 6]).includes(((root % 12) + 12) % 12);
const chordName = (root: number, q: ChordQuality, keyRoot: number, minor: boolean) =>
  `${(sharpKey(keyRoot, minor) ? SHARP : FLAT)[((root % 12) + 12) % 12]}${SUFFIX[q] ?? ''}`;

const BeatStarterDialog: React.FC<BeatStarterDialogProps> = p => {
  const [genre, setGenre] = useState<BeatGenreId>('trap');
  const g = genreRecipe(genre);
  const [root, setRoot] = useState<number>(p.root ?? g.defaultRoot);
  const [mode, setMode] = useState<'minor' | 'major'>(p.root !== null && p.scale ? (isMinor(p.scale) ? 'minor' : 'major') : (isMinor(g.scale) ? 'minor' : 'major'));
  const [bpm, setBpm] = useState<number>(p.hasBeat ? p.bpm : g.bpm);
  const [seed, setSeed] = useState(0);
  const [pick, setPick] = useState(0);
  const [ix, setIx] = useState<KitIndex | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const [loading, setLoading] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  const h = p.isMobile ? 'h-11' : 'h-10';

  useEffect(() => { loadKitIndex().then(setIx).catch(() => setIx(null)); }, []);
  useEffect(() => () => { audioEngine.stopAudition(); if (timer.current) window.clearTimeout(timer.current); }, []);

  const chooseGenre = (id: BeatGenreId) => {
    const ng = genreRecipe(id);
    setGenre(id); setPick(0); setSeed(0);
    if (!p.hasBeat) setBpm(ng.bpm);
    if (p.root === null) { setRoot(ng.defaultRoot); setMode(isMinor(ng.scale) ? 'minor' : 'major'); }
    stop();
  };

  const modes = useMemo(() => {
    const all = progressionsFor(genre, null);
    return { minor: all.some(x => isMinor(x.scale)), major: all.some(x => !isMinor(x.scale)) };
  }, [genre]);
  const effMode = modes[mode] ? mode : mode === 'minor' ? 'major' : 'minor';

  const variants = useMemo(() => beatVariants({ genre, root, mode: effMode, bpm, seed }), [genre, root, effMode, bpm, seed]);
  const sk = variants[Math.min(pick, variants.length - 1)];

  const stop = () => { audioEngine.stopAudition(); setPlaying(null); if (timer.current) window.clearTimeout(timer.current); };
  const listen = async (i: number) => {
    if (playing === i) { stop(); return; }
    setLoading(i);
    try {
      await p.ensureEngine?.();
      const ctx = audioEngine.ctx;
      if (!ctx) throw new Error('audio');
      if (ctx.state !== 'running') await ctx.resume().catch(() => {});
      const buf = await renderSkeleton(variants[i], ctx.sampleRate, ix);
      audioEngine.auditionBuffers([{ buffer: buf, at: 0 }]);
      setPlaying(i);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setPlaying(c => (c === i ? null : c)), buf.duration * 1000 + 100);
    } catch {
      p.notify?.('La pré-écoute ne démarre pas (sons pas encore chargés ou hors ligne). Réessaie, ou pose le squelette directement : tu l’écouteras dans le projet.');
    } finally { setLoading(null); }
  };

  const chordLine = (s: BeatSkeleton) => {
    const seen: string[] = [];
    for (const c of s.chords) { const sym = chordName(c.root, c.quality, s.root, isMinor(s.scale)); if (seen[seen.length - 1] !== sym) seen.push(sym); if (seen.length >= 8) break; }
    // Une seule fois la suite (elle se répète sur 8 mesures).
    const n = s.progression.chords.length;
    return seen.slice(0, n).join(' – ');
  };

  return (
    <div className="fixed inset-0 z-[700] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={() => { stop(); p.onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="beat-start-title" data-testid="beat-starter" onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-2xl max-h-[94vh] overflow-y-auto space-y-3 rounded-t-2xl sm:rounded-2xl border border-nv-line bg-nv-panel p-4 text-nv-ink shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="beat-start-title" className="text-[15px] font-black">🎲 Démarrer un beat</h2>
            <p className="text-[11px] text-nv-muted">Un squelette de 8 mesures à base de règles du genre : tempo, batterie, accords, 808. Rien n’est généré par une IA : tu modifies tout ensuite.</p>
          </div>
          <button type="button" onClick={() => { stop(); p.onClose(); }} aria-label="Fermer Démarrer un beat" className="h-10 w-10 shrink-0 rounded-full text-nv-muted hover:bg-nv-accent/10"><i className="fas fa-times" aria-hidden /></button>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="text-[12px] font-black">1. Le genre</legend>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5" role="radiogroup" aria-label="Genre">
            {BEAT_GENRES.map(x => (
              <button key={x.id} type="button" role="radio" aria-checked={genre === x.id} onClick={() => chooseGenre(x.id)} data-testid={`beat-genre-${x.id}`}
                className={`${p.isMobile ? 'min-h-[3rem]' : 'min-h-[2.75rem]'} rounded-xl px-2.5 py-1.5 text-left ${genre === x.id ? 'bg-cyan-500/15 ring-1 ring-cyan-400/70' : 'bg-nv-well hover:bg-nv-accent/10'}`}>
                <span className="block text-[13px] font-black">{x.emoji} {x.name}</span>
                <span className="block text-[10.5px] text-nv-muted">{x.bpm} BPM · {x.hint}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-[12px] font-black">2. La tonalité et le tempo</legend>
          {p.hasBeat ? (
            <p className="text-[12px] text-nv-muted rounded-xl bg-nv-well px-3 py-2" data-testid="beat-keeps-beat">
              Ton instru est chargée : le squelette garde son tempo ({Math.round(p.bpm)} BPM){p.root !== null ? ` et sa tonalité (${keyNameFr(p.root, p.scale || 'MINOR')})` : ''}.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <label className="flex items-center gap-1.5 text-nv-muted">Tonique
              <select value={root} onChange={e => setRoot(Number(e.target.value))} disabled={p.hasBeat && p.root !== null} data-testid="beat-root"
                className={`${h} px-2 rounded-xl bg-nv-well border border-nv-line text-nv-ink`}>
                {NOTE_NAMES_FR.map((n, i) => <option key={n} value={i}>{n}</option>)}
              </select>
            </label>
            <div className="flex gap-1" role="radiogroup" aria-label="Mode">
              {(['minor', 'major'] as const).map(m => (
                <button key={m} type="button" role="radio" aria-checked={effMode === m} disabled={!modes[m] || (p.hasBeat && p.root !== null)} onClick={() => setMode(m)} data-testid={`beat-mode-${m}`}
                  title={!modes[m] ? `Pas de suite ${m === 'minor' ? 'mineure' : 'majeure'} classique dans ce genre` : undefined}
                  className={`${h} px-3 rounded-xl font-bold disabled:opacity-40 ${effMode === m ? 'bg-cyan-500/15 ring-1 ring-cyan-400/70' : 'bg-nv-well'}`}>{m === 'minor' ? 'Mineur' : 'Majeur'}</button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-nv-muted">Tempo
              <input type="number" min={g.bpmRange[0] - 20} max={g.bpmRange[1] + 20} value={bpm} disabled={p.hasBeat} data-testid="beat-bpm"
                onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setBpm(Math.max(40, Math.min(240, v))); }}
                className={`${h} w-20 px-2 rounded-xl bg-nv-well border border-nv-line text-nv-ink tabular-nums`} />
              <span className="text-[11px]">BPM (habituel : {g.bpmRange[0]}-{g.bpmRange[1]})</span>
            </label>
          </div>
        </fieldset>

        <fieldset className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <legend className="text-[12px] font-black">3. Une des 3 variantes</legend>
            <button type="button" onClick={() => { stop(); setSeed(s => s + 1); setPick(0); }} data-testid="beat-dice"
              className={`${h} px-3 rounded-xl bg-nv-well text-[12px] font-bold hover:bg-nv-accent/10`} title="3 autres combinaisons de motif, suite d'accords et 808">🎲 Relancer le dé</button>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-3" role="radiogroup" aria-label="Variante">
            {variants.map((v, i) => (
              <div key={i} className={`rounded-xl p-2.5 space-y-1.5 ${pick === i ? 'bg-cyan-500/10 ring-1 ring-cyan-400/60' : 'bg-nv-well'}`} data-testid="beat-variant">
                <button type="button" role="radio" aria-checked={pick === i} onClick={() => setPick(i)} className="block w-full text-left" data-testid={`beat-variant-${i}`}>
                  <span className="block text-[13px] font-black">Variante {String.fromCharCode(65 + i)}</span>
                  <span className="block text-[11px] text-nv-muted">{chordLine(v)}</span>
                  <span className="block text-[10.5px] text-nv-muted">{v.progression.roman} · {v.drums.name}</span>
                </button>
                <button type="button" onClick={() => void listen(i)} aria-label={`${playing === i ? 'Arrêter' : 'Écouter'} la variante ${String.fromCharCode(65 + i)}`} data-testid={`beat-listen-${i}`}
                  className={`w-full ${h} rounded-xl text-[12px] font-bold ${playing === i ? 'bg-cyan-500 text-black' : 'bg-nv-panel text-nv-ink hover:bg-nv-accent/10'}`}>
                  <i className={`fas ${loading === i ? 'fa-circle-notch fa-spin' : playing === i ? 'fa-stop' : 'fa-play'} mr-1.5`} aria-hidden />{playing === i ? 'Stop' : 'Écouter'}
                </button>
              </div>
            ))}
          </div>
        </fieldset>

        <div className="rounded-xl bg-nv-well px-3 py-2 text-[11.5px] text-nv-muted space-y-0.5" data-testid="beat-summary">
          <p><b className="text-nv-ink">{sk.summary}</b></p>
          <p>Pose : batterie (kit NOVA {g.name}), 808 qui suit les fondamentales, piste d’accords et {g.instruments[0] === 'pad' ? 'nappe' : g.instruments[0]} sur 8 mesures.</p>
          {p.replaces.length > 0 && <p className="text-amber-600" data-testid="beat-replaces">Remplace {p.replaces.join(', ')} (Ctrl+Z pour revenir).</p>}
        </div>

        <div className="flex gap-2">
          <button type="button" onClick={() => { stop(); p.onClose(); }} className={`${h} px-4 rounded-xl bg-nv-well font-bold`}>Annuler</button>
          <button type="button" onClick={() => { stop(); p.onApply(sk); }} data-testid="beat-apply"
            className={`flex-1 ${h} rounded-xl font-black bg-cyan-500 text-black hover:bg-cyan-400`}>Poser le squelette</button>
        </div>
      </div>
    </div>
  );
};

export default BeatStarterDialog;
