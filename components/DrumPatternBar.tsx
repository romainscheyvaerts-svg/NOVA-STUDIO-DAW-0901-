import React, { useMemo, useRef, useState } from 'react';
import type { DrumMachine } from '../utils/drumKits';
import {
  addPattern, deletePattern, drumSongEnd, duplicatePattern, ensurePatterns, MAX_PATTERNS, PATTERN_COLORS, recolorPattern,
  renamePattern, sectionsFromMarkers, selectPattern, songBars, songFromSections,
} from '../utils/drumPatterns';

interface Props {
  dm: DrumMachine;
  onChange: (dm: DrumMachine) => void;
  bpm: number;
  /** Fin de la boucle du morceau (s). */
  loopEnd: number;
  markers?: { type?: string; name: string; time: number; endTime?: number; color?: string }[];
  /** Mesure en cours de lecture (-1 = arrêt). */
  playBar: number;
}

/**
 * Motifs A, B, C… (comme les Patterns de FL Studio) et leur placement dans le
 * morceau (comme la Playlist de FL) : on peint les mesures avec le motif choisi.
 */
const DrumPatternBar: React.FC<Props> = ({ dm: raw, onChange, bpm, loopEnd, markers, playBar }) => {
  const dm = useMemo(() => ensurePatterns(raw), [raw]);
  const patterns = dm.patterns!;
  const active = patterns.find(p => p.id === dm.activePattern) || patterns[0];
  const barSec = 240 / bpm;
  const totalBars = Math.max(4, Math.ceil(drumSongEnd(dm, bpm, loopEnd) / barSec - 0.01));
  const song = songBars(dm, totalBars);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [colors, setColors] = useState(false);
  const [draft, setDraft] = useState<string[] | null>(null);
  const brush = useRef<string>('');
  const shown = draft || song;
  const sections = useMemo(() => sectionsFromMarkers(markers || []), [markers]);
  const colorOf = (id: string) => patterns.find(p => p.id === id)?.color;
  const nameOf = (id: string) => patterns.find(p => p.id === id)?.name || '';

  const barAt = (e: React.PointerEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const b = el?.closest('[data-bar]')?.getAttribute('data-bar');
    return b == null ? -1 : parseInt(b, 10);
  };
  const paint = (b: number, base: string[]) => {
    if (b < 0 || b >= base.length || base[b] === brush.current) return base;
    const next = [...base]; next[b] = brush.current; return next;
  };
  const down = (e: React.PointerEvent) => {
    const b = barAt(e);
    if (b < 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    // Tap sur une mesure du motif choisi = silence ; sinon on peint le motif choisi.
    brush.current = song[b] === active.id ? '' : active.id;
    setDraft(paint(b, song));
  };
  const move = (e: React.PointerEvent) => { if (draft) setDraft(paint(barAt(e), draft)); };
  const up = () => {
    if (draft) onChange({ ...dm, song: draft });
    setDraft(null);
  };

  const startRename = (id: string) => { setRenaming(id); setName(nameOf(id)); setColors(false); };
  const commitRename = () => { if (renaming) onChange(renamePattern(dm, renaming, name)); setRenaming(null); };

  const fillEvery = dm.fill?.every || 0;
  const btn = 'nova-hit shrink-0 whitespace-nowrap h-9 px-2.5 rounded-lg text-[11px] font-bold bg-white/5 text-slate-200 hover:bg-white/10 disabled:opacity-40';

  return (
    <div className="space-y-2">
      {/* Banque de motifs */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5" role="tablist" aria-label="Motifs de batterie">
        <span className="shrink-0 text-[11px] font-bold uppercase tracking-wide text-slate-500 mr-0.5"
          title="Motifs de batterie : comme les Patterns de FL Studio. Chaque motif a ses propres pas ; place-les dans le morceau juste en dessous.">Motifs</span>
        {patterns.map(p => (
          renaming === p.id ? (
            <input key={p.id} autoFocus value={name} onChange={e => setName(e.target.value)} onBlur={commitRename}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }}
              aria-label="Nom du motif" maxLength={24}
              className="shrink-0 h-9 w-28 px-2 rounded-lg bg-black/40 border border-cyan-400 text-[12px] font-bold text-white outline-none" />
          ) : (
            <button key={p.id} type="button" role="tab" aria-selected={p.id === active.id}
              onClick={() => (p.id === active.id ? startRename(p.id) : onChange(selectPattern(dm, p.id)))}
              title={p.id === active.id ? 'Motif affiché : touche encore pour le renommer' : `Afficher et modifier le motif ${p.name}`}
              className={`nova-hit shrink-0 h-9 min-w-[40px] px-2.5 rounded-lg text-[12px] font-black border-2 transition-colors ${p.id === active.id ? 'text-black' : 'text-white bg-white/5'}`}
              style={p.id === active.id ? { background: p.color, borderColor: p.color } : { borderColor: `${p.color}88` }}>
              {p.name}
            </button>
          )
        ))}
        <button type="button" onClick={() => onChange(addPattern(dm))} disabled={patterns.length >= MAX_PATTERNS}
          title="Nouveau motif vide (comme « New pattern » dans FL Studio)" className={btn}><i className="fas fa-plus mr-1" />Motif</button>
        <button type="button" onClick={() => onChange(duplicatePattern(dm, active.id))} disabled={patterns.length >= MAX_PATTERNS}
          title="Dupliquer le motif affiché pour en faire une variante (comme « Clone pattern » dans FL Studio)" className={btn}><i className="far fa-clone mr-1" />Dupliquer</button>
        <button type="button" onClick={() => startRename(active.id)} title="Renommer le motif (Couplet, Refrain…)" aria-label="Renommer le motif" className={btn}><i className="fas fa-pen" /></button>
        <button type="button" onClick={() => setColors(v => !v)} aria-expanded={colors} title="Couleur du motif" aria-label="Couleur du motif" className={btn}><i className="fas fa-palette" /></button>
        <button type="button" onClick={() => onChange(deletePattern(dm, active.id))} disabled={patterns.length <= 1}
          title="Supprimer le motif affiché (ses mesures passent au premier motif ; Annuler pour revenir)" aria-label="Supprimer le motif" className={btn}><i className="fas fa-trash" /></button>
      </div>
      {colors && (
        <div className="flex gap-1.5" role="group" aria-label="Couleurs">
          {PATTERN_COLORS.map(c => (
            <button key={c} type="button" onClick={() => { onChange(recolorPattern(dm, active.id, c)); setColors(false); }} aria-label={`Couleur ${c}`}
              className={`nova-hit w-9 h-9 rounded-lg border-2 ${active.color === c ? 'border-white' : 'border-transparent'}`} style={{ background: c }} />
          ))}
        </div>
      )}

      {/* Placement dans le morceau */}
      <div>
        <div className="flex flex-wrap items-center gap-1.5 mb-1">
          <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mr-auto"
            title="Placement : comme la Playlist de FL Studio. Peins les mesures avec le motif choisi (glisse le doigt) ; touche une mesure déjà peinte pour la rendre muette.">
            Dans le morceau <span className="normal-case font-normal text-slate-500">· peins avec « {active.name} »</span>
          </span>
          <button type="button" onClick={() => onChange({ ...dm, song: new Array(totalBars).fill(active.id) })} className={btn}
            title={`Le motif ${active.name} partout dans le morceau`}>Partout</button>
          {sections.length > 0 && patterns.length > 1 && (
            <button type="button" className={btn}
              title="Suivre la structure du morceau : le motif affiché sur les couplets, le suivant sur les refrains (parties les plus pleines), rien sur l'intro et l'outro"
              onClick={() => {
                const other = patterns.find(p => p.id !== active.id)!;
                onChange(songFromSections(dm, sections, bpm, totalBars, { base: active.id, full: other.id, intro: '' }));
              }}>Suivre la structure</button>
          )}
          <label className="flex items-center gap-1 text-[11px] text-slate-300" title="Fill : variation automatique à la fin de chaque phrase (roulement de caisse claire), comme un batteur. Ou un motif « fill » à toi.">
            Fill
            <select value={fillEvery} onChange={e => onChange({ ...dm, fill: { ...(dm.fill || {}), every: parseInt(e.target.value, 10) as 0 | 4 | 8 } })}
              className="h-9 rounded-lg bg-white/5 border border-white/10 px-1.5 text-[11px] text-white">
              <option value={0}>non</option>
              <option value={4}>toutes les 4 mesures</option>
              <option value={8}>toutes les 8 mesures</option>
            </select>
            {fillEvery > 0 && (
              <select value={dm.fill?.patternId || ''} onChange={e => onChange({ ...dm, fill: { every: fillEvery as 4 | 8, patternId: e.target.value || null } })}
                aria-label="Motif joué en fill" className="h-9 rounded-lg bg-white/5 border border-white/10 px-1.5 text-[11px] text-white">
                <option value="">auto (roulement)</option>
                {patterns.map(p => <option key={p.id} value={p.id}>motif {p.name}</option>)}
              </select>
            )}
          </label>
        </div>
        <div className="overflow-x-auto no-scrollbar">
          <div className="inline-flex flex-col min-w-full select-none">
            {sections.length > 0 && (
              <div className="relative h-4" aria-hidden="true">
                {sections.map((s, i) => {
                  const x = (b: number) => b * 30 + (Math.floor(b / 4) + 1) * 3;
                  const a = Math.round(s.start / barSec), z = Math.max(a + 1, Math.round(s.end / barSec));
                  return (
                    <span key={i} className="absolute top-0 text-[9px] font-bold text-slate-400 truncate border-l border-white/20 pl-0.5"
                      style={{ left: x(a), width: x(z) - x(a) }}>{s.name}</span>
                  );
                })}
              </div>
            )}
            <div className="flex touch-none" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
              role="group" aria-label="Motif de chaque mesure">
              {shown.map((id, b) => (
                <div key={b} data-bar={b} role="button" tabIndex={0}
                  aria-label={`Mesure ${b + 1} : ${id ? `motif ${nameOf(id)}` : 'silence'}`}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); const next = [...song]; next[b] = song[b] === active.id ? '' : active.id; onChange({ ...dm, song: next }); } }}
                  className={`relative shrink-0 w-[28px] h-10 mr-[2px] rounded-md flex items-center justify-center text-[11px] font-black cursor-pointer ${b % 4 === 0 ? 'ml-[3px]' : ''} ${playBar === b ? 'ring-2 ring-white' : ''}`}
                  style={id ? { background: colorOf(id) || '#475569', color: '#000' } : { background: 'rgba(255,255,255,0.04)', color: '#64748b' }}>
                  {id ? nameOf(id).slice(0, 3) : '·'}
                  {b % 4 === 0 && <span className="absolute -bottom-0 left-0.5 text-[8px] font-bold text-black/50">{b + 1}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DrumPatternBar;
