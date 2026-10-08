import React, { useEffect, useRef, useState } from 'react';
import type { DrumMachine, DrumRow } from '../utils/drumKits';
import { rowStepsPerBar, setRowLength, setRowRate, setStepParam, StepParam, StepRate, STEP_RATES, STEPS_PER_BAR } from '../utils/drumPatterns';
import { padSampleKey } from '../utils/drumSamples';
import { audioBufferRegistry } from '../utils/audioBufferRegistry';
import { applyKit, deleteKit, getKit, kitFromDrumMachine, kitFromFile, KIT_EXT, kitToFile, listKits, onKitsChange, renameKit, saveKit, UserKit } from '../utils/userKits';
import { wavOf } from '../services/AudioUtils';
import { audioEngine } from '../engine/AudioEngine';
import { saveBlob } from '../utils/saveBlob';

/**
 * R18 · Outils de la boîte à rythmes façon FL Studio :
 *  - KitBar : kits perso (enregistrer, charger dans un autre projet, renommer,
 *    supprimer, exporter / importer en .novakit avec les sons) ;
 *  - StepGraph : éditeur de graphe sous la grille (vélocité, pan, hauteur par pas) ;
 *  - RowTiming : résolution (1/16, 1/32, triolets), longueur et swing de la rangée.
 */

// ===== Kits perso =====

export const KitBar: React.FC<{
  dm: DrumMachine | null;
  onChange: (dm: DrumMachine) => void;
  ensureEngine?: () => Promise<unknown>;
  notify?: (msg: string) => void;
  narrow?: boolean;
}> = ({ dm, onChange, ensureEngine, notify, narrow }) => {
  const [kits, setKits] = useState<UserKit[]>([]);
  const [naming, setNaming] = useState<null | { mode: 'save' } | { mode: 'rename'; id: string }>(null);
  const [name, setName] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    const load = () => { void listKits().then(k => { if (live) setKits(k); }); };
    load();
    const off = onKitsChange(load);
    return () => { live = false; off(); };
  }, []);

  const save = async (n: string) => {
    if (!dm) return;
    setBusy(true);
    try {
      // Son des samples perso : écrit en WAV dans le kit (il voyage avec lui).
      const wavs = new Map<string, ArrayBuffer>();
      for (const id of Object.keys(dm.samples || {})) {
        const b = audioBufferRegistry.get(padSampleKey(id));
        if (b) wavs.set(id, await wavOf(b).arrayBuffer());
      }
      const k = kitFromDrumMachine(dm, n, id => wavs.get(id));
      await saveKit(k);
      notify?.(`💾 Kit « ${k.name} » enregistré sur cet appareil : charge-le dans n’importe quel projet (Mes kits).`);
    } catch { notify?.('Kit non enregistré (stockage du navigateur plein ou bloqué ?).'); }
    finally { setBusy(false); }
  };

  const load = async (id: string) => {
    setBusy(true);
    try {
      await ensureEngine?.();
      const k = await getKit(id);
      if (!k) return;
      const ctx = audioEngine.ctx;
      for (const [sid, s] of Object.entries(k.samples)) {
        if (audioBufferRegistry.has(padSampleKey(sid)) || !s.wav || !ctx) continue;
        try { audioBufferRegistry.register(await ctx.decodeAudioData(s.wav.slice(0)), padSampleKey(sid)); } catch { /* son illisible : pad muet */ }
      }
      onChange(applyKit(dm, k));
      notify?.(`🥁 Kit « ${k.name} » chargé : tes pas sont gardés sur les pads de même nom. Annuler (Ctrl+Z) pour revenir.`);
    } finally { setBusy(false); setMenu(null); }
  };

  const exportKit = async (id: string) => {
    const k = await getKit(id);
    if (!k) return;
    await saveBlob(await kitToFile(k), `${k.name}${KIT_EXT}`);
    setMenu(null);
  };

  const importKit = async (f: File) => {
    try {
      const k = await kitFromFile(await f.arrayBuffer());
      await saveKit(k);
      notify?.(`📥 Kit « ${k.name} » importé (${k.pads.length} pads) : touche-le pour le charger.`);
    } catch (e) { notify?.(e instanceof Error ? e.message : 'Kit illisible.'); }
  };

  const confirmName = async () => {
    const n = name.trim();
    if (!naming || !n) { setNaming(null); return; }
    if (naming.mode === 'save') await save(n); else await renameKit(naming.id, n);
    setNaming(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="kit-bar">
      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mr-1" title="Kits perso : les sons et réglages de tes pads, réutilisables d'un projet à l'autre (preset de Drum Rack dans Live, kit du Channel Rack dans FL)">Mes kits</span>
      {naming ? (
        <form className="flex items-center gap-1" onSubmit={e => { e.preventDefault(); void confirmName(); }}>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={40} aria-label="Nom du kit" data-testid="kit-name"
            className="h-10 w-40 rounded-lg bg-white/5 border border-white/15 px-2 text-[12px] text-white" placeholder="Nom du kit" />
          <button type="submit" className="h-10 px-3 rounded-lg bg-cyan-500 text-black text-[12px] font-black" data-testid="kit-name-ok">OK</button>
          <button type="button" onClick={() => setNaming(null)} className="h-10 px-2 rounded-lg bg-white/5 text-slate-300 text-[12px]">Annuler</button>
        </form>
      ) : (
        <button type="button" disabled={!dm || busy} onClick={() => { setName(`Kit ${new Date().toLocaleDateString('fr-FR')}`); setNaming({ mode: 'save' }); }}
          data-testid="kit-save" title="Enregistrer les sons et réglages des pads comme kit perso (sur cet appareil)"
          className="nova-hit h-10 px-3 rounded-lg bg-white/[0.06] text-slate-200 text-[12px] font-bold hover:bg-white/10 disabled:opacity-40">
          <i className="fas fa-floppy-disk mr-1.5 text-cyan-400" />{narrow ? 'Kit' : 'Enregistrer le kit'}
        </button>
      )}
      {kits.map(k => (
        <div key={k.id} className="relative">
          <div className="flex rounded-lg overflow-hidden border border-white/10">
            <button type="button" onClick={() => void load(k.id)} disabled={busy} data-testid={`kit-load-${k.name}`}
              title={`Charger « ${k.name} » (${k.pads.length} pads) dans ce projet`}
              className="nova-hit h-10 px-3 bg-white/[0.04] text-white text-[12px] font-bold hover:bg-white/10 max-w-[160px] truncate">🎒 {k.name}</button>
            <button type="button" onClick={() => setMenu(menu === k.id ? null : k.id)} aria-label={`Options du kit ${k.name}`} aria-expanded={menu === k.id}
              className="nova-hit w-8 h-10 bg-white/[0.04] text-slate-400 hover:text-white border-l border-white/10"><i className="fas fa-ellipsis-vertical" /></button>
          </div>
          {menu === k.id && (
            <div className="absolute z-20 top-11 left-0 w-44 rounded-xl border border-white/15 bg-nv-raised shadow-2xl p-1 flex flex-col" role="menu">
              <button type="button" role="menuitem" onClick={() => { setName(k.name); setNaming({ mode: 'rename', id: k.id }); setMenu(null); }} className="h-10 px-3 text-left text-[12px] text-nv-ink rounded-lg hover:bg-white/10"><i className="fas fa-pen mr-2" />Renommer</button>
              <button type="button" role="menuitem" onClick={() => void exportKit(k.id)} className="h-10 px-3 text-left text-[12px] text-nv-ink rounded-lg hover:bg-white/10"><i className="fas fa-file-export mr-2" />Exporter ({KIT_EXT})</button>
              <button type="button" role="menuitem" onClick={() => { void deleteKit(k.id); setMenu(null); notify?.(`Kit « ${k.name} » supprimé de cet appareil.`); }} className="h-10 px-3 text-left text-[12px] text-red-400 rounded-lg hover:bg-red-500/10"><i className="fas fa-trash mr-2" />Supprimer</button>
            </div>
          )}
        </div>
      ))}
      <input ref={fileRef} type="file" accept={`${KIT_EXT},application/zip`} className="hidden" data-testid="kit-import-input"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importKit(f); }} />
      <button type="button" onClick={() => fileRef.current?.click()} title={`Importer un kit (${KIT_EXT}) reçu d'un autre beatmaker`}
        className="nova-hit h-10 px-3 rounded-lg bg-white/[0.04] text-slate-300 text-[12px] font-bold hover:text-white"><i className="fas fa-file-import mr-1" />{narrow ? '' : 'Importer'}</button>
    </div>
  );
};

// ===== Éditeur de graphe (FL : Graph Editor) =====

const PARAMS: { id: StepParam; label: string; hint: string }[] = [
  { id: 'vel', label: 'Vélocité', hint: 'Force de chaque pas (Graph Editor de FL Studio, Velocity dans Live)' },
  { id: 'pan', label: 'Pan', hint: 'Panoramique de chaque pas, ajouté à celui du pad (Pan du Graph Editor de FL)' },
  { id: 'pitch', label: 'Hauteur', hint: 'Hauteur de chaque pas en demi-tons, ajoutée à l’accordage du pad (Pitch du Graph Editor de FL)' },
];

export const StepGraph: React.FC<{
  dm: DrumMachine;
  rowIndex: number;
  /** Pas affichés (index dans la rangée) et largeur d'un pas 1/16 (px, 0 = flexible). */
  cells: number[];
  onChange: (dm: DrumMachine) => void;
  playStep?: number;
}> = ({ dm, rowIndex, cells, onChange, playStep }) => {
  const [param, setParam] = useState<StepParam>('vel');
  const row = dm.rows[rowIndex];
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const latest = useRef(dm); latest.current = dm;
  if (!row) return null;
  const valueOf = (i: number) => (param === 'vel' ? row.steps[i] || 0 : param === 'pan' ? row.stepPan?.[i] || 0 : row.stepPitch?.[i] || 0);
  const setAt = (e: React.PointerEvent) => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const k = Math.floor(((e.clientX - r.left) / r.width) * cells.length);
    const i = cells[Math.max(0, Math.min(cells.length - 1, k))];
    const y = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    const v = param === 'vel' ? 1 + y * 126 : param === 'pan' ? y * 2 - 1 : Math.round(y * 24 - 12);
    const next = setStepParam(latest.current, rowIndex, i, param, v);
    if (next !== latest.current) { latest.current = next; onChange(next); }
  };
  const fmt = (v: number) => (param === 'vel' ? String(Math.round(v)) : param === 'pan' ? (Math.abs(v) < 0.02 ? 'C' : `${v < 0 ? 'G' : 'D'}${Math.round(Math.abs(v) * 100)}`) : `${v > 0 ? '+' : ''}${v}`);
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-2" data-testid="step-graph">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[11px] font-bold text-slate-400 mr-1 truncate">Graphe · {row.name}</span>
        <div className="flex rounded-lg overflow-hidden border border-white/10 ml-auto" role="group" aria-label="Paramètre du graphe">
          {PARAMS.map(p => (
            <button key={p.id} type="button" onClick={() => setParam(p.id)} aria-pressed={param === p.id} title={p.hint} data-testid={`graph-${p.id}`}
              className={`h-9 px-2.5 text-[11px] font-bold ${param === p.id ? 'bg-violet-400 text-black' : 'bg-white/5 text-slate-300'}`}>{p.label}</button>
          ))}
        </div>
      </div>
      <div ref={box} className="relative h-20 flex gap-0.5 touch-none select-none cursor-ns-resize" data-own-longpress=""
        onPointerDown={e => { dragging.current = true; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); setAt(e); }}
        onPointerMove={e => { if (dragging.current) setAt(e); }}
        onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}
        role="slider" aria-label={`${PARAMS.find(p => p.id === param)?.label} par pas de ${row.name}`} aria-valuemin={param === 'vel' ? 1 : param === 'pan' ? -1 : -12} aria-valuemax={param === 'vel' ? 127 : param === 'pan' ? 1 : 12}>
        {param !== 'vel' && <div className="absolute inset-x-0 top-1/2 h-px bg-white/15 pointer-events-none" />}
        {cells.map(i => {
          const on = (row.steps[i] || 0) > 0;
          const v = valueOf(i);
          const h = param === 'vel' ? (v / 127) * 100 : param === 'pan' ? Math.abs(v) * 50 : (Math.abs(v) / 12) * 50;
          const top = param === 'vel' ? 100 - h : v >= 0 ? 50 - h : 50;
          return (
            <div key={i} className={`relative flex-1 rounded-sm ${playStep === i ? 'bg-white/10' : 'bg-white/[0.03]'}`} title={on ? `Pas ${i + 1} : ${fmt(v)}` : `Pas ${i + 1} éteint`}>
              {on && <div className={`absolute inset-x-0 rounded-sm ${param === 'vel' ? 'bg-cyan-400' : param === 'pan' ? 'bg-amber-400' : 'bg-violet-400'}`} style={{ top: `${top}%`, height: `${Math.max(2, h)}%` }} />}
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-[10px] text-slate-500">Glisse sur les barres pour régler chaque pas allumé (comme le Graph Editor de FL Studio).</p>
    </div>
  );
};

// ===== Rangée : résolution, longueur, swing =====

export const RowTiming: React.FC<{ dm: DrumMachine; rowIndex: number; onChange: (dm: DrumMachine) => void }> = ({ dm, rowIndex, onChange }) => {
  const row = dm.rows[rowIndex];
  if (!row) return null;
  const spb = rowStepsPerBar(row);
  const full = spb * (dm.bars || 1);
  const len = row.len && row.len > 0 ? row.len : full;
  const edit = (patch: Partial<DrumRow>) => onChange({ ...dm, rows: dm.rows.map((r, i) => (i === rowIndex ? { ...r, ...patch } : r)) });
  return (
    <div className="space-y-2" data-testid="row-timing">
      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Rangée</p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg overflow-hidden border border-white/10" role="group" aria-label="Résolution de la rangée">
          {STEP_RATES.map(r => (
            <button key={r.id} type="button" onClick={() => onChange(setRowRate(dm, rowIndex, r.id as StepRate))} aria-pressed={(row.rate || '16') === r.id} title={r.hint}
              data-testid={`row-rate-${r.id}`}
              className={`h-10 px-2.5 text-[12px] font-bold ${(row.rate || '16') === r.id ? 'bg-white text-black' : 'bg-white/5 text-white'}`}>{r.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-1" title="Longueur de la rangée en pas : plus courte que le motif, elle boucle toute seule (polymétrie, comme les longueurs de rangée de Bitwig ou de la Drum Machine de Logic)">
          <span className="text-[12px] text-slate-400">Longueur</span>
          <button type="button" onClick={() => onChange(setRowLength(dm, rowIndex, Math.max(1, len - 1)))} aria-label="Raccourcir la rangée d'un pas" className="nova-hit w-9 h-10 rounded-lg bg-white/10 text-white">−</button>
          <span className="min-w-[44px] text-center text-[12px] font-black text-white tabular-nums" data-testid="row-len">{len}</span>
          <button type="button" onClick={() => onChange(setRowLength(dm, rowIndex, Math.min(full, len + 1)))} aria-label="Allonger la rangée d'un pas" className="nova-hit w-9 h-10 rounded-lg bg-white/10 text-white">+</button>
          {row.len ? <button type="button" onClick={() => onChange(setRowLength(dm, rowIndex, 0))} className="h-10 px-2 text-[11px] text-cyan-300">tout le motif</button> : null}
        </div>
        <label className="flex items-center gap-2 text-[12px] text-slate-400" title="Swing de cette rangée seulement (le reste garde le swing global), comme le swing par canal de FL Studio">
          Swing
          <input type="range" min={-0.05} max={0.6} step={0.05} value={typeof row.swing === 'number' ? row.swing : -0.05}
            onChange={e => { const v = parseFloat(e.target.value); edit({ swing: v < 0 ? undefined : v }); }} className="w-24 accent-cyan-400" aria-label="Swing de la rangée" />
          <span className="w-14 tabular-nums text-white">{typeof row.swing === 'number' ? `${Math.round(row.swing * 100)} %` : 'global'}</span>
        </label>
      </div>
    </div>
  );
};

/** Pas d'une rangée à afficher : tout le motif (ordinateur) ou une demi-mesure (téléphone, page 0, 1…). */
export function rowCells(row: DrumRow, bars: number, page: number | null): { cells: number[]; usable: number } {
  const spb = rowStepsPerBar(row);
  const usable = row.len && row.len > 0 ? Math.min(row.len, spb * 4) : spb * bars;
  if (page === null) return { cells: Array.from({ length: spb * bars }, (_, i) => i), usable };
  const per = (8 * spb) / STEPS_PER_BAR;
  return { cells: Array.from({ length: per }, (_, i) => page * per + i), usable };
}
