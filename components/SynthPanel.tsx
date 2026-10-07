import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Track } from '../types';
import {
  NovaSynthSettings, SynthOsc, SynthEnv, OscWave, FilterType, LfoDest, normalizeSynth, stepIndex, toggleFavorite, settingsKey,
} from '../utils/novaSynth';
import { SYNTH_PRESETS, PRESET_CATEGORIES, PresetCategory, presetById, presetSettings, previewNotesFor } from '../utils/novaSynthPresets';

/**
 * Écran du synthé NOVA (V24) : préréglages par catégories (aperçu au clic,
 * précédent / suivant, favoris) et tous les réglages, en français, avec
 * l'équivalent chez Serum / Sytrus / Vital dans l'aide.
 *
 * Chaque changement passe par onChange (→ handleUpdateTrack) : il est annulable
 * avec Ctrl+Z, et les glissements rapprochés ne font qu'une étape.
 * Tout se règle au doigt : curseurs larges, cibles de 40 px, aide affichée au toucher.
 */

interface Props {
  track: Track;
  /** Nouveaux réglages ; undefined = revenir à l'ancien synthé simple. */
  onChange: (s: NovaSynthSettings | undefined) => void;
  /** Aperçu : joue ces notes avec ces réglages. */
  onPreview: (s: NovaSynthSettings, pitches: number[]) => void;
  onNoteOn: (pitch: number) => void;
  onNoteOff: (pitch: number) => void;
  onClose: () => void;
}

const FAV_KEY = 'nova.synth.favoris';
const readFavs = (): string[] => {
  try { const v = JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; }
};
const writeFavs = (v: string[]) => { try { localStorage.setItem(FAV_KEY, JSON.stringify(v)); } catch { /* navigation privée */ } };

const WAVE_LABEL: Record<OscWave, { label: string; icon: string }> = {
  sine: { label: 'Sinus', icon: '∿' },
  triangle: { label: 'Triangle', icon: '⋀' },
  sawtooth: { label: 'Dents de scie', icon: '⩘' },
  square: { label: 'Carré', icon: '⊓' },
};
const FILTER_LABEL: Record<FilterType, string> = { lowpass: 'Passe-bas', highpass: 'Passe-haut', bandpass: 'Passe-bande' };
const LFO_LABEL: Record<LfoDest, string> = { off: 'Aucun', filter: 'Filtre', pitch: 'Hauteur', amp: 'Volume' };

const fmtHz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`);
const fmtS = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
const fmtPct = (v: number) => `${Math.round(v * 100)} %`;

// --- Curseur tactile (linéaire ou logarithmique) ----------------------------------------

const Slider: React.FC<{
  label: string; value: number; min: number; max: number; step?: number; log?: boolean;
  format?: (v: number) => string; hint: string; onHint: (h: string) => void; onChange: (v: number) => void; testId?: string;
}> = ({ label, value, min, max, step, log, format, hint, onHint, onChange, testId }) => {
  const toPos = (v: number) => (log ? Math.log(Math.max(v, min) / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromPos = (p: number) => (log ? min * Math.pow(max / min, p) : min + p * (max - min));
  const pos = Math.round(toPos(value) * 1000);
  const round = (v: number) => (step ? Math.round(v / step) * step : v);
  return (
    <label className="flex flex-col gap-0.5 min-w-0" title={hint} onPointerDown={() => onHint(`${label} : ${hint}`)}>
      <span className="flex items-baseline justify-between gap-1 text-[10px] font-bold text-slate-300">
        <span className="truncate">{label}</span>
        <span className="font-mono text-cyan-200 shrink-0">{format ? format(value) : value.toFixed(2)}</span>
      </span>
      <input type="range" min={0} max={1000} value={pos} data-testid={testId}
        aria-label={label} aria-valuetext={format ? format(value) : String(value)}
        onChange={e => onChange(round(fromPos(Number(e.target.value) / 1000)))}
        onDoubleClick={() => onHint(`${label} : ${hint}`)}
        className="nova-synth-range w-full h-8 accent-cyan-400 touch-none cursor-pointer" />
    </label>
  );
};

const Seg = <T extends string>({ value, options, onChange, label, hint, onHint }: {
  value: T; options: [T, string][]; onChange: (v: T) => void; label: string; hint: string; onHint: (h: string) => void;
}) => (
  <div className="flex flex-col gap-0.5" title={hint} onPointerDown={() => onHint(`${label} : ${hint}`)}>
    <span className="text-[10px] font-bold text-slate-300">{label}</span>
    <div className="flex rounded-lg overflow-hidden border border-white/10" role="group" aria-label={label}>
      {options.map(([id, txt]) => (
        <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}
          className={`flex-1 min-h-[36px] px-1.5 text-[11px] font-bold ${value === id ? 'bg-cyan-500 text-black' : 'bg-white/5 text-slate-300 hover:text-white'}`}>{txt}</button>
      ))}
    </div>
  </div>
);

const Card: React.FC<{ title: string; children: React.ReactNode; right?: React.ReactNode; hint?: string; onHint?: (h: string) => void }> = ({ title, children, right, hint, onHint }) => (
  <section className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 flex flex-col gap-2 min-w-0">
    <header className="flex items-center justify-between gap-2" title={hint} onPointerDown={() => hint && onHint?.(`${title} : ${hint}`)}>
      <h3 className="text-[11px] font-black uppercase tracking-wider text-slate-200">{title}</h3>
      {right}
    </header>
    {children}
  </section>
);

// --- Mini clavier pour essayer le son --------------------------------------------------

/** Deux octaves sur grand écran, une seule sur téléphone (touches assez larges pour le doigt). */
const keysFor = (narrow: boolean) => Array.from({ length: narrow ? 13 : 25 }, (_, i) => 48 + i);
const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(p % 12);
const MiniKeyboard: React.FC<{ onNoteOn: (p: number) => void; onNoteOff: (p: number) => void; octave: number }> = ({ onNoteOn, onNoteOff, octave }) => {
  const held = useRef(new Map<number, number>());
  const [down, setDown] = useState<Set<number>>(new Set());
  const press = (pointer: number, p: number) => {
    held.current.set(pointer, p); onNoteOn(p);
    setDown(d => new Set(d).add(p));
  };
  const lift = (pointer: number) => {
    const p = held.current.get(pointer);
    if (p === undefined) return;
    held.current.delete(pointer); onNoteOff(p);
    setDown(d => { const n = new Set(d); n.delete(p); return n; });
  };
  useEffect(() => () => { held.current.forEach(p => onNoteOff(p)); held.current.clear(); }, [onNoteOff]);
  const [narrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  const KEYS = keysFor(narrow);
  const whites = KEYS.filter(k => !isBlack(k));
  return (
    <div className="relative h-16 select-none touch-none" role="group" aria-label="Clavier d'essai">
      <div className="absolute inset-0 flex">
        {whites.map(k => {
          const p = k + octave * 12;
          return (
            <button key={k} type="button" aria-label={`Note ${p}`}
              onPointerDown={e => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); press(e.pointerId, p); }}
              onPointerUp={e => lift(e.pointerId)} onPointerCancel={e => lift(e.pointerId)}
              className={`flex-1 border border-black/60 rounded-b-md ${down.has(p) ? 'bg-cyan-300' : 'bg-slate-100'}`} />
          );
        })}
      </div>
      {KEYS.filter(isBlack).map(k => {
        const idx = whites.filter(w => w < k).length;
        const p = k + octave * 12;
        return (
          <button key={k} type="button" aria-label={`Note ${p}`}
            onPointerDown={e => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); press(e.pointerId, p); }}
            onPointerUp={e => lift(e.pointerId)} onPointerCancel={e => lift(e.pointerId)}
            style={{ left: `calc(${(idx / whites.length) * 100}% - ${(0.6 / whites.length) * 50}%)`, width: `${(0.6 / whites.length) * 100}%` }}
            className={`absolute top-0 h-[60%] rounded-b-md z-10 ${down.has(p) ? 'bg-cyan-500' : 'bg-slate-900'} border border-black`} />
        );
      })}
    </div>
  );
};

// --- Écran ------------------------------------------------------------------------------

const SynthPanel: React.FC<Props> = ({ track, onChange, onPreview, onNoteOn, onNoteOff, onClose }) => {
  const legacy = !track.novaSynth;
  const s = useMemo(() => normalizeSynth(track.novaSynth ?? presetSettings('nova-saw-classique')), [track.novaSynth]);
  // Ancien synthé : on montre toute la banque ; sinon la catégorie du son en cours.
  const [cat, setCat] = useState<PresetCategory | 'Tous' | 'Favoris'>(() => (!legacy && s.presetId && presetById(s.presetId)?.cat) || 'Tous');
  const [favs, setFavs] = useState<string[]>(readFavs);
  const [hint, setHint] = useState('Touche un réglage pour voir à quoi il sert. Ctrl+Z annule.');
  const [tab, setTab] = useState<'sons' | 'reglages'>('sons');
  const [kbOct, setKbOct] = useState(0);
  const preset = s.presetId ? presetById(s.presetId) : undefined;
  const modified = !!preset && settingsKey(presetSettings(preset.id)) !== settingsKey(s);

  // Échap ferme l'écran.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const list = useMemo(() => {
    if (cat === 'Tous') return SYNTH_PRESETS;
    if (cat === 'Favoris') return SYNTH_PRESETS.filter(p => favs.includes(p.id));
    return SYNTH_PRESETS.filter(p => p.cat === cat);
  }, [cat, favs]);

  const choose = useCallback((id: string) => {
    const next = presetSettings(id);
    onChange(next);
    onPreview(next, previewNotesFor(id));
  }, [onChange, onPreview]);

  const step = (dir: 1 | -1) => {
    const pool = list.length ? list : SYNTH_PRESETS;
    const i = pool.findIndex(p => p.id === s.presetId);
    const n = stepIndex(pool.length, i, dir);
    if (n >= 0) choose(pool[n].id);
  };

  const set = (fn: (d: NovaSynthSettings) => void) => {
    const d: NovaSynthSettings = JSON.parse(JSON.stringify(s));
    fn(d);
    onChange(normalizeSynth(d));
  };
  const setOsc = (i: number, patch: Partial<SynthOsc>) => set(d => { d.osc[i] = { ...d.osc[i], ...patch }; });
  const setEnv = (k: 'ampEnv' | 'filterEnv', patch: Partial<SynthEnv>) => set(d => { d[k] = { ...d[k], ...patch }; });

  const fav = !!s.presetId && favs.includes(s.presetId);
  const toggleFav = () => { if (!s.presetId) return; const n = toggleFavorite(favs, s.presetId); setFavs(n); writeFavs(n); };
  const h = setHint;

  const envCard = (k: 'ampEnv' | 'filterEnv', title: string, hintTxt: string) => {
    const e = s[k];
    return (
      <Card title={title} hint={hintTxt} onHint={h}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <Slider label="Attaque" value={e.a} min={0.001} max={5} log format={fmtS} hint="Temps pour monter au maximum. Court = percussif, long = nappe qui arrive doucement (Attack de Serum)." onHint={h} onChange={v => setEnv(k, { a: v })} />
          <Slider label="Déclin" value={e.d} min={0.01} max={8} log format={fmtS} hint="Temps pour redescendre au niveau de maintien (Decay)." onHint={h} onChange={v => setEnv(k, { d: v })} />
          <Slider label="Maintien" value={e.s} min={0} max={1} format={fmtPct} hint="Niveau tant que la touche est tenue. 0 = pluck ou cloche qui s'éteint seul (Sustain)." onHint={h} onChange={v => setEnv(k, { s: v })} />
          <Slider label="Relâchement" value={e.r} min={0.01} max={10} log format={fmtS} hint="Queue du son après avoir lâché la touche (Release)." onHint={h} onChange={v => setEnv(k, { r: v })} />
        </div>
      </Card>
    );
  };

  const presetsView = (
    <div className="flex flex-col gap-2 min-h-0">
      <div className="flex gap-1.5 overflow-x-auto pb-1 shrink-0" role="tablist" aria-label="Catégories de sons">
        {(['Tous', 'Favoris', ...PRESET_CATEGORIES] as const).map(c => (
          <button key={c} type="button" role="tab" aria-selected={cat === c} onClick={() => setCat(c)}
            className={`shrink-0 min-h-[36px] px-3 rounded-full text-[11px] font-bold border ${cat === c ? 'bg-cyan-500 text-black border-cyan-400' : 'bg-white/5 text-slate-300 border-white/10 hover:text-white'}`}>
            {c === 'Favoris' ? `★ Favoris${favs.length ? ` (${favs.length})` : ''}` : c}
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="text-[12px] text-slate-400 p-4 text-center">Aucun favori pour l'instant : touche ★ à côté du nom d'un son pour le retrouver ici.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5" data-testid="synth-presets">
          {list.map(p => {
            const on = p.id === s.presetId;
            return (
              <button key={p.id} type="button" onClick={() => choose(p.id)} aria-pressed={on} title={p.tip} data-preset={p.id}
                className={`text-left min-h-[48px] rounded-lg px-2.5 py-1.5 border transition-colors ${on ? 'bg-cyan-500/20 border-cyan-400 text-white' : 'bg-white/[0.04] border-white/10 text-slate-200 hover:bg-white/10'}`}>
                <span className="block text-[12px] font-bold leading-tight truncate">{favs.includes(p.id) && <span className="text-amber-300 mr-1">★</span>}{p.name}</span>
                <span className="block text-[10px] text-slate-400 truncate">{cat === 'Tous' || cat === 'Favoris' ? p.cat : p.tip}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  const settingsView = (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
      {s.osc.map((o, i) => (
        <Card key={i} title={`Oscillateur ${i + 1}`} hint="Source du son. Jusqu'à 3 oscillateurs mélangés, comme les OSC A/B de Serum ou les opérateurs de Sytrus." onHint={h}
          right={<button type="button" aria-pressed={o.on} onClick={() => setOsc(i, { on: !o.on })} data-testid={`osc-${i + 1}-on`}
            className={`min-h-[32px] px-3 rounded-lg text-[11px] font-black ${o.on ? 'bg-cyan-500 text-black' : 'bg-white/10 text-slate-400'}`}>{o.on ? 'Activé' : 'Coupé'}</button>}>
          <div className={o.on ? '' : 'opacity-40 pointer-events-none'}>
            <Seg label="Forme d'onde" value={o.wave} onChange={v => setOsc(i, { wave: v })} onHint={h}
              hint="Sinus = doux et rond (sub, flûte) ; triangle = un peu plus brillant ; dents de scie = riche et brillant (pads, leads) ; carré = creux (clarinette, basses rétro)."
              options={(Object.keys(WAVE_LABEL) as OscWave[]).map(w => [w, WAVE_LABEL[w].icon + ' ' + (w === 'sawtooth' ? 'Scie' : WAVE_LABEL[w].label)])} />
            <div className="grid grid-cols-3 gap-x-2 gap-y-1 mt-1.5">
              <Slider label="Octave" value={o.octave} min={-3} max={3} step={1} format={v => (v > 0 ? `+${v}` : `${v}`)} hint="Monte ou descend l'oscillateur d'une ou plusieurs octaves (Octave de Serum)." onHint={h} onChange={v => setOsc(i, { octave: v })} />
              <Slider label="Demi-tons" value={o.semi} min={-12} max={12} step={1} format={v => (v > 0 ? `+${v}` : `${v}`)} hint="Transpose en demi-tons : +7 = quinte, +12 = octave. Utile pour les cloches (Semi de Serum, Coarse de Sytrus)." onHint={h} onChange={v => setOsc(i, { semi: v })} />
              <Slider label="Fin" value={o.fine} min={-100} max={100} step={1} format={v => `${Math.round(v)} ct`} hint="Désaccord fin en cents : quelques cents épaississent le son (Fine de Serum)." onHint={h} onChange={v => setOsc(i, { fine: v })} />
              <Slider label="Niveau" value={o.level} min={0} max={1} format={fmtPct} hint="Volume de cet oscillateur dans le mélange (Level de Serum)." onHint={h} onChange={v => setOsc(i, { level: v })} />
              <Slider label="Unisson" value={o.unison} min={1} max={7} step={1} format={v => `${v} voix`} hint="Empile plusieurs copies désaccordées pour un son large, comme l'Unison de Serum ou le Supersaw de Sylenth." onHint={h} onChange={v => setOsc(i, { unison: v })} />
              <Slider label="Désaccord" value={o.detune} min={0} max={100} format={v => `${Math.round(v)} ct`} hint="Écart entre les voix d'unisson : plus c'est haut, plus ça « chorus » (Detune de Serum)." onHint={h} onChange={v => setOsc(i, { detune: v })} />
              <Slider label="Stéréo" value={o.spread} min={0} max={1} format={fmtPct} hint="Étale les voix d'unisson de gauche à droite (Blend / Width de Serum)." onHint={h} onChange={v => setOsc(i, { spread: v })} />
            </div>
          </div>
        </Card>
      ))}
      <Card title="Filtre" hint="Sculpte la brillance. Comme le filtre de Serum ou le module Filter de Sytrus." onHint={h}
        right={<button type="button" aria-pressed={s.filter.steep} onClick={() => set(d => { d.filter.steep = !d.filter.steep; })}
          title="24 dB/oct : coupure plus raide (MG Low 24 de Serum)"
          className={`min-h-[32px] px-2.5 rounded-lg text-[11px] font-black ${s.filter.steep ? 'bg-cyan-500 text-black' : 'bg-white/10 text-slate-300'}`}>{s.filter.steep ? '24 dB' : '12 dB'}</button>}>
        <Seg label="Type" value={s.filter.type} onChange={v => set(d => { d.filter.type = v; })} onHint={h}
          hint="Passe-bas = garde les graves (le plus courant) ; passe-haut = enlève les graves ; passe-bande = son de radio, voix, chœurs."
          options={(Object.keys(FILTER_LABEL) as FilterType[]).map(f => [f, FILTER_LABEL[f]])} />
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <Slider label="Coupure" value={s.filter.cutoff} min={20} max={20000} log format={fmtHz} testId="synth-cutoff" hint="Fréquence où le filtre agit : plus bas = plus sombre (Cutoff de Serum)." onHint={h} onChange={v => set(d => { d.filter.cutoff = v; })} />
          <Slider label="Résonance" value={s.filter.reso} min={0.1} max={20} log format={v => v.toFixed(1)} hint="Accentue la coupure, son plus « acide » (Res de Serum)." onHint={h} onChange={v => set(d => { d.filter.reso = v; })} />
          <Slider label="Enveloppe" value={s.filter.envAmount} min={-4} max={6} step={0.05} format={v => `${v > 0 ? '+' : ''}${v.toFixed(1)} oct`} hint="Combien l'enveloppe de filtre ouvre le son à chaque note : c'est le « pluck » (Env 2 → Cutoff dans Serum)." onHint={h} onChange={v => set(d => { d.filter.envAmount = v; })} />
          <Slider label="Suivi clavier" value={s.filter.keytrack} min={0} max={1} format={fmtPct} hint="Les notes aiguës ouvrent davantage le filtre, comme un vrai instrument (Key Track de Serum)." onHint={h} onChange={v => set(d => { d.filter.keytrack = v; })} />
          <Slider label="Vélocité" value={s.filter.velAmount} min={0} max={4} step={0.05} format={v => `${v.toFixed(1)} oct`} hint="Frapper fort ouvre le filtre (Velocity → Cutoff dans Serum)." onHint={h} onChange={v => set(d => { d.filter.velAmount = v; })} />
          <Slider label="Bruit" value={s.noise.level} min={0} max={1} format={fmtPct} hint="Ajoute du souffle : flûtes, attaques, textures (Noise de Serum)." onHint={h} onChange={v => set(d => { d.noise.level = v; })} />
        </div>
      </Card>
      {envCard('ampEnv', 'Enveloppe de volume', "Forme du volume dans le temps (ADSR, Env 1 de Serum).")}
      {envCard('filterEnv', 'Enveloppe de filtre', "Forme de l'ouverture du filtre dans le temps (Env 2 de Serum).")}
      <Card title="LFO" hint="Mouvement régulier : vibrato, wobble, trémolo (LFO 1 de Serum)." onHint={h}>
        <Seg label="Agit sur" value={s.lfo.dest} onChange={v => set(d => { d.lfo.dest = v; })} onHint={h}
          hint="Filtre = wah / wobble ; Hauteur = vibrato ; Volume = trémolo (comme un Rhodes)."
          options={(Object.keys(LFO_LABEL) as LfoDest[]).map(k => [k, LFO_LABEL[k]])} />
        <Seg label="Forme" value={s.lfo.wave} onChange={v => set(d => { d.lfo.wave = v; })} onHint={h}
          hint="Forme du mouvement : sinus = doux, carré = saccadé."
          options={(Object.keys(WAVE_LABEL) as OscWave[]).map(w => [w, WAVE_LABEL[w].icon])} />
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <Slider label="Vitesse" value={s.lfo.rate} min={0.05} max={20} log format={v => `${v.toFixed(2)} Hz`} hint="Rapidité du mouvement (Rate de Serum)." onHint={h} onChange={v => set(d => { d.lfo.rate = v; })} />
          <Slider label="Intensité" value={s.lfo.amount} min={0} max={1} format={fmtPct} hint="Profondeur du mouvement." onHint={h} onChange={v => set(d => { d.lfo.amount = v; })} />
        </div>
      </Card>
      <Card title="Jeu" hint="Comment les notes s'enchaînent (Voicing de Serum)." onHint={h}>
        <Seg label="Voix" value={s.mono ? 'mono' : 'poly'} onChange={v => set(d => { d.mono = v === 'mono'; })} onHint={h}
          hint="Poly = accords ; Mono = une note à la fois, pour les leads et les basses (Mono de Serum)."
          options={[['poly', 'Poly (accords)'], ['mono', 'Mono']]} />
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <Slider label="Glissé" value={s.glide} min={0} max={1} format={v => (v <= 0.0005 ? 'non' : fmtS(v))} hint="Portamento : la hauteur glisse d'une note à l'autre (Porta de Serum, Slide de Sytrus)." onHint={h} onChange={v => set(d => { d.glide = v < 0.003 ? 0 : v; })} />
          <Slider label="Vélocité → volume" value={s.velToAmp} min={0} max={1} format={fmtPct} hint="0 = toutes les notes au même volume ; 100 % = très dynamique comme un piano." onHint={h} onChange={v => set(d => { d.velToAmp = v; })} />
        </div>
        {s.mono && (
          <button type="button" aria-pressed={s.legato} onClick={() => set(d => { d.legato = !d.legato; })}
            title="Legato : une note liée ne relance pas l'attaque (Legato de Serum)"
            className={`min-h-[36px] rounded-lg text-[11px] font-bold border ${s.legato ? 'bg-cyan-500/20 border-cyan-400 text-white' : 'bg-white/5 border-white/10 text-slate-300'}`}>Legato {s.legato ? 'oui' : 'non'}</button>
        )}
      </Card>
      <Card title="Effets" hint="Chorus et delay intégrés, légers (FX de Serum)." onHint={h}>
        <div className="grid grid-cols-3 gap-x-2 gap-y-1">
          <Slider label="Chorus" value={s.fx.chorus.mix} min={0} max={1} format={fmtPct} hint="Élargit et fait onduler le son, comme le chorus d'un Juno (Chorus de Serum)." onHint={h} onChange={v => set(d => { d.fx.chorus.mix = v; })} />
          <Slider label="Vitesse" value={s.fx.chorus.rate} min={0.05} max={8} log format={v => `${v.toFixed(2)} Hz`} hint="Vitesse d'ondulation du chorus." onHint={h} onChange={v => set(d => { d.fx.chorus.rate = v; })} />
          <Slider label="Profondeur" value={s.fx.chorus.depth} min={0} max={1} format={fmtPct} hint="Ampleur de l'ondulation du chorus." onHint={h} onChange={v => set(d => { d.fx.chorus.depth = v; })} />
          <Slider label="Delay" value={s.fx.delay.mix} min={0} max={1} format={fmtPct} hint="Échos : idéal sur les plucks et les arpèges (Delay de Serum)." onHint={h} onChange={v => set(d => { d.fx.delay.mix = v; })} />
          <Slider label="Temps" value={s.fx.delay.time} min={0.02} max={1.5} log format={fmtS} hint="Écart entre les échos." onHint={h} onChange={v => set(d => { d.fx.delay.time = v; })} />
          <Slider label="Répétitions" value={s.fx.delay.feedback} min={0} max={0.9} format={fmtPct} hint="Nombre d'échos (Feedback)." onHint={h} onChange={v => set(d => { d.fx.delay.feedback = v; })} />
        </div>
      </Card>
      <Card title="Sortie" hint="Volume général du synthé." onHint={h}>
        <Slider label="Volume" value={s.level} min={0} max={1} format={fmtPct} hint="Volume du son (Master de Serum)." onHint={h} onChange={v => set(d => { d.level = v; })} />
        {!legacy && (
          <button type="button" onClick={() => onChange(undefined)}
            className="min-h-[36px] rounded-lg text-[11px] font-bold bg-white/5 border border-white/10 text-slate-300 hover:text-white"
            title="Revenir au synthé d'origine de NOVA (une dent de scie filtrée), celui des anciens projets">Revenir au synthé simple d'origine</button>
        )}
      </Card>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[300] bg-black/70 flex items-stretch sm:items-center justify-center" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog" aria-modal="true" aria-label="Synthé NOVA" data-testid="synth-panel">
      <div className="w-full sm:w-[min(1180px,96vw)] h-full sm:h-[92vh] bg-[#101218] sm:rounded-2xl border border-white/10 shadow-2xl flex flex-col overflow-hidden">
        {/* En-tête : nom du son, précédent / suivant, favori, aperçu */}
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-white/10 bg-gradient-to-r from-cyan-500/10 to-fuchsia-500/10">
          <div className="flex items-center gap-2 min-w-0 w-full sm:w-auto sm:flex-1">
            <span className="text-[11px] font-black uppercase tracking-widest text-cyan-300 shrink-0">🎹 Synthé NOVA</span>
            <span className="text-[13px] font-bold text-white truncate" data-testid="synth-preset-name">
              {legacy ? 'Synthé simple (son d\'origine)' : (s.name || preset?.name || 'Son personnalisé')}{modified && <span className="text-amber-300 text-[11px] ml-1" title="Réglages retouchés depuis le préréglage">• modifié</span>}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 ml-auto">
            <button type="button" onClick={() => step(-1)} aria-label="Son précédent" title="Son précédent" className="w-10 h-10 rounded-lg bg-white/10 text-white hover:bg-white/20"><i className="fas fa-chevron-left" /></button>
            <button type="button" onClick={() => step(1)} aria-label="Son suivant" title="Son suivant" className="w-10 h-10 rounded-lg bg-white/10 text-white hover:bg-white/20"><i className="fas fa-chevron-right" /></button>
            <button type="button" onClick={toggleFav} disabled={!s.presetId} aria-pressed={fav} aria-label={fav ? 'Retirer des favoris' : 'Ajouter aux favoris'} title="Favori"
              className={`w-10 h-10 rounded-lg text-[16px] ${fav ? 'bg-amber-400/20 text-amber-300' : 'bg-white/10 text-slate-300'} disabled:opacity-30`}>★</button>
            <button type="button" onClick={() => onPreview(s, s.presetId ? previewNotesFor(s.presetId) : [48, 55, 58, 62, 65])}
              className="h-10 px-3 rounded-lg bg-cyan-500 text-black text-[12px] font-black" title="Écouter un accord avec ce son"><i className="fas fa-play mr-1" />Écouter</button>
            <button type="button" onClick={onClose} aria-label="Fermer le synthé" title="Fermer (Échap)" className="w-10 h-10 rounded-lg bg-white/10 text-white hover:bg-white/20"><i className="fas fa-times" /></button>
          </div>
        </div>
        {/* Onglets (sur petit écran, un seul à la fois) */}
        <div className="flex gap-1 px-3 pt-2 shrink-0" role="tablist" aria-label="Vue du synthé">
          {([['sons', `Sons (${SYNTH_PRESETS.length})`], ['reglages', 'Réglages']] as const).map(([id, txt]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} data-testid={`synth-tab-${id}`}
              className={`min-h-[36px] px-4 rounded-t-lg text-[12px] font-black ${tab === id ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}>{txt}</button>
          ))}
        </div>
        <p className="px-3 py-1.5 text-[11px] text-slate-300 bg-white/[0.04] border-y border-white/5 min-h-[30px]" role="status" aria-live="polite" data-testid="synth-hint">
          <i className="fas fa-info-circle text-cyan-400 mr-1.5" />{hint}
        </p>
        <div className="flex-1 overflow-y-auto overscroll-contain p-3">
          {tab === 'sons' ? presetsView : settingsView}
        </div>
        <div className="border-t border-white/10 px-3 py-2 bg-black/30 flex items-center gap-2">
          <div className="flex flex-col gap-1 shrink-0">
            <button type="button" onClick={() => setKbOct(o => Math.min(2, o + 1))} aria-label="Clavier une octave plus haut" className="w-10 h-8 rounded bg-white/10 text-white text-[11px]">+8ve</button>
            <button type="button" onClick={() => setKbOct(o => Math.max(-3, o - 1))} aria-label="Clavier une octave plus bas" className="w-10 h-8 rounded bg-white/10 text-white text-[11px]">-8ve</button>
          </div>
          <div className="flex-1 min-w-0"><MiniKeyboard octave={kbOct} onNoteOn={onNoteOn} onNoteOff={onNoteOff} /></div>
        </div>
      </div>
    </div>
  );
};

export default SynthPanel;
