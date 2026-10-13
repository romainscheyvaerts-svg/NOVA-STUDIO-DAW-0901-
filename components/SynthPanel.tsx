import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Track } from '../types';
import {
  NovaSynthSettings, SynthOsc, SynthEnv, OscWave, FilterType, LfoDest, normalizeSynth, stepIndex, toggleFavorite, settingsKey,
} from '../utils/novaSynth';
import { SYNTH_PRESETS, PRESET_CATEGORIES, PresetCategory, presetById, presetSettings, previewNotesFor, SynthPreset } from '../utils/novaSynthPresets';
import { wavePath, filterPath, envPoints, lfoPath, freqToX } from '../utils/novaSynthDraw';
import { Knob, PushButton, Faceplate, HwHelpProvider, InfoBar } from '../plugins/hw';
import './synth/synthe.css';

/**
 * Synthé NOVA (V24 → façade du 14/10/2026) : un vrai synthé à l'écran.
 *  - En-tête : écran du son, précédent / suivant, favori, écouter, fermer.
 *  - Navigateur de sons : recherche, catégories, favoris, nouveautés, écoute rapide (▶ sans choisir).
 *  - Façade (kit « matériel » plugins/hw) : OSC 1-3 avec écran de forme d'onde, FILTRE avec sa
 *    courbe, ENVELOPPES dessinées, LFO, JEU, EFFETS, SORTIE ; boutons rotatifs (glisser, molette,
 *    double-clic = valeur d'origine), aide dans la ligne d'info.
 *  - Clavier jouable à la souris et au doigt (glissando), octave ±.
 * Bureau : navigateur et façade côte à côte. Téléphone / tablette : onglets Sons / Réglages,
 * modules repliables, cibles de 44 px, aucun défilement horizontal. La façade reste sombre ;
 * le cadre suit le thème clair ou sombre.
 *
 * Chaque changement passe par onChange (→ handleUpdateTrack) : annulable avec Ctrl+Z.
 * Points d'accroche QA gardés : synth-panel, synth-preset-name, synth-presets [data-preset],
 * synth-tab-sons / synth-tab-reglages, synth-cutoff, synth-hint, osc-N-on, onglets de catégories.
 */

interface Props {
  track: Track;
  /** Nouveaux réglages ; undefined = revenir à l'ancien synthé simple. */
  onChange: (s: NovaSynthSettings | undefined) => void;
  /** Aperçu : joue ces notes avec ces réglages (aucune note : le moteur reprend ces réglages). */
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

const WAVES: { id: OscWave; label: string; short: string }[] = [
  { id: 'sine', label: 'Sinus', short: 'SIN' },
  { id: 'triangle', label: 'Triangle', short: 'TRI' },
  { id: 'sawtooth', label: 'Dents de scie', short: 'SCIE' },
  { id: 'square', label: 'Carré', short: 'CARRÉ' },
];
const WAVE_HINT = 'Sinus = doux et rond (sub, flûte) ; triangle = un peu plus brillant ; dents de scie = riche et brillant (nappes, leads) ; carré = creux (basses rétro, chiptune).';
const FILTERS: { id: FilterType; label: string; short: string }[] = [
  { id: 'lowpass', label: 'Passe-bas', short: 'BAS' },
  { id: 'highpass', label: 'Passe-haut', short: 'HAUT' },
  { id: 'bandpass', label: 'Passe-bande', short: 'BANDE' },
];
const LFO_DESTS: { id: LfoDest; label: string }[] = [
  { id: 'off', label: 'Aucun' }, { id: 'filter', label: 'Filtre' }, { id: 'pitch', label: 'Hauteur' }, { id: 'amp', label: 'Volume' },
];

const fr = (v: number, d = 1) => v.toLocaleString('fr-FR', { maximumFractionDigits: d });
const fmtHz = (v: number) => (v >= 1000 ? `${fr(v / 1000, v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`);
const fmtS = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${fr(v, 2)} s`);
const fmtPct = (v: number) => `${Math.round(v * 100)} %`;
const fmtSigned = (v: number) => (v > 0 ? `+${v}` : `${v}`);
const NOTE_NAMES = ['Do', 'Do♯', 'Ré', 'Ré♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];
/** Nom français : 60 = Do3. */
const noteName = (p: number) => `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 2}`;
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Petit écran : téléphone (< 640 px), avec suivi du redimensionnement. */
function useNarrow(): boolean {
  const q = '(max-width: 639px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return narrow;
}
/** Bureau large (≥ 1024 px) : navigateur et façade côte à côte. */
function useWide(): boolean {
  const q = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setWide(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return wide;
}

// --- Écrans (SVG) ----------------------------------------------------------------------

const Glass: React.FC<{ className: string; children: React.ReactNode; label: string }> = ({ className, children, label }) => (
  <div className={`hw-screen syn-screen ${className}`} role="img" aria-label={label}>
    <div className="hw-screen-glass">{children}</div>
  </div>
);
/** Les tracés passent sous la légende de l'écran (14 px en haut). */
const BELOW_CAPTION = (h: number) => `translate(0 14) scale(1 ${((h - 17) / h).toFixed(4)})`;
const GridLines: React.FC<{ w: number; h: number; xs?: number[]; ys?: number[] }> = ({ w, h, xs = [], ys = [] }) => (
  <g className="syn-grid-lines">
    {xs.map(x => <line key={`x${x}`} x1={x} x2={x} y1={0} y2={h} />)}
    {ys.map(y => <line key={`y${y}`} x1={0} x2={w} y1={y} y2={y} />)}
  </g>
);

const WaveIcon: React.FC<{ wave: OscWave }> = ({ wave }) => (
  <svg className="syn-ico" viewBox="0 0 22 12" aria-hidden="true"><path d={wavePath(wave, 22, 12, 1, 0.8)} fill="none" stroke="currentColor" strokeWidth={1.6} /></svg>
);

const WaveScreen: React.FC<{ o: SynthOsc; n: number }> = ({ o, n }) => {
  const W = 160, H = 54;
  const amp = 0.25 + 0.65 * o.level;
  const ghosts = o.unison > 1 ? Array.from({ length: o.unison }, (_, k) => ((k / (o.unison - 1)) - 0.5) * (0.04 + o.detune / 250)) : [];
  const tune = [o.octave ? `${fmtSigned(o.octave)} oct` : '', o.semi ? `${fmtSigned(o.semi)} dt` : '', o.fine ? `${fmtSigned(Math.round(o.fine))} ct` : ''].filter(Boolean).join(' · ');
  const wl = WAVES.find(w => w.id === o.wave)!;
  return (
    <Glass className="syn-screen-wave" label={`Oscillateur ${n} : ${wl.label}${o.on ? '' : ', coupé'}`}>
      <span className="syn-screen-cap">OSC {n} <b>{wl.short}</b></span>
      {(tune || o.unison > 1) && <span className="syn-screen-cap syn-screen-cap-r">{tune}{o.unison > 1 ? `${tune ? ' · ' : ''}${o.unison}×` : ''}</span>}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <GridLines w={W} h={H} ys={[H / 2]} xs={[W / 2]} />
        <g transform={BELOW_CAPTION(H)}>
          {ghosts.map((ph, k) => <path key={k} className="syn-trace-ghost" d={wavePath(o.wave, W, H, 2, amp, ph)} vectorEffect="non-scaling-stroke" />)}
          {o.on && <path className="syn-trace" d={wavePath(o.wave, W, H, 2, amp)} vectorEffect="non-scaling-stroke" />}
        </g>
      </svg>
    </Glass>
  );
};

const FilterScreen: React.FC<{ s: NovaSynthSettings }> = ({ s }) => {
  const W = 220, H = 74;
  const f = s.filter;
  const open = Math.min(20000, Math.max(20, f.cutoff * Math.pow(2, f.envAmount)));
  const x = freqToX(f.cutoff, W);
  const label = FILTERS.find(t => t.id === f.type)!;
  const d = filterPath(f, W, H);
  return (
    <Glass className="syn-screen-filter" label={`Filtre ${label.label} à ${fmtHz(f.cutoff)}, résonance ${fr(f.reso)}`}>
      <span className="syn-screen-cap">{label.label.toUpperCase()} <b>{fmtHz(f.cutoff)}</b>{f.steep ? ' · 24 dB' : ' · 12 dB'}</span>
      {f.envAmount !== 0 && <span className="syn-screen-cap syn-screen-cap-r" style={{ color: '#f0abfc' }}>ENV {f.envAmount > 0 ? '+' : ''}{fr(f.envAmount)} oct</span>}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <GridLines w={W} h={H} xs={[100, 1000, 10000].map(v => freqToX(v, W))} ys={[H * 24 / 66]} />
        <g transform={BELOW_CAPTION(H)}>
          {f.envAmount !== 0 && <path className="syn-trace-2" d={filterPath(f, W, H, open)} vectorEffect="non-scaling-stroke" />}
          <path className="syn-fill" d={`${d}L${W} ${H}L0 ${H}Z`} />
          <path className="syn-trace" d={d} vectorEffect="non-scaling-stroke" />
        </g>
        <line x1={x} x2={x} y1={0} y2={H} stroke="#5eead4" strokeOpacity={0.35} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      </svg>
    </Glass>
  );
};

const EnvScreen: React.FC<{ amp: SynthEnv; filt: SynthEnv; showFilter: boolean }> = ({ amp, filt, showFilter }) => {
  const W = 220, H = 74;
  const a = envPoints(amp, W, H, 3), f = envPoints(filt, W, H, 3);
  return (
    <Glass className="syn-screen-env" label={`Enveloppe de volume : attaque ${fmtS(amp.a)}, déclin ${fmtS(amp.d)}, maintien ${fmtPct(amp.s)}, relâchement ${fmtS(amp.r)}`}>
      <span className="syn-screen-cap"><b>VOLUME</b></span>
      {showFilter && <span className="syn-screen-cap syn-screen-cap-r" style={{ color: '#f0abfc' }}>FILTRE</span>}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <GridLines w={W} h={H} ys={[H / 2]} />
        <g transform={BELOW_CAPTION(H)}>
          {showFilter && <path className="syn-trace-2" d={f.d} vectorEffect="non-scaling-stroke" />}
          <path className="syn-fill" d={`${a.d}Z`} />
          <path className="syn-trace" d={a.d} vectorEffect="non-scaling-stroke" />
        </g>
      </svg>
    </Glass>
  );
};

const LfoScreen: React.FC<{ s: NovaSynthSettings }> = ({ s }) => {
  const W = 160, H = 74;
  const off = s.lfo.dest === 'off' || s.lfo.amount <= 0;
  const dest = LFO_DESTS.find(d => d.id === s.lfo.dest)!;
  return (
    <Glass className="syn-screen-lfo" label={`LFO : ${dest.label}, ${fr(s.lfo.rate, 2)} Hz`}>
      <span className="syn-screen-cap">LFO → <b>{dest.label.toUpperCase()}</b></span>
      <span className="syn-screen-cap syn-screen-cap-r">{fr(s.lfo.rate, 2)} Hz</span>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <GridLines w={W} h={H} ys={[H / 2]} />
        <g transform={BELOW_CAPTION(H)}>
          <path className={off ? 'syn-trace-ghost' : 'syn-trace'} d={lfoPath(s.lfo.wave, s.lfo.rate, off ? 0.15 : s.lfo.amount, W, H)} vectorEffect="non-scaling-stroke" />
        </g>
      </svg>
    </Glass>
  );
};

// --- Modules de la façade ---------------------------------------------------------------

const Mod: React.FC<{
  id: string; title: string; className: string; open: boolean; onToggle: (id: string) => void;
  aside?: React.ReactNode; off?: boolean; children: React.ReactNode;
}> = ({ id, title, className, open, onToggle, aside, off, children }) => (
  <section className={`syn-mod ${className}`} data-open={open ? 'true' : 'false'} data-off={off ? 'true' : undefined} data-synth-mod={id} aria-label={title}>
    <div className="syn-mod-head">
      <div className="hw-section-title" onClick={() => { if (window.matchMedia?.('(max-width: 639px)').matches) onToggle(id); }}>
        <span className="hw-silk">{title}</span>
      </div>
      {aside}
      <button type="button" className="syn-fold" aria-expanded={open} aria-label={`${open ? 'Replier' : 'Déplier'} ${title}`} onClick={() => onToggle(id)}>
        <i className="fas fa-chevron-down" aria-hidden="true" />
      </button>
    </div>
    <div className="syn-mod-body">{children}</div>
  </section>
);

/** Sélecteur exclusif à poussoirs (groupe radio). */
function Radio<T extends string>({ label, value, options, onChange, hint, paramId, grid }: {
  label: string; value: T; options: { id: T; text: React.ReactNode; aria: string }[]; onChange: (v: T) => void; hint: string; paramId: string; grid?: boolean;
}) {
  return (
    <div className={`syn-radio${grid ? ' syn-radio-2x2' : ''}`} role="radiogroup" aria-label={label} data-nova-param={paramId}>
      {options.map(o => (
        <PushButton key={o.id} role="radio" active={value === o.id} onClick={() => onChange(o.id)} ariaLabel={o.aria} hint={hint} dark led="#5eead4"
          valueText={value === o.id ? 'choisi' : undefined}>{o.text}</PushButton>
      ))}
    </div>
  );
}

// --- Clavier ----------------------------------------------------------------------------

const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);

const Keybed: React.FC<{ low: number; count: number; onNoteOn: (p: number) => void; onNoteOff: (p: number) => void }> = ({ low, count, onNoteOn, onNoteOff }) => {
  const held = useRef(new Map<number, number>());
  const [down, setDown] = useState<Set<number>>(new Set());
  const keys = useMemo(() => Array.from({ length: count }, (_, i) => low + i), [low, count]);
  const whites = keys.filter(k => !isBlack(k));
  const ww = 100 / whites.length;
  const sync = () => setDown(new Set(held.current.values()));
  const press = (pointer: number, p: number) => { held.current.set(pointer, p); onNoteOn(p); sync(); };
  const lift = (pointer: number) => {
    const p = held.current.get(pointer);
    if (p === undefined) return;
    held.current.delete(pointer);
    if (![...held.current.values()].includes(p)) onNoteOff(p);
    sync();
  };
  const pitchAt = (x: number, y: number): number | null => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest?.('[data-pitch]') as HTMLElement | null;
    return el ? Number(el.dataset.pitch) : null;
  };
  // Changement d'octave ou fermeture : aucune note ne reste coincée.
  useEffect(() => () => { held.current.forEach(p => onNoteOff(p)); held.current.clear(); }, [onNoteOff, low]);
  return (
    <div className="syn-keys" role="group" aria-label={`Clavier d'essai, de ${noteName(low)} à ${noteName(low + count - 1)}`} data-testid="synth-keyboard"
      onPointerDown={e => {
        const t = (e.target as HTMLElement).closest('[data-pitch]') as HTMLElement | null;
        if (!t) return;
        e.preventDefault();
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* pointeur synthétique ou déjà relâché */ }
        press(e.pointerId, Number(t.dataset.pitch));
      }}
      onPointerMove={e => {
        if (!held.current.has(e.pointerId)) return;
        const p = pitchAt(e.clientX, e.clientY);
        if (p === null || p === held.current.get(e.pointerId)) return;
        lift(e.pointerId); press(e.pointerId, p); // glissando
      }}
      onPointerUp={e => lift(e.pointerId)} onPointerCancel={e => lift(e.pointerId)} onLostPointerCapture={e => lift(e.pointerId)}>
      {whites.map((k, i) => (
        <button key={k} type="button" tabIndex={-1} data-pitch={k} data-down={down.has(k) ? 'true' : 'false'} aria-label={noteName(k)}
          className="syn-key syn-key-w" style={{ left: `${i * ww}%`, width: `calc(${ww}% - 2px)` }}>
          {k % 12 === 0 && <span className="syn-key-label">{noteName(k)}</span>}
        </button>
      ))}
      {keys.filter(isBlack).map(k => {
        const idx = whites.filter(w => w < k).length;
        return (
          <button key={k} type="button" tabIndex={-1} data-pitch={k} data-down={down.has(k) ? 'true' : 'false'} aria-label={noteName(k)}
            className="syn-key syn-key-b" style={{ left: `calc(${idx * ww}% - ${ww * 0.33}%)`, width: `${ww * 0.64}%` }} />
        );
      })}
    </div>
  );
};

// --- Écran ------------------------------------------------------------------------------

type Cat = PresetCategory | 'Tous' | 'Favoris' | 'Nouveautés';

const SynthPanel: React.FC<Props> = ({ track, onChange, onPreview, onNoteOn, onNoteOff, onClose }) => {
  const legacy = !track.novaSynth;
  const s = useMemo(() => normalizeSynth(track.novaSynth ?? presetSettings('nova-saw-classique')), [track.novaSynth]);
  const sRef = useRef(s);
  sRef.current = s;
  const narrow = useNarrow();
  const wide = useWide();
  const [cat, setCat] = useState<Cat>(() => (!legacy && s.presetId && presetById(s.presetId)?.cat) || 'Tous');
  const [query, setQuery] = useState('');
  const [favs, setFavs] = useState<string[]>(readFavs);
  const [tab, setTab] = useState<'sons' | 'reglages'>('sons');
  const [kbOct, setKbOct] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>({ osc1: true, filter: true });
  const preset = s.presetId ? presetById(s.presetId) : undefined;
  const modified = !!preset && settingsKey(presetSettings(preset.id)) !== settingsKey(s);
  const newCount = useMemo(() => SYNTH_PRESETS.filter(p => p.isNew).length, []);

  // Échap ferme l'écran.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Écoute rapide d'un autre son : le moteur reprend ensuite le son de la piste.
  const auditioned = useRef(false);
  const restoreTimer = useRef<number | undefined>(undefined);
  const restore = useCallback(() => {
    window.clearTimeout(restoreTimer.current);
    if (!auditioned.current) return;
    auditioned.current = false;
    if (!legacy) onPreview(sRef.current, []);
  }, [legacy, onPreview]);
  useEffect(() => () => { window.clearTimeout(restoreTimer.current); if (auditioned.current && !legacy) onPreview(sRef.current, []); }, [legacy, onPreview]);
  const audition = (id: string) => {
    onPreview(presetSettings(id), previewNotesFor(id));
    auditioned.current = true;
    window.clearTimeout(restoreTimer.current);
    restoreTimer.current = window.setTimeout(restore, 2600);
  };

  const list = useMemo(() => {
    const q = fold(query.trim());
    if (q) return SYNTH_PRESETS.filter(p => fold(`${p.name} ${p.cat} ${p.tip}`).includes(q));
    if (cat === 'Tous') return SYNTH_PRESETS;
    if (cat === 'Favoris') return SYNTH_PRESETS.filter(p => favs.includes(p.id));
    if (cat === 'Nouveautés') return SYNTH_PRESETS.filter(p => p.isNew);
    return SYNTH_PRESETS.filter(p => p.cat === cat);
  }, [cat, favs, query]);

  const choose = useCallback((id: string) => {
    window.clearTimeout(restoreTimer.current);
    auditioned.current = false;
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
  const toggleMod = useCallback((id: string) => setOpen(o => ({ ...o, [id]: !o[id] })), []);
  const noteOn = useCallback((p: number) => { restore(); onNoteOn(p); }, [restore, onNoteOn]);

  const keyCount = narrow ? 13 : wide ? 25 : 18;
  const kbLow = 48 + kbOct * 12;

  // --- Navigateur de sons -------------------------------------------------------------
  const chip = (c: Cat, text: string) => (
    <button key={c} type="button" role="tab" aria-selected={!query && cat === c} onClick={() => { setQuery(''); setCat(c); }}
      className={`shrink-0 min-h-[44px] lg:min-h-[26px] px-3 lg:px-2.5 rounded-full text-[11px] lg:text-[10.5px] font-bold border whitespace-nowrap ${!query && cat === c ? 'bg-cyan-500 text-black border-cyan-400' : 'bg-white/5 text-slate-300 border-white/10 hover:text-white'}`}>
      {text}
    </button>
  );
  const row = (p: SynthPreset) => {
    const on = p.id === s.presetId;
    return (
      <div key={p.id} className={`flex items-stretch rounded-lg border transition-colors ${on ? 'bg-cyan-500/15 border-cyan-400' : 'bg-white/[0.04] border-white/10 hover:bg-white/10'}`}>
        <button type="button" onClick={() => choose(p.id)} aria-pressed={on} title={p.tip} data-preset={p.id}
          className="flex-1 min-w-0 text-left min-h-[48px] px-2.5 py-1.5">
          <span className="flex items-center gap-1.5 text-[12px] font-bold leading-tight text-white min-w-0">
            {favs.includes(p.id) && <span className="text-amber-300 shrink-0" aria-label="favori">★</span>}
            <span className="truncate">{p.name}</span>
            {p.isNew && <span className="shrink-0 rounded px-1 py-px text-[8.5px] font-black uppercase tracking-wider bg-fuchsia-500/20 text-fuchsia-200 border border-fuchsia-400/40">Nouveau</span>}
          </span>
          <span className="block text-[10px] text-slate-400 truncate">{cat === 'Tous' || cat === 'Favoris' || cat === 'Nouveautés' || query ? p.cat : p.tip}</span>
        </button>
        <button type="button" onClick={() => audition(p.id)} aria-label={`Écouter ${p.name}`} title="Écouter sans choisir"
          className="w-11 shrink-0 rounded-r-lg text-slate-300 hover:text-cyan-300 hover:bg-white/5 border-l border-white/10">
          <i className="fas fa-play text-[11px]" aria-hidden="true" />
        </button>
      </div>
    );
  };
  const browser = (
    <div className="flex flex-col gap-2 min-h-0 h-full" data-synth-browser>
      <label className="relative block shrink-0">
        <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[12px]" aria-hidden="true" />
        <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Chercher : pluck, drill, nappe…" aria-label="Chercher un son"
          className="w-full h-11 lg:h-9 pl-8 pr-3 rounded-lg bg-white/5 border border-white/10 text-[12px] text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400" />
      </label>
      <div className="flex gap-1.5 lg:gap-1 overflow-x-auto lg:flex-wrap pb-1 shrink-0 scrollbar-hide" role="tablist" aria-label="Catégories de sons">
        {chip('Tous', 'Tous')}
        {chip('Favoris', `★ Favoris${favs.length ? ` (${favs.length})` : ''}`)}
        {chip('Nouveautés', `✨ Nouveautés (${newCount})`)}
        {PRESET_CATEGORIES.map(c => chip(c, c))}
      </div>
      {list.length === 0 ? (
        <p className="text-[12px] text-slate-400 p-4 text-center">
          {query ? `Aucun son pour « ${query} ». Essaie « pluck », « nappe » ou « basse ».` : "Aucun favori pour l'instant : touche ★ à côté du nom du son pour le retrouver ici."}
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-1.5 overflow-y-auto overscroll-contain min-h-0 pr-0.5 content-start" data-testid="synth-presets">
          {list.map(row)}
        </div>
      )}
    </div>
  );

  // --- Façade -----------------------------------------------------------------------------
  const oscMod = (o: SynthOsc, i: number) => {
    const id = `osc${i + 1}`;
    const p = (k: string) => `osc${i + 1}-${k}`;
    return (
      <Mod key={id} id={id} title={`Oscillateur ${i + 1}`} className="syn-osc" open={!!open[id]} onToggle={toggleMod} off={!o.on}
        aside={<PushButton active={o.on} onClick={() => setOsc(i, { on: !o.on })} text={o.on ? 'Actif' : 'Coupé'} led="#5eead4" dark
          ariaLabel={`Oscillateur ${i + 1}`} hint="Allume ou coupe cet oscillateur (jusqu'à 3 sources mélangées)." valueText={o.on ? 'actif' : 'coupé'}
          dataAttrs={{ 'data-testid': `osc-${i + 1}-on` }} />}>
        <div className="syn-row-split">
          <WaveScreen o={o} n={i + 1} />
          <Radio grid label={`Forme d'onde de l'oscillateur ${i + 1}`} value={o.wave} paramId={p('wave')} hint={WAVE_HINT} onChange={v => setOsc(i, { wave: v })}
            options={WAVES.map(w => ({ id: w.id, aria: w.label, text: <WaveIcon wave={w.id} /> }))} />
        </div>
        <div className="syn-knobs-4">
          <Knob size="S" label="Octave" ariaLabel={`Octave de l'oscillateur ${i + 1}`} paramId={p('octave')} value={o.octave} min={-3} max={3} step={1} defaultValue={0}
            detents={[-3, -2, -1, 0, 1, 2, 3].map(v => ({ v }))} format={fmtSigned} cap="graphite" hint="Monte ou descend l'oscillateur d'une ou plusieurs octaves." onChange={v => setOsc(i, { octave: v })} />
          <Knob size="S" label="Demi-tons" ariaLabel={`Demi-tons de l'oscillateur ${i + 1}`} paramId={p('semi')} value={o.semi} min={-12} max={12} step={1} defaultValue={0} bipolar arc="#5eead4"
            format={v => `${fmtSigned(v)} dt`} cap="graphite" hint="Transpose en demi-tons : +7 = quinte, +12 = octave. Utile pour les cloches." onChange={v => setOsc(i, { semi: v })} />
          <Knob size="S" label="Fin" ariaLabel={`Désaccord fin de l'oscillateur ${i + 1}`} paramId={p('fine')} value={o.fine} min={-100} max={100} step={1} defaultValue={0} bipolar arc="#5eead4"
            format={v => `${fmtSigned(Math.round(v))} ct`} cap="graphite" hint="Désaccord fin en cents : quelques cents épaississent le son." onChange={v => setOsc(i, { fine: v })} />
          <Knob size="S" label="Niveau" ariaLabel={`Niveau de l'oscillateur ${i + 1}`} paramId={p('level')} value={o.level} min={0} max={1} defaultValue={0.8} arc="#5eead4"
            format={fmtPct} cap="graphite" hint="Volume de cet oscillateur dans le mélange." onChange={v => setOsc(i, { level: v })} />
          <Knob size="S" label="Unisson" ariaLabel={`Unisson de l'oscillateur ${i + 1}`} paramId={p('unison')} value={o.unison} min={1} max={7} step={1} defaultValue={1}
            detents={[1, 2, 3, 4, 5, 6, 7].map(v => ({ v }))} format={v => `${v} voix`} cap="graphite" hint="Empile des copies désaccordées pour un son large (supersaw)." onChange={v => setOsc(i, { unison: v })} />
          <Knob size="S" label="Écart" ariaLabel={`Désaccord de l'unisson, oscillateur ${i + 1}`} paramId={p('detune')} value={o.detune} min={0} max={100} defaultValue={0} arc="#f0abfc"
            format={v => `${Math.round(v)} ct`} cap="graphite" hint="Écart entre les voix d'unisson : plus c'est haut, plus ça ondule." onChange={v => setOsc(i, { detune: v })} />
          <Knob size="S" label="Stéréo" ariaLabel={`Largeur stéréo de l'oscillateur ${i + 1}`} paramId={p('spread')} value={o.spread} min={0} max={1} defaultValue={0} arc="#f0abfc"
            format={fmtPct} cap="graphite" hint="Étale les voix d'unisson de gauche à droite." onChange={v => setOsc(i, { spread: v })} />
        </div>
      </Mod>
    );
  };

  const envRow = (k: 'ampEnv' | 'filterEnv', name: string) => {
    const e = s[k];
    const p = (x: string) => `${k === 'ampEnv' ? 'amp' : 'fenv'}-${x}`;
    const col = k === 'ampEnv' ? '#5eead4' : '#f0abfc';
    return (
      <div>
        <div className="hw-silk hw-silk-soft" style={{ textAlign: 'left', marginBottom: 2 }}>{name}</div>
        <div className="syn-knobs-4">
          <Knob size="S" label="Att." ariaLabel={`Attaque (${name.toLowerCase()})`} paramId={p('a')} value={e.a} min={0.001} max={5} curve="log" defaultValue={0.005} arc={col} cap="graphite"
            format={fmtS} hint="Temps pour monter au maximum. Court = percussif, long = nappe qui arrive doucement." onChange={v => setEnv(k, { a: v })} />
          <Knob size="S" label="Décl." ariaLabel={`Déclin (${name.toLowerCase()})`} paramId={p('d')} value={e.d} min={0.01} max={8} curve="log" defaultValue={0.3} arc={col} cap="graphite"
            format={fmtS} hint="Temps pour redescendre au niveau de maintien." onChange={v => setEnv(k, { d: v })} />
          <Knob size="S" label="Maint." ariaLabel={`Maintien (${name.toLowerCase()})`} paramId={p('s')} value={e.s} min={0} max={1} defaultValue={0.7} arc={col} cap="graphite"
            format={fmtPct} hint="Niveau tant que la touche est tenue. 0 = pluck ou cloche qui s'éteint seul." onChange={v => setEnv(k, { s: v })} />
          <Knob size="S" label="Relâch." ariaLabel={`Relâchement (${name.toLowerCase()})`} paramId={p('r')} value={e.r} min={0.01} max={10} curve="log" defaultValue={0.25} arc={col} cap="graphite"
            format={fmtS} hint="Queue du son après avoir lâché la touche." onChange={v => setEnv(k, { r: v })} />
        </div>
      </div>
    );
  };

  const cutoffInput = (
    // Champ natif masqué (accroche des scripts QA qui pilotent la coupure), toujours rendu.
    <input type="range" className="hw-sr-only" tabIndex={-1} aria-hidden="true" data-testid="synth-cutoff" min={20} max={20000} step="any"
      value={s.filter.cutoff} onChange={e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) set(d => { d.filter.cutoff = v; }); }} />
  );

  const facade = (
    <div className="syn-cheeks">
      <span className="syn-cheek" aria-hidden="true" />
      <Faceplate finish="black" className="syn-finish hw-touch" model="NOVA SYNTH" modelStyle="wide" kicker="3 oscillateurs · filtre 12 / 24 dB · 2 enveloppes · LFO · chorus · écho">
        <div className="syn-grid">
          {s.osc.map(oscMod)}
          <Mod id="filter" title="Filtre" className="syn-filter" open={!!open.filter} onToggle={toggleMod}
            aside={<>{cutoffInput}<PushButton active={s.filter.steep} onClick={() => set(d => { d.filter.steep = !d.filter.steep; })} text={s.filter.steep ? '24 dB' : '12 dB'} dark led="#fcd34d"
              ariaLabel="Pente du filtre 24 dB par octave" hint="24 dB/oct : coupure plus raide (deux filtres en série)." valueText={s.filter.steep ? '24 dB/oct' : '12 dB/oct'} /></>}>
            <FilterScreen s={s} />
            <Radio label="Type de filtre" value={s.filter.type} paramId="filter-type" onChange={v => set(d => { d.filter.type = v; })}
              hint="Passe-bas = garde les graves (le plus courant) ; passe-haut = enlève les graves ; passe-bande = son de radio, voix, chœurs."
              options={FILTERS.map(f => ({ id: f.id, aria: f.label, text: f.short }))} />
            <div className="syn-knobs-3">
              <Knob size="M" label="Coupure" ariaLabel="Coupure du filtre" paramId="filter-cutoff" value={s.filter.cutoff} min={20} max={20000} curve="log" defaultValue={2400} arc="#5eead4" cap="silver"
                format={fmtHz} hint="Fréquence où le filtre agit : plus bas = plus sombre." onChange={v => set(d => { d.filter.cutoff = v; })} />
              <Knob size="M" label="Résonance" ariaLabel="Résonance du filtre" paramId="filter-reso" value={s.filter.reso} min={0.1} max={20} curve="log" defaultValue={1} arc="#fcd34d" cap="silver"
                format={v => fr(v)} hint="Accentue la coupure : son plus « acide »." onChange={v => set(d => { d.filter.reso = v; })} />
              <Knob size="M" label="Enveloppe" ariaLabel="Enveloppe vers le filtre" paramId="filter-env" value={s.filter.envAmount} min={-4} max={6} step={0.05} defaultValue={1.5} bipolar arc="#f0abfc" cap="silver"
                format={v => `${v > 0 ? '+' : ''}${fr(v)} oct`} hint="Combien l'enveloppe de filtre ouvre le son à chaque note : c'est le « pluck »." onChange={v => set(d => { d.filter.envAmount = v; })} />
              <Knob size="S" label="Suivi" ariaLabel="Suivi du clavier" paramId="filter-key" value={s.filter.keytrack} min={0} max={1} defaultValue={0.3} cap="graphite"
                format={fmtPct} hint="Les notes aiguës ouvrent davantage le filtre, comme un vrai instrument." onChange={v => set(d => { d.filter.keytrack = v; })} />
              <Knob size="S" label="Vélocité" ariaLabel="Vélocité vers le filtre" paramId="filter-vel" value={s.filter.velAmount} min={0} max={4} step={0.05} defaultValue={1} cap="graphite"
                format={v => `${fr(v)} oct`} hint="Frapper fort ouvre le filtre." onChange={v => set(d => { d.filter.velAmount = v; })} />
              <Knob size="S" label="Bruit" ariaLabel="Bruit" paramId="noise" value={s.noise.level} min={0} max={1} defaultValue={0} cap="graphite"
                format={fmtPct} hint="Ajoute du souffle : flûtes, attaques, textures." onChange={v => set(d => { d.noise.level = v; })} />
            </div>
          </Mod>
          <Mod id="env" title="Enveloppes" className="syn-env" open={!!open.env} onToggle={toggleMod}>
            <EnvScreen amp={s.ampEnv} filt={s.filterEnv} showFilter={s.filter.envAmount !== 0} />
            {envRow('ampEnv', 'Volume')}
            {envRow('filterEnv', 'Filtre')}
          </Mod>
          <Mod id="lfo" title="LFO" className="syn-lfo" open={!!open.lfo} onToggle={toggleMod} off={s.lfo.dest === 'off'}>
            <LfoScreen s={s} />
            <Radio label="Le LFO agit sur" value={s.lfo.dest} paramId="lfo-dest" onChange={v => set(d => { d.lfo.dest = v; })}
              hint="Filtre = wah / wobble ; Hauteur = vibrato ; Volume = trémolo ou « pompe » façon sidechain."
              options={LFO_DESTS.map(x => ({ id: x.id, aria: `LFO : ${x.label}`, text: x.label }))} />
            <div className="syn-row" style={{ justifyContent: 'space-between' }}>
              <Radio label="Forme du LFO" value={s.lfo.wave} paramId="lfo-wave" onChange={v => set(d => { d.lfo.wave = v; })}
                hint="Forme du mouvement : sinus = doux, carré = saccadé." options={WAVES.map(w => ({ id: w.id, aria: `LFO ${w.label}`, text: <WaveIcon wave={w.id} /> }))} />
            </div>
            <div className="syn-knobs-3">
              <Knob size="M" label="Vitesse" ariaLabel="Vitesse du LFO" paramId="lfo-rate" value={s.lfo.rate} min={0.05} max={20} curve="log" defaultValue={5} arc="#5eead4" cap="silver"
                format={v => `${fr(v, 2)} Hz`} hint="Rapidité du mouvement. 2,5 Hz ≈ une noire à 150 BPM." onChange={v => set(d => { d.lfo.rate = v; })} />
              <Knob size="M" label="Intensité" ariaLabel="Intensité du LFO" paramId="lfo-amount" value={s.lfo.amount} min={0} max={1} defaultValue={0.2} arc="#5eead4" cap="silver"
                format={fmtPct} hint="Profondeur du mouvement." onChange={v => set(d => { d.lfo.amount = v; })} />
            </div>
          </Mod>
          <Mod id="play" title="Jeu" className="syn-play" open={!!open.play} onToggle={toggleMod}>
            <Radio label="Voix" value={s.mono ? 'mono' : 'poly'} paramId="voices" onChange={v => set(d => { d.mono = v === 'mono'; })}
              hint="Poly = accords ; Mono = une note à la fois, pour les leads et les basses."
              options={[{ id: 'poly', aria: 'Poly (accords)', text: 'POLY' }, { id: 'mono', aria: 'Mono', text: 'MONO' }]} />
            <PushButton active={s.mono && s.legato} disabled={!s.mono} onClick={() => set(d => { d.legato = !d.legato; })} text="Legato" dark led="#fcd34d"
              ariaLabel="Legato" hint="Mono : une note liée ne relance pas l'attaque." valueText={s.legato ? 'oui' : 'non'} className="hw-push-sm" />
            <div className="syn-knobs">
              <Knob size="S" label="Glissé" ariaLabel="Glissé (portamento)" paramId="glide" value={s.glide} min={0} max={1} defaultValue={0} cap="graphite"
                format={v => (v <= 0.0005 ? 'non' : fmtS(v))} hint="Portamento : la hauteur glisse d'une note à l'autre." onChange={v => set(d => { d.glide = v < 0.003 ? 0 : v; })} />
              <Knob size="S" label="Vél.→vol" ariaLabel="Vélocité vers le volume" paramId="vel-amp" value={s.velToAmp} min={0} max={1} defaultValue={0.6} cap="graphite"
                format={fmtPct} hint="0 = toutes les notes au même volume ; 100 % = très dynamique comme un piano." onChange={v => set(d => { d.velToAmp = v; })} />
            </div>
          </Mod>
          <Mod id="fx" title="Effets" className="syn-fx" open={!!open.fx} onToggle={toggleMod}>
            <div className="hw-silk hw-silk-soft" style={{ textAlign: 'left' }}>Chorus</div>
            <div className="syn-knobs-3">
              <Knob size="S" label="Mélange" ariaLabel="Chorus : mélange" paramId="chorus-mix" value={s.fx.chorus.mix} min={0} max={1} defaultValue={0} arc="#5eead4" cap="graphite"
                format={fmtPct} hint="Élargit et fait onduler le son, comme le chorus d'un vieux synthé." onChange={v => set(d => { d.fx.chorus.mix = v; })} />
              <Knob size="S" label="Vitesse" ariaLabel="Chorus : vitesse" paramId="chorus-rate" value={s.fx.chorus.rate} min={0.05} max={8} curve="log" defaultValue={0.6} cap="graphite"
                format={v => `${fr(v, 2)} Hz`} hint="Vitesse d'ondulation du chorus." onChange={v => set(d => { d.fx.chorus.rate = v; })} />
              <Knob size="S" label="Profond." ariaLabel="Chorus : profondeur" paramId="chorus-depth" value={s.fx.chorus.depth} min={0} max={1} defaultValue={0.4} cap="graphite"
                format={fmtPct} hint="Ampleur de l'ondulation du chorus." onChange={v => set(d => { d.fx.chorus.depth = v; })} />
            </div>
            <div className="hw-silk hw-silk-soft" style={{ textAlign: 'left' }}>Écho</div>
            <div className="syn-knobs-3">
              <Knob size="S" label="Mélange" ariaLabel="Écho : mélange" paramId="delay-mix" value={s.fx.delay.mix} min={0} max={1} defaultValue={0} arc="#f0abfc" cap="graphite"
                format={fmtPct} hint="Échos : idéal sur les plucks et les arpèges." onChange={v => set(d => { d.fx.delay.mix = v; })} />
              <Knob size="S" label="Temps" ariaLabel="Écho : temps" paramId="delay-time" value={s.fx.delay.time} min={0.02} max={1.5} curve="log" defaultValue={0.375} cap="graphite"
                format={fmtS} hint="Écart entre les échos." onChange={v => set(d => { d.fx.delay.time = v; })} />
              <Knob size="S" label="Répét." ariaLabel="Écho : répétitions" paramId="delay-fb" value={s.fx.delay.feedback} min={0} max={0.9} defaultValue={0.3} cap="graphite"
                format={fmtPct} hint="Nombre d'échos (réinjection)." onChange={v => set(d => { d.fx.delay.feedback = v; })} />
            </div>
          </Mod>
          <Mod id="out" title="Sortie" className="syn-out" open={!!open.out} onToggle={toggleMod}>
            <div className="syn-knobs">
              <Knob size="L" label="Volume" ariaLabel="Volume du synthé" paramId="level" value={s.level} min={0} max={1} defaultValue={0.7} arc="#5eead4" cap="silver"
                format={fmtPct} hint="Volume du son (les sons de la banque sont calibrés au même niveau)." onChange={v => set(d => { d.level = v; })} />
            </div>
            {!legacy && (
              <PushButton active={false} onClick={() => onChange(undefined)} text="Synthé simple" dark led={false} className="hw-push-sm"
                ariaLabel="Revenir au synthé simple d'origine" hint="Revenir au synthé d'origine de NOVA (une dent de scie filtrée), celui des anciens projets." />
            )}
          </Mod>
        </div>
      </Faceplate>
      <span className="syn-cheek" aria-hidden="true" />
    </div>
  );

  const showSons = wide || tab === 'sons';
  const showReglages = wide || tab === 'reglages';
  const name = legacy ? 'Synthé simple (son d\'origine)' : (s.name || preset?.name || 'Son personnalisé');

  return (
    <div className="fixed inset-0 z-[300] bg-black/70 flex items-stretch sm:items-center justify-center" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog" aria-modal="true" aria-label="Synthé NOVA" data-testid="synth-panel">
      <HwHelpProvider>
      <div className="w-full sm:w-[min(1380px,97vw)] h-full sm:h-[95vh] bg-nv-surface sm:rounded-2xl border border-white/10 shadow-2xl flex flex-col overflow-hidden">
        {/* En-tête : nom du son (écran), précédent / suivant, favori, écoute, fermer */}
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-white/10 bg-nv-panel">
          <span className="text-[11px] font-black uppercase tracking-widest text-cyan-300 shrink-0 order-1">🎹 Synthé NOVA</span>
          <div className="flex items-center gap-1.5 min-w-0 flex-1 basis-full sm:basis-auto order-3 sm:order-2">
            <button type="button" onClick={() => step(-1)} aria-label="Son précédent" title="Son précédent" className="w-11 h-11 shrink-0 rounded-lg bg-white/10 text-white hover:bg-white/20"><i className="fas fa-chevron-left" /></button>
            <div className="syn-lcd flex-1 nova-sombre" title={preset?.tip}>
              <small>{legacy ? 'Ancien synthé' : `${preset?.cat ?? 'Son personnalisé'}${preset?.isNew ? ' · nouveau' : ''}`}</small>
              <span data-testid="synth-preset-name">{name}{modified && <span className="text-amber-300 text-[11px] ml-1" title="Réglages retouchés depuis le préréglage">• modifié</span>}</span>
            </div>
            <button type="button" onClick={() => step(1)} aria-label="Son suivant" title="Son suivant" className="w-11 h-11 shrink-0 rounded-lg bg-white/10 text-white hover:bg-white/20"><i className="fas fa-chevron-right" /></button>
            <button type="button" onClick={toggleFav} disabled={!s.presetId} aria-pressed={fav} aria-label={fav ? 'Retirer des favoris' : 'Ajouter aux favoris'} title="Favori"
              className={`w-11 h-11 shrink-0 rounded-lg text-[16px] ${fav ? 'bg-amber-400/20 text-amber-300' : 'bg-white/10 text-slate-300'} disabled:opacity-30`}>★</button>
            <button type="button" onClick={() => { window.clearTimeout(restoreTimer.current); auditioned.current = false; onPreview(s, s.presetId ? previewNotesFor(s.presetId) : [48, 55, 58, 62, 65]); }}
              className="h-11 min-w-[44px] px-3 shrink-0 rounded-lg bg-cyan-500 text-black text-[12px] font-black" title="Écouter un accord avec ce son" aria-label="Écouter ce son"><i className="fas fa-play sm:mr-1" /><span className="hidden sm:inline">Écouter</span></button>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer le synthé" title="Fermer (Échap)" className="w-11 h-11 rounded-lg bg-white/10 text-white hover:bg-white/20 shrink-0 ml-auto order-2 sm:order-3"><i className="fas fa-times" /></button>
        </div>
        {/* Onglets (téléphone et tablette : une vue à la fois) */}
        <div className="flex gap-1 px-3 pt-2 shrink-0 lg:hidden" role="tablist" aria-label="Vue du synthé">
          {([['sons', `Sons (${SYNTH_PRESETS.length})`], ['reglages', 'Réglages']] as const).map(([id, txt]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} data-testid={`synth-tab-${id}`}
              className={`min-h-[44px] px-4 rounded-t-lg text-[12px] font-black ${tab === id ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}>{txt}</button>
          ))}
        </div>
        <div className="flex-1 min-h-0 flex">
          {showSons && (
            <div className={`${wide ? 'w-[320px] shrink-0 border-r border-white/10' : 'flex-1 min-w-0'} min-h-0 p-3 flex flex-col`}>{browser}</div>
          )}
          {showReglages && (
            <div className="flex-1 min-w-0 overflow-y-auto overscroll-contain p-2 sm:p-3 bg-nv-bg nova-sombre" data-synth-facade>{facade}</div>
          )}
        </div>
        {/* Clavier d'essai */}
        <div className="border-t border-white/10 px-2 sm:px-3 pt-1.5 pb-2 bg-nv-panel shrink-0">
          <div className="flex items-center gap-2 mb-1.5">
            <button type="button" onClick={() => setKbOct(o => Math.max(-3, o - 1))} disabled={kbOct <= -3} aria-label="Clavier une octave plus bas" title="Une octave plus bas"
              className="w-11 h-11 sm:h-8 rounded-lg bg-white/10 text-white text-[12px] font-black disabled:opacity-30">−</button>
            <span className="text-[11px] font-bold text-slate-300 tabular-nums">{noteName(kbLow)} – {noteName(kbLow + keyCount - 1)}</span>
            <button type="button" onClick={() => setKbOct(o => Math.min(2, o + 1))} disabled={kbOct >= 2} aria-label="Clavier une octave plus haut" title="Une octave plus haut"
              className="w-11 h-11 sm:h-8 rounded-lg bg-white/10 text-white text-[12px] font-black disabled:opacity-30">+</button>
            <span className="text-[10px] text-slate-400 truncate hidden sm:inline">Joue à la souris ou au doigt ; glisse sur les touches pour un glissando.</span>
          </div>
          <Keybed low={kbLow} count={keyCount} onNoteOn={noteOn} onNoteOff={onNoteOff} />
        </div>
        <div className="nova-sombre shrink-0" data-testid="synth-hint" role="status" aria-live="polite">
          <InfoBar idle={<>Synthé NOVA : choisis un son à gauche (▶ pour l'écouter sans le choisir), puis sculpte-le. Glisse un bouton, double-clic = valeur d'origine, <b>Ctrl+Z</b> annule.</>}
            side={`${SYNTH_PRESETS.length} sons`} />
        </div>
      </div>
      </HwHelpProvider>
    </div>
  );
};

export default SynthPanel;
