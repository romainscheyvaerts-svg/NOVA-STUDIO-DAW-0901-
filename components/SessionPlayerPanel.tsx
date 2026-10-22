import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Track } from '../types';
import { genreRecipe, type BeatGenreId } from '../utils/beatRecipes';
import { tempoMapStore, timeToPosition } from '../utils/tempoMap';
import {
  SEANCE_ROLES, SEANCE_STYLES, fillEvery, roleInfo, sanitizeSeance, seanceClipsOf,
  type SeanceCreateOptions, type SeanceRole, type SeanceSettings,
} from '../utils/sessionPlayer';

interface Props {
  /** Piste du musicien (réglages), null : ajouter un musicien. */
  track: Track | null;
  /** Région à mettre en avant (clic droit sur une région). */
  focusClipId?: string;
  chordCount: number;
  sectionCount: number;
  defaultStyle: BeatGenreId;
  onCreate: (o: SeanceCreateOptions) => Promise<boolean>;
  onChange: (clipIds: string[] | null, patch: Partial<SeanceSettings>) => void;
  onFreeze: (clipIds: string[] | null) => void;
  onSplitSections: () => void;
  onOpenNotes: (clipId: string) => void;
  onClose: () => void;
}

const MOTIFS = ['A', 'B', 'C'];
const intensityWord = (v: number) => (v <= 3 ? 'doux' : v <= 6 ? 'moyen' : v <= 8 ? 'fort' : 'très fort');
const complexityWord = (v: number) => (v <= 2 ? 'ossature' : v <= 4 ? 'simple' : v === 5 ? 'la recette' : v <= 7 ? 'riche' : 'chargé');
const fillsWord = (v: number) => (v === 0 ? 'aucun' : fillEvery(v) === 0 ? 'en fin de région' : `toutes les ${fillEvery(v)} mesures`);

/**
 * L3 · Écart 16 — Musiciens de séance (utils/sessionPlayer) : ajouter un batteur, un
 * bassiste ou des claviers qui suivent les accords, puis régler chaque région (une par
 * section) : intensité, complexité, remplissages. « Figer en notes MIDI » pour éditer.
 */
const SessionPlayerPanel: React.FC<Props> = p => {
  const { track } = p;
  const regions = useMemo(() => seanceClipsOf(track), [track]);
  const first = regions[0]?.seance ? sanitizeSeance(regions[0].seance) : null;
  const [role, setRole] = useState<SeanceRole>('drums');
  const [style, setStyle] = useState<BeatGenreId>(p.defaultStyle);
  const [pattern, setPattern] = useState(0);
  const [bySection, setBySection] = useState(true);
  const [busy, setBusy] = useState(false);
  const focusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); p.onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [p.onClose]);
  useEffect(() => { focusRef.current?.scrollIntoView({ block: 'nearest' }); }, [p.focusClipId]);

  const chip = (on: boolean) => `nova-hit min-h-9 px-2.5 rounded-lg border text-[12px] font-bold ${on ? 'bg-amber-400 text-black border-amber-300' : 'border-nv-line/15 text-nv-ink hover:bg-nv-raised'}`;
  const lbl = 'text-[11px] font-bold text-nv-muted block mb-1';
  const needChords = role !== 'drums' && p.chordCount === 0;
  const editing = !!track && regions.length > 0 && !!first;
  const info = roleInfo(editing ? first!.role : role);
  const map = tempoMapStore.get();
  const barOf = (t: number) => timeToPosition(map, t + 1e-6).bar + 1;

  const create = async () => {
    if (busy || needChords) return;
    setBusy(true);
    try { await p.onCreate({ role, style, pattern, bySection: bySection && p.sectionCount > 0 }); } finally { setBusy(false); }
  };

  const styleRow = (cur: BeatGenreId | null, pick: (s: BeatGenreId) => void) => (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Style">
      {SEANCE_STYLES.map(s => (
        <button key={s.id} type="button" role="radio" aria-checked={cur === s.id} title={s.hint} data-testid={`seance-style-${s.id}`} onClick={() => pick(s.id)} className={chip(cur === s.id)}>
          <span aria-hidden="true">{s.emoji}</span> {s.name}
        </button>
      ))}
    </div>
  );
  const motifRow = (cur: number | null, pick: (m: number) => void, st: BeatGenreId) => (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Motif">
      {MOTIFS.map((m, i) => {
        const g = genreRecipe(st);
        const hint = info.id === 'drums' ? g.drums[i % g.drums.length]?.name : info.id === 'bass' ? 'rythme de basse publié du genre' : 'rythme d’accompagnement';
        return <button key={m} type="button" role="radio" aria-checked={cur === i} title={hint} data-testid={`seance-motif-${m}`} onClick={() => pick(i)} className={chip(cur === i)}>Motif {m}</button>;
      })}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[1250] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onMouseDown={p.onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="seance-title" data-testid="seance-panel" onMouseDown={e => e.stopPropagation()}
        className="w-full sm:max-w-xl max-h-[92dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-nv-line/15 bg-nv-surface text-nv-ink shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-nv-line/15">
          <div className="min-w-0">
            <h2 id="seance-title" className="text-[14px] font-black uppercase tracking-widest truncate">
              {editing ? `${info.emoji} ${info.label}${track!.name.toUpperCase().startsWith(info.track) ? '' : ` · ${track!.name}`}` : 'Musiciens de séance'}
            </h2>
            <p className="text-[12px] text-nv-muted">
              {editing
                ? (info.id === 'drums' ? 'Joue sur la grille du morceau, tempo et rampes compris.' : 'Suit ta piste d’accords : s’ils changent, il rejoue tout seul.')
                : 'Un musicien qui joue tout seul, calé sur tes accords et sur la grille. Règles de genre publiées, aucune IA ; le résultat reste du MIDI modifiable.'}
            </p>
          </div>
          <button type="button" onClick={p.onClose} aria-label="Fermer" title="Fermer (Échap)" className="nova-hit w-9 h-9 rounded-full text-nv-muted hover:text-nv-ink flex items-center justify-center shrink-0"><i className="fas fa-times" aria-hidden="true"></i></button>
        </div>

        {!editing && (
          <div className="p-5 space-y-4" data-testid="seance-create">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Musicien">
              {SEANCE_ROLES.map(r => (
                <button key={r.id} type="button" role="radio" aria-checked={role === r.id} data-testid={`seance-role-${r.id}`} onClick={() => setRole(r.id)}
                  className={`nova-hit text-left rounded-2xl border p-3 ${role === r.id ? 'border-amber-400 bg-amber-400/10' : 'border-nv-line/15 hover:bg-nv-raised'}`}>
                  <span className="block text-[20px]" aria-hidden="true">{r.emoji}</span>
                  <span className="block font-black text-[13px]">{r.label}</span>
                  <span className="block text-[11px] text-nv-muted">{r.hint}</span>
                </button>
              ))}
            </div>
            {needChords && (
              <p className="text-[12px] rounded-xl border border-amber-400/40 bg-amber-400/10 p-3" data-testid="seance-need-chords">
                La piste d’accords est vide : le {roleInfo(role).label.toLowerCase()} n’a rien à suivre. Pose des accords dans le couloir <b>Accords</b> (menu Affichage) ou lance <b>Détecter</b> sur ton beat. Le batteur, lui, peut jouer tout de suite.
              </p>
            )}
            <div><span className={lbl}>Style</span>{styleRow(style, setStyle)}</div>
            <div><span className={lbl}>Motif de la recette</span>{motifRow(pattern, setPattern, style)}</div>
            {p.sectionCount > 0 && (
              <label className="flex items-center gap-2 text-[12px] font-bold cursor-pointer">
                <input type="checkbox" className="w-5 h-5" checked={bySection} onChange={e => setBySection(e.target.checked)} data-testid="seance-by-section" />
                Une région par section ({p.sectionCount}) : intro plus calme, refrain plus fort
              </label>
            )}
            <button type="button" disabled={busy || needChords} onClick={() => { void create(); }} data-testid="seance-add"
              className="w-full min-h-11 rounded-xl bg-amber-400 text-black text-[13px] font-black disabled:opacity-40">
              {busy ? 'Ajout…' : `Ajouter le ${roleInfo(role).label.toLowerCase()}`}
            </button>
            <p className="text-[11px] text-nv-muted">
              {p.chordCount ? `Il joue sur la durée de tes ${p.chordCount} accords` : 'Sans accords : sur la boucle, sinon 8 mesures'}{p.sectionCount && bySection ? ', une région par section' : ''}. Ctrl+Z pour annuler.
            </p>
          </div>
        )}

        {editing && first && (
          <div className="p-5 space-y-4" data-testid="seance-edit">
            <div><span className={lbl}>Style (toutes les régions)</span>{styleRow(regions.every(c => c.seance?.style === first.style) ? first.style : null, s => p.onChange(null, { style: s }))}</div>
            <div><span className={lbl}>Motif (toutes les régions)</span>{motifRow(regions.every(c => c.seance?.pattern === first.pattern) ? first.pattern : null, m => p.onChange(null, { pattern: m }), first.style)}</div>
            {first.role === 'drums' && (() => {
              const rec = genreRecipe(first.style);
              const recSwing = rec.drums[first.pattern % rec.drums.length]?.swing ?? rec.swing ?? 0;
              const sw = first.swing ?? recSwing;
              return (
                <div>
                  <span className={lbl}>Swing : {Math.round(sw * 100)} %{first.swing === undefined ? ' (celui de la recette)' : ''}</span>
                  <div className="flex items-center gap-2">
                    <input type="range" min={0} max={0.6} step={0.02} value={sw} onChange={e => p.onChange(null, { swing: Number(e.target.value) })} className="flex-1" aria-label="Swing" data-testid="seance-swing" />
                    <button type="button" disabled={first.swing === undefined} onClick={() => p.onChange(null, { swing: undefined })} className={chip(false)} title="Revenir au swing de la recette du genre">Recette</button>
                  </div>
                </div>
              );
            })()}

            <div className="space-y-2" aria-label="Régions">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-black uppercase tracking-widest">Régions ({regions.length})</span>
                {p.sectionCount > 0 && <button type="button" onClick={p.onSplitSections} data-testid="seance-split" className={chip(false)} title="Une région par repère de section (Intro, Couplet, Refrain…), chacune avec ses réglages">Une région par section</button>}
              </div>
              {regions.map(c => {
                const s = sanitizeSeance(c.seance)!;
                const focus = c.id === p.focusClipId;
                const set = (patch: Partial<SeanceSettings>) => p.onChange([c.id], patch);
                return (
                  <section key={c.id} ref={focus ? (el => { focusRef.current = el; }) : undefined} data-testid="seance-region"
                    className={`rounded-2xl border p-3 space-y-2 ${focus ? 'border-amber-400/70 bg-amber-400/5' : 'border-nv-line/15'}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-black text-[13px] flex-1 truncate">{s.section || genreRecipe(s.style).name}<span className="text-nv-muted font-bold"> · mes. {barOf(c.start)}–{barOf(c.start + c.duration - 1e-3)} · {c.notes?.length || 0} notes</span></span>
                      <button type="button" onClick={() => p.onOpenNotes(c.id)} className="nova-hit min-h-9 px-2 rounded-lg text-[11px] font-bold text-nv-muted hover:bg-nv-raised" title="Ouvrir les notes au piano roll (une retouche fige la région)">Notes</button>
                      <button type="button" onClick={() => p.onFreeze([c.id])} data-testid="seance-freeze-one" className="nova-hit min-h-9 px-2 rounded-lg text-[11px] font-bold text-cyan-300 hover:bg-nv-raised" title="Garder ces notes telles quelles et les éditer à la main">Figer</button>
                    </div>
                    <label className="block"><span className={lbl}>Intensité : {s.intensity} ({intensityWord(s.intensity)})</span>
                      <input type="range" min={1} max={10} step={1} value={s.intensity} onChange={e => set({ intensity: Number(e.target.value) })} className="w-full" data-testid="seance-intensity" /></label>
                    <label className="block"><span className={lbl}>Complexité : {s.complexity} ({complexityWord(s.complexity)})</span>
                      <input type="range" min={1} max={10} step={1} value={s.complexity} onChange={e => set({ complexity: Number(e.target.value) })} className="w-full" data-testid="seance-complexity" /></label>
                    {s.role === 'drums' && (
                      <label className="block"><span className={lbl}>Remplissages : {fillsWord(s.fills)}</span>
                        <input type="range" min={0} max={10} step={1} value={s.fills} onChange={e => set({ fills: Number(e.target.value) })} className="w-full" data-testid="seance-fills" /></label>
                    )}
                  </section>
                );
              })}
            </div>

            <div className="border-t border-nv-line/15 pt-4 space-y-1.5">
              <button type="button" onClick={() => p.onFreeze(null)} data-testid="seance-freeze"
                className="w-full min-h-11 rounded-xl bg-cyan-500 text-black text-[13px] font-black">
                Figer en notes MIDI
              </button>
              <p className="text-[11px] text-nv-muted">Garde exactement les notes que tu entends, à éditer au piano roll (Ctrl+Z pour revenir). Retoucher une note fige aussi la région : tes retouches ne sont jamais écrasées.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SessionPlayerPanel;
