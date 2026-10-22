import React, { useMemo, useRef, useState } from 'react';
import type { DrumMachine } from '../utils/drumKits';
import {
  addPattern, barsOf, deletePattern, drumSongEnd, duplicatePattern, ensurePatterns, MAX_PATTERNS, PATTERN_COLORS, recolorPattern,
  renamePattern, sectionsFromMarkers, selectPattern, songBars, songFromSections, type DrumFill,
} from '../utils/drumPatterns';
import { applyRecipe, clearPattern, clipboard, copyPattern, doublePattern, paste, recipeChoices, reroll, reversePattern, rotatePattern, usesProbability } from '../utils/drumEdit';
import { DrumMenu, menuAt, type DrumMenuItem, type DrumMenuState } from './DrumMenu';

interface Props {
  dm: DrumMachine;
  onChange: (dm: DrumMachine) => void;
  bpm: number;
  /** Fin de la boucle du morceau (s). */
  loopEnd: number;
  markers?: { type?: string; name: string; time: number; endTime?: number; color?: string }[];
  /** Mesure en cours de lecture (-1 = arrêt). */
  playBar: number;
  /** Mode simple : onglets des motifs seulement (pas de placement ni de menus). */
  simple?: boolean;
  narrow?: boolean;
  notify?: (msg: string) => void;
}

/**
 * Motifs A, B, C… (comme les Patterns de FL Studio) et leur placement dans le
 * morceau (comme la Playlist de FL) : on peint les mesures avec le motif choisi.
 * Les commandes rares (dupliquer, copier, doubler, décaler, inverser, rythmes publiés…) sont dans « ⋯ ».
 */
// Au doigt : cases de mesure de 40 px (au lieu de 28) pour les toucher ou les peindre sans viser.
const CELL_W = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? 40 : 28;

const DrumPatternBar: React.FC<Props> = ({ dm: raw, onChange, bpm, loopEnd, markers, playBar, simple, narrow, notify }) => {
  const dm = useMemo(() => ensurePatterns(raw), [raw]);
  const patterns = dm.patterns!;
  const active = patterns.find(p => p.id === dm.activePattern) || patterns[0];
  const barSec = 240 / bpm;
  const totalBars = Math.max(4, Math.ceil(drumSongEnd(dm, bpm, loopEnd) / barSec - 0.01));
  const song = songBars(dm, totalBars);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<string[] | null>(null);
  const [menu, setMenu] = useState<DrumMenuState | null>(null);
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

  const startRename = (id: string) => { setRenaming(id); setName(nameOf(id)); };
  const commitRename = () => { if (renaming) onChange(renamePattern(dm, renaming, name)); setRenaming(null); };

  // ── Menu du motif (⋯ ou clic droit sur un onglet) ──
  const latest = useRef(dm);
  latest.current = dm;
  const patternItems = (): DrumMenuItem[] => {
    const b = barsOf(dm.bars);
    return [
      { label: 'Dupliquer le motif', icon: 'fa-clone', kbd: 'Ctrl+D', disabled: patterns.length >= MAX_PATTERNS, onClick: () => onChange(duplicatePattern(dm, active.id)), testId: 'pattern-duplicate' },
      { label: 'Renommer (Couplet, Refrain…)', icon: 'fa-pen', onClick: () => startRename(active.id) },
      { kind: 'node', node: (
        <div role="group" aria-label="Couleur du motif" className="flex flex-wrap gap-1.5 px-1">
          {PATTERN_COLORS.map(c => (
            <button key={c} type="button" onClick={() => { onChange(recolorPattern(dm, active.id, c)); setMenu(null); }} aria-label={`Couleur ${c}`}
              className={`w-11 h-11 rounded-lg border-2 ${active.color === c ? 'border-white' : 'border-transparent'}`} style={{ background: c }} />
          ))}
        </div>
      ) },
      { kind: 'sep' },
      { label: 'Copier le motif', icon: 'fa-copy', kbd: 'Ctrl+C', onClick: () => { copyPattern(dm); notify?.(`Motif ${active.name} copié : choisis un autre motif puis ⋯ › Coller (ou Ctrl+V).`); } },
      { label: 'Coller dans ce motif', icon: 'fa-paste', kbd: 'Ctrl+V', disabled: !clipboard() || clipboard()!.kind !== 'pattern', onClick: () => { const n = paste(dm, 0); if (n) onChange(n); } },
      { label: b >= 8 ? 'Longueur maximale (8 mesures)' : `Doubler la longueur (${b} → ${b * 2} mesures)`, icon: 'fa-up-right-and-down-left-from-center', disabled: b >= 8, onClick: () => onChange(doublePattern(dm)), testId: 'pattern-double' },
      { label: 'Décaler tout le motif vers la gauche', icon: 'fa-arrow-left', kbd: 'Maj+Alt+←', onClick: () => { const n = rotatePattern(latest.current, -1); latest.current = n; onChange(n); }, keepOpen: true },
      { label: 'Décaler tout le motif vers la droite', icon: 'fa-arrow-right', kbd: 'Maj+Alt+→', onClick: () => { const n = rotatePattern(latest.current, 1); latest.current = n; onChange(n); }, keepOpen: true },
      { label: 'Inverser le motif', icon: 'fa-right-left', onClick: () => onChange(reversePattern(dm)) },
      { label: 'Effacer le motif', icon: 'fa-eraser', kbd: 'Maj+Suppr', onClick: () => onChange(clearPattern(dm)) },
      { kind: 'sep' },
      { label: 'Rythmes publiés (recettes sourcées)…', icon: 'fa-book-open', onClick: () => setTimeout(() => setMenu(recipeMenu('new')), 0), testId: 'pattern-recipes' },
      ...(usesProbability(dm) ? [{ label: 'Nouveau tirage des probabilités', icon: 'fa-dice', hint: 'Les pas à probabilité changent ; le même tirage à la lecture et à l\'export.', onClick: () => onChange(reroll(dm)) } as DrumMenuItem] : []),
      { kind: 'sep' },
      { label: 'Supprimer le motif', icon: 'fa-trash', danger: true, disabled: patterns.length <= 1, onClick: () => onChange(deletePattern(dm, active.id)) },
    ];
  };
  const lastAt = useRef({ clientX: 0, clientY: 0 });
  const recipeMenu = (mode: 'new' | 'replace'): DrumMenuState => {
    const items: DrumMenuItem[] = [
      { kind: 'choices', label: 'Poser le rythme dans', value: mode, options: [{ label: 'Nouveau motif', value: 'new' }, { label: `Motif ${active.name}`, value: 'replace' }],
        onPick: v => setMenu(recipeMenu(v as 'new' | 'replace')) },
    ];
    let genre = '';
    for (const c of recipeChoices()) {
      if (c.genre !== genre) { genre = c.genre; items.push({ kind: 'title', label: `${c.emoji} ${c.genreName}` }); }
      items.push({
        label: `${c.name} (${c.bars} mes.)`, hint: `Recette publiée, sources [${c.src.join('] [')}] de RECETTES_BEAT.md`, testId: `recipe-${c.genre}-${c.index}`,
        onClick: () => {
          if (mode === 'new' && patterns.length >= MAX_PATTERNS) { notify?.(`${MAX_PATTERNS} motifs au plus : choisis « Motif ${active.name} ».`); return; }
          const r = applyRecipe(dm, c.genre, c.index, mode);
          onChange(r.dm);
          notify?.(`🥁 Rythme publié « ${c.genreName} : ${c.name} » posé${mode === 'new' ? ' dans un nouveau motif' : ''} (swing ${Math.round(r.dm.swing * 100)} %).${r.missing.length ? ` Pas de pad pour : ${r.missing.join(', ')}.` : ''} Annuler (Ctrl+Z) pour revenir.`);
        },
      });
    }
    return { x: lastAt.current.clientX, y: lastAt.current.clientY, title: 'Rythmes publiés', items };
  };
  const openPatternMenu = (at: { clientX: number; clientY: number }) => { lastAt.current = at; setMenu(menuAt(at, `Motif ${active.name}`, patternItems())); };

  // ── Remplissage (fill) ──
  const fill: DrumFill = dm.fill || { every: 0 };
  const fillEvery = fill.every || 0;
  const setFill = (patch: Partial<DrumFill>) => onChange({ ...dm, fill: { ...fill, ...patch } });
  const fillMenu = (at: { clientX: number; clientY: number }) => setMenu(menuAt(at, 'Remplissage de fin de phrase', [
    { kind: 'choices', label: 'Remplissage automatique (règles publiées)', value: fill.patternId ? '' : fill.style || 'roll', testId: 'fill-style',
      options: [{ label: 'Roulement (1 temps)', value: 'roll', hint: 'Caisse claire en crescendo sur le dernier temps' }, { label: 'Toms + roulement (2 temps)', value: 'toms', hint: '4 doubles de tom puis le roulement' }],
      onPick: v => { setFill({ style: v as DrumFill['style'], patternId: null }); setMenu(null); } },
    { kind: 'choices', label: 'Ou jouer un de tes motifs en fill (sa dernière mesure)', value: fill.patternId || '',
      options: patterns.map(p => ({ label: p.name, value: p.id })), onPick: v => { setFill({ patternId: String(v) }); setMenu(null); } },
    { label: 'Crash sur le 1 après le fill', checked: !!fill.crash, hint: 'Si le kit a une crash : elle remplace le charley sur le 1 à la sortie du fill (leçon de batterie publiée, voir RECETTES.md).', onClick: () => setFill({ crash: !fill.crash }), testId: 'fill-crash' },
  ]));

  const btn = 'nova-hit shrink-0 whitespace-nowrap h-10 px-2.5 rounded-lg text-[11px] font-bold bg-white/5 text-slate-200 hover:bg-white/10 disabled:opacity-40';

  return (
    <div className="space-y-2">
      {/* Banque de motifs */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5" role="tablist" aria-label="Motifs de batterie">
        <span className="shrink-0 text-[11px] font-bold uppercase tracking-wide text-slate-500 mr-0.5"
          title="Motifs de batterie : chaque motif a ses propres pas ; place-les dans le morceau juste en dessous.">Motifs</span>
        {patterns.map(p => (
          renaming === p.id ? (
            <input key={p.id} autoFocus value={name} onChange={e => setName(e.target.value)} onBlur={commitRename}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }}
              aria-label="Nom du motif" maxLength={24}
              className="shrink-0 h-10 w-28 px-2 rounded-lg bg-black/40 border border-cyan-400 text-[12px] font-bold text-white outline-none" />
          ) : (
            <button key={p.id} type="button" role="tab" aria-selected={p.id === active.id}
              onClick={() => (p.id === active.id ? startRename(p.id) : onChange(selectPattern(dm, p.id)))}
              onContextMenu={e => { e.preventDefault(); if (simple) return; const at = { clientX: e.clientX, clientY: e.clientY }; if (p.id !== active.id) onChange(selectPattern(dm, p.id)); setTimeout(() => openPatternMenu(at), 0); }}
              title={p.id === active.id ? 'Motif affiché : touche encore pour le renommer (clic droit : menu du motif)' : `Afficher et modifier le motif ${p.name} ([ / ] : motif précédent / suivant)`}
              className={`nova-hit shrink-0 h-10 min-w-[44px] px-2.5 rounded-lg text-[12px] font-black border-2 transition-colors ${p.id === active.id ? 'text-black' : 'text-white bg-white/5'}`}
              style={p.id === active.id ? { background: p.color, borderColor: p.color } : { borderColor: `${p.color}88` }}>
              {p.name}
            </button>
          )
        ))}
        <button type="button" onClick={() => onChange(addPattern(dm))} disabled={patterns.length >= MAX_PATTERNS}
          title="Nouveau motif vide" className={btn}><i className="fas fa-plus mr-1" />Motif</button>
        {!simple && (
          <button type="button" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); openPatternMenu({ clientX: r.left, clientY: r.bottom + 4 }); }}
            aria-label={`Menu du motif ${active.name}`} aria-haspopup="menu" data-testid="pattern-more"
            title="Dupliquer, copier / coller, doubler, décaler, inverser, effacer, rythmes publiés…" className={`${btn} w-10 px-0`}><i className="fas fa-ellipsis" aria-hidden /></button>
        )}
      </div>

      {/* Placement dans le morceau */}
      {!simple && (
      <div>
        <div className="flex flex-wrap items-center gap-1.5 mb-1">
          <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mr-auto"
            title="Placement : peins les mesures avec le motif choisi (glisse le doigt) ; touche une mesure déjà peinte pour la rendre muette.">
            Dans le morceau <span className="normal-case font-normal text-slate-500">· peins avec « {active.name} »</span>
          </span>
          <button type="button" onClick={() => onChange({ ...dm, song: new Array(totalBars).fill(active.id) })} className={btn}
            title={`Le motif ${active.name} partout dans le morceau`} data-testid="pattern-everywhere">Partout</button>
          {sections.length > 0 && patterns.length > 1 && (
            <button type="button" className={btn}
              title="Suivre la structure du morceau : le motif affiché sur les couplets, le suivant sur les refrains (parties les plus pleines), rien sur l'intro et l'outro"
              onClick={() => {
                const other = patterns.find(p => p.id !== active.id)!;
                onChange(songFromSections(dm, sections, bpm, totalBars, { base: active.id, full: other.id, intro: '' }));
              }}>Suivre la structure</button>
          )}
          <label className="flex items-center gap-1 text-[11px] text-slate-300" title="Fill : variation de fin de phrase, comme un batteur (règles publiées : une phrase fait souvent 4 mesures).">
            Fill
            <select value={fillEvery} onChange={e => setFill({ every: parseInt(e.target.value, 10) as DrumFill['every'] })} data-testid="fill-every"
              className="h-10 rounded-lg bg-white/5 border border-white/10 px-1.5 text-[11px] text-white">
              <option value={0}>non</option>
              <option value={2}>toutes les 2 mesures</option>
              <option value={4}>toutes les 4 mesures</option>
              <option value={8}>toutes les 8 mesures</option>
            </select>
          </label>
          {fillEvery > 0 && (
            <button type="button" className={`${btn} w-10 px-0`} aria-label="Réglages du fill" aria-haspopup="menu" data-testid="fill-more"
              title={`Fill : ${fill.patternId ? `motif ${nameOf(fill.patternId)}` : fill.style === 'toms' ? 'toms + roulement' : 'roulement'}${fill.crash ? ', crash après' : ''}`}
              onClick={e => { const r = e.currentTarget.getBoundingClientRect(); fillMenu({ clientX: r.left, clientY: r.bottom + 4 }); }}>
              <i className="fas fa-ellipsis" aria-hidden />
            </button>
          )}
        </div>
        <div className="overflow-x-auto no-scrollbar">
          <div className="inline-flex flex-col min-w-full select-none">
            {sections.length > 0 && (
              <div className="relative h-4" aria-hidden="true">
                {sections.map((s, i) => {
                  const x = (b: number) => b * (CELL_W + 2) + (Math.floor(b / 4) + 1) * 3;
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
                  className={`relative shrink-0 h-10 [@media(pointer:coarse)]:h-11 mr-[2px] rounded-md flex items-center justify-center text-[11px] font-black cursor-pointer ${b % 4 === 0 ? 'ml-[3px]' : ''} ${playBar === b ? 'ring-2 ring-white' : ''}`}
                  style={{ width: CELL_W, ...(id ? { background: colorOf(id) || '#475569', color: '#000' } : { background: 'rgba(255,255,255,0.04)', color: '#64748b' }) }}>
                  {id ? nameOf(id).slice(0, 3) : '·'}
                  {b % 4 === 0 && <span className="absolute -bottom-0 left-0.5 text-[8px] font-bold text-black/50">{b + 1}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      )}
      <DrumMenu menu={menu} onClose={() => setMenu(null)} narrow={narrow} />
    </div>
  );
};

export default DrumPatternBar;
