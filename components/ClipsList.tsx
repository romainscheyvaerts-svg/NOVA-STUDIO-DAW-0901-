import React, { useMemo, useState } from 'react';
import type { DAWState } from '../types';
import { canDropOn, clearUnused, CLIP_DRAG_TYPE, ClipSort, clipRows, filterRows, fmtDuration } from '../utils/clipsList';
import { applyR21, r21Bus } from '../utils/r21Bus';
import { playheadStore } from '../utils/playheadStore';

/**
 * R21 · Liste des clips de la session (Pro Tools : Clips List, Ctrl+Maj+L ;
 * Logic : Project Audio Browser). Tous les clips audio et MIDI : recherche,
 * tri, durée, son d'origine ; glisser un clip sur une piste (ou « Poser » au
 * doigt) ; « Supprimer les clips inutilisés » (non destructif).
 */
const SORTS: { id: ClipSort; label: string }[] = [
  { id: 'start', label: 'Position' }, { id: 'name', label: 'Nom' }, { id: 'duration', label: 'Durée' }, { id: 'track', label: 'Piste' }, { id: 'source', label: 'Son d\'origine' },
];

const ClipsList: React.FC<{ state: DAWState; compact?: boolean }> = ({ state, compact }) => {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<ClipSort>('start');
  const [dir, setDir] = useState<1 | -1>(1);
  const [only, setOnly] = useState<'all' | 'audio' | 'midi' | 'unused'>('all');
  const [confirm, setConfirm] = useState(false);
  const [placing, setPlacing] = useState<string | null>(null);
  const rows = useMemo(() => clipRows(state), [state.tracks, state.clipBin]);
  const shown = useMemo(() => filterRows(rows, q, sort, dir, only), [rows, q, sort, dir, only]);
  const unused = rows.filter(r => !r.used).length;
  const tracksFor = (kind: 'audio' | 'midi') => state.tracks.filter(t => canDropOn(kind, t) && !t.isHidden);

  const chip = (on: boolean) => `nova-hit-tactile h-8 shrink-0 rounded-full px-3 text-[11px] font-bold border ${on ? 'border-nv-accent bg-nv-accent/20 text-nv-ink' : 'border-nv-line text-nv-muted hover:text-nv-ink'}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="clips-list">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <i className="fas fa-search pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] text-nv-muted" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Chercher un clip, une piste, un fichier…" aria-label="Chercher dans la liste des clips"
            data-testid="clips-search" className="h-9 w-full rounded-lg border border-nv-line bg-nv-bg pl-7 pr-2 text-[12px] text-nv-ink" />
        </div>
        <select value={sort} onChange={e => setSort(e.target.value as ClipSort)} aria-label="Trier par" data-testid="clips-sort"
          title="Trier la liste (Pro Tools : Clips List › Sort by)" className="h-9 rounded-lg border border-nv-line bg-nv-bg px-2 text-[12px] font-bold text-nv-ink">
          {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <button type="button" onClick={() => setDir(v => (v === 1 ? -1 : 1))} aria-label={dir === 1 ? 'Ordre croissant' : 'Ordre décroissant'} title="Inverser l'ordre"
          className="nova-hit-tactile h-9 w-9 shrink-0 rounded-lg border border-nv-line text-nv-muted hover:text-nv-ink">
          <i className={`fas ${dir === 1 ? 'fa-sort-amount-down-alt' : 'fa-sort-amount-down'}`} />
        </button>
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-0.5" role="radiogroup" aria-label="Filtrer">
        {([['all', `Tous (${rows.length})`], ['audio', 'Audio'], ['midi', 'MIDI'], ['unused', `Hors timeline (${unused})`]] as const).map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={only === id} onClick={() => setOnly(id)} className={chip(only === id)}
            title={id === 'unused' ? 'Clips retirés de la timeline : gardés ici, comme dans la Clips List de Pro Tools' : undefined}>{label}</button>
        ))}
      </div>
      <p className="text-[11px] text-nv-muted">{compact ? 'Touche « Poser » pour mettre un clip à la tête de lecture.' : 'Glisse un clip sur une piste pour l\'y poser (ou « Poser » : à la tête de lecture).'}</p>
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1" aria-label="Clips de la session">
        {!shown.length && (
          <li className="rounded-xl border border-dashed border-nv-line p-4 text-center text-[12px] text-nv-muted">
            {rows.length ? 'Aucun clip ne correspond.' : 'Pas encore de clip : enregistre une prise ou importe un son.'}
          </li>
        )}
        {shown.slice(0, 400).map(r => (
          <li key={r.key} draggable={!r.offline} data-testid="clips-row" data-clip-key={r.key}
            onDragStart={e => { e.dataTransfer.setData(CLIP_DRAG_TYPE, JSON.stringify({ key: r.key })); e.dataTransfer.effectAllowed = 'copy'; }}
            className={`group rounded-xl border p-2 ${r.used ? 'border-nv-line bg-nv-well/40' : 'border-amber-400/40 bg-amber-500/10'} ${r.offline ? 'opacity-60' : 'cursor-grab'}`}>
            <div className="flex items-center gap-2">
              <span className="h-8 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
              <i className={`fas ${r.kind === 'midi' ? 'fa-music' : 'fa-wave-square'} w-4 shrink-0 text-center text-[11px] text-nv-muted`} aria-label={r.kind === 'midi' ? 'MIDI' : 'Audio'} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-bold text-nv-ink" title={r.name}>{r.name}{r.muted ? <span className="ml-1 text-[10px] font-normal text-nv-muted">(muet)</span> : null}</p>
                <p className="truncate text-[11px] text-nv-muted" title={`Son d'origine : ${r.source}`}>
                  {fmtDuration(r.duration)} · {r.trackName}{r.used ? ` à ${r.start.toFixed(2).replace('.', ',')} s` : ''} · {r.kind === 'midi' ? `${r.notes} note${r.notes > 1 ? 's' : ''}` : r.source}
                </p>
              </div>
              {!r.offline && (
                <button type="button" onClick={() => setPlacing(p => (p === r.key ? null : r.key))} aria-expanded={placing === r.key}
                  title="Poser ce clip sur une piste, à la tête de lecture" className="nova-hit-tactile h-8 shrink-0 rounded-lg border border-nv-line px-2.5 text-[11px] font-bold text-nv-ink hover:bg-nv-accent/15">Poser</button>
              )}
            </div>
            {placing === r.key && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {tracksFor(r.kind).map(t => (
                  <button key={t.id} type="button" className="nova-hit-tactile h-8 rounded-lg border border-nv-line px-2.5 text-[11px] font-bold text-nv-ink hover:bg-nv-accent/15"
                    onClick={() => { r21Bus.emit({ kind: 'placeClip', key: r.key, trackId: t.id, time: playheadStore.get() }); setPlacing(null); }}>
                    <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: t.color }} />{t.name}
                  </button>
                ))}
                {!tracksFor(r.kind).length && <span className="text-[11px] text-nv-muted">Aucune piste {r.kind === 'midi' ? 'MIDI' : 'audio'} : crées-en une d'abord.</span>}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 border-t border-nv-line pt-2">
        {!confirm ? (
          <button type="button" disabled={!unused} onClick={() => setConfirm(true)} data-testid="clips-clear-unused"
            title="Pro Tools : Clips List › Clear Unused. Retire de la liste les clips qui ne sont plus sur la timeline. Les sons de la timeline ne sont pas touchés ; Ctrl+Z les remet."
            className="nova-hit-tactile h-9 flex-1 rounded-lg border border-nv-line text-[12px] font-bold text-nv-ink disabled:opacity-40 hover:bg-white/5">
            <i className="fas fa-broom mr-1.5 text-[11px]" />Supprimer les clips inutilisés{unused ? ` (${unused})` : ''}
          </button>
        ) : (
          <div className="flex flex-1 flex-col gap-2 rounded-xl border border-amber-400/40 bg-amber-500/10 p-2" role="alertdialog" aria-label="Confirmer">
            <p className="text-[12px] text-nv-ink">Retirer {unused} clip{unused > 1 ? 's' : ''} hors timeline de la liste ? La timeline ne bouge pas, et Ctrl+Z les remet.</p>
            <div className="flex gap-2">
              <button type="button" data-testid="clips-clear-confirm" className="nova-hit-tactile h-9 flex-1 rounded-lg bg-amber-400 text-[12px] font-black text-black"
                onClick={() => { applyR21(s => clearUnused(s).state, `🧹 ${unused} clip${unused > 1 ? 's' : ''} inutilisé${unused > 1 ? 's' : ''} retiré${unused > 1 ? 's' : ''} de la liste — Ctrl+Z pour les remettre.`); setConfirm(false); }}>Retirer</button>
              <button type="button" className="nova-hit-tactile h-9 flex-1 rounded-lg border border-nv-line text-[12px] font-bold text-nv-ink" onClick={() => setConfirm(false)}>Annuler</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ClipsList;
