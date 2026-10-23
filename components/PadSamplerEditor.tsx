import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DrumMachine, DrumRow } from '../utils/drumKits';
import {
  ampEnvelope, cleanSampler, dbToGain, envValue, filterSections, gainToDb, listPadPresets, nearestZeroCrossing, peakOf, savePadPreset, deletePadPreset,
  sectionGainDb, semisToRatio, smpOf, SAMPLER_DEFAULTS, type PadPreset, type PadSamplerParams,
} from '../utils/padSampler';
import { regionOf, assignSample, removePadLayer, setPadLayer, userSampleId } from '../utils/drumSamples';
import { padSourceBuffer, sampleFromFile } from '../utils/padBuffers';
import { audioEngine } from '../engine/AudioEngine';
import { KIT_DRAG_TYPE, kitIndexIfLoaded, kitRef, kitSoundLabel } from '../utils/drumKitLibrary';
import { libSoundLabel } from '../utils/drumKits';
import { DrumMenu, menuAt, type DrumMenuItem, type DrumMenuState } from './DrumMenu';

/**
 * Éditeur de son d'un pad (sampler de pad) : onglets Sample · Enveloppes · Filtre · Hauteur · Modulation.
 * Chaque valeur affichée est la valeur réelle (ms, dB, Hz, demi-tons) — mêmes formules que le moteur
 * (utils/padSampler.ts), mesurées par tests/padSampler.test.ts et qa/sampler_pads.py.
 * S'ouvre au double-clic sur le nom d'un pad, ou par son menu › « Éditer le son ».
 */
type Tab = 'sample' | 'env' | 'filter' | 'pitch' | 'mod';
const TABS: { id: Tab; label: string }[] = [
  { id: 'sample', label: 'Sample' }, { id: 'env', label: 'Enveloppes' }, { id: 'filter', label: 'Filtre' }, { id: 'pitch', label: 'Hauteur' }, { id: 'mod', label: 'Modulation' },
];
const TAB_KEY = 'nova_pad_sampler_tab';

const fr = (v: number, d = 1) => v.toFixed(d).replace('.', ',');
export const fmtMs = (s: number) => (s >= 1 ? `${fr(s, 2)} s` : `${s * 1000 >= 10 ? Math.round(s * 1000) : fr(s * 1000, 1)} ms`);
export const fmtHz = (hz: number) => (hz >= 1000 ? `${fr(hz / 1000, hz >= 10000 ? 1 : 2)} kHz` : `${Math.round(hz)} Hz`);
export const fmtDb = (db: number) => (Number.isFinite(db) ? `${db > 0 ? '+' : db < 0 ? '−' : ''}${fr(Math.abs(db), 1)} dB` : '−∞ dB');
const fmtSt = (st: number) => `${st > 0 ? '+' : st < 0 ? '−' : ''}${Math.abs(st)} dt`;

/** Au doigt : curseur de 44 px de haut (la règle générale de l'appli en donne 40), piste fine au milieu. */
const COARSE = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
export const TOUCH_RANGE: React.CSSProperties = { height: 44, padding: '19px 0', backgroundClip: 'content-box' };

/** Curseur au doigt (44 px), valeur exacte affichée, retour à la valeur par défaut d'un clic sur la valeur. */
const Ctl: React.FC<{
  label: string; value: number; min: number; max: number; step?: number; fmt: (v: number) => string; onChange: (v: number) => void; dflt?: number;
  /** Échelle logarithmique (temps, fréquences) : la position du curseur suit le logarithme. */
  log?: boolean; hint?: string; testId?: string; disabled?: boolean;
}> = ({ label, value, min, max, step, fmt, onChange, dflt, log, hint, testId, disabled }) => {
  const lo = log ? Math.log(Math.max(1e-6, min)) : min;
  const hi = log ? Math.log(max) : max;
  const pos = log ? Math.log(Math.max(min, value)) : value;
  const toV = (x: number) => {
    let v = log ? Math.exp(x) : x;
    if (log && v <= min * 1.0001) v = min;
    if (log) {
      // Échelle logarithmique : valeurs « rondes » (3 chiffres, et 1 kHz plutôt que 998 Hz).
      v = +v.toPrecision(3);
      const two = +v.toPrecision(2);
      if (Math.abs(v - two) / v < 0.004) v = two;
    }
    if (step) v = Math.round(v / step) * step;
    return Math.max(min, Math.min(max, +v.toPrecision(6)));
  };
  return (
    <label className={`flex flex-col gap-0.5 min-w-0 ${disabled ? 'opacity-40' : ''}`} title={hint} data-testid={testId}>
      <span className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
        <span className="truncate">{label}</span>
        <button type="button" disabled={disabled} onClick={() => dflt !== undefined && onChange(dflt)} title={dflt !== undefined ? `Revenir à ${fmt(dflt)}` : undefined}
          className="tabular-nums text-[12px] font-bold text-slate-100 hover:text-cyan-300 min-h-[28px] [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:px-2" data-value="">{fmt(value)}</button>
      </span>
      <input type="range" disabled={disabled} min={lo} max={hi} step={log ? (hi - lo) / 4000 : step || (max - min) / 1000} value={pos}
        aria-label={label} aria-valuetext={fmt(value)}
        onChange={e => onChange(toV(parseFloat(e.target.value)))} className="w-full h-9 accent-cyan-400" style={COARSE ? TOUCH_RANGE : undefined} />
    </label>
  );
};

const Seg: React.FC<{ label: string; value: string | number; options: { label: string; value: string | number; hint?: string }[]; onPick: (v: string | number) => void; testId?: string }> = ({ label, value, options, onPick, testId }) => (
  <div className="flex flex-col gap-1 min-w-0" data-testid={testId}>
    <span className="text-[11px] text-slate-400">{label}</span>
    <div className="flex flex-wrap rounded-xl overflow-hidden border border-white/10 w-fit max-w-full" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} onClick={() => onPick(o.value)} title={o.hint}
          className={`min-h-[44px] min-w-[44px] px-3 text-[12px] font-bold ${o.value === value ? 'bg-white text-black' : 'bg-white/5 text-white hover:bg-white/10'}`}>{o.label}</button>
      ))}
    </div>
  </div>
);

interface Props {
  dm: DrumMachine;
  rowIndex: number;
  onChange: (dm: DrumMachine) => void;
  onAudition: () => void;
  onClose: () => void;
  ensureEngine: () => Promise<unknown>;
  notify?: (msg: string) => void;
  narrow?: boolean;
  projectKey: number | null;
  /** Remplacer le son : fichier ou son du navigateur des kits lâché sur l'éditeur. */
  onDropFiles: (e: React.DragEvent) => void;
  allowDrop: (e: React.DragEvent) => void;
}

const PadSamplerEditor: React.FC<Props> = ({ dm, rowIndex, onChange, onAudition, onClose, ensureEngine, notify, narrow, projectKey, onDropFiles, allowDrop }) => {
  const row = dm.rows[rowIndex] as DrumRow;
  const [tab, setTab] = useState<Tab>(() => { try { return (localStorage.getItem(TAB_KEY) as Tab) || 'sample'; } catch { return 'sample'; } });
  const pickTab = (t: Tab) => { setTab(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* */ } };
  const [src, setSrc] = useState<AudioBuffer | null>(null);
  const [menu, setMenu] = useState<DrumMenuState | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const layerFileRef = useRef<HTMLInputElement>(null);
  const s = smpOf(row.smp);
  const reg = regionOf(row);
  const root = typeof projectKey === 'number' ? projectKey : 0;

  // Son d'origine du pad (forme d'onde, normalisation, passages par zéro).
  useEffect(() => {
    let alive = true;
    void ensureEngine().then(() => {
      if (!audioEngine.ctx) return;
      return padSourceBuffer(row, audioEngine.ctx, root).then(b => { if (alive) setSrc(b); });
    }).catch(() => { if (alive) setSrc(null); });
    return () => { alive = false; };
  }, [row.sound, root]);

  // Échap ferme l'éditeur (pas toute la batterie) : la fenêtre du dessus d'abord. Focus dans l'éditeur, sur le
  // pad double-cliqué (dans la batterie) ou nulle part. Avant (audit de nuit 22/10/2026) : double-clic sur un
  // pad puis Échap fermait TOUTE la batterie, le focus étant resté sur le pad.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[data-testid=drum-menu]')) return;
      const a = document.activeElement as HTMLElement | null;
      const inside = !!rootRef.current?.contains(a) || !a || a === document.body || !!a.closest?.("[aria-labelledby='drums-title']");
      if (!inside) return;
      e.preventDefault(); e.stopImmediatePropagation(); onClose();
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [onClose]);

  // Pré-écoute après un réglage (pas à chaque cran du curseur).
  const auditionTimer = useRef<number | null>(null);
  const later = () => { if (auditionTimer.current) window.clearTimeout(auditionTimer.current); auditionTimer.current = window.setTimeout(onAudition, 260); };
  const latest = useRef(dm); latest.current = dm;
  const editRow = (patch: Partial<DrumRow>, listen = true) => {
    const d = latest.current;
    const next = { ...d, rows: d.rows.map((r, i) => (i === rowIndex ? { ...r, ...patch } : r)) };
    latest.current = next;
    onChange(next);
    if (listen) later();
  };
  const edit = (patch: Partial<PadSamplerParams>, listen = true) => {
    const cur = latest.current.rows[rowIndex]?.smp;
    const merged = cleanSampler({ ...(cur || {}), ...patch });
    // Valeur par défaut (son d'avant) : le champ disparaît, l'ancien chemin du moteur rejoue.
    editRow({ smp: merged }, listen);
  };

  // Niveau de normalisation (crête de la zone jouée → 0 dBFS), mesuré sur le son.
  const normDb = useMemo(() => {
    if (!src) return null;
    const ch = Array.from({ length: src.numberOfChannels }, (_, c) => src.getChannelData(c));
    const a = Math.floor(reg.start * src.length), b = Math.ceil(reg.end * src.length);
    const pk = peakOf(ch.map(c => c.subarray(a, Math.max(a + 1, b))));
    return pk > 1e-9 ? -gainToDb(pk) : null;
  }, [src, reg.start, reg.end]);

  const label = row.smp?.layers?.length ? `${row.name} + ${row.smp.layers.length} couche${row.smp.layers.length > 1 ? 's' : ''}` : row.name;
  const presetMenu = (e: React.MouseEvent) => {
    const list = listPadPresets();
    const items: DrumMenuItem[] = [
      { label: 'Enregistrer ce réglage comme preset…', icon: 'fa-floppy-disk', onClick: () => setNaming(row.name), testId: 'pad-preset-save' },
      ...(list.length ? [{ kind: 'sep' } as DrumMenuItem, { kind: 'title', label: 'Mes presets de pad (sur cet appareil)' } as DrumMenuItem] : []),
      ...list.map(p => ({ label: p.name, icon: 'fa-sliders', onClick: () => applyPreset(p), testId: `pad-preset-${p.name}` } as DrumMenuItem)),
      ...(list.length ? [{ kind: 'sep' } as DrumMenuItem, ...list.map(p => ({ label: `Supprimer « ${p.name} »`, icon: 'fa-trash', danger: true, onClick: () => deletePadPreset(p.id) } as DrumMenuItem))] : []),
    ];
    setMenu(menuAt(e, 'Presets de pad', items));
  };
  const applyPreset = (p: PadPreset) => {
    const keepLayers = row.smp?.layers;
    editRow({ smp: cleanSampler({ ...p.smp, ...(keepLayers ? { layers: keepLayers } : {}) }), ...(typeof p.tune === 'number' ? { tune: p.tune } : {}), ...(typeof p.decay === 'number' ? { decay: p.decay } : {}) });
    notify?.(`Preset « ${p.name} » appliqué au pad « ${row.name} » (le son reste le même). Annuler (Ctrl+Z) pour revenir.`);
  };

  const importInto = async (f: File | undefined, layer: boolean) => {
    if (!f) return;
    try {
      await ensureEngine();
      const smp = await sampleFromFile(audioEngine.ctx!, f);
      if (layer) onChange(setPadLayer(latest.current, rowIndex, null, `user:${smp.id}`, smp.info.name, smp));
      else { const r = assignSample(latest.current, smp.id, smp.info, { rowIndex }); if (r) onChange(r.dm); }
      later();
    } catch { notify?.('Ce fichier ne se lit pas : essaie un WAV, MP3, AIFF ou FLAC.'); }
  };
  const dropLayer = (e: React.DragEvent) => {
    const kitId = e.dataTransfer?.getData(KIT_DRAG_TYPE);
    if (kitId) { e.preventDefault(); e.stopPropagation(); const ix = kitIndexIfLoaded(); onChange(setPadLayer(latest.current, rowIndex, null, kitRef(kitId), ix?.byId.get(kitId)?.name || 'Couche')); later(); return; }
    const f = e.dataTransfer?.files?.[0];
    if (f) { e.preventDefault(); e.stopPropagation(); void importInto(f, true); }
  };

  return (
    <div ref={rootRef} className="rounded-2xl border border-cyan-400/30 bg-white/[0.03] p-3 space-y-3" data-testid="pad-sampler"
      onDragOver={allowDrop} onDrop={e => { e.stopPropagation(); onDropFiles(e); }} role="region" aria-label={`Son du pad ${row.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] font-black text-white mr-auto min-w-0 truncate"><i className="fas fa-wave-square text-cyan-400 mr-1.5" aria-hidden />Son du pad « {label} »</p>
        <button type="button" onClick={onAudition} className="min-h-[44px] px-3 rounded-xl bg-cyan-500 text-black text-[12px] font-black" data-testid="pad-sampler-play">
          <i className="fas fa-play mr-1.5" aria-hidden />Écouter
        </button>
        <button type="button" onClick={presetMenu} aria-haspopup="menu" className="min-h-[44px] px-3 rounded-xl bg-white/[0.06] text-slate-200 text-[12px] font-bold" data-testid="pad-presets">
          Presets <i className="fas fa-chevron-down ml-1 text-[10px]" aria-hidden />
        </button>
        <button type="button" onClick={() => { editRow({ smp: row.smp?.layers ? { layers: row.smp.layers, layerMode: row.smp.layerMode } : undefined }); notify?.('Réglages du sampler remis à zéro : le pad sonne comme son sample brut (Annuler pour revenir).'); }}
          disabled={!row.smp} title="Remettre le sampler à zéro (le son brut, comme avant)" aria-label="Remettre le sampler à zéro"
          className="min-h-[44px] w-11 rounded-xl bg-white/[0.06] text-slate-300 disabled:opacity-40"><i className="fas fa-rotate-left" aria-hidden /></button>
        <button type="button" onClick={onClose} aria-label="Fermer l'éditeur de son" className="min-h-[44px] w-11 rounded-xl bg-white/[0.06] text-slate-300"><i className="fas fa-times" aria-hidden /></button>
      </div>
      {naming !== null && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); const p = savePadPreset(naming, row.smp, { tune: row.tune, decay: row.decay }); setNaming(null); if (p) notify?.(`💾 Preset « ${p.name} » enregistré : Presets › « ${p.name} » sur n'importe quel pad.`); }}>
          <input autoFocus value={naming} onChange={e => setNaming(e.target.value)} maxLength={40} aria-label="Nom du preset" data-testid="pad-preset-name"
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setNaming(null); }}
            className="h-11 flex-1 min-w-[160px] rounded-lg bg-white/5 border border-white/15 px-2 text-[12px] text-white" />
          <button type="submit" className="h-11 px-3 rounded-lg bg-cyan-500 text-black text-[12px] font-black" data-testid="pad-preset-ok">Enregistrer</button>
          <button type="button" onClick={() => setNaming(null)} className="h-11 px-3 rounded-lg bg-white/5 text-slate-300 text-[12px]">Annuler</button>
        </form>
      )}

      <div className="flex gap-1 overflow-x-auto no-scrollbar" role="tablist" aria-label="Réglages du son">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => pickTab(t.id)} data-testid={`pad-tab-${t.id}`}
            className={`shrink-0 min-h-[44px] px-3.5 rounded-xl text-[12px] font-black ${tab === t.id ? 'bg-white text-black' : 'bg-white/5 text-slate-200 hover:bg-white/10'}`}>{t.label}</button>
        ))}
      </div>

      {tab === 'sample' && (
        <div className="space-y-3" role="tabpanel" aria-label="Sample">
          <WaveEditor src={src} row={row} onRegion={(a, b) => editRow({ start: a, end: b })} onLoop={(a, b) => edit({ loopStart: a, loopEnd: b })} />
          <div className="flex flex-wrap items-end gap-3">
            <Seg label="Lecture" value={s.mode} testId="pad-mode" onPick={v => edit({ mode: v as 'oneshot' | 'gate' })}
              options={[{ label: 'Un coup', value: 'oneshot', hint: 'Le son joue jusqu’au bout' }, { label: 'Note tenue', value: 'gate', hint: 'Le son joue tant que la note est tenue (longueur du pas), puis relâchement' }]} />
            <Seg label="Sens" value={row.reverse ? 1 : 0} onPick={v => editRow({ reverse: !!v || undefined })} testId="pad-reverse"
              options={[{ label: 'Normal', value: 0 }, { label: 'À l’envers', value: 1 }]} />
            <Seg label="Boucle" value={s.loop ? 1 : 0} onPick={v => edit({ loop: !!v })} testId="pad-loop"
              options={[{ label: 'Non', value: 0 }, { label: 'Oui', value: 1, hint: 'La boucle tourne tant que la note est tenue' }]} />
          </div>
          {s.loop && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-2">
              <Ctl label="Début de boucle" value={s.loopStart} min={0} max={0.99} step={0.001} dflt={0} fmt={v => fmtMs(v * (reg.end - reg.start) * (src?.duration || 0))} onChange={v => edit({ loopStart: Math.min(v, s.loopEnd - 0.005) })} />
              <Ctl label="Fin de boucle" value={s.loopEnd} min={0.01} max={1} step={0.001} dflt={1} fmt={v => fmtMs(v * (reg.end - reg.start) * (src?.duration || 0))} onChange={v => edit({ loopEnd: Math.max(v, s.loopStart + 0.005) })} />
              <Ctl label="Fondu de boucle" value={s.loopXfade} min={0} max={0.5} step={0.001} dflt={0} fmt={fmtMs} onChange={v => edit({ loopXfade: v })} testId="pad-loop-xfade" />
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
            <Ctl label="Fondu d'entrée" value={reg.fadeIn} min={0} max={0.5} step={0.001} dflt={0} fmt={fmtMs} onChange={v => editRow({ fadeIn: v || undefined })} />
            <Ctl label="Fondu de sortie" value={reg.fadeOut} min={0} max={1} step={0.001} dflt={0} fmt={fmtMs} onChange={v => editRow({ fadeOut: v || undefined })} />
          </div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Niveau</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
            <Ctl label="Gain" value={s.gainDb} min={-48} max={24} step={0.1} dflt={0} fmt={fmtDb} onChange={v => edit({ gainDb: v })} testId="pad-gain"
              hint={`×${fr(dbToGain(s.gainDb), 3)} en amplitude`} />
            <Ctl label="Panoramique" value={row.pan} min={-1} max={1} step={0.01} dflt={0} fmt={v => (Math.abs(v) < 0.005 ? 'centre' : `${v < 0 ? 'G' : 'D'} ${Math.round(Math.abs(v) * 100)} %`)} onChange={v => editRow({ pan: v })} />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Seg label="Polarité" value={s.invert ? 1 : 0} onPick={v => edit({ invert: !!v })} testId="pad-invert" options={[{ label: 'Normale', value: 0 }, { label: 'Inversée (Ø)', value: 1 }]} />
            <Seg label={`Normaliser${normDb !== null ? ` (${fmtDb(normDb)})` : ''}`} value={s.normalize ? 1 : 0} onPick={v => edit({ normalize: !!v })} testId="pad-normalize"
              options={[{ label: 'Non', value: 0 }, { label: 'Crête à 0 dBFS', value: 1 }]} />
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border-2 border-dashed border-white/15 p-2 text-[12px] text-slate-300">
            <i className="fas fa-arrow-down text-cyan-400" aria-hidden />
            <span className="flex-1 min-w-[180px]">Remplacer le son : glisse ici un fichier audio ou un son du navigateur des kits (les réglages du sampler sont gardés).</span>
            <input ref={fileRef} type="file" accept="audio/*,.wav,.mp3,.aif,.aiff,.flac,.ogg,.m4a" className="hidden" onChange={e => { void importInto(e.target.files?.[0], false); e.target.value = ''; }} />
            <button type="button" onClick={() => fileRef.current?.click()} className="min-h-[44px] px-3 rounded-lg bg-white/10 text-white font-bold">Choisir un fichier</button>
          </div>
        </div>
      )}

      {tab === 'env' && (
        <div className="space-y-3" role="tabpanel" aria-label="Enveloppes">
          <EnvGraph smp={row.smp} onEdit={p => edit(p, false)} onRelease={later} />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-2">
            <Ctl label="Attaque" value={s.attack} min={0} max={4} log={false} step={0.0005} dflt={0} fmt={fmtMs} onChange={v => edit({ attack: v })} testId="pad-attack" />
            <Ctl label="Maintien" value={s.hold} min={0} max={4} step={0.0005} dflt={0} fmt={fmtMs} onChange={v => edit({ hold: v })} testId="pad-hold" />
            <Ctl label="Décroissance" value={s.decay} min={0} max={8} step={0.001} dflt={0} fmt={fmtMs} onChange={v => edit({ decay: v })} testId="pad-decay" />
            <Ctl label="Sustain" value={s.sustain} min={0} max={1} step={0.001} dflt={1} fmt={v => `${Math.round(v * 100)} % (${fmtDb(gainToDb(v))})`} onChange={v => edit({ sustain: v })} testId="pad-sustain" />
            <Ctl label="Relâchement (note tenue)" value={s.release} min={0.002} max={8} log step={0.0005} dflt={SAMPLER_DEFAULTS.release} fmt={fmtMs} onChange={v => edit({ release: v })} testId="pad-release"
              hint="Joue quand la note s'arrête (mode « Note tenue » ou boucle, onglet Sample). 2 ms au moins : une coupe franche claque." />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-2">
            <Ctl label="Courbe de l'attaque" value={s.attackCurve} min={0} max={1} step={0.01} dflt={0} fmt={v => (v < 0.01 ? 'droite' : `courbe ${Math.round(v * 100)} %`)} onChange={v => edit({ attackCurve: v })} />
            <Ctl label="Courbe de la décroissance" value={s.decayCurve} min={0} max={1} step={0.01} dflt={1} fmt={v => (v < 0.01 ? 'droite' : `courbe ${Math.round(v * 100)} %`)} onChange={v => edit({ decayCurve: v })} />
            <Ctl label="Courbe du relâchement" value={s.releaseCurve} min={0} max={1} step={0.01} dflt={1} fmt={v => (v < 0.01 ? 'droite' : `courbe ${Math.round(v * 100)} %`)} onChange={v => edit({ releaseCurve: v })} />
          </div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Enveloppe de hauteur <span className="normal-case font-normal">(attaque des kicks et des 808)</span></p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
            <Ctl label="Montant" value={s.pitchEnvAmt} min={-48} max={48} step={1} dflt={0} fmt={fmtSt} onChange={v => edit({ pitchEnvAmt: v })} testId="pad-pitchenv" />
            <Ctl label="Retour en" value={s.pitchEnvDecay} min={0.001} max={4} log step={0.0005} dflt={SAMPLER_DEFAULTS.pitchEnvDecay} fmt={fmtMs} onChange={v => edit({ pitchEnvDecay: v })} disabled={!s.pitchEnvAmt} />
          </div>
        </div>
      )}

      {tab === 'filter' && (
        <div className="space-y-3" role="tabpanel" aria-label="Filtre">
          <div className="flex flex-wrap items-end gap-3">
            <Seg label="Type" value={s.filterType} testId="pad-filter-type" onPick={v => edit({ filterType: v as PadSamplerParams['filterType'] })}
              options={[{ label: 'Aucun', value: 'off' }, { label: 'Passe-bas', value: 'lp' }, { label: 'Passe-haut', value: 'hp' }, { label: 'Passe-bande', value: 'bp' }]} />
            <Seg label="Pente" value={s.filterSlope} testId="pad-filter-slope" onPick={v => edit({ filterSlope: Number(v) as 12 | 24 })}
              options={[{ label: '12 dB/oct', value: 12 }, { label: '24 dB/oct', value: 24 }]} />
          </div>
          <FilterCurve smp={row.smp} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
            <Ctl label={s.filterType === 'bp' ? 'Centre' : 'Coupure (−3 dB)'} value={s.cutoff} min={20} max={20000} log dflt={1000} fmt={fmtHz} onChange={v => edit({ cutoff: Math.round(v * 10) / 10 })} disabled={s.filterType === 'off'} testId="pad-cutoff" />
            <Ctl label="Résonance" value={s.reso} min={0} max={1} step={0.01} dflt={0} fmt={v => `${Math.round(v * 100)} %`} onChange={v => edit({ reso: v })} disabled={s.filterType === 'off'} testId="pad-reso" />
          </div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Enveloppe du filtre</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
            <Ctl label="Montant" value={s.filterEnvAmt} min={-8} max={8} step={0.1} dflt={0} fmt={v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fr(Math.abs(v), 1)} oct.`} onChange={v => edit({ filterEnvAmt: v })} disabled={s.filterType === 'off'} testId="pad-filter-env" />
            <Ctl label="Attaque" value={s.filterAttack} min={0} max={4} step={0.0005} dflt={0} fmt={fmtMs} onChange={v => edit({ filterAttack: v })} disabled={s.filterType === 'off' || !s.filterEnvAmt} />
            <Ctl label="Décroissance" value={s.filterDecay} min={0.001} max={8} log step={0.0005} dflt={SAMPLER_DEFAULTS.filterDecay} fmt={fmtMs} onChange={v => edit({ filterDecay: v })} disabled={s.filterType === 'off' || !s.filterEnvAmt} />
            <Ctl label="Sustain" value={s.filterSustain} min={0} max={1} step={0.01} dflt={0} fmt={v => `${Math.round(v * 100)} %`} onChange={v => edit({ filterSustain: v })} disabled={s.filterType === 'off' || !s.filterEnvAmt} />
          </div>
        </div>
      )}

      {tab === 'pitch' && (
        <div className="space-y-3" role="tabpanel" aria-label="Hauteur">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
            <Ctl label="Accordage" value={row.tune || 0} min={-24} max={24} step={1} dflt={0} fmt={fmtSt} onChange={v => editRow({ tune: v })} testId="pad-tune" />
            <Ctl label="Accordage fin" value={s.cents} min={-100} max={100} step={1} dflt={0} fmt={v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} centièmes`} onChange={v => edit({ cents: v })} testId="pad-cents" />
          </div>
          <p className="text-[12px] text-slate-300 tabular-nums" data-testid="pad-ratio">
            Vitesse de lecture : ×{fr(semisToRatio((row.tune || 0) + s.cents / 100), 4)}{(row.tune || 0) % 12 === 0 && row.tune && !s.cents ? ` (${Math.abs(row.tune) / 12} octave${Math.abs(row.tune) > 12 ? 's' : ''} ${row.tune > 0 ? 'au-dessus' : 'en dessous'})` : ''}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
            <Ctl label="Suivi de la hauteur des pas" value={s.keytrack} min={0} max={1} step={0.01} dflt={1} fmt={v => `${Math.round(v * 100)} %`} onChange={v => edit({ keytrack: v })}
              hint="100 % : un pas réglé à +7 dt joue 7 demi-tons plus haut ; 0 % : la hauteur des pas est ignorée." />
            <Ctl label="Temps de glisse" value={s.glideMs / 1000} min={0} max={2} step={0.001} dflt={SAMPLER_DEFAULTS.glideMs / 1000} fmt={fmtMs} onChange={v => edit({ glideMs: Math.round(v * 1000) })} testId="pad-glide"
              hint="Pas « glisse » (menu du pas) : la hauteur glisse depuis le coup précédent en ce temps-là." />
          </div>
          <Seg label="Quand l'accordage change" value={s.stretch ? 1 : 0} testId="pad-stretch" onPick={v => edit({ stretch: !!v })}
            options={[{ label: 'La durée change (comme une platine)', value: 0 }, { label: 'Garder la durée', value: 1, hint: 'Le son est étiré pour garder sa durée' }]} />
        </div>
      )}

      {tab === 'mod' && (
        <div className="space-y-3" role="tabpanel" aria-label="Modulation">
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Vélocité (force du pas)</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-2">
            <Ctl label="→ Volume" value={s.velToVol} min={0} max={1} step={0.01} dflt={1} fmt={v => `${Math.round(v * 100)} %`} onChange={v => edit({ velToVol: v })} testId="pad-vel-vol"
              hint="100 % : un pas à mi-force joue à mi-volume (−6 dB) ; 0 % : tous les pas au même volume." />
            <Ctl label="→ Coupure du filtre" value={s.filterVel} min={-8} max={8} step={0.1} dflt={0} fmt={v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fr(Math.abs(v), 1)} oct.`} onChange={v => edit({ filterVel: v })} disabled={s.filterType === 'off'} />
            <Ctl label="→ Hauteur" value={s.velToPitch} min={-24} max={24} step={0.1} dflt={0} fmt={v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fr(Math.abs(v), 1)} dt`} onChange={v => edit({ velToPitch: v })} />
          </div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Couches <span className="normal-case font-normal">(plusieurs sons sur le pad)</span></p>
          <div className="space-y-1.5" onDragOver={allowDrop} onDrop={dropLayer} data-testid="pad-layers">
            <Seg label="Le son joué dépend" value={s.layerMode} onPick={v => edit({ layerMode: v as 'vel' | 'rr' })} testId="pad-layer-mode"
              options={[{ label: 'de la vélocité', value: 'vel', hint: 'Du plus doux au plus fort, parts égales' }, { label: 'à tour de rôle', value: 'rr', hint: 'Alternance (round-robin) : chaque coup prend le son suivant' }]} />
            {[{ sound: row.sound, name: 'Son du pad' }, ...(row.smp?.layers || [])].map((l, i, all) => (
              <div key={i} className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-2 min-h-[44px] text-[12px]">
                <span className="w-16 shrink-0 text-slate-400 tabular-nums">{s.layerMode === 'vel' ? `${Math.round((i / all.length) * 127) + (i ? 1 : 0)}–${Math.round(((i + 1) / all.length) * 127)}` : `n° ${i + 1}`}</span>
                <span className="flex-1 min-w-0 truncate text-white">{i === 0 ? `${row.name} (son du pad)` : l.name || soundName(l.sound)}</span>
                {i > 0 && <button type="button" onClick={() => onChange(removePadLayer(latest.current, rowIndex, i - 1))} aria-label={`Retirer la couche ${i + 1}`} className="w-11 h-11 rounded-lg text-red-300 hover:bg-red-500/10"><i className="fas fa-trash" aria-hidden /></button>}
              </div>
            ))}
            <input ref={layerFileRef} type="file" accept="audio/*,.wav,.mp3,.aif,.aiff,.flac,.ogg,.m4a" className="hidden" onChange={e => { void importInto(e.target.files?.[0], true); e.target.value = ''; }} />
            <button type="button" onClick={() => layerFileRef.current?.click()} disabled={(row.smp?.layers?.length || 0) >= 7} data-testid="pad-layer-add"
              className="w-full min-h-[44px] rounded-lg border-2 border-dashed border-white/15 text-[12px] font-bold text-slate-300 hover:border-cyan-400/60 disabled:opacity-40">
              <i className="fas fa-plus mr-1.5" aria-hidden />Ajouter une couche (fichier, ou glisse un son des kits ici)
            </button>
          </div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Caractère</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-2">
            <Ctl label="Saturation douce" value={s.drive} min={0} max={1} step={0.01} dflt={0} fmt={v => (v ? `${Math.round(v * 100)} %` : 'aucune')} onChange={v => edit({ drive: v })} testId="pad-drive" />
            <Ctl label="Résolution" value={s.crushBits || 17} min={2} max={17} step={1} dflt={17} fmt={v => (v >= 17 ? 'intacte' : `${v} bits`)} onChange={v => edit({ crushBits: v >= 17 ? 0 : v })} testId="pad-bits" />
            <Ctl label="Échantillonnage" value={s.crushDown} min={1} max={32} step={1} dflt={1} fmt={v => (v <= 1 ? 'intact' : `${fmtHz((audioEngine.ctx?.sampleRate || 48000) / v)}`)} onChange={v => edit({ crushDown: v })} testId="pad-downsample" />
          </div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Voix</p>
          <div className="flex flex-wrap items-end gap-3">
            <Seg label="Polyphonie" value={s.poly} onPick={v => edit({ poly: v as 'poly' | 'mono' })} testId="pad-poly"
              options={[{ label: 'Poly', value: 'poly', hint: 'Les coups se superposent' }, { label: 'Mono', value: 'mono', hint: 'Chaque coup coupe le précédent du même pad' }]} />
            <Seg label="Groupe d'étouffement" value={row.choke || 0} onPick={v => editRow({ choke: Number(v) || undefined })} testId="pad-choke"
              options={[{ label: 'Aucun', value: 0 }, { label: '1', value: 1, hint: 'Groupe des hi-hats' }, { label: '2', value: 2 }, { label: '3', value: 3 }, { label: '4', value: 4 }]} />
          </div>
        </div>
      )}
      <DrumMenu menu={menu} onClose={() => setMenu(null)} narrow={narrow} />
    </div>
  );
};

const soundName = (ref: string) => (userSampleId(ref) ? 'Ton son' : kitSoundLabel(ref) || libSoundLabel(ref) || ref.replace(/^synth:/, ''));

/** Forme d'onde avec poignées début / fin (et boucle) glissables ; option : caler sur un passage par zéro. */
const WaveEditor: React.FC<{ src: AudioBuffer | null; row: DrumRow; onRegion: (a: number, b: number) => void; onLoop: (a: number, b: number) => void }> = ({ src, row, onRegion, onLoop }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [zero, setZero] = useState(true);
  const drag = useRef<null | 'start' | 'end' | 'ls' | 'le'>(null);
  const reg = regionOf(row);
  const s = smpOf(row.smp);
  const regLen = reg.end - reg.start;
  const ls = reg.start + s.loopStart * regLen, le = reg.start + s.loopEnd * regLen;
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const w = c.clientWidth || 600, h = c.clientHeight || 96;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    if (!src) return;
    const d = src.getChannelData(0);
    const per = Math.max(1, Math.floor(d.length / w));
    g.fillStyle = 'rgba(34,211,238,0.85)';
    for (let x = 0; x < w; x++) {
      let mn = 1, mx = -1;
      const a = x * per;
      for (let i = a; i < Math.min(d.length, a + per); i++) { if (d[i] < mn) mn = d[i]; if (d[i] > mx) mx = d[i]; }
      const y1 = (1 - (mx + 1) / 2) * h, y2 = (1 - (mn + 1) / 2) * h;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }, [src]);
  const toFrac = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const snap = (f: number) => {
    if (!zero || !src) return f;
    const d = src.getChannelData(0);
    return nearestZeroCrossing(d, Math.round(f * d.length), Math.round(src.sampleRate * 0.003)) / d.length;
  };
  const down = (e: React.PointerEvent) => {
    const f = toFrac(e);
    const r = box.current!.getBoundingClientRect();
    const px = (x: number) => Math.abs(x - f) * r.width;
    const cands: [typeof drag.current, number][] = [['start', px(reg.start)], ['end', px(reg.end)]];
    if (s.loop) cands.push(['ls', px(ls)], ['le', px(le)]);
    cands.sort((a, b) => a[1] - b[1]);
    if (cands[0][1] > 28) return;
    drag.current = cands[0][0];
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const k = drag.current;
    if (!k) return;
    const f = snap(toFrac(e));
    if (k === 'start') onRegion(Math.min(f, reg.end - 0.005), reg.end);
    else if (k === 'end') onRegion(reg.start, Math.max(f, reg.start + 0.005));
    else {
      const rel = (f - reg.start) / Math.max(1e-6, regLen);
      if (k === 'ls') onLoop(Math.max(0, Math.min(rel, s.loopEnd - 0.005)), s.loopEnd);
      else onLoop(s.loopStart, Math.min(1, Math.max(rel, s.loopStart + 0.005)));
    }
  };
  const dur = src?.duration || 0;
  const handle = (f: number, color: string, labelTxt: string) => (
    <div className="absolute top-0 bottom-0 pointer-events-none" style={{ left: `${f * 100}%` }}>
      <div className={`absolute -left-px top-0 bottom-0 w-0.5 ${color}`} />
      <div className={`absolute -left-[7px] top-0 w-3.5 h-3.5 rounded-sm ${color}`} />
      <span className="absolute left-1.5 bottom-0.5 text-[9px] font-bold text-white/80 whitespace-nowrap">{labelTxt}</span>
    </div>
  );
  return (
    <div className="space-y-1">
      <div ref={box} className="relative h-24 rounded-xl bg-black/30 overflow-hidden touch-none select-none cursor-ew-resize" data-own-longpress=""
        onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        role="group" aria-label="Forme d'onde : glisse les poignées de début et de fin" data-testid="pad-wave">
        <canvas ref={canvas} className="absolute inset-0 w-full h-full" />
        <div className="absolute inset-y-0 left-0 bg-black/55 pointer-events-none" style={{ width: `${reg.start * 100}%` }} />
        <div className="absolute inset-y-0 right-0 bg-black/55 pointer-events-none" style={{ width: `${(1 - reg.end) * 100}%` }} />
        {s.loop && <div className="absolute inset-y-0 bg-amber-300/15 pointer-events-none" style={{ left: `${ls * 100}%`, width: `${(le - ls) * 100}%` }} />}
        {handle(reg.start, 'bg-emerald-400', 'Début')}
        {handle(reg.end, 'bg-rose-400', 'Fin')}
        {s.loop && handle(ls, 'bg-amber-300', 'Boucle')}
        {s.loop && handle(le, 'bg-amber-300', '')}
        {!src && <span className="absolute inset-0 flex items-center justify-center text-[11px] text-slate-500">Chargement du son…</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400 tabular-nums">
        <span>Début <b className="text-slate-100">{fmtMs(reg.start * dur)}</b></span>
        <span>Fin <b className="text-slate-100">{fmtMs(reg.end * dur)}</b></span>
        <span>Joué <b className="text-slate-100">{fmtMs(regLen * dur)}</b></span>
        <label className="ml-auto flex items-center gap-2 min-h-[44px] cursor-pointer">
          <input type="checkbox" checked={zero} onChange={e => setZero(e.target.checked)} className="w-5 h-5 accent-cyan-400" />
          Caler sur un passage par zéro (sans clic)
        </label>
        {(reg.start > 0 || reg.end < 1) && <button type="button" onClick={() => onRegion(0, 1)} className="min-h-[44px] px-2 text-cyan-300">Tout le son</button>}
      </div>
    </div>
  );
};

/** Enveloppe d'amplitude dessinée ; points glissables (attaque, maintien, décroissance / sustain, relâchement). */
const EnvGraph: React.FC<{ smp: PadSamplerParams | undefined; onEdit: (p: Partial<PadSamplerParams>) => void; onRelease: () => void }> = ({ smp, onEdit, onRelease }) => {
  const s = smpOf(smp);
  const box = useRef<SVGSVGElement>(null);
  const drag = useRef<null | 'a' | 'h' | 'd' | 'r'>(null);
  const W = 600, H = 140, P = 10;
  const noteLen = s.attack + s.hold + s.decay + Math.max(0.15, (s.attack + s.hold + s.decay) * 0.4);
  const total = Math.max(0.3, noteLen + s.release) * 1.1;
  const X = (t: number) => P + (t / total) * (W - 2 * P);
  const Y = (v: number) => H - P - v * (H - 2 * P);
  const segs = ampEnvelope(smp, 1, noteLen);
  const path = useMemo(() => {
    const pts: string[] = [];
    const n = 160;
    for (let i = 0; i <= n; i++) { const t = (i / n) * total; pts.push(`${X(t).toFixed(1)},${Y(envValue(segs, t)).toFixed(1)}`); }
    return `M${pts.join(' L')}`;
  }, [JSON.stringify(segs), total]);
  const pt = { a: [s.attack, 1], h: [s.attack + s.hold, 1], d: [s.attack + s.hold + s.decay, s.sustain], r: [noteLen + s.release, 0] } as const;
  const tAt = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
    return { t: Math.max(0, ((x - P) / (W - 2 * P)) * total), v: Math.max(0, Math.min(1, (H - P - y) / (H - 2 * P))) };
  };
  const round = (t: number) => Math.round(t * 2000) / 2000;
  const down = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const sx = r.width / W;
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    let best: typeof drag.current = null, bd = 1e9;
    (Object.keys(pt) as ('a' | 'h' | 'd' | 'r')[]).forEach(k => { const [t, v] = pt[k]; const dx = X(t) * sx - at.x, dy = Y(v) * (r.height / H) - at.y; const dd = Math.hypot(dx, dy); if (dd < bd) { bd = dd; best = k; } });
    if (bd > 32) return;
    drag.current = best;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const k = drag.current;
    if (!k) return;
    const { t, v } = tAt(e);
    if (k === 'a') onEdit({ attack: round(Math.min(4, t)) });
    else if (k === 'h') onEdit({ hold: round(Math.max(0, Math.min(4, t - s.attack))) });
    else if (k === 'd') onEdit({ decay: round(Math.max(0, Math.min(8, t - s.attack - s.hold))), sustain: Math.round(v * 1000) / 1000 });
    else onEdit({ release: Math.max(0.002, round(Math.min(8, t - noteLen))) });
  };
  const end = () => { if (drag.current) onRelease(); drag.current = null; };
  return (
    <div className="space-y-1">
      <svg ref={box} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-36 rounded-xl bg-black/30 touch-none select-none" data-own-longpress=""
        onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} role="group" aria-label="Enveloppe d'amplitude : glisse les points" data-testid="pad-env-graph">
        <line x1={X(noteLen)} x2={X(noteLen)} y1={P} y2={H - P} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <path d={`${path} L${X(total)},${Y(0)} L${X(0)},${Y(0)} Z`} fill="rgba(34,211,238,0.12)" />
        <path d={path} fill="none" stroke="rgb(34,211,238)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {(Object.keys(pt) as ('a' | 'h' | 'd' | 'r')[]).map(k => (
          <circle key={k} cx={X(pt[k][0])} cy={Y(pt[k][1])} r={7} fill={k === 'r' ? '#fbbf24' : '#fff'} stroke="#000" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <p className="text-[10px] text-slate-500">Points : attaque · fin du maintien · fin de la décroissance (hauteur = sustain) · fin du relâchement (en jaune, après la fin de la note en pointillé).</p>
    </div>
  );
};

/** Réponse du filtre (dB), calculée avec les formules du moteur : la coupure affichée est celle qu'on entend. */
const FilterCurve: React.FC<{ smp: PadSamplerParams | undefined }> = ({ smp }) => {
  const s = smpOf(smp);
  const W = 600, H = 110, SR = 48000;
  const secs = filterSections(s.filterType, s.filterSlope, s.reso);
  const fx = (f: number) => (Math.log(f / 20) / Math.log(20000 / 20)) * W;
  const dbY = (db: number) => H / 2 - (Math.max(-36, Math.min(18, db)) / 54) * H * 0.9 - H * 0.08;
  const pts: string[] = [];
  for (let i = 0; i <= 200; i++) {
    const f = 20 * Math.pow(1000, i / 200);
    const db = secs.reduce((a, sec) => a + sectionGainDb(sec, s.cutoff, f, SR), 0);
    pts.push(`${fx(f).toFixed(1)},${dbY(db).toFixed(1)}`);
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-24 rounded-xl bg-black/30" aria-hidden data-testid="pad-filter-curve">
      {[100, 1000, 10000].map(f => <line key={f} x1={fx(f)} x2={fx(f)} y1={0} y2={H} stroke="rgba(255,255,255,0.08)" vectorEffect="non-scaling-stroke" />)}
      <line x1={0} x2={W} y1={dbY(0)} y2={dbY(0)} stroke="rgba(255,255,255,0.15)" vectorEffect="non-scaling-stroke" />
      <line x1={0} x2={W} y1={dbY(-3.01)} y2={dbY(-3.01)} stroke="rgba(251,191,36,0.25)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      {s.filterType !== 'off' && <line x1={fx(s.cutoff)} x2={fx(s.cutoff)} y1={0} y2={H} stroke="rgba(251,191,36,0.6)" vectorEffect="non-scaling-stroke" />}
      <polyline points={pts.join(' ')} fill="none" stroke="rgb(167,139,250)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

export default PadSamplerEditor;
