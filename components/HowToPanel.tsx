import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  GUIDES, PREREQ_LABELS, guideById, searchGuides, stepsFor, type GuideFacts,
} from '../utils/guides';

/**
 * « ❓ Comment faire ? » : la liste des parcours (utils/guides) avec une recherche, et le
 * détail d'un parcours (étapes, ce qu'il faut avant, résultat, pièges) avec « Montre-moi ».
 * Ordinateur : fenêtre centrée ; téléphone : plein écran. Échap : détail → liste → fermé.
 */
export interface HowToPanelProps {
  open: boolean;
  onClose: () => void;
  facts: GuideFacts;
  isMobile: boolean;
  /** Parcours à ouvrir directement (palette « Comment faire : … », chat). */
  initialId?: string | null;
  onShowMe: (id: string) => void;
}

const HowToPanel: React.FC<HowToPanelProps> = ({ open, onClose, facts, isMobile, initialId, onShowMe }) => {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(initialId && guideById(initialId) ? initialId : null);
    // Pas de clavier qui surgit au téléphone : la recherche se touche si on en a besoin.
    if (!isMobile) window.setTimeout(() => inputRef.current?.focus(), 30);
  }, [open, initialId, isMobile]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (selected) setSelected(null); else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, selected, onClose]);

  const found = useMemo(() => searchGuides(query), [query]);
  const guide = selected ? guideById(selected) : undefined;
  const steps = useMemo(() => (guide ? stepsFor(guide, facts) : []), [guide, facts]);

  if (!open) return null;

  const body = guide ? (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 custom-scroll" data-testid="howto-detail" data-guide={guide.id}>
      <p className="text-[13px] leading-snug text-nv-muted">{guide.summary}</p>
      {guide.prereqs.length > 0 && (
        <div className="mt-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-nv-muted">Avant de commencer</p>
          <ul className="mt-1 flex flex-wrap gap-1.5" data-testid="howto-prereqs">
            {guide.prereqs.map(p => (
              <li key={p} className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold text-amber-500">{PREREQ_LABELS[p]}</li>
            ))}
          </ul>
        </div>
      )}
      <ol className="mt-3 space-y-1.5" data-testid="howto-steps">
        {steps.map((s, i) => (
          <li key={i} className={`flex gap-2.5 rounded-xl border px-3 py-2 ${s.skipped ? 'border-emerald-500/25 bg-emerald-500/[0.06]' : 'border-nv-line/12 bg-nv-raised'}`}>
            <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-black ${s.skipped ? 'bg-emerald-500 text-black' : 'bg-cyan-500 text-black'}`}>{s.skipped ? '✓' : i + 1}</span>
            <span className={`text-[13px] leading-snug ${s.skipped ? 'text-nv-muted line-through decoration-emerald-500/60' : 'text-nv-ink'}`}>
              {s.text}{s.skipped ? <span className="ml-1 no-underline text-[11px] font-bold text-emerald-500">(déjà fait)</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[12px] leading-snug text-nv-ink"><b>Résultat :</b> {guide.result}</p>
      {guide.pitfalls.length > 0 && (
        <div className="mt-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2" data-testid="howto-pitfalls">
          <p className="text-[11px] font-black uppercase tracking-widest text-amber-500">Pièges fréquents</p>
          <ul className="mt-1 space-y-1">
            {guide.pitfalls.map((p, i) => <li key={i} className="text-[12px] leading-snug text-nv-ink">⚠️ {p}</li>)}
          </ul>
        </div>
      )}
    </div>
  ) : (
    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 custom-scroll" role="list" aria-label="Parcours" data-testid="howto-list">
      {found.length === 0 && (
        <p className="px-3 py-8 text-center text-[13px] text-nv-muted">Aucun parcours pour « {query} ». Essaie « voix », « autotune », « export », « Spotify », « synthé »… ou demande à Nova.</p>
      )}
      {found.map(g => (
        <button key={g.id} type="button" role="listitem" onClick={() => setSelected(g.id)} data-testid={`howto-item-${g.id}`}
          className="mb-1.5 flex min-h-[52px] w-full items-center gap-3 rounded-xl border border-nv-line/12 bg-nv-raised px-3 py-2 text-left hover:border-nv-accent/50">
          <span className="text-xl leading-none" aria-hidden="true">{g.emoji}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-bold text-nv-ink">{g.title}</span>
            <span className="block truncate text-[11px] text-nv-muted">{g.summary}</span>
          </span>
          {g.prereqs.includes('appli-windows') && <span className="hidden shrink-0 rounded-md border border-nv-line/20 px-1.5 py-0.5 text-[10px] font-bold text-nv-muted sm:inline">Windows</span>}
          <i className="fas fa-chevron-right text-[11px] text-nv-muted" aria-hidden="true"></i>
        </button>
      ))}
    </div>
  );

  return createPortal(
    <div className={`fixed inset-0 z-[770] flex bg-black/50 ${isMobile ? '' : 'items-start justify-center px-3 pt-[8vh]'}`}
      onMouseDown={onClose} data-testid="howto-panel">
      <div role="dialog" aria-modal="true" aria-labelledby="howto-title"
        className={`flex flex-col overflow-hidden bg-nv-surface text-nv-ink shadow-2xl ${isMobile
          ? 'h-full w-full pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]'
          : 'max-h-[82vh] w-full max-w-[600px] rounded-2xl border border-nv-line/15'}`}
        onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 pt-3">
          {guide && (
            <button type="button" onClick={() => setSelected(null)} aria-label="Retour à la liste" data-testid="howto-back"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-nv-muted hover:bg-nv-line/10 hover:text-nv-ink">
              <i className="fas fa-arrow-left" aria-hidden="true"></i>
            </button>
          )}
          <h2 id="howto-title" className="min-w-0 flex-1 truncate px-1 text-[16px] font-black">
            {guide ? <>{guide.emoji} {guide.title}</> : '❓ Comment faire ?'}
          </h2>
          <button type="button" onClick={onClose} aria-label="Fermer (Échap)" title="Fermer (Échap)" data-testid="howto-close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-nv-muted hover:bg-nv-line/10 hover:text-nv-ink">
            <i className="fas fa-times" aria-hidden="true"></i>
          </button>
        </div>
        {!guide && (
          <div className="px-3 pb-2 pt-2">
            <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} type="search"
              onKeyDown={e => { if (e.key === 'Enter' && found[0]) setSelected(found[0].id); e.stopPropagation(); }}
              placeholder="Ce que tu veux faire : enregistrer, autotune, exporter, Spotify…"
              aria-label="Chercher un parcours" data-testid="howto-search"
              className="h-11 w-full rounded-xl border border-nv-line/15 bg-nv-well/40 px-3 text-[14px] text-nv-ink outline-none placeholder:text-nv-muted focus:border-nv-accent/60" />
            {!query && <p className="mt-1.5 px-1 text-[11px] text-nv-muted">{GUIDES.length} parcours pas à pas. « Montre-moi » te guide bouton par bouton ; tu peux aussi demander à Nova « comment je fais pour… ».</p>}
          </div>
        )}
        {body}
        {guide && (
          <div className="flex gap-2 border-t border-nv-line/10 p-3">
            <button type="button" onClick={() => onShowMe(guide.id)} data-testid="howto-showme"
              className="min-h-11 flex-1 rounded-xl bg-cyan-500 px-4 text-[14px] font-black text-black">▶ Montre-moi</button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default HowToPanel;
